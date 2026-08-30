import type { MainEventKindV2, MainEventV2 } from './events-v4';
import { deriveDurableActive } from './model-v4';
import type { RuntimeClock } from './runtime-clock';
import { assertTransactionRecord } from './schema-v4';
import {
  MAIN_STATES_V2,
  type CleanupLedgerEntry,
  type MainStateV2,
  type NoteSyncRecordV4,
  type RemoteObservation,
  type SealedOperationIntent,
  type UploadAssetRecordV4,
} from './types-v4';

export type TransitionEffectKind =
  | 'LOCAL_COMMIT'
  | 'NONE'
  | 'REMOTE_MUTATION'
  | 'REMOTE_OBSERVATION';

export type TransitionProducerID =
  | 'atomic-commit-coordinator'
  | 'error-classifier'
  | 'liveness-coordinator'
  | 'main-coordinator'
  | 'remote-operation-observer'
  | 'source-observer';

export type TransitionRuntime = { clock: RuntimeClock };

export type TransitionDefinition = {
  effectKind: TransitionEffectKind;
  eventKind: MainEventKindV2;
  from: readonly MainStateV2[];
  guard: (record: NoteSyncRecordV4, event: MainEventV2) => boolean;
  id: string;
  producerID: TransitionProducerID;
  reducer: (
    record: NoteSyncRecordV4,
    event: MainEventV2,
    runtime: TransitionRuntime,
  ) => NoteSyncRecordV4;
};

function requireTransaction(record: NoteSyncRecordV4) {
  const transaction = record.mainTransaction;
  if (!transaction) throw new Error('Transition requires a main transaction');
  return transaction;
}

function persistIntent(
  record: NoteSyncRecordV4,
  intent: SealedOperationIntent,
): NoteSyncRecordV4 {
  const transaction = requireTransaction(record);
  return {
    ...record,
    mainTransaction: {
      ...transaction,
      operationIntent: intent,
      operationSequence: intent.operationSequence,
    },
  };
}

function clearIntent(record: NoteSyncRecordV4): NoteSyncRecordV4 {
  const transaction = requireTransaction(record);
  return {
    ...record,
    mainTransaction: { ...transaction, operationIntent: null },
  };
}

function upsertUpload(
  assets: UploadAssetRecordV4[],
  next: UploadAssetRecordV4,
): UploadAssetRecordV4[] {
  const index = assets.findIndex(({ assetID }) => assetID === next.assetID);
  if (index === -1) return [...assets, next];
  return assets.map((asset, position) => (position === index ? next : asset));
}

function mergeCleanupEntries(
  current: CleanupLedgerEntry[],
  additions: CleanupLedgerEntry[],
): CleanupLedgerEntry[] {
  const byID = new Map(current.map((entry) => [entry.cleanupID, entry]));
  for (const entry of additions) byID.set(entry.cleanupID, entry);
  return Array.from(byID.values());
}

const executionStates = [
  'PREPARING',
  'CANDIDATE_CREATING',
  'CANDIDATE_WRITING',
  'CANDIDATE_VERIFYING',
  'CANDIDATE_DURABLE',
] as const;

function observationFromEvent(event: MainEventV2): RemoteObservation | null {
  switch (event.type) {
    case 'BATCH_APPENDED':
    case 'CANDIDATE_CREATED':
    case 'CANDIDATE_VERIFIED':
    case 'CONTAINER_CREATED':
    case 'UPLOAD_OBSERVED':
      return event.observation;
    default:
      return null;
  }
}

