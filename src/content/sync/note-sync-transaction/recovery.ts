import type { NoteSyncEvent } from './events';
import type {
  CandidateRecord,
  CleanupTarget,
  CompletionEvidence,
  ManagedResourceRecord,
  OperationEvidence,
  QuarantineRecord,
  UploadAssetRecord,
} from './types';

export type RemoteOperationObservation =
  | {
      evidence: OperationEvidence;
      resource?: ManagedResourceRecord;
      type: 'success';
    }
  | {
      asset: UploadAssetRecord;
      evidence: OperationEvidence;
      type: 'upload-observed';
    }
  | {
      candidate: CandidateRecord;
      evidence: OperationEvidence;
      type: 'candidate-created';
    }
  | {
      completionEvidence: CompletionEvidence;
      finalBlock: ManagedResourceRecord;
      type: 'candidate-finalized';
    }
  | {
      attachedUploads: UploadAssetRecord[];
      cleanupTarget: CleanupTarget;
      type: 'append-unknown';
    }
  | {
      cleanupTarget?: CleanupTarget;
      diagnostic?: QuarantineRecord;
      type: 'finalization-unknown';
    }
  | { diagnostic: QuarantineRecord; type: 'uncertain' }
  | { type: 'proven-unexecuted' };

export function observationToEvent(
  observation: RemoteOperationObservation,
): NoteSyncEvent {
  switch (observation.type) {
    case 'success':
      return {
        evidence: observation.evidence,
        ...(observation.resource && { resource: observation.resource }),
        type: 'OPERATION_SUCCEEDED',
      };
    case 'upload-observed':
      return {
        asset: observation.asset,
        evidence: observation.evidence,
        type: 'UPLOAD_OBSERVED',
      };
    case 'candidate-created':
      return {
        candidate: observation.candidate,
        evidence: observation.evidence,
        type: 'RECONCILE_CREATE',
      };
    case 'candidate-finalized':
      return {
        completionEvidence: observation.completionEvidence,
        finalBlock: observation.finalBlock,
        type: 'FINALIZE_CONFIRMED',
      };
    case 'append-unknown':
      return {
        attachedUploads: observation.attachedUploads,
        cleanupTarget: observation.cleanupTarget,
        type: 'APPEND_UNKNOWN',
      };
    case 'finalization-unknown':
      return {
        ...(observation.cleanupTarget && {
          cleanupTarget: observation.cleanupTarget,
        }),
        ...(observation.diagnostic && { diagnostic: observation.diagnostic }),
        type: 'FINALIZE_UNKNOWN',
      };
    case 'uncertain':
      return {
        diagnostic: observation.diagnostic,
        type: 'OPERATION_UNCERTAIN',
      };
    case 'proven-unexecuted':
      return { type: 'OPERATION_PROVEN_UNEXECUTED' };
  }
  return assertNever(observation);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported remote observation: ${JSON.stringify(value)}`);
}
