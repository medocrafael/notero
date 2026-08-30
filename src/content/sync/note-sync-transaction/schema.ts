import { z } from 'zod';

import { isObject } from '../../utils';

import {
  MAX_CLEANUP_TARGETS,
  MAX_QUARANTINE_RECORDS,
  MAX_UPLOAD_ASSETS,
  cleanupContainsActive,
  operationBelongsToRecord,
  sameTargetIdentity,
} from './model';
import type {
  NoteSyncRecordV3,
  NoteSyncRecordValidation,
  QuarantineRecord,
} from './types';
import {
  NOTE_SYNC_SCHEMA_VERSION,
  NOTE_TRANSACTION_STATES,
  OPERATION_KINDS,
} from './types';

const nonEmpty = z.string().min(1).max(2_000);
const digest = z.string().min(8).max(256);
const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: 'expected an ISO-compatible timestamp',
  });
const safeCounter = z.number().int().nonnegative().safe();

const notionTargetSchema = z
  .object({
    connectionID: nonEmpty,
    databaseID: nonEmpty,
    identityType: z.literal('legacy-local').optional(),
    pageID: nonEmpty,
    workspaceID: nonEmpty,
  })
  .strict();

const targetIdentitySchema = notionTargetSchema
  .extend({
    libraryID: safeCounter,
    noteItemKey: nonEmpty,
    parentItemKey: nonEmpty,
  })
  .strict();

const remoteParentSchema = z
  .object({ id: nonEmpty, type: z.enum(['block_id', 'page_id']) })
  .strict();

const managedResourceSchema = z
  .object({
    attemptID: nonEmpty.optional(),
    blockID: nonEmpty,
    createdByID: nonEmpty,
    kind: z.enum(['candidate', 'container', 'note']),
    lastEditedTime: timestamp,
    marker: nonEmpty,
    operationID: nonEmpty,
    parent: remoteParentSchema,
    versionMarker: nonEmpty,
  })
  .strict();

const operationEvidenceSchema = z
  .object({
    observedAt: timestamp,
    operationID: nonEmpty,
    remoteLastEditedTime: timestamp.optional(),
    requestDigest: digest,
    result: z.enum([
      'attached',
      'created',
      'deleted',
      'finalized',
      'uploaded',
      'written',
    ]),
    returnedBlockIDs: z.array(nonEmpty).max(100).optional(),
  })
  .strict();

const completionEvidenceSchema = z
  .object({
    completedAt: timestamp,
    finalization: operationEvidenceSchema,
    manifestDigest: digest,
    verifiedAt: timestamp,
  })
  .strict();

const versionRecordSchema = z
  .object({
    block: managedResourceSchema,
    committedAt: timestamp,
    completedAt: timestamp,
    completionEvidence: completionEvidenceSchema,
    container: managedResourceSchema,
    contentManifestDigest: digest,
    generation: safeCounter,
    imageAssetIdentities: z.array(digest).max(32),
    sourceVersion: digest,
    transactionID: nonEmpty,
  })
  .strict();

const candidateRecordSchema = z
  .object({
    batchDigests: z.array(digest).max(10_000),
    block: managedResourceSchema,
    completionEvidence: completionEvidenceSchema.nullable(),
    expectedBlockCount: safeCounter,
    expectedImageCount: safeCounter,
    generation: safeCounter,
    imageAssetIdentities: z.array(digest).max(32),
    manifestDigest: digest,
    nextBatchIndex: safeCounter,
    previousActiveBlockID: nonEmpty.nullable(),
    returnedBlockIDs: z.array(nonEmpty).max(10_000),
    sourceVersion: digest,
    status: z.enum(['durable', 'staging', 'verified']),
    transactionID: nonEmpty,
  })
  .strict();

const cleanupTargetSchema = z
  .object({
    generation: safeCounter,
    reason: z.enum([
      'aborted-candidate',
      'orphan-cleanup',
      'retired-active',
      'superseded-candidate',
      'unused-container',
    ]),
    resource: managedResourceSchema,
    sourceVersion: digest,
    status: z.enum(['pending', 'quarantined']),
    transactionID: nonEmpty,
  })
  .strict();

