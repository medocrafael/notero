import {
  APIResponseError,
  RequestTimeoutError,
  type Client,
  isFullBlock,
} from '@notionhq/client';
import type {
  BlockObjectRequest,
  BlockObjectResponse,
  FileUploadObjectResponse,
} from '@notionhq/client/build/src/api-endpoints';

import type { ResolvedNoteImage } from '../note-image-resolver';
import {
  buildManagedHeadingRichText,
  hasExactOwnershipMarker,
} from '../notion-block-ownership';
import {
  UploadReconciliationAmbiguousError,
  type NotionImageUploadService,
} from '../notion-image-upload-service';

import type { RemoteOperationAdapter } from './executor';
import type { RemoteOperationObservation } from './recovery';
import type {
  CandidateRecord,
  CleanupTarget,
  ManagedResourceRecord,
  OperationEvidence,
  OperationIntent,
  QuarantineRecord,
  RemoteParent,
  UploadAssetRecord,
} from './types';

const MAX_CHILD_LIST_PAGES = 20;
const LEGACY_MIGRATION_NOTICE =
  'Notero created new managed note copies and left all legacy synchronized blocks unchanged. Duplicate note content may remain until you manually review and remove the legacy blocks.';

type AppendIntent = Extract<OperationIntent, { kind: 'APPEND_BATCH' }>;
type UploadSendIntent = Extract<OperationIntent, { kind: 'UPLOAD_SEND' }>;

export type NotionBlocksClient = {
  blocks: Pick<Client['blocks'], 'delete' | 'retrieve' | 'update'> & {
    children: Pick<Client['blocks']['children'], 'append' | 'list'>;
  };
};

export type NotionUploadGateway = Pick<
  NotionImageUploadService,
  'create' | 'reconcileCreate' | 'retrieve' | 'sendCreated'
>;

export type OperationPayloadProvider = {
  getAppendBatch: (intent: AppendIntent) => Promise<BlockObjectRequest[]>;
  getUploadBytes: (intent: UploadSendIntent) => Promise<ResolvedNoteImage>;
};

export type NotionOperationRuntime = {
  now: () => string;
};

const DEFAULT_RUNTIME: NotionOperationRuntime = {
  now: () => new Date().toISOString(),
};

function parentMatches(
  block: BlockObjectResponse,
  expected: RemoteParent,
): boolean {
  return expected.type === 'page_id'
    ? block.parent.type === 'page_id' && block.parent.page_id === expected.id
    : block.parent.type === 'block_id' && block.parent.block_id === expected.id;
}

function isAmbiguousWrite(error: unknown): boolean {
  if (
    RequestTimeoutError.isRequestTimeoutError(error) ||
    error instanceof TypeError
  ) {
    return true;
  }
  return (
    error instanceof APIResponseError &&
    [409, 429, 500, 502, 503, 504, 529].includes(error.status)
  );
}

