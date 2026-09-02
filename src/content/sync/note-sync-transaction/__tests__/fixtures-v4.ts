import { FakeRuntimeClock } from '../../../../../test/utils';
import { digestCanonical } from '../canonical';
import {
  asLocalConnectionIdentity,
  asRemoteCreatorIdentity,
  deriveContainerTargetDigest,
  deriveManifestDigestV4,
  deriveTargetIdentityDigest,
} from '../identity-v4';
import {
  createIdleRecordV4,
  createOperationIntent,
  sealOperationIntent,
} from '../model-v4';
import type {
  CandidateRecordV4,
  CanonicalSourceDescriptorV4,
  MainStateV2,
  MainWriterLease,
  ManagedContainerMapping,
  ManagedResourceIdentity,
  NoteSyncRecordV4,
  SealedOperationIntent,
  SourceSnapshotV4,
  TargetIdentity,
} from '../types-v4';

export const clockV4 = new FakeRuntimeClock('2026-08-30T00:00:00.000Z');

export const targetV4: TargetIdentity = {
  connectionID: asLocalConnectionIdentity('connection-test'),
  databaseID: 'database-test',
  libraryID: 7,
  noteItemKey: 'NOTE_TEST',
  pageID: 'page-test',
  parentItemKey: 'PARENT_TEST',
  workspaceID: 'workspace-test',
};

export function syntheticSourceDescriptorV4(input: {
  batches: readonly (readonly unknown[])[];
  featurePolicy?: CanonicalSourceDescriptorV4['featurePolicy'];
  imageAssetIdentityDigests?: readonly string[];
  imageContentHashes?: readonly string[];
  descriptorSeed?: string;
  sourceVersion: string;
  title: string;
}): CanonicalSourceDescriptorV4 {
  const imageAssetIdentityDigests = [
    ...(input.imageAssetIdentityDigests ?? []),
  ];
  const imageContentHashes = [...(input.imageContentHashes ?? [])];
  return {
    converterVersion: 'converter-v4',
    expectedBatchCount: input.batches.length,
    expectedBlockCount: input.batches.reduce(
      (count, batch) => count + batch.length,
      0,
    ),
    expectedImageCount: imageAssetIdentityDigests.length,
    featurePolicy: input.featurePolicy ?? 'text-only-v1',
    normalizedHTMLHash: digestCanonical('test-normalized-html-v4', {
      descriptorSeed: input.descriptorSeed ?? input.sourceVersion,
    }),
    normalizedTitleHash: digestCanonical(
      'test-normalized-title-v4',
      input.title,
    ),
    noteIdentity: {
      libraryID: targetV4.libraryID,
      noteItemKey: targetV4.noteItemKey,
      parentItemKey: targetV4.parentItemKey,
    },
    orderedBatchDigests: input.batches.map((batch, batchIndex) =>
      digestCanonical('notero-batch-v4', {
        batch,
        batchIndex,
        sourceVersion: input.sourceVersion,
      }),
    ),
    orderedImageAssetIdentityDigests: imageAssetIdentityDigests,
    orderedImageContentHashes: imageContentHashes,
    targetIdentityDigest: deriveTargetIdentityDigest(targetV4),
  };
}

export const sourceVersionV4 =
  'source:0000000000000000000000000000000000000000000000000000000000000001';
export const defaultSourceBatchesV4 = [
  [{ paragraph: { rich_text: [] }, type: 'paragraph' }],
] as const;
export const sourceDescriptorV4 = syntheticSourceDescriptorV4({
  batches: defaultSourceBatchesV4,
  sourceVersion: sourceVersionV4,
  title: 'Synthetic note',
});
export const manifestDigestV4 = deriveManifestDigestV4(sourceDescriptorV4);

function firstBatchDigest(descriptor: CanonicalSourceDescriptorV4): string {
  const digest = descriptor.orderedBatchDigests[0];
  if (!digest) throw new Error('Synthetic source descriptor has no batch');
  return digest;
}

