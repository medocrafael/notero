import { describe, expect, it } from 'vite-plus/test';

import { MainCoordinatorV2 } from '../coordinator-v4';
import { MainTransactionExecutorV2 } from '../executor-v4';
import { knownRemoteCreator } from '../identity-v4';
import {
  StaleRecordRevisionError,
  StaleRootRevisionError,
  type TransactionalMetadataStoreV4,
} from '../metadata-store-adapter';
import { createIdleRecordV4 } from '../model-v4';
import type { ProcessSession, RuntimeIdentityFactory } from '../model-v4';
import type {
  RemoteOperationAdapterV4,
  RemoteOperationResultV4,
} from '../remote-operation-v4';
import { transitionMainV2 } from '../transition-registry';
import type {
  ManagedResourceIdentity,
  MetadataStoreSnapshot,
  MutationAuthorization,
  NoteSyncRecordV4,
  RemoteObservation,
  RemoteVerificationState,
  RevisionExpectation,
  SealedOperationIntent,
  SourceSnapshotV4,
} from '../types-v4';

import {
  clockV4,
  sourceVersionV4,
  targetV4,
  textSourceSnapshotV4,
} from './fixtures-v4';

function identity(prefix: string): RuntimeIdentityFactory {
  let sequence = 0;
  return { randomUUID: () => `${prefix}-${++sequence}` };
}

function source(): SourceSnapshotV4 {
  return textSourceSnapshotV4();
}

class MemoryStore implements TransactionalMetadataStoreV4 {
  public snapshot: MetadataStoreSnapshot;

  public constructor(record: NoteSyncRecordV4) {
    this.snapshot = {
      legacyMigrationRequired: false,
      record,
      rootRevision: 0,
    };
  }

  public async load(): Promise<MetadataStoreSnapshot> {
    return structuredClone(this.snapshot);
  }

  public async persist(
    expectation: RevisionExpectation,
    nextRecord: NoteSyncRecordV4,
  ): Promise<MetadataStoreSnapshot> {
    return this.write(expectation, () => nextRecord);
  }

  public async mutate(
    expectation: RevisionExpectation,
    mutation: (current: NoteSyncRecordV4) => NoteSyncRecordV4,
  ): Promise<MetadataStoreSnapshot> {
    return this.write(expectation, mutation);
  }

  public async mergeCleanupEntry(
    expectation: RevisionExpectation,
    entry: NoteSyncRecordV4['cleanupLedger'][number],
  ): Promise<MetadataStoreSnapshot> {
    return this.write(expectation, (current) => ({
      ...current,
      cleanupLedger: [...current.cleanupLedger, entry],
    }));
  }

  private write(
    expectation: RevisionExpectation,
    mutation: (current: NoteSyncRecordV4) => NoteSyncRecordV4,
  ): MetadataStoreSnapshot {
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
    const proposed = mutation(structuredClone(this.snapshot.record));
    this.snapshot = {
      ...this.snapshot,
      record: {
        ...proposed,
        revision: this.snapshot.record.revision + 1,
      },
      rootRevision: this.snapshot.rootRevision + 1,
    };
    return structuredClone(this.snapshot);
  }
}

function observation(
  intent: SealedOperationIntent,
  values: Partial<RemoteObservation>,
): RemoteObservation {
  return {
    attachedUploadIDs: [],
    blockFingerprints: [],
    deletionProof: null,
    generation: intent.generation,
    observedAt: clockV4.nowISOString(),
    operationID: intent.operationID,
    outcome: 'UNKNOWN',
    remoteResource: null,
    requestDigest: intent.requestDigest,
    responseClassification: 'scripted',
    returnedBlockIDs: [],
    sourceVersion: intent.sourceVersion,
    targetIdentityDigest: intent.targetIdentityDigest,
    transactionID: intent.transactionID,
    upload: null,
    ...values,
  };
}

class ScriptedRemote implements RemoteOperationAdapterV4 {
  public readonly executed: string[] = [];
  public readonly observed: string[] = [];

  public constructor(private readonly store: MemoryStore) {}

  public async execute(
    authorization: MutationAuthorization,
  ): Promise<RemoteOperationResultV4> {
    const durable = this.store.snapshot.record.mainTransaction?.operationIntent;
    if (durable?.operationID !== authorization.intent.operationID) {
      throw new Error('Remote mutation ran without its durable intent');
    }
    this.executed.push(authorization.intent.operationID);
    return this.success(authorization.intent);
  }

