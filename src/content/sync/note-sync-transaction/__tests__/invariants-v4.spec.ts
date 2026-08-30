import { describe, expect, it } from 'vite-plus/test';

import { FakeRuntimeClock } from '../../../../../test/utils';
import { MainCoordinatorV2 } from '../coordinator-v4';
import { deriveTargetIdentityDigest } from '../identity-v4';
import {
  createOperationIntent,
  createSealedQuarantineEvidence,
  deriveDurableActive,
} from '../model-v4';
import {
  ownershipFromResource,
  type TransactionInvariantCode,
  validateTransactionRecord,
} from '../schema-v4';
import { transitionMainV2 } from '../transition-registry';
import type {
  CleanupLedgerEntry,
  NoteSyncRecordV4,
  RemoteObservation,
  SourceSnapshotV4,
  UploadAssetRecordV4,
} from '../types-v4';

import {
  candidateV4,
  clockV4,
  containerV4,
  manifestDigestV4,
  recordV4,
  sourceVersionV4,
  targetV4,
} from './fixtures-v4';

function textSource(): SourceSnapshotV4 {
  return {
    batches: [[{ paragraph: { rich_text: [] }, type: 'paragraph' }]],
    featurePolicy: 'text-only-v1',
    imageAssets: [],
    imageOccurrenceCount: 0,
    manifestDigest: manifestDigestV4,
    sourceVersion: sourceVersionV4,
    title: 'Synthetic note',
  };
}

function recordWithContainerIntent(): NoteSyncRecordV4 {
  let sequence = 0;
  const planner = new MainCoordinatorV2(
    textSource(),
    targetV4,
    { processSessionID: 'process-v4', startedAt: clockV4.nowISOString() },
    clockV4,
    { randomUUID: () => `invariant-${++sequence}` },
  );
  let record: NoteSyncRecordV4 = {
    ...recordV4('IDLE'),
    requestedSource: null,
  };
  for (let step = 0; step < 4; step += 1) {
    const event = planner.select(record);
    if (!event) throw new Error('Expected setup transition');
    record = transitionMainV2(record, event, { clock: clockV4 }).nextState;
  }
  return record;
}

function oldActive() {
  const candidate = candidateV4('DURABLE', 'active-v4', {
    generation: 0,
    manifestDigest: 'manifest:active',
    sourceVersion: 'source:active',
    transactionID: 'transaction:active',
  });
  return deriveDurableActive(candidate, 'text-only-v1', clockV4);
}

function cleanupForActive(): CleanupLedgerEntry {
  const active = oldActive();
  return {
    attemptCount: 0,
    cleanupID: 'cleanup:active',
    createdAt: clockV4.nowISOString(),
    deleteIntent: null,
    generation: active.generation,
    lastObservation: null,
    nextRetryAt: null,
    ownership: ownershipFromResource(active.block),
    quarantineEvidenceID: null,
    reason: 'REPLACED_ACTIVE',
    resource: active.block,
    sourceVersion: active.sourceVersion,
    state: 'PENDING',
    transactionID: active.transactionID,
    updatedAt: clockV4.nowISOString(),
    workerLease: null,
  };
}

function observation(
  operationID: string,
  targetIdentityDigest: string,
): RemoteObservation {
  return {
    attachedUploadIDs: [],
    blockFingerprints: [],
    deletionProof: null,
    generation: 0,
    observedAt: clockV4.nowISOString(),
    operationID,
    outcome: 'EXACT',
    remoteResource: null,
    requestDigest: 'request:liveness',
    responseClassification: 'exact',
    returnedBlockIDs: [],
    sourceVersion: 'source:active',
    targetIdentityDigest,
    transactionID: 'transaction:liveness',
    upload: null,
  };
}

function expectInvariant(
  code: TransactionInvariantCode,
  record: NoteSyncRecordV4,
  context: Parameters<typeof validateTransactionRecord>[1] = {},
): void {
  const validation = validateTransactionRecord(record, context);
  expect(validation.valid).toBe(false);
  if (validation.valid) throw new Error(`Expected ${code}`);
  expect(validation.issues.map((issue) => issue.code)).toContain(code);
}

