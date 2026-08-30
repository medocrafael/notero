import type { NotionTarget } from '../notion-image-upload-service';

export const NOTE_SYNC_SCHEMA_VERSION_V4 = 4 as const;

export const MAIN_STATES_V2 = [
  'IDLE',
  'PREPARING',
  'CANDIDATE_CREATING',
  'CANDIDATE_WRITING',
  'CANDIDATE_VERIFYING',
  'CANDIDATE_DURABLE',
  'QUARANTINED',
] as const;

export type MainStateV2 = (typeof MAIN_STATES_V2)[number];

export const CLEANUP_STATES = [
  'PENDING',
  'DELETE_INTENDED',
  'DELETE_UNCERTAIN',
  'QUARANTINED',
  'CONFIRMED',
] as const;

export type CleanupState = (typeof CLEANUP_STATES)[number];
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

export type ManagedResourceIdentity = {
  blockID: string;
  createdByID: string;
  kind: 'container' | 'note';
  lastEditedTime: string;
  operationMarker: string;
  ownershipMarker: string;
  parent: RemoteParent;
  targetIdentityDigest: string;
  versionMarker: string;
};

export type ManagedContainerMapping = ManagedResourceIdentity & {
  kind: 'container';
};

export type OwnershipExpectation = {
  blockID: string;
  createdByID: string;
  kind: ManagedResourceIdentity['kind'];
  lastEditedTime: string;
  operationMarker: string;
  ownershipMarker: string;
  parent: RemoteParent;
  targetIdentityDigest: string;
  versionMarker: string;
};

export type RequestedSource = {
  featurePolicy: FeaturePolicy;
  manifestDigest: string;
  observedAt: string;
  sourceVersion: string;
};

export type MainWriterLease = {
  acquiredAt: string;
  expiresAt: string;
  generation: number;
  leaseEpoch: number;
  leaseID: string;
  noteIdentityDigest: string;
  processSessionID: string;
  transactionID: string;
};

export type CleanupWorkerLease = {
  acquiredAt: string;
  cleanupID: string;
  expiresAt: string;
  leaseEpoch: number;
  leaseID: string;
  processSessionID: string;
};

export type UploadReference = {
  assetID: string;
  contentHash: string;
  fileUploadID: string;
};

export type CreateContainerDetails = {
  expectedCreator: string;
  isolationDeadline: string;
  migrationNotice: boolean;
  operationMarker: string;
  ownershipMarker: string;
  parent: RemoteParent;
  requestStartedAt: string;
  resourceTargetIdentityDigest: string;
  title: string;
  versionMarker: string;
};

export type CreateCandidateDetails = {
  container: ManagedContainerMapping;
  expectedCreator: string;
  expectedBatchCount: number;
  expectedBlockCount: number;
  expectedImageCount: number;
  expectedImageUploadIDs: string[];
  finalTitle: string;
  imageAssetIdentities: string[];
  isolationDeadline: string;
  manifestDigest: string;
  operationMarker: string;
  ownershipMarker: string;
  parent: RemoteParent;
  previousActiveBlockID: string | null;
  requestStartedAt: string;
  versionMarker: string;
};

export type AppendBatchDetails = {
  batchDigest: string;
  batchIndex: number;
  blockFingerprints: string[];
  candidate: ManagedResourceIdentity;
  expectedTitle: string;
  expectedBlockCount: number;
  fileUploads: UploadReference[];
  precedingBlockIDs: string[];
};

export type VerifyCandidateDetails = {
  batchBlockCounts: number[];
  batchDigests: string[];
  blockFingerprints: string[];
  candidate: ManagedResourceIdentity;
  expectedBatchCount: number;
  expectedBlockCount: number;
  expectedImageUploadIDs: string[];
  expectedTitle: string;
  manifestDigest: string;
  returnedBlockIDs: string[];
};

export type UploadCreateDetails = {
  assetID: string;
  attachmentIdentity: string;
  attachmentKey: string;
  contentHash: string;
  contentLength: number;
  contentType: string;
  expectedCreator: string;
  filename: string;
  isolationDeadline: string;
  requestStartedAt: string;
  sourceIdentity: string;
};

export type UploadSendDetails = {
  assetID: string;
  attachmentIdentity: string;
  attachmentKey: string;
  contentHash: string;
  contentLength: number;
  contentType: string;
  createOperationID: string;
  expectedCreator: string;
  fileUploadID: string;
  filename: string;
  sourceIdentity: string;
};

export type DeleteBlockDetails = {
  cleanupID: string;
  exactBlockID: string;
  ownership: OwnershipExpectation;
  reason: CleanupLedgerEntry['reason'];
};

export type VerifyLivenessDetails = {
  active: ManagedResourceIdentity | null;
  container: ManagedContainerMapping | null;
  force: boolean;
};

export const OPERATION_KINDS_V4 = [
  'CREATE_CONTAINER',
  'CREATE_CANDIDATE',
  'APPEND_BATCH',
  'VERIFY_CANDIDATE',
  'UPLOAD_CREATE',
  'UPLOAD_SEND',
  'VERIFY_LIVENESS',
  'DELETE_BLOCK',
] as const;