const quarantineRecordSchema = z
  .object({
    actionable: z.boolean(),
    code: z.enum([
      'AMBIGUOUS_REMOTE_RESULT',
      'FEATURE_V2_TRANSACTION_UNSUPPORTED',
      'ILLEGAL_EVENT',
      'INVALID_FIELD',
      'INVALID_JSON',
      'INVALID_TRANSACTION',
      'OWNERSHIP_CHANGED',
      'PAGINATION_INCOMPLETE',
      'REMOTE_NOT_FOUND',
      'STALE_REVISION',
    ]),
    createdAt: timestamp,
    evidenceDigest: nonEmpty,
    message: nonEmpty,
    operationID: nonEmpty.nullable(),
  })
  .strict();

const operationBase = {
  generation: safeCounter,
  operationGeneration: safeCounter,
  operationID: nonEmpty,
  phase: z.enum(['INTENDED', 'UNCERTAIN']),
  requestDigest: digest,
  sourceVersion: digest,
  targetIdentity: targetIdentitySchema,
  transactionID: nonEmpty,
};

const operationIntentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...operationBase,
      details: z
        .object({
          expectedCreator: nonEmpty.nullable(),
          isolationDeadline: timestamp,
          marker: nonEmpty,
          migrationNotice: z.boolean(),
          parent: remoteParentSchema,
          requestStartedAt: timestamp,
          title: z.string().max(2_000),
          versionMarker: nonEmpty,
        })
        .strict(),
      kind: z.literal('CREATE_CONTAINER'),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      details: z
        .object({
          candidatePlan: z
            .object({
              expectedBlockCount: safeCounter,
              expectedImageCount: safeCounter,
              imageAssetIdentities: z.array(digest).max(32),
              manifestDigest: digest,
              previousActiveBlockID: nonEmpty.nullable(),
            })
            .strict(),
          container: managedResourceSchema,
          expectedCreator: nonEmpty.nullable(),
          isolationDeadline: timestamp,
          marker: nonEmpty,
          migrationNotice: z.boolean(),
          parent: remoteParentSchema,
          requestStartedAt: timestamp,
          title: z.string().max(2_000),
          versionMarker: nonEmpty,
        })
        .strict(),
      kind: z.literal('CREATE_CANDIDATE'),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      details: z
        .object({
          batchDigest: digest,
          batchIndex: safeCounter,
          candidate: managedResourceSchema,
          expectedBlockCount: safeCounter,
          fileUploads: z.array(z.lazy(() => uploadAssetSchema)).max(32),
        })
        .strict(),
      kind: z.literal('APPEND_BATCH'),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      details: z
        .object({
          candidate: managedResourceSchema,
          finalTitle: z.string().max(2_000),
          manifestDigest: digest,
          ownershipMarker: nonEmpty,
          versionMarker: nonEmpty,
        })
        .strict(),
      kind: z.literal('FINALIZE_CANDIDATE'),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      details: z
        .object({
          exactBlockID: nonEmpty,
          expectedCreator: nonEmpty,
          expectedLastEditedTime: timestamp,
          expectedOwnershipMarker: nonEmpty,
          expectedParent: remoteParentSchema,
          expectedVersionMarker: nonEmpty,
          kind: z.enum(['candidate', 'container', 'note']),
          reason: z.enum([
            'aborted-candidate',
            'orphan-cleanup',
            'retired-active',
            'superseded-candidate',
            'unused-container',
          ]),
          targetGeneration: safeCounter,
          targetSourceVersion: digest,
        })
        .strict(),
      kind: z.literal('DELETE_BLOCK'),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      details: z
        .object({
          attachmentKey: nonEmpty,
          contentHash: digest,
          contentLength: safeCounter,
          contentType: nonEmpty,
          filename: nonEmpty,
          isolationDeadline: timestamp,
          requestStartedAt: timestamp,
        })
        .strict(),
      kind: z.literal('UPLOAD_CREATE'),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      details: z
        .object({
          attachmentKey: nonEmpty,
          contentHash: digest,
          contentLength: safeCounter,
          contentType: nonEmpty,
          createOperationID: nonEmpty,
          filename: nonEmpty,
          fileUploadID: nonEmpty,
        })
        .strict(),
      kind: z.literal('UPLOAD_SEND'),
    })
    .strict(),
]);