describe('central schema-v4 invariants V1-V18', () => {
  it('V1 binds every target digest', () => {
    const record = recordV4('PREPARING');
    if (!record.mainTransaction) throw new Error('bad fixture');
    expectInvariant('V1', {
      ...record,
      mainTransaction: {
        ...record.mainTransaction,
        targetIdentityDigest: 'target:foreign',
      },
    });
  });

  it('V2 couples IDLE to the absence of a transaction', () => {
    expectInvariant('V2', { ...recordV4('PREPARING'), mainState: 'IDLE' });
  });

  it('V3 binds candidate transaction identity', () => {
    const record = recordV4('CANDIDATE_WRITING');
    if (!record.mainTransaction?.candidate) throw new Error('bad fixture');
    expectInvariant('V3', {
      ...record,
      mainTransaction: {
        ...record.mainTransaction,
        candidate: {
          ...record.mainTransaction.candidate,
          transactionID: 'transaction:foreign',
        },
      },
    });
  });

  it('V4 recomputes operation request and authorization identity', () => {
    const record = recordWithContainerIntent();
    const transaction = record.mainTransaction;
    if (!transaction?.operationIntent) throw new Error('bad fixture');
    expectInvariant('V4', {
      ...record,
      mainTransaction: {
        ...transaction,
        operationIntent: {
          ...transaction.operationIntent,
          requestDigest: 'request:tampered',
        },
      },
    });
  });

  it('V5 binds operation details to the current resource', () => {
    const record = recordWithContainerIntent();
    const transaction = record.mainTransaction;
    const current = transaction?.operationIntent;
    if (!transaction || current?.kind !== 'CREATE_CONTAINER') {
      throw new Error('bad fixture');
    }
    const { requestDigest: _digest, status: _status, ...request } = current;
    const operationIntent = createOperationIntent({
      ...request,
      details: {
        ...request.details,
        parent: { id: 'page:foreign', type: 'page_id' },
      },
    });
    expectInvariant('V5', {
      ...record,
      mainTransaction: { ...transaction, operationIntent },
    });
  });

  it('V6 binds candidate to the canonical container', () => {
    const record = recordV4('CANDIDATE_WRITING');
    if (!record.mainTransaction?.candidate) throw new Error('bad fixture');
    expectInvariant('V6', {
      ...record,
      mainTransaction: {
        ...record.mainTransaction,
        candidate: {
          ...record.mainTransaction.candidate,
          container: containerV4('container:foreign'),
        },
      },
    });
  });

  it('V7 binds candidate status to the main state', () => {
    const record = recordV4('CANDIDATE_DURABLE');
    if (!record.mainTransaction) throw new Error('bad fixture');
    expectInvariant('V7', {
      ...record,
      mainTransaction: {
        ...record.mainTransaction,
        candidate: candidateV4('WRITING'),
      },
    });
  });

  it('V8 enforces contiguous unique batch evidence', () => {
    const record = recordV4('CANDIDATE_VERIFYING');
    if (!record.mainTransaction?.candidate) throw new Error('bad fixture');
    const first = record.mainTransaction.candidate.batchEvidence[0];
    if (!first) throw new Error('bad fixture');
    expectInvariant('V8', {
      ...record,
      mainTransaction: {
        ...record.mainTransaction,
        candidate: {
          ...record.mainTransaction.candidate,
          batchEvidence: [first, { ...first, index: 1 }],
          expectedBatchCount: 2,
          expectedBlockCount: 2,
        },
      },
    });
  });

  it('V9 binds completion evidence to exact returned blocks', () => {
    const record = recordV4('CANDIDATE_DURABLE');
    const candidate = record.mainTransaction?.candidate;
    if (!candidate?.completionEvidence || !record.mainTransaction) {
      throw new Error('bad fixture');
    }
    expectInvariant('V9', {
      ...record,
      mainTransaction: {
        ...record.mainTransaction,
        candidate: {
          ...candidate,
          completionEvidence: {
            ...candidate.completionEvidence,
            returnedBlockIDs: ['child:foreign'],
          },
        },
      },
    });
  });

  it('V10 permits active only from coherent durability evidence', () => {
    const active = oldActive();
    expectInvariant('V10', {
      ...recordV4('IDLE'),
      active: { ...active, manifestDigest: 'manifest:foreign' },
      container: active.container,
    });
  });

  it('V11 forbids cleanup ownership of current active', () => {
    const active = oldActive();
    expectInvariant('V11', {
      ...recordV4('IDLE'),
      active,
      cleanupLedger: [cleanupForActive()],
      container: active.container,
    });
  });

  it('V12 binds cleanup ownership evidence to its exact resource', () => {
    const cleanup = cleanupForActive();
    expectInvariant('V12', {
      ...recordV4('IDLE'),
      cleanupLedger: [
        {
          ...cleanup,
          ownership: { ...cleanup.ownership, blockID: 'block:foreign' },
        },
      ],
    });
  });

  it('V13 recomputes upload asset content identity', () => {
    const asset: UploadAssetRecordV4 = {
      assetID: 'asset:tampered',
      attachedAt: null,
      attachmentIdentity: 'attachment:synthetic',
      attachmentKey: 'IMAGE_TEST',
      contentHash: 'content:synthetic',
      contentLength: 3,
      contentType: 'image/png',
      createOperationID: 'operation:create-upload',
      expiryTime: null,
      fileUploadID: null,
      filename: 'synthetic.png',
      generation: 1,
      sendOperationID: null,
      sourceIdentity: 'source-image:synthetic',
      sourceVersion: sourceVersionV4,
      status: 'FAILED',
      targetIdentityDigest: deriveTargetIdentityDigest(targetV4),
      transactionID: 'transaction:upload',
    };
    expectInvariant('V13', {
      ...recordV4('IDLE'),
      uploadAssets: [asset],
    });
  });

  it('V14 rejects conflicting immutable data for the same source version', () => {
    const record = recordV4('PREPARING');
    if (!record.requestedSource) throw new Error('bad fixture');
    expectInvariant('V14', {
      ...record,
      requestedSource: {
        ...record.requestedSource,
        manifestDigest: 'manifest:foreign',
      },
    });
  });

  it('V15 makes quarantine evidence one-way and sealed', () => {
    const record = recordWithContainerIntent();
    const intent = record.mainTransaction?.operationIntent;
    if (!intent || !record.mainTransaction) throw new Error('bad fixture');
    const sealed = createSealedQuarantineEvidence({
      clock: clockV4,
      evidenceID: 'evidence:v15',
      generation: intent.generation,
      intent,
      noteRevision: record.revision,
      observation: null,
      origin: 'MAIN',
      reasonCode: 'UNKNOWN',
      requiredRepair: 'VERIFY_REMOTE_RESOURCE',
      resource: null,
      responseClassification: 'unknown',
      rootRevision: 0,
      sourceVersion: intent.sourceVersion,
      transactionID: intent.transactionID,
    });
    expectInvariant('V15', {
      ...record,
      mainState: 'QUARANTINED',
      mainTransaction: { ...record.mainTransaction, operationIntent: null },
      quarantineEvidence: [
        {
          ...sealed,
          originalOperationIntent: intent,
        },
      ],
    });
  });

  it('V16 requires a currently valid lease for executable authorization', () => {
    const record = recordWithContainerIntent();
    const future = new FakeRuntimeClock('2026-08-30T01:00:00.000Z');
    expectInvariant('V16', record, {
      clock: future,
      requireCurrentAuthorization: true,
    });
  });

  it('V17 binds liveness evidence to current mappings and target', () => {
    const active = oldActive();
    const targetDigest = active.targetIdentityDigest;
    const operationID = 'operation:liveness';
    expectInvariant('V17', {
      ...recordV4('IDLE'),
      active,
      container: active.container,
      remoteVerification: {
        activeObservation: observation(operationID, targetDigest),
        checkedAt: clockV4.nowISOString(),
        containerObservation: observation(operationID, targetDigest),
        expectedActive: null,
        expectedContainer: active.container,
        outcome: 'EXACT',
        targetIdentityDigest: targetDigest,
        verificationID: operationID,
      },
    });
  });

  it('V18 permits exactly one root and note revision increment', () => {
    expectInvariant(
      'V18',
      { ...recordV4('IDLE'), revision: 3 },
      {
        previousRevision: { noteRevision: 1, rootRevision: 4 },
        rootRevision: 6,
      },
    );
  });
});
