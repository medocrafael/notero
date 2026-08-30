import { z } from 'zod';

import { canonicalJSON } from './canonical';
import {
  deriveAssetID,
  deriveContainerTargetDigest,
  deriveTargetIdentityDigest,
  recomputeOperationRequestDigest,
  sameResourceIdentity,
} from './identity-v4';
import type { RuntimeClock } from './runtime-clock';
import {
  CLEANUP_STATES,
  MAIN_STATES_V2,
  NOTE_SYNC_SCHEMA_VERSION_V4,
  OPERATION_KINDS_V4,
  type CleanupLedgerEntry,
  type CandidateRecordV4,
  type ManagedResourceIdentity,
  type NoteSyncRecordV4,
  type OwnershipExpectation,
  type SealedOperationIntent,
  type RemoteObservation,
  type SyncedNotesRootV4,
  type TargetIdentity,
  type UploadAssetRecordV4,
} from './types-v4';

const MAX_BATCHES = 10_000;
const MAX_CLEANUP_ENTRIES = 512;
const MAX_EVIDENCE_ENTRIES = 64;
const MAX_UPLOAD_ASSETS = 64;

const nonEmpty = z.string().min(1);
const digest = nonEmpty;
const safeCounter = z.number().int().nonnegative().safe();
const timestamp = nonEmpty.refine(
  (value) => Number.isFinite(Date.parse(value)),
  'invalid timestamp',
);

const remoteParentSchema = z
  .object({ id: nonEmpty, type: z.enum(['block_id', 'page_id']) })
  .strict();

const targetIdentitySchema = z
  .object({
    connectionID: nonEmpty,
    databaseID: nonEmpty,
    identityType: z.literal('legacy-local').optional(),
    libraryID: safeCounter,
    noteItemKey: nonEmpty,
    pageID: nonEmpty,
    parentItemKey: nonEmpty,
    workspaceID: nonEmpty,
  })
  .strict();

const managedResourceSchema = z
  .object({
    blockID: nonEmpty,
    createdByID: nonEmpty,
    kind: z.enum(['container', 'note']),
    lastEditedTime: timestamp,
    operationMarker: nonEmpty,
    ownershipMarker: nonEmpty,
    parent: remoteParentSchema,
    targetIdentityDigest: digest,
    versionMarker: nonEmpty,
  })
  .strict();

const managedContainerSchema = managedResourceSchema.extend({
  kind: z.literal('container'),
});

const ownershipExpectationSchema = z
  .object({
    blockID: nonEmpty,
    createdByID: nonEmpty,
    kind: z.enum(['container', 'note']),
    lastEditedTime: timestamp,
    operationMarker: nonEmpty,
    ownershipMarker: nonEmpty,
    parent: remoteParentSchema,
    targetIdentityDigest: digest,
    versionMarker: nonEmpty,
  })
  .strict();

const mainLeaseSchema = z
  .object({
    acquiredAt: timestamp,
    expiresAt: timestamp,
    generation: safeCounter,
    leaseEpoch: safeCounter,
    leaseID: nonEmpty,
    noteIdentityDigest: digest,
    processSessionID: nonEmpty,
    transactionID: nonEmpty,
  })
  .strict();

const cleanupLeaseSchema = z
  .object({
    acquiredAt: timestamp,
    cleanupID: nonEmpty,
    expiresAt: timestamp,
    leaseEpoch: safeCounter,
    leaseID: nonEmpty,
    processSessionID: nonEmpty,
  })
  .strict();

const uploadReferenceSchema = z
  .object({
    assetID: digest,
    contentHash: digest,
    fileUploadID: nonEmpty,
  })
  .strict();

const createContainerDetailsSchema = z
  .object({
    expectedCreator: nonEmpty,
    isolationDeadline: timestamp,
    migrationNotice: z.boolean(),
    operationMarker: nonEmpty,
    ownershipMarker: nonEmpty,
    parent: remoteParentSchema,
    requestStartedAt: timestamp,
    resourceTargetIdentityDigest: digest,
    title: z.string().max(2_000),
    versionMarker: nonEmpty,
  })
  .strict();

const createCandidateDetailsSchema = z
  .object({
    container: managedContainerSchema,
    expectedCreator: nonEmpty,
    expectedBatchCount: safeCounter,
    expectedBlockCount: safeCounter,
    expectedImageCount: safeCounter,
    expectedImageUploadIDs: z.array(nonEmpty).max(64),
    finalTitle: z.string().max(2_000),
    imageAssetIdentities: z.array(digest).max(64),
    isolationDeadline: timestamp,
    manifestDigest: digest,
    operationMarker: nonEmpty,
    ownershipMarker: nonEmpty,
    parent: remoteParentSchema,
    previousActiveBlockID: nonEmpty.nullable(),
    requestStartedAt: timestamp,
    versionMarker: nonEmpty,
  })
  .strict();

const appendBatchDetailsSchema = z
  .object({
    batchDigest: digest,
    batchIndex: safeCounter,
    blockFingerprints: z.array(digest).max(100),
    candidate: managedResourceSchema,
    expectedTitle: z.string().max(2_000),
    expectedBlockCount: safeCounter,
    fileUploads: z.array(uploadReferenceSchema).max(32),
    precedingBlockIDs: z.array(nonEmpty).max(10_000),
  })
  .strict();

const verifyCandidateDetailsSchema = z
  .object({
    batchBlockCounts: z.array(safeCounter).max(MAX_BATCHES),
    batchDigests: z.array(digest).max(MAX_BATCHES),
    blockFingerprints: z.array(digest).max(10_000),
    candidate: managedResourceSchema,
    expectedBatchCount: safeCounter,
    expectedBlockCount: safeCounter,
    expectedImageUploadIDs: z.array(nonEmpty).max(64),
    expectedTitle: z.string().max(2_000),
    manifestDigest: digest,
    returnedBlockIDs: z.array(nonEmpty).max(10_000),
  })
  .strict();

const uploadCreateDetailsSchema = z
  .object({
    assetID: digest,
    attachmentIdentity: nonEmpty,
    attachmentKey: nonEmpty,
    contentHash: digest,
    contentLength: safeCounter,
    contentType: nonEmpty,
    expectedCreator: nonEmpty,
    filename: nonEmpty,
    isolationDeadline: timestamp,
    requestStartedAt: timestamp,
    sourceIdentity: nonEmpty,
  })
  .strict();