export type OperationKindV4 = (typeof OPERATION_KINDS_V4)[number];
export type OperationOwner = 'CLEANUP' | 'MAIN';
export type OperationIntentStatus = 'EXECUTABLE' | 'SEALED' | 'UNCERTAIN';

type OperationIntentBase<Kind extends OperationKindV4, Details> = {
  createdAt: string;
  details: Details;
  generation: number;
  kind: Kind;
  leaseEpoch: number;
  leaseID: string;
  operationID: string;
  operationSequence: number;
  owner: OperationOwner;
  processSessionID: string;
  requestDigest: string;
  sourceVersion: string;
  status: OperationIntentStatus;
  targetIdentityDigest: string;
  transactionID: string;
};

export type SealedOperationIntent =
  | OperationIntentBase<'APPEND_BATCH', AppendBatchDetails>
  | OperationIntentBase<'CREATE_CANDIDATE', CreateCandidateDetails>
  | OperationIntentBase<'CREATE_CONTAINER', CreateContainerDetails>
  | OperationIntentBase<'DELETE_BLOCK', DeleteBlockDetails>
  | OperationIntentBase<'UPLOAD_CREATE', UploadCreateDetails>
  | OperationIntentBase<'UPLOAD_SEND', UploadSendDetails>
  | OperationIntentBase<'VERIFY_CANDIDATE', VerifyCandidateDetails>
  | OperationIntentBase<'VERIFY_LIVENESS', VerifyLivenessDetails>;

export type BatchCompletionEvidence = {
  batchDigest: string;
  blockFingerprints: string[];
  completedAt: string;
  index: number;
  imageUploadIDs: string[];
  parentBlockID: string;
  returnedBlockIDs: string[];
};

export type CompletionEvidenceV4 = {
  batchDigests: string[];
  blockFingerprints: string[];
  candidateBlockID: string;
  completedBatchCount: number;
  expectedBatchCount: number;
  expectedBlockCount: number;
  expectedImageCount: number;
  imageAssetIdentities: string[];
  imageUploadIDs: string[];
  manifestDigest: string;
  returnedBlockIDs: string[];
  sourceVersion: string;
  verificationIntent: Extract<
    SealedOperationIntent,
    { kind: 'VERIFY_CANDIDATE' }
  >;
  verifiedAt: string;
};

export type CandidateRecordV4 = {
  batchEvidence: BatchCompletionEvidence[];
  completionEvidence: CompletionEvidenceV4 | null;
  container: ManagedContainerMapping;
  expectedBatchCount: number;
  expectedBlockCount: number;
  expectedImageCount: number;
  generation: number;
  imageAssetIdentities: string[];
  manifestDigest: string;
  previousActiveBlockID: string | null;
  resource: ManagedResourceIdentity;
  sourceVersion: string;
  status: 'CREATED' | 'DURABLE' | 'WRITING';
  targetIdentityDigest: string;
  transactionID: string;
};

export type DurableActiveMapping = {
  block: ManagedResourceIdentity;
  committedAt: string;
  completionEvidence: CompletionEvidenceV4;
  container: ManagedContainerMapping;
  featurePolicy: FeaturePolicy;
  generation: number;
  imageAssetIdentities: string[];
  manifestDigest: string;
  sourceVersion: string;
  targetIdentityDigest: string;
  transactionID: string;
};

export type RunHalt = {
  classification:
    | 'AUTH_REQUIRED'
    | 'PERMISSION_REQUIRED'
    | 'TRANSIENT_BUDGET_EXHAUSTED'
    | 'VALIDATION_FAILED';
  haltedAt: string;
  operationID: string | null;
  proof: 'NOT_EXECUTED' | 'UNKNOWN_AFTER_WRITE';
  redactedMessage: string;
};

export type MainTransactionV2 = {
  candidate: CandidateRecordV4 | null;
  featurePolicy: FeaturePolicy;
  generation: number;
  operationIntent: SealedOperationIntent | null;
  operationSequence: number;
  purpose: 'LIVENESS' | 'SYNC';
  runHalt: RunHalt | null;
  sourceManifestDigest: string;
  sourceTitle: string;
  targetIdentityDigest: string;
  transactionID: string;
  transactionSourceVersion: string;
};

export type RemoteObservation = {
  attachedUploadIDs: string[];
  blockFingerprints: string[];
  deletionProof: {
    archived: true;
    exactBlockID: string;
    inTrash: true;
  } | null;
  generation: number;
  observedAt: string;
  operationID: string;
  outcome:
    | 'APPENDED'
    | 'CREATED'
    | 'DELETED'
    | 'EXACT'
    | 'MISMATCH'
    | 'NOT_FOUND'
    | 'PERMISSION_DENIED'
    | 'UNKNOWN'
    | 'UPLOADED'
    | 'VERIFIED';
  remoteResource: ManagedResourceIdentity | null;
  requestDigest: string;
  responseClassification: string;
  returnedBlockIDs: string[];
  sourceVersion: string;
  targetIdentityDigest: string;
  transactionID: string;
  upload: UploadAssetRecordV4 | null;
};

