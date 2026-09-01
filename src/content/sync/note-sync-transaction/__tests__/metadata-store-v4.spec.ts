import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  FakeRuntimeClock,
  createZoteroItemMock,
  zoteroMock,
} from '../../../../../test/utils';
import {
  getRawSyncedNotesMetadataFromAttachment,
  getRawSyncedNotesQuarantineFromAttachment,
} from '../../../data/item-data';
import {
  deriveAssetID,
  deriveFileUploadBindingDigest,
  deriveTargetIdentityDigest,
  recomputeOperationRequestDigest,
} from '../identity-v4';
import {
  classifyMetadataRootV4,
  QuarantinedMetadataError,
  StaleRootRevisionError,
  ZoteroTransactionalMetadataStoreV4,
} from '../metadata-store-adapter';
import { createIdleRecordV4, deriveDurableActive } from '../model-v4';
import { ownershipFromResource, parseSyncedNotesRootV4 } from '../schema-v4';
import type {
  CleanupLedgerEntry,
  NoteSyncRecordV4,
  SyncedNotesRootV4,
  TargetIdentity,
  UploadAssetRecordV4,
} from '../types-v4';

import {
  candidateResourceV4,
  candidateV4,
  clockV4,
  recordV4,
  sourceVersionV4,
  targetV4,
  verifyIntentV4,
} from './fixtures-v4';

type Harness = ReturnType<typeof createHarness>;

function createHarness() {
  let attachmentNote = '';
  let inTransaction = false;
  let transactionTail = Promise.resolve();
  const attachment = createZoteroItemMock();
  attachment.getField.mockImplementation((field) =>
    field === 'url'
      ? 'https://www.notion.so/Synthetic-page00000000000000000000000000000001'
      : '',
  );
  attachment.getNote.mockImplementation(() => attachmentNote);
  attachment.save.mockResolvedValue(true);
  attachment.setNote.mockImplementation((note) => {
    attachmentNote = note;
    return true;
  });
  const parent = createZoteroItemMock();
  parent.getAttachments.mockReturnValue([attachment.id]);
  zoteroMock.DB.inTransaction.mockImplementation(() => inTransaction);
  zoteroMock.DB.executeTransaction.mockImplementation((callback) => {
    const result = transactionTail.then(async () => {
      inTransaction = true;
      try {
        return await callback();
      } finally {
        inTransaction = false;
      }
    });
    transactionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  });
  zoteroMock.Items.reload.mockResolvedValue();
  return {
    attachment,
    clock: new FakeRuntimeClock(clockV4.nowISOString()),
    parent,
    readQuarantine: () => {
      const raw = getRawSyncedNotesQuarantineFromAttachment(attachment);
      return raw ? JSON.parse(raw) : undefined;
    },
    readRoot: () => {
      const raw = getRawSyncedNotesMetadataFromAttachment(attachment);
      if (!raw) throw new Error('Expected metadata root');
      return parseSyncedNotesRootV4(JSON.parse(raw));
    },
    setMetadataRaw: (raw: string) => {
      attachmentNote = `<pre id="notero-synced-notes">${raw
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')}</pre>`;
    },
  };
}

function createStore(
  harness: Harness,
  target: TargetIdentity = targetV4,
): ZoteroTransactionalMetadataStoreV4 {
  return new ZoteroTransactionalMetadataStoreV4(
    harness.parent,
    target.noteItemKey,
    createIdleRecordV4(target, harness.clock),
    harness.clock,
  );
}

function cleanupEntry(): CleanupLedgerEntry {
  const resource = candidateResourceV4('aborted-candidate');
  return {
    attemptCount: 0,
    cleanupID: 'cleanup-test',
    createdAt: clockV4.nowISOString(),
    deleteIntent: null,
    generation: 1,
    lastAttemptAt: null,
    lastObservation: null,
    nextRetryAt: null,
    ownership: ownershipFromResource(resource),
    quarantineEvidenceID: null,
    reason: 'ABORTED_ATTEMPT',
    resource,
    sourceVersion: sourceVersionV4,
    state: 'PENDING',
    transactionID: 'aborted-transaction',
    updatedAt: clockV4.nowISOString(),
    workerLease: null,
  };
}

function withLastKnownGood(record: NoteSyncRecordV4): NoteSyncRecordV4 {
  const candidate = candidateV4('DURABLE', 'last-known-good', {
    generation: 0,
    sourceVersion: 'source:last-known-good',
    transactionID: 'transaction:last-known-good',
  });
  const active = deriveDurableActive(
    candidate,
    'text-only-v1',
    clockV4.nowISOString(),
  );
  return { ...record, active };
}

