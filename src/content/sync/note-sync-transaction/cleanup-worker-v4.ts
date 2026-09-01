import { authorizeCleanupMutation } from './authorization-v4';
import {
  type CleanupEventPayloadV4,
  type CleanupEventV4,
  transitionCleanupV4,
} from './cleanup-ledger-v4';
import {
  StaleRecordRevisionError,
  StaleRootRevisionError,
  type TransactionalMetadataStoreV4,
} from './metadata-store-adapter';
import {
  createOperationIntent,
  createSealedQuarantineEvidence,
  type ProcessSession,
  type RuntimeIdentityFactory,
} from './model-v4';
import type { RemoteOperationAdapterV4 } from './remote-operation-v4';
import type { RemoteOperationResultV4 } from './remote-operation-v4';
import type { RuntimeClock } from './runtime-clock';
import type {
  CleanupLedgerEntry,
  CleanupWorkerLease,
  MetadataStoreSnapshot,
  NoteSyncRecordV4,
  RemoteObservation,
  SealedQuarantineEvidence,
} from './types-v4';

const CLEANUP_LEASE_MS = 30_000;
const DEFAULT_LIMIT = 2;
const MAX_ENTRY_ATTEMPTS = 3;
const MAX_LOCAL_PERSIST_RETRIES = 3;

export type CleanupRunResultV4 = {
  errors: string[];
  inspected: number;
  mutationAttempts: number;
  processedCleanupIDs: string[];
};

function due(
  entry: CleanupLedgerEntry,
  clock: RuntimeClock,
  processSessionID: string,
): boolean {
  if (
    !['DELETE_INTENDED', 'DELETE_UNCERTAIN', 'PENDING'].includes(entry.state)
  ) {
    return false;
  }
  if (
    entry.nextRetryAt &&
    clock.compare(entry.nextRetryAt, clock.nowISOString()) > 0
  ) {
    return false;
  }
  const lease = entry.workerLease;
  return (
    !lease ||
    lease.processSessionID === processSessionID ||
    clock.compare(lease.expiresAt, clock.nowISOString()) <= 0
  );
}

export function selectCleanupWorkV4(
  record: NoteSyncRecordV4,
  clock: RuntimeClock,
  processSessionID: string,
  limit = DEFAULT_LIMIT,
): CleanupLedgerEntry[] {
  const activeBlockID = record.active?.block.blockID;
  return record.cleanupLedger
    .filter(
      (entry) =>
        entry.resource.blockID !== activeBlockID &&
        due(entry, clock, processSessionID),
    )
    .toSorted(
      (left, right) =>
        clock.compare(left.updatedAt, right.updatedAt) ||
        left.cleanupID.localeCompare(right.cleanupID),
    )
    .slice(0, Math.max(0, limit));
}

export class CleanupWorkerV2 {
  public constructor(
    private readonly store: TransactionalMetadataStoreV4,
    private readonly remote: RemoteOperationAdapterV4,
    private readonly session: ProcessSession,
    private readonly clock: RuntimeClock,
    private readonly identity: RuntimeIdentityFactory,
    private readonly limit = DEFAULT_LIMIT,
  ) {}

  public async runBounded(): Promise<CleanupRunResultV4> {
    const result: CleanupRunResultV4 = {
      errors: [],
      inspected: 0,
      mutationAttempts: 0,
      processedCleanupIDs: [],
    };
    const initial = await this.store.load();
    const selected = selectCleanupWorkV4(
      initial.record,
      this.clock,
      this.session.processSessionID,
      this.limit,
    );
    result.inspected = selected.length;
    for (const selectedEntry of selected) {
      try {
        const mutated = await this.processOne(selectedEntry.cleanupID);
        result.mutationAttempts += mutated ? 1 : 0;
        result.processedCleanupIDs.push(selectedEntry.cleanupID);
      } catch (error) {
        result.errors.push(
          error instanceof Error ? error.name : 'UnknownError',
        );
      }
    }
    return result;
  }

