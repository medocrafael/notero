import { describe, expect, it } from 'vite-plus/test';

import { authorizeMainMutation } from '../authorization-v4';
import { transitionCleanupV4 } from '../cleanup-ledger-v4';
import { selectCleanupWorkV4 } from '../cleanup-worker-v4';
import { MainCoordinatorV2 } from '../coordinator-v4';
import { deriveAssetID, deriveTargetIdentityDigest } from '../identity-v4';
import {
  createOperationIntent,
  createSealedQuarantineEvidence,
  deriveDurableActive,
} from '../model-v4';
import { ownershipFromResource, validateTransactionRecord } from '../schema-v4';
import { transitionMainV2 } from '../transition-registry';
import type {
  CleanupLedgerEntry,
  CleanupWorkerLease,
  NoteSyncRecordV4,
  RemoteObservation,
  RemoteVerificationState,
  SealedOperationIntent,
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
import {
  applyModelActionV4,
  ModelHarnessV4,
  PROPERTY_IDS_V4,
  type PropertyIDV4,
} from './model-harness-v4';

type PropertyCase = {
  property: PropertyIDV4;
  title: string;
  verify: () => Promise<void> | void;
};

function source(
  version = sourceVersionV4,
  manifest = manifestDigestV4,
): SourceSnapshotV4 {
  return textSourceSnapshotV4(version, manifest);
}

function eventTiming() {
  const timestamp = clockV4.nowISOString();
  return { occurredAt: timestamp, updatedAt: timestamp };
}

function identities(prefix = 'property') {
  let sequence = 0;
  return { randomUUID: () => `${prefix}-${++sequence}` };
}

function coordinator(snapshot = source(), forceLiveness = false) {
  return new MainCoordinatorV2(
    snapshot,
    targetV4,
    { processSessionID: 'process-test', startedAt: clockV4.nowISOString() },
    clockV4,
    identities(),
    { forceLiveness },
  );
}

function advance(
  record: NoteSyncRecordV4,
  event: NonNullable<ReturnType<MainCoordinatorV2['select']>>,
) {
  return transitionMainV2(record, event).nextState;
}

function recordWithIntent(): NoteSyncRecordV4 {
  const planner = coordinator();
  let record = recordV4('IDLE');
  for (let step = 0; step < 4; step += 1) {
    const event = planner.select(record);
    if (!event) throw new Error('Expected durable intent setup event');
    record = advance(record, event);
  }
  if (!record.mainTransaction?.operationIntent) {
    throw new Error('Expected durable main intent');
  }
  return record;
}

function cleanupEntry(cleanupID: string, blockID: string): CleanupLedgerEntry {
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

function cleanupLease(entry: CleanupLedgerEntry): CleanupWorkerLease {
  return {
    acquiredAt: clockV4.nowISOString(),
    cleanupID: entry.cleanupID,
    expiresAt: clockV4.addMs(clockV4.nowISOString(), 60_000),
    leaseEpoch: 1,
    leaseID: `lease:${entry.cleanupID}`,
    processSessionID: 'cleanup-process',
  };
}

function withDeleteIntent(entry: CleanupLedgerEntry): CleanupLedgerEntry {
  const lease = cleanupLease(entry);
  return {
    ...entry,
    attemptCount: 1,
    deleteIntent: createOperationIntent({
      createdAt: clockV4.nowISOString(),
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
      operationID: `operation:${entry.cleanupID}`,
      operationSequence: 1,
      owner: 'CLEANUP',
      processSessionID: lease.processSessionID,
      sourceVersion: entry.sourceVersion,
      targetIdentityDigest: entry.resource.targetIdentityDigest,
      transactionID: entry.transactionID,
    }),
    state: 'DELETE_INTENDED',
    workerLease: lease,
  };
}

function observation(
  intent: SealedOperationIntent,
  values: Partial<RemoteObservation> = {},
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
    responseClassification: 'property-table',
    returnedBlockIDs: [],
    sourceVersion: intent.sourceVersion,
    targetIdentityDigest: intent.targetIdentityDigest,
    transactionID: intent.transactionID,
    upload: null,
    ...values,
  };
}

function evidence(record: NoteSyncRecordV4, reasonCode: string) {
  const intent = record.mainTransaction?.operationIntent;
  if (!intent) throw new Error('Evidence setup requires an intent');
  return createSealedQuarantineEvidence({
    clock: clockV4,
    evidenceID: `evidence:${reasonCode}`,
    generation: intent.generation,
    intent,
    noteRevision: record.revision,
    observation: null,
    origin: 'MAIN',
    reasonCode,
    requiredRepair: 'VERIFY_REMOTE_RESOURCE',
    resource: null,
    responseClassification: 'property-table',
    rootRevision: 0,
    sourceVersion: intent.sourceVersion,
    transactionID: intent.transactionID,
  });
}

function idleWithActive(): NoteSyncRecordV4 {
  const candidate = candidateV4('DURABLE');
  const active = deriveDurableActive(
    candidate,
    'text-only-v1',
    clockV4.nowISOString(),
  );
  return {
    ...recordV4('IDLE'),
    active,
    container: active.container,
    requestedSource: {
      featurePolicy: active.featurePolicy,
      manifestDigest: active.manifestDigest,
      observedAt: clockV4.nowISOString(),
      sourceDescriptor: active.sourceDescriptor,
      sourceVersion: active.sourceVersion,
    },
  };
}

const reducerCases: PropertyCase[] = [
  {
    property: 'P1',
    title: 'keeps the old active until a durable candidate commits locally',
    verify: () => {
      const oldCandidate = candidateV4('DURABLE', 'old-active', {
        generation: 0,
        manifestDigest: 'manifest:old',
        sourceVersion: 'source:old',
        transactionID: 'transaction:old',
      });
      const record = {
        ...recordV4('CANDIDATE_DURABLE'),
        active: deriveDurableActive(
          oldCandidate,
          'text-only-v1',
          clockV4.nowISOString(),
        ),
      };
      const next = transitionMainV2(record, {
        committedAt: clockV4.nowISOString(),
        retiredActiveCleanup: null,
        ...eventTiming(),
        type: 'COMMIT_DURABLE_CANDIDATE',
      }).nextState;
      expect(record.active?.block.blockID).toBe('old-active');
      expect(next.active?.block.blockID).toBe('candidate-test');
      expect(next.mainState).toBe('IDLE');
    },
  },
  {
    property: 'P2',
    title: 'rejects cleanup whose ownership proof differs from its resource',
    verify: () => {
      const entry = cleanupEntry('cleanup:p2', 'block:p2');
      const invalid = {
        ...recordV4('IDLE'),
        cleanupLedger: [
          {
            ...entry,
            ownership: { ...entry.ownership, createdByID: 'foreign-user' },
          },
        ],
      };
      const validation = validateTransactionRecord(invalid);
      expect(validation.valid).toBe(false);
      if (!validation.valid) {
        expect(validation.issues.map(({ code }) => code)).toContain('V12');
      }
    },
  },
  {
    property: 'P3',
    title: 'cannot reduce missing deletion proof to CONFIRMED',
    verify: () => {
      const entry = withDeleteIntent(cleanupEntry('cleanup:p3', 'block:p3'));
      const record = { ...recordV4('IDLE'), cleanupLedger: [entry] };
      const intent = entry.deleteIntent;
      if (!intent) throw new Error('Expected delete intent');
      expect(() =>
        transitionCleanupV4(record, entry.cleanupID, {
          observation: observation(intent, { outcome: 'DELETED' }),
          occurredAt: clockV4.nowISOString(),
          type: 'DELETE_CONFIRMED',
        }),
      ).toThrow('delete observation lacks exact in_trash proof');
    },
  },
  {
    property: 'P4',
    title: 'rejects mutation authorization without a durable exact intent',
    verify: () => {
      expect(() =>
        authorizeMainMutation(
          {
            containerGeneration: 0,
            legacyMigrationRequired: false,
            record: recordV4(),
            rootRevision: 0,
          },
          {
            processSessionID: 'process-test',
            startedAt: clockV4.nowISOString(),
          },
          clockV4,
          identities('authorization'),
        ),
      ).toThrow(/exact durable main operation authorization/i);
    },
  },
  {
    property: 'P5',
    title: 'seals an uncertain intent and enters quarantine',
    verify: () => {
      const record = recordWithIntent();
      const next = transitionMainV2(record, {
        evidence: evidence(record, 'P5_UNCERTAIN'),
        ...eventTiming(),
        type: 'OPERATION_UNCERTAIN',
      }).nextState;
      expect(next.mainState).toBe('QUARANTINED');
      expect(
        next.quarantineEvidence.at(-1)?.originalOperationIntent?.status,
      ).toBe('SEALED');
    },
  },
  {
    property: 'P6',
    title: 'coalesces to the latest requested source without replaying it',
    verify: () => {
      const planner = coordinator(source('source:new', 'manifest:new'));
      let record = recordV4('PREPARING');
      const observed = planner.select(record);
      if (!observed) throw new Error('Expected source observation');
      record = advance(record, observed);
      const supersede = planner.select(record);
      if (!supersede) throw new Error('Expected supersession');
      record = advance(record, supersede);
      expect(record.requestedSource?.sourceVersion).toBe('source:new');
      expect(record.mainTransaction?.transactionSourceVersion).toBe(
        'source:new',
      );
      expect(planner.select(record)?.type).not.toBe('SOURCE_OBSERVED');
    },
  },
  {
    property: 'P7',
    title: 'rejects upload metadata in a Feature OFF transaction',
    verify: () => {
      const record = recordV4('PREPARING');
      const base = {
        attachmentIdentity: 'attachment:p7',
        contentHash: 'hash:p7',
        contentLength: 7,
        contentType: 'image/png',
        filename: 'p7.png',
        sourceIdentity: 'source-image:p7',
        targetIdentityDigest: deriveTargetIdentityDigest(targetV4),
      };
      const assetIdentityDigest = deriveAssetID(base);
      const invalid = {
        ...record,
        uploadAssets: [
          {
            assetID: assetIdentityDigest,
            assetIdentityDigest,
            ...base,
            attachedAt: null,
            attachmentKey: 'IMAGE-P7',
            createOperationID: 'operation:p7',
            expiryTime: null,
            fileUploadBindingDigest: null,
            fileUploadID: null,
            generation: 1,
            sendOperationID: null,
            sourceVersion: sourceVersionV4,
            status: 'CREATE_INTENDED' as const,
            transactionID: 'transaction-test',
          },
        ],
      };
      const validation = validateTransactionRecord(invalid);
      expect(validation.valid).toBe(false);
      if (!validation.valid) {
        expect(validation.issues.map(({ code }) => code)).toContain('V13');
      }
    },
  },
  {
    property: 'P8',
    title: 'selects no transition for unchanged active with fresh liveness',
    verify: () => {
      const record = idleWithActive();
      const verification: RemoteVerificationState = {
        activeObservation: null,
        checkedAt: clockV4.nowISOString(),
        containerObservation: null,
        expectedActive: record.active?.block ?? null,
        expectedContainer: record.container,
        outcome: 'EXACT',
        targetIdentityDigest: deriveTargetIdentityDigest(targetV4),
        verificationID: 'verification:p8',
      };
      expect(
        coordinator().select({ ...record, remoteVerification: verification }),
      ).toBeNull();
    },
  },
  {
    property: 'P9',
    title: 'cannot commit a candidate without durable completion proof',
    verify: () => {
      expect(() =>
        transitionMainV2(recordV4('CANDIDATE_WRITING'), {
          committedAt: clockV4.nowISOString(),
          retiredActiveCleanup: null,
          ...eventTiming(),
          type: 'COMMIT_DURABLE_CANDIDATE',
        }),
      ).toThrow(/exactly one transition/i);
    },
  },
  {
    property: 'P10',
    title: 'selects only the configured bounded cleanup batch',
    verify: () => {
      const record = {
        ...recordV4('IDLE'),
        cleanupLedger: [
          cleanupEntry('cleanup:p10:1', 'block:p10:1'),
          cleanupEntry('cleanup:p10:2', 'block:p10:2'),
          cleanupEntry('cleanup:p10:3', 'block:p10:3'),
        ],
      };
      expect(
        selectCleanupWorkV4(record, clockV4, 'cleanup-process', 2),
      ).toHaveLength(2);
    },
  },
  {
    property: 'P11',
    title: 'keeps cleanup transitions orthogonal to all main fields',
    verify: () => {
      const entry = withDeleteIntent(cleanupEntry('cleanup:p11', 'block:p11'));
      const record = { ...idleWithActive(), cleanupLedger: [entry] };
      const next = transitionCleanupV4(record, entry.cleanupID, {
        nextRetryAt: clockV4.addMs(clockV4.nowISOString(), 1_000),
        observation: null,
        occurredAt: clockV4.nowISOString(),
        type: 'DELETE_BECAME_UNCERTAIN',
      });
      expect(next.mainState).toBe(record.mainState);
      expect(next.mainTransaction).toBe(record.mainTransaction);
      expect(next.active).toStrictEqual(record.active);
      expect(next.requestedSource).toStrictEqual(record.requestedSource);
    },
  },
  {
    property: 'P12',
    title: 'authorizes exactly the persisted intent and current lease',
    verify: () => {
      const record = recordWithIntent();
      const authorization = authorizeMainMutation(
        {
          containerGeneration: 0,
          legacyMigrationRequired: false,
          record,
          rootRevision: 0,
        },
        {
          processSessionID: 'process-test',
          startedAt: clockV4.nowISOString(),
        },
        clockV4,
        identities('authorization'),
      );
      expect(authorization.intent).toStrictEqual(
        record.mainTransaction?.operationIntent,
      );
      expect(authorization.lease).toStrictEqual(
        record.writerCoordination.mainLease,
      );
    },
  },
  {
    property: 'P13',
    title: 'rejects cleanup ownership of the current active resource',
    verify: () => {
      const record = idleWithActive();
      const active = record.active?.block;
      if (!active) throw new Error('Expected active resource');
      const entry = {
        ...cleanupEntry('cleanup:p13', active.blockID),
        ownership: ownershipFromResource(active),
        resource: active,
      };
      const validation = validateTransactionRecord({
        ...record,
        cleanupLedger: [entry],
      });
      expect(validation.valid).toBe(false);
      if (!validation.valid) {
        expect(validation.issues.map(({ code }) => code)).toContain('V11');
      }
    },
  },
  {
    property: 'P14',
    title: 'persists a permanent run halt and stops same-run selection',
    verify: () => {
      const record = recordWithIntent();
      const intent = record.mainTransaction?.operationIntent;
      if (!intent) throw new Error('Expected intent');
      const next = transitionMainV2(record, {
        evidence: evidence(record, 'P14_PERMISSION'),
        halt: {
          classification: 'PERMISSION_REQUIRED',
          haltedAt: clockV4.nowISOString(),
          nextRetryAt: null,
          operationID: intent.operationID,
          proof: 'NOT_EXECUTED',
          redactedMessage: 'Permission required',
        },
        ...eventTiming(),
        type: 'OPERATION_REJECTED',
      }).nextState;
      expect(next.mainTransaction?.runHalt?.classification).toBe(
        'PERMISSION_REQUIRED',
      );
      expect(coordinator().select(next)).toBeNull();
    },
  },
  {
    property: 'P15',
    title: 'schedules IDLE liveness when evidence is stale or absent',
    verify: () => {
      expect(coordinator().select(idleWithActive())?.type).toBe(
        'START_LIVENESS',
      );
    },
  },
];

async function runActions(actions: Parameters<typeof applyModelActionV4>[1][]) {
  const harness = new ModelHarnessV4();
  for (const action of actions) await applyModelActionV4(harness, action);
  return harness;
}

const integrationCases: PropertyCase[] = [
  {
    property: 'P1',
    title: 'preserves LKG through a remote-commit/local-persist crash',
    verify: async () => {
      await assertStatefulWitness('P1', ['SYNC_TEXT', 'CRASH_AFTER_REMOTE']);
    },
  },
  {
    property: 'P2',
    title: 'does not mutate a moved active block',
    verify: async () => {
      await assertStatefulWitness('P2', ['SYNC_TEXT', 'MOVE_ACTIVE']);
    },
  },
  {
    property: 'P3',
    title: 'distinguishes archived-only from exact in_trash cleanup proof',
    verify: async () => {
      await assertStatefulWitness('P3', [
        'SYNC_TEXT',
        'SOURCE_B',
        'CLEANUP_ARCHIVED_ONLY',
      ]);
      await assertStatefulWitness('P3', [
        'SYNC_TEXT',
        'SOURCE_B',
        'CLEANUP_CONFIRMED',
      ]);
    },
  },
  {
    property: 'P4',
    title: 'audits a durable exact intent before every stateful mutation',
    verify: async () => {
      await assertStatefulWitness('P4', ['SYNC_IMAGE']);
    },
  },
  {
    property: 'P5',
    title: 'recovers a persisted ambiguous intent without blind replay',
    verify: async () => {
      await assertStatefulWitness('P5', [
        'SYNC_TEXT',
        'CRASH_AFTER_REMOTE',
        'RESTART',
      ]);
    },
  },
  {
    property: 'P6',
    title: 'commits the latest requested source after coalescing',
    verify: async () => {
      await assertStatefulWitness('P6', ['SYNC_TEXT', 'SOURCE_B', 'SOURCE_C']);
    },
  },
  {
    property: 'P7',
    title: 'performs zero image work when Feature OFF',
    verify: async () => {
      await assertStatefulWitness('P7', ['SYNC_FEATURE_OFF']);
    },
  },
  {
    property: 'P8',
    title: 'makes an unchanged resync a no-op',
    verify: async () => {
      await assertStatefulWitness('P8', ['SYNC_TEXT', 'UNCHANGED']);
    },
  },
  {
    property: 'P9',
    title: 'exposes only an active backed by complete verification',
    verify: async () => {
      await assertStatefulWitness('P9', ['SYNC_IMAGE']);
    },
  },
  {
    property: 'P10',
    title: 'keeps main, mutation, and cleanup execution bounded',
    verify: async () => {
      await assertStatefulWitness('P10', [
        'SYNC_TEXT',
        'SOURCE_B',
        'CLEANUP_CONFIRMED',
      ]);
    },
  },
  {
    property: 'P11',
    title: 'advances source C while cleanup remains uncertain',
    verify: async () => {
      await assertStatefulWitness('P11', [
        'SYNC_TEXT',
        'SOURCE_B',
        'CLEANUP_404',
        'SOURCE_C',
      ]);
    },
  },
  {
    property: 'P12',
    title: 'binds every stateful mutation to one exact lease',
    verify: async () => {
      await assertStatefulWitness('P12', ['SYNC_IMAGE']);
    },
  },
  {
    property: 'P13',
    title: 'does not modify an ownership-marker-edited block',
    verify: async () => {
      await assertStatefulWitness('P13', ['SYNC_TEXT', 'EDIT_ACTIVE']);
    },
  },
  {
    property: 'P14',
    title: 'attempts a permanent permission failure only once in a run',
    verify: async () => {
      await assertStatefulWitness('P14', ['SYNC_TEXT', 'PERMISSION_LOST']);
    },
  },
  {
    property: 'P15',
    title: 'detects IDLE stale mapping after TTL',
    verify: async () => {
      await assertStatefulWitness('P15', ['SYNC_TEXT', 'ADVANCE_TTL']);
    },
  },
];

async function assertStatefulWitness(
  property: PropertyIDV4,
  actions: Parameters<typeof applyModelActionV4>[1][],
) {
  const harness = await runActions(actions);
  const failures = harness.propertyFailures.filter((failure) =>
    failure.startsWith(`${property}:`),
  );
  expect(failures).toStrictEqual([]);
  expect(harness.propertyWitnesses.get(property) ?? 0).toBeGreaterThan(0);
}

describe('P1-P15 production reducer/table properties', () => {
  it('defines exactly one reducer/table case for every required property', () => {
    expect(reducerCases.map(({ property }) => property)).toStrictEqual(
      PROPERTY_IDS_V4,
    );
  });

  it.each(reducerCases)('$property $title', async ({ verify }) => {
    expect.hasAssertions();
    await verify();
  });
});

describe('P1-P15 stateful Notion integration properties', () => {
  it('defines exactly one stateful case for every required property', () => {
    expect(integrationCases.map(({ property }) => property)).toStrictEqual(
      PROPERTY_IDS_V4,
    );
  });

  it.each(integrationCases)('$property $title', async ({ verify }) => {
    expect.hasAssertions();
    await verify();
  });
});
