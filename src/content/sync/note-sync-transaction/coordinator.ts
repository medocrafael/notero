import { isObject } from '../../utils/is-object';
import {
  type BlockOwnershipIdentity,
  createOwnershipMarker,
} from '../notion-block-ownership';
import { getZoteroCrypto } from '../zotero-web-api';

import type { NoteSyncEvent } from './events';
import type { TransactionEventSelector } from './executor';
import type { NoteSourceAdapter } from './source-adapter';
import type {
  CleanupTarget,
  CreateCandidateIntentDetails,
  CreateBlockIntentDetails,
  NoteSyncRecordV3,
  OperationIntent,
  RemoteOperationIdentity,
  TargetIdentity,
  UploadAssetRecord,
} from './types';

const BLOCK_CREATE_ISOLATION_MS = 2 * 60 * 1000;
const UPLOAD_CREATE_ISOLATION_MS = 65 * 60 * 1000;

export type TransactionCoordinatorRuntime = {
  now: () => string;
  randomUUID: () => string;
};

export type NoteTransactionSource = Pick<
  NoteSourceAdapter,
  | 'buildBatches'
  | 'descriptors'
  | 'registerAppendPayload'
  | 'snapshot'
  | 'title'
>;

const DEFAULT_RUNTIME: TransactionCoordinatorRuntime = {
  now: () => new Date().toISOString(),
  randomUUID: () => getZoteroCrypto().randomUUID(),
};