const uploadAssetSchema = z
  .object({
    attachedAt: timestamp.nullable(),
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
    sourceVersion: digest,
    status: z.enum([
      'attached',
      'create-intended',
      'create-uncertain',
      'created-unsent',
      'expired',
      'failed',
      'send-intended',
      'send-uncertain',
      'uploaded',
    ]),
    targetIdentity: targetIdentitySchema,
    transactionID: nonEmpty,
  })
  .strict();

export const noteSyncRecordV3Schema = z
  .object({
    active: versionRecordSchema.nullable(),
    candidate: candidateRecordSchema.nullable(),
    cleanup: z
      .object({
        mode: z.enum(['abort', 'retire']).nullable(),
        resume: z.enum(['IDLE', 'PREPARING']),
        targets: z.array(cleanupTargetSchema).max(MAX_CLEANUP_TARGETS),
      })
      .strict(),
    container: managedResourceSchema.nullable(),
    createdAt: timestamp,
    featurePolicy: z.enum(['embedded-images-v1', 'text-only-v1']),
    generation: safeCounter,
    operationGeneration: safeCounter,
    operationIntent: operationIntentSchema.nullable(),
    quarantine: z.array(quarantineRecordSchema).max(MAX_QUARANTINE_RECORDS),
    recordRevision: safeCounter,
    requestedSourceVersion: digest.nullable(),
    schemaVersion: z.literal(NOTE_SYNC_SCHEMA_VERSION),
    sourceVersion: digest.nullable(),
    state: z.enum(NOTE_TRANSACTION_STATES),
    targetIdentity: targetIdentitySchema,
    transactionID: nonEmpty.nullable(),
    updatedAt: timestamp,
    uploads: z.array(uploadAssetSchema).max(MAX_UPLOAD_ASSETS),
  })
  .strict();