const uploadSendDetailsSchema = z
  .object({
    assetID: digest,
    attachmentIdentity: nonEmpty,
    attachmentKey: nonEmpty,
    contentHash: digest,
    contentLength: safeCounter,
    contentType: nonEmpty,
    createOperationID: nonEmpty,
    expectedCreator: nonEmpty,
    fileUploadID: nonEmpty,
    filename: nonEmpty,
    sourceIdentity: nonEmpty,
  })
  .strict();

const deleteBlockDetailsSchema = z
  .object({
    cleanupID: nonEmpty,
    exactBlockID: nonEmpty,
    ownership: ownershipExpectationSchema,
    reason: z.enum([
      'ABORTED_ATTEMPT',
      'REPLACED_ACTIVE',
      'SUPERSEDED_CANDIDATE',
      'UNUSED_CONTAINER',
    ]),
  })
  .strict();

const verifyLivenessDetailsSchema = z
  .object({
    active: managedResourceSchema.nullable(),
    container: managedContainerSchema.nullable(),
    force: z.boolean(),
  })
  .strict();

const operationBase = {
  createdAt: timestamp,
  generation: safeCounter,
  leaseEpoch: safeCounter,
  leaseID: nonEmpty,
  operationID: nonEmpty,
  operationSequence: safeCounter,
  owner: z.enum(['CLEANUP', 'MAIN']),
  processSessionID: nonEmpty,
  requestDigest: digest,
  sourceVersion: digest,
  status: z.enum(['EXECUTABLE', 'SEALED', 'UNCERTAIN']),
  targetIdentityDigest: digest,
  transactionID: nonEmpty,
};

const operationIntentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...operationBase,
      details: createContainerDetailsSchema,
      kind: z.literal('CREATE_CONTAINER'),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      details: createCandidateDetailsSchema,
      kind: z.literal('CREATE_CANDIDATE'),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      details: appendBatchDetailsSchema,
      kind: z.literal('APPEND_BATCH'),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      details: verifyCandidateDetailsSchema,
      kind: z.literal('VERIFY_CANDIDATE'),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      details: uploadCreateDetailsSchema,
      kind: z.literal('UPLOAD_CREATE'),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      details: uploadSendDetailsSchema,
      kind: z.literal('UPLOAD_SEND'),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      details: verifyLivenessDetailsSchema,
      kind: z.literal('VERIFY_LIVENESS'),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      details: deleteBlockDetailsSchema,
      kind: z.literal('DELETE_BLOCK'),
    })
    .strict(),
]);

const uploadAssetSchema = z
  .object({
    assetID: digest,
    attachedAt: timestamp.nullable(),
    attachmentIdentity: nonEmpty,
    attachmentKey: nonEmpty,
    contentHash: digest,
    contentLength: safeCounter,
    contentType: nonEmpty,
    createOperationID: nonEmpty,
    expiryTime: timestamp.nullable(),
    fileUploadID: nonEmpty.nullable(),
    filename: nonEmpty,
    generation: safeCounter,
    sendOperationID: nonEmpty.nullable(),
    sourceIdentity: nonEmpty,
    sourceVersion: digest,
    status: z.enum([
      'ATTACHED',
      'CREATE_INTENDED',
      'CREATE_UNCERTAIN',
      'CREATED_UNSENT',
      'EXPIRED',
      'FAILED',
      'SEND_INTENDED',
      'SEND_UNCERTAIN',
      'UPLOADED',
    ]),
    targetIdentityDigest: digest,
    transactionID: nonEmpty,
  })
  .strict();

const remoteObservationSchema = z
  .object({
    attachedUploadIDs: z.array(nonEmpty).max(32),
    blockFingerprints: z.array(digest).max(10_000),
    deletionProof: z
      .object({
        archived: z.literal(true),
        exactBlockID: nonEmpty,
        inTrash: z.literal(true),
      })
      .strict()
      .nullable(),
    generation: safeCounter,
    observedAt: timestamp,
    operationID: nonEmpty,
    outcome: z.enum([
      'APPENDED',
      'CREATED',
      'DELETED',
      'EXACT',
      'MISMATCH',
      'NOT_FOUND',
      'PERMISSION_DENIED',
      'UNKNOWN',
      'UPLOADED',
      'VERIFIED',
    ]),
    remoteResource: managedResourceSchema.nullable(),
    requestDigest: digest,
    responseClassification: nonEmpty,
    returnedBlockIDs: z.array(nonEmpty).max(10_000),
    sourceVersion: digest,
    targetIdentityDigest: digest,
    transactionID: nonEmpty,
    upload: uploadAssetSchema.nullable(),
  })
  .strict();

const batchEvidenceSchema = z
  .object({
    batchDigest: digest,
    blockFingerprints: z.array(digest).max(100),
    completedAt: timestamp,
    imageUploadIDs: z.array(nonEmpty).max(32),
    index: safeCounter,
    parentBlockID: nonEmpty,
    returnedBlockIDs: z.array(nonEmpty).max(100),
  })
  .strict();

const completionEvidenceSchema = z
  .object({
    batchDigests: z.array(digest).max(MAX_BATCHES),
    blockFingerprints: z.array(digest).max(10_000),
    candidateBlockID: nonEmpty,
    completedBatchCount: safeCounter,
    expectedBatchCount: safeCounter,
    expectedBlockCount: safeCounter,
    expectedImageCount: safeCounter,
    imageAssetIdentities: z.array(digest).max(64),
    imageUploadIDs: z.array(nonEmpty).max(64),
    manifestDigest: digest,
    returnedBlockIDs: z.array(nonEmpty).max(10_000),
    sourceVersion: digest,
    verificationIntent: operationIntentSchema.refine(
      (intent) => intent.kind === 'VERIFY_CANDIDATE',
    ),
    verifiedAt: timestamp,
  })
  .strict();

const candidateSchema = z
  .object({
    batchEvidence: z.array(batchEvidenceSchema).max(MAX_BATCHES),
    completionEvidence: completionEvidenceSchema.nullable(),
    container: managedContainerSchema,
    expectedBatchCount: safeCounter,
    expectedBlockCount: safeCounter,
    expectedImageCount: safeCounter,
    generation: safeCounter,
    imageAssetIdentities: z.array(digest).max(64),
    manifestDigest: digest,
    previousActiveBlockID: nonEmpty.nullable(),
    resource: managedResourceSchema,
    sourceVersion: digest,
    status: z.enum(['CREATED', 'DURABLE', 'WRITING']),
    targetIdentityDigest: digest,
    transactionID: nonEmpty,
  })
  .strict();

