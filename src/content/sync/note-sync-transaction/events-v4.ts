import type {
  BatchCompletionEvidence,
  CandidateRecordV4,
  CleanupLedgerEntry,
  CompletionEvidenceV4,
  MainTransactionV2,
  MainWriterLease,
  ManagedContainerMapping,
  RemoteObservation,
  RemoteVerificationState,
  RequestedSource,
  RunHalt,
  SealedOperationIntent,
  SealedQuarantineEvidence,
  UploadAssetRecordV4,
} from './types-v4';

export type MainEventV2 =
  | { source: RequestedSource; type: 'SOURCE_OBSERVED' }
  | { transaction: MainTransactionV2; type: 'START_SYNC' }
  | { transaction: MainTransactionV2; type: 'START_LIVENESS' }
  | { lease: MainWriterLease; type: 'MAIN_LEASE_ACQUIRED' }
  | { type: 'RESUME_AFTER_HALT' }
  | {
      intent: Extract<SealedOperationIntent, { kind: 'CREATE_CONTAINER' }>;
      type: 'CONTAINER_INTENT_PERSISTED';
    }
  | {
      container: ManagedContainerMapping;
      observation: RemoteObservation;
      type: 'CONTAINER_CREATED';
    }
  | {
      asset: UploadAssetRecordV4;
      intent: Extract<
        SealedOperationIntent,
        { kind: 'UPLOAD_CREATE' | 'UPLOAD_SEND' }
      >;
      type: 'UPLOAD_INTENT_PERSISTED';
    }
  | {
      asset: UploadAssetRecordV4;
      observation: RemoteObservation;
      type: 'UPLOAD_OBSERVED';
    }
  | {
      intent: Extract<SealedOperationIntent, { kind: 'CREATE_CANDIDATE' }>;
      type: 'CANDIDATE_INTENT_PERSISTED';
    }
  | {
      candidate: CandidateRecordV4;
      observation: RemoteObservation;
      type: 'CANDIDATE_CREATED';
    }
  | {
      intent: Extract<SealedOperationIntent, { kind: 'APPEND_BATCH' }>;
      type: 'APPEND_INTENT_PERSISTED';
    }
  | {
      evidence: BatchCompletionEvidence;
      observation: RemoteObservation;
      type: 'BATCH_APPENDED';
    }
  | {
      intent: Extract<SealedOperationIntent, { kind: 'VERIFY_CANDIDATE' }>;
      type: 'VERIFY_INTENT_PERSISTED';
    }
  | {
      completionEvidence: CompletionEvidenceV4;
      observation: RemoteObservation;
      type: 'CANDIDATE_VERIFIED';
    }
  | {
      retiredActiveCleanup: CleanupLedgerEntry | null;
      type: 'COMMIT_DURABLE_CANDIDATE';
    }
  | {
      cleanupEntries: CleanupLedgerEntry[];
      replacement: MainTransactionV2;
      type: 'SUPERSEDE_TRANSACTION';
    }
  | { halt: RunHalt; type: 'OPERATION_REJECTED' }
  | {
      evidence: SealedQuarantineEvidence;
      type: 'OPERATION_UNCERTAIN';
    }
  | {
      evidence: SealedQuarantineEvidence;
      type: 'VALIDATION_QUARANTINED';
    }
  | {
      intent: Extract<SealedOperationIntent, { kind: 'VERIFY_LIVENESS' }>;
      type: 'LIVENESS_INTENT_PERSISTED';
    }
  | {
      verification: RemoteVerificationState;
      type: 'LIVENESS_EXACT';
    }
  | {
      clearContainer: boolean;
      evidence: SealedQuarantineEvidence;
      replacement: MainTransactionV2;
      verification: RemoteVerificationState;
      type: 'LIVENESS_REPAIR_REQUIRED';
    };

export type MainEventKindV2 = MainEventV2['type'];