function checksum(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
    right ^= right >>> 13;
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

function requestDigest(value: unknown): string {
  return `request-${checksum(JSON.stringify(value))}`;
}

function versionMarker(value: unknown): string {
  return `notero-version:v3:${checksum(JSON.stringify(value))}`;
}

function collectFileUploadIDs(value: unknown): string[] {
  if (!isObject(value) && !Array.isArray(value)) return [];
  if (Array.isArray(value)) {
    return Array.from(
      new Set(value.flatMap((child) => collectFileUploadIDs(child))),
    );
  }
  const record = value;
  const fileUpload = isObject(record.file_upload)
    ? record.file_upload
    : undefined;
  const ownID =
    record.type === 'file_upload' && typeof fileUpload?.id === 'string'
      ? [fileUpload.id]
      : [];
  return Array.from(
    new Set([
      ...ownID,
      ...Object.values(record).flatMap((child) => collectFileUploadIDs(child)),
    ]),
  );
}

export class NoteTransactionCoordinator {
  private readonly runtime: TransactionCoordinatorRuntime;

  public constructor(
    private readonly source: NoteTransactionSource,
    private readonly targetIdentity: TargetIdentity,
    private readonly legacyMigrationRequired: boolean,
    runtime: Partial<TransactionCoordinatorRuntime> = {},
  ) {
    this.runtime = { ...DEFAULT_RUNTIME, ...runtime };
  }

  public selector(): TransactionEventSelector {
    return (record) => this.select(record);
  }

  private select(record: NoteSyncRecordV3): NoteSyncEvent | null {
    const snapshot = this.source.snapshot;
    if (record.state === 'QUARANTINED') return null;

    if (record.state === 'IDLE') {
      if (
        record.active?.sourceVersion === snapshot.sourceVersion &&
        record.featurePolicy === snapshot.featurePolicy
      ) {
        return null;
      }
      return {
        featurePolicy: snapshot.featurePolicy,
        now: this.runtime.now(),
        requestedSourceVersion: snapshot.sourceVersion,
        source: snapshot,
        targetIdentity: this.targetIdentity,
        transactionID: this.runtime.randomUUID(),
        type: 'SYNC_REQUESTED',
      };
    }

    if (
      record.requestedSourceVersion !== snapshot.sourceVersion ||
      record.sourceVersion !== snapshot.sourceVersion ||
      record.featurePolicy !== snapshot.featurePolicy
    ) {
      return this.sourceChanged(record);
    }

    const state = record.state;
    switch (state) {
      case 'PREPARING':
        return this.prepare(record);
      case 'CANDIDATE_CREATING':
        return this.createCandidate(record);
      case 'CANDIDATE_WRITING':
        return this.writeCandidate(record);
      case 'CANDIDATE_VERIFYING':
        return this.finalizeCandidate(record);
      case 'CANDIDATE_DURABLE':
        return { committedAt: this.runtime.now(), type: 'COMMIT_ACTIVE' };
      case 'ACTIVE_COMMITTED':
        return record.cleanup.targets.length
          ? { type: 'PREVIOUS_ACTIVE_RETIRED' }
          : { type: 'NO_PREVIOUS_ACTIVE' };
      case 'CLEANING':
        return this.clean(record);
    }
    return assertNever(state);
  }

  private sourceChanged(record: NoteSyncRecordV3): NoteSyncEvent {
    const requestedSourceVersion = this.source.snapshot.sourceVersion;
    const now = this.runtime.now();
    if (record.state === 'CANDIDATE_DURABLE') {
      if (!record.candidate) {
        return this.invalid(record, 'Durable state has no candidate');
      }
      return record.active
        ? {
            cleanupTarget: this.candidateCleanup(
              record,
              'superseded-candidate',
            ),
            now,
            requestedSourceVersion,
            type: 'SOURCE_CHANGED_WITH_ACTIVE',
          }
        : {
            committedAt: now,
            now,
            requestedSourceVersion,
            type: 'SOURCE_CHANGED_WITHOUT_ACTIVE',
          };
    }
    if (['ACTIVE_COMMITTED', 'CLEANING'].includes(record.state)) {
      return { now, requestedSourceVersion, type: 'SOURCE_CHANGED' };
    }
    return {
      ...(record.candidate && {
        cleanupTarget: this.candidateCleanup(record, 'superseded-candidate'),
      }),
      now,
      requestedSourceVersion,
      type: 'SOURCE_CHANGED',
    };
  }

  private prepare(record: NoteSyncRecordV3): NoteSyncEvent {
    if (!record.container) return this.createContainer(record);
    if (record.featurePolicy === 'embedded-images-v1') {
      for (const asset of this.source.snapshot.imageAssets) {
        const existing = record.uploads.find(
          (upload) =>
            upload.attachmentKey === asset.attachmentKey &&
            upload.contentHash === asset.contentHash &&
            upload.targetIdentity.connectionID ===
              record.targetIdentity.connectionID &&
            upload.targetIdentity.workspaceID ===
              record.targetIdentity.workspaceID &&
            upload.targetIdentity.databaseID ===
              record.targetIdentity.databaseID &&
            upload.targetIdentity.pageID === record.targetIdentity.pageID,
        );
        const reusable = Boolean(
          existing?.fileUploadID &&
          ['attached', 'created-unsent', 'uploaded'].includes(
            existing.status,
          ) &&
          (existing.expiryTime === null ||
            !existing.expiryTime ||
            Date.parse(existing.expiryTime) > Date.now()),
        );
        if (!existing || !reusable) {
          return this.createUpload(record, asset);
        }
        if (existing.status === 'created-unsent') {
          return this.sendUpload(record, existing);
        }
      }
    }
    return { type: 'RESOURCES_READY' };
  }

  private operationBase(
    record: NoteSyncRecordV3,
    operationID: string,
    digest: string,
  ): RemoteOperationIdentity & { phase: 'INTENDED' } {
    if (!record.transactionID || !record.sourceVersion) {
      throw new Error('Cannot plan a remote operation outside a transaction');
    }
    return {
      generation: record.generation,
      operationGeneration: record.operationGeneration + 1,
      operationID,
      phase: 'INTENDED',
      requestDigest: digest,
      sourceVersion: record.sourceVersion,
      targetIdentity: record.targetIdentity,
      transactionID: record.transactionID,
    };
  }

  private createContainer(record: NoteSyncRecordV3): NoteSyncEvent {
    const operationID = this.runtime.randomUUID();
    const identity = this.containerIdentity();
    const marker = createOwnershipMarker(identity);
    const operationVersion = versionMarker(['container', operationID]);
    const started = this.runtime.now();
    const details: CreateBlockIntentDetails = {
      expectedCreator:
        record.targetIdentity.identityType === 'legacy-local'
          ? null
          : record.targetIdentity.connectionID,
      isolationDeadline: new Date(
        Date.parse(started) + BLOCK_CREATE_ISOLATION_MS,
      ).toISOString(),
      marker,
      migrationNotice: this.legacyMigrationRequired,
      parent: { id: record.targetIdentity.pageID, type: 'page_id' },
      requestStartedAt: started,
      title: 'Zotero Notes',
      versionMarker: operationVersion,
    };
    const intent: OperationIntent = {
      ...this.operationBase(
        record,
        operationID,
        requestDigest(['CREATE_CONTAINER', details]),
      ),
      details,
      kind: 'CREATE_CONTAINER',
    };
    return { intent, type: 'CONTAINER_REQUIRED' };
  }

  private createUpload(
    record: NoteSyncRecordV3,
    asset: NoteSourceAdapter['snapshot']['imageAssets'][number],
  ): NoteSyncEvent {
    const operationID = this.runtime.randomUUID();
    const started = this.runtime.now();
    const details = {
      attachmentKey: asset.attachmentKey,
      contentHash: asset.contentHash,
      contentLength: asset.contentLength,
      contentType: asset.contentType,
      filename: asset.filename,
      isolationDeadline: new Date(
        Date.parse(started) + UPLOAD_CREATE_ISOLATION_MS,
      ).toISOString(),
      requestStartedAt: started,
    };
    const intent: Extract<OperationIntent, { kind: 'UPLOAD_CREATE' }> = {
      ...this.operationBase(
        record,
        operationID,
        requestDigest(['UPLOAD_CREATE', details]),
      ),
      details,
      kind: 'UPLOAD_CREATE',
    };
    const upload: UploadAssetRecord = {
      attachedAt: null,
      attachmentKey: asset.attachmentKey,
      contentHash: asset.contentHash,
      contentLength: asset.contentLength,
      contentType: asset.contentType,
      createOperationID: operationID,
      expiryTime: details.isolationDeadline,
      fileUploadID: null,
      filename: asset.filename,
      generation: record.generation,
      sendOperationID: null,
      sourceVersion: intent.sourceVersion,
      status: 'create-intended',
      targetIdentity: record.targetIdentity,
      transactionID: intent.transactionID,
    };
    return { intent, type: 'UPLOAD_CREATE_REQUIRED', upload };
  }

  private sendUpload(
    record: NoteSyncRecordV3,
    upload: UploadAssetRecord,
  ): NoteSyncEvent {
    if (!upload.fileUploadID) throw new Error('Created upload has no ID');
    const operationID = this.runtime.randomUUID();
    const details = {
      attachmentKey: upload.attachmentKey,
      contentHash: upload.contentHash,
      contentLength: upload.contentLength,
      contentType: upload.contentType,
      createOperationID: upload.createOperationID,
      filename: upload.filename,
      fileUploadID: upload.fileUploadID,
    };
    const intent: Extract<OperationIntent, { kind: 'UPLOAD_SEND' }> = {
      ...this.operationBase(
        record,
        operationID,
        requestDigest(['UPLOAD_SEND', details]),
      ),
      details,
      kind: 'UPLOAD_SEND',
    };
    return { intent, type: 'UPLOAD_SEND_REQUIRED' };
  }

  private createCandidate(record: NoteSyncRecordV3): NoteSyncEvent {
    if (!record.container || !record.transactionID) {
      return this.invalid(record, 'Candidate creation requires a container');
    }
    const operationID = this.runtime.randomUUID();
    const started = this.runtime.now();
    const candidateMarker = createOwnershipMarker(
      this.candidateIdentity(record.transactionID),
    );
    const candidateVersion = versionMarker([
      'candidate',
      record.transactionID,
      record.generation,
      record.sourceVersion,
    ]);
    const details: CreateCandidateIntentDetails = {
      candidatePlan: {
        expectedBlockCount: this.source.snapshot.batches.reduce(
          (total, batch) => total + batch.length,
          0,
        ),
        expectedImageCount: this.source.descriptors.length,
        imageAssetIdentities: this.source.snapshot.imageAssets.map((asset) =>
          requestDigest([
            asset.attachmentKey,
            asset.contentHash,
            asset.contentLength,
            asset.contentType,
          ]),
        ),
        manifestDigest: this.source.snapshot.manifestDigest,
        previousActiveBlockID: record.active?.block.blockID || null,
      },
      container: record.container,
      expectedCreator: record.container.createdByID,
      isolationDeadline: new Date(
        Date.parse(started) + BLOCK_CREATE_ISOLATION_MS,
      ).toISOString(),
      marker: candidateMarker,
      migrationNotice: false,
      parent: { id: record.container.blockID, type: 'block_id' },
      requestStartedAt: started,
      title: 'Notero sync in progress',
      versionMarker: candidateVersion,
    };
    const intent: Extract<OperationIntent, { kind: 'CREATE_CANDIDATE' }> = {
      ...this.operationBase(
        record,
        operationID,
        requestDigest(['CREATE_CANDIDATE', details]),
      ),
      details,
      kind: 'CREATE_CANDIDATE',
    };
    return { intent, type: 'CREATE_CANDIDATE' };
  }

  private writeCandidate(record: NoteSyncRecordV3): NoteSyncEvent {
    if (!record.candidate) {
      return this.invalid(record, 'Candidate write has no candidate');
    }
    const blockBatches = this.source.buildBatches(record);
    const index = record.candidate.nextBatchIndex;
    const batch = blockBatches[index];
    if (!batch) return { type: 'CONTENT_COMPLETE' };
    const operationID = this.runtime.randomUUID();
    const uploadIDs = new Set(collectFileUploadIDs(batch));
    const fileUploads = record.uploads.filter(
      ({ fileUploadID }) => fileUploadID && uploadIDs.has(fileUploadID),
    );
    if (fileUploads.length !== uploadIDs.size) {
      return this.invalid(
        record,
        'Append batch references an unknown File Upload',
      );
    }
    const batchDigest = requestDigest(batch);
    const details = {
      batchDigest,
      batchIndex: index,
      candidate: record.candidate.block,
      expectedBlockCount: batch.length,
      fileUploads,
    };
    const intent: Extract<OperationIntent, { kind: 'APPEND_BATCH' }> = {
      ...this.operationBase(
        record,
        operationID,
        requestDigest(['APPEND_BATCH', details, batch]),
      ),
      details,
      kind: 'APPEND_BATCH',
    };
    this.source.registerAppendPayload(operationID, batch);
    return { intent, type: 'APPEND_BATCH' };
  }

  private finalizeCandidate(record: NoteSyncRecordV3): NoteSyncEvent {
    if (!record.candidate) {
      return this.invalid(record, 'Candidate finalization has no candidate');
    }
    const operationID = this.runtime.randomUUID();
    const details = {
      candidate: record.candidate.block,
      finalTitle: this.source.title,
      manifestDigest: record.candidate.manifestDigest,
      ownershipMarker: createOwnershipMarker(this.noteIdentity()),
      versionMarker: versionMarker([
        'active',
        record.generation,
        record.sourceVersion,
      ]),
    };
    const intent: Extract<OperationIntent, { kind: 'FINALIZE_CANDIDATE' }> = {
      ...this.operationBase(
        record,
        operationID,
        requestDigest(['FINALIZE_CANDIDATE', details]),
      ),
      details,
      kind: 'FINALIZE_CANDIDATE',
    };
    return { intent, type: 'FINALIZE_CANDIDATE' };
  }

  private clean(record: NoteSyncRecordV3): NoteSyncEvent {
    const target = record.cleanup.targets.find(
      ({ status }) => status === 'pending',
    );
    if (!target) return { type: 'CLEANUP_COMPLETE' };
    if (target.resource.blockID === record.active?.block.blockID) {
      return this.invalid(record, 'Cleanup attempted to target current active');
    }
    const operationID = this.runtime.randomUUID();
    const details = {
      exactBlockID: target.resource.blockID,
      expectedCreator: target.resource.createdByID,
      expectedLastEditedTime: target.resource.lastEditedTime,
      expectedOwnershipMarker: target.resource.marker,
      expectedParent: target.resource.parent,
      expectedVersionMarker: target.resource.versionMarker,
      kind: target.resource.kind,
      reason: target.reason,
      targetGeneration: target.generation,
      targetSourceVersion: target.sourceVersion,
    };
    const intent: Extract<OperationIntent, { kind: 'DELETE_BLOCK' }> = {
      ...this.operationBase(
        record,
        operationID,
        requestDigest(['DELETE_BLOCK', details]),
      ),
      details,
      kind: 'DELETE_BLOCK',
    };
    return { intent, type: 'DELETE_NEXT' };
  }

  private candidateCleanup(
    record: NoteSyncRecordV3,
    reason: CleanupTarget['reason'],
  ): CleanupTarget {
    if (!record.candidate || !record.transactionID || !record.sourceVersion) {
      throw new Error('Cannot isolate a missing candidate');
    }
    return {
      generation: record.generation,
      reason,
      resource: record.candidate.block,
      sourceVersion: record.sourceVersion,
      status: 'pending',
      transactionID: record.transactionID,
    };
  }

  private invalid(record: NoteSyncRecordV3, message: string): NoteSyncEvent {
    return {
      diagnostic: {
        actionable: true,
        code: 'INVALID_TRANSACTION',
        createdAt: this.runtime.now(),
        evidenceDigest: requestDigest([
          record.state,
          record.recordRevision,
          record.transactionID,
        ]),
        message,
        operationID: record.operationIntent?.operationID || null,
      },
      type: 'INVALID_SCHEMA_OR_EVIDENCE',
    };
  }

  private containerIdentity(): BlockOwnershipIdentity {
    return {
      kind: 'container',
      libraryID: this.targetIdentity.libraryID,
      parentItemKey: this.targetIdentity.parentItemKey,
      target: this.targetIdentity,
    };
  }

  private candidateIdentity(transactionID: string): BlockOwnershipIdentity {
    return {
      attemptID: transactionID,
      kind: 'candidate',
      libraryID: this.targetIdentity.libraryID,
      noteItemKey: this.targetIdentity.noteItemKey,
      parentItemKey: this.targetIdentity.parentItemKey,
      target: this.targetIdentity,
    };
  }

  private noteIdentity(): BlockOwnershipIdentity {
    return {
      kind: 'note',
      libraryID: this.targetIdentity.libraryID,
      noteItemKey: this.targetIdentity.noteItemKey,
      parentItemKey: this.targetIdentity.parentItemKey,
      target: this.targetIdentity,
    };
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported transaction state: ${JSON.stringify(value)}`);
}