const activeSchema = z
  .object({
    block: managedResourceSchema,
    committedAt: timestamp,
    completionEvidence: completionEvidenceSchema,
    container: managedContainerSchema,
    featurePolicy: z.enum(['embedded-images-v1', 'text-only-v1']),
    generation: safeCounter,
    imageAssetIdentities: z.array(digest).max(64),
    manifestDigest: digest,
    sourceVersion: digest,
    targetIdentityDigest: digest,
    transactionID: nonEmpty,
  })
  .strict();

const requestedSourceSchema = z
  .object({
    featurePolicy: z.enum(['embedded-images-v1', 'text-only-v1']),
    manifestDigest: digest,
    observedAt: timestamp,
    sourceVersion: digest,
  })
  .strict();

const runHaltSchema = z
  .object({
    classification: z.enum([
      'AUTH_REQUIRED',
      'PERMISSION_REQUIRED',
      'TRANSIENT_BUDGET_EXHAUSTED',
      'VALIDATION_FAILED',
    ]),
    haltedAt: timestamp,
    operationID: nonEmpty.nullable(),
    proof: z.enum(['NOT_EXECUTED', 'UNKNOWN_AFTER_WRITE']),
    redactedMessage: nonEmpty,
  })
  .strict();

const mainTransactionSchema = z
  .object({
    candidate: candidateSchema.nullable(),
    featurePolicy: z.enum(['embedded-images-v1', 'text-only-v1']),
    generation: safeCounter,
    operationIntent: operationIntentSchema.nullable(),
    operationSequence: safeCounter,
    purpose: z.enum(['LIVENESS', 'SYNC']),
    runHalt: runHaltSchema.nullable(),
    sourceManifestDigest: digest,
    sourceTitle: z.string().max(2_000),
    targetIdentityDigest: digest,
    transactionID: nonEmpty,
    transactionSourceVersion: digest,
  })
  .strict();

const cleanupEntrySchema = z
  .object({
    attemptCount: safeCounter,
    cleanupID: nonEmpty,
    createdAt: timestamp,
    deleteIntent: operationIntentSchema.nullable(),
    generation: safeCounter,
    lastObservation: remoteObservationSchema.nullable(),
    nextRetryAt: timestamp.nullable(),
    ownership: ownershipExpectationSchema,
    quarantineEvidenceID: nonEmpty.nullable(),
    reason: z.enum([
      'ABORTED_ATTEMPT',
      'REPLACED_ACTIVE',
      'SUPERSEDED_CANDIDATE',
      'UNUSED_CONTAINER',
    ]),
    resource: managedResourceSchema,
    sourceVersion: digest,
    state: z.enum(CLEANUP_STATES),
    transactionID: nonEmpty,
    updatedAt: timestamp,
    workerLease: cleanupLeaseSchema.nullable(),
  })
  .strict();

const quarantineEvidenceSchema = z
  .object({
    evidenceID: nonEmpty,
    expectedOwnership: ownershipExpectationSchema.nullable(),
    firstSeenAt: timestamp,
    generation: safeCounter.nullable(),
    lastObservation: remoteObservationSchema.nullable(),
    lastSeenAt: timestamp,
    noteRevision: safeCounter,
    origin: z.enum(['CLEANUP', 'LIVENESS', 'MAIN', 'SCHEMA']),
    originalOperationIntent: operationIntentSchema.nullable(),
    reasonCode: nonEmpty,
    requiredRepair: z.enum([
      'NONE',
      'RECONNECT_NOTION',
      'RESET_CORRUPT_METADATA',
      'RESTORE_CAPABILITY',
      'VERIFY_REMOTE_RESOURCE',
    ]),
    resource: managedResourceSchema.nullable(),
    responseClassification: nonEmpty.nullable(),
    rootRevision: safeCounter,
    sealed: z.literal(true),
    sourceVersion: digest.nullable(),
    transactionID: nonEmpty.nullable(),
  })
  .strict();

const remoteVerificationSchema = z
  .object({
    activeObservation: remoteObservationSchema.nullable(),
    checkedAt: timestamp,
    containerObservation: remoteObservationSchema.nullable(),
    expectedActive: managedResourceSchema.nullable(),
    expectedContainer: managedContainerSchema.nullable(),
    outcome: z.enum([
      'ACTIVE_MISSING',
      'CONTAINER_MISSING',
      'EXACT',
      'OWNERSHIP_MISMATCH',
      'PERMISSION_REQUIRED',
    ]),
    targetIdentityDigest: digest,
    verificationID: nonEmpty,
  })
  .strict();

export const noteSyncRecordV4Schema = z
  .object({
    active: activeSchema.nullable(),
    cleanupLedger: z.array(cleanupEntrySchema).max(MAX_CLEANUP_ENTRIES),
    container: managedContainerSchema.nullable(),
    createdAt: timestamp,
    mainState: z.enum(MAIN_STATES_V2),
    mainTransaction: mainTransactionSchema.nullable(),
    quarantineEvidence: z
      .array(quarantineEvidenceSchema)
      .max(MAX_EVIDENCE_ENTRIES),
    remoteVerification: remoteVerificationSchema.nullable(),
    requestedSource: requestedSourceSchema.nullable(),
    revision: safeCounter,
    schemaVersion: z.literal(NOTE_SYNC_SCHEMA_VERSION_V4),
    targetIdentity: targetIdentitySchema,
    updatedAt: timestamp,
    uploadAssets: z.array(uploadAssetSchema).max(MAX_UPLOAD_ASSETS),
    writerCoordination: z
      .object({ mainLease: mainLeaseSchema.nullable() })
      .strict(),
  })
  .strict();

const legacyEvidenceSchema = z
  .object({
    containerBlockID: nonEmpty.optional(),
    noteBlockIDs: z.record(z.string(), nonEmpty),
  })
  .strict();

export const syncedNotesRootV4Schema = z
  .object({
    container: managedContainerSchema.nullable(),
    legacy: legacyEvidenceSchema.optional(),
    notes: z.record(z.string(), noteSyncRecordV4Schema),
    preservedLegacyFields: z.record(z.string(), z.unknown()).optional(),
    rootRevision: safeCounter,
    schemaVersion: z.literal(NOTE_SYNC_SCHEMA_VERSION_V4),
  })
  .strict();

export type TransactionInvariantCode =
  | 'SCHEMA'
  | 'V1'
  | 'V2'
  | 'V3'
  | 'V4'
  | 'V5'
  | 'V6'
  | 'V7'
  | 'V8'
  | 'V9'
  | 'V10'
  | 'V11'
  | 'V12'
  | 'V13'
  | 'V14'
  | 'V15'
  | 'V16'
  | 'V17'
  | 'V18';

export type TransactionInvariantIssue = {
  code: TransactionInvariantCode;
  message: string;
  path: string;
};

