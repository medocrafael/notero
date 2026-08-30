import { createIdleRecord } from '../model';
import type {
  CandidateRecord,
  CompletionEvidence,
  ManagedResourceRecord,
  NoteSyncRecordV3,
  OperationEvidence,
  OperationIntent,
  OperationKind,
  QuarantineRecord,
  TargetIdentity,
  VersionRecord,
} from '../types';

export const now = '2026-08-30T00:00:00.000Z';
export const target: TargetIdentity = {
  connectionID: 'connection-test',
  databaseID: 'database-test',
  libraryID: 1,
  noteItemKey: 'NOTE0001',
  pageID: 'page-test',
  parentItemKey: 'PARENT01',
  workspaceID: 'workspace-test',
};

export function resource(
  kind: ManagedResourceRecord['kind'],
  blockID = `${kind}-block`,
): ManagedResourceRecord {
  return {
    attemptID: kind === 'candidate' ? 'transaction-test' : undefined,
    blockID,
    createdByID: target.connectionID,
    kind,
    lastEditedTime: now,
    marker: `ownership-${kind}-marker`,
    operationID: `create-${blockID}`,
    parent:
      kind === 'container'
        ? { id: target.pageID, type: 'page_id' }
        : { id: 'container-block', type: 'block_id' },
    versionMarker: `version-${kind}-marker`,
  };
}

export function evidence(
  operationID: string,
  result: OperationEvidence['result'],
  requestDigest = `digest-${operationID}`,
): OperationEvidence {
  return { observedAt: now, operationID, requestDigest, result };
}

export const completionEvidence: CompletionEvidence = {
  completedAt: now,
  finalization: evidence('finalize-op', 'finalized', 'digest-finalize-op'),
  manifestDigest: 'manifest-digest',
  verifiedAt: now,
};

export function candidate(
  status: CandidateRecord['status'] = 'staging',
): CandidateRecord {
  return {
    batchDigests: status === 'staging' ? [] : ['batch-digest-0001'],
    block: resource(status === 'durable' ? 'note' : 'candidate'),
    completionEvidence: status === 'durable' ? completionEvidence : null,
    expectedBlockCount: 1,
    expectedImageCount: 0,
    generation: 1,
    imageAssetIdentities: [],
    manifestDigest: 'manifest-digest',
    nextBatchIndex: status === 'staging' ? 0 : 1,
    previousActiveBlockID: null,
    returnedBlockIDs: status === 'staging' ? [] : ['content-block-0001'],
    sourceVersion: 'source-version-0001',
    status,
    transactionID: 'transaction-test',
  };
}

export function version(
  block = resource('note', 'active-block'),
): VersionRecord {
  return {
    block,
    committedAt: now,
    completedAt: now,
    completionEvidence,
    container: resource('container', 'container-block'),
    contentManifestDigest: 'manifest-digest',
    generation: 0,
    imageAssetIdentities: [],
    sourceVersion: 'active-version-0001',
    transactionID: 'transaction-active',
  };
}

export function quarantine(
  code: QuarantineRecord['code'] = 'INVALID_TRANSACTION',
): QuarantineRecord {
  return {
    actionable: true,
    code,
    createdAt: now,
    evidenceDigest: 'evidence-digest',
    message: 'Synthetic actionable diagnostic',
    operationID: null,
  };
}

export function record(
  state: NoteSyncRecordV3['state'],
  options: {
    active?: VersionRecord | null;
    featurePolicy?: NoteSyncRecordV3['featurePolicy'];
  } = {},
): NoteSyncRecordV3 {
  const base = createIdleRecord(
    target,
    options.featurePolicy || 'embedded-images-v1',
    now,
  );
  if (state === 'IDLE') return { ...base, active: options.active || null };
  if (state === 'QUARANTINED') {
    return {
      ...base,
      active: options.active || null,
      quarantine: [quarantine()],
      state,
    };
  }
  const transactional: NoteSyncRecordV3 = {
    ...base,
    active: options.active === undefined ? null : options.active,
    container: resource('container', 'container-block'),
    generation: 1,
    requestedSourceVersion: 'source-version-0001',
    sourceVersion: 'source-version-0001',
    state,
    transactionID: 'transaction-test',
  };
  if (state === 'CANDIDATE_WRITING') {
    transactional.candidate = candidate('staging');
  } else if (state === 'CANDIDATE_VERIFYING') {
    transactional.candidate = candidate('verified');
  } else if (state === 'CANDIDATE_DURABLE') {
    transactional.candidate = candidate('durable');
  } else if (state === 'ACTIVE_COMMITTED') {
    transactional.candidate = candidate('durable');
    transactional.active = version(transactional.candidate.block);
    transactional.active = {
      ...transactional.active,
      generation: 1,
      sourceVersion: transactional.sourceVersion || 'source-version-0001',
      transactionID: transactional.transactionID || 'transaction-test',
    };
  } else if (state === 'CLEANING') {
    transactional.active = options.active || version();
    transactional.cleanup = {
      mode: 'abort',
      resume: 'PREPARING',
      targets: [
        {
          generation: 1,
          reason: 'aborted-candidate',
          resource: resource('candidate', 'cleanup-block'),
          sourceVersion: 'source-version-0001',
          status: 'pending',
          transactionID: 'transaction-test',
        },
      ],
    };
  }
  return transactional;
}

