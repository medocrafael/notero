import { describe, expect, it } from 'vite-plus/test';

import {
  transitionCleanupV4,
  type CleanupEventPayloadV4,
} from '../cleanup-ledger-v4';
import { CleanupWorkerV2, selectCleanupWorkV4 } from '../cleanup-worker-v4';
import {
  StaleRecordRevisionError,
  StaleRootRevisionError,
  type TransactionalMetadataStoreV4,
} from '../metadata-store-adapter';
import { createOperationIntent } from '../model-v4';
import type { ProcessSession, RuntimeIdentityFactory } from '../model-v4';
import type { RemoteOperationAdapterV4 } from '../remote-operation-v4';
import { ownershipFromResource } from '../schema-v4';
import type {
  CleanupLedgerEntry,
  CleanupWorkerLease,
  MetadataStoreSnapshot,
  NoteSyncRecordV4,
  RemoteObservation,
  RevisionExpectation,
  SealedOperationIntent,
} from '../types-v4';

import {
  candidateResourceV4,
  clockV4,
  recordV4,
  sourceVersionV4,
} from './fixtures-v4';

function cleanup(
  cleanupID = 'cleanup-v4',
  blockID = 'cleanup-block-v4',
): CleanupLedgerEntry {
  const resource = candidateResourceV4(blockID);
  return {
    attemptCount: 0,
    cleanupID,
    createdAt: clockV4.nowISOString(),
    deleteIntent: null,
    generation: 1,
    lastAttemptAt: null,
    lastObservation: null,
    nextRetryAt: null,
    ownership: ownershipFromResource(resource),
    quarantineEvidenceID: null,
    reason: 'REPLACED_ACTIVE',
    resource,
    sourceVersion: sourceVersionV4,
    state: 'PENDING',
    transactionID: `transaction:${cleanupID}`,
    updatedAt: clockV4.nowISOString(),
    workerLease: null,
  };
}

function lease(entry: CleanupLedgerEntry): CleanupWorkerLease {
  return {
    acquiredAt: clockV4.nowISOString(),
    cleanupID: entry.cleanupID,
    expiresAt: clockV4.addMs(clockV4.nowISOString(), 60_000),
    leaseEpoch: 1,
    leaseID: `lease:${entry.cleanupID}`,
    processSessionID: 'cleanup-process',
  };
}

function deleteIntent(
  entry: CleanupLedgerEntry,
  workerLease: CleanupWorkerLease,
) {
  return createOperationIntent({
    createdAt: clockV4.nowISOString(),
    details: {
      cleanupID: entry.cleanupID,
      exactBlockID: entry.resource.blockID,
      ownership: entry.ownership,
      reason: entry.reason,
    },
    generation: entry.generation,
    kind: 'DELETE_BLOCK',
    leaseEpoch: workerLease.leaseEpoch,
    leaseID: workerLease.leaseID,
    operationID: `operation:${entry.cleanupID}`,
    operationSequence: entry.attemptCount + 1,
    owner: 'CLEANUP',
    processSessionID: workerLease.processSessionID,
    sourceVersion: entry.sourceVersion,
    targetIdentityDigest: entry.resource.targetIdentityDigest,
    transactionID: entry.transactionID,
  });
}

function deletedObservation(
  intent: SealedOperationIntent,
  entry: CleanupLedgerEntry,
): RemoteObservation {
  return {
    attachedUploadIDs: [],
    blockFingerprints: [],
    deletionProof: {
      archived: true,
      exactBlockID: entry.resource.blockID,
      inTrash: true,
    },
    generation: intent.generation,
    observedAt: clockV4.nowISOString(),
    operationID: intent.operationID,
    outcome: 'DELETED',
    remoteResource: entry.resource,
    requestDigest: intent.requestDigest,
    responseClassification: 'exact-in-trash',
    returnedBlockIDs: [entry.resource.blockID],
    sourceVersion: intent.sourceVersion,
    targetIdentityDigest: intent.targetIdentityDigest,
    transactionID: intent.transactionID,
    upload: null,
  };
}

function transition(
  record: NoteSyncRecordV4,
  cleanupID: string,
  event: CleanupEventPayloadV4,
) {
  return transitionCleanupV4(record, cleanupID, {
    ...event,
    occurredAt: clockV4.nowISOString(),
  });
}

class CleanupMemoryStore implements TransactionalMetadataStoreV4 {
  public onLoad: (() => void) | null = null;

  public snapshot: MetadataStoreSnapshot;

  public constructor(record: NoteSyncRecordV4) {
    this.snapshot = {
      legacyMigrationRequired: false,
      record,
      rootRevision: 0,
    };
  }

  public async load() {
    this.onLoad?.();
    return structuredClone(this.snapshot);
  }

  public async loadForMutationAuthorization() {
    return this.load();
  }

  public async persist(
    expectation: RevisionExpectation,
    next: NoteSyncRecordV4,
  ) {
    return this.write(expectation, () => next);
  }

