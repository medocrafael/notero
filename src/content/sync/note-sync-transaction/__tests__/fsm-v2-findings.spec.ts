import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { MainCoordinatorV2 } from '../coordinator-v4';
import {
  createIdleRecordV4,
  createSealedQuarantineEvidence,
  deriveDurableActive,
} from '../model-v4';
import { ownershipFromResource, validateTransactionRecord } from '../schema-v4';
import { TRANSITION_REGISTRY, transitionMainV2 } from '../transition-registry';
import type {
  CleanupLedgerEntry,
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
  textSourceSnapshotV4,
} from './fixtures-v4';

function source(
  sourceVersion = sourceVersionV4,
  manifestDigest = manifestDigestV4,
): SourceSnapshotV4 {
  return textSourceSnapshotV4(sourceVersion, manifestDigest);
}

function planner(snapshot = source(), resumeHalted = false) {
  let sequence = 0;
  return new MainCoordinatorV2(
    snapshot,
    targetV4,
    { processSessionID: 'findings-process', startedAt: clockV4.nowISOString() },
    clockV4,
    { randomUUID: () => `finding-${++sequence}` },
    { resumeHalted },
  );
}

function advance(
  record: NoteSyncRecordV4,
  event: NonNullable<ReturnType<MainCoordinatorV2['select']>>,
): NoteSyncRecordV4 {
  return transitionMainV2(record, event).nextState;
}

function pendingCleanup(): CleanupLedgerEntry {
  const resource = candidateResourceV4('review-cleanup');
  return {
    attemptCount: 0,
    cleanupID: 'review-cleanup',
    createdAt: clockV4.nowISOString(),
    deleteIntent: null,
    generation: 0,
    lastAttemptAt: null,
    lastObservation: null,
    nextRetryAt: null,
    ownership: ownershipFromResource(resource),
    quarantineEvidenceID: null,
    reason: 'ABORTED_ATTEMPT',
    resource,
    sourceVersion: 'source:retired',
    state: 'PENDING',
    transactionID: 'transaction:retired',
    updatedAt: clockV4.nowISOString(),
    workerLease: null,
  };
}

function transactionSource(relativePath: string): string {
  return readFileSync(
    resolve(
      process.cwd(),
      'src/content/sync/note-sync-transaction',
      relativePath,
    ),
    'utf8',
  );
}

