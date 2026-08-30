import {
  getNotionLinkAttachment,
  getRawSyncedNotesMetadataFromAttachment,
  setRawSyncedNotesMetadataOnAttachment,
} from '../../data/item-data';
import { isObject } from '../../utils';

import {
  assertMetadataRootBudgetV4,
  compactRecordMetadataV4,
} from './metadata-budget-v4';
import type { RuntimeClock } from './runtime-clock';
import {
  assertTransactionRecord,
  parseSyncedNotesRootV4,
  serializeSyncedNotesRootV4,
} from './schema-v4';
import {
  NOTE_SYNC_SCHEMA_VERSION_V4,
  type CleanupLedgerEntry,
  type LegacyMetadataEvidence,
  type MetadataStoreSnapshot,
  type NoteSyncRecordV4,
  type RevisionExpectation,
  type SyncedNotesRootV4,
} from './types-v4';
import { ZoteroRuntimeAdapter } from './zotero-runtime-adapter';

export class StaleRecordRevisionError extends Error {
  public readonly name = 'StaleRecordRevisionError';

  public constructor(
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super(
      `Stale note sync record revision: expected ${expectedRevision}, actual ${actualRevision}`,
    );
  }
}

export class StaleRootRevisionError extends Error {
  public readonly name = 'StaleRootRevisionError';

  public constructor(
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super(
      `Stale note sync root revision: expected ${expectedRevision}, actual ${actualRevision}`,
    );
  }
}

export class QuarantinedMetadataError extends Error {
  public readonly name = 'QuarantinedMetadataError';

  public constructor(
    public readonly raw: string,
    message: string,
  ) {
    super(message);
  }
}

function parseLegacyEvidence(
  value: Record<string, unknown>,
): LegacyMetadataEvidence {
  const noteBlockIDs: Record<string, string> = {};
  if (isObject(value.noteBlockIDs)) {
    for (const [key, blockID] of Object.entries(value.noteBlockIDs)) {
      if (typeof blockID === 'string') noteBlockIDs[key] = blockID;
    }
  }
  if (isObject(value.notes)) {
    for (const [key, note] of Object.entries(value.notes)) {
      if (isObject(note) && typeof note.blockID === 'string') {
        noteBlockIDs[key] = note.blockID;
      }
    }
  }
  return {
    ...(typeof value.containerBlockID === 'string' && {
      containerBlockID: value.containerBlockID,
    }),
    noteBlockIDs,
  };
}

type ParsedRootV4 = {
  legacyMigrationRequired: boolean;
  root: SyncedNotesRootV4;
};

function emptyRootV4(): SyncedNotesRootV4 {
  return {
    container: null,
    notes: {},
    rootRevision: 0,
    schemaVersion: NOTE_SYNC_SCHEMA_VERSION_V4,
  };
}

function parseRootV4(raw: string | undefined): ParsedRootV4 {
  if (!raw) return { legacyMigrationRequired: false, root: emptyRootV4() };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new QuarantinedMetadataError(
      `redacted-length:${raw.length}`,
      'Notero metadata root is invalid JSON',
    );
  }
  if (!isObject(value)) {
    throw new QuarantinedMetadataError(
      `redacted-length:${raw.length}`,
      'Notero metadata root is not an object',
    );
  }
  const schemaVersion =
    typeof value.schemaVersion === 'number' ? value.schemaVersion : 1;
  if (schemaVersion === NOTE_SYNC_SCHEMA_VERSION_V4) {
    try {
      return {
        legacyMigrationRequired: false,
        root: parseSyncedNotesRootV4(value),
      };
    } catch (error) {
      throw new QuarantinedMetadataError(
        `redacted-length:${raw.length}`,
        `Notero schema-v4 metadata failed validation (${error instanceof Error ? error.name : 'UnknownValidationError'})`,
      );
    }
  }
  if (schemaVersion === 2 || schemaVersion === 3) {
    throw new QuarantinedMetadataError(
      `redacted-length:${raw.length}`,
      `Unpublished feature-v${schemaVersion} transaction metadata is sealed; reset development metadata before FSM v2 can continue`,
    );
  }
  if (schemaVersion > NOTE_SYNC_SCHEMA_VERSION_V4) {
    throw new QuarantinedMetadataError(
      `redacted-length:${raw.length}`,
      `Notero metadata schema v${schemaVersion} requires a newer plugin`,
    );
  }
  const evidence = parseLegacyEvidence(value);
  return {
    legacyMigrationRequired: Boolean(
      evidence.containerBlockID || Object.keys(evidence.noteBlockIDs).length,
    ),
    root: {
      container: null,
      legacy: evidence,
      notes: {},
      preservedLegacyFields: value,
      rootRevision: 0,
      schemaVersion: NOTE_SYNC_SCHEMA_VERSION_V4,
    },
  };
}

function recordFromRootV4(
  parsed: ParsedRootV4,
  noteItemKey: string,
  initial: NoteSyncRecordV4,
): NoteSyncRecordV4 {
  const stored = parsed.root.notes[noteItemKey];
  const record = stored || {
    ...initial,
    container: parsed.root.container,
  };
  return assertTransactionRecord(record, {
    expectedTargetIdentity: initial.targetIdentity,
    rootRevision: parsed.root.rootRevision,
  });
}

export type TransactionalMetadataStoreV4 = {
  load: () => Promise<MetadataStoreSnapshot>;
  mergeCleanupEntry: (
    expectation: RevisionExpectation,
    entry: CleanupLedgerEntry,
  ) => Promise<MetadataStoreSnapshot>;
  mutate: (
    expectation: RevisionExpectation,
    mutation: (current: NoteSyncRecordV4) => NoteSyncRecordV4,
  ) => Promise<MetadataStoreSnapshot>;
  persist: (
    expectation: RevisionExpectation,
    nextRecord: NoteSyncRecordV4,
  ) => Promise<MetadataStoreSnapshot>;
};

