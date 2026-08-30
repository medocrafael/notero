import type { NoteSyncEvent } from './events';
import type { MetadataStoreAdapter } from './metadata-store-adapter';
import { StaleRecordRevisionError } from './metadata-store-adapter';
import {
  observationToEvent,
  type RemoteOperationObservation,
} from './recovery';
import { transition } from './reducer';
import type { NoteSyncRecordV3, OperationIntent } from './types';

export type RemoteOperationAdapter = {
  execute: (intent: OperationIntent) => Promise<RemoteOperationObservation>;
  observe: (intent: OperationIntent) => Promise<RemoteOperationObservation>;
};

export type TransactionEventSelector = (
  record: NoteSyncRecordV3,
) => NoteSyncEvent | null;

export type ExecutorEvent =
  | {
      operationID: string | null;
      revision: number;
      type:
        | 'persist-after'
        | 'persist-before'
        | 'remote-mutation-committed'
        | 'remote-operation'
        | 'response-delivered';
    }
  | { revision: number; type: 'stale-reload' };

export type ExecutorRuntime = {
  maxSteps: number;
  onEvent: (event: ExecutorEvent) => void;
};

const DEFAULT_RUNTIME: ExecutorRuntime = {
  maxSteps: 128,
  onEvent: () => undefined,
};

/**
 * Executes one reducer effect through the mandatory protocol:
 * reducer -> durable intent -> remote action -> observation -> reducer -> CAS.
 */
export class NoteSyncTransactionExecutor {
  private readonly runtime: ExecutorRuntime;

  public constructor(
    private readonly store: MetadataStoreAdapter,
    private readonly remote: RemoteOperationAdapter,
    runtime: Partial<ExecutorRuntime> = {},
  ) {
    this.runtime = { ...DEFAULT_RUNTIME, ...runtime };
  }

  public async runUntilStable(
    selectEvent: TransactionEventSelector,
  ): Promise<NoteSyncRecordV3> {
    for (let step = 0; step < this.runtime.maxSteps; step += 1) {
      const before = await this.store.load();
      if (before.operationIntent) {
        const recovered = await this.recoverIntent(before);
        if (recovered.operationIntent?.phase === 'UNCERTAIN') return recovered;
        continue;
      }
      const event = selectEvent(before);
      if (!event) return before;
      await this.applySelectedEvent(selectEvent, event, before);
    }
    throw new Error(
      `Note synchronization exceeded ${this.runtime.maxSteps} state transitions`,
    );
  }

  private async applySelectedEvent(
    selectEvent: TransactionEventSelector,
    selected: NoteSyncEvent,
    initial: NoteSyncRecordV3,
  ): Promise<NoteSyncRecordV3> {
    let current = initial;
    let event = selected;
    for (;;) {
      const result = transition(current, event);
      const remoteEffect = result.effects.find(
        ({ type }) => type === 'EXECUTE_REMOTE_OPERATION',
      );
      this.runtime.onEvent({
        operationID:
          remoteEffect?.type === 'EXECUTE_REMOTE_OPERATION'
            ? remoteEffect.intent.operationID
            : null,
        revision: current.recordRevision,
        type: 'persist-before',
      });
      let persisted: NoteSyncRecordV3;
      try {
        persisted = await this.store.persist(
          current.recordRevision,
          result.nextState,
        );
      } catch (error) {
        if (!(error instanceof StaleRecordRevisionError)) throw error;
        current = await this.store.load();
        this.runtime.onEvent({
          revision: current.recordRevision,
          type: 'stale-reload',
        });
        if (current.operationIntent) return current;
        const replacement = selectEvent(current);
        if (!replacement) return current;
        event = replacement;
        continue;
      }
      this.runtime.onEvent({
        operationID: persisted.operationIntent?.operationID || null,
        revision: persisted.recordRevision,
        type: 'persist-after',
      });
      if (!remoteEffect || remoteEffect.type !== 'EXECUTE_REMOTE_OPERATION') {
        return persisted;
      }
      this.assertMatchingDurableIntent(persisted, remoteEffect.intent);
      this.runtime.onEvent({
        operationID: remoteEffect.intent.operationID,
        revision: persisted.recordRevision,
        type: 'remote-operation',
      });
      const observation = await this.remote.execute(remoteEffect.intent);
      if (!['proven-unexecuted', 'uncertain'].includes(observation.type)) {
        this.runtime.onEvent({
          operationID: remoteEffect.intent.operationID,
          revision: persisted.recordRevision,
          type: 'remote-mutation-committed',
        });
      }
      return this.persistObservation(persisted, observation);
    }
  }

  private async recoverIntent(
    persisted: NoteSyncRecordV3,
  ): Promise<NoteSyncRecordV3> {
    const intent = persisted.operationIntent;
    if (!intent) return persisted;
    this.assertMatchingDurableIntent(persisted, intent);
    this.runtime.onEvent({
      operationID: intent.operationID,
      revision: persisted.recordRevision,
      type: 'remote-operation',
    });
    const observation = await this.remote.observe(intent);
    return this.persistObservation(persisted, observation);
  }

  private async persistObservation(
    initial: NoteSyncRecordV3,
    observation: RemoteOperationObservation,
  ): Promise<NoteSyncRecordV3> {
    const event = observationToEvent(observation);
    let current = initial;
    for (;;) {
      const expectedOperationID = current.operationIntent?.operationID;
      this.runtime.onEvent({
        operationID: expectedOperationID || null,
        revision: current.recordRevision,
        type: 'response-delivered',
      });
      const result = transition(current, event);
      try {
        const persisted = await this.store.persist(
          current.recordRevision,
          result.nextState,
        );
        this.runtime.onEvent({
          operationID: expectedOperationID || null,
          revision: persisted.recordRevision,
          type: 'persist-after',
        });
        return persisted;
      } catch (error) {
        if (!(error instanceof StaleRecordRevisionError)) throw error;
        const latest = await this.store.load();
        this.runtime.onEvent({
          revision: latest.recordRevision,
          type: 'stale-reload',
        });
        if (latest.operationIntent?.operationID !== expectedOperationID) {
          return latest;
        }
        current = latest;
      }
    }
  }

  private assertMatchingDurableIntent(
    persisted: NoteSyncRecordV3,
    intent: OperationIntent,
  ): void {
    if (
      persisted.operationIntent?.operationID !== intent.operationID ||
      persisted.operationIntent.requestDigest !== intent.requestDigest
    ) {
      throw new Error(
        `Remote operation ${intent.operationID} lacks matching durable intent`,
      );
    }
  }
}
