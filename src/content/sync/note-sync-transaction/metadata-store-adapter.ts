import {
  getRawSyncedNotesMetadata,
  saveRawSyncedNotesMetadata,
} from '../../data/item-data';
import { isObject } from '../../utils';

import { sameTargetIdentity } from './model';
import {
  parseManagedResourceRecord,
  serializeNoteSyncRecord,
  validateNoteSyncRecordJSON,
} from './schema';
import type {
  ManagedResourceRecord,
  NoteSyncRecordV3,
  TargetIdentity,
} from './types';

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