  public async observe(
    intent: SealedOperationIntent,
  ): Promise<RemoteOperationResultV4> {
    this.observed.push(intent.operationID);
    return this.success(intent);
  }

  private resource(
    intent: Extract<
      SealedOperationIntent,
      { kind: 'CREATE_CANDIDATE' | 'CREATE_CONTAINER' }
    >,
  ): ManagedResourceIdentity {
    const details = intent.details;
    const createdByID = knownRemoteCreator(details.expectedCreator);
    if (!createdByID) throw new Error('Test remote creator is unknown');
    return {
      blockID: `block:${intent.operationID}`,
      createdByID,
      kind: intent.kind === 'CREATE_CONTAINER' ? 'container' : 'note',
      lastEditedTime: clockV4.nowISOString(),
      operationMarker: details.operationMarker,
      ownershipMarker: details.ownershipMarker,
      parent: details.parent,
      targetIdentityDigest:
        intent.kind === 'CREATE_CONTAINER'
          ? intent.details.resourceTargetIdentityDigest
          : intent.targetIdentityDigest,
      versionMarker: details.versionMarker,
    };
  }

  private success(intent: SealedOperationIntent): RemoteOperationResultV4 {
    switch (intent.kind) {
      case 'CREATE_CONTAINER':
      case 'CREATE_CANDIDATE':
        return {
          observation: observation(intent, {
            outcome: 'CREATED',
            remoteResource: this.resource(intent),
            returnedBlockIDs: [`block:${intent.operationID}`],
          }),
          type: 'OBSERVED',
        };
      case 'APPEND_BATCH':
        return {
          observation: observation(intent, {
            blockFingerprints: intent.details.blockFingerprints,
            outcome: 'APPENDED',
            remoteResource: intent.details.candidate,
            returnedBlockIDs: intent.details.blockFingerprints.map(
              (_fingerprint, index) =>
                `child:${intent.details.batchIndex}:${index}`,
            ),
          }),
          type: 'OBSERVED',
        };
      case 'VERIFY_CANDIDATE':
        return {
          observation: observation(intent, {
            blockFingerprints: intent.details.blockFingerprints,
            outcome: 'VERIFIED',
            remoteResource: intent.details.candidate,
            returnedBlockIDs: intent.details.returnedBlockIDs,
          }),
          type: 'OBSERVED',
        };
      case 'FINALIZE_CANDIDATE':
        return {
          observation: observation(intent, {
            outcome: 'FINALIZED',
            remoteResource: intent.details.candidate,
            returnedBlockIDs: [intent.details.candidate.blockID],
          }),
          type: 'OBSERVED',
        };
      case 'VERIFY_LIVENESS': {
        const exact = (resource: ManagedResourceIdentity | null) =>
          resource
            ? observation(intent, {
                outcome: 'EXACT',
                remoteResource: resource,
                returnedBlockIDs: [resource.blockID],
              })
            : null;
        const verification: RemoteVerificationState = {
          activeObservation: exact(intent.details.active),
          checkedAt: clockV4.nowISOString(),
          containerObservation: exact(intent.details.container),
          expectedActive: intent.details.active,
          expectedContainer: intent.details.container,
          outcome: 'EXACT',
          targetIdentityDigest: intent.targetIdentityDigest,
          verificationID: intent.operationID,
        };
        return {
          observation: observation(intent, { outcome: 'EXACT' }),
          type: 'OBSERVED',
          verification,
        };
      }
      case 'UPLOAD_CREATE':
      case 'UPLOAD_SEND':
      case 'DELETE_BLOCK':
        throw new Error(`Unexpected scripted operation ${intent.kind}`);
    }
    throw new Error('Unsupported scripted operation');
  }
}

function session(id: string): ProcessSession {
  return { processSessionID: id, startedAt: clockV4.nowISOString() };
}

