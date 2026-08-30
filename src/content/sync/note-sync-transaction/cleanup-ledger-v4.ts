import type { RuntimeClock } from './runtime-clock';
import { assertTransactionRecord } from './schema-v4';
import type {
  CleanupLedgerEntry,
  CleanupState,
  CleanupWorkerLease,
  NoteSyncRecordV4,
  RemoteObservation,
  SealedOperationIntent,
  SealedQuarantineEvidence,
} from './types-v4';

export type CleanupEventV4 =
  | { lease: CleanupWorkerLease; type: 'CLEANUP_LEASE_ACQUIRED' }
  | {
      intent: Extract<SealedOperationIntent, { kind: 'DELETE_BLOCK' }>;
      type: 'DELETE_INTENT_PERSISTED';
    }
  | { observation: RemoteObservation; type: 'DELETE_CONFIRMED' }
  | {
      nextRetryAt: string;
      observation: RemoteObservation | null;
      type: 'DELETE_PROVEN_LIVE';
    }
  | {
      nextRetryAt: string;
      observation: RemoteObservation | null;
      type: 'DELETE_BECAME_UNCERTAIN';
    }
  | {
      evidence: SealedQuarantineEvidence;
      observation: RemoteObservation | null;
      type: 'CLEANUP_QUARANTINED';
    };

export type CleanupTransitionProducer =
  | 'cleanup-error-classifier'
  | 'cleanup-observer'
  | 'cleanup-worker';

export type CleanupTransitionDefinition = {
  eventKind: CleanupEventV4['type'];
  from: readonly CleanupState[];
  id: string;
  producerID: CleanupTransitionProducer;
};

export const CLEANUP_TRANSITION_REGISTRY: readonly CleanupTransitionDefinition[] =
  [
    {
      eventKind: 'CLEANUP_LEASE_ACQUIRED',
      from: ['PENDING'],
      id: 'C01_LEASE_ACQUIRED',
      producerID: 'cleanup-worker',
    },
    {
      eventKind: 'DELETE_INTENT_PERSISTED',
      from: ['PENDING'],
      id: 'C02_DELETE_INTENT_PERSISTED',
      producerID: 'cleanup-worker',
    },
    {
      eventKind: 'DELETE_CONFIRMED',
      from: ['DELETE_INTENDED', 'DELETE_UNCERTAIN'],
      id: 'C03_DELETE_CONFIRMED',
      producerID: 'cleanup-observer',
    },
    {
      eventKind: 'DELETE_PROVEN_LIVE',
      from: ['DELETE_INTENDED', 'DELETE_UNCERTAIN'],
      id: 'C04_DELETE_PROVEN_LIVE',
      producerID: 'cleanup-observer',
    },
    {
      eventKind: 'DELETE_BECAME_UNCERTAIN',
      from: ['DELETE_INTENDED', 'DELETE_UNCERTAIN'],
      id: 'C05_DELETE_BECAME_UNCERTAIN',
      producerID: 'cleanup-error-classifier',
    },
    {
      eventKind: 'CLEANUP_QUARANTINED',
      from: ['DELETE_INTENDED', 'DELETE_UNCERTAIN'],
      id: 'C06_CLEANUP_QUARANTINED',
      producerID: 'cleanup-error-classifier',
    },
  ] as const;

function updateEntry(
  record: NoteSyncRecordV4,
  cleanupID: string,
  update: (entry: CleanupLedgerEntry) => CleanupLedgerEntry,
): NoteSyncRecordV4 {
  let found = false;
  const cleanupLedger = record.cleanupLedger.map((entry) => {
    if (entry.cleanupID !== cleanupID) return entry;
    found = true;
    return update(entry);
  });
  if (!found) throw new Error(`Cleanup entry ${cleanupID} does not exist`);
  return { ...record, cleanupLedger };
}

function sealDeleteIntent(
  entry: CleanupLedgerEntry,
  status: 'SEALED' | 'UNCERTAIN',
) {
  const intent = entry.deleteIntent;
  if (!intent || intent.kind !== 'DELETE_BLOCK') {
    throw new Error('Cleanup transition requires a delete intent');
  }
  return { ...intent, status };
}

export function transitionCleanupV4(
  record: NoteSyncRecordV4,
  cleanupID: string,
  event: CleanupEventV4,
  clock: RuntimeClock,
): NoteSyncRecordV4 {
  assertTransactionRecord(record);
  const acceptedObservation = 'observation' in event ? event.observation : null;
  if (acceptedObservation) {
    assertTransactionRecord(record, { acceptedObservation });
  }
  const current = record.cleanupLedger.find(
    (entry) => entry.cleanupID === cleanupID,
  );
  if (!current) throw new Error(`Cleanup entry ${cleanupID} does not exist`);
  const definitions = CLEANUP_TRANSITION_REGISTRY.filter(
    (definition) =>
      definition.eventKind === event.type &&
      definition.from.includes(current.state),
  );
  if (definitions.length !== 1) {
    throw new Error(
      `Expected one cleanup transition for ${current.state}/${event.type}; found ${definitions.length}`,
    );
  }
  const now = clock.nowISOString();
  const next = updateEntry(record, cleanupID, (entry) => {
    switch (event.type) {
      case 'CLEANUP_LEASE_ACQUIRED':
        return { ...entry, updatedAt: now, workerLease: event.lease };
      case 'DELETE_INTENT_PERSISTED':
        return {
          ...entry,
          attemptCount: entry.attemptCount + 1,
          deleteIntent: event.intent,
          lastObservation: null,
          nextRetryAt: null,
          state: 'DELETE_INTENDED',
          updatedAt: now,
        };
      case 'DELETE_CONFIRMED':
        return {
          ...entry,
          deleteIntent: null,
          lastObservation: event.observation,
          nextRetryAt: null,
          state: 'CONFIRMED',
          updatedAt: now,
          workerLease: null,
        };
      case 'DELETE_PROVEN_LIVE':
        return {
          ...entry,
          deleteIntent: null,
          lastObservation: event.observation,
          nextRetryAt: event.nextRetryAt,
          state: 'PENDING',
          updatedAt: now,
          workerLease: null,
        };
      case 'DELETE_BECAME_UNCERTAIN':
        return {
          ...entry,
          deleteIntent: sealDeleteIntent(entry, 'UNCERTAIN'),
          lastObservation: event.observation,
          nextRetryAt: event.nextRetryAt,
          state: 'DELETE_UNCERTAIN',
          updatedAt: now,
        };
      case 'CLEANUP_QUARANTINED':
        return {
          ...entry,
          deleteIntent: sealDeleteIntent(entry, 'SEALED'),
          lastObservation: event.observation,
          nextRetryAt: null,
          quarantineEvidenceID: event.evidence.evidenceID,
          state: 'QUARANTINED',
          updatedAt: now,
        };
    }
    throw new Error('Unsupported cleanup event');
  });
  const withEvidence =
    event.type === 'CLEANUP_QUARANTINED'
      ? {
          ...next,
          quarantineEvidence: [...next.quarantineEvidence, event.evidence],
        }
      : next;
  if (
    withEvidence.mainState !== record.mainState ||
    withEvidence.mainTransaction !== record.mainTransaction ||
    withEvidence.active !== record.active ||
    withEvidence.requestedSource !== record.requestedSource
  ) {
    throw new Error('Cleanup transition modified authoritative main state');
  }
  return assertTransactionRecord(withEvidence);
}
