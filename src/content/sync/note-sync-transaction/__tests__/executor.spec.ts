import { describe, expect, it, vi } from 'vite-plus/test';

import type { NoteSyncEvent } from '../events';
import {
  type ExecutorEvent,
  NoteSyncTransactionExecutor,
  type RemoteOperationAdapter,
} from '../executor';
import { JsonMetadataStoreAdapter } from '../metadata-store-adapter';
import type { RemoteOperationObservation } from '../recovery';
import { serializeNoteSyncRecord, validateNoteSyncRecordJSON } from '../schema';
import type { NoteSyncRecordV3, OperationIntent } from '../types';

import {
  evidence,
  intent,
  now,
  quarantine,
  record,
  resource,
} from './fixtures';

function createHarness(
  options: {
    executeObservation?: RemoteOperationObservation;
    failWriteAt?: number;
    observeObservation?: RemoteOperationObservation;
  } = {},
) {
  const initial = { ...record('PREPARING'), container: null };
  let raw = serializeNoteSyncRecord(initial);
  let writeCount = 0;
  const events: ExecutorEvent[] = [];
  const execute = vi.fn<RemoteOperationAdapter['execute']>(
    async (operation: OperationIntent): Promise<RemoteOperationObservation> => {
      const durable = parseRecord(raw);
      expect(durable.operationIntent?.operationID).toBe(operation.operationID);
      expect(durable.operationIntent?.requestDigest).toBe(
        operation.requestDigest,
      );
      return (
        options.executeObservation || {
          evidence: evidence(
            operation.operationID,
            'created',
            operation.requestDigest,
          ),
          resource: resource('container', 'container-block'),
          type: 'success',
        }
      );
    },
  );
  const observe = vi.fn<RemoteOperationAdapter['observe']>(
    async (operation: OperationIntent): Promise<RemoteOperationObservation> =>
      options.observeObservation ||
      options.executeObservation || {
        evidence: evidence(
          operation.operationID,
          'created',
          operation.requestDigest,
        ),
        resource: resource('container', 'container-block'),
        type: 'success',
      },
  );
  const remote: RemoteOperationAdapter = { execute, observe };
  const store = new JsonMetadataStoreAdapter({
    read: async () => raw,
    write: async (nextRaw) => {
      writeCount += 1;
      if (writeCount === options.failWriteAt) {
        throw new Error(`Synthetic persist failure ${writeCount}`);
      }
      raw = nextRaw;
    },
  });
  const executor = new NoteSyncTransactionExecutor(store, remote, {
    onEvent: (event) => events.push(event),
  });
  const select = (state: NoteSyncRecordV3): NoteSyncEvent | null =>
    state.state === 'PREPARING' && !state.container
      ? { intent: intent('CREATE_CONTAINER'), type: 'CONTAINER_REQUIRED' }
      : null;
  return { events, execute, executor, observe, raw: () => raw, select };
}

describe('transaction executor effect protocol', () => {
  it('persists matching intent before every remote mutation', async () => {
    const test = createHarness();

    const result = await test.executor.runUntilStable(test.select);

    expect(result.container?.blockID).toBe('container-block');
    expect(test.execute).toHaveBeenCalledTimes(1);
    expect(test.events.map(({ type }) => type)).toStrictEqual([
      'persist-before',
      'persist-after',
      'remote-operation',
      'remote-mutation-committed',
      'response-delivered',
      'persist-after',
    ]);
  });

  it('crash before intent persistence performs no remote operation', async () => {
    const test = createHarness({ failWriteAt: 1 });

    await expect(test.executor.runUntilStable(test.select)).rejects.toThrow(
      'Synthetic persist failure 1',
    );

    expect(test.execute).not.toHaveBeenCalled();
    expect(JSON.parse(test.raw())).toMatchObject({ operationIntent: null });
  });

  it('remote success plus crash before post-result persist recovers by observation', async () => {
    const crashed = createHarness({ failWriteAt: 2 });

    await expect(
      crashed.executor.runUntilStable(crashed.select),
    ).rejects.toThrow('Synthetic persist failure 2');
    expect(crashed.execute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(crashed.raw())).toMatchObject({
      operationIntent: { kind: 'CREATE_CONTAINER', phase: 'INTENDED' },
    });

    let raw = crashed.raw();
    const observe = vi.fn<RemoteOperationAdapter['observe']>(
      async (
        operation: OperationIntent,
      ): Promise<RemoteOperationObservation> => ({
        evidence: evidence(
          operation.operationID,
          'created',
          operation.requestDigest,
        ),
        resource: resource('container', 'container-block'),
        type: 'success',
      }),
    );
    const restarted = new NoteSyncTransactionExecutor(
      new JsonMetadataStoreAdapter({
        read: async () => raw,
        write: async (nextRaw) => {
          raw = nextRaw;
        },
      }),
      { execute: vi.fn<RemoteOperationAdapter['execute']>(), observe },
    );

    const result = await restarted.runUntilStable(crashed.select);

    expect(result.container?.blockID).toBe('container-block');
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('persists uncertainty and exits without an automatic loop', async () => {
    const uncertain: RemoteOperationObservation = {
      diagnostic: {
        ...quarantine('AMBIGUOUS_REMOTE_RESULT'),
        createdAt: now,
        operationID: 'create_container-op',
      },
      type: 'uncertain',
    };
    const test = createHarness({
      executeObservation: uncertain,
      observeObservation: uncertain,
    });

    const result = await test.executor.runUntilStable(test.select);

    expect(result.operationIntent).toMatchObject({ phase: 'UNCERTAIN' });
    expect(test.execute).toHaveBeenCalledTimes(1);
    expect(test.observe).toHaveBeenCalledTimes(1);
  });

  it('JSON restart preserves exact operation identity', async () => {
    const test = createHarness({ failWriteAt: 2 });
    await expect(test.executor.runUntilStable(test.select)).rejects.toThrow(
      'Synthetic persist failure 2',
    );
    const persisted = parseRecord(test.raw());

    expect(persisted.operationIntent?.transactionID).toBe(
      persisted.transactionID,
    );
    expect(persisted.operationIntent?.generation).toBe(persisted.generation);
    expect(persisted.operationIntent?.sourceVersion).toBe(
      persisted.sourceVersion,
    );
  });
});

function parseRecord(raw: string): NoteSyncRecordV3 {
  const parsed = validateNoteSyncRecordJSON(raw);
  if (parsed.validation !== 'valid') {
    throw new Error('Expected valid synthetic transaction metadata');
  }
  return parsed.record;
}
