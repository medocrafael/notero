import type {
  BatchCompletionEvidence,
  CandidateRecordV4,
  CleanupLedgerEntry,
  CompletionEvidenceV4,
  FinalizationEvidenceV4,
  MainTransactionV2,
  MainWriterLease,
  ManagedContainerMapping,
  OperationKindV4,
  RemoteObservation,
  RemoteVerificationState,
  RequestedSource,
  RunHalt,
  SealedOperationIntent,
  SealedQuarantineEvidence,
  UploadAssetRecordV4,
} from './types-v4';

export type MainEventPayloadV2 =
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
      attachedAssets: UploadAssetRecordV4[];
      candidate: CandidateRecordV4['resource'];
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
      intent: Extract<SealedOperationIntent, { kind: 'FINALIZE_CANDIDATE' }>;
      type: 'FINALIZE_INTENT_PERSISTED';
    }
  | {
      candidate: CandidateRecordV4['resource'];
      finalizationEvidence: FinalizationEvidenceV4;
      observation: RemoteObservation;
      type: 'CANDIDATE_FINALIZED';
    }
  | {
      committedAt: string;
      retiredActiveCleanup: CleanupLedgerEntry | null;
      type: 'COMMIT_DURABLE_CANDIDATE';
    }
  | {
      cleanupEntries: CleanupLedgerEntry[];
      replacement: MainTransactionV2;
      type: 'SUPERSEDE_TRANSACTION';
    }
  | {
      abortedCandidateCleanup?: CleanupLedgerEntry | null;
      evidence: SealedQuarantineEvidence;
      halt: RunHalt;
      type: 'OPERATION_REJECTED';
    }
  | {
      abortedCandidateCleanup: CleanupLedgerEntry | null;
      halt: RunHalt;
      operationKind: OperationKindV4;
      type: 'OPERATION_PROVEN_UNEXECUTED';
    }
  | { type: 'RECOVER_STALLED_CANDIDATE_CREATE' }
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

type MainEventTimingV2 = {
  occurredAt: string;
  updatedAt: string;
};

export type MainEventV2 = MainEventPayloadV2 extends infer Event
  ? Event extends { type: MainEventKindV2 }
    ? Event & MainEventTimingV2
    : never
  : never;

export type MainEventKindV2 = MainEventPayloadV2['type'];
