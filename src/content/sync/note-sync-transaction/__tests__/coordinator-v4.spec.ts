import { describe, expect, it } from 'vite-plus/test';

import { MainCoordinatorV2 } from '../coordinator-v4';
import {
  deriveDurableActive,
  createSealedQuarantineEvidence,
} from '../model-v4';
import { createIdleRecordV4 } from '../model-v4';
import { ownershipFromResource } from '../schema-v4';
import { TRANSITION_REGISTRY, transitionMainV2 } from '../transition-registry';
import type {
  CleanupLedgerEntry,
  MainStateV2,
  NoteSyncRecordV4,
  SourceSnapshotV4,
} from '../types-v4';

import {
  candidateResourceV4,
  candidateV4,
  clockV4,
  manifestDigestV4,
  recordV4,
  sourceVersionV4,
  targetV4,
} from './fixtures-v4';

function source(
  sourceVersion = sourceVersionV4,
  manifestDigest = manifestDigestV4,
): SourceSnapshotV4 {
  return {
    batches: [[{ paragraph: { rich_text: [] }, type: 'paragraph' }]],
    featurePolicy: 'text-only-v1',
    imageAssets: [],
    imageOccurrenceCount: 0,
    manifestDigest,
    sourceVersion,
    title: 'Synthetic note',
  };
}

function identities(start = 0) {
  let next = start;
  return { randomUUID: () => `generated-${++next}` };
}

function coordinator(
  snapshot = source(),
  options: ConstructorParameters<typeof MainCoordinatorV2>[5] = {},
) {
  return new MainCoordinatorV2(
    snapshot,
    targetV4,
    { processSessionID: 'process-v4', startedAt: clockV4.nowISOString() },
    clockV4,
    identities(),
    options,
  );
}

function advance(
  record: NoteSyncRecordV4,
  event: NonNullable<ReturnType<MainCoordinatorV2['select']>>,
) {
  return transitionMainV2(record, event, { clock: clockV4 }).nextState;
}

function pendingCleanup(cleanupID = 'existing-cleanup'): CleanupLedgerEntry {
  const resource = candidateResourceV4(cleanupID);
  return {
    attemptCount: 0,
    cleanupID,
    createdAt: clockV4.nowISOString(),
    deleteIntent: null,
    generation: 0,
    lastObservation: null,
    nextRetryAt: null,
    ownership: ownershipFromResource(resource),
    quarantineEvidenceID: null,
    reason: 'ABORTED_ATTEMPT',
    resource,
    sourceVersion: 'source:cleanup',
    state: 'PENDING',
    transactionID: 'transaction:cleanup',
    updatedAt: clockV4.nowISOString(),
    workerLease: null,
  };
}