export const TRANSITION_REGISTRY: readonly TransitionDefinition[] = [
  {
    effectKind: 'NONE',
    eventKind: 'SOURCE_OBSERVED',
    from: MAIN_STATES_V2,
    guard: (record, event) =>
      event.type === 'SOURCE_OBSERVED' &&
      (record.requestedSource?.sourceVersion !== event.source.sourceVersion ||
        record.requestedSource.manifestDigest !== event.source.manifestDigest ||
        record.requestedSource.featurePolicy !== event.source.featurePolicy),
    id: 'M01_SOURCE_OBSERVED',
    producerID: 'source-observer',
    reducer: (record, event) => {
      if (event.type !== 'SOURCE_OBSERVED') throw new Error('Wrong event');
      return { ...record, requestedSource: event.source };
    },
  },
  {
    effectKind: 'NONE',
    eventKind: 'START_SYNC',
    from: ['IDLE'],
    guard: (record, event) =>
      event.type === 'START_SYNC' &&
      event.transaction.purpose === 'SYNC' &&
      record.requestedSource?.sourceVersion ===
        event.transaction.transactionSourceVersion,
    id: 'M02_START_SYNC',
    producerID: 'main-coordinator',
    reducer: (record, event) => {
      if (event.type !== 'START_SYNC') throw new Error('Wrong event');
      return {
        ...record,
        mainState: 'PREPARING',
        mainTransaction: event.transaction,
        writerCoordination: { mainLease: null },
      };
    },
  },
  {
    effectKind: 'NONE',
    eventKind: 'START_LIVENESS',
    from: ['IDLE'],
    guard: (_record, event) =>
      event.type === 'START_LIVENESS' &&
      event.transaction.purpose === 'LIVENESS',
    id: 'M03_START_LIVENESS',
    producerID: 'liveness-coordinator',
    reducer: (record, event) => {
      if (event.type !== 'START_LIVENESS') throw new Error('Wrong event');
      return {
        ...record,
        mainState: 'PREPARING',
        mainTransaction: event.transaction,
        writerCoordination: { mainLease: null },
      };
    },
  },
  {
    effectKind: 'NONE',
    eventKind: 'MAIN_LEASE_ACQUIRED',
    from: executionStates,
    guard: (record, event) => {
      const transaction = record.mainTransaction;
      return (
        event.type === 'MAIN_LEASE_ACQUIRED' &&
        Boolean(transaction) &&
        event.lease.transactionID === transaction?.transactionID &&
        event.lease.generation === transaction.generation
      );
    },
    id: 'M04_MAIN_LEASE_ACQUIRED',
    producerID: 'main-coordinator',
    reducer: (record, event) => {
      if (event.type !== 'MAIN_LEASE_ACQUIRED') throw new Error('Wrong event');
      return {
        ...record,
        writerCoordination: { mainLease: event.lease },
      };
    },
  },
  {
    effectKind: 'NONE',
    eventKind: 'RESUME_AFTER_HALT',
    from: executionStates,
    guard: (record, event) =>
      event.type === 'RESUME_AFTER_HALT' &&
      Boolean(record.mainTransaction?.runHalt),
    id: 'M05_RESUME_AFTER_HALT',
    producerID: 'main-coordinator',
    reducer: (record, event) => {
      if (event.type !== 'RESUME_AFTER_HALT') throw new Error('Wrong event');
      const transaction = requireTransaction(record);
      return {
        ...record,
        mainTransaction: {
          ...transaction,
          operationIntent: null,
          runHalt: null,
        },
        writerCoordination: { mainLease: null },
      };
    },
  },
  {
    effectKind: 'REMOTE_MUTATION',
    eventKind: 'CONTAINER_INTENT_PERSISTED',
    from: ['PREPARING'],
    guard: (record, event) =>
      event.type === 'CONTAINER_INTENT_PERSISTED' && !record.container,
    id: 'M06_CONTAINER_INTENT_PERSISTED',
    producerID: 'main-coordinator',
    reducer: (record, event) => {
      if (event.type !== 'CONTAINER_INTENT_PERSISTED')
        throw new Error('Wrong event');
      return persistIntent(record, event.intent);
    },
  },
  {
    effectKind: 'NONE',
    eventKind: 'CONTAINER_CREATED',
    from: ['PREPARING'],
    guard: (record, event) =>
      event.type === 'CONTAINER_CREATED' &&
      record.mainTransaction?.operationIntent?.kind === 'CREATE_CONTAINER',
    id: 'M07_CONTAINER_CREATED',
    producerID: 'remote-operation-observer',
    reducer: (record, event) => {
      if (event.type !== 'CONTAINER_CREATED') throw new Error('Wrong event');
      const cleared = clearIntent(record);
      return { ...cleared, container: event.container };
    },
  },
  {
    effectKind: 'REMOTE_MUTATION',
    eventKind: 'UPLOAD_INTENT_PERSISTED',
    from: ['PREPARING'],
    guard: (record, event) =>
      event.type === 'UPLOAD_INTENT_PERSISTED' &&
      record.mainTransaction?.featurePolicy === 'embedded-images-v1',
    id: 'M08_UPLOAD_INTENT_PERSISTED',
    producerID: 'main-coordinator',
    reducer: (record, event) => {
      if (event.type !== 'UPLOAD_INTENT_PERSISTED')
        throw new Error('Wrong event');
      return {
        ...persistIntent(record, event.intent),
        uploadAssets: upsertUpload(record.uploadAssets, event.asset),
      };
    },
  },
  {
    effectKind: 'NONE',
    eventKind: 'UPLOAD_OBSERVED',
    from: ['PREPARING'],
    guard: (record, event) =>
      event.type === 'UPLOAD_OBSERVED' &&
      ['UPLOAD_CREATE', 'UPLOAD_SEND'].includes(
        record.mainTransaction?.operationIntent?.kind ?? '',
      ),
    id: 'M09_UPLOAD_OBSERVED',
    producerID: 'remote-operation-observer',
    reducer: (record, event) => {
      if (event.type !== 'UPLOAD_OBSERVED') throw new Error('Wrong event');
      return {
        ...clearIntent(record),
        uploadAssets: upsertUpload(record.uploadAssets, event.asset),
      };
    },
  },
  {
    effectKind: 'REMOTE_MUTATION',
    eventKind: 'CANDIDATE_INTENT_PERSISTED',
    from: ['PREPARING'],
    guard: (record, event) =>
      event.type === 'CANDIDATE_INTENT_PERSISTED' && Boolean(record.container),
    id: 'M10_CANDIDATE_INTENT_PERSISTED',
    producerID: 'main-coordinator',
    reducer: (record, event) => {
      if (event.type !== 'CANDIDATE_INTENT_PERSISTED')
        throw new Error('Wrong event');
      return {
        ...persistIntent(record, event.intent),
        mainState: 'CANDIDATE_CREATING',
      };
    },
  },
  {
    effectKind: 'NONE',
    eventKind: 'CANDIDATE_CREATED',
    from: ['CANDIDATE_CREATING'],
    guard: (record, event) =>
      event.type === 'CANDIDATE_CREATED' &&
      record.mainTransaction?.operationIntent?.kind === 'CREATE_CANDIDATE',
    id: 'M11_CANDIDATE_CREATED',
    producerID: 'remote-operation-observer',
    reducer: (record, event) => {
      if (event.type !== 'CANDIDATE_CREATED') throw new Error('Wrong event');
      const transaction = requireTransaction(record);
      return {
        ...record,
        mainState:
          event.candidate.expectedBatchCount === 0
            ? 'CANDIDATE_VERIFYING'
            : 'CANDIDATE_WRITING',
        mainTransaction: {
          ...transaction,
          candidate: event.candidate,
          operationIntent: null,
        },
      };
    },
  },
  {
    effectKind: 'REMOTE_MUTATION',
    eventKind: 'APPEND_INTENT_PERSISTED',
    from: ['CANDIDATE_WRITING'],
    guard: (record, event) =>
      event.type === 'APPEND_INTENT_PERSISTED' &&
      Boolean(record.mainTransaction?.candidate),
    id: 'M12_APPEND_INTENT_PERSISTED',
    producerID: 'main-coordinator',
    reducer: (record, event) => {
      if (event.type !== 'APPEND_INTENT_PERSISTED')
        throw new Error('Wrong event');
      return persistIntent(record, event.intent);
    },
  },
  {
    effectKind: 'NONE',
    eventKind: 'BATCH_APPENDED',
    from: ['CANDIDATE_WRITING'],
    guard: (record, event) =>
      event.type === 'BATCH_APPENDED' &&
      record.mainTransaction?.operationIntent?.kind === 'APPEND_BATCH',
    id: 'M13_BATCH_APPENDED',
    producerID: 'remote-operation-observer',
    reducer: (record, event) => {
      if (event.type !== 'BATCH_APPENDED') throw new Error('Wrong event');
      const transaction = requireTransaction(record);
      const candidate = transaction.candidate;
      if (!candidate) throw new Error('Append success requires a candidate');
      const batchEvidence = [...candidate.batchEvidence, event.evidence];
      return {
        ...record,
        mainState:
          batchEvidence.length === candidate.expectedBatchCount
            ? 'CANDIDATE_VERIFYING'
            : 'CANDIDATE_WRITING',
        mainTransaction: {
          ...transaction,
          candidate: {
            ...candidate,
            batchEvidence,
            resource: event.candidate,
            status: 'WRITING',
          },
          operationIntent: null,
        },
        uploadAssets: event.attachedAssets.reduce(
          (assets, asset) => upsertUpload(assets, asset),
          record.uploadAssets,
        ),
      };
    },
  },
  {
    effectKind: 'REMOTE_OBSERVATION',
    eventKind: 'VERIFY_INTENT_PERSISTED',
    from: ['CANDIDATE_VERIFYING'],
    guard: (record, event) =>
      event.type === 'VERIFY_INTENT_PERSISTED' &&
      Boolean(record.mainTransaction?.candidate),
    id: 'M14_VERIFY_INTENT_PERSISTED',
    producerID: 'main-coordinator',
    reducer: (record, event) => {
      if (event.type !== 'VERIFY_INTENT_PERSISTED')
        throw new Error('Wrong event');
      return persistIntent(record, event.intent);
    },
  },
  {
    effectKind: 'NONE',
    eventKind: 'CANDIDATE_VERIFIED',
    from: ['CANDIDATE_VERIFYING'],
    guard: (record, event) =>
      event.type === 'CANDIDATE_VERIFIED' &&
      record.mainTransaction?.operationIntent?.kind === 'VERIFY_CANDIDATE',
    id: 'M15_CANDIDATE_VERIFIED',
    producerID: 'remote-operation-observer',
    reducer: (record, event) => {
      if (event.type !== 'CANDIDATE_VERIFIED') throw new Error('Wrong event');
      const transaction = requireTransaction(record);
      const candidate = transaction.candidate;
      if (!candidate) throw new Error('Verification requires a candidate');
      return {
        ...record,
        mainState: 'CANDIDATE_DURABLE',
        mainTransaction: {
          ...transaction,
          candidate: {
            ...candidate,
            completionEvidence: event.completionEvidence,
            status: 'DURABLE',
          },
          operationIntent: null,
        },
      };
    },
  },
  {
    effectKind: 'LOCAL_COMMIT',
    eventKind: 'COMMIT_DURABLE_CANDIDATE',
    from: ['CANDIDATE_DURABLE'],
    guard: (record, event) =>
      event.type === 'COMMIT_DURABLE_CANDIDATE' &&
      record.mainTransaction?.candidate?.status === 'DURABLE',
    id: 'M16_COMMIT_DURABLE_CANDIDATE',
    producerID: 'atomic-commit-coordinator',
    reducer: (record, event, runtime) => {
      if (event.type !== 'COMMIT_DURABLE_CANDIDATE')
        throw new Error('Wrong event');
      const transaction = requireTransaction(record);
      const candidate = transaction.candidate;
      if (!candidate) throw new Error('Commit requires a candidate');
      return {
        ...record,
        active: deriveDurableActive(
          candidate,
          transaction.featurePolicy,
          runtime.clock,
        ),
        cleanupLedger: mergeCleanupEntries(
          record.cleanupLedger,
          event.retiredActiveCleanup ? [event.retiredActiveCleanup] : [],
        ),
        container: candidate.container,
        mainState: 'IDLE',
        mainTransaction: null,
        remoteVerification: null,
        writerCoordination: { mainLease: null },
      };
    },
  },
  {
    effectKind: 'NONE',
    eventKind: 'SUPERSEDE_TRANSACTION',
    from: executionStates,
    guard: (record, event) =>
      event.type === 'SUPERSEDE_TRANSACTION' &&
      !record.mainTransaction?.operationIntent &&
      event.replacement.generation >
        (record.mainTransaction?.generation ?? -1) &&
      event.replacement.transactionSourceVersion ===
        record.requestedSource?.sourceVersion,
    id: 'M17_SUPERSEDE_TRANSACTION',
    producerID: 'main-coordinator',
    reducer: (record, event) => {
      if (event.type !== 'SUPERSEDE_TRANSACTION')
        throw new Error('Wrong event');
      return {
        ...record,
        cleanupLedger: mergeCleanupEntries(
          record.cleanupLedger,
          event.cleanupEntries,
        ),
        mainState: 'PREPARING',
        mainTransaction: event.replacement,
        writerCoordination: { mainLease: null },
      };
    },
  },
  {
    effectKind: 'NONE',
    eventKind: 'OPERATION_PROVEN_UNEXECUTED',
    from: executionStates,
    guard: (record, event) =>
      event.type === 'OPERATION_PROVEN_UNEXECUTED' &&
      Boolean(record.mainTransaction?.operationIntent),
    id: 'M18_OPERATION_PROVEN_UNEXECUTED',
    producerID: 'remote-operation-observer',
    reducer: (record, event) => {
      if (event.type !== 'OPERATION_PROVEN_UNEXECUTED')
        throw new Error('Wrong event');
      const transaction = requireTransaction(record);
      const intent = transaction.operationIntent;
      const uploadAssets = record.uploadAssets.map((asset) => {
        if (
          intent?.kind === 'UPLOAD_CREATE' &&
          asset.assetID === intent.details.assetID
        ) {
          return { ...asset, status: 'FAILED' as const };
        }
        if (
          intent?.kind === 'UPLOAD_SEND' &&
          asset.assetID === intent.details.assetID
        ) {
          return { ...asset, status: 'CREATED_UNSENT' as const };
        }
        return asset;
      });
      return {
        ...record,
        mainTransaction: { ...transaction, operationIntent: null },
        uploadAssets,
      };
    },
  },
  {
    effectKind: 'NONE',
    eventKind: 'OPERATION_REJECTED',
    from: executionStates,
    guard: (record, event) =>
      event.type === 'OPERATION_REJECTED' &&
      Boolean(record.mainTransaction?.operationIntent),
    id: 'M19_OPERATION_REJECTED',
    producerID: 'error-classifier',
    reducer: (record, event) => {
      if (event.type !== 'OPERATION_REJECTED') throw new Error('Wrong event');
      const transaction = requireTransaction(record);
      return {
        ...record,
        mainTransaction: {
          ...transaction,
          operationIntent: null,
          runHalt: event.halt,
        },
        quarantineEvidence: [...record.quarantineEvidence, event.evidence],
      };
    },
  },
  {
    effectKind: 'NONE',
    eventKind: 'OPERATION_UNCERTAIN',
    from: executionStates,
    guard: (record, event) =>
      event.type === 'OPERATION_UNCERTAIN' &&
      Boolean(record.mainTransaction?.operationIntent),
    id: 'M20_OPERATION_UNCERTAIN',
    producerID: 'error-classifier',
    reducer: (record, event) => {
      if (event.type !== 'OPERATION_UNCERTAIN') throw new Error('Wrong event');
      const transaction = requireTransaction(record);
      return {
        ...record,
        mainState: 'QUARANTINED',
        mainTransaction: { ...transaction, operationIntent: null },
        quarantineEvidence: [...record.quarantineEvidence, event.evidence],
        writerCoordination: { mainLease: null },
      };
    },
  },
  {
    effectKind: 'NONE',
    eventKind: 'VALIDATION_QUARANTINED',
    from: MAIN_STATES_V2,
    guard: (_record, event) => event.type === 'VALIDATION_QUARANTINED',
    id: 'M21_VALIDATION_QUARANTINED',
    producerID: 'error-classifier',
    reducer: (record, event) => {
      if (event.type !== 'VALIDATION_QUARANTINED')
        throw new Error('Wrong event');
      return {
        ...record,
        mainState: 'QUARANTINED',
        mainTransaction: record.mainTransaction
          ? { ...record.mainTransaction, operationIntent: null }
          : null,
        quarantineEvidence: [...record.quarantineEvidence, event.evidence],
        writerCoordination: { mainLease: null },
      };
    },
  },
  {
    effectKind: 'REMOTE_OBSERVATION',
    eventKind: 'LIVENESS_INTENT_PERSISTED',
    from: ['PREPARING'],
    guard: (record, event) =>
      event.type === 'LIVENESS_INTENT_PERSISTED' &&
      record.mainTransaction?.purpose === 'LIVENESS',
    id: 'M22_LIVENESS_INTENT_PERSISTED',
    producerID: 'liveness-coordinator',
    reducer: (record, event) => {
      if (event.type !== 'LIVENESS_INTENT_PERSISTED')
        throw new Error('Wrong event');
      return persistIntent(record, event.intent);
    },
  },
  {
    effectKind: 'NONE',
    eventKind: 'LIVENESS_EXACT',
    from: ['PREPARING'],
    guard: (record, event) =>
      event.type === 'LIVENESS_EXACT' &&
      record.mainTransaction?.operationIntent?.kind === 'VERIFY_LIVENESS' &&
      event.verification.outcome === 'EXACT',
    id: 'M23_LIVENESS_EXACT',
    producerID: 'remote-operation-observer',
    reducer: (record, event) => {
      if (event.type !== 'LIVENESS_EXACT') throw new Error('Wrong event');
      return {
        ...record,
        mainState: 'IDLE',
        mainTransaction: null,
        remoteVerification: event.verification,
        writerCoordination: { mainLease: null },
      };
    },
  },
  {
    effectKind: 'NONE',
    eventKind: 'LIVENESS_REPAIR_REQUIRED',
    from: ['PREPARING'],
    guard: (record, event) =>
      event.type === 'LIVENESS_REPAIR_REQUIRED' &&
      record.mainTransaction?.operationIntent?.kind === 'VERIFY_LIVENESS',
    id: 'M24_LIVENESS_REPAIR_REQUIRED',
    producerID: 'remote-operation-observer',
    reducer: (record, event) => {
      if (event.type !== 'LIVENESS_REPAIR_REQUIRED')
        throw new Error('Wrong event');
      return {
        ...record,
        ...(event.clearContainer && { container: null }),
        mainState: 'PREPARING',
        mainTransaction: event.replacement,
        quarantineEvidence: [...record.quarantineEvidence, event.evidence],
        remoteVerification: event.verification,
        writerCoordination: { mainLease: null },
      };
    },
  },
] as const;

