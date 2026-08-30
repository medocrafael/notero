import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  FakeRuntimeClock,
  createZoteroItemMock,
  zoteroMock,
} from '../../../../../test/utils';
import { getRawSyncedNotesMetadataFromAttachment } from '../../../data/item-data';
import {
  StaleRootRevisionError,
  ZoteroTransactionalMetadataStoreV4,
} from '../metadata-store-adapter';
import { createIdleRecordV4 } from '../model-v4';
import { ownershipFromResource, parseSyncedNotesRootV4 } from '../schema-v4';
import type { CleanupLedgerEntry, TargetIdentity } from '../types-v4';

import {
  candidateResourceV4,
  clockV4,
  recordV4,
  sourceVersionV4,
  targetV4,
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
    readRoot: () => {
      const raw = getRawSyncedNotesMetadataFromAttachment(attachment);
      if (!raw) throw new Error('Expected metadata root');
      return parseSyncedNotesRootV4(JSON.parse(raw));
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