describe('production FSM v2 coordinator and transition registry', () => {
  it('contains only the seven main states and production-owned producers', () => {
    const states = new Set<MainStateV2>();
    for (const definition of TRANSITION_REGISTRY) {
      for (const state of definition.from) states.add(state);
      expect(definition.id).toMatch(/^M\d{2}_/);
      expect(definition.producerID).toMatch(
        /^(atomic-commit-coordinator|error-classifier|liveness-coordinator|main-coordinator|remote-operation-observer|source-observer)$/,
      );
      expect(definition.guard).toBeTypeOf('function');
      expect(definition.reducer).toBeTypeOf('function');
    }
    expect(Array.from(states).toSorted()).toStrictEqual([
      'CANDIDATE_CREATING',
      'CANDIDATE_DURABLE',
      'CANDIDATE_VERIFYING',
      'CANDIDATE_WRITING',
      'IDLE',
      'PREPARING',
      'QUARANTINED',
    ]);
    expect(JSON.stringify(TRANSITION_REGISTRY)).not.toContain(
      'ACTIVE_COMMITTED',
    );
    expect(JSON.stringify(TRANSITION_REGISTRY)).not.toContain('CLEANING');
  });

  it('consumes each source observation once before planning further work', () => {
    const planner = coordinator();
    const initial = createIdleRecordV4(targetV4, clockV4);

    const observed = planner.select(initial);
    expect(observed?.type).toBe('SOURCE_OBSERVED');
    if (!observed) throw new Error('Expected source event');
    const afterObservation = advance(initial, observed);
    const next = planner.select(afterObservation);

    expect(next?.type).toBe('START_SYNC');
    expect(next?.type).not.toBe('SOURCE_OBSERVED');
  });

  it('keeps an existing cleanup ledger orthogonal while latest source supersedes main', () => {
    const existing = pendingCleanup();
    const old = {
      ...recordV4('PREPARING'),
      cleanupLedger: [existing],
    };
    const planner = coordinator(source('source:newest', 'manifest:newest'));
    const observation = planner.select(old);
    if (!observation) throw new Error('Expected source observation');
    const afterObservation = advance(old, observation);
    const supersede = planner.select(afterObservation);
    expect(supersede?.type).toBe('SUPERSEDE_TRANSACTION');
    if (!supersede) throw new Error('Expected supersede');
    const next = advance(afterObservation, supersede);

    expect(next.mainState).toBe('PREPARING');
    expect(next.cleanupLedger).toContainEqual(existing);
    expect(next.mainTransaction?.transactionSourceVersion).toBe(
      'source:newest',
    );
  });

  it('commits a first durable candidate before consuming a newer source', () => {
    const old = recordV4('CANDIDATE_DURABLE');
    const planner = coordinator(source('source:newest', 'manifest:newest'));
    const observed = planner.select(old);
    if (!observed) throw new Error('Expected source observation');
    const queued = advance(old, observed);
    const commit = planner.select(queued);

    expect(commit?.type).toBe('COMMIT_DURABLE_CANDIDATE');
    if (!commit) throw new Error('Expected local commit');
    const result = transitionMainV2(queued, commit, { clock: clockV4 });
    expect(result.effectKind).toBe('LOCAL_COMMIT');
    expect(result.nextState.active?.sourceVersion).toBe(sourceVersionV4);
    expect(result.nextState.requestedSource?.sourceVersion).toBe(
      'source:newest',
    );
  });

  it('preserves an existing active and cleans only a superseded durable candidate', () => {
    const oldSource = 'source:old-active';
    const oldManifest = 'manifest:old-active';
    const activeCandidate = candidateV4('DURABLE', 'old-active', {
      generation: 0,
      manifestDigest: oldManifest,
      sourceVersion: oldSource,
      transactionID: 'transaction:old-active',
    });
    const active = deriveDurableActive(
      activeCandidate,
      'text-only-v1',
      clockV4,
    );
    const old = { ...recordV4('CANDIDATE_DURABLE'), active };
    const planner = coordinator(source('source:newest', 'manifest:newest'));
    const observed = planner.select(old);
    if (!observed) throw new Error('Expected source observation');
    const queued = advance(old, observed);
    const supersede = planner.select(queued);

    expect(supersede?.type).toBe('SUPERSEDE_TRANSACTION');
    if (!supersede || supersede.type !== 'SUPERSEDE_TRANSACTION') {
      throw new Error('Expected supersede');
    }
    const next = advance(queued, supersede);
    expect(next.active).toStrictEqual(active);
    expect(next.cleanupLedger).toHaveLength(1);
    expect(next.cleanupLedger[0]?.resource.blockID).toBe('candidate-test');
  });

  it('halts after a permanent rejection and cannot re-plan in the same run', () => {
    const planner = coordinator();
    let current = createIdleRecordV4(targetV4, clockV4);
    for (let step = 0; step < 4; step += 1) {
      const event = planner.select(current);
      if (!event) throw new Error('Expected setup event');
      current = advance(current, event);
    }
    expect(current.mainTransaction?.operationIntent?.kind).toBe(
      'CREATE_CONTAINER',
    );
    const intent = current.mainTransaction?.operationIntent;
    if (!intent) throw new Error('Expected intent');
    current = transitionMainV2(
      current,
      {
        halt: {
          classification: 'PERMISSION_REQUIRED',
          haltedAt: clockV4.nowISOString(),
          operationID: intent.operationID,
          proof: 'NOT_EXECUTED',
          redactedMessage: 'Notion permission required',
        },
        type: 'OPERATION_REJECTED',
      },
      { clock: clockV4 },
    ).nextState;

    expect(planner.select(current)).toBeNull();
    expect(current.mainTransaction?.operationIntent).toBeNull();
    expect(current.mainTransaction?.runHalt?.operationID).toBe(
      intent.operationID,
    );
  });

  it('seals the complete original intent when an outcome is uncertain', () => {
    const planner = coordinator();
    let current = createIdleRecordV4(targetV4, clockV4);
    for (let step = 0; step < 4; step += 1) {
      const event = planner.select(current);
      if (!event) throw new Error('Expected setup event');
      current = advance(current, event);
    }
    const intent = current.mainTransaction?.operationIntent;
    if (!intent) throw new Error('Expected intent');
    const evidence = createSealedQuarantineEvidence({
      clock: clockV4,
      evidenceID: 'evidence:uncertain',
      generation: intent.generation,
      intent,
      noteRevision: current.revision,
      observation: null,
      origin: 'MAIN',
      reasonCode: 'REMOTE_OUTCOME_UNKNOWN',
      requiredRepair: 'VERIFY_REMOTE_RESOURCE',
      resource: null,
      responseClassification: 'network-interruption',
      rootRevision: 0,
      sourceVersion: intent.sourceVersion,
      transactionID: intent.transactionID,
    });
    const quarantined = transitionMainV2(
      current,
      { evidence, type: 'OPERATION_UNCERTAIN' },
      { clock: clockV4 },
    ).nextState;

    expect(quarantined.mainState).toBe('QUARANTINED');
    expect(
      quarantined.quarantineEvidence[0]?.originalOperationIntent?.requestDigest,
    ).toBe(intent.requestDigest);
    expect(
      quarantined.quarantineEvidence[0]?.originalOperationIntent?.status,
    ).toBe('SEALED');
  });
});