export type TransitionResultV2 = {
  effectKind: TransitionEffectKind;
  nextState: NoteSyncRecordV4;
  transitionID: string;
};

export function transitionMainV2(
  record: NoteSyncRecordV4,
  event: MainEventV2,
  runtime: TransitionRuntime,
): TransitionResultV2 {
  assertTransactionRecord(record);
  const matches = TRANSITION_REGISTRY.filter(
    (definition) =>
      definition.eventKind === event.type &&
      definition.from.includes(record.mainState) &&
      definition.guard(record, event),
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one transition for ${record.mainState}/${event.type}; found ${matches.length}`,
    );
  }
  const definition = matches[0];
  if (!definition) throw new Error('Transition registry lookup failed');
  const observation = observationFromEvent(event);
  if (observation) {
    assertTransactionRecord(record, { acceptedObservation: observation });
  }
  const reduced = {
    ...definition.reducer(record, event, runtime),
    updatedAt: runtime.clock.nowISOString(),
  };
  const committedCandidate =
    event.type === 'COMMIT_DURABLE_CANDIDATE'
      ? record.mainTransaction?.candidate
      : undefined;
  const nextState = assertTransactionRecord(reduced, {
    ...(committedCandidate && { committedCandidate }),
  });
  return {
    effectKind: definition.effectKind,
    nextState,
    transitionID: definition.id,
  };
}
