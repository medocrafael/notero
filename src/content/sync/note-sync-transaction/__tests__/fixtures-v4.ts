import { FakeRuntimeClock } from '../../../../../test/utils';
import {
  deriveContainerTargetDigest,
  deriveTargetIdentityDigest,
} from '../identity-v4';
import {
  createIdleRecordV4,
  createOperationIntent,
  sealOperationIntent,
} from '../model-v4';
import type {
  CandidateRecordV4,
  MainStateV2,
  MainWriterLease,
  ManagedContainerMapping,
  ManagedResourceIdentity,
  NoteSyncRecordV4,
  SealedOperationIntent,
  TargetIdentity,
} from '../types-v4';

export const clockV4 = new FakeRuntimeClock('2026-08-30T00:00:00.000Z');

export const targetV4: TargetIdentity = {
  connectionID: 'connection-test',
  databaseID: 'database-test',
  libraryID: 7,
  noteItemKey: 'NOTE_TEST',
  pageID: 'page-test',
  parentItemKey: 'PARENT_TEST',
  workspaceID: 'workspace-test',
};

export const sourceVersionV4 =
  'source:0000000000000000000000000000000000000000000000000000000000000001';
export const manifestDigestV4 =
  'manifest:0000000000000000000000000000000000000000000000000000000000000001';

export function containerV4(
  blockID = 'container-test',
): ManagedContainerMapping {
  return {
    blockID,
    createdByID: 'connection-test',
    kind: 'container',
    lastEditedTime: clockV4.nowISOString(),
    operationMarker: 'operation:create-container-test',
    ownershipMarker: 'notero:managed-container-v4',
    parent: { id: targetV4.pageID, type: 'page_id' },
    targetIdentityDigest: deriveContainerTargetDigest(targetV4),
    versionMarker: 'notero:version-v4',
  };
}

export function candidateResourceV4(
  blockID = 'candidate-test',
): ManagedResourceIdentity {
  return {
    blockID,
    createdByID: 'connection-test',
    kind: 'note',
    lastEditedTime: clockV4.nowISOString(),
    operationMarker: 'operation:create-candidate-test',
    ownershipMarker: 'notero:managed-note-v4',
    parent: { id: containerV4().blockID, type: 'block_id' },
    targetIdentityDigest: deriveTargetIdentityDigest(targetV4),
    versionMarker: 'notero:version-v4',
  };
}

export function leaseV4(): MainWriterLease {
  return {
    acquiredAt: clockV4.nowISOString(),
    expiresAt: clockV4.addMs(clockV4.nowISOString(), 60_000),
    generation: 1,
    leaseEpoch: 1,
    leaseID: 'lease-test',
    noteIdentityDigest: deriveTargetIdentityDigest(targetV4),
    processSessionID: 'process-test',
    transactionID: 'transaction-test',
  };
}

function intentBase() {
  return {
    createdAt: clockV4.nowISOString(),
    generation: 1,
    leaseEpoch: 1,
    leaseID: 'lease-test',
    operationSequence: 1,
    owner: 'MAIN' as const,
    processSessionID: 'process-test',
    sourceVersion: sourceVersionV4,
    targetIdentityDigest: deriveTargetIdentityDigest(targetV4),
    transactionID: 'transaction-test',
  };
}

export function verifyIntentV4(): Extract<
  SealedOperationIntent,
  { kind: 'VERIFY_CANDIDATE' }
> {
  const intent = createOperationIntent({
    ...intentBase(),
    details: {
      batchDigests: ['batch:0'],
      blockFingerprints: ['block:0'],
      candidate: candidateResourceV4(),
      expectedBatchCount: 1,
      expectedBlockCount: 1,
      expectedImageUploadIDs: [],
      manifestDigest: manifestDigestV4,
      returnedBlockIDs: ['child:0'],
    },
    kind: 'VERIFY_CANDIDATE',
    operationID: 'operation:verify-candidate-test',
  });
  if (intent.kind !== 'VERIFY_CANDIDATE') throw new Error('bad fixture');
  return intent;
}

export function candidateV4(
  status: CandidateRecordV4['status'] = 'WRITING',
): CandidateRecordV4 {
  const batchEvidence =
    status === 'CREATED'
      ? []
      : [
          {
            batchDigest: 'batch:0',
            blockFingerprints: ['block:0'],
            completedAt: clockV4.nowISOString(),
            imageUploadIDs: [],
            index: 0,
            parentBlockID: candidateResourceV4().blockID,
            returnedBlockIDs: ['child:0'],
          },
        ];
  const completionEvidence =
    status === 'DURABLE'
      ? {
          batchDigests: ['batch:0'],
          blockFingerprints: ['block:0'],
          candidateBlockID: candidateResourceV4().blockID,
          completedBatchCount: 1,
          expectedBatchCount: 1,
          expectedBlockCount: 1,
          expectedImageCount: 0,
          imageAssetIdentities: [],
          imageUploadIDs: [],
          manifestDigest: manifestDigestV4,
          returnedBlockIDs: ['child:0'],
          sourceVersion: sourceVersionV4,
          verificationIntent: sealOperationIntent(verifyIntentV4(), 'SEALED'),
          verifiedAt: clockV4.nowISOString(),
        }
      : null;
  return {
    batchEvidence,
    completionEvidence,
    container: containerV4(),
    expectedBatchCount: 1,
    expectedBlockCount: 1,
    expectedImageCount: 0,
    generation: 1,
    imageAssetIdentities: [],
    manifestDigest: manifestDigestV4,
    previousActiveBlockID: null,
    resource: candidateResourceV4(),
    sourceVersion: sourceVersionV4,
    status,
    targetIdentityDigest: deriveTargetIdentityDigest(targetV4),
    transactionID: 'transaction-test',
  };
}

export function recordV4(
  mainState: MainStateV2 = 'PREPARING',
): NoteSyncRecordV4 {
  const idle = createIdleRecordV4(targetV4, clockV4);
  if (mainState === 'IDLE') return idle;
  const candidate =
    mainState === 'CANDIDATE_WRITING'
      ? candidateV4('CREATED')
      : mainState === 'CANDIDATE_VERIFYING'
        ? candidateV4('WRITING')
        : mainState === 'CANDIDATE_DURABLE'
          ? candidateV4('DURABLE')
          : null;
  return {
    ...idle,
    container: mainState === 'PREPARING' ? null : containerV4(),
    mainState,
    mainTransaction: {
      candidate,
      featurePolicy: 'text-only-v1',
      generation: 1,
      operationIntent: null,
      operationSequence: 0,
      purpose: 'SYNC',
      runHalt: null,
      sourceManifestDigest: manifestDigestV4,
      sourceTitle: 'Synthetic note',
      targetIdentityDigest: deriveTargetIdentityDigest(targetV4),
      transactionID: 'transaction-test',
      transactionSourceVersion: sourceVersionV4,
    },
    requestedSource: {
      featurePolicy: 'text-only-v1',
      manifestDigest: manifestDigestV4,
      observedAt: clockV4.nowISOString(),
      sourceVersion: sourceVersionV4,
    },
    writerCoordination: { mainLease: leaseV4() },
  };
}