  private async processOne(cleanupID: string): Promise<boolean> {
    let snapshot = await this.store.load();
    let entry = this.entry(snapshot, cleanupID);
    if (
      !entry ||
      entry.resource.blockID === snapshot.record.active?.block.blockID
    ) {
      return false;
    }
    if (entry.state === 'PENDING') {
      snapshot = await this.apply(snapshot, cleanupID, {
        lease: this.createLease(entry),
        type: 'CLEANUP_LEASE_ACQUIRED',
      });
      entry = this.requireEntry(snapshot, cleanupID);
      const lease = entry.workerLease;
      if (!lease) throw new Error('Cleanup lease was not persisted');
      const operationID = this.identity.randomUUID();
      const intent = createOperationIntent({
        createdAt: this.clock.nowISOString(),
        details: {
          cleanupID: entry.cleanupID,
          exactBlockID: entry.resource.blockID,
          ownership: entry.ownership,
          reason: entry.reason,
        },
        generation: entry.generation,
        kind: 'DELETE_BLOCK',
        leaseEpoch: lease.leaseEpoch,
        leaseID: lease.leaseID,
        operationID,
        operationSequence: entry.attemptCount + 1,
        owner: 'CLEANUP',
        processSessionID: lease.processSessionID,
        sourceVersion: entry.sourceVersion,
        targetIdentityDigest: entry.resource.targetIdentityDigest,
        transactionID: entry.transactionID,
      });
      snapshot = await this.apply(snapshot, cleanupID, {
        intent,
        type: 'DELETE_INTENT_PERSISTED',
      });
      // Reload and authorize immediately before the one mutation attempt.
      snapshot = await this.store.load();
      entry = this.requireEntry(snapshot, cleanupID);
      if (entry.deleteIntent?.operationID !== operationID) return false;
      const authorization = authorizeCleanupMutation(
        snapshot,
        cleanupID,
        this.session,
        this.clock,
        this.identity,
      );
      const remoteResult = await this.executeSafely(authorization, async () => {
        const latest = await this.store.loadForMutationAuthorization();
        return authorizeCleanupMutation(
          latest,
          cleanupID,
          this.session,
          this.clock,
          this.identity,
        );
      });
      await this.applyResult(snapshot, cleanupID, remoteResult);
      return true;
    }
    const intent = entry.deleteIntent;
    if (
      (entry.state === 'DELETE_INTENDED' ||
        entry.state === 'DELETE_UNCERTAIN') &&
      intent?.kind === 'DELETE_BLOCK'
    ) {
      const attemptedAt = this.clock.nowISOString();
      snapshot = await this.apply(snapshot, cleanupID, {
        attemptedAt,
        lease: this.createLease(entry),
        type: 'CLEANUP_CYCLE_STARTED',
      });
      entry = this.requireEntry(snapshot, cleanupID);
      const currentIntent = entry.deleteIntent;
      if (!currentIntent || currentIntent.kind !== 'DELETE_BLOCK') return false;
      const remoteResult = await this.observeSafely(currentIntent);
      await this.applyResult(snapshot, cleanupID, remoteResult);
    }
    return false;
  }

  private async applyResult(
    snapshot: MetadataStoreSnapshot,
    cleanupID: string,
    result: RemoteOperationResultV4,
  ): Promise<void> {
    const entry = this.requireEntry(snapshot, cleanupID);
    let event: CleanupEventPayloadV4;
    if (
      result.type === 'OBSERVED' &&
      result.observation.outcome === 'DELETED' &&
      result.observation.deletionProof?.exactBlockID === entry.resource.blockID
    ) {
      event = {
        observation: result.observation,
        type: 'DELETE_CONFIRMED',
      };
    } else if (result.type === 'PROVEN_UNEXECUTED') {
      event =
        entry.attemptCount >= MAX_ENTRY_ATTEMPTS
          ? this.quarantineEvent(
              snapshot,
              entry,
              null,
              'DELETE_RETRY_BUDGET_EXHAUSTED',
              result.responseClassification,
              'NONE',
            )
          : {
              nextRetryAt: this.nextRetryAt(entry.attemptCount),
              observation: null,
              type: 'DELETE_PROVEN_LIVE',
            };
    } else if (result.type === 'REJECTED') {
      event = this.quarantineEvent(
        snapshot,
        entry,
        null,
        result.classification,
        result.responseClassification,
        result.classification === 'AUTH_REQUIRED'
          ? 'RECONNECT_NOTION'
          : result.classification === 'PERMISSION_REQUIRED'
            ? 'RESTORE_CAPABILITY'
            : 'NONE',
      );
    } else if (
      result.type === 'UNCERTAIN' &&
      result.reasonCode === 'OWNERSHIP_CHANGED'
    ) {
      event = this.quarantineEvent(
        snapshot,
        entry,
        result.lastObservation,
        'OWNERSHIP_CHANGED',
        result.responseClassification,
        'VERIFY_REMOTE_RESOURCE',
      );
    } else {
      const observation =
        result.type === 'UNCERTAIN'
          ? result.lastObservation
          : result.type === 'OBSERVED'
            ? result.observation
            : null;
      const responseClassification =
        result.type === 'UNCERTAIN'
          ? result.responseClassification
          : 'non-delete-observation';
      event =
        entry.attemptCount >= MAX_ENTRY_ATTEMPTS
          ? this.quarantineEvent(
              snapshot,
              entry,
              observation,
              'DELETE_OUTCOME_UNRESOLVED',
              responseClassification,
              'VERIFY_REMOTE_RESOURCE',
            )
          : {
              nextRetryAt: this.nextRetryAt(entry.attemptCount),
              observation,
              type: 'DELETE_BECAME_UNCERTAIN',
            };
    }
    await this.apply(snapshot, cleanupID, event);
  }