/**
 * Production schema-v4 store. Fresh reload, root/note compare, immutable note
 * merge, setNote, and item.save() all execute inside one real Zotero DB
 * transaction. This is atomic compare-merge-write, not a remote CAS.
 */
export class ZoteroTransactionalMetadataStoreV4 implements TransactionalMetadataStoreV4 {
  private readonly attachmentID: Zotero.DataObjectID;
  private readonly runtime: ZoteroRuntimeAdapter;

  public constructor(
    parentItem: Zotero.Item,
    private readonly noteItemKey: string,
    private readonly initial: NoteSyncRecordV4,
    private readonly clock: RuntimeClock,
    runtime = new ZoteroRuntimeAdapter(),
  ) {
    const attachment = getNotionLinkAttachment(parentItem);
    if (!attachment) {
      throw new Error('Cannot synchronize note metadata without a Notion link');
    }
    runtime.assertCapabilities(attachment);
    this.attachmentID = attachment.id;
    this.runtime = runtime;
  }

  public async load(): Promise<MetadataStoreSnapshot> {
    await this.runtime.reloadItems([this.attachmentID]);
    const freshAttachment = this.runtime.getItem(this.attachmentID);
    const parsed = parseRootV4(
      getRawSyncedNotesMetadataFromAttachment(freshAttachment),
    );
    return {
      legacyMigrationRequired: parsed.legacyMigrationRequired,
      record: recordFromRootV4(parsed, this.noteItemKey, this.initial),
      rootRevision: parsed.root.rootRevision,
    };
  }

  public async persist(
    expectation: RevisionExpectation,
    nextRecord: NoteSyncRecordV4,
  ): Promise<MetadataStoreSnapshot> {
    assertTransactionRecord(nextRecord, {
      expectedTargetIdentity: this.initial.targetIdentity,
      rootRevision: expectation.rootRevision,
    });
    return this.writeAtomically(expectation, () => nextRecord);
  }

  public async mutate(
    expectation: RevisionExpectation,
    mutation: (current: NoteSyncRecordV4) => NoteSyncRecordV4,
  ): Promise<MetadataStoreSnapshot> {
    return this.writeAtomically(expectation, mutation);
  }

  public async mergeCleanupEntry(
    expectation: RevisionExpectation,
    entry: CleanupLedgerEntry,
  ): Promise<MetadataStoreSnapshot> {
    return this.mutate(expectation, (current) => {
      const existingIndex = current.cleanupLedger.findIndex(
        ({ cleanupID }) => cleanupID === entry.cleanupID,
      );
      const cleanupLedger = current.cleanupLedger.slice();
      if (existingIndex === -1) cleanupLedger.push(entry);
      else cleanupLedger[existingIndex] = entry;
      return { ...current, cleanupLedger };
    });
  }

  private async writeAtomically(
    expectation: RevisionExpectation,
    mutation: (current: NoteSyncRecordV4) => NoteSyncRecordV4,
  ): Promise<MetadataStoreSnapshot> {
    return this.runtime.executeTransaction(async () => {
      await this.runtime.reloadItems([this.attachmentID]);
      const freshAttachment = this.runtime.asTransactionalItem(
        this.runtime.getItem(this.attachmentID),
      );
      const parsed = parseRootV4(
        getRawSyncedNotesMetadataFromAttachment(freshAttachment),
      );
      if (parsed.root.rootRevision !== expectation.rootRevision) {
        throw new StaleRootRevisionError(
          expectation.rootRevision,
          parsed.root.rootRevision,
        );
      }
      const current = recordFromRootV4(parsed, this.noteItemKey, this.initial);
      if (current.revision !== expectation.noteRevision) {
        throw new StaleRecordRevisionError(
          expectation.noteRevision,
          current.revision,
        );
      }
      const proposed = compactRecordMetadataV4(mutation(current));
      if (proposed.revision !== current.revision) {
        throw new StaleRecordRevisionError(current.revision, proposed.revision);
      }
      assertTransactionRecord(proposed, {
        expectedTargetIdentity: this.initial.targetIdentity,
        rootRevision: parsed.root.rootRevision,
      });
      const nextRootRevision = parsed.root.rootRevision + 1;
      const persisted: NoteSyncRecordV4 = {
        ...proposed,
        revision: current.revision + 1,
        updatedAt: this.clock.nowISOString(),
      };
      assertTransactionRecord(persisted, {
        expectedTargetIdentity: this.initial.targetIdentity,
        previousRevision: {
          noteRevision: current.revision,
          rootRevision: parsed.root.rootRevision,
        },
        rootRevision: nextRootRevision,
      });
      const mergedRoot: SyncedNotesRootV4 = {
        ...parsed.root,
        container: persisted.container,
        notes: {
          ...parsed.root.notes,
          [this.noteItemKey]: persisted,
        },
        rootRevision: nextRootRevision,
      };
      const serialized = serializeSyncedNotesRootV4(mergedRoot);
      assertMetadataRootBudgetV4(mergedRoot);
      setRawSyncedNotesMetadataOnAttachment(
        freshAttachment,
        serialized,
        this.clock.nowISOString(),
      );
      await this.runtime.saveItem(freshAttachment, { skipNotifier: true });
      return {
        legacyMigrationRequired: parsed.legacyMigrationRequired,
        record: persisted,
        rootRevision: nextRootRevision,
      };
    });
  }
}