export type TransactionValidationContext = {
  acceptedObservation?: RemoteObservation;
  clock?: RuntimeClock;
  committedCandidate?: CandidateRecordV4;
  expectedTargetIdentity?: TargetIdentity;
  previousRevision?: { noteRevision: number; rootRevision: number };
  requireCurrentAuthorization?: boolean;
  rootRevision?: number;
};

export type TransactionValidationResult =
  | { issues: []; record: NoteSyncRecordV4; valid: true }
  | { issues: TransactionInvariantIssue[]; valid: false };

export class TransactionInvariantError extends Error {
  public readonly name = 'TransactionInvariantError';

  public constructor(public readonly issues: TransactionInvariantIssue[]) {
    super(issues.map(({ code, message }) => `${code}: ${message}`).join('; '));
  }
}

function equal(left: unknown, right: unknown): boolean {
  return canonicalJSON(left) === canonicalJSON(right);
}

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

export function ownershipFromResource(
  resource: ManagedResourceIdentity,
): OwnershipExpectation {
  return {
    blockID: resource.blockID,
    createdByID: resource.createdByID,
    kind: resource.kind,
    lastEditedTime: resource.lastEditedTime,
    operationMarker: resource.operationMarker,
    ownershipMarker: resource.ownershipMarker,
    parent: resource.parent,
    targetIdentityDigest: resource.targetIdentityDigest,
    versionMarker: resource.versionMarker,
  };
}

function uploadDetailsMatch(
  asset: UploadAssetRecordV4,
  intent: Extract<
    SealedOperationIntent,
    { kind: 'UPLOAD_CREATE' | 'UPLOAD_SEND' }
  >,
): boolean {
  const details = intent.details;
  const commonMatches =
    asset.assetID === details.assetID &&
    asset.attachmentIdentity === details.attachmentIdentity &&
    asset.attachmentKey === details.attachmentKey &&
    asset.contentHash === details.contentHash &&
    asset.contentLength === details.contentLength &&
    asset.contentType === details.contentType &&
    asset.filename === details.filename &&
    asset.sourceIdentity === details.sourceIdentity;
  if (!commonMatches || intent.kind === 'UPLOAD_CREATE') return commonMatches;
  return (
    asset.createOperationID === intent.details.createOperationID &&
    asset.fileUploadID === intent.details.fileUploadID
  );
}

/**
 * The only cross-field validator for persisted note transactions. Callers use
 * this same entry point at load, persist, authorization, commit, cleanup, and
 * observation acceptance boundaries.
 */