  private quarantineEvent(
    snapshot: MetadataStoreSnapshot,
    entry: CleanupLedgerEntry,
    observation: RemoteObservation | null,
    reasonCode: string,
    responseClassification: string,
    requiredRepair: SealedQuarantineEvidence['requiredRepair'],
  ): Extract<CleanupEventPayloadV4, { type: 'CLEANUP_QUARANTINED' }> {
    const intent = entry.deleteIntent;
    if (!intent) throw new Error('Cleanup quarantine lost its delete intent');
    return {
      evidence: createSealedQuarantineEvidence({
        clock: this.clock,
        evidenceID: this.identity.randomUUID(),
        generation: entry.generation,
        intent,
        noteRevision: snapshot.record.revision,
        observation,
        origin: 'CLEANUP',
        reasonCode,
        requiredRepair,
        resource: entry.resource,
        responseClassification,
        rootRevision: snapshot.rootRevision,
        sourceVersion: entry.sourceVersion,
        transactionID: entry.transactionID,
      }),
      observation,
      type: 'CLEANUP_QUARANTINED',
    };
  }

  private async apply(
    initial: MetadataStoreSnapshot,
    cleanupID: string,
    payload: CleanupEventPayloadV4,
  ): Promise<MetadataStoreSnapshot> {
    let snapshot = initial;
    const event = {
      ...payload,
      occurredAt: this.clock.nowISOString(),
    } as CleanupEventV4;
    for (let attempt = 0; attempt < MAX_LOCAL_PERSIST_RETRIES; attempt += 1) {
      try {
        return await this.store.mutate(
          {
            noteRevision: snapshot.record.revision,
            rootRevision: snapshot.rootRevision,
          },
          (current) => transitionCleanupV4(current, cleanupID, event),
        );
      } catch (error) {
        if (
          !(error instanceof StaleRecordRevisionError) &&
          !(error instanceof StaleRootRevisionError)
        ) {
          throw error;
        }
        snapshot = await this.store.load();
      }
    }
    throw new Error('Cleanup metadata persist retry budget exhausted');
  }

  private createLease(entry: CleanupLedgerEntry): CleanupWorkerLease {
    const acquiredAt = this.clock.nowISOString();
    return {
      acquiredAt,
      cleanupID: entry.cleanupID,
      expiresAt: this.clock.addMs(acquiredAt, CLEANUP_LEASE_MS),
      leaseEpoch:
        Math.max(entry.workerLease?.leaseEpoch ?? 0, entry.attemptCount) + 1,
      leaseID: this.identity.randomUUID(),
      processSessionID: this.session.processSessionID,
    };
  }

  private nextRetryAt(attemptCount: number): string {
    const delay = Math.min(5 * 60_000, 1_000 * 2 ** Math.max(0, attemptCount));
    return this.clock.addMs(this.clock.nowISOString(), delay);
  }

  private entry(snapshot: MetadataStoreSnapshot, cleanupID: string) {
    return snapshot.record.cleanupLedger.find(
      (candidate) => candidate.cleanupID === cleanupID,
    );
  }

  private requireEntry(
    snapshot: MetadataStoreSnapshot,
    cleanupID: string,
  ): CleanupLedgerEntry {
    const entry = this.entry(snapshot, cleanupID);
    if (!entry) throw new Error(`Cleanup entry ${cleanupID} disappeared`);
    return entry;
  }

  private async executeSafely(
    authorization: Parameters<RemoteOperationAdapterV4['execute']>[0],
    reauthorize: Parameters<RemoteOperationAdapterV4['execute']>[1],
  ): Promise<RemoteOperationResultV4> {
    try {
      return await this.remote.execute(authorization, reauthorize);
    } catch (error) {
      return this.unexpected(error);
    }
  }

  private async observeSafely(
    intent: Parameters<RemoteOperationAdapterV4['observe']>[0],
  ): Promise<RemoteOperationResultV4> {
    try {
      return await this.remote.observe(intent);
    } catch (error) {
      return this.unexpected(error);
    }
  }

  private unexpected(error: unknown): RemoteOperationResultV4 {
    return {
      lastObservation: null,
      reasonCode: 'UNCLASSIFIED_CLEANUP_FAILURE',
      redactedMessage: error instanceof Error ? error.name : 'UnknownError',
      requiredRepair: 'VERIFY_REMOTE_RESOURCE',
      responseClassification: 'unclassified-exception',
      type: 'UNCERTAIN',
    };
  }
}