export const batchDigestV4 = firstBatchDigest(sourceDescriptorV4);

export function textSourceSnapshotV4(
  sourceVersion = sourceVersionV4,
  descriptorSeed = sourceVersion,
  title = 'Synthetic note',
): SourceSnapshotV4 {
  const batches = defaultSourceBatchesV4.map((batch) => [...batch]);
  const effectiveDescriptorSeed =
    sourceVersion === sourceVersionV4 && descriptorSeed === manifestDigestV4
      ? sourceVersion
      : descriptorSeed;
  const sourceDescriptor = syntheticSourceDescriptorV4({
    batches,
    descriptorSeed: effectiveDescriptorSeed,
    sourceVersion,
    title,
  });
  return {
    batches,
    featurePolicy: 'text-only-v1',
    imageAssetIDsByBatch: [[]],
    imageAssets: [],
    imageOccurrenceCount: 0,
    manifestDigest: deriveManifestDigestV4(sourceDescriptor),
    sourceDescriptor,
    sourceVersion,
    title,
  };
}

export function containerV4(
  blockID = 'container-test',
): ManagedContainerMapping {
  return {
    blockID,
    createdByID: asRemoteCreatorIdentity('connection-test'),
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
    createdByID: asRemoteCreatorIdentity('connection-test'),
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

type FixtureTransactionIdentity = {
  generation?: number;
  manifestDigest?: string;
  sourceVersion?: string;
  transactionID?: string;
};

function descriptorForIdentity(
  identity: FixtureTransactionIdentity,
): CanonicalSourceDescriptorV4 {
  if (!identity.manifestDigest && !identity.sourceVersion) {
    return sourceDescriptorV4;
  }
  return syntheticSourceDescriptorV4({
    batches: defaultSourceBatchesV4,
    descriptorSeed: identity.manifestDigest ?? identity.sourceVersion,
    sourceVersion: identity.sourceVersion ?? sourceVersionV4,
    title: 'Synthetic note',
  });
}

function manifestForIdentity(identity: FixtureTransactionIdentity): string {
  return deriveManifestDigestV4(descriptorForIdentity(identity));
}

function intentBase(identity: FixtureTransactionIdentity = {}) {
  return {
    createdAt: clockV4.nowISOString(),
    generation: identity.generation ?? 1,
    leaseEpoch: 1,
    leaseID: 'lease-test',
    operationSequence: 1,
    owner: 'MAIN' as const,
    processSessionID: 'process-test',
    sourceVersion: identity.sourceVersion ?? sourceVersionV4,
    targetIdentityDigest: deriveTargetIdentityDigest(targetV4),
    transactionID: identity.transactionID ?? 'transaction-test',
  };
}

export function verifyIntentV4(
  blockID = 'candidate-test',
  identity: FixtureTransactionIdentity = {},
): Extract<SealedOperationIntent, { kind: 'VERIFY_CANDIDATE' }> {
  const descriptor = descriptorForIdentity(identity);
  const intent = createOperationIntent({
    ...intentBase(identity),
    details: {
      batchBlockCounts: [1],
      batchDigests: [...descriptor.orderedBatchDigests],
      blockFingerprints: ['block:0'],
      candidate: candidateResourceV4(blockID),
      expectedBatchCount: 1,
      expectedBlockCount: 1,
      expectedImageUploadIDs: [],
      expectedTitle: 'Notero Sync Incomplete — Synthetic note',
      fileUploads: [],
      manifestDigest: manifestForIdentity(identity),
      returnedBlockIDs: ['child:0'],
      sourceDescriptor: descriptor,
    },
    kind: 'VERIFY_CANDIDATE',
    operationID: 'operation:verify-candidate-test',
  });
  if (intent.kind !== 'VERIFY_CANDIDATE') throw new Error('bad fixture');
  return intent;
}

export function finalizeIntentV4(
  blockID = 'candidate-test',
  identity: FixtureTransactionIdentity = {},
): Extract<SealedOperationIntent, { kind: 'FINALIZE_CANDIDATE' }> {
  const intent = createOperationIntent({
    ...intentBase(identity),
    details: {
      candidate: candidateResourceV4(blockID),
      finalTitle: 'Synthetic note',
      stagingTitle: 'Notero Sync Incomplete — Synthetic note',
      verification: verifyIntentV4(blockID, identity).details,
    },
    kind: 'FINALIZE_CANDIDATE',
    operationID: 'operation:finalize-candidate-test',
  });
  if (intent.kind !== 'FINALIZE_CANDIDATE') throw new Error('bad fixture');
  return intent;
}

export function candidateV4(
  status: CandidateRecordV4['status'] = 'WRITING',
  blockID = 'candidate-test',
  identity: FixtureTransactionIdentity = {},
): CandidateRecordV4 {
  const descriptor = descriptorForIdentity(identity);
  const batchEvidence =
    status === 'CREATED'
      ? []
      : [
          {
            batchDigest: firstBatchDigest(descriptor),
            blockFingerprints: ['block:0'],
            completedAt: clockV4.nowISOString(),
            imageAssetIdentityDigests: [],
            imageUploadIDs: [],
            index: 0,
            parentBlockID: candidateResourceV4(blockID).blockID,
            returnedBlockIDs: ['child:0'],
          },
        ];
  const completionEvidence =
    status === 'DURABLE' || status === 'VERIFIED'
      ? {
          batchDigests: [...descriptor.orderedBatchDigests],
          blockFingerprints: ['block:0'],
          candidateBlockID: candidateResourceV4(blockID).blockID,
          completedBatchCount: 1,
          expectedBatchCount: 1,
          expectedBlockCount: 1,
          expectedImageCount: 0,
          imageAssetIdentities: [],
          imageAssetIdentityDigests: [],
          imageUploadIDs: [],
          manifestDigest: manifestForIdentity(identity),
          returnedBlockIDs: ['child:0'],
          sourceVersion: identity.sourceVersion ?? sourceVersionV4,
          verificationIntent: sealOperationIntent(
            verifyIntentV4(blockID, identity),
            'SEALED',
          ),
          verifiedAt: clockV4.nowISOString(),
        }
      : null;
  const finalizationEvidence =
    status === 'DURABLE'
      ? {
          candidateBlockID: candidateResourceV4(blockID).blockID,
          finalTitle: 'Synthetic note',
          finalizationIntent: sealOperationIntent(
            finalizeIntentV4(blockID, identity),
            'SEALED',
          ),
          finalizedAt: clockV4.nowISOString(),
          lastEditedTime: candidateResourceV4(blockID).lastEditedTime,
          stagingTitle: 'Notero Sync Incomplete — Synthetic note',
        }
      : null;
  return {
    batchEvidence,
    completionEvidence,
    container: containerV4(),
    expectedBatchCount: 1,
    expectedBlockCount: 1,
    expectedImageCount: 0,
    finalizationEvidence,
    finalTitle: 'Synthetic note',
    generation: identity.generation ?? 1,
    imageAssetIdentities: [],
    manifestDigest: manifestForIdentity(identity),
    previousActiveBlockID: null,
    resource: candidateResourceV4(blockID),
    sourceDescriptor: descriptor,
    sourceVersion: identity.sourceVersion ?? sourceVersionV4,
    stagingTitle: 'Notero Sync Incomplete — Synthetic note',
    status,
    targetIdentityDigest: deriveTargetIdentityDigest(targetV4),
    transactionID: identity.transactionID ?? 'transaction-test',
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
      sourceDescriptor: sourceDescriptorV4,
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
      sourceDescriptor: sourceDescriptorV4,
      sourceVersion: sourceVersionV4,
    },
    writerCoordination: { mainLease: leaseV4() },
  };
}