export function validateTransactionRecord(
  value: unknown,
  context: TransactionValidationContext = {},
): TransactionValidationResult {
  const parsed = noteSyncRecordV4Schema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      issues: [
        {
          code: 'SCHEMA',
          message: first?.message || 'Invalid schema v4 note record',
          path: first?.path.join('.') || '<root>',
        },
      ],
      valid: false,
    };
  }
  const record = parsed.data as NoteSyncRecordV4;
  const issues: TransactionInvariantIssue[] = [];
  const add = (code: TransactionInvariantCode, path: string, message: string) =>
    issues.push({ code, message, path });
  const targetDigest = deriveTargetIdentityDigest(record.targetIdentity);
  const containerDigest = deriveContainerTargetDigest(record.targetIdentity);
  const transaction = record.mainTransaction;

  // V1 — schema, target identity, and every derived target digest.
  if (
    context.expectedTargetIdentity &&
    !equal(context.expectedTargetIdentity, record.targetIdentity)
  ) {
    add('V1', 'targetIdentity', 'record belongs to another target identity');
  }
  const checkResourceTarget = (
    resource: ManagedResourceIdentity | null,
    path: string,
  ) => {
    if (!resource) return;
    const expected =
      resource.kind === 'container' ? containerDigest : targetDigest;
    if (resource.targetIdentityDigest !== expected) {
      add(
        'V1',
        `${path}.targetIdentityDigest`,
        'resource target digest differs',
      );
    }
  };
  checkResourceTarget(record.container, 'container');
  if (
    transaction?.targetIdentityDigest !== undefined &&
    transaction.targetIdentityDigest !== targetDigest
  ) {
    add(
      'V1',
      'mainTransaction.targetIdentityDigest',
      'transaction target digest differs',
    );
  }
  checkResourceTarget(
    transaction?.candidate?.resource ?? null,
    'mainTransaction.candidate.resource',
  );
  checkResourceTarget(
    transaction?.candidate?.container ?? null,
    'mainTransaction.candidate.container',
  );
  checkResourceTarget(record.active?.block ?? null, 'active.block');
  checkResourceTarget(record.active?.container ?? null, 'active.container');
  if (record.active && record.active.targetIdentityDigest !== targetDigest) {
    add('V1', 'active.targetIdentityDigest', 'active target digest differs');
  }
  for (const [index, asset] of record.uploadAssets.entries()) {
    if (asset.targetIdentityDigest !== targetDigest) {
      add(
        'V1',
        `uploadAssets.${index}.targetIdentityDigest`,
        'upload target digest differs',
      );
    }
  }

  // V2 — IDLE has no main transaction; every executing state has one.
  if (record.mainState === 'IDLE' && transaction) {
    add('V2', 'mainTransaction', 'IDLE must not contain a main transaction');
  }
  if (!['IDLE', 'QUARANTINED'].includes(record.mainState) && !transaction) {
    add(
      'V2',
      'mainTransaction',
      `${record.mainState} requires one transaction`,
    );
  }

  // V3 — main state and transaction identity are inseparable.
  if (transaction?.candidate) {
    const candidate = transaction.candidate;
    if (
      candidate.transactionID !== transaction.transactionID ||
      candidate.generation !== transaction.generation ||
      candidate.sourceVersion !== transaction.transactionSourceVersion
    ) {
      add(
        'V3',
        'mainTransaction.candidate',
        'candidate transaction identity differs',
      );
    }
  }

  // V4 — intent transaction, source, target, sequence, lease, and request.
  const validateRequestDigest = (
    intent: SealedOperationIntent,
    path: string,
  ) => {
    if (recomputeOperationRequestDigest(intent) !== intent.requestDigest) {
      add(
        'V4',
        `${path}.requestDigest`,
        'operation request digest cannot be recomputed',
      );
    }
  };
  if (transaction?.operationIntent) {
    const intent = transaction.operationIntent;
    validateRequestDigest(intent, 'mainTransaction.operationIntent');
    if (
      intent.owner !== 'MAIN' ||
      intent.transactionID !== transaction.transactionID ||
      intent.generation !== transaction.generation ||
      intent.sourceVersion !== transaction.transactionSourceVersion ||
      intent.targetIdentityDigest !== targetDigest ||
      intent.operationSequence !== transaction.operationSequence
    ) {
      add(
        'V4',
        'mainTransaction.operationIntent',
        'main intent identity differs',
      );
    }
    const lease = record.writerCoordination.mainLease;
    if (
      !lease ||
      intent.leaseID !== lease.leaseID ||
      intent.leaseEpoch !== lease.leaseEpoch ||
      intent.processSessionID !== lease.processSessionID
    ) {
      add('V4', 'writerCoordination.mainLease', 'main intent lease differs');
    }
  }
  if (context.acceptedObservation) {
    const observation = context.acceptedObservation;
    const matchingIntent = [
      transaction?.operationIntent ?? null,
      ...record.cleanupLedger.map(({ deleteIntent }) => deleteIntent),
    ].find((intent) => intent?.operationID === observation.operationID);
    if (
      !matchingIntent ||
      observation.requestDigest !== matchingIntent.requestDigest ||
      observation.transactionID !== matchingIntent.transactionID ||
      observation.generation !== matchingIntent.generation ||
      observation.sourceVersion !== matchingIntent.sourceVersion ||
      observation.targetIdentityDigest !== matchingIntent.targetIdentityDigest
    ) {
      add(
        'V4',
        'acceptedObservation',
        'remote observation does not match a durable operation intent',
      );
    }
    checkResourceTarget(
      observation.remoteResource,
      'acceptedObservation.remoteResource',
    );
    if (
      (observation.outcome === 'DELETED') !==
        Boolean(observation.deletionProof) ||
      (observation.deletionProof &&
        observation.deletionProof.exactBlockID !==
          observation.remoteResource?.blockID)
    ) {
      add(
        'V12',
        'acceptedObservation.deletionProof',
        'delete observation lacks exact in_trash proof',
      );
    }
  }

  // V5 — operation details point only at the current valid resource.
  const mainIntent = transaction?.operationIntent;
  if (mainIntent) {
    switch (mainIntent.kind) {
      case 'CREATE_CONTAINER':
        if (
          record.container ||
          mainIntent.details.parent.type !== 'page_id' ||
          mainIntent.details.parent.id !== record.targetIdentity.pageID ||
          mainIntent.details.resourceTargetIdentityDigest !== containerDigest
        ) {
          add(
            'V5',
            'mainTransaction.operationIntent.details',
            'container create target is not current',
          );
        }
        break;
      case 'CREATE_CANDIDATE':
        if (
          !record.container ||
          !sameResourceIdentity(
            mainIntent.details.container,
            record.container,
          ) ||
          mainIntent.details.parent.type !== 'block_id' ||
          mainIntent.details.parent.id !== record.container.blockID ||
          transaction?.candidate
        ) {
          add(
            'V5',
            'mainTransaction.operationIntent.details',
            'candidate create target is not current',
          );
        }
        break;
      case 'APPEND_BATCH':
        if (
          !transaction?.candidate ||
          !sameResourceIdentity(
            mainIntent.details.candidate,
            transaction.candidate.resource,
          ) ||
          mainIntent.details.batchIndex !==
            transaction.candidate.batchEvidence.length ||
          !equal(
            mainIntent.details.precedingBlockIDs,
            transaction.candidate.batchEvidence.flatMap(
              ({ returnedBlockIDs }) => returnedBlockIDs,
            ),
          )
        ) {
          add(
            'V5',
            'mainTransaction.operationIntent.details',
            'append target or batch index differs',
          );
        }
        break;
      case 'VERIFY_CANDIDATE':
        if (
          !transaction?.candidate ||
          !sameResourceIdentity(
            mainIntent.details.candidate,
            transaction.candidate.resource,
          ) ||
          !equal(
            mainIntent.details.batchBlockCounts,
            transaction.candidate.batchEvidence.map(
              ({ returnedBlockIDs }) => returnedBlockIDs.length,
            ),
          )
        ) {
          add(
            'V5',
            'mainTransaction.operationIntent.details',
            'verification candidate differs',
          );
        }
        break;
      case 'UPLOAD_CREATE':
      case 'UPLOAD_SEND': {
        const asset = record.uploadAssets.find(
          ({ assetID }) => assetID === mainIntent.details.assetID,
        );
        if (!asset || !uploadDetailsMatch(asset, mainIntent)) {
          add(
            'V5',
            'mainTransaction.operationIntent.details',
            'upload intent differs from its asset',
          );
        }
        break;
      }
      case 'VERIFY_LIVENESS':
        if (
          !sameResourceIdentity(
            mainIntent.details.active,
            record.active?.block ?? null,
          ) ||
          !sameResourceIdentity(mainIntent.details.container, record.container)
        ) {
          add(
            'V5',
            'mainTransaction.operationIntent.details',
            'liveness target differs',
          );
        }
        break;
      case 'DELETE_BLOCK':
        add(
          'V5',
          'mainTransaction.operationIntent.kind',
          'delete belongs only to cleanup',
        );
        break;
    }
  }

  // V6 — candidate identity and canonical container are fully coupled.
  const candidate = transaction?.candidate;
  if (candidate) {
    if (
      candidate.targetIdentityDigest !== targetDigest ||
      !record.container ||
      !sameResourceIdentity(candidate.container, record.container) ||
      candidate.resource.parent.type !== 'block_id' ||
      candidate.resource.parent.id !== record.container.blockID
    ) {
      add(
        'V6',
        'mainTransaction.candidate',
        'candidate target or container differs',
      );
    }
    if (
      candidate.resource.kind !== 'note' ||
      candidate.resource.targetIdentityDigest !== targetDigest
    ) {
      add(
        'V6',
        'mainTransaction.candidate.resource',
        'candidate ownership marker scope differs',
      );
    }
  }

  // V7 — candidate status follows the seven-state main machine.
  if (record.mainState === 'CANDIDATE_CREATING' && candidate) {
    add(
      'V7',
      'mainTransaction.candidate',
      'candidate creating requires no candidate yet',
    );
  }
  if (record.mainState === 'CANDIDATE_WRITING') {
    if (
      !candidate ||
      !['CREATED', 'WRITING'].includes(candidate.status) ||
      candidate.completionEvidence
    ) {
      add(
        'V7',
        'mainTransaction.candidate',
        'candidate writing requires incomplete write evidence',
      );
    }
  }
  if (record.mainState === 'CANDIDATE_VERIFYING') {
    if (
      !candidate ||
      candidate.status !== 'WRITING' ||
      candidate.completionEvidence ||
      candidate.batchEvidence.length !== candidate.expectedBatchCount ||
      candidate.batchEvidence.flatMap(
        ({ returnedBlockIDs }) => returnedBlockIDs,
      ).length !== candidate.expectedBlockCount
    ) {
      add(
        'V7',
        'mainTransaction.candidate',
        'candidate verifying requires complete batches but no durability proof',
      );
    }
  }
  if (record.mainState === 'CANDIDATE_DURABLE') {
    if (
      !candidate ||
      candidate.status !== 'DURABLE' ||
      !candidate.completionEvidence
    ) {
      add(
        'V7',
        'mainTransaction.candidate',
        'durable state requires durable candidate evidence',
      );
    }
  }

  // V8 — completed batches are contiguous, bounded, unique, and parented.
  if (candidate) {
    const indexes = candidate.batchEvidence.map(({ index }) => index);
    if (
      indexes.some((index, position) => index !== position) ||
      candidate.batchEvidence.length > candidate.expectedBatchCount
    ) {
      add(
        'V8',
        'mainTransaction.candidate.batchEvidence',
        'batch indexes are not contiguous and bounded',
      );
    }
    const returned = candidate.batchEvidence.flatMap(
      ({ returnedBlockIDs }) => returnedBlockIDs,
    );
    const fingerprints = candidate.batchEvidence.flatMap(
      ({ blockFingerprints }) => blockFingerprints,
    );
    if (duplicate(returned) || duplicate(fingerprints)) {
      add(
        'V8',
        'mainTransaction.candidate.batchEvidence',
        'batch block identities are not unique',
      );
    }
    if (
      candidate.batchEvidence.some(
        ({ parentBlockID }) => parentBlockID !== candidate.resource.blockID,
      )
    ) {
      add(
        'V8',
        'mainTransaction.candidate.batchEvidence',
        'batch parent differs from candidate',
      );
    }
  }

  // V9 — completion is a deterministic proof of this exact candidate.
  if (candidate?.completionEvidence) {
    const completion = candidate.completionEvidence;
    const batches = candidate.batchEvidence;
    const verifyIntent = completion.verificationIntent;
    validateRequestDigest(
      verifyIntent,
      'mainTransaction.candidate.completionEvidence.verificationIntent',
    );
    if (
      completion.candidateBlockID !== candidate.resource.blockID ||
      completion.manifestDigest !== candidate.manifestDigest ||
      completion.sourceVersion !== candidate.sourceVersion ||
      completion.expectedBatchCount !== candidate.expectedBatchCount ||
      completion.completedBatchCount !== batches.length ||
      completion.expectedBlockCount !== candidate.expectedBlockCount ||
      completion.expectedImageCount !== candidate.expectedImageCount ||
      !equal(
        completion.batchDigests,
        batches.map(({ batchDigest }) => batchDigest),
      ) ||
      !equal(
        completion.returnedBlockIDs,
        batches.flatMap(({ returnedBlockIDs }) => returnedBlockIDs),
      ) ||
      !equal(
        completion.blockFingerprints,
        batches.flatMap(({ blockFingerprints }) => blockFingerprints),
      ) ||
      !equal(completion.imageAssetIdentities, candidate.imageAssetIdentities) ||
      verifyIntent.kind !== 'VERIFY_CANDIDATE' ||
      verifyIntent.status !== 'SEALED' ||
      verifyIntent.owner !== 'MAIN' ||
      verifyIntent.transactionID !== candidate.transactionID ||
      verifyIntent.generation !== candidate.generation ||
      verifyIntent.sourceVersion !== candidate.sourceVersion ||
      verifyIntent.targetIdentityDigest !== candidate.targetIdentityDigest ||
      !sameResourceIdentity(
        verifyIntent.details.candidate,
        candidate.resource,
      ) ||
      !equal(verifyIntent.details.batchDigests, completion.batchDigests) ||
      !equal(
        verifyIntent.details.batchBlockCounts,
        batches.map(({ returnedBlockIDs }) => returnedBlockIDs.length),
      ) ||
      !equal(
        verifyIntent.details.blockFingerprints,
        completion.blockFingerprints,
      ) ||
      !equal(
        verifyIntent.details.returnedBlockIDs,
        completion.returnedBlockIDs,
      ) ||
      !equal(
        verifyIntent.details.expectedImageUploadIDs,
        completion.imageUploadIDs,
      )
    ) {
      add(
        'V9',
        'mainTransaction.candidate.completionEvidence',
        'completion proof is not bound to the candidate',
      );
    }
  }

  // V10 — authoritative active is internally durable and, during commit, is
  // exactly derived from the current durable candidate.
  if (record.active) {
    const active = record.active;
    if (
      active.block.kind !== 'note' ||
      active.block.blockID !== active.completionEvidence.candidateBlockID ||
      active.targetIdentityDigest !== targetDigest ||
      active.manifestDigest !== active.completionEvidence.manifestDigest ||
      active.sourceVersion !== active.completionEvidence.sourceVersion ||
      active.transactionID !==
        active.completionEvidence.verificationIntent.transactionID ||
      active.generation !==
        active.completionEvidence.verificationIntent.generation ||
      active.sourceVersion !==
        active.completionEvidence.verificationIntent.sourceVersion
    ) {
      add('V10', 'active', 'active is not a self-consistent durable mapping');
    }
    if (
      candidate?.status === 'DURABLE' &&
      active.transactionID === candidate.transactionID &&
      (!sameResourceIdentity(active.block, candidate.resource) ||
        !equal(active.completionEvidence, candidate.completionEvidence))
    ) {
      add('V10', 'active', 'active was not derived from its durable candidate');
    }
  }
  if (
    context.committedCandidate &&
    (!record.active ||
      context.committedCandidate.status !== 'DURABLE' ||
      !sameResourceIdentity(
        record.active.block,
        context.committedCandidate.resource,
      ) ||
      !equal(
        record.active.completionEvidence,
        context.committedCandidate.completionEvidence,
      ))
  ) {
    add(
      'V10',
      'active',
      'active commit differs from the supplied durable candidate',
    );
  }

  // V11 — cleanup never owns the authoritative active; remote IDs are unique.
  const executableCleanup = record.cleanupLedger.filter(
    ({ state }) => state !== 'CONFIRMED',
  );
  if (
    record.active &&
    executableCleanup.some(
      ({ resource }) => resource.blockID === record.active?.block.blockID,
    )
  ) {
    add(
      'V11',
      'cleanupLedger',
      'cleanup contains the authoritative active block',
    );
  }
  if (duplicate(executableCleanup.map(({ resource }) => resource.blockID))) {
    add(
      'V11',
      'cleanupLedger',
      'remote cleanup resource has multiple live owners',
    );
  }

  // V12 — cleanup identity, ownership, intent, lease, and observation bind.
  for (const [index, cleanup] of record.cleanupLedger.entries()) {
    const path = `cleanupLedger.${index}`;
    if (!equal(cleanup.ownership, ownershipFromResource(cleanup.resource))) {
      add(
        'V12',
        `${path}.ownership`,
        'cleanup ownership differs from resource',
      );
    }
    const intent = cleanup.deleteIntent;
    if (intent) {
      validateRequestDigest(intent, `${path}.deleteIntent`);
      if (
        intent.kind !== 'DELETE_BLOCK' ||
        intent.owner !== 'CLEANUP' ||
        intent.transactionID !== cleanup.transactionID ||
        intent.generation !== cleanup.generation ||
        intent.sourceVersion !== cleanup.sourceVersion ||
        intent.targetIdentityDigest !== cleanup.resource.targetIdentityDigest ||
        intent.details.cleanupID !== cleanup.cleanupID ||
        intent.details.exactBlockID !== cleanup.resource.blockID ||
        intent.details.reason !== cleanup.reason ||
        !equal(intent.details.ownership, cleanup.ownership)
      ) {
        add('V12', `${path}.deleteIntent`, 'cleanup delete intent differs');
      }
      const lease = cleanup.workerLease;
      if (
        !lease ||
        lease.cleanupID !== cleanup.cleanupID ||
        lease.leaseID !== intent.leaseID ||
        lease.leaseEpoch !== intent.leaseEpoch ||
        lease.processSessionID !== intent.processSessionID
      ) {
        add('V12', `${path}.workerLease`, 'cleanup lease differs from intent');
      }
    }
    if (cleanup.state === 'PENDING' && intent) {
      add(
        'V12',
        `${path}.deleteIntent`,
        'pending cleanup cannot have delete intent',
      );
    }
    if (
      cleanup.state === 'DELETE_INTENDED' &&
      (!intent || intent.status !== 'EXECUTABLE')
    ) {
      add(
        'V12',
        `${path}.deleteIntent`,
        'delete-intended cleanup requires executable intent',
      );
    }
    if (
      cleanup.state === 'DELETE_UNCERTAIN' &&
      (!intent || intent.status !== 'UNCERTAIN')
    ) {
      add(
        'V12',
        `${path}.deleteIntent`,
        'uncertain cleanup requires uncertain intent',
      );
    }
    if (cleanup.state === 'CONFIRMED' && intent) {
      add(
        'V12',
        `${path}.deleteIntent`,
        'confirmed cleanup cannot retain executable intent',
      );
    }
    if (
      cleanup.state === 'CONFIRMED' &&
      (cleanup.lastObservation?.outcome !== 'DELETED' ||
        cleanup.lastObservation.deletionProof?.exactBlockID !==
          cleanup.resource.blockID)
    ) {
      add(
        'V12',
        `${path}.lastObservation`,
        'confirmed cleanup lacks exact in_trash deletion proof',
      );
    }
    if (
      cleanup.state === 'DELETE_UNCERTAIN' &&
      (!cleanup.nextRetryAt || intent?.status !== 'UNCERTAIN')
    ) {
      add(
        'V12',
        path,
        'uncertain cleanup requires a retry deadline and uncertain intent',
      );
    }
    if (
      cleanup.state === 'QUARANTINED' &&
      (!cleanup.quarantineEvidenceID || intent?.status !== 'SEALED')
    ) {
      add(
        'V12',
        path,
        'quarantined cleanup requires sealed intent and linked evidence',
      );
    }
    if (cleanup.lastObservation && intent) {
      const observation = cleanup.lastObservation;
      if (
        observation.operationID !== intent.operationID ||
        observation.requestDigest !== intent.requestDigest ||
        observation.transactionID !== intent.transactionID ||
        observation.generation !== intent.generation ||
        observation.sourceVersion !== intent.sourceVersion ||
        observation.targetIdentityDigest !== intent.targetIdentityDigest
      ) {
        add(
          'V12',
          `${path}.lastObservation`,
          'cleanup observation differs from intent',
        );
      }
    }
  }
  if (duplicate(record.cleanupLedger.map(({ cleanupID }) => cleanupID))) {
    add('V12', 'cleanupLedger', 'cleanup IDs are not unique');
  }

  // V13 — upload content identity and lifecycle are internally consistent.
  for (const [index, asset] of record.uploadAssets.entries()) {
    const path = `uploadAssets.${index}`;
    if (asset.assetID !== deriveAssetID(asset)) {
      add(
        'V13',
        `${path}.assetID`,
        'upload asset digest differs from source bytes identity',
      );
    }
    if (
      asset.status === 'ATTACHED' &&
      (!asset.fileUploadID || !asset.attachedAt || asset.expiryTime !== null)
    ) {
      add(
        'V13',
        path,
        'attached upload requires permanent attachment evidence',
      );
    }
    if (
      [
        'CREATED_UNSENT',
        'SEND_INTENDED',
        'SEND_UNCERTAIN',
        'UPLOADED',
      ].includes(asset.status) &&
      !asset.fileUploadID
    ) {
      add(
        'V13',
        `${path}.fileUploadID`,
        'upload lifecycle requires a File Upload ID',
      );
    }
    if (
      ['SEND_INTENDED', 'SEND_UNCERTAIN'].includes(asset.status) &&
      !asset.sendOperationID
    ) {
      add(
        'V13',
        `${path}.sendOperationID`,
        'send lifecycle requires its operation ID',
      );
    }
  }
  if (duplicate(record.uploadAssets.map(({ assetID }) => assetID))) {
    add('V13', 'uploadAssets', 'upload asset IDs are not unique');
  }
  if (
    transaction?.featurePolicy === 'text-only-v1' &&
    (['UPLOAD_CREATE', 'UPLOAD_SEND'].includes(
      transaction.operationIntent?.kind ?? '',
    ) ||
      record.uploadAssets.some(
        (asset) =>
          asset.transactionID === transaction.transactionID &&
          asset.generation === transaction.generation,
      ))
  ) {
    add(
      'V13',
      'mainTransaction.featurePolicy',
      'feature OFF forbids new upload work',
    );
  }

  // V14 — repeated versions must carry exactly the same immutable source data.
  const requested = record.requestedSource;
  if (
    requested &&
    transaction &&
    requested.sourceVersion === transaction.transactionSourceVersion
  ) {
    if (
      requested.manifestDigest !== transaction.sourceManifestDigest ||
      requested.featurePolicy !== transaction.featurePolicy
    ) {
      add(
        'V14',
        'requestedSource',
        'requested and transaction versions conflict',
      );
    }
  }
  if (
    requested &&
    record.active &&
    requested.sourceVersion === record.active.sourceVersion
  ) {
    if (
      requested.manifestDigest !== record.active.manifestDigest ||
      requested.featurePolicy !== record.active.featurePolicy
    ) {
      add('V14', 'requestedSource', 'requested and active versions conflict');
    }
  }
  if (
    transaction?.purpose === 'SYNC' &&
    record.active?.sourceVersion === transaction.transactionSourceVersion &&
    (!record.remoteVerification ||
      record.remoteVerification.outcome === 'EXACT')
  ) {
    add(
      'V14',
      'mainTransaction.transactionSourceVersion',
      'unchanged source cannot start another sync transaction',
    );
  }

  // V15 — quarantine evidence is permanently sealed and never authorizes.
  for (const [index, evidence] of record.quarantineEvidence.entries()) {
    if (
      !evidence.sealed ||
      evidence.originalOperationIntent?.status === 'EXECUTABLE' ||
      (evidence.originalOperationIntent &&
        recomputeOperationRequestDigest(evidence.originalOperationIntent) !==
          evidence.originalOperationIntent.requestDigest)
    ) {
      add(
        'V15',
        `quarantineEvidence.${index}`,
        'quarantine evidence is not sealed',
      );
    }
  }
  if (
    record.mainState === 'QUARANTINED' &&
    (!record.quarantineEvidence.length ||
      transaction?.operationIntent?.status === 'EXECUTABLE')
  ) {
    add(
      'V15',
      'quarantineEvidence',
      'main quarantine must preserve sealed evidence',
    );
  }

  // V16 — an executable main intent has exact structural and live lease proof.
  if (transaction?.operationIntent?.status === 'EXECUTABLE') {
    const lease = record.writerCoordination.mainLease;
    if (
      !lease ||
      lease.transactionID !== transaction.transactionID ||
      lease.generation !== transaction.generation ||
      lease.noteIdentityDigest !== targetDigest
    ) {
      add(
        'V16',
        'writerCoordination.mainLease',
        'executable intent lacks exact main lease',
      );
    }
    if (
      context.requireCurrentAuthorization &&
      (!context.clock ||
        !lease ||
        context.clock.compare(lease.expiresAt, context.clock.nowISOString()) <=
          0)
    ) {
      add(
        'V16',
        'writerCoordination.mainLease.expiresAt',
        'executable intent lease is expired or unverifiable',
      );
    }
  }
  for (const [index, cleanup] of record.cleanupLedger.entries()) {
    if (
      cleanup.deleteIntent?.status === 'EXECUTABLE' &&
      context.requireCurrentAuthorization &&
      (!context.clock ||
        !cleanup.workerLease ||
        context.clock.compare(
          cleanup.workerLease.expiresAt,
          context.clock.nowISOString(),
        ) <= 0)
    ) {
      add(
        'V16',
        `cleanupLedger.${index}.workerLease.expiresAt`,
        'executable cleanup intent lease is expired or unverifiable',
      );
    }
  }

  // V17 — liveness evidence is bound to exact mappings and target.
  if (record.remoteVerification) {
    const verification = record.remoteVerification;
    if (
      verification.targetIdentityDigest !== targetDigest ||
      !sameResourceIdentity(
        verification.expectedActive,
        record.active?.block ?? null,
      ) ||
      !sameResourceIdentity(verification.expectedContainer, record.container)
    ) {
      add(
        'V17',
        'remoteVerification',
        'liveness evidence target differs from current mapping',
      );
    }
    for (const observation of [
      verification.activeObservation,
      verification.containerObservation,
    ]) {
      if (
        observation &&
        (observation.operationID !== verification.verificationID ||
          observation.targetIdentityDigest !== targetDigest)
      ) {
        add(
          'V17',
          'remoteVerification',
          'liveness observation identity differs',
        );
      }
    }
  }

  // V18 — root/note revisions are nonnegative and increment exactly once.
  if (
    context.rootRevision !== undefined &&
    !Number.isSafeInteger(context.rootRevision)
  ) {
    add('V18', 'rootRevision', 'root revision is not a safe integer');
  }
  if (context.previousRevision) {
    if (record.revision !== context.previousRevision.noteRevision + 1) {
      add('V18', 'revision', 'note revision did not increment exactly once');
    }
    if (context.rootRevision !== context.previousRevision.rootRevision + 1) {
      add(
        'V18',
        'rootRevision',
        'root revision did not increment exactly once',
      );
    }
  }

  return issues.length
    ? { issues, valid: false }
    : { issues: [], record, valid: true };
}