function isProvenUnexecuted(error: unknown): boolean {
  return (
    error instanceof APIResponseError && [400, 401, 403].includes(error.status)
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof APIResponseError && error.status === 404;
}

function requireSupportedImageContentType(
  contentType: string,
): ResolvedNoteImage['contentType'] {
  if (
    contentType === 'image/gif' ||
    contentType === 'image/jpeg' ||
    contentType === 'image/png' ||
    contentType === 'image/webp'
  ) {
    return contentType;
  }
  throw new Error(`Unsupported note image content type: ${contentType}`);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported operation intent: ${JSON.stringify(value)}`);
}

export class NotionOperationAdapter implements RemoteOperationAdapter {
  private readonly runtime: NotionOperationRuntime;
  private readonly uploads: NotionUploadGateway;

  public constructor(
    private readonly notion: NotionBlocksClient,
    private readonly payloads: OperationPayloadProvider,
    uploadService: NotionUploadGateway,
    runtime: Partial<NotionOperationRuntime> = {},
  ) {
    this.runtime = { ...DEFAULT_RUNTIME, ...runtime };
    this.uploads = uploadService;
  }

  public async execute(
    intent: OperationIntent,
  ): Promise<RemoteOperationObservation> {
    switch (intent.kind) {
      case 'CREATE_CONTAINER':
      case 'CREATE_CANDIDATE':
        return this.executeCreate(intent);
      case 'APPEND_BATCH':
        return this.executeAppend(intent);
      case 'FINALIZE_CANDIDATE':
        return this.executeFinalization(intent);
      case 'DELETE_BLOCK':
        return this.executeDelete(intent);
      case 'UPLOAD_CREATE':
        return this.executeUploadCreate(intent);
      case 'UPLOAD_SEND':
        return this.executeUploadSend(intent);
    }
    return assertNever(intent);
  }

  public async observe(
    intent: OperationIntent,
  ): Promise<RemoteOperationObservation> {
    switch (intent.kind) {
      case 'CREATE_CONTAINER':
      case 'CREATE_CANDIDATE':
        return this.observeCreate(intent);
      case 'APPEND_BATCH':
        return this.appendUnknown(intent);
      case 'FINALIZE_CANDIDATE':
        return this.observeFinalization(intent);
      case 'DELETE_BLOCK':
        return this.executeDelete(intent);
      case 'UPLOAD_CREATE':
        return this.observeUploadCreate(intent);
      case 'UPLOAD_SEND':
        return this.observeUploadSend(intent);
    }
    return assertNever(intent);
  }

  private evidence(
    intent: OperationIntent,
    result: OperationEvidence['result'],
    extra: Partial<OperationEvidence> = {},
  ): OperationEvidence {
    return {
      observedAt: this.runtime.now(),
      operationID: intent.operationID,
      requestDigest: intent.requestDigest,
      result,
      ...extra,
    };
  }

  private diagnostic(
    intent: OperationIntent,
    code: QuarantineRecord['code'],
    message: string,
  ): QuarantineRecord {
    return {
      actionable: true,
      code,
      createdAt: this.runtime.now(),
      evidenceDigest: `${intent.operationID}:${intent.requestDigest}:${code}`,
      message,
      operationID: intent.operationID,
    };
  }

  private resourceFromBlock(
    block: BlockObjectResponse,
    intent: Extract<
      OperationIntent,
      { kind: 'CREATE_CANDIDATE' | 'CREATE_CONTAINER' }
    >,
  ): ManagedResourceRecord {
    return {
      ...(intent.kind === 'CREATE_CANDIDATE' && {
        attemptID: intent.transactionID,
      }),
      blockID: block.id,
      createdByID: block.created_by.id,
      kind: intent.kind === 'CREATE_CONTAINER' ? 'container' : 'candidate',
      lastEditedTime: block.last_edited_time,
      marker: intent.details.marker,
      operationID: intent.operationID,
      parent: intent.details.parent,
      versionMarker: intent.details.versionMarker,
    };
  }

  private blockMatchesCreate(
    block: BlockObjectResponse,
    intent: Extract<
      OperationIntent,
      { kind: 'CREATE_CANDIDATE' | 'CREATE_CONTAINER' }
    >,
  ): boolean {
    return (
      block.type === 'heading_1' &&
      block.heading_1.is_toggleable &&
      !block.in_trash &&
      !block.archived &&
      (!intent.details.expectedCreator ||
        block.created_by.id === intent.details.expectedCreator) &&
      parentMatches(block, intent.details.parent) &&
      hasExactOwnershipMarker(
        block.heading_1.rich_text,
        intent.details.marker,
      ) &&
      hasExactOwnershipMarker(
        block.heading_1.rich_text,
        intent.details.versionMarker,
      )
    );
  }

  private async verifyLiveResource(
    resource: ManagedResourceRecord,
  ): Promise<boolean> {
    let block;
    try {
      block = await this.notion.blocks.retrieve({ block_id: resource.blockID });
    } catch {
      return false;
    }
    return (
      isFullBlock(block) &&
      block.type === 'heading_1' &&
      !block.in_trash &&
      !block.archived &&
      block.id === resource.blockID &&
      block.created_by.id === resource.createdByID &&
      block.last_edited_time === resource.lastEditedTime &&
      parentMatches(block, resource.parent) &&
      hasExactOwnershipMarker(block.heading_1.rich_text, resource.marker) &&
      hasExactOwnershipMarker(block.heading_1.rich_text, resource.versionMarker)
    );
  }

  private createObservation(
    intent: Extract<
      OperationIntent,
      { kind: 'CREATE_CANDIDATE' | 'CREATE_CONTAINER' }
    >,
    block: BlockObjectResponse,
  ): RemoteOperationObservation {
    const managed = this.resourceFromBlock(block, intent);
    const created = this.evidence(intent, 'created', {
      remoteLastEditedTime: block.last_edited_time,
      returnedBlockIDs: [block.id],
    });
    if (intent.kind === 'CREATE_CONTAINER') {
      return { evidence: created, resource: managed, type: 'success' };
    }
    const plan = intent.details.candidatePlan;
    const candidate: CandidateRecord = {
      batchDigests: [],
      block: managed,
      completionEvidence: null,
      expectedBlockCount: plan.expectedBlockCount,
      expectedImageCount: plan.expectedImageCount,
      generation: intent.generation,
      imageAssetIdentities: plan.imageAssetIdentities,
      manifestDigest: plan.manifestDigest,
      nextBatchIndex: 0,
      previousActiveBlockID: plan.previousActiveBlockID,
      returnedBlockIDs: [],
      sourceVersion: intent.sourceVersion,
      status: 'staging',
      transactionID: intent.transactionID,
    };
    return { candidate, evidence: created, type: 'candidate-created' };
  }

  private async executeCreate(
    intent: Extract<
      OperationIntent,
      { kind: 'CREATE_CANDIDATE' | 'CREATE_CONTAINER' }
    >,
  ): Promise<RemoteOperationObservation> {
    if (
      intent.kind === 'CREATE_CANDIDATE' &&
      !(await this.verifyLiveResource(intent.details.container))
    ) {
      return {
        diagnostic: this.diagnostic(
          intent,
          'OWNERSHIP_CHANGED',
          'Canonical container ownership could not be verified before candidate creation',
        ),
        type: 'uncertain',
      };
    }
    try {
      const response = await this.notion.blocks.children.append({
        block_id: intent.details.parent.id,
        children: [
          {
            heading_1: {
              ...(intent.kind === 'CREATE_CONTAINER' &&
                intent.details.migrationNotice && {
                  children: [
                    {
                      paragraph: {
                        rich_text: [
                          {
                            text: { content: LEGACY_MIGRATION_NOTICE },
                            type: 'text' as const,
                          },
                        ],
                      },
                    },
                  ],
                }),
              is_toggleable: true,
              rich_text: buildManagedHeadingRichText(intent.details.title, [
                intent.details.marker,
                intent.details.versionMarker,
              ]),
            },
          },
        ],
      });
      const created = response.results[0];
      if (
        created &&
        isFullBlock(created) &&
        this.blockMatchesCreate(created, intent)
      ) {
        return this.createObservation(intent, created);
      }
      return this.observeCreate(intent);
    } catch (error) {
      if (isProvenUnexecuted(error)) return { type: 'proven-unexecuted' };
      if (isAmbiguousWrite(error)) return this.observeCreate(intent);
      throw error;
    }
  }

  private async observeCreate(
    intent: Extract<
      OperationIntent,
      { kind: 'CREATE_CANDIDATE' | 'CREATE_CONTAINER' }
    >,
  ): Promise<RemoteOperationObservation> {
    if (
      intent.kind === 'CREATE_CANDIDATE' &&
      !(await this.verifyLiveResource(intent.details.container))
    ) {
      return {
        diagnostic: this.diagnostic(
          intent,
          'OWNERSHIP_CHANGED',
          'Canonical container ownership could not be verified during reconciliation',
        ),
        type: 'uncertain',
      };
    }
    let matches: BlockObjectResponse[];
    try {
      matches = await this.findMatchingChildren(intent);
    } catch {
      return {
        diagnostic: this.diagnostic(
          intent,
          'PAGINATION_INCOMPLETE',
          'Managed block create reconciliation could not exhaust pagination',
        ),
        type: 'uncertain',
      };
    }
    if (matches.length === 1 && matches[0]) {
      return this.createObservation(intent, matches[0]);
    }
    if (
      matches.length === 0 &&
      Date.parse(this.runtime.now()) >=
        Date.parse(intent.details.isolationDeadline)
    ) {
      return { type: 'proven-unexecuted' };
    }
    return {
      diagnostic: this.diagnostic(
        intent,
        'AMBIGUOUS_REMOTE_RESULT',
        `Managed block create reconciliation found ${matches.length} exact matches`,
      ),
      type: 'uncertain',
    };
  }

  private async findMatchingChildren(
    intent: Extract<
      OperationIntent,
      { kind: 'CREATE_CANDIDATE' | 'CREATE_CONTAINER' }
    >,
  ): Promise<BlockObjectResponse[]> {
    const matches: BlockObjectResponse[] = [];
    let startCursor: string | undefined;
    for (let page = 0; page < MAX_CHILD_LIST_PAGES; page += 1) {
      const response = await this.notion.blocks.children.list({
        block_id: intent.details.parent.id,
        page_size: 100,
        ...(startCursor && { start_cursor: startCursor }),
      });
      for (const block of response.results) {
        if (isFullBlock(block) && this.blockMatchesCreate(block, intent)) {
          matches.push(block);
        }
      }
      if (!response.has_more) return matches;
      if (!response.next_cursor) {
        throw new Error('Notion child listing omitted its continuation cursor');
      }
      startCursor = response.next_cursor;
    }
    throw new Error('Notion child listing exceeded its bounded page budget');
  }

  private cleanupTarget(
    intent:
      | AppendIntent
      | Extract<OperationIntent, { kind: 'FINALIZE_CANDIDATE' }>,
  ): CleanupTarget {
    return {
      generation: intent.generation,
      reason: 'aborted-candidate',
      resource: intent.details.candidate,
      sourceVersion: intent.sourceVersion,
      status: 'pending',
      transactionID: intent.transactionID,
    };
  }

  private async executeAppend(
    intent: AppendIntent,
  ): Promise<RemoteOperationObservation> {
    if (!(await this.verifyLiveResource(intent.details.candidate))) {
      return this.appendUnknown(intent);
    }
    try {
      const response = await this.notion.blocks.children.append({
        block_id: intent.details.candidate.blockID,
        children: await this.payloads.getAppendBatch(intent),
      });
      const returnedBlockIDs = response.results
        .filter(isFullBlock)
        .map(({ id }) => id);
      if (returnedBlockIDs.length !== intent.details.expectedBlockCount) {
        return this.appendUnknown(intent);
      }
      return {
        evidence: this.evidence(intent, 'written', { returnedBlockIDs }),
        type: 'success',
      };
    } catch {
      return this.appendUnknown(intent);
    }
  }

  private async appendUnknown(
    intent: AppendIntent,
  ): Promise<RemoteOperationObservation> {
    const attachedUploads: UploadAssetRecord[] = [];
    for (const upload of intent.details.fileUploads) {
      if (!upload.fileUploadID) continue;
      try {
        const observed = await this.uploads.retrieve(upload.fileUploadID);
        if (observed.status === 'uploaded' && observed.expiry_time === null) {
          attachedUploads.push({
            ...upload,
            attachedAt: this.runtime.now(),
            expiryTime: null,
            status: 'attached',
          });
        }
      } catch {
        // Candidate abandonment does not depend on upload status. Unknown file
        // evidence is preserved in its prior state and is never guessed.
      }
    }
    return {
      attachedUploads,
      cleanupTarget: this.cleanupTarget(intent),
      type: 'append-unknown',
    };
  }

  private async executeFinalization(
    intent: Extract<OperationIntent, { kind: 'FINALIZE_CANDIDATE' }>,
  ): Promise<RemoteOperationObservation> {
    try {
      await this.notion.blocks.update({
        block_id: intent.details.candidate.blockID,
        heading_1: {
          is_toggleable: true,
          rich_text: buildManagedHeadingRichText(intent.details.finalTitle, [
            intent.details.ownershipMarker,
            intent.details.versionMarker,
          ]),
        },
      });
    } catch (error) {
      if (!isAmbiguousWrite(error) && !isProvenUnexecuted(error)) throw error;
    }
    return this.observeFinalization(intent);
  }

  private async observeFinalization(
    intent: Extract<OperationIntent, { kind: 'FINALIZE_CANDIDATE' }>,
  ): Promise<RemoteOperationObservation> {
    let block;
    try {
      block = await this.notion.blocks.retrieve({
        block_id: intent.details.candidate.blockID,
      });
    } catch (error) {
      return {
        diagnostic: this.diagnostic(
          intent,
          isNotFound(error) ? 'REMOTE_NOT_FOUND' : 'AMBIGUOUS_REMOTE_RESULT',
          'Candidate finalization could not be observed exactly',
        ),
        type: 'finalization-unknown',
      };
    }
    if (!isFullBlock(block) || block.type !== 'heading_1') {
      return {
        diagnostic: this.diagnostic(
          intent,
          'OWNERSHIP_CHANGED',
          'Candidate finalization returned an unexpected block',
        ),
        type: 'finalization-unknown',
      };
    }
    const finalMatches =
      block.id === intent.details.candidate.blockID &&
      !block.in_trash &&
      !block.archived &&
      block.created_by.id === intent.details.candidate.createdByID &&
      parentMatches(block, intent.details.candidate.parent) &&
      block.heading_1.rich_text[0]?.plain_text === intent.details.finalTitle &&
      hasExactOwnershipMarker(
        block.heading_1.rich_text,
        intent.details.ownershipMarker,
      ) &&
      hasExactOwnershipMarker(
        block.heading_1.rich_text,
        intent.details.versionMarker,
      );
    if (finalMatches) {
      const finalBlock: ManagedResourceRecord = {
        ...intent.details.candidate,
        kind: 'note',
        lastEditedTime: block.last_edited_time,
        marker: intent.details.ownershipMarker,
        operationID: intent.operationID,
        versionMarker: intent.details.versionMarker,
      };
      const finalization = this.evidence(intent, 'finalized', {
        remoteLastEditedTime: block.last_edited_time,
      });
      return {
        completionEvidence: {
          completedAt: this.runtime.now(),
          finalization,
          manifestDigest: intent.details.manifestDigest,
          verifiedAt: this.runtime.now(),
        },
        finalBlock,
        type: 'candidate-finalized',
      };
    }
    const stagingStillMatches =
      block.id === intent.details.candidate.blockID &&
      !block.in_trash &&
      !block.archived &&
      block.created_by.id === intent.details.candidate.createdByID &&
      parentMatches(block, intent.details.candidate.parent) &&
      hasExactOwnershipMarker(
        block.heading_1.rich_text,
        intent.details.candidate.marker,
      ) &&
      hasExactOwnershipMarker(
        block.heading_1.rich_text,
        intent.details.candidate.versionMarker,
      );
    return stagingStillMatches
      ? {
          cleanupTarget: this.cleanupTarget(intent),
          type: 'finalization-unknown',
        }
      : {
          diagnostic: this.diagnostic(
            intent,
            'OWNERSHIP_CHANGED',
            'Candidate title, marker, creator, or parent changed unexpectedly',
          ),
          type: 'finalization-unknown',
        };
  }

  private blockMatchesDelete(
    block: BlockObjectResponse,
    intent: Extract<OperationIntent, { kind: 'DELETE_BLOCK' }>,
    allowEditedTimeChange: boolean,
  ): boolean {
    return (
      block.id === intent.details.exactBlockID &&
      block.type === 'heading_1' &&
      block.created_by.id === intent.details.expectedCreator &&
      parentMatches(block, intent.details.expectedParent) &&
      hasExactOwnershipMarker(
        block.heading_1.rich_text,
        intent.details.expectedOwnershipMarker,
      ) &&
      hasExactOwnershipMarker(
        block.heading_1.rich_text,
        intent.details.expectedVersionMarker,
      ) &&
      (allowEditedTimeChange ||
        block.last_edited_time === intent.details.expectedLastEditedTime)
    );
  }

  private async executeDelete(
    intent: Extract<OperationIntent, { kind: 'DELETE_BLOCK' }>,
  ): Promise<RemoteOperationObservation> {
    let existing;
    try {
      existing = await this.notion.blocks.retrieve({
        block_id: intent.details.exactBlockID,
      });
    } catch (error) {
      return {
        diagnostic: this.diagnostic(
          intent,
          isNotFound(error) ? 'REMOTE_NOT_FOUND' : 'AMBIGUOUS_REMOTE_RESULT',
          'Delete target cannot be observed; 404 is not deletion proof',
        ),
        type: 'uncertain',
      };
    }
    if (!isFullBlock(existing)) {
      return {
        diagnostic: this.diagnostic(
          intent,
          'OWNERSHIP_CHANGED',
          'Delete target is not a complete Notion block',
        ),
        type: 'uncertain',
      };
    }
    if (existing.in_trash || existing.archived) {
      return this.blockMatchesDelete(existing, intent, true)
        ? { evidence: this.evidence(intent, 'deleted'), type: 'success' }
        : {
            diagnostic: this.diagnostic(
              intent,
              'OWNERSHIP_CHANGED',
              'Trashed delete target no longer matches durable intent',
            ),
            type: 'uncertain',
          };
    }
    if (!this.blockMatchesDelete(existing, intent, false)) {
      return {
        diagnostic: this.diagnostic(
          intent,
          'OWNERSHIP_CHANGED',
          'Live delete target changed after DELETE_INTENT was persisted',
        ),
        type: 'uncertain',
      };
    }
    try {
      const deleted = await this.notion.blocks.delete({
        block_id: intent.details.exactBlockID,
      });
      if (
        isFullBlock(deleted) &&
        deleted.id === intent.details.exactBlockID &&
        deleted.in_trash
      ) {
        return { evidence: this.evidence(intent, 'deleted'), type: 'success' };
      }
    } catch {
      // Observation below deliberately treats 404 as unknown.
    }
    return {
      diagnostic: this.diagnostic(
        intent,
        'AMBIGUOUS_REMOTE_RESULT',
        'Notion delete response did not prove in_trash=true',
      ),
      type: 'uncertain',
    };
  }

  private uploadAsset(
    intent: Extract<OperationIntent, { kind: 'UPLOAD_CREATE' | 'UPLOAD_SEND' }>,
    upload: FileUploadObjectResponse,
  ): UploadAssetRecord {
    const status =
      upload.status === 'uploaded'
        ? upload.expiry_time === null
          ? 'attached'
          : 'uploaded'
        : upload.status === 'expired'
          ? 'expired'
          : upload.status === 'failed'
            ? 'failed'
            : 'created-unsent';
    return {
      attachedAt: status === 'attached' ? this.runtime.now() : null,
      attachmentKey: intent.details.attachmentKey,
      contentHash: intent.details.contentHash,
      contentLength: intent.details.contentLength,
      contentType: intent.details.contentType,
      createOperationID:
        intent.kind === 'UPLOAD_CREATE'
          ? intent.operationID
          : intent.details.createOperationID,
      expiryTime: upload.expiry_time,
      fileUploadID: upload.id,
      filename: intent.details.filename,
      generation: intent.generation,
      sendOperationID:
        intent.kind === 'UPLOAD_SEND' ? intent.operationID : null,
      sourceVersion: intent.sourceVersion,
      status,
      targetIdentity: intent.targetIdentity,
      transactionID: intent.transactionID,
    };
  }

  private uploadObservation(
    intent: Extract<OperationIntent, { kind: 'UPLOAD_CREATE' | 'UPLOAD_SEND' }>,
    upload: FileUploadObjectResponse,
  ): RemoteOperationObservation {
    return {
      asset: this.uploadAsset(intent, upload),
      evidence: this.evidence(
        intent,
        upload.status === 'uploaded' ? 'uploaded' : 'created',
      ),
      type: 'upload-observed',
    };
  }

  private async executeUploadCreate(
    intent: Extract<OperationIntent, { kind: 'UPLOAD_CREATE' }>,
  ): Promise<RemoteOperationObservation> {
    try {
      const created = await this.uploads.create({
        contentType: requireSupportedImageContentType(
          intent.details.contentType,
        ),
        filename: intent.details.filename,
        size: intent.details.contentLength,
      });
      return this.uploadObservation(intent, created);
    } catch (error) {
      if (isProvenUnexecuted(error)) return { type: 'proven-unexecuted' };
      return this.observeUploadCreate(intent);
    }
  }

  private async observeUploadCreate(
    intent: Extract<OperationIntent, { kind: 'UPLOAD_CREATE' }>,
  ): Promise<RemoteOperationObservation> {
    try {
      const match = await this.uploads.reconcileCreate({
        connectionID: intent.targetIdentity.connectionID,
        contentLength: intent.details.contentLength,
        contentType: intent.details.contentType,
        filename: intent.details.filename,
        isolationDeadline: new Date(intent.details.isolationDeadline),
        requestStartedAt: new Date(intent.details.requestStartedAt),
      });
      if (match) return this.uploadObservation(intent, match);
      if (
        Date.parse(this.runtime.now()) >=
        Date.parse(intent.details.isolationDeadline)
      ) {
        return { type: 'proven-unexecuted' };
      }
    } catch (error) {
      if (!(error instanceof UploadReconciliationAmbiguousError)) throw error;
    }
    return {
      diagnostic: this.diagnostic(
        intent,
        'AMBIGUOUS_REMOTE_RESULT',
        'File Upload create reconciliation did not find exactly one match',
      ),
      type: 'uncertain',
    };
  }

  private async executeUploadSend(
    intent: UploadSendIntent,
  ): Promise<RemoteOperationObservation> {
    const current = await this.uploads.retrieve(intent.details.fileUploadID);
    if (current.status !== 'pending') {
      return this.uploadObservation(intent, current);
    }
    try {
      await this.uploads.sendCreated(
        await this.payloads.getUploadBytes(intent),
        current,
      );
    } catch {
      return this.observeUploadSend(intent);
    }
    return this.observeUploadSend(intent);
  }

  private async observeUploadSend(
    intent: UploadSendIntent,
  ): Promise<RemoteOperationObservation> {
    try {
      const observed = await this.uploads.retrieve(intent.details.fileUploadID);
      if (observed.status !== 'pending') {
        return this.uploadObservation(intent, observed);
      }
    } catch {
      // Never resend bytes after SEND_INTENT; an unreadable result is unknown.
    }
    return {
      diagnostic: this.diagnostic(
        intent,
        'AMBIGUOUS_REMOTE_RESULT',
        'File Upload send remains pending or unreadable; bytes will not be resent',
      ),
      type: 'uncertain',
    };
  }
}
