import { recomputeOperationRequestDigest } from './identity-v4';
import type { ProcessSession, RuntimeIdentityFactory } from './model-v4';
import type { RuntimeClock } from './runtime-clock';
import { assertTransactionRecord } from './schema-v4';
import type {
  MetadataStoreSnapshot,
  MutationAuthorization,
  SealedOperationIntent,
} from './types-v4';

function authorize(
  snapshot: MetadataStoreSnapshot,
  intent: SealedOperationIntent,
  lease: MutationAuthorization['lease'],
  session: ProcessSession,
  clock: RuntimeClock,
  identity: RuntimeIdentityFactory,
): MutationAuthorization {
  if (intent.status !== 'EXECUTABLE') {
    throw new Error('Only an executable operation intent can authorize I/O');
  }
  if (lease.processSessionID !== session.processSessionID) {
    throw new Error('Operation lease belongs to another process session');
  }
  if (clock.compare(lease.expiresAt, clock.nowISOString()) <= 0) {
    throw new Error('Operation lease expired before remote authorization');
  }
  if (recomputeOperationRequestDigest(intent) !== intent.requestDigest) {
    throw new Error('Operation request digest changed before authorization');
  }
  return {
    authorizedAt: clock.nowISOString(),
    intent,
    lease,
    noteRevision: snapshot.record.revision,
    oneTimeToken: identity.randomUUID(),
    rootRevision: snapshot.rootRevision,
  };
}

export function authorizeMainMutation(
  snapshot: MetadataStoreSnapshot,
  session: ProcessSession,
  clock: RuntimeClock,
  identity: RuntimeIdentityFactory,
): MutationAuthorization {
  const record = assertTransactionRecord(snapshot.record, {
    clock,
    requireCurrentAuthorization: true,
    rootRevision: snapshot.rootRevision,
  });
  const transaction = record.mainTransaction;
  const intent = transaction?.operationIntent;
  const lease = record.writerCoordination.mainLease;
  if (!transaction || !intent || !lease || intent.owner !== 'MAIN') {
    throw new Error('No exact durable main operation authorization exists');
  }
  return authorize(snapshot, intent, lease, session, clock, identity);
}

export function authorizeCleanupMutation(
  snapshot: MetadataStoreSnapshot,
  cleanupID: string,
  session: ProcessSession,
  clock: RuntimeClock,
  identity: RuntimeIdentityFactory,
): MutationAuthorization {
  const record = assertTransactionRecord(snapshot.record, {
    clock,
    requireCurrentAuthorization: true,
    rootRevision: snapshot.rootRevision,
  });
  const cleanup = record.cleanupLedger.find(
    (entry) => entry.cleanupID === cleanupID,
  );
  const intent = cleanup?.deleteIntent;
  const lease = cleanup?.workerLease;
  if (
    !cleanup ||
    cleanup.state !== 'DELETE_INTENDED' ||
    !intent ||
    intent.kind !== 'DELETE_BLOCK' ||
    intent.owner !== 'CLEANUP' ||
    !lease
  ) {
    throw new Error('No exact durable cleanup authorization exists');
  }
  if (record.active?.block.blockID === cleanup.resource.blockID) {
    throw new Error('Current active resource cannot be authorized for cleanup');
  }
  return authorize(snapshot, intent, lease, session, clock, identity);
}
