import type { NotionTarget } from '../notion-image-upload-service';

export const NOTE_SYNC_SCHEMA_VERSION = 3 as const;

export const NOTE_TRANSACTION_STATES = [
  'IDLE',
  'PREPARING',
  'CANDIDATE_CREATING',
  'CANDIDATE_WRITING',
  'CANDIDATE_VERIFYING',
  'CANDIDATE_DURABLE',
  'ACTIVE_COMMITTED',
  'CLEANING',
  'QUARANTINED',
] as const;

export type NoteTransactionState = (typeof NOTE_TRANSACTION_STATES)[number];

export const OPERATION_KINDS = [
  'CREATE_CONTAINER',
  'CREATE_CANDIDATE',
  'APPEND_BATCH',
  'FINALIZE_CANDIDATE',
  'DELETE_BLOCK',
  'UPLOAD_CREATE',
  'UPLOAD_SEND',
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];
export type OperationIntentPhase = 'INTENDED' | 'UNCERTAIN';
export type FeaturePolicy = 'embedded-images-v1' | 'text-only-v1';

export type TargetIdentity = NotionTarget & {
  libraryID: number;
  noteItemKey: string;
  parentItemKey: string;
};

export type RemoteParent = {
  id: string;
  type: 'block_id' | 'page_id';
};

export type ManagedBlockReference = {
  attemptID?: string;
  blockID: string;
  createdByID?: string;
  kind: 'candidate' | 'container' | 'note';
  marker: string;
};

export type ManagedResourceRecord = ManagedBlockReference & {
  createdByID: string;
  lastEditedTime: string;
  operationID: string;
  parent: RemoteParent;
  versionMarker: string;
};

export type RemoteOperationIdentity = {
  generation: number;
  operationGeneration: number;
  operationID: string;
  requestDigest: string;
  sourceVersion: string;
  targetIdentity: TargetIdentity;
  transactionID: string;
};

export type DeleteIntentDetails = {
  exactBlockID: string;
  expectedCreator: string | null;
  expectedLastEditedTime: string;
  expectedOwnershipMarker: string;
  expectedParent: RemoteParent;
  expectedVersionMarker: string;
  kind: ManagedResourceRecord['kind'];
  reason:
    | 'aborted-candidate'
    | 'orphan-cleanup'
    | 'retired-active'
    | 'superseded-candidate'
    | 'unused-container';
  targetGeneration: number;
  targetSourceVersion: string;
};

export type CreateBlockIntentDetails = {
  expectedCreator: string | null;
  isolationDeadline: string;
  marker: string;
  migrationNotice: boolean;
  parent: RemoteParent;
  requestStartedAt: string;
  title: string;
  versionMarker: string;
};

export type CreateCandidateIntentDetails = CreateBlockIntentDetails & {
  candidatePlan: {
    expectedBlockCount: number;
    expectedImageCount: number;
    imageAssetIdentities: string[];
    manifestDigest: string;
    previousActiveBlockID: string | null;
  };
  container: ManagedResourceRecord;
};

export type AppendBatchIntentDetails = {
  batchDigest: string;
  batchIndex: number;
  candidate: ManagedResourceRecord;
  expectedBlockCount: number;
  fileUploads: UploadAssetRecord[];
};

export type FinalizeCandidateIntentDetails = {
  candidate: ManagedResourceRecord;
  finalTitle: string;
  manifestDigest: string;
  ownershipMarker: string;
  versionMarker: string;
};

export type UploadCreateIntentDetails = {
  attachmentKey: string;
  contentHash: string;
  contentLength: number;
  contentType: string;
  filename: string;
  isolationDeadline: string;
  requestStartedAt: string;
};

export type UploadSendIntentDetails = {
  attachmentKey: string;
  contentHash: string;
  contentLength: number;
  contentType: string;
  createOperationID: string;
  fileUploadID: string;
  filename: string;
};

type OperationIntentBase<
  K extends OperationKind,
  D,
> = RemoteOperationIdentity & {
  details: D;
  kind: K;
  phase: OperationIntentPhase;
};

export type OperationIntent =
  | OperationIntentBase<'APPEND_BATCH', AppendBatchIntentDetails>
  | OperationIntentBase<'CREATE_CANDIDATE', CreateCandidateIntentDetails>
  | OperationIntentBase<'CREATE_CONTAINER', CreateBlockIntentDetails>
  | OperationIntentBase<'DELETE_BLOCK', DeleteIntentDetails>
  | OperationIntentBase<'FINALIZE_CANDIDATE', FinalizeCandidateIntentDetails>
  | OperationIntentBase<'UPLOAD_CREATE', UploadCreateIntentDetails>
  | OperationIntentBase<'UPLOAD_SEND', UploadSendIntentDetails>;