function idleWithLastKnownGood(): NoteSyncRecordV4 {
  const record = withLastKnownGood(createIdleRecordV4(targetV4, clockV4));
  const active = record.active;
  if (!active) throw new Error('Expected last-known-good fixture');
  return {
    ...record,
    container: active.container,
    requestedSource: {
      featurePolicy: active.featurePolicy,
      manifestDigest: active.manifestDigest,
      observedAt: clockV4.nowISOString(),
      sourceDescriptor: active.sourceDescriptor,
      sourceVersion: active.sourceVersion,
    },
  };
}

function rootFor(record: NoteSyncRecordV4): SyncedNotesRootV4 {
  return {
    container: record.container,
    notes: { [targetV4.noteItemKey]: record },
    rootRevision: 0,
    schemaVersion: 4,
  };
}

function durableTransactionRecord(): NoteSyncRecordV4 {
  return withLastKnownGood(structuredClone(recordV4('CANDIDATE_DURABLE')));
}

function requiredTransaction(record: NoteSyncRecordV4) {
  const transaction = record.mainTransaction;
  if (!transaction) throw new Error('Expected a main transaction fixture');
  return transaction;
}

function requiredCandidate(record: NoteSyncRecordV4) {
  const candidate = requiredTransaction(record).candidate;
  if (!candidate) throw new Error('Expected a candidate fixture');
  return candidate;
}

function requiredCompletion(record: NoteSyncRecordV4) {
  const completion = requiredCandidate(record).completionEvidence;
  if (!completion) throw new Error('Expected completion evidence fixture');
  return completion;
}

function requiredActive(record: NoteSyncRecordV4) {
  const active = record.active;
  if (!active) throw new Error('Expected an active fixture');
  return active;
}

function requiredMainLease(record: NoteSyncRecordV4) {
  const lease = record.writerCoordination.mainLease;
  if (!lease) throw new Error('Expected a main lease fixture');
  return lease;
}

function requiredRequestedSource(record: NoteSyncRecordV4) {
  const source = record.requestedSource;
  if (!source) throw new Error('Expected a requested source fixture');
  return source;
}

function requiredFirstBatch(record: NoteSyncRecordV4) {
  const batch = requiredCandidate(record).batchEvidence[0];
  if (!batch) throw new Error('Expected batch evidence fixture');
  return batch;
}

function uploadAsset(
  label: string,
  fileUploadID: string | null,
  values: Partial<UploadAssetRecordV4> = {},
): UploadAssetRecordV4 {
  const identity = {
    attachmentIdentity: `attachment:${label}`,
    contentHash: `content:${label}`,
    contentLength: 10,
    contentType: 'image/png',
    filename: `${label}.png`,
    sourceIdentity: `source-image:${label}`,
    targetIdentityDigest: deriveTargetIdentityDigest(targetV4),
  };
  const assetIdentityDigest = deriveAssetID(identity);
  const fileUploadBindingDigest = fileUploadID
    ? deriveFileUploadBindingDigest({
        assetIdentityDigest,
        fileUploadID,
        targetIdentityDigest: identity.targetIdentityDigest,
      })
    : null;
  return {
    assetID: assetIdentityDigest,
    assetIdentityDigest,
    attachedAt: clockV4.nowISOString(),
    attachmentKey: `IMAGE_${label}`,
    createOperationID: `operation:create:${label}`,
    expiryTime: null,
    fileUploadBindingDigest,
    fileUploadID,
    generation: 0,
    sendOperationID: `operation:send:${label}`,
    sourceVersion: 'source:last-known-good',
    status: 'ATTACHED',
    transactionID: 'transaction:last-known-good',
    ...identity,
    ...values,
  };
}

type SchemaCorruptionCase = {
  build: () => NoteSyncRecordV4;
  name: string;
};