function duplicate(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

/**
 * Transaction invariants implementing the approved safety model:
 * I1 preserve the last-known-good active; I2 require exact ownership;
 * I3 never guess from absence; I4 persist destructive intent first;
 * I5 recover from state/evidence; I6 separate requested/transaction/active
 * versions; I7 make replay idempotent; I8 commit monotonically from durable
 * evidence; I9 forbid upload work when the feature is off; I10 preserve
 * unknown evidence; I11 keep one authoritative active; I12 couple every
 * observation to its operation identity. Field validity alone cannot prove
 * these relationships.
 */
export function validateTransactionInvariants(
  record: NoteSyncRecordV3,
): string[] {
  const errors: string[] = [];
  const requireTransaction = () => {
    if (!record.transactionID || !record.sourceVersion) {
      errors.push(`${record.state} requires transactionID and sourceVersion`);
    }
  };

  if (record.featurePolicy === 'text-only-v1') {
    if (record.uploads.length) errors.push('Feature OFF requires uploads=[]');
    if (
      record.operationIntent &&
      ['UPLOAD_CREATE', 'UPLOAD_SEND'].includes(record.operationIntent.kind)
    ) {
      errors.push('Feature OFF forbids file-upload operations');
    }
  }
  if (cleanupContainsActive(record)) {
    errors.push('cleanup must never target authoritative active');
  }
  if (!operationBelongsToRecord(record)) {
    errors.push('operation intent identity does not match the transaction');
  }
  if (
    duplicate(record.cleanup.targets.map(({ resource }) => resource.blockID))
  ) {
    errors.push('cleanup block identities must be unique');
  }
  if (
    duplicate(
      record.uploads.map(
        (upload) => `${upload.attachmentKey}:${upload.contentHash}`,
      ),
    )
  ) {
    errors.push('upload asset identities must be unique');
  }
  for (const upload of record.uploads) {
    if (!sameTargetIdentity(upload.targetIdentity, record.targetIdentity)) {
      errors.push('upload target identity does not match the note target');
    }
    if (
      upload.status === 'attached' &&
      (!upload.fileUploadID || !upload.attachedAt)
    ) {
      errors.push('attached upload requires permanent attachment evidence');
    }
    if (upload.status === 'send-uncertain' && !upload.fileUploadID) {
      errors.push('send-uncertain upload requires a file upload ID');
    }
  }
  if (record.active) {
    if (record.active.block.kind !== 'note') {
      errors.push('active block must have stable note ownership');
    }
    if (
      record.active.completionEvidence.manifestDigest !==
      record.active.contentManifestDigest
    ) {
      errors.push('active manifest is not coupled to completion evidence');
    }
  }
  if (record.candidate) {
    requireTransaction();
    if (
      record.candidate.transactionID !== record.transactionID ||
      record.candidate.generation !== record.generation ||
      record.candidate.sourceVersion !== record.sourceVersion
    ) {
      errors.push('candidate identity does not match current transaction');
    }
    if (
      record.candidate.status === 'durable' &&
      !record.candidate.completionEvidence
    ) {
      errors.push('durable candidate requires completion evidence');
    }
    if (
      record.candidate.nextBatchIndex !== record.candidate.batchDigests.length
    ) {
      errors.push('candidate batch indexes must be contiguous');
    }
  }

  switch (record.state) {
    case 'IDLE':
      if (
        record.transactionID ||
        record.sourceVersion ||
        record.candidate ||
        record.operationIntent ||
        record.cleanup.targets.length
      ) {
        errors.push('IDLE cannot contain transaction work');
      }
      break;
    case 'PREPARING':
      requireTransaction();
      if (record.candidate?.status === 'durable') {
        errors.push('PREPARING cannot contain a durable candidate');
      }
      break;
    case 'CANDIDATE_CREATING':
      requireTransaction();
      if (!record.container) errors.push('candidate create requires container');
      if (record.candidate)
        errors.push('candidate create requires candidate=null');
      if (
        record.operationIntent &&
        record.operationIntent.kind !== 'CREATE_CANDIDATE'
      ) {
        errors.push('candidate create has an incompatible intent');
      }
      break;
    case 'CANDIDATE_WRITING':
      requireTransaction();
      if (!record.candidate || record.candidate.status !== 'staging') {
        errors.push('candidate writing requires a staging candidate');
      }
      if (
        record.operationIntent &&
        record.operationIntent.kind !== 'APPEND_BATCH'
      ) {
        errors.push('candidate writing has an incompatible intent');
      }
      break;
    case 'CANDIDATE_VERIFYING':
      requireTransaction();
      if (!record.candidate || record.candidate.status !== 'verified') {
        errors.push('candidate verification requires complete batch evidence');
      }
      if (
        record.operationIntent &&
        record.operationIntent.kind !== 'FINALIZE_CANDIDATE'
      ) {
        errors.push('candidate verification has an incompatible intent');
      }
      break;
    case 'CANDIDATE_DURABLE':
      requireTransaction();
      if (!record.candidate || record.candidate.status !== 'durable') {
        errors.push('CANDIDATE_DURABLE requires durable candidate evidence');
      }
      if (record.operationIntent) {
        errors.push('CANDIDATE_DURABLE cannot have a remote intent');
      }
      break;
    case 'ACTIVE_COMMITTED':
      requireTransaction();
      if (
        !record.active ||
        !record.candidate ||
        record.candidate.status !== 'durable' ||
        record.active.block.blockID !== record.candidate.block.blockID ||
        record.active.transactionID !== record.transactionID ||
        record.active.generation !== record.generation ||
        record.active.sourceVersion !== record.sourceVersion
      ) {
        errors.push('ACTIVE_COMMITTED must point to its durable candidate');
      }
      if (record.operationIntent) {
        errors.push('ACTIVE_COMMITTED cannot require remote promotion');
      }
      break;
    case 'CLEANING': {
      requireTransaction();
      const current = record.cleanup.targets[0];
      if (record.operationIntent?.kind === 'DELETE_BLOCK') {
        const details = record.operationIntent.details;
        if (
          !current ||
          details.exactBlockID !== current.resource.blockID ||
          details.expectedParent.id !== current.resource.parent.id ||
          details.expectedCreator !== current.resource.createdByID ||
          details.expectedOwnershipMarker !== current.resource.marker ||
          details.expectedVersionMarker !== current.resource.versionMarker ||
          details.expectedLastEditedTime !== current.resource.lastEditedTime ||
          details.targetGeneration !== current.generation ||
          details.targetSourceVersion !== current.sourceVersion
        ) {
          errors.push(
            'DELETE intent must exactly match current cleanup target',
          );
        }
      } else if (record.operationIntent) {
        errors.push('CLEANING only permits DELETE_BLOCK intent');
      }
      break;
    }
    case 'QUARANTINED':
      if (!record.quarantine.length) {
        errors.push('QUARANTINED requires actionable diagnostic evidence');
      }
      if (record.operationIntent) {
        errors.push('QUARANTINED cannot authorize remote mutation');
      }
      break;
    default:
      errors.push(`unsupported transaction state ${String(record.state)}`);
  }
  return errors;
}

function quarantine(
  raw: string,
  code: QuarantineRecord['code'],
  message: string,
): NoteSyncRecordValidation {
  return {
    diagnostic: {
      actionable: true,
      code,
      createdAt: new Date(0).toISOString(),
      evidenceDigest: `redacted-length:${raw.length}`,
      message,
      operationID: null,
    },
    preservedRaw: raw,
    validation: 'quarantined',
  };
}

/** Strict three-layer validation: JSON syntax, fields, then transaction rules. */
export function validateNoteSyncRecordJSON(
  raw: string,
): NoteSyncRecordValidation {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return quarantine(
      raw,
      'INVALID_JSON',
      'Note sync record is not valid JSON',
    );
  }
  if (!isObject(value)) {
    return quarantine(
      raw,
      'INVALID_FIELD',
      'Note sync record root is not an object',
    );
  }
  const parsed = noteSyncRecordV3Schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') || '<root>';
    return quarantine(
      raw,
      'INVALID_FIELD',
      `Note sync record field ${path} is invalid`,
    );
  }
  const record: NoteSyncRecordV3 = parsed.data;
  const invariantErrors = validateTransactionInvariants(record);
  if (invariantErrors.length) {
    return quarantine(raw, 'INVALID_TRANSACTION', invariantErrors.join('; '));
  }
  return { record, validation: 'valid' };
}