  public async mutate(
    expectation: RevisionExpectation,
    mutation: (current: NoteSyncRecordV4) => NoteSyncRecordV4,
  ) {
    return this.write(expectation, mutation);
  }

  public async mergeCleanupEntry(
    expectation: RevisionExpectation,
    entry: CleanupLedgerEntry,
  ) {
    return this.write(expectation, (current) => ({
      ...current,
      cleanupLedger: [...current.cleanupLedger, entry],
    }));
  }

  private write(
    expectation: RevisionExpectation,
    mutation: (current: NoteSyncRecordV4) => NoteSyncRecordV4,
  ) {
    if (expectation.rootRevision !== this.snapshot.rootRevision) {
      throw new StaleRootRevisionError(
        expectation.rootRevision,
        this.snapshot.rootRevision,
      );
    }
    if (expectation.noteRevision !== this.snapshot.record.revision) {
      throw new StaleRecordRevisionError(
        expectation.noteRevision,
        this.snapshot.record.revision,
      );
    }
    const current = this.snapshot.record;
    this.snapshot = {
      ...this.snapshot,
      record: {
        ...mutation(structuredClone(current)),
        revision: current.revision + 1,
      },
      rootRevision: this.snapshot.rootRevision + 1,
    };
    return structuredClone(this.snapshot);
  }
}

function processSession(): ProcessSession {
  return {
    processSessionID: 'cleanup-process',
    startedAt: clockV4.nowISOString(),
  };
}

function identities(): RuntimeIdentityFactory {
  let sequence = 0;
  return { randomUUID: () => `cleanup-generated-${++sequence}` };
}