const schemaCorruptionCases: readonly SchemaCorruptionCase[] = [
  {
    name: '01 transactionID mismatch',
    build: () => {
      const record = durableTransactionRecord();
      requiredCandidate(record).transactionID = 'transaction:other';
      return record;
    },
  },
  {
    name: '02 generation mismatch',
    build: () => {
      const record = durableTransactionRecord();
      requiredCandidate(record).generation += 1;
      return record;
    },
  },
  {
    name: '03 source mismatch',
    build: () => {
      const record = durableTransactionRecord();
      requiredTransaction(record).transactionSourceVersion = 'source:other';
      return record;
    },
  },
  {
    name: '04 target mismatch',
    build: () => {
      const record = durableTransactionRecord();
      requiredTransaction(record).targetIdentityDigest = 'target:other';
      return record;
    },
  },
  {
    name: '05 lease mismatch',
    build: () => {
      const record = durableTransactionRecord();
      requiredMainLease(record).transactionID = 'transaction:other';
      return record;
    },
  },
  {
    name: '06 operation sequence mismatch',
    build: () => {
      const record = withLastKnownGood(
        structuredClone(recordV4('CANDIDATE_VERIFYING')),
      );
      const intent = verifyIntentV4();
      const transaction = requiredTransaction(record);
      transaction.operationIntent = intent;
      transaction.operationSequence = intent.operationSequence + 1;
      return record;
    },
  },
  {
    name: '07 candidate block mismatch',
    build: () => {
      const record = durableTransactionRecord();
      requiredCompletion(record).candidateBlockID = 'block:other';
      return record;
    },
  },
  {
    name: '08 candidate container mismatch',
    build: () => {
      const record = durableTransactionRecord();
      requiredCandidate(record).container.blockID = 'container:other';
      return record;
    },
  },
  {
    name: '09 candidate source mismatch',
    build: () => {
      const record = durableTransactionRecord();
      requiredCandidate(record).sourceVersion = 'source:other';
      return record;
    },
  },
  {
    name: '10 completed batch gap',
    build: () => {
      const record = durableTransactionRecord();
      requiredFirstBatch(record).index = 1;
      return record;
    },
  },
  {
    name: '11 completed batch duplicate',
    build: () => {
      const record = durableTransactionRecord();
      const evidence = requiredFirstBatch(record);
      requiredCandidate(record).batchEvidence.push(structuredClone(evidence));
      return record;
    },
  },
  {
    name: '12 returned child duplicate',
    build: () => {
      const record = durableTransactionRecord();
      const completion = requiredCompletion(record);
      const firstReturnedBlockID = completion.returnedBlockIDs[0];
      if (!firstReturnedBlockID) {
        throw new Error('Expected a returned child fixture');
      }
      completion.returnedBlockIDs.push(firstReturnedBlockID);
      return record;
    },
  },
  {
    name: '13 returned child wrong parent',
    build: () => {
      const record = durableTransactionRecord();
      requiredFirstBatch(record).parentBlockID = 'candidate:other';
      return record;
    },
  },
  {
    name: '14 manifest recompute mismatch',
    build: () => {
      const record = durableTransactionRecord();
      const transaction = requiredTransaction(record);
      const candidate = requiredCandidate(record);
      const completion = requiredCompletion(record);
      const forged = 'manifest:forged';
      requiredRequestedSource(record).manifestDigest = forged;
      transaction.sourceManifestDigest = forged;
      candidate.manifestDigest = forged;
      completion.manifestDigest = forged;
      completion.verificationIntent.details.manifestDigest = forged;
      completion.verificationIntent.requestDigest =
        recomputeOperationRequestDigest(completion.verificationIntent);
      return record;
    },
  },
  {
    name: '15 image asset mapping mismatch',
    build: () => {
      const record = durableTransactionRecord();
      requiredCandidate(record).imageAssetIdentities = ['asset:unbound'];
      return record;
    },
  },
  {
    name: '16 swapped File Upload IDs',
    build: () => {
      const record = idleWithLastKnownGood();
      const first = uploadAsset('a', 'file-upload:a');
      const second = uploadAsset('b', 'file-upload:b');
      first.fileUploadID = 'file-upload:b';
      second.fileUploadID = 'file-upload:a';
      record.uploadAssets = [first, second];
      return record;
    },
  },
  {
    name: '17 completion candidate mismatch',
    build: () => {
      const record = durableTransactionRecord();
      requiredCompletion(record).expectedImageCount = 1;
      return record;
    },
  },
  {
    name: '18 active non-durable',
    build: () => {
      const record = idleWithLastKnownGood();
      requiredActive(record).completionEvidence.completedBatchCount = 0;
      return record;
    },
  },
  {
    name: '19 active in executable cleanup',
    build: () => {
      const record = idleWithLastKnownGood();
      const active = requiredActive(record);
      record.cleanupLedger = [
        {
          ...cleanupEntry(),
          ownership: ownershipFromResource(active.block),
          resource: active.block,
        },
      ];
      return record;
    },
  },
  {
    name: '20 Feature OFF executable upload',
    build: () => {
      const record = withLastKnownGood(structuredClone(recordV4('PREPARING')));
      const transaction = requiredTransaction(record);
      record.uploadAssets = [
        uploadAsset('feature-off', null, {
          attachedAt: null,
          generation: transaction.generation,
          sendOperationID: null,
          sourceVersion: transaction.transactionSourceVersion,
          status: 'CREATE_INTENDED',
          transactionID: transaction.transactionID,
        }),
      ];
      return record;
    },
  },
  {
    name: '21 sealed intent made executable',
    build: () => {
      const record = idleWithLastKnownGood();
      requiredActive(record).completionEvidence.verificationIntent.status =
        'EXECUTABLE';
      return record;
    },
  },
  {
    name: '22 liveness evidence old target',
    build: () => {
      const record = idleWithLastKnownGood();
      const active = requiredActive(record);
      record.remoteVerification = {
        activeObservation: null,
        checkedAt: clockV4.nowISOString(),
        containerObservation: null,
        expectedActive: active.block,
        expectedContainer: record.container,
        outcome: 'EXACT',
        targetIdentityDigest: 'target:old',
        verificationID: 'verification:old-target',
      };
      return record;
    },
  },
] as const;

