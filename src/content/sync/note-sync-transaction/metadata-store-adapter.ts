import {
  getNotionLinkAttachment,
  getRawSyncedNotesMetadata,
  getRawSyncedNotesMetadataFromAttachment,
  saveRawSyncedNotesMetadata,
  setRawSyncedNotesMetadataOnAttachment,
} from '../../data/item-data';
import { isObject } from '../../utils';

import { sameTargetIdentity } from './model';
import type { RuntimeClock } from './runtime-clock';
import {
  parseManagedResourceRecord,
  serializeNoteSyncRecord,
  validateNoteSyncRecordJSON,
} from './schema';
import {
  assertTransactionRecord,
  parseSyncedNotesRootV4,
  serializeSyncedNotesRootV4,
} from './schema-v4';
import type {
  ManagedResourceRecord,
  NoteSyncRecordV3,
  TargetIdentity,
} from './types';
import {
  NOTE_SYNC_SCHEMA_VERSION_V4,
  type CleanupLedgerEntry,
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

export class QuarantinedMetadataError extends Error {
  public readonly name = 'QuarantinedMetadataError';

  public constructor(
    public readonly raw: string,
    message: string,
  ) {
    super(message);
  }
}

export type MetadataStoreAdapter = {
  load: () => Promise<NoteSyncRecordV3>;
  persist: (
    expectedRevision: number,
    nextRecord: NoteSyncRecordV3,
  ) => Promise<NoteSyncRecordV3>;
};

export type RawMetadataAccess = {
  read: () => Promise<string>;
  write: (nextRaw: string) => Promise<void>;
};

/**
 * Optimistic compare-and-swap boundary. `recordRevision` is authoritative:
 * stale writers are rejected before any write, then the executor must reload,
 * revalidate, and select a new reducer transition.
 */
export class JsonMetadataStoreAdapter implements MetadataStoreAdapter {
  public constructor(
    private readonly access: RawMetadataAccess,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async load(): Promise<NoteSyncRecordV3> {
    const raw = await this.access.read();
    const parsed = validateNoteSyncRecordJSON(raw);
    if (parsed.validation === 'quarantined') {
      throw new QuarantinedMetadataError(raw, parsed.diagnostic.message);
    }
    return parsed.record;
  }

  public async persist(
    expectedRevision: number,
    nextRecord: NoteSyncRecordV3,
  ): Promise<NoteSyncRecordV3> {
    const current = await this.load();
    if (current.recordRevision !== expectedRevision) {
      throw new StaleRecordRevisionError(
        expectedRevision,
        current.recordRevision,
      );
    }
    if (nextRecord.recordRevision !== expectedRevision) {
      throw new StaleRecordRevisionError(
        expectedRevision,
        nextRecord.recordRevision,
      );
    }
    const persisted = {
      ...nextRecord,
      recordRevision: expectedRevision + 1,
      updatedAt: this.now(),
    };
    await this.access.write(serializeNoteSyncRecord(persisted));
    const confirmed = await this.load();
    if (
      confirmed.recordRevision !== persisted.recordRevision ||
      confirmed.transactionID !== persisted.transactionID ||
      confirmed.state !== persisted.state
    ) {
      throw new StaleRecordRevisionError(
        persisted.recordRevision,
        confirmed.recordRevision,
      );
    }
    return confirmed;
  }
}

type LegacyMetadataEvidence = {
  containerBlockID?: string;
  noteBlockIDs: Record<string, string>;
};

type NativeMetadataRoot = {
  container: ManagedResourceRecord | null;
  containerTarget: ContainerTargetIdentity | null;
  legacy?: LegacyMetadataEvidence;
  notes: Record<string, unknown>;
  preservedUnknown?: Record<string, unknown>;
  schemaVersion: 3;
};

type ContainerTargetIdentity = Omit<TargetIdentity, 'noteItemKey'>;

type ParsedMetadataRoot =
  | { kind: 'empty'; raw: undefined }
  | { evidence: LegacyMetadataEvidence; kind: 'legacy'; raw: string }
  | { kind: 'native'; root: NativeMetadataRoot; raw: string };

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

function parseContainerTarget(
  value: unknown,
): ContainerTargetIdentity | undefined {
  if (
    !isObject(value) ||
    typeof value.connectionID !== 'string' ||
    typeof value.databaseID !== 'string' ||
    typeof value.libraryID !== 'number' ||
    typeof value.pageID !== 'string' ||
    typeof value.parentItemKey !== 'string' ||
    typeof value.workspaceID !== 'string' ||
    (value.identityType !== undefined && value.identityType !== 'legacy-local')
  ) {
    return undefined;
  }
  return {
    connectionID: value.connectionID,
    databaseID: value.databaseID,
    ...(value.identityType === 'legacy-local' && {
      identityType: value.identityType,
    }),
    libraryID: value.libraryID,
    pageID: value.pageID,
    parentItemKey: value.parentItemKey,
    workspaceID: value.workspaceID,
  };
}

function containerTargetFrom(target: TargetIdentity): ContainerTargetIdentity {
  const { noteItemKey: _noteItemKey, ...containerTarget } = target;
  return containerTarget;
}

function sameContainerTarget(
  left: ContainerTargetIdentity,
  right: TargetIdentity,
): boolean {
  return (
    left.connectionID === right.connectionID &&
    left.databaseID === right.databaseID &&
    left.identityType === right.identityType &&
    left.libraryID === right.libraryID &&
    left.pageID === right.pageID &&
    left.parentItemKey === right.parentItemKey &&
    left.workspaceID === right.workspaceID
  );
}

function parseRoot(raw: string | undefined): ParsedMetadataRoot {
  if (!raw) return { kind: 'empty', raw: undefined };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new QuarantinedMetadataError(
      raw,
      'Notero metadata root is invalid JSON',
    );
  }
  if (!isObject(value)) {
    throw new QuarantinedMetadataError(
      raw,
      'Notero metadata root is not an object',
    );
  }
  const schemaVersion =
    typeof value.schemaVersion === 'number' ? value.schemaVersion : 1;
  if (schemaVersion === 2) {
    throw new QuarantinedMetadataError(
      raw,
      'Unpublished feature-v2 transaction metadata is quarantined; old stage recovery is not supported',
    );
  }
  if (schemaVersion > 3) {
    throw new QuarantinedMetadataError(
      raw,
      `Notero metadata schema v${schemaVersion} requires a newer version`,
    );
  }
  if (schemaVersion !== 3) {
    return { evidence: parseLegacyEvidence(value), kind: 'legacy', raw };
  }
  if (!isObject(value.notes)) {
    throw new QuarantinedMetadataError(raw, 'Native v3 notes root is invalid');
  }
  const container =
    value.container === null
      ? null
      : parseManagedResourceRecord(value.container);
  if (value.container !== null && !container) {
    throw new QuarantinedMetadataError(
      raw,
      'Native v3 container evidence is invalid',
    );
  }
  const containerTarget =
    value.containerTarget === null
      ? null
      : parseContainerTarget(value.containerTarget);
  if (
    (container && !containerTarget) ||
    (!container && value.containerTarget !== null)
  ) {
    throw new QuarantinedMetadataError(
      raw,
      'Native v3 container target scope is invalid or missing',
    );
  }
  const legacy = isObject(value.legacy)
    ? parseLegacyEvidence(value.legacy)
    : undefined;
  const knownFields = new Set([
    'container',
    'containerTarget',
    'legacy',
    'notes',
    'preservedUnknown',
    'schemaVersion',
  ]);
  const preservedUnknown = {
    ...(isObject(value.preservedUnknown) ? value.preservedUnknown : {}),
    ...Object.fromEntries(
      Object.entries(value).filter(([key]) => !knownFields.has(key)),
    ),
  };
  return {
    kind: 'native',
    raw,
    root: {
      container: container || null,
      containerTarget: containerTarget || null,
      ...(legacy && { legacy }),
      notes: value.notes,
      ...(Object.keys(preservedUnknown).length && { preservedUnknown }),
      schemaVersion: 3,
    },
  };
}

function recordFromRoot(
  root: ParsedMetadataRoot,
  noteItemKey: string,
  initial: NoteSyncRecordV3,
): NoteSyncRecordV3 {
  if (root.kind !== 'native') return initial;
  if (
    root.root.containerTarget &&
    !sameContainerTarget(root.root.containerTarget, initial.targetIdentity)
  ) {
    throw new QuarantinedMetadataError(
      root.raw,
      'Native v3 canonical container belongs to another target scope',
    );
  }
  const value = root.root.notes[noteItemKey];
  if (value === undefined) {
    return { ...initial, container: root.root.container };
  }
  const parsed = validateNoteSyncRecordJSON(JSON.stringify(value));
  if (parsed.validation === 'quarantined') {
    throw new QuarantinedMetadataError(root.raw, parsed.diagnostic.message);
  }
  if (
    !sameTargetIdentity(parsed.record.targetIdentity, initial.targetIdentity)
  ) {
    throw new QuarantinedMetadataError(
      root.raw,
      'Native v3 note target identity differs from the requested target',
    );
  }
  if (
    root.root.container &&
    parsed.record.container?.blockID !== root.root.container.blockID
  ) {
    throw new QuarantinedMetadataError(
      root.raw,
      'Native v3 note container differs from the canonical root container',
    );
  }
  return parsed.record;
}

/** Production root adapter used only while parent/note locks are held. */
export class ZoteroMetadataStoreAdapter implements MetadataStoreAdapter {
  public constructor(
    private readonly parentItem: Zotero.Item,
    private readonly noteItemKey: string,
    private readonly initial: NoteSyncRecordV3,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async load(): Promise<NoteSyncRecordV3> {
    const root = parseRoot(getRawSyncedNotesMetadata(this.parentItem));
    return recordFromRoot(root, this.noteItemKey, this.initial);
  }

  public async persist(
    expectedRevision: number,
    nextRecord: NoteSyncRecordV3,
  ): Promise<NoteSyncRecordV3> {
    const root = parseRoot(getRawSyncedNotesMetadata(this.parentItem));
    const current = recordFromRoot(root, this.noteItemKey, this.initial);
    if (
      current.recordRevision !== expectedRevision ||
      nextRecord.recordRevision !== expectedRevision
    ) {
      throw new StaleRecordRevisionError(
        expectedRevision,
        current.recordRevision,
      );
    }
    const persisted: NoteSyncRecordV3 = {
      ...nextRecord,
      recordRevision: expectedRevision + 1,
      updatedAt: this.now(),
    };
    const serialized = JSON.parse(serializeNoteSyncRecord(persisted));
    const existingNotes = root.kind === 'native' ? root.root.notes : {};
    const legacy =
      root.kind === 'legacy'
        ? root.evidence
        : root.kind === 'native'
          ? root.root.legacy
          : undefined;
    const nextRoot: NativeMetadataRoot = {
      container:
        persisted.container ||
        (root.kind === 'native' ? root.root.container : null),
      containerTarget:
        persisted.container || (root.kind === 'native' && root.root.container)
          ? containerTargetFrom(persisted.targetIdentity)
          : null,
      ...(legacy && { legacy }),
      notes: { ...existingNotes, [this.noteItemKey]: serialized },
      ...(root.kind === 'native' && root.root.preservedUnknown
        ? { preservedUnknown: root.root.preservedUnknown }
        : {}),
      schemaVersion: 3,
    };
    await saveRawSyncedNotesMetadata(this.parentItem, JSON.stringify(nextRoot));
    const confirmed = await this.load();
    if (
      confirmed.recordRevision !== persisted.recordRevision ||
      confirmed.transactionID !== persisted.transactionID ||
      confirmed.state !== persisted.state
    ) {
      throw new StaleRecordRevisionError(
        persisted.recordRevision,
        confirmed.recordRevision,
      );
    }
    return confirmed;
  }

  public hasLegacyEvidence(): boolean {
    const root = parseRoot(getRawSyncedNotesMetadata(this.parentItem));
    if (root.kind === 'legacy') {
      return Boolean(
        root.evidence.containerBlockID ||
        Object.keys(root.evidence.noteBlockIDs).length,
      );
    }
    return Boolean(
      root.kind === 'native' &&
      root.root.legacy &&
      (root.root.legacy.containerBlockID ||
        Object.keys(root.root.legacy.noteBlockIDs).length),
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
    return {
      legacyMigrationRequired: false,
      root: parseSyncedNotesRootV4(value),
    };
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
 * merge, setNote, and item.save() all execute inside one Zotero DB transaction.
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
    return Zotero.DB.executeTransaction(async () => {
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
      const proposed = mutation(current);
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
        container: persisted.container || parsed.root.container,
        notes: {
          ...parsed.root.notes,
          [this.noteItemKey]: persisted,
        },
        rootRevision: nextRootRevision,
      };
      const serialized = serializeSyncedNotesRootV4(mergedRoot);
      setRawSyncedNotesMetadataOnAttachment(
        freshAttachment,
        serialized,
        this.clock.nowISOString(),
      );
      await freshAttachment.save({ skipNotifier: true });
      return {
        legacyMigrationRequired: parsed.legacyMigrationRequired,
        record: persisted,
        rootRevision: nextRootRevision,
      };
    });
  }
}