describe('FSM v2 main executor', () => {
  it('persists every exact intent before remote execution and commits locally', async () => {
    const process = session('process-v4');
    const store = new MemoryStore(createIdleRecordV4(targetV4, clockV4));
    const ids = identity('executor');
    const coordinator = new MainCoordinatorV2(
      source(),
      targetV4,
      process,
      clockV4,
      ids,
    );
    const remote = new ScriptedRemote(store);
    const executor = new MainTransactionExecutorV2(
      store,
      coordinator,
      remote,
      process,
      clockV4,
      ids,
    );

    const result = await executor.runUntilStable();

    expect(result.status).toBe('STABLE');
    expect(result.snapshot.record.mainState).toBe('IDLE');
    expect(result.snapshot.record.active?.sourceVersion).toBe(sourceVersionV4);
    expect(remote.executed.length).toBeGreaterThanOrEqual(3);
    expect(result.snapshot.record.mainTransaction).toBeNull();
  });

  it('observes a durable pre-restart intent before acquiring a new session lease', async () => {
    const oldSession = session('old-process');
    const oldIDs = identity('old');
    const oldCoordinator = new MainCoordinatorV2(
      source(),
      targetV4,
      oldSession,
      clockV4,
      oldIDs,
    );
    let record = createIdleRecordV4(targetV4, clockV4);
    for (let step = 0; step < 4; step += 1) {
      const event = oldCoordinator.select(record);
      if (!event) throw new Error('Expected restart setup event');
      record = transitionMainV2(record, event).nextState;
    }
    const recoveredOperationID =
      record.mainTransaction?.operationIntent?.operationID;
    if (!recoveredOperationID) throw new Error('Expected durable operation');
    const store = new MemoryStore(record);
    const newSession = session('new-process');
    const newIDs = identity('new');
    const coordinator = new MainCoordinatorV2(
      source(),
      targetV4,
      newSession,
      clockV4,
      newIDs,
    );
    const remote = new ScriptedRemote(store);
    const executor = new MainTransactionExecutorV2(
      store,
      coordinator,
      remote,
      newSession,
      clockV4,
      newIDs,
    );

    const result = await executor.runUntilStable();

    expect(result.status).toBe('STABLE');
    expect(remote.observed).toContain(recoveredOperationID);
    expect(remote.executed).not.toContain(recoveredOperationID);
    expect(result.snapshot.record.active?.sourceVersion).toBe(sourceVersionV4);
  });

  it('halts after one permanent mutation rejection in a run', async () => {
    const process = session('reject-process');
    const ids = identity('reject');
    const store = new MemoryStore(createIdleRecordV4(targetV4, clockV4));
    const coordinator = new MainCoordinatorV2(
      source(),
      targetV4,
      process,
      clockV4,
      ids,
    );
    let calls = 0;
    const remote: RemoteOperationAdapterV4 = {
      execute: async () => {
        calls += 1;
        return {
          classification: 'PERMISSION_REQUIRED',
          proof: 'NOT_EXECUTED',
          redactedMessage: 'Permission required',
          responseClassification: 'http-403',
          type: 'REJECTED',
        };
      },
      observe: async () => {
        throw new Error('No recovery observation expected');
      },
    };
    const executor = new MainTransactionExecutorV2(
      store,
      coordinator,
      remote,
      process,
      clockV4,
      ids,
    );

    const result = await executor.runUntilStable();

    expect(result.status).toBe('HALTED');
    expect(calls).toBe(1);
    expect(
      result.snapshot.record.mainTransaction?.runHalt?.classification,
    ).toBe('PERMISSION_REQUIRED');
    expect(
      result.snapshot.record.quarantineEvidence[0]?.originalOperationIntent
        ?.status,
    ).toBe('SEALED');
  });

  it('resumes a persisted halt once in a new invocation without same-run replay', async () => {
    const firstProcess = session('first-reject-process');
    const firstIDs = identity('first-reject');
    const store = new MemoryStore(createIdleRecordV4(targetV4, clockV4));
    let calls = 0;
    const rejectingRemote: RemoteOperationAdapterV4 = {
      execute: async () => {
        calls += 1;
        return {
          classification: 'PERMISSION_REQUIRED',
          proof: 'NOT_EXECUTED',
          redactedMessage: 'Permission required',
          responseClassification: 'http-403',
          type: 'REJECTED',
        };
      },
      observe: async () => {
        throw new Error('Rejected operations are proven unexecuted');
      },
    };
    const first = await new MainTransactionExecutorV2(
      store,
      new MainCoordinatorV2(
        source(),
        targetV4,
        firstProcess,
        clockV4,
        firstIDs,
      ),
      rejectingRemote,
      firstProcess,
      clockV4,
      firstIDs,
    ).runUntilStable();
    expect(first.status).toBe('HALTED');
    expect(calls).toBe(1);

    const secondProcess = session('second-reject-process');
    const secondIDs = identity('second-reject');
    const second = await new MainTransactionExecutorV2(
      store,
      new MainCoordinatorV2(
        source(),
        targetV4,
        secondProcess,
        clockV4,
        secondIDs,
        {
          resumeHalted: true,
        },
      ),
      rejectingRemote,
      secondProcess,
      clockV4,
      secondIDs,
    ).runUntilStable();

    expect(second.status).toBe('HALTED');
    expect(second.mutationAttempts).toBe(1);
    expect(calls).toBe(2);
    expect(second.transitionIDs).toContain('M05_RESUME_AFTER_HALT');
    expect(second.transitionIDs).toContain('M19_OPERATION_REJECTED');
  });

  it('halts locally without remote I/O when the mutation budget is zero', async () => {
    const process = session('zero-budget-process');
    const ids = identity('zero-budget');
    const store = new MemoryStore(createIdleRecordV4(targetV4, clockV4));
    let calls = 0;
    const remote: RemoteOperationAdapterV4 = {
      execute: async () => {
        calls += 1;
        throw new Error('Mutation must not execute');
      },
      observe: async () => {
        throw new Error('Fresh intent must not be observed');
      },
    };
    const result = await new MainTransactionExecutorV2(
      store,
      new MainCoordinatorV2(source(), targetV4, process, clockV4, ids),
      remote,
      process,
      clockV4,
      ids,
      128,
      0,
    ).runUntilStable();

    expect(result.status).toBe('HALTED');
    expect(result.mutationAttempts).toBe(0);
    expect(calls).toBe(0);
    expect(
      result.snapshot.record.mainTransaction?.runHalt?.classification,
    ).toBe('TRANSIENT_BUDGET_EXHAUSTED');
  });

  it('routes an invariant-invalid remote observation to production M21', async () => {
    const process = session('invalid-observation-process');
    const ids = identity('invalid-observation');
    const store = new MemoryStore(createIdleRecordV4(targetV4, clockV4));
    const scripted = new ScriptedRemote(store);
    const remote: RemoteOperationAdapterV4 = {
      execute: async (authorization) => {
        const result = await scripted.execute(authorization);
        if (result.type !== 'OBSERVED') return result;
        return {
          ...result,
          observation: {
            ...result.observation,
            requestDigest: 'tampered-observation-digest',
          },
        };
      },
      observe: (intent) => scripted.observe(intent),
    };
    const result = await new MainTransactionExecutorV2(
      store,
      new MainCoordinatorV2(source(), targetV4, process, clockV4, ids),
      remote,
      process,
      clockV4,
      ids,
    ).runUntilStable();

    expect(result.status).toBe('QUARANTINED');
    expect(result.transitionIDs).toContain('M21_VALIDATION_QUARANTINED');
    expect(
      result.snapshot.record.quarantineEvidence.at(-1)?.originalOperationIntent
        ?.status,
    ).toBe('SEALED');
  });

  it('consumes force-liveness once and returns stable after exact evidence', async () => {
    const firstProcess = session('force-setup-process');
    const firstIDs = identity('force-setup');
    const store = new MemoryStore(createIdleRecordV4(targetV4, clockV4));
    await new MainTransactionExecutorV2(
      store,
      new MainCoordinatorV2(
        source(),
        targetV4,
        firstProcess,
        clockV4,
        firstIDs,
      ),
      new ScriptedRemote(store),
      firstProcess,
      clockV4,
      firstIDs,
    ).runUntilStable();

    const forceProcess = session('force-process');
    const forceIDs = identity('force');
    const result = await new MainTransactionExecutorV2(
      store,
      new MainCoordinatorV2(
        source(),
        targetV4,
        forceProcess,
        clockV4,
        forceIDs,
        {
          forceLiveness: true,
        },
      ),
      new ScriptedRemote(store),
      forceProcess,
      clockV4,
      forceIDs,
    ).runUntilStable();

    expect(result.status).toBe('STABLE');
    expect(
      result.transitionIDs.filter((id) => id === 'M03_START_LIVENESS'),
    ).toHaveLength(1);
    expect(
      result.transitionIDs.filter((id) => id === 'M23_LIVENESS_EXACT'),
    ).toHaveLength(1);
  });
});