export function intent(kind: OperationKind): OperationIntent {
  const base = {
    generation: 1,
    operationGeneration: 1,
    operationID: `${kind.toLowerCase()}-op`,
    phase: 'INTENDED' as const,
    requestDigest: `digest-${kind.toLowerCase()}-op`,
    sourceVersion: 'source-version-0001',
    targetIdentity: target,
    transactionID: 'transaction-test',
  };
  let value: OperationIntent;
  switch (kind) {
    case 'CREATE_CONTAINER':
      value = {
        ...base,
        details: {
          expectedCreator: target.connectionID,
          isolationDeadline: '2026-08-30T00:02:00.000Z',
          marker: `ownership-${kind.toLowerCase()}-marker`,
          migrationNotice: false,
          parent:
            kind === 'CREATE_CONTAINER'
              ? { id: target.pageID, type: 'page_id' }
              : { id: 'container-block', type: 'block_id' },
          requestStartedAt: now,
          title: kind === 'CREATE_CONTAINER' ? 'Zotero Notes' : 'Note title',
          versionMarker: `version-${kind.toLowerCase()}-marker`,
        },
        kind,
      };
      break;
    case 'CREATE_CANDIDATE':
      value = {
        ...base,
        details: {
          candidatePlan: {
            expectedBlockCount: 1,
            expectedImageCount: 0,
            imageAssetIdentities: [],
            manifestDigest: 'manifest-digest',
            previousActiveBlockID: null,
          },
          container: resource('container', 'container-block'),
          expectedCreator: target.connectionID,
          isolationDeadline: '2026-08-30T00:02:00.000Z',
          marker: 'ownership-create_candidate-marker',
          migrationNotice: false,
          parent: { id: 'container-block', type: 'block_id' },
          requestStartedAt: now,
          title: 'Note title',
          versionMarker: 'version-create_candidate-marker',
        },
        kind,
      };
      break;
    case 'APPEND_BATCH':
      value = {
        ...base,
        details: {
          batchDigest: 'batch-digest-0001',
          batchIndex: 0,
          candidate: resource('candidate'),
          expectedBlockCount: 1,
          fileUploads: [],
        },
        kind,
      };
      break;
    case 'FINALIZE_CANDIDATE':
      value = {
        ...base,
        details: {
          candidate: resource('candidate'),
          finalTitle: 'Note title',
          manifestDigest: 'manifest-digest',
          ownershipMarker: 'ownership-note-marker',
          versionMarker: 'version-note-marker',
        },
        kind,
        operationID: 'finalize-op',
        requestDigest: 'digest-finalize-op',
      };
      break;
    case 'DELETE_BLOCK': {
      const cleanup = resource('candidate', 'cleanup-block');
      value = {
        ...base,
        details: {
          exactBlockID: cleanup.blockID,
          expectedCreator: cleanup.createdByID,
          expectedLastEditedTime: cleanup.lastEditedTime,
          expectedOwnershipMarker: cleanup.marker,
          expectedParent: cleanup.parent,
          expectedVersionMarker: cleanup.versionMarker,
          kind: cleanup.kind,
          reason: 'aborted-candidate',
          targetGeneration: 1,
          targetSourceVersion: 'source-version-0001',
        },
        kind,
      };
      break;
    }
    case 'UPLOAD_CREATE':
      value = {
        ...base,
        details: {
          attachmentKey: 'IMAGE001',
          contentHash: 'image-content-hash',
          contentLength: 100,
          contentType: 'image/png',
          filename: 'notero-image.png',
          isolationDeadline: '2026-08-30T01:05:00.000Z',
          requestStartedAt: now,
        },
        kind,
      };
      break;
    case 'UPLOAD_SEND':
      value = {
        ...base,
        details: {
          attachmentKey: 'IMAGE001',
          contentHash: 'image-content-hash',
          contentLength: 100,
          contentType: 'image/png',
          createOperationID: 'upload_create-op',
          filename: 'notero-image.png',
          fileUploadID: 'upload-test',
        },
        kind,
      };
      break;
  }
  return value;
}