export type CleanupLedgerEntry = {
  attemptCount: number;
  cleanupID: string;
  createdAt: string;
  deleteIntent: SealedOperationIntent | null;
  generation: number;
  lastObservation: RemoteObservation | null;
  nextRetryAt: string | null;
  ownership: OwnershipExpectation;
  quarantineEvidenceID: string | null;
  reason:
    | 'ABORTED_ATTEMPT'
    | 'REPLACED_ACTIVE'
    | 'SUPERSEDED_CANDIDATE'
    | 'UNUSED_CONTAINER';
  resource: ManagedResourceIdentity;
  sourceVersion: string;
  state: CleanupState;
  transactionID: string;
  updatedAt: string;
  workerLease: CleanupWorkerLease | null;
};

export type UploadAssetRecordV4 = {
  assetID: string;
  attachedAt: string | null;
  attachmentIdentity: string;
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
  sourceIdentity: string;
  sourceVersion: string;
  status:
    | 'ATTACHED'
    | 'CREATE_INTENDED'
    | 'CREATE_UNCERTAIN'
    | 'CREATED_UNSENT'
    | 'EXPIRED'
    | 'FAILED'
    | 'SEND_INTENDED'
    | 'SEND_UNCERTAIN'
    | 'UPLOADED';
  targetIdentityDigest: string;
  transactionID: string;
};

export type SealedQuarantineEvidence = {
  evidenceID: string;
  firstSeenAt: string;
  generation: number | null;
  lastObservation: RemoteObservation | null;
  lastSeenAt: string;
  noteRevision: number;
  origin: 'CLEANUP' | 'LIVENESS' | 'MAIN' | 'SCHEMA';
  originalOperationIntent: SealedOperationIntent | null;
  reasonCode: string;
  requiredRepair:
    | 'NONE'
    | 'RECONNECT_NOTION'
    | 'RESET_CORRUPT_METADATA'
    | 'RESTORE_CAPABILITY'
    | 'VERIFY_REMOTE_RESOURCE';
  resource: ManagedResourceIdentity | null;
  responseClassification: string | null;
  rootRevision: number;
  sealed: true;
  sourceVersion: string | null;
  transactionID: string | null;
  expectedOwnership: OwnershipExpectation | null;
};

export type RemoteVerificationState = {
  activeObservation: RemoteObservation | null;
  checkedAt: string;
  containerObservation: RemoteObservation | null;
  expectedActive: ManagedResourceIdentity | null;
  expectedContainer: ManagedContainerMapping | null;
  outcome:
    | 'ACTIVE_MISSING'
    | 'CONTAINER_MISSING'
    | 'EXACT'
    | 'OWNERSHIP_MISMATCH'
    | 'PERMISSION_REQUIRED';
  targetIdentityDigest: string;
  verificationID: string;
};

export type NoteSyncRecordV4 = {
  active: DurableActiveMapping | null;
  cleanupLedger: CleanupLedgerEntry[];
  container: ManagedContainerMapping | null;
  createdAt: string;
  mainState: MainStateV2;
  mainTransaction: MainTransactionV2 | null;
  quarantineEvidence: SealedQuarantineEvidence[];
  remoteVerification: RemoteVerificationState | null;
  requestedSource: RequestedSource | null;
  revision: number;
  schemaVersion: typeof NOTE_SYNC_SCHEMA_VERSION_V4;
  targetIdentity: TargetIdentity;
  updatedAt: string;
  uploadAssets: UploadAssetRecordV4[];
  writerCoordination: {
    mainLease: MainWriterLease | null;
  };
};

export type LegacyMetadataEvidence = {
  containerBlockID?: string;
  noteBlockIDs: Record<string, string>;
};

export type SyncedNotesRootV4 = {
  container: ManagedContainerMapping | null;
  legacy?: LegacyMetadataEvidence;
  notes: Record<string, NoteSyncRecordV4>;
  preservedLegacyFields?: Record<string, unknown>;
  rootRevision: number;
  schemaVersion: typeof NOTE_SYNC_SCHEMA_VERSION_V4;
};

export type SourceSnapshotV4 = {
  batches: readonly unknown[][];
  featurePolicy: FeaturePolicy;
  imageAssetIDsByBatch: readonly (readonly string[])[];
  imageOccurrenceCount: number;
  imageAssets: readonly {
    assetID: string;
    attachmentIdentity: string;
    attachmentKey: string;
    contentHash: string;
    contentLength: number;
    contentType: string;
    filename: string;
    sourceIdentity: string;
  }[];
  manifestDigest: string;
  sourceVersion: string;
  title: string;
};

export type MetadataStoreSnapshot = {
  legacyMigrationRequired: boolean;
  record: NoteSyncRecordV4;
  rootRevision: number;
};

export type RevisionExpectation = {
  noteRevision: number;
  rootRevision: number;
};

export type MutationAuthorization = {
  authorizedAt: string;
  intent: SealedOperationIntent;
  lease: MainWriterLease | CleanupWorkerLease;
  noteRevision: number;
  oneTimeToken: string;
  rootRevision: number;
};