describe('FSM v2 independent-review finding regressions', () => {
  it('H-01 consumes one source observation and cannot livelock on it', () => {
    const coordinator = planner(source('source:new', 'manifest:new'));
    const initial = recordV4('IDLE');
    const first = coordinator.select(initial);
    if (!first) throw new Error('Expected source observation');
    const observed = advance(initial, first);

    expect(first.type).toBe('SOURCE_OBSERVED');
    expect(coordinator.select(observed)?.type).not.toBe('SOURCE_OBSERVED');
  });

  it('H-02 advances the latest source while cleanup remains unresolved', () => {
    const coordinator = planner(source('source:new', 'manifest:new'));
    const initial = {
      ...recordV4('PREPARING'),
      cleanupLedger: [pendingCleanup()],
    };
    const observedEvent = coordinator.select(initial);
    if (!observedEvent) throw new Error('Expected source observation');
    const observed = advance(initial, observedEvent);
    const supersede = coordinator.select(observed);
    if (!supersede) throw new Error('Expected transaction supersession');
    const next = advance(observed, supersede);

    expect(next.mainState).toBe('PREPARING');
    expect(next.cleanupLedger[0]?.state).toBe('PENDING');
    expect(next.mainTransaction?.transactionSourceVersion).toBe('source:new');
  });

  it('H-03 performs one explicit finalization update and then observes it', () => {
    const adapter = transactionSource('notion-operation-adapter-v4.ts');

    expect(adapter.match(/this\.notion\.blocks\.update/g)).toHaveLength(1);
    expect(adapter).toMatch(
      /executeFinalize[\s\S]*expectedTitle: intent\.details\.stagingTitle[\s\S]*blocks\.update[\s\S]*observeFinalize/,
    );
    expect(adapter).toMatch(
      /observeFinalize[\s\S]*expectedTitle: intent\.details\.finalTitle/,
    );
  });

  it('H-04 rejects metadata whose durable candidate crosses transactions', () => {
    const corrupted = structuredClone(recordV4('CANDIDATE_DURABLE'));
    if (!corrupted.mainTransaction?.candidate) throw new Error('bad fixture');
    corrupted.mainTransaction.candidate.transactionID = 'foreign-transaction';

    const validation = validateTransactionRecord(corrupted, {
      rootRevision: 0,
    });

    expect(validation.valid).toBe(false);
    if (validation.valid) throw new Error('Expected invalid metadata');
    expect(validation.issues.map(({ code }) => code)).toContain('V6');
  });

  it('H-05 uses the Zotero transaction runtime for atomic merge and save', () => {
    const store = transactionSource('metadata-store-adapter.ts');

    expect(store).toContain('this.runtime.executeTransaction');
    expect(store).toContain('this.runtime.reloadItems');
    expect(store).toContain('this.runtime.saveItem');
    expect(store).not.toContain('saveTx(');
    expect(store).not.toContain('Optimistic compare-and-swap');
  });

  it('M-01 exposes one unique production registry with real producers', () => {
    const ids = TRANSITION_REGISTRY.map(({ id }) => id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const transition of TRANSITION_REGISTRY) {
      expect(transition.producerID).not.toBe('test');
      expect(transition.guard).toBeTypeOf('function');
      expect(transition.reducer).toBeTypeOf('function');
    }
  });

  it('M-02 preserves a permanent run halt until a new invocation resumes it', () => {
    const coordinator = planner();
    let record = createIdleRecordV4(targetV4, clockV4);
    for (let step = 0; step < 4; step += 1) {
      const event = coordinator.select(record);
      if (!event) throw new Error('Expected setup transition');
      record = advance(record, event);
    }
    const intent = record.mainTransaction?.operationIntent;
    if (!intent) throw new Error('Expected a durable intent');
    const evidence = createSealedQuarantineEvidence({
      clock: clockV4,
      evidenceID: 'finding-permanent-error',
      generation: intent.generation,
      intent,
      noteRevision: record.revision,
      observation: null,
      origin: 'MAIN',
      reasonCode: 'PERMISSION_REQUIRED',
      requiredRepair: 'RESTORE_CAPABILITY',
      resource: null,
      responseClassification: 'http-403',
      rootRevision: 0,
      sourceVersion: intent.sourceVersion,
      transactionID: intent.transactionID,
    });
    record = transitionMainV2(record, {
      evidence,
      halt: {
        classification: 'PERMISSION_REQUIRED',
        haltedAt: clockV4.nowISOString(),
        nextRetryAt: null,
        operationID: intent.operationID,
        proof: 'NOT_EXECUTED',
        redactedMessage: 'Permission required',
      },
      occurredAt: clockV4.nowISOString(),
      type: 'OPERATION_REJECTED',
      updatedAt: clockV4.nowISOString(),
    }).nextState;

    expect(coordinator.select(record)).toBeNull();
    expect(planner(source(), true).select(record)?.type).toBe(
      'RESUME_AFTER_HALT',
    );
  });

  it('M-03 accepts deletion only with exact in_trash and archived proof', () => {
    const adapter = transactionSource('notion-operation-adapter-v4.ts');

    expect(adapter).toMatch(/\.block\.in_trash && .*\.block\.archived/s);
    expect(adapter).toContain("'delete-observation-404'");
  });

  it('M-04 schedules liveness for an IDLE active without fresh evidence', () => {
    const candidate = candidateV4('DURABLE');
    const active = deriveDurableActive(
      candidate,
      'text-only-v1',
      clockV4.nowISOString(),
    );
    const record = {
      ...createIdleRecordV4(targetV4, clockV4),
      active,
      container: active.container,
      requestedSource: {
        featurePolicy: 'text-only-v1' as const,
        manifestDigest: active.manifestDigest,
        observedAt: clockV4.nowISOString(),
        sourceDescriptor: active.sourceDescriptor,
        sourceVersion: active.sourceVersion,
      },
    };

    expect(planner().select(record)?.type).toBe('START_LIVENESS');
  });

  it('M-05 seals the complete original intent on uncertainty', () => {
    const coordinator = planner();
    let record = createIdleRecordV4(targetV4, clockV4);
    for (let step = 0; step < 4; step += 1) {
      const event = coordinator.select(record);
      if (!event) throw new Error('Expected setup transition');
      record = advance(record, event);
    }
    const intent = record.mainTransaction?.operationIntent;
    if (!intent) throw new Error('Expected a durable intent');
    const evidence = createSealedQuarantineEvidence({
      clock: clockV4,
      evidenceID: 'finding-uncertain',
      generation: intent.generation,
      intent,
      noteRevision: record.revision,
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
    const quarantined = transitionMainV2(record, {
      evidence,
      occurredAt: clockV4.nowISOString(),
      type: 'OPERATION_UNCERTAIN',
      updatedAt: clockV4.nowISOString(),
    }).nextState;

    expect(
      quarantined.quarantineEvidence[0]?.originalOperationIntent,
    ).toMatchObject({ requestDigest: intent.requestDigest, status: 'SEALED' });
  });

  it('L-01 routes production transaction time through RuntimeClock', () => {
    const directory = resolve(
      process.cwd(),
      'src/content/sync/note-sync-transaction',
    );
    const files = readdirSync(directory)
      .filter((name) => name.endsWith('.ts') && name !== 'runtime-clock.ts')
      .map((name) => ({ name, source: transactionSource(name) }));
    files.push({
      name: '../notion-image-upload-service.ts',
      source: readFileSync(
        resolve(directory, '../notion-image-upload-service.ts'),
        'utf8',
      ),
    });
    files.push({
      name: '../sync-note-item.ts',
      source: readFileSync(resolve(directory, '../sync-note-item.ts'), 'utf8'),
    });
    const directCalls = files.flatMap(({ name, source: text }) =>
      Array.from(
        text.matchAll(/\b(?:Date\.now\(\)|new Date\(|performance\.now\()/g),
        (match) => `${name}:${match[0]}`,
      ),
    );

    expect(directCalls).toStrictEqual([]);
  });
});