export function serializeNoteSyncRecord(record: NoteSyncRecordV3): string {
  const fieldResult = noteSyncRecordV3Schema.safeParse(record);
  if (!fieldResult.success) {
    throw new Error('Cannot serialize an invalid note sync record field set');
  }
  const invariantErrors = validateTransactionInvariants(fieldResult.data);
  if (invariantErrors.length) {
    throw new Error(
      `Cannot serialize invalid transaction: ${invariantErrors.join('; ')}`,
    );
  }
  return JSON.stringify(fieldResult.data);
}

export function isNativeV3Record(value: unknown): value is NoteSyncRecordV3 {
  return (
    isObject(value) &&
    value.schemaVersion === NOTE_SYNC_SCHEMA_VERSION &&
    typeof value.state === 'string' &&
    isKnownString(NOTE_TRANSACTION_STATES, value.state) &&
    (!isObject(value.operationIntent) ||
      (typeof value.operationIntent.kind === 'string' &&
        isKnownString(OPERATION_KINDS, value.operationIntent.kind)))
  );
}

function isKnownString<const Values extends readonly string[]>(
  values: Values,
  value: string,
): value is Values[number] {
  return values.some((candidate) => candidate === value);
}

export function parseManagedResourceRecord(
  value: unknown,
): import('./types').ManagedResourceRecord | undefined {
  const parsed = managedResourceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