export function assertTransactionRecord(
  value: unknown,
  context: TransactionValidationContext = {},
): NoteSyncRecordV4 {
  const validation = validateTransactionRecord(value, context);
  if (!validation.valid) throw new TransactionInvariantError(validation.issues);
  return validation.record;
}

export function parseSyncedNotesRootV4(value: unknown): SyncedNotesRootV4 {
  const parsed = syncedNotesRootV4Schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TransactionInvariantError([
      {
        code: 'SCHEMA',
        message: issue?.message || 'Invalid schema v4 metadata root',
        path: issue?.path.join('.') || '<root>',
      },
    ]);
  }
  const root = parsed.data as SyncedNotesRootV4;
  for (const [noteKey, record] of Object.entries(root.notes)) {
    const validation = validateTransactionRecord(record, {
      rootRevision: root.rootRevision,
    });
    if (!validation.valid) {
      throw new TransactionInvariantError(
        validation.issues.map((issue) => ({
          ...issue,
          path: `notes.${noteKey}.${issue.path}`,
        })),
      );
    }
  }
  return root;
}

export function serializeSyncedNotesRootV4(root: SyncedNotesRootV4): string {
  parseSyncedNotesRootV4(root);
  return canonicalJSON(root);
}

export function isKnownOperationKindV4(value: string): boolean {
  return OPERATION_KINDS_V4.some((kind) => kind === value);
}

export function isKnownCleanupState(value: string): boolean {
  return CLEANUP_STATES.some((state) => state === value);
}

export function cleanupEntryIsExecutable(entry: CleanupLedgerEntry): boolean {
  return (
    entry.state === 'DELETE_INTENDED' &&
    entry.deleteIntent?.status === 'EXECUTABLE'
  );
}
