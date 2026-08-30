import { describe, expect, it } from 'vite-plus/test';

import {
  JsonMetadataStoreAdapter,
  StaleRecordRevisionError,
} from '../metadata-store-adapter';
import { serializeNoteSyncRecord } from '../schema';

import { record } from './fixtures';

describe('recordRevision optimistic concurrency', () => {
  it('rejects two stale executors writing the same note record', async () => {
    let raw = serializeNoteSyncRecord(record('IDLE'));
    const access = {
      read: async () => raw,
      write: async (nextRaw: string) => {
        raw = nextRaw;
      },
    };
    const first = new JsonMetadataStoreAdapter(access);
    const second = new JsonMetadataStoreAdapter(access);
    const firstRead = await first.load();
    const staleRead = await second.load();

    const committed = await first.persist(firstRead.recordRevision, {
      ...firstRead,
      requestedSourceVersion: 'source-version-0001',
    });

    expect(committed.recordRevision).toBe(1);
    await expect(
      second.persist(staleRead.recordRevision, {
        ...staleRead,
        requestedSourceVersion: 'source-version-0002',
      }),
    ).rejects.toBeInstanceOf(StaleRecordRevisionError);
    expect((await second.load()).requestedSourceVersion).toBe(
      'source-version-0001',
    );
  });

  it('confirms exact state and transaction identity after each write', async () => {
    let raw = serializeNoteSyncRecord(record('IDLE'));
    const store = new JsonMetadataStoreAdapter({
      read: async () => raw,
      write: async (nextRaw) => {
        raw = nextRaw;
      },
    });
    const initial = await store.load();

    const persisted = await store.persist(initial.recordRevision, initial);

    expect(persisted.recordRevision).toBe(1);
    expect(persisted.state).toBe('IDLE');
    expect(persisted.transactionID).toBeNull();
  });
});
