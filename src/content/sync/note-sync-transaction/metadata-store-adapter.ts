import {
  getNotionLinkAttachment,
  getRawSyncedNotesMetadataFromAttachment,
  setRawSyncedNotesMetadataOnAttachment,
  setSyncedNotesQuarantineOnAttachment,
  type MetadataQuarantineEnvelope,
} from '../../data/item-data';
import { isObject } from '../../utils';

import { digestCanonical } from './canonical';
import {
  assertMetadataRootBudgetV4,
  compactRecordMetadataV4,
} from './metadata-budget-v4';
import type { RuntimeClock } from './runtime-clock';
import {
  assertTransactionRecord,
  parseSyncedNotesRootV4,
  serializeSyncedNotesRootV4,
  TransactionInvariantError,
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
    public readonly result: Exclude<MetadataLoadResultV4, { kind: 'VALID' }>,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  public get category() {
    return this.result.kind;
  }

  public get diagnostics() {
    return this.result.diagnostics;
  }

  public get raw() {
    return this.result.raw;
  }

  public get rawHash() {
    return this.result.rawHash;
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

type InvalidMetadataLoadResultKindV4 =
  | 'FUTURE_SCHEMA'
  | 'PARSEABLE_INVALID'
  | 'SYNTAX_INVALID';

type InvalidMetadataLoadResultV4 = {
  diagnostics: readonly string[];
  kind: InvalidMetadataLoadResultKindV4;
  raw: string;
  rawHash: string;
  schemaVersion: number | null;
};

export type MetadataLoadResultV4 =
  | {
      kind: 'VALID';
      parsed: ParsedRootV4;
      raw: string;
      rawHash: string;
    }
  | InvalidMetadataLoadResultV4;

function emptyRootV4(): SyncedNotesRootV4 {
  return {
    container: null,
    notes: {},
    rootRevision: 0,
    schemaVersion: NOTE_SYNC_SCHEMA_VERSION_V4,
  };
}

function rawHashV4(raw: string): string {
  return digestCanonical('notero-metadata-raw-v4', raw);
}

function invalidLoadResult(
  kind: InvalidMetadataLoadResultKindV4,
  raw: string,
  diagnostics: readonly string[],
  schemaVersion: number | null,
): InvalidMetadataLoadResultV4 {
  return {
    diagnostics,
    kind,
    raw,
    rawHash: rawHashV4(raw),
    schemaVersion,
  };
}

function validationDiagnostics(error: unknown): readonly string[] {
  if (error instanceof TransactionInvariantError) {
    return error.issues.map(({ code, path }) => `${code}:${path}`);
  }
  return [error instanceof Error ? error.name : 'UnknownValidationError'];
}

export function classifyMetadataRootV4(
  raw: string | undefined,
): MetadataLoadResultV4 {
  if (!raw) {
    return {
      kind: 'VALID',
      parsed: { legacyMigrationRequired: false, root: emptyRootV4() },
      raw: '',
      rawHash: rawHashV4(''),
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalidLoadResult('SYNTAX_INVALID', raw, ['INVALID_JSON:$'], null);
  }
  if (!isObject(value)) {
    return invalidLoadResult(
      'PARSEABLE_INVALID',
      raw,
      ['INVALID_ROOT:$'],
      null,
    );
  }
  const schemaVersion =
    typeof value.schemaVersion === 'number' ? value.schemaVersion : 1;
  if (schemaVersion === NOTE_SYNC_SCHEMA_VERSION_V4) {
    try {
      return {
        kind: 'VALID',
        parsed: {
          legacyMigrationRequired: false,
          root: parseSyncedNotesRootV4(value),
        },
        raw,
        rawHash: rawHashV4(raw),
      };
    } catch (error) {
      return invalidLoadResult(
        'PARSEABLE_INVALID',
        raw,
        validationDiagnostics(error),
        schemaVersion,
      );
    }
  }
  if (schemaVersion === 2 || schemaVersion === 3) {
    return invalidLoadResult(
      'PARSEABLE_INVALID',
      raw,
      [`UNPUBLISHED_FEATURE_SCHEMA_V${schemaVersion}:$`],
      schemaVersion,
    );
  }
  if (schemaVersion > NOTE_SYNC_SCHEMA_VERSION_V4) {
    return invalidLoadResult(
      'FUTURE_SCHEMA',
      raw,
      [`FUTURE_SCHEMA_V${schemaVersion}:$`],
      schemaVersion,
    );
  }
  const evidence = parseLegacyEvidence(value);
  return {
    kind: 'VALID',
    parsed: {
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
    },
    raw,
    rawHash: rawHashV4(raw),
  };
}

function metadataError(
  result: InvalidMetadataLoadResultV4,
): QuarantinedMetadataError {
  const unpublishedFeatureSchema =
    result.schemaVersion === 2 || result.schemaVersion === 3;
  const reason = unpublishedFeatureSchema
    ? `feature-v${result.schemaVersion} transaction metadata is sealed`
    : result.kind === 'FUTURE_SCHEMA'
      ? 'requires a newer plugin'
      : result.kind === 'SYNTAX_INVALID'
        ? 'is invalid JSON'
        : 'failed schema-v4 validation';
  const targetScope = result.diagnostics.some((diagnostic) =>
    diagnostic.toLowerCase().includes('target'),
  )
    ? ' for the target scope'
    : '';
  return new QuarantinedMetadataError(
    result,
    `Notero metadata ${reason}${targetScope}; local quarantine evidence was preserved`,
  );
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
    let lastInvalid: InvalidMetadataLoadResultV4 | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.runtime.reloadItems([this.attachmentID]);
      const freshAttachment = this.runtime.getItem(this.attachmentID);
      const classified = classifyMetadataRootV4(
        getRawSyncedNotesMetadataFromAttachment(freshAttachment),
      );
      if (classified.kind === 'VALID') {
        try {
          return this.snapshotFromParsed(classified.parsed);
        } catch (error) {
          lastInvalid = invalidLoadResult(
            'PARSEABLE_INVALID',
            classified.raw,
            validationDiagnostics(error),
            NOTE_SYNC_SCHEMA_VERSION_V4,
          );
        }
      } else {
        lastInvalid = classified;
      }
      if (await this.persistQuarantineEnvelope(lastInvalid)) {
        throw metadataError(lastInvalid);
      }
    }
    if (!lastInvalid) throw new Error('Metadata load retry lost its result');
    throw metadataError(lastInvalid);
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
      const classified = classifyMetadataRootV4(
        getRawSyncedNotesMetadataFromAttachment(freshAttachment),
      );
      if (classified.kind !== 'VALID') throw metadataError(classified);
      const parsed = classified.parsed;
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

  private snapshotFromParsed(parsed: ParsedRootV4): MetadataStoreSnapshot {
    return {
      legacyMigrationRequired: parsed.legacyMigrationRequired,
      record: recordFromRootV4(parsed, this.noteItemKey, this.initial),
      rootRevision: parsed.root.rootRevision,
    };
  }

  private async persistQuarantineEnvelope(
    expected: InvalidMetadataLoadResultV4,
  ): Promise<boolean> {
    return this.runtime.executeTransaction(async () => {
      await this.runtime.reloadItems([this.attachmentID]);
      const freshAttachment = this.runtime.asTransactionalItem(
        this.runtime.getItem(this.attachmentID),
      );
      const current = classifyMetadataRootV4(
        getRawSyncedNotesMetadataFromAttachment(freshAttachment),
      );
      if (current.rawHash !== expected.rawHash) {
        return false;
      }
      const quarantined = current.kind === 'VALID' ? expected : current;
      const originalNote = freshAttachment.getNote();
      const envelope: MetadataQuarantineEnvelope = {
        category: quarantined.kind,
        diagnostics: quarantined.diagnostics,
        executable: false,
        quarantinedAt: this.clock.nowISOString(),
        raw: quarantined.raw,
        rawHash: quarantined.rawHash,
        schemaVersion: quarantined.schemaVersion,
        sealed: true,
      };
      try {
        setSyncedNotesQuarantineOnAttachment(
          freshAttachment,
          envelope,
          envelope.quarantinedAt,
        );
        await this.runtime.saveItem(freshAttachment, { skipNotifier: true });
      } catch (error) {
        freshAttachment.setNote(originalNote);
        throw new QuarantinedMetadataError(
          quarantined,
          'Notero metadata quarantine could not be persisted; original metadata was retained',
          { cause: error },
        );
      }
      return true;
    });
  }
}
