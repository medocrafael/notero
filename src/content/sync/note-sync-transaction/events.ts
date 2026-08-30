import type {
  CandidateRecord,
  CleanupTarget,
  CompletionEvidence,
  FeaturePolicy,
  ManagedResourceRecord,
  OperationEvidence,
  OperationIntent,
  QuarantineRecord,
  SourceSnapshot,
  TargetIdentity,
  UploadAssetRecord,
  VersionRecord,
} from './types';

export type NoteSyncEvent =
  | {
      featurePolicy: FeaturePolicy;
      now: string;
      requestedSourceVersion: string;
      source: SourceSnapshot;
      targetIdentity: TargetIdentity;
      transactionID: string;
      type: 'SYNC_REQUESTED';
    }
  | { intent: OperationIntent; type: 'CONTAINER_REQUIRED' }
  | {
      intent: OperationIntent;
      upload: UploadAssetRecord;
      type: 'UPLOAD_CREATE_REQUIRED';
    }
  | { intent: OperationIntent; type: 'UPLOAD_SEND_REQUIRED' }
  | { type: 'RESOURCES_READY' }
  | { intent: OperationIntent; type: 'CREATE_CANDIDATE' }
  | {
      candidate: CandidateRecord;
      evidence: OperationEvidence;
      type: 'RECONCILE_CREATE';
    }
  | { intent: OperationIntent; type: 'APPEND_BATCH' }
  | {
      attachedUploads?: UploadAssetRecord[];
      cleanupTarget: CleanupTarget;
      type: 'APPEND_UNKNOWN';
    }
  | { type: 'CONTENT_COMPLETE' }
  | { intent: OperationIntent; type: 'FINALIZE_CANDIDATE' }
  | {
      completionEvidence: CompletionEvidence;
      finalBlock: ManagedResourceRecord;
      type: 'FINALIZE_CONFIRMED';
    }
  | {
      cleanupTarget?: CleanupTarget;
      diagnostic?: QuarantineRecord;
      type: 'FINALIZE_UNKNOWN';
    }
  | { committedAt: string; type: 'COMMIT_ACTIVE' }
  | { type: 'NO_PREVIOUS_ACTIVE' }
  | { type: 'PREVIOUS_ACTIVE_RETIRED' }
  | { intent: OperationIntent; type: 'DELETE_NEXT' }
  | {
      diagnostic?: QuarantineRecord;
      evidence?: OperationEvidence;
      type: 'RECOVER_DELETE_INTENT';
    }
  | { type: 'CLEANUP_COMPLETE' }
  | {
      cleanupTarget?: CleanupTarget;
      now: string;
      requestedSourceVersion: string;
      type: 'SOURCE_CHANGED';
    }
  | {
      cleanupTarget: CleanupTarget;
      now: string;
      requestedSourceVersion: string;
      type: 'SOURCE_CHANGED_WITH_ACTIVE';
    }
  | {
      committedAt: string;
      now: string;
      requestedSourceVersion: string;
      type: 'SOURCE_CHANGED_WITHOUT_ACTIVE';
    }
  | {
      diagnostic: QuarantineRecord;
      type: 'INVALID_SCHEMA_OR_EVIDENCE';
    }
  | {
      active?: VersionRecord | null;
      candidate?: CandidateRecord | null;
      repairedState: 'IDLE' | 'PREPARING';
      type: 'EXPLICIT_REPAIR_OR_NEW_PROOF';
    }
  | {
      evidence: OperationEvidence;
      resource?: ManagedResourceRecord;
      type: 'OPERATION_SUCCEEDED';
    }
  | {
      asset: UploadAssetRecord;
      evidence: OperationEvidence;
      type: 'UPLOAD_OBSERVED';
    }
  | { diagnostic: QuarantineRecord; type: 'OPERATION_UNCERTAIN' }
  | { type: 'OPERATION_PROVEN_UNEXECUTED' };