export type OperationEvidence = {
  observedAt: string;
  operationID: string;
  requestDigest: string;
  result:
    | 'attached'
    | 'created'
    | 'deleted'
    | 'finalized'
    | 'uploaded'
    | 'written';
  returnedBlockIDs?: string[];
  remoteLastEditedTime?: string;
};

export type UploadAssetRecord = {
  attachedAt: string | null;
  attachmentKey: string;
  contentHash: string;
  contentLength: number;
  contentType: string;
  createOperationID: string;
  expiryTime: string | null;
  fileUploadID: string | null;
  filename: string;
  generation: number;
  sendOperationID: string | null;
  sourceVersion: string;
  status:
    | 'attached'
    | 'create-intended'
    | 'create-uncertain'
    | 'created-unsent'
    | 'expired'
    | 'failed'
    | 'send-intended'
    | 'send-uncertain'
    | 'uploaded';
  targetIdentity: TargetIdentity;
  transactionID: string;
};

export type CompletionEvidence = {
  completedAt: string;
  finalization: OperationEvidence;
  manifestDigest: string;
  verifiedAt: string;
};

export type VersionRecord = {
  block: ManagedResourceRecord;
  committedAt: string;
  completedAt: string;
  completionEvidence: CompletionEvidence;
  container: ManagedResourceRecord;
  contentManifestDigest: string;
  generation: number;
  imageAssetIdentities: string[];
  sourceVersion: string;
  transactionID: string;
};

export type CandidateRecord = {
  batchDigests: string[];
  block: ManagedResourceRecord;
  completionEvidence: CompletionEvidence | null;
  expectedBlockCount: number;
  expectedImageCount: number;
  generation: number;
  imageAssetIdentities: string[];
  manifestDigest: string;
  nextBatchIndex: number;
  previousActiveBlockID: string | null;
  returnedBlockIDs: string[];
  sourceVersion: string;
  status: 'durable' | 'staging' | 'verified';
  transactionID: string;
};

export type CleanupTarget = {
  generation: number;
  reason: DeleteIntentDetails['reason'];
  resource: ManagedResourceRecord;
  sourceVersion: string;
  status: 'pending' | 'quarantined';
  transactionID: string;
};

export type QuarantineRecord = {
  actionable: boolean;
  code:
    | 'AMBIGUOUS_REMOTE_RESULT'
    | 'FEATURE_V2_TRANSACTION_UNSUPPORTED'
    | 'ILLEGAL_EVENT'
    | 'INVALID_FIELD'
    | 'INVALID_JSON'
    | 'INVALID_TRANSACTION'
    | 'OWNERSHIP_CHANGED'
    | 'PAGINATION_INCOMPLETE'
    | 'REMOTE_NOT_FOUND'
    | 'STALE_REVISION';
  createdAt: string;
  evidenceDigest: string;
  message: string;
  operationID: string | null;
};

export type NoteSyncRecordV3 = {
  active: VersionRecord | null;
  candidate: CandidateRecord | null;
  cleanup: {
    mode: 'abort' | 'retire' | null;
    resume: 'IDLE' | 'PREPARING';
    targets: CleanupTarget[];
  };
  container: ManagedResourceRecord | null;
  createdAt: string;
  featurePolicy: FeaturePolicy;
  generation: number;
  operationGeneration: number;
  operationIntent: OperationIntent | null;
  quarantine: QuarantineRecord[];
  recordRevision: number;
  requestedSourceVersion: string | null;
  schemaVersion: typeof NOTE_SYNC_SCHEMA_VERSION;
  sourceVersion: string | null;
  state: NoteTransactionState;
  targetIdentity: TargetIdentity;
  transactionID: string | null;
  updatedAt: string;
  uploads: UploadAssetRecord[];
};

export type ValidatedNoteSyncRecord = {
  record: NoteSyncRecordV3;
  validation: 'valid';
};

export type QuarantinedNoteSyncRecord = {
  diagnostic: QuarantineRecord;
  preservedRaw: string;
  validation: 'quarantined';
};

export type NoteSyncRecordValidation =
  | QuarantinedNoteSyncRecord
  | ValidatedNoteSyncRecord;

export type SourceSnapshot = {
  batches: readonly unknown[][];
  featurePolicy: FeaturePolicy;
  imageAssets: readonly {
    attachmentKey: string;
    contentHash: string;
    contentLength: number;
    contentType: string;
    filename: string;
  }[];
  manifestDigest: string;
  sourceVersion: string;
  title: string;
};