describe('orthogonal cleanup ledger FSM', () => {
  it('changes only cleanup-owned fields while moving to confirmed', () => {
    const entry = cleanup();
    const original = { ...recordV4('IDLE'), cleanupLedger: [entry] };
    const workerLease = lease(entry);
    const intended = transition(original, entry.cleanupID, {
      lease: workerLease,
      type: 'CLEANUP_LEASE_ACQUIRED',
    });
    const intent = deleteIntent(entry, workerLease);
    const withIntent = transition(intended, entry.cleanupID, {
      intent,
      type: 'DELETE_INTENT_PERSISTED',
    });
    const confirmed = transition(withIntent, entry.cleanupID, {
      observation: deletedObservation(intent, entry),
      type: 'DELETE_CONFIRMED',
    });

    expect(confirmed.cleanupLedger[0]?.state).toBe('CONFIRMED');
    expect(confirmed.mainState).toBe(original.mainState);
    expect(confirmed.mainTransaction).toBe(original.mainTransaction);
    expect(confirmed.active).toBe(original.active);
    expect(confirmed.requestedSource).toBe(original.requestedSource);
  });

  it('never selects current active and bounds one worker pass', () => {
    const activeRecord = recordV4('CANDIDATE_DURABLE');
    const active = activeRecord.mainTransaction?.candidate;
    if (!active?.completionEvidence)
      throw new Error('Expected durable fixture');
    const activeCleanup = {
      ...cleanup('active-cleanup', active.resource.blockID),
      resource: active.resource,
      ownership: ownershipFromResource(active.resource),
    };
    const record = {
      ...recordV4('IDLE'),
      active: {
        block: active.resource,
        committedAt: clockV4.nowISOString(),
        completionEvidence: active.completionEvidence,
        container: active.container,
        featurePolicy: 'text-only-v1' as const,
        finalizationEvidence: active.finalizationEvidence,
        generation: active.generation,
        imageAssetIdentities: active.imageAssetIdentities,
        manifestDigest: active.manifestDigest,
        sourceDescriptor: active.sourceDescriptor,
        sourceVersion: active.sourceVersion,
        targetIdentityDigest: active.targetIdentityDigest,
        transactionID: active.transactionID,
      },
      cleanupLedger: [
        activeCleanup,
        cleanup('eligible-1', 'block-1'),
        cleanup('eligible-2', 'block-2'),
      ],
      container: active.container,
    };

    const selected = selectCleanupWorkV4(record, clockV4, 'cleanup-process', 1);

    expect(selected).toHaveLength(1);
    expect(selected[0]?.cleanupID).toBe('eligible-1');
  });

  it('persists exact delete intent before the worker calls the remote adapter', async () => {
    const entry = cleanup();
    const initial = { ...recordV4('IDLE'), cleanupLedger: [entry] };
    const store = new CleanupMemoryStore(initial);
    let remoteCalls = 0;
    const remote: RemoteOperationAdapterV4 = {
      execute: async ({ intent }) => {
        remoteCalls += 1;
        const durable = store.snapshot.record.cleanupLedger[0]?.deleteIntent;
        if (durable?.operationID !== intent.operationID) {
          throw new Error('Delete ran without durable exact intent');
        }
        return {
          observation: deletedObservation(intent, entry),
          type: 'OBSERVED',
        };
      },
      observe: async () => {
        throw new Error('No recovery observation expected');
      },
    };
    const worker = new CleanupWorkerV2(
      store,
      remote,
      processSession(),
      clockV4,
      identities(),
      1,
    );

    const result = await worker.runBounded();

    expect(result.errors).toStrictEqual([]);
    expect(remoteCalls).toBe(1);
    expect(store.snapshot.record.cleanupLedger[0]?.state).toBe('CONFIRMED');
    expect(store.snapshot.record.mainState).toBe(initial.mainState);
  });

  it('rereads cleanup authorization after ownership preflight and before delete', async () => {
    const entry = cleanup('post-preflight-cleanup');
    const initial = { ...recordV4('IDLE'), cleanupLedger: [entry] };
    const store = new CleanupMemoryStore(initial);
    const events: string[] = [];
    store.onLoad = () => events.push('durable-reload');
    const remote: RemoteOperationAdapterV4 = {
      execute: async (
        authorization,
        reauthorize?: () => Promise<typeof authorization>,
      ) => {
        events.push('remote-ownership-preflight');
        if (reauthorize) await reauthorize();
        events.push('remote-mutation');
        return {
          observation: deletedObservation(authorization.intent, entry),
          type: 'OBSERVED',
        };
      },
      observe: async () => {
        throw new Error('No recovery observation expected');
      },
    };
    const result = await new CleanupWorkerV2(
      store,
      remote,
      processSession(),
      clockV4,
      identities(),
      1,
    ).runBounded();

    expect(result.errors).toStrictEqual([]);
    const preflight = events.indexOf('remote-ownership-preflight');
    const mutation = events.indexOf('remote-mutation');
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(mutation).toBeGreaterThan(preflight);
    expect(events.slice(preflight + 1, mutation)).toContain('durable-reload');
  });

  it('persists uncertainty without throwing or blocking authoritative state', async () => {
    const entry = cleanup();
    const initial = { ...recordV4('IDLE'), cleanupLedger: [entry] };
    const store = new CleanupMemoryStore(initial);
    const remote: RemoteOperationAdapterV4 = {
      execute: async () => ({
        lastObservation: null,
        reasonCode: 'DELETE_STATE_UNKNOWN',
        redactedMessage: 'Unknown delete result',
        requiredRepair: 'VERIFY_REMOTE_RESOURCE',
        responseClassification: 'http-404-or-inaccessible',
        type: 'UNCERTAIN',
      }),
      observe: async () => {
        throw new Error('No recovery observation expected');
      },
    };
    const worker = new CleanupWorkerV2(
      store,
      remote,
      processSession(),
      clockV4,
      identities(),
      1,
    );

    const result = await worker.runBounded();

    expect(result.errors).toStrictEqual([]);
    expect(store.snapshot.record.cleanupLedger[0]?.state).toBe(
      'DELETE_UNCERTAIN',
    );
    expect(store.snapshot.record.mainState).toBe('IDLE');
    expect(store.snapshot.record.active).toBe(initial.active);
  });

  it('counts every uncertain cleanup cycle and converges to quarantine at the bounded budget', async () => {
    const entry = cleanup('cleanup-bounded', 'block-bounded');
    const initial = { ...recordV4('IDLE'), cleanupLedger: [entry] };
    const store = new CleanupMemoryStore(initial);
    let executeCalls = 0;
    let observeCalls = 0;
    const uncertain = {
      lastObservation: null,
      reasonCode: 'DELETE_STATE_UNKNOWN',
      redactedMessage: 'Unknown delete result',
      requiredRepair: 'VERIFY_REMOTE_RESOURCE' as const,
      responseClassification: 'http-404-or-inaccessible',
      type: 'UNCERTAIN' as const,
    };
    const remote: RemoteOperationAdapterV4 = {
      execute: async () => {
        executeCalls += 1;
        return uncertain;
      },
      observe: async () => {
        observeCalls += 1;
        return uncertain;
      },
    };
    const worker = new CleanupWorkerV2(
      store,
      remote,
      processSession(),
      clockV4,
      identities(),
      1,
    );

    await worker.runBounded();
    expect(store.snapshot.record.cleanupLedger[0]).toMatchObject({
      attemptCount: 1,
      state: 'DELETE_UNCERTAIN',
    });
    clockV4.advance(10 * 60_000);
    await worker.runBounded();
    expect(store.snapshot.record.cleanupLedger[0]).toMatchObject({
      attemptCount: 2,
      state: 'DELETE_UNCERTAIN',
    });
    clockV4.advance(10 * 60_000);
    await worker.runBounded();

    expect(store.snapshot.record.cleanupLedger[0]).toMatchObject({
      attemptCount: 3,
      lastAttemptAt: expect.any(String),
      state: 'QUARANTINED',
    });
    expect(store.snapshot.record.mainState).toBe('IDLE');
    expect(executeCalls).toBe(1);
    expect(observeCalls).toBe(2);
  });
});