describe('Zotero schema-v4 transaction store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reloads, compares, merges, setNotes, and saves exactly once in one DB transaction', async () => {
    const harness = createHarness();
    const store = createStore(harness);
    const current = await store.load();

    const persisted = await store.persist(
      { noteRevision: 0, rootRevision: 0 },
      current.record,
    );

    expect(persisted.rootRevision).toBe(1);
    expect(persisted.record.revision).toBe(1);
    expect(zoteroMock.DB.executeTransaction.mock.calls).toHaveLength(1);
    expect(zoteroMock.Items.reload.mock.calls).toContainEqual([
      [harness.attachment.id],
    ]);
    expect(harness.attachment.setNote.mock.calls).toHaveLength(1);
    expect(harness.attachment.save.mock.calls).toStrictEqual([
      [{ skipNotifier: true }],
    ]);
    expect(harness.attachment.saveTx.mock.calls).toHaveLength(0);
  });

  it('rereads mutation authorization inside a read-only Zotero DB transaction', async () => {
    const harness = createHarness();
    const store = createStore(harness);
    await store.load();
    vi.clearAllMocks();

    const snapshot = await store.loadForMutationAuthorization();

    expect(snapshot.record.mainState).toBe('IDLE');
    expect(zoteroMock.DB.executeTransaction.mock.calls).toHaveLength(1);
    expect(zoteroMock.Items.reload.mock.calls).toStrictEqual([
      [[harness.attachment.id]],
    ]);
    expect(harness.attachment.setNote.mock.calls).toHaveLength(0);
    expect(harness.attachment.save.mock.calls).toHaveLength(0);
    expect(harness.attachment.saveTx.mock.calls).toHaveLength(0);
  });

  it.each([
    ['SYNTAX_INVALID', '{broken'],
    ['PARSEABLE_INVALID', JSON.stringify({ schemaVersion: 4 })],
    ['FUTURE_SCHEMA', JSON.stringify({ schemaVersion: 99 })],
  ] as const)(
    'classifies and seals %s metadata without replacing raw evidence',
    async (kind, raw) => {
      const harness = createHarness();
      harness.setMetadataRaw(raw);
      const classified = classifyMetadataRootV4(raw);

      expect(classified.kind).toBe(kind);
      await expect(createStore(harness).load()).rejects.toMatchObject({
        category: kind,
        raw,
      });

      expect(getRawSyncedNotesMetadataFromAttachment(harness.attachment)).toBe(
        raw,
      );
      expect(harness.readQuarantine()).toMatchObject({
        category: kind,
        executable: false,
        raw,
        sealed: true,
      });
      expect(harness.attachment.save.mock.calls).toHaveLength(1);
    },
  );

  it('returns a typed error and restores the in-memory note when quarantine persistence fails', async () => {
    const harness = createHarness();
    const raw = '{syntax-invalid';
    harness.setMetadataRaw(raw);
    const original = harness.attachment.getNote();
    harness.attachment.save.mockRejectedValueOnce(
      new Error('Synthetic local save failure'),
    );

    await expect(createStore(harness).load()).rejects.toBeInstanceOf(
      QuarantinedMetadataError,
    );
    expect(harness.attachment.getNote()).toBe(original);
    expect(getRawSyncedNotesMetadataFromAttachment(harness.attachment)).toBe(
      raw,
    );
  });

  it.each(schemaCorruptionCases)(
    'quarantines schema matrix case $name before any remote mutation or commit',
    async ({ build }) => {
      const harness = createHarness();
      const record = build();
      const activeBlockID = record.active?.block.blockID;
      const raw = JSON.stringify(rootFor(record));
      const remoteMutation = vi.fn<() => void>();
      harness.setMetadataRaw(raw);

      expect(classifyMetadataRootV4(raw).kind).toBe('PARSEABLE_INVALID');
      await expect(
        (async () => {
          await createStore(harness).load();
          remoteMutation();
        })(),
      ).rejects.toMatchObject({ category: 'PARSEABLE_INVALID' });

      expect(remoteMutation).not.toHaveBeenCalled();
      expect(getRawSyncedNotesMetadataFromAttachment(harness.attachment)).toBe(
        raw,
      );
      expect(JSON.parse(raw)).toMatchObject({
        notes: {
          [targetV4.noteItemKey]: {
            active: record.active
              ? { block: { blockID: activeBlockID } }
              : null,
          },
        },
        rootRevision: 0,
      });
      expect(harness.readQuarantine()).toMatchObject({
        category: 'PARSEABLE_INVALID',
        executable: false,
        raw,
        sealed: true,
      });
    },
  );

  it('serializes two writers and rejects the stale writer before setNote/save', async () => {
    const harness = createHarness();
    const firstStore = createStore(harness);
    const secondStore = createStore(harness);
    const first = await firstStore.load();
    const second = await secondStore.load();

    const results = await Promise.allSettled([
      firstStore.persist(
        {
          noteRevision: first.record.revision,
          rootRevision: first.rootRevision,
        },
        first.record,
      ),
      secondStore.persist(
        {
          noteRevision: second.record.revision,
          rootRevision: second.rootRevision,
        },
        second.record,
      ),
    ]);

    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]?.status).toBe('rejected');
    expect(
      results[1]?.status === 'rejected' ? results[1].reason : null,
    ).toBeInstanceOf(StaleRootRevisionError);
    expect(harness.attachment.setNote.mock.calls).toHaveLength(1);
    expect(harness.attachment.save.mock.calls).toHaveLength(1);
  });

  it('preserves another note when a stale different-note writer reloads and retries', async () => {
    const harness = createHarness();
    const otherTarget = { ...targetV4, noteItemKey: 'OTHER_NOTE' };
    const firstStore = createStore(harness);
    const otherStore = createStore(harness, otherTarget);
    const first = await firstStore.load();
    const other = await otherStore.load();

    await firstStore.persist(
      { noteRevision: 0, rootRevision: 0 },
      first.record,
    );
    await expect(
      otherStore.persist(
        { noteRevision: 0, rootRevision: other.rootRevision },
        other.record,
      ),
    ).rejects.toBeInstanceOf(StaleRootRevisionError);
    const refreshedOther = await otherStore.load();
    await otherStore.persist(
      {
        noteRevision: refreshedOther.record.revision,
        rootRevision: refreshedOther.rootRevision,
      },
      refreshedOther.record,
    );

    const root = harness.readRoot();
    expect(Object.keys(root.notes).toSorted()).toStrictEqual([
      'NOTE_TEST',
      'OTHER_NOTE',
    ]);
    expect(root.notes.NOTE_TEST?.revision).toBe(1);
    expect(root.notes.OTHER_NOTE?.revision).toBe(1);
  });

  it('merges cleanup by cleanupID without overwriting newer main progress', async () => {
    const harness = createHarness();
    const store = createStore(harness);
    const main = recordV4('PREPARING');
    await store.persist({ noteRevision: 0, rootRevision: 0 }, main);

    await expect(
      store.mergeCleanupEntry(
        { noteRevision: 0, rootRevision: 0 },
        cleanupEntry(),
      ),
    ).rejects.toBeInstanceOf(StaleRootRevisionError);
    const refreshed = await store.load();
    const merged = await store.mergeCleanupEntry(
      {
        noteRevision: refreshed.record.revision,
        rootRevision: refreshed.rootRevision,
      },
      cleanupEntry(),
    );

    expect(merged.record.mainState).toBe('PREPARING');
    expect(merged.record.mainTransaction?.transactionID).toBe(
      'transaction-test',
    );
    expect(merged.record.cleanupLedger).toHaveLength(1);
    expect(merged.record.cleanupLedger[0]?.cleanupID).toBe('cleanup-test');
  });
});
