import {
  APIResponseError,
  RequestTimeoutError,
  type Client,
  isFullBlock,
  isFullPage,
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
  type NotionImageUploadService,
  RemoteWriteResultUncertainError,
  type UploadMutationAttempt,
  UploadReconciliationAmbiguousError,
} from '../notion-image-upload-service';

import { canonicalJSON } from './canonical';
import {
  asRemoteCreatorIdentity,
  deriveFileUploadBindingDigest,
  knownRemoteCreator,
  recomputeOperationRequestDigest,
} from './identity-v4';
import { deriveNotionBlockFingerprint } from './notion-block-fingerprint-v4';
import type {
  RemoteMutationReauthorizerV4,
  RemoteMutationAttemptV4,
  RemoteOperationAdapterV4,
  RemoteOperationResultV4,
} from './remote-operation-v4';
import type { RuntimeClock } from './runtime-clock';
import type {
  ManagedResourceIdentity,
  MutationAuthorization,
  OwnershipExpectation,
  RemoteObservation,
  RemoteParent,
  RemoteCreatorIdentity,
  RemoteVerificationState,
  SealedOperationIntent,
  UploadAssetRecordV4,
  VerifyCandidateDetails,
} from './types-v4';

const MAX_CHILD_LIST_PAGES = 100;
const MAX_HYDRATION_DEPTH = 8;
const LEGACY_MIGRATION_NOTICE =
  'Notero created new managed note copies and left all legacy synchronized blocks unchanged. Duplicate note content may remain until you manually review and remove the legacy blocks.';

type HeadingBlock = Extract<BlockObjectResponse, { type: 'heading_1' }>;
type CreateIntent = Extract<
  SealedOperationIntent,
  { kind: 'CREATE_CANDIDATE' | 'CREATE_CONTAINER' }
>;
type AppendIntent = Extract<SealedOperationIntent, { kind: 'APPEND_BATCH' }>;
type VerifyIntent = Extract<
  SealedOperationIntent,
  { kind: 'VERIFY_CANDIDATE' }
>;
type FinalizeIntent = Extract<
  SealedOperationIntent,
  { kind: 'FINALIZE_CANDIDATE' }
>;
type UploadCreateIntent = Extract<
  SealedOperationIntent,
  { kind: 'UPLOAD_CREATE' }
>;
type UploadSendIntent = Extract<SealedOperationIntent, { kind: 'UPLOAD_SEND' }>;
type DeleteIntent = Extract<SealedOperationIntent, { kind: 'DELETE_BLOCK' }>;
type LivenessIntent = Extract<
  SealedOperationIntent,
  { kind: 'VERIFY_LIVENESS' }
>;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export type NotionBlocksClientV4 = {
  blocks: Pick<Client['blocks'], 'delete' | 'retrieve' | 'update'> & {
    children: Pick<Client['blocks']['children'], 'append' | 'list'>;
  };
  pages: Pick<Client['pages'], 'retrieve'>;
};

export type NotionUploadGatewayV4 = Pick<
  NotionImageUploadService,
  'create' | 'reconcileCreate' | 'retrieve' | 'sendCreated'
>;

export type OperationPayloadProviderV4 = {
  getAppendBatch: (intent: AppendIntent) => Promise<BlockObjectRequest[]>;
  getUploadBytes: (intent: UploadSendIntent) => Promise<ResolvedNoteImage>;
};

type ManagedRead =
  | { block: HeadingBlock; type: 'EXACT' }
  | { type: 'MISMATCH' }
  | { type: 'NOT_FOUND' }
  | { result: RemoteOperationResultV4; type: 'FAILED' };

type BeforeMutationV4 = (
  attempt: RemoteMutationAttemptV4,
) => Promise<RemoteOperationResultV4 | null>;

class LocalMutationAuthorizationError extends Error {
  public readonly name = 'LocalMutationAuthorizationError';

  public constructor(public readonly result: RemoteOperationResultV4) {
    super('The durable mutation authorization changed before the SDK call');
  }
}

function parentMatches(block: BlockObjectResponse, expected: RemoteParent) {
  return expected.type === 'page_id'
    ? block.parent.type === 'page_id' && block.parent.page_id === expected.id
    : block.parent.type === 'block_id' && block.parent.block_id === expected.id;
}

function isAmbiguousWrite(error: unknown): boolean {
  return (
    RequestTimeoutError.isRequestTimeoutError(error) ||
    error instanceof TypeError ||
    (error instanceof APIResponseError &&
      [500, 502, 503, 504, 529].includes(error.status)) ||
    error instanceof RemoteWriteResultUncertainError
  );
}

function redactedErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownRemoteError';
}

function responseHeader(
  error: APIResponseError,
  name: string,
): string | undefined {
  if (error.headers instanceof Headers) {
    return error.headers.get(name) || undefined;
  }
  const entry = Object.entries(error.headers || {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

function requiredImageContentType(
  value: string,
): ResolvedNoteImage['contentType'] {
  if (
    value === 'image/gif' ||
    value === 'image/jpeg' ||
    value === 'image/png' ||
    value === 'image/webp'
  ) {
    return value;
  }
  throw new Error('Unsupported embedded image content type');
}

function assertNever(value: never): never {
  throw new Error(`Unsupported operation kind: ${JSON.stringify(value)}`);
}

export class NotionOperationAdapterV2 implements RemoteOperationAdapterV4 {
  private readonly consumedAuthorizations = new Set<string>();

  public constructor(
    private readonly notion: NotionBlocksClientV4,
    private readonly payloads: OperationPayloadProviderV4,
    private readonly uploads: NotionUploadGatewayV4,
    private readonly clock: RuntimeClock,
  ) {}

  public async execute(
    authorization: MutationAuthorization,
    reauthorize: RemoteMutationReauthorizerV4,
  ): Promise<RemoteOperationResultV4> {
    const intent = this.consumeAuthorization(authorization);
    const beforeMutation = this.beforeMutation(authorization, reauthorize);
    switch (intent.kind) {
      case 'CREATE_CONTAINER':
      case 'CREATE_CANDIDATE':
        return this.executeCreate(intent, beforeMutation);
      case 'APPEND_BATCH':
        return this.executeAppend(intent, beforeMutation);
      case 'FINALIZE_CANDIDATE':
        return this.executeFinalize(intent, beforeMutation);
      case 'VERIFY_CANDIDATE':
      case 'VERIFY_LIVENESS':
        return this.observe(intent);
      case 'UPLOAD_CREATE':
        return this.executeUploadCreate(intent, beforeMutation);
      case 'UPLOAD_SEND':
        return this.executeUploadSend(intent, beforeMutation);
      case 'DELETE_BLOCK':
        return this.executeDelete(intent, beforeMutation);
    }
    return assertNever(intent);
  }

  public async observe(
    intent: SealedOperationIntent,
  ): Promise<RemoteOperationResultV4> {
    if (recomputeOperationRequestDigest(intent) !== intent.requestDigest) {
      return this.rejected(
        'VALIDATION_FAILED',
        'INVALID_REQUEST_DIGEST',
        'Operation request identity is invalid',
      );
    }
    switch (intent.kind) {
      case 'CREATE_CONTAINER':
      case 'CREATE_CANDIDATE':
        return this.observeCreate(intent);
      case 'APPEND_BATCH':
        return this.observeAppend(intent);
      case 'FINALIZE_CANDIDATE':
        return this.observeFinalize(intent);
      case 'VERIFY_CANDIDATE':
        return this.observeCandidate(intent);
      case 'VERIFY_LIVENESS':
        return this.observeLiveness(intent);
      case 'UPLOAD_CREATE':
        return this.observeUploadCreate(intent);
      case 'UPLOAD_SEND':
        return this.observeUploadSend(intent);
      case 'DELETE_BLOCK':
        return this.observeDelete(intent);
    }
    return assertNever(intent);
  }

  private consumeAuthorization(
    authorization: MutationAuthorization,
  ): SealedOperationIntent {
    const { intent, lease, oneTimeToken } = authorization;
    if (!oneTimeToken || this.consumedAuthorizations.has(oneTimeToken)) {
      throw new Error('Remote authorization token is missing or reused');
    }
    if (
      intent.status !== 'EXECUTABLE' ||
      intent.leaseID !== lease.leaseID ||
      intent.leaseEpoch !== lease.leaseEpoch ||
      intent.processSessionID !== lease.processSessionID ||
      recomputeOperationRequestDigest(intent) !== intent.requestDigest ||
      this.clock.compare(lease.expiresAt, this.clock.nowISOString()) <= 0
    ) {
      throw new Error('Remote authorization is stale or inconsistent');
    }
    this.consumedAuthorizations.add(oneTimeToken);
    return intent;
  }

  private beforeMutation(
    initial: MutationAuthorization,
    reauthorize: RemoteMutationReauthorizerV4,
  ): BeforeMutationV4 {
    return async (attempt) => {
      let refreshed: MutationAuthorization;
      let refreshedIntent: SealedOperationIntent;
      try {
        refreshed = await reauthorize(attempt);
        refreshedIntent = this.consumeAuthorization(refreshed);
      } catch {
        return {
          responseClassification: 'local-authorization-unavailable',
          type: 'PROVEN_UNEXECUTED',
        };
      }
      if (
        refreshed.noteRevision !== initial.noteRevision ||
        refreshed.rootRevision !== initial.rootRevision ||
        canonicalJSON(refreshedIntent) !== canonicalJSON(initial.intent) ||
        canonicalJSON(refreshed.lease) !== canonicalJSON(initial.lease)
      ) {
        return {
          responseClassification: 'local-authorization-changed',
          type: 'PROVEN_UNEXECUTED',
        };
      }
      return null;
    };
  }

  private observation(
    intent: SealedOperationIntent,
    values: Partial<RemoteObservation> = {},
  ): RemoteObservation {
    return {
      attachedUploadIDs: [],
      blockFingerprints: [],
      deletionProof: null,
      generation: intent.generation,
      observedAt: this.clock.nowISOString(),
      operationID: intent.operationID,
      outcome: 'UNKNOWN',
      remoteResource: null,
      requestDigest: intent.requestDigest,
      responseClassification: 'unknown',
      returnedBlockIDs: [],
      sourceVersion: intent.sourceVersion,
      targetIdentityDigest: intent.targetIdentityDigest,
      transactionID: intent.transactionID,
      upload: null,
      ...values,
    };
  }

  private rejected(
    classification: Extract<
      RemoteOperationResultV4,
      { type: 'REJECTED' }
    >['classification'],
    responseClassification: string,
    redactedMessage: string,
  ): RemoteOperationResultV4 {
    return {
      classification,
      proof: 'NOT_EXECUTED',
      redactedMessage,
      responseClassification,
      type: 'REJECTED',
    };
  }

  private uncertain(
    responseClassification: string,
    reasonCode: string,
    lastObservation: RemoteObservation | null = null,
  ): RemoteOperationResultV4 {
    return {
      lastObservation,
      reasonCode,
      redactedMessage: 'Remote result requires explicit verification',
      requiredRepair: 'VERIFY_REMOTE_RESOURCE',
      responseClassification,
      type: 'UNCERTAIN',
    };
  }

  private errorResult(error: unknown): RemoteOperationResultV4 {
    if (error instanceof APIResponseError) {
      if (error.status === 400) {
        return this.rejected(
          'VALIDATION_FAILED',
          'http-400',
          'Notion rejected the request',
        );
      }
      if (error.status === 401) {
        return this.rejected(
          'AUTH_REQUIRED',
          'http-401',
          'Notion authentication is required',
        );
      }
      if (error.status === 403) {
        return this.rejected(
          'PERMISSION_REQUIRED',
          'http-403',
          'Notion permission is required',
        );
      }
      if (error.status === 409 || error.status === 429) {
        const now = this.clock.nowISOString();
        const retryAfter = responseHeader(error, 'retry-after');
        const seconds = retryAfter === undefined ? NaN : Number(retryAfter);
        const retryDate = retryAfter ? Date.parse(retryAfter) : NaN;
        const retryDateISOString = Number.isFinite(retryDate)
          ? this.clock.addMs(now, retryDate - Date.parse(now))
          : null;
        const nextRetryAt =
          Number.isFinite(seconds) && seconds >= 0
            ? this.clock.addMs(now, Math.max(1_000, seconds * 1_000))
            : retryDateISOString !== null &&
                this.clock.compare(retryDateISOString, now) > 0
              ? retryDateISOString
              : this.clock.addMs(now, error.status === 429 ? 5_000 : 1_000);
        return {
          nextRetryAt,
          responseClassification: `http-${error.status}`,
          type: 'PROVEN_UNEXECUTED',
        };
      }
    }
    return this.uncertain(
      `exception-${redactedErrorName(error)}`,
      'REMOTE_OUTCOME_UNKNOWN',
    );
  }

  private readErrorResult(error: unknown): RemoteOperationResultV4 {
    if (error instanceof APIResponseError) {
      if (error.status === 401) {
        return this.rejected(
          'AUTH_REQUIRED',
          'http-401',
          'Notion authentication is required',
        );
      }
      if (error.status === 403) {
        return this.rejected(
          'PERMISSION_REQUIRED',
          'http-403',
          'Notion permission is required',
        );
      }
    }
    return this.uncertain(
      `read-${redactedErrorName(error)}`,
      'REMOTE_READ_UNRESOLVED',
    );
  }

  private headingMatches(
    block: HeadingBlock,
    expected: {
      createdByID: RemoteCreatorIdentity;
      lastEditedTime?: string;
      operationMarker: string;
      ownershipMarker: string;
      parent: RemoteParent;
      title?: string;
      versionMarker: string;
    },
    allowTrashed = false,
  ): boolean {
    const trashStateIsValid = allowTrashed
      ? block.in_trash === block.archived
      : !block.in_trash && !block.archived;
    return (
      trashStateIsValid &&
      block.heading_1.is_toggleable &&
      block.created_by.id === expected.createdByID &&
      (!expected.lastEditedTime ||
        block.last_edited_time === expected.lastEditedTime) &&
      parentMatches(block, expected.parent) &&
      (expected.title === undefined ||
        block.heading_1.rich_text[0]?.plain_text === expected.title) &&
      hasExactOwnershipMarker(
        block.heading_1.rich_text,
        expected.operationMarker,
      ) &&
      hasExactOwnershipMarker(
        block.heading_1.rich_text,
        expected.ownershipMarker,
      ) &&
      hasExactOwnershipMarker(block.heading_1.rich_text, expected.versionMarker)
    );
  }

  private resourceFromHeading(
    block: HeadingBlock,
    expected: {
      kind: ManagedResourceIdentity['kind'];
      operationMarker: string;
      ownershipMarker: string;
      parent: RemoteParent;
      targetIdentityDigest: string;
      versionMarker: string;
    },
  ): ManagedResourceIdentity {
    return {
      blockID: block.id,
      createdByID: asRemoteCreatorIdentity(block.created_by.id),
      kind: expected.kind,
      lastEditedTime: block.last_edited_time,
      operationMarker: expected.operationMarker,
      ownershipMarker: expected.ownershipMarker,
      parent: expected.parent,
      targetIdentityDigest: expected.targetIdentityDigest,
      versionMarker: expected.versionMarker,
    };
  }

  private async readManaged(
    resource: ManagedResourceIdentity,
    options: {
      allowEditedTimeChange?: boolean;
      allowTrashed?: boolean;
      expectedTitle?: string;
    } = {},
  ): Promise<ManagedRead> {
    let response;
    try {
      response = await this.notion.blocks.retrieve({
        block_id: resource.blockID,
      });
    } catch (error) {
      if (error instanceof APIResponseError && error.status === 404) {
        return { type: 'NOT_FOUND' };
      }
      return { result: this.readErrorResult(error), type: 'FAILED' };
    }
    if (!isFullBlock(response) || response.type !== 'heading_1') {
      return { type: 'MISMATCH' };
    }
    const matches = this.headingMatches(
      response,
      {
        createdByID: resource.createdByID,
        ...(!options.allowEditedTimeChange && {
          lastEditedTime: resource.lastEditedTime,
        }),
        operationMarker: resource.operationMarker,
        ownershipMarker: resource.ownershipMarker,
        parent: resource.parent,
        ...(options.expectedTitle !== undefined && {
          title: options.expectedTitle,
        }),
        versionMarker: resource.versionMarker,
      },
      options.allowTrashed,
    );
    return matches && response.id === resource.blockID
      ? { block: response, type: 'EXACT' }
      : { type: 'MISMATCH' };
  }

  private creationMatches(block: HeadingBlock, intent: CreateIntent): boolean {
    const details = intent.details;
    const expectedCreator = knownRemoteCreator(details.expectedCreator);
    const title =
      intent.kind === 'CREATE_CONTAINER'
        ? intent.details.title
        : intent.details.stagingTitle;
    return (
      block.id.length > 0 &&
      this.headingMatches(block, {
        createdByID:
          expectedCreator || asRemoteCreatorIdentity(block.created_by.id),
        operationMarker: details.operationMarker,
        ownershipMarker: details.ownershipMarker,
        parent: details.parent,
        title,
        versionMarker: details.versionMarker,
      }) &&
      this.clock.compare(block.created_time, details.requestStartedAt) >= 0 &&
      this.clock.compare(block.created_time, details.isolationDeadline) <= 0
    );
  }

  private creationObservation(
    block: HeadingBlock,
    intent: CreateIntent,
  ): RemoteOperationResultV4 {
    const details = intent.details;
    const resource = this.resourceFromHeading(block, {
      kind: intent.kind === 'CREATE_CONTAINER' ? 'container' : 'note',
      operationMarker: details.operationMarker,
      ownershipMarker: details.ownershipMarker,
      parent: details.parent,
      targetIdentityDigest:
        intent.kind === 'CREATE_CONTAINER'
          ? intent.details.resourceTargetIdentityDigest
          : intent.targetIdentityDigest,
      versionMarker: details.versionMarker,
    });
    return {
      observation: this.observation(intent, {
        outcome: 'CREATED',
        remoteResource: resource,
        responseClassification: 'exact-create',
        returnedBlockIDs: [block.id],
      }),
      type: 'OBSERVED',
    };
  }

  private async verifyContainerParent(
    intent: Extract<CreateIntent, { kind: 'CREATE_CONTAINER' }>,
  ): Promise<RemoteOperationResultV4 | null> {
    if (intent.details.parent.type !== 'page_id') {
      return this.rejected(
        'VALIDATION_FAILED',
        'container-parent-not-page',
        'The managed container target is not a page',
      );
    }
    let page;
    try {
      page = await this.notion.pages.retrieve({
        page_id: intent.details.parent.id,
      });
    } catch (error) {
      return this.readErrorResult(error);
    }
    if (!isFullPage(page) || page.id !== intent.details.parent.id) {
      return this.rejected(
        'VALIDATION_FAILED',
        'container-parent-partial-or-mismatched',
        'The Notion target page could not be validated',
      );
    }
    if (page.in_trash || page.archived) {
      return this.uncertain(
        'container-parent-unavailable',
        'OWNERSHIP_CHANGED',
      );
    }
    return null;
  }

  private async executeCreate(
    intent: CreateIntent,
    beforeMutation: BeforeMutationV4,
  ): Promise<RemoteOperationResultV4> {
    if (intent.kind === 'CREATE_CONTAINER') {
      const parentFailure = await this.verifyContainerParent(intent);
      if (parentFailure) return parentFailure;
    } else {
      const parent = await this.readManaged(intent.details.container);
      if (parent.type === 'FAILED') return parent.result;
      if (parent.type !== 'EXACT') {
        return this.uncertain(
          `candidate-parent-${parent.type.toLowerCase()}`,
          'OWNERSHIP_CHANGED',
        );
      }
    }
    const details = intent.details;
    const title =
      intent.kind === 'CREATE_CONTAINER'
        ? intent.details.title
        : intent.details.stagingTitle;
    const authorizationFailure = await beforeMutation({
      attempt: 1,
      mutation: 'blocks.children.append',
    });
    if (authorizationFailure) return authorizationFailure;
    try {
      const response = await this.notion.blocks.children.append({
        block_id: details.parent.id,
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
              rich_text: buildManagedHeadingRichText(title, [
                details.operationMarker,
                details.ownershipMarker,
                details.versionMarker,
              ]),
            },
          },
        ],
      });
      const first = response.results[0];
      if (
        first &&
        isFullBlock(first) &&
        first.type === 'heading_1' &&
        this.creationMatches(first, intent)
      ) {
        return this.creationObservation(first, intent);
      }
      return this.observeCreate(intent);
    } catch (error) {
      const classified = this.errorResult(error);
      if (isAmbiguousWrite(error)) return this.observeCreate(intent);
      return classified;
    }
  }

  private async observeCreate(
    intent: CreateIntent,
  ): Promise<RemoteOperationResultV4> {
    if (intent.kind === 'CREATE_CANDIDATE') {
      const parent = await this.readManaged(intent.details.container, {
        allowEditedTimeChange: true,
      });
      if (parent.type === 'FAILED') return parent.result;
      if (parent.type !== 'EXACT') {
        return this.uncertain(
          `candidate-parent-${parent.type.toLowerCase()}`,
          'OWNERSHIP_CHANGED',
        );
      }
    }
    let children: BlockObjectResponse[];
    try {
      children = await this.listFullChildren(intent.details.parent.id);
    } catch (error) {
      return this.uncertain(
        `create-reconciliation-${redactedErrorName(error)}`,
        'PAGINATION_INCOMPLETE',
      );
    }
    const matches = children.filter(
      (block): block is HeadingBlock =>
        block.type === 'heading_1' && this.creationMatches(block, intent),
    );
    if (
      knownRemoteCreator(intent.details.expectedCreator) &&
      matches.length === 1 &&
      matches[0]
    ) {
      return this.creationObservation(matches[0], intent);
    }
    if (
      matches.length === 0 &&
      this.clock.compare(
        this.clock.nowISOString(),
        intent.details.isolationDeadline,
      ) >= 0
    ) {
      return {
        responseClassification: 'isolation-window-empty',
        type: 'PROVEN_UNEXECUTED',
      };
    }
    return this.uncertain(
      `create-match-count-${matches.length}`,
      'AMBIGUOUS_REMOTE_RESULT',
    );
  }

  private async executeAppend(
    intent: AppendIntent,
    beforeMutation: BeforeMutationV4,
  ): Promise<RemoteOperationResultV4> {
    let payload: BlockObjectRequest[];
    try {
      payload = await this.payloads.getAppendBatch(intent);
    } catch {
      return this.rejected(
        'VALIDATION_FAILED',
        'local-payload-unavailable',
        'The frozen source payload is unavailable',
      );
    }
    const fingerprints = payload.map((block, blockIndex) =>
      deriveNotionBlockFingerprint(block, {
        batchIndex: intent.details.batchIndex,
        blockIndex,
        sourceVersion: intent.sourceVersion,
      }),
    );
    if (
      payload.length !== intent.details.expectedBlockCount ||
      JSON.stringify(fingerprints) !==
        JSON.stringify(intent.details.blockFingerprints)
    ) {
      return this.rejected(
        'VALIDATION_FAILED',
        'local-payload-mismatch',
        'The frozen source payload no longer matches its operation intent',
      );
    }
    // This is the ownership-sensitive pre-write read. It intentionally occurs
    // after payload preparation and immediately before children.append().
    const candidate = await this.readManaged(intent.details.candidate, {
      expectedTitle: intent.details.expectedTitle,
    });
    if (candidate.type === 'FAILED') return candidate.result;
    if (candidate.type !== 'EXACT') {
      return this.uncertain(
        `append-owner-${candidate.type.toLowerCase()}`,
        'OWNERSHIP_CHANGED',
      );
    }
    const authorizationFailure = await beforeMutation({
      attempt: 1,
      mutation: 'blocks.children.append',
    });
    if (authorizationFailure) return authorizationFailure;
    try {
      await this.notion.blocks.children.append({
        block_id: intent.details.candidate.blockID,
        children: payload,
      });
      return this.observeAppend(intent);
    } catch (error) {
      if (isAmbiguousWrite(error)) return this.observeAppend(intent);
      return this.errorResult(error);
    }
  }

  private async observeAppend(
    intent: AppendIntent,
  ): Promise<RemoteOperationResultV4> {
    const candidate = await this.readManaged(intent.details.candidate, {
      allowEditedTimeChange: true,
      expectedTitle: intent.details.expectedTitle,
    });
    if (candidate.type === 'FAILED') return candidate.result;
    if (candidate.type !== 'EXACT') {
      return this.uncertain(
        `append-observation-owner-${candidate.type.toLowerCase()}`,
        'OWNERSHIP_CHANGED',
      );
    }
    let children: BlockObjectResponse[];
    try {
      children = await this.listFullChildren(intent.details.candidate.blockID);
    } catch (error) {
      return this.uncertain(
        `append-list-${redactedErrorName(error)}`,
        'PAGINATION_INCOMPLETE',
      );
    }
    const ids = children.map(({ id }) => id);
    const prefix = intent.details.precedingBlockIDs;
    const prefixMatches = prefix.every((id, index) => ids[index] === id);
    if (!prefixMatches) {
      return this.uncertain(
        'append-prefix-mismatch',
        'REMOTE_CONTENT_CHANGED',
        this.observation(intent, {
          outcome: 'MISMATCH',
          remoteResource: this.resourceFromHeading(candidate.block, {
            kind: 'note',
            operationMarker: intent.details.candidate.operationMarker,
            ownershipMarker: intent.details.candidate.ownershipMarker,
            parent: intent.details.candidate.parent,
            targetIdentityDigest: intent.targetIdentityDigest,
            versionMarker: intent.details.candidate.versionMarker,
          }),
          responseClassification: 'child-prefix-mismatch',
        }),
      );
    }
    const current = children.slice(
      prefix.length,
      prefix.length + intent.details.expectedBlockCount,
    );
    if (
      current.length === 0 &&
      children.length === prefix.length &&
      intent.details.expectedBlockCount > 0
    ) {
      return {
        responseClassification: 'exact-live-without-batch',
        type: 'PROVEN_UNEXECUTED',
      };
    }
    if (
      current.length !== intent.details.expectedBlockCount ||
      children.length !== prefix.length + intent.details.expectedBlockCount
    ) {
      return this.uncertain(
        'append-child-count-mismatch',
        'PARTIAL_REMOTE_WRITE',
      );
    }
    let hydrated: unknown[];
    try {
      hydrated = await Promise.all(
        current.map((block) => this.hydrateBlock(block, 0)),
      );
    } catch (error) {
      return this.uncertain(
        `append-hydration-${redactedErrorName(error)}`,
        'PAGINATION_INCOMPLETE',
      );
    }
    const fingerprints = hydrated.map((block, blockIndex) =>
      deriveNotionBlockFingerprint(block, {
        batchIndex: intent.details.batchIndex,
        blockIndex,
        sourceVersion: intent.sourceVersion,
      }),
    );
    if (
      JSON.stringify(fingerprints) !==
      JSON.stringify(intent.details.blockFingerprints)
    ) {
      return this.uncertain(
        'append-fingerprint-mismatch',
        'REMOTE_CONTENT_CHANGED',
      );
    }
    const attached = await this.verifyAttachedUploads(
      intent,
      intent.details.fileUploads,
    );
    if (attached.type !== 'EXACT') return attached.result;
    const resource = this.resourceFromHeading(candidate.block, {
      kind: 'note',
      operationMarker: intent.details.candidate.operationMarker,
      ownershipMarker: intent.details.candidate.ownershipMarker,
      parent: intent.details.candidate.parent,
      targetIdentityDigest: intent.targetIdentityDigest,
      versionMarker: intent.details.candidate.versionMarker,
    });
    return {
      observation: this.observation(intent, {
        attachedUploadIDs: attached.fileUploadIDs,
        blockFingerprints: fingerprints,
        outcome: 'APPENDED',
        remoteResource: resource,
        responseClassification: 'exact-append',
        returnedBlockIDs: current.map(({ id }) => id),
      }),
      type: 'OBSERVED',
    };
  }

  private async observeCandidate(
    intent: VerifyIntent,
  ): Promise<RemoteOperationResultV4> {
    return this.verifyCandidate(intent, intent.details);
  }

  private async verifyCandidate(
    intent: SealedOperationIntent,
    details: VerifyCandidateDetails,
  ): Promise<RemoteOperationResultV4> {
    const candidate = await this.readManaged(details.candidate, {
      allowEditedTimeChange: true,
      expectedTitle: details.expectedTitle,
    });
    if (candidate.type === 'FAILED') return candidate.result;
    if (candidate.type !== 'EXACT') {
      return this.uncertain(
        `verify-owner-${candidate.type.toLowerCase()}`,
        'OWNERSHIP_CHANGED',
      );
    }
    let children: BlockObjectResponse[];
    try {
      children = await this.listFullChildren(details.candidate.blockID);
    } catch (error) {
      return this.uncertain(
        `verify-list-${redactedErrorName(error)}`,
        'PAGINATION_INCOMPLETE',
      );
    }
    const ids = children.map(({ id }) => id);
    if (JSON.stringify(ids) !== JSON.stringify(details.returnedBlockIDs)) {
      return this.uncertain(
        'verify-child-id-mismatch',
        'REMOTE_CONTENT_CHANGED',
      );
    }
    const fingerprints: string[] = [];
    let offset = 0;
    try {
      for (
        let batchIndex = 0;
        batchIndex < details.batchBlockCounts.length;
        batchIndex += 1
      ) {
        const count = details.batchBlockCounts[batchIndex] ?? 0;
        const batch = children.slice(offset, offset + count);
        const hydrated = await Promise.all(
          batch.map((block) => this.hydrateBlock(block, 0)),
        );
        fingerprints.push(
          ...hydrated.map((block, blockIndex) =>
            deriveNotionBlockFingerprint(block, {
              batchIndex,
              blockIndex,
              sourceVersion: intent.sourceVersion,
            }),
          ),
        );
        offset += count;
      }
    } catch (error) {
      return this.uncertain(
        `verify-hydration-${redactedErrorName(error)}`,
        'PAGINATION_INCOMPLETE',
      );
    }
    if (
      offset !== children.length ||
      JSON.stringify(fingerprints) !== JSON.stringify(details.blockFingerprints)
    ) {
      return this.uncertain(
        'verify-fingerprint-mismatch',
        'REMOTE_CONTENT_CHANGED',
      );
    }
    const attached = await this.verifyAttachedUploads(
      intent,
      details.fileUploads,
    );
    if (attached.type !== 'EXACT') return attached.result;
    return {
      observation: this.observation(intent, {
        attachedUploadIDs: attached.fileUploadIDs,
        blockFingerprints: fingerprints,
        outcome: 'VERIFIED',
        remoteResource: this.resourceFromHeading(candidate.block, {
          kind: 'note',
          operationMarker: details.candidate.operationMarker,
          ownershipMarker: details.candidate.ownershipMarker,
          parent: details.candidate.parent,
          targetIdentityDigest: intent.targetIdentityDigest,
          versionMarker: details.candidate.versionMarker,
        }),
        responseClassification: 'exact-candidate-verification',
        returnedBlockIDs: ids,
      }),
      type: 'OBSERVED',
    };
  }

  private async executeFinalize(
    intent: FinalizeIntent,
    beforeMutation: BeforeMutationV4,
  ): Promise<RemoteOperationResultV4> {
    const verification = await this.verifyCandidate(
      intent,
      intent.details.verification,
    );
    if (verification.type !== 'OBSERVED') return verification;
    const authorizationFailure = await beforeMutation({
      attempt: 1,
      mutation: 'blocks.update',
    });
    if (authorizationFailure) return authorizationFailure;
    try {
      const response = await this.notion.blocks.update({
        block_id: intent.details.candidate.blockID,
        heading_1: {
          is_toggleable: true,
          rich_text: buildManagedHeadingRichText(intent.details.finalTitle, [
            intent.details.candidate.operationMarker,
            intent.details.candidate.ownershipMarker,
            intent.details.candidate.versionMarker,
          ]),
        },
      });
      if (
        isFullBlock(response) &&
        response.type === 'heading_1' &&
        response.id === intent.details.candidate.blockID &&
        this.headingMatches(response, {
          createdByID: intent.details.candidate.createdByID,
          operationMarker: intent.details.candidate.operationMarker,
          ownershipMarker: intent.details.candidate.ownershipMarker,
          parent: intent.details.candidate.parent,
          title: intent.details.finalTitle,
          versionMarker: intent.details.candidate.versionMarker,
        })
      ) {
        return this.finalizationObservation(response, intent);
      }
      return this.observeFinalize(intent);
    } catch (error) {
      if (isAmbiguousWrite(error)) return this.observeFinalize(intent);
      return this.errorResult(error);
    }
  }

  private async observeFinalize(
    intent: FinalizeIntent,
  ): Promise<RemoteOperationResultV4> {
    const finalized = await this.readManaged(intent.details.candidate, {
      allowEditedTimeChange: true,
      expectedTitle: intent.details.finalTitle,
    });
    if (finalized.type === 'FAILED') return finalized.result;
    if (finalized.type === 'EXACT') {
      return this.finalizationObservation(finalized.block, intent);
    }
    const staging = await this.readManaged(intent.details.candidate, {
      expectedTitle: intent.details.stagingTitle,
    });
    if (staging.type === 'FAILED') return staging.result;
    if (staging.type === 'EXACT') {
      return {
        responseClassification: 'exact-staging-title-retained',
        type: 'PROVEN_UNEXECUTED',
      };
    }
    return this.uncertain(
      `finalize-observation-${finalized.type.toLowerCase()}`,
      'OWNERSHIP_CHANGED',
    );
  }

  private finalizationObservation(
    block: HeadingBlock,
    intent: FinalizeIntent,
  ): RemoteOperationResultV4 {
    return {
      observation: this.observation(intent, {
        outcome: 'FINALIZED',
        remoteResource: this.resourceFromHeading(block, {
          kind: 'note',
          operationMarker: intent.details.candidate.operationMarker,
          ownershipMarker: intent.details.candidate.ownershipMarker,
          parent: intent.details.candidate.parent,
          targetIdentityDigest: intent.targetIdentityDigest,
          versionMarker: intent.details.candidate.versionMarker,
        }),
        responseClassification: 'exact-candidate-finalization',
        returnedBlockIDs: [block.id],
      }),
      type: 'OBSERVED',
    };
  }

  private async listFullChildren(
    parentBlockID: string,
  ): Promise<BlockObjectResponse[]> {
    const children: BlockObjectResponse[] = [];
    let startCursor: string | undefined;
    for (let page = 0; page < MAX_CHILD_LIST_PAGES; page += 1) {
      const response = await this.notion.blocks.children.list({
        block_id: parentBlockID,
        page_size: 100,
        ...(startCursor && { start_cursor: startCursor }),
      });
      for (const child of response.results) {
        if (!isFullBlock(child)) {
          throw new Error('Notion returned a partial child block');
        }
        children.push(child);
      }
      if (!response.has_more) return children;
      if (!response.next_cursor) {
        throw new Error('Notion child pagination omitted its cursor');
      }
      startCursor = response.next_cursor;
    }
    throw new Error('Notion child pagination exceeded its bounded budget');
  }

  private async hydrateBlock(
    block: BlockObjectResponse,
    depth: number,
  ): Promise<unknown> {
    if (!block.has_children) return block;
    if (depth >= MAX_HYDRATION_DEPTH) {
      throw new Error('Notion block nesting exceeded its bounded depth');
    }
    const children = await this.listFullChildren(block.id);
    const hydrated = await Promise.all(
      children.map((child) => this.hydrateBlock(child, depth + 1)),
    );
    const record: unknown = block;
    if (!isUnknownRecord(record)) {
      throw new Error('Notion full block is not an object');
    }
    const data = record[block.type];
    if (!isUnknownRecord(data)) {
      throw new Error('Notion full block omitted its type payload');
    }
    return {
      ...record,
      [block.type]: {
        ...data,
        children: hydrated,
      },
    };
  }

  private async verifyAttachedUploads(
    intent: Pick<SealedOperationIntent, 'targetIdentityDigest'>,
    references: AppendIntent['details']['fileUploads'],
  ): Promise<
    | { fileUploadIDs: string[]; type: 'EXACT' }
    | { result: RemoteOperationResultV4; type: 'FAILED' }
  > {
    const uniqueReferences = Array.from(
      new Map(
        references.map((reference) => [reference.fileUploadID, reference]),
      ).values(),
    );
    for (const reference of uniqueReferences) {
      if (
        reference.fileUploadBindingDigest !==
        deriveFileUploadBindingDigest({
          assetIdentityDigest: reference.assetIdentityDigest,
          fileUploadID: reference.fileUploadID,
          targetIdentityDigest: intent.targetIdentityDigest,
        })
      ) {
        return {
          result: this.uncertain(
            'upload-reference-binding-mismatch',
            'UPLOAD_IDENTITY_CHANGED',
          ),
          type: 'FAILED',
        };
      }
      let upload: FileUploadObjectResponse;
      try {
        upload = await this.uploads.retrieve(reference.fileUploadID);
      } catch (error) {
        return { result: this.readErrorResult(error), type: 'FAILED' };
      }
      if (
        upload.id !== reference.fileUploadID ||
        upload.created_by.id !== reference.expectedCreator ||
        upload.filename !== reference.filename ||
        upload.content_type !== reference.contentType ||
        upload.content_length !== reference.contentLength
      ) {
        return {
          result: this.uncertain(
            'upload-asset-identity-mismatch',
            'UPLOAD_IDENTITY_CHANGED',
          ),
          type: 'FAILED',
        };
      }
      if (
        upload.archived ||
        upload.status !== 'uploaded' ||
        upload.expiry_time !== null
      ) {
        return {
          result: this.uncertain(
            'upload-not-attached',
            'UPLOAD_ATTACHMENT_UNVERIFIED',
          ),
          type: 'FAILED',
        };
      }
    }
    return {
      fileUploadIDs: uniqueReferences.map(({ fileUploadID }) => fileUploadID),
      type: 'EXACT',
    };
  }

  private uploadIdentityMatches(
    upload: FileUploadObjectResponse,
    intent: UploadCreateIntent | UploadSendIntent,
    requireCreateWindow: boolean,
  ): boolean {
    const details = intent.details;
    const expectedCreator = knownRemoteCreator(details.expectedCreator);
    return (
      upload.id.length > 0 &&
      Boolean(expectedCreator) &&
      upload.created_by.id === expectedCreator &&
      upload.filename === details.filename &&
      upload.content_type === details.contentType &&
      upload.content_length === details.contentLength &&
      (!requireCreateWindow ||
        (intent.kind === 'UPLOAD_CREATE' &&
          this.clock.compare(
            upload.created_time,
            intent.details.requestStartedAt,
          ) >= 0 &&
          this.clock.compare(
            upload.created_time,
            intent.details.isolationDeadline,
          ) <= 0))
    );
  }

  private uploadLifecycleMatches(upload: FileUploadObjectResponse): boolean {
    if (upload.status === 'expired') return upload.archived;
    return !upload.archived && upload.status !== 'failed';
  }

  private uploadAsset(
    intent: UploadCreateIntent | UploadSendIntent,
    upload: FileUploadObjectResponse,
  ): UploadAssetRecordV4 {
    const details = intent.details;
    const status =
      upload.status === 'expired'
        ? ('EXPIRED' as const)
        : upload.status === 'uploaded'
          ? ('UPLOADED' as const)
          : ('CREATED_UNSENT' as const);
    const binding = {
      assetIdentityDigest: details.assetIdentityDigest,
      fileUploadID: upload.id,
      targetIdentityDigest: intent.targetIdentityDigest,
    };
    return {
      assetID: details.assetID,
      assetIdentityDigest: details.assetIdentityDigest,
      attachedAt: null,
      attachmentIdentity: details.attachmentIdentity,
      attachmentKey: details.attachmentKey,
      contentHash: details.contentHash,
      contentLength: details.contentLength,
      contentType: details.contentType,
      createOperationID:
        intent.kind === 'UPLOAD_CREATE'
          ? intent.operationID
          : intent.details.createOperationID,
      expiryTime: upload.expiry_time,
      fileUploadBindingDigest: deriveFileUploadBindingDigest(binding),
      fileUploadID: upload.id,
      filename: details.filename,
      generation: intent.generation,
      sendOperationID:
        intent.kind === 'UPLOAD_SEND' ? intent.operationID : null,
      sourceIdentity: details.sourceIdentity,
      sourceVersion: intent.sourceVersion,
      status,
      targetIdentityDigest: intent.targetIdentityDigest,
      transactionID: intent.transactionID,
    };
  }

  private observedUpload(
    intent: UploadCreateIntent | UploadSendIntent,
    upload: FileUploadObjectResponse,
  ): RemoteOperationResultV4 {
    const asset = this.uploadAsset(intent, upload);
    return {
      observation: this.observation(intent, {
        outcome:
          asset.status === 'UPLOADED'
            ? 'UPLOADED'
            : asset.status === 'EXPIRED'
              ? 'MISMATCH'
              : 'CREATED',
        responseClassification: `exact-upload-${upload.status}`,
        returnedBlockIDs: [upload.id],
        upload: asset,
      }),
      type: 'OBSERVED',
    };
  }

  private async executeUploadCreate(
    intent: UploadCreateIntent,
    beforeMutation: BeforeMutationV4,
  ): Promise<RemoteOperationResultV4> {
    try {
      const upload = await this.uploads.create(
        {
          contentType: requiredImageContentType(intent.details.contentType),
          filename: intent.details.filename,
          size: intent.details.contentLength,
        },
        {
          authorizeCreateAttempt: (attempt) =>
            this.authorizeUploadAttempt(beforeMutation, attempt),
        },
      );
      return this.uploadIdentityMatches(upload, intent, true) &&
        this.uploadLifecycleMatches(upload)
        ? this.observedUpload(intent, upload)
        : this.observeUploadCreate(intent);
    } catch (error) {
      if (error instanceof LocalMutationAuthorizationError) {
        return error.result;
      }
      if (
        isAmbiguousWrite(error) ||
        error instanceof UploadReconciliationAmbiguousError
      ) {
        return this.observeUploadCreate(intent);
      }
      return this.errorResult(error);
    }
  }

  private async observeUploadCreate(
    intent: UploadCreateIntent,
  ): Promise<RemoteOperationResultV4> {
    let upload: FileUploadObjectResponse | undefined;
    try {
      const expectedCreator = knownRemoteCreator(
        intent.details.expectedCreator,
      );
      upload = await this.uploads.reconcileCreate({
        ...(expectedCreator && { connectionID: expectedCreator }),
        contentLength: intent.details.contentLength,
        contentType: intent.details.contentType,
        filename: intent.details.filename,
        isolationDeadline: intent.details.isolationDeadline,
        requestStartedAt: intent.details.requestStartedAt,
      });
    } catch (error) {
      return this.uncertain(
        `upload-create-reconcile-${redactedErrorName(error)}`,
        error instanceof UploadReconciliationAmbiguousError
          ? 'AMBIGUOUS_REMOTE_RESULT'
          : 'PAGINATION_INCOMPLETE',
      );
    }
    if (
      upload &&
      this.uploadIdentityMatches(upload, intent, true) &&
      this.uploadLifecycleMatches(upload)
    ) {
      return this.observedUpload(intent, upload);
    }
    if (
      !upload &&
      this.clock.compare(
        this.clock.nowISOString(),
        intent.details.isolationDeadline,
      ) >= 0
    ) {
      return {
        responseClassification: 'upload-isolation-window-empty',
        type: 'PROVEN_UNEXECUTED',
      };
    }
    return this.uncertain(
      'upload-create-not-isolated',
      'AMBIGUOUS_REMOTE_RESULT',
    );
  }

  private async executeUploadSend(
    intent: UploadSendIntent,
    beforeMutation: BeforeMutationV4,
  ): Promise<RemoteOperationResultV4> {
    let image: ResolvedNoteImage;
    try {
      image = await this.payloads.getUploadBytes(intent);
    } catch {
      return this.rejected(
        'VALIDATION_FAILED',
        'local-image-unavailable',
        'The frozen local image is unavailable',
      );
    }
    if (
      image.contentHash !== intent.details.contentHash ||
      image.size !== intent.details.contentLength ||
      image.contentType !== intent.details.contentType ||
      image.filename !== intent.details.filename
    ) {
      return this.rejected(
        'VALIDATION_FAILED',
        'local-image-mismatch',
        'The local image changed after its source snapshot was frozen',
      );
    }
    let upload: FileUploadObjectResponse;
    try {
      upload = await this.uploads.retrieve(intent.details.fileUploadID);
    } catch (error) {
      return this.readErrorResult(error);
    }
    if (!this.uploadIdentityMatches(upload, intent, false)) {
      return this.uncertain(
        'upload-send-owner-mismatch',
        'UPLOAD_IDENTITY_CHANGED',
      );
    }
    if (upload.status === 'expired' && this.uploadLifecycleMatches(upload)) {
      return this.observedUpload(intent, upload);
    }
    if (!this.uploadLifecycleMatches(upload)) {
      return this.uncertain(
        'upload-send-lifecycle-mismatch',
        'UPLOAD_IDENTITY_CHANGED',
      );
    }
    if (upload.status === 'uploaded')
      return this.observedUpload(intent, upload);
    try {
      // retrieve() above is the immediate upload ownership/status check before
      // the send mutation.
      await this.uploads.sendCreated(image, upload, {
        authorizeSendAttempt: (attempt) =>
          this.authorizeUploadAttempt(beforeMutation, attempt),
      });
      return this.observeUploadSend(intent);
    } catch (error) {
      if (error instanceof LocalMutationAuthorizationError) {
        return error.result;
      }
      if (isAmbiguousWrite(error)) return this.observeUploadSend(intent);
      return this.errorResult(error);
    }
  }

  private async authorizeUploadAttempt(
    beforeMutation: BeforeMutationV4,
    attempt: UploadMutationAttempt,
  ): Promise<void> {
    const failure = await beforeMutation(attempt);
    if (failure) throw new LocalMutationAuthorizationError(failure);
  }

  private async observeUploadSend(
    intent: UploadSendIntent,
  ): Promise<RemoteOperationResultV4> {
    let upload: FileUploadObjectResponse;
    try {
      upload = await this.uploads.retrieve(intent.details.fileUploadID);
    } catch (error) {
      return this.readErrorResult(error);
    }
    if (!this.uploadIdentityMatches(upload, intent, false)) {
      return this.uncertain(
        'upload-send-observation-mismatch',
        'UPLOAD_IDENTITY_CHANGED',
      );
    }
    if (!this.uploadLifecycleMatches(upload)) {
      return this.uncertain(
        'upload-send-observation-lifecycle-mismatch',
        'UPLOAD_IDENTITY_CHANGED',
      );
    }
    if (upload.status === 'uploaded' || upload.status === 'expired') {
      return this.observedUpload(intent, upload);
    }
    return this.uncertain(
      'upload-send-still-pending',
      'UPLOAD_SEND_UNRESOLVED',
    );
  }

  private async livenessObservation(
    intent: LivenessIntent,
    resource: ManagedResourceIdentity,
  ): Promise<
    | { observation: RemoteObservation; type: 'OBSERVED' }
    | { result: RemoteOperationResultV4; type: 'FAILED' }
  > {
    const read = await this.readManaged(resource);
    if (read.type === 'FAILED') return read;
    if (read.type === 'NOT_FOUND') {
      return {
        observation: this.observation(intent, {
          outcome: 'NOT_FOUND',
          responseClassification: 'http-404-or-inaccessible',
        }),
        type: 'OBSERVED',
      };
    }
    if (read.type === 'MISMATCH') {
      return {
        observation: this.observation(intent, {
          outcome: 'MISMATCH',
          responseClassification: 'ownership-mismatch',
        }),
        type: 'OBSERVED',
      };
    }
    return {
      observation: this.observation(intent, {
        outcome: 'EXACT',
        remoteResource: resource,
        responseClassification: 'exact-live-resource',
        returnedBlockIDs: [resource.blockID],
      }),
      type: 'OBSERVED',
    };
  }

  private async observeLiveness(
    intent: LivenessIntent,
  ): Promise<RemoteOperationResultV4> {
    const active = intent.details.active
      ? await this.livenessObservation(intent, intent.details.active)
      : null;
    if (active?.type === 'FAILED') return active.result;
    const container = intent.details.container
      ? await this.livenessObservation(intent, intent.details.container)
      : null;
    if (container?.type === 'FAILED') return container.result;
    const activeObservation = active?.observation ?? null;
    const containerObservation = container?.observation ?? null;
    if (
      activeObservation?.outcome === 'NOT_FOUND' &&
      containerObservation?.outcome === 'NOT_FOUND'
    ) {
      return this.rejected(
        'PERMISSION_REQUIRED',
        'both-managed-resources-404',
        'Managed Notion resources are missing or inaccessible',
      );
    }
    let outcome: RemoteVerificationState['outcome'] = 'EXACT';
    if (containerObservation?.outcome === 'NOT_FOUND') {
      outcome = 'CONTAINER_MISSING';
    } else if (activeObservation?.outcome === 'NOT_FOUND') {
      outcome = 'ACTIVE_MISSING';
    } else if (
      activeObservation?.outcome === 'MISMATCH' ||
      containerObservation?.outcome === 'MISMATCH'
    ) {
      outcome = 'OWNERSHIP_MISMATCH';
    }
    const verification: RemoteVerificationState = {
      activeObservation,
      checkedAt: this.clock.nowISOString(),
      containerObservation,
      expectedActive: intent.details.active,
      expectedContainer: intent.details.container,
      outcome,
      targetIdentityDigest: intent.targetIdentityDigest,
      verificationID: intent.operationID,
    };
    return {
      observation: this.observation(intent, {
        outcome: outcome === 'EXACT' ? 'EXACT' : 'MISMATCH',
        responseClassification: `liveness-${outcome.toLowerCase()}`,
      }),
      type: 'OBSERVED',
      verification,
    };
  }

  private resourceFromOwnership(
    ownership: OwnershipExpectation,
  ): ManagedResourceIdentity {
    return {
      blockID: ownership.blockID,
      createdByID: ownership.createdByID,
      kind: ownership.kind,
      lastEditedTime: ownership.lastEditedTime,
      operationMarker: ownership.operationMarker,
      ownershipMarker: ownership.ownershipMarker,
      parent: ownership.parent,
      targetIdentityDigest: ownership.targetIdentityDigest,
      versionMarker: ownership.versionMarker,
    };
  }

  private deletionObservation(
    intent: DeleteIntent,
    block: HeadingBlock,
  ): RemoteOperationResultV4 {
    return {
      observation: this.observation(intent, {
        deletionProof: {
          archived: true,
          exactBlockID: block.id,
          inTrash: true,
        },
        outcome: 'DELETED',
        remoteResource: this.resourceFromOwnership(intent.details.ownership),
        responseClassification: 'exact-in-trash',
        returnedBlockIDs: [block.id],
      }),
      type: 'OBSERVED',
    };
  }

  private async readDeleteTarget(intent: DeleteIntent): Promise<ManagedRead> {
    const resource = this.resourceFromOwnership(intent.details.ownership);
    const read = await this.readManaged(resource, {
      allowEditedTimeChange: true,
      allowTrashed: true,
    });
    if (
      read.type === 'EXACT' &&
      !read.block.in_trash &&
      read.block.last_edited_time !== intent.details.ownership.lastEditedTime
    ) {
      return { type: 'MISMATCH' };
    }
    return read;
  }

  private async executeDelete(
    intent: DeleteIntent,
    beforeMutation: BeforeMutationV4,
  ): Promise<RemoteOperationResultV4> {
    const before = await this.readDeleteTarget(intent);
    if (before.type === 'FAILED') return before.result;
    if (before.type === 'NOT_FOUND') {
      return this.uncertain('delete-preflight-404', 'DELETE_STATE_UNKNOWN');
    }
    if (before.type === 'MISMATCH') {
      return this.uncertain(
        'delete-preflight-ownership-mismatch',
        'OWNERSHIP_CHANGED',
      );
    }
    if (before.block.in_trash && before.block.archived) {
      return this.deletionObservation(intent, before.block);
    }
    if (before.block.in_trash || before.block.archived) {
      return this.uncertain(
        'delete-preflight-trash-fields-inconsistent',
        'DELETE_STATE_UNKNOWN',
      );
    }
    const authorizationFailure = await beforeMutation({
      attempt: 1,
      mutation: 'blocks.delete',
    });
    if (authorizationFailure) return authorizationFailure;
    try {
      // readDeleteTarget() immediately above is the mandatory ownership check.
      await this.notion.blocks.delete({
        block_id: intent.details.exactBlockID,
      });
      return this.observeDelete(intent);
    } catch (error) {
      if (isAmbiguousWrite(error)) return this.observeDelete(intent);
      return this.errorResult(error);
    }
  }

  private async observeDelete(
    intent: DeleteIntent,
  ): Promise<RemoteOperationResultV4> {
    const observed = await this.readDeleteTarget(intent);
    if (observed.type === 'FAILED') return observed.result;
    if (observed.type === 'NOT_FOUND') {
      return this.uncertain('delete-observation-404', 'DELETE_STATE_UNKNOWN');
    }
    if (observed.type === 'MISMATCH') {
      return this.uncertain(
        'delete-observation-ownership-mismatch',
        'OWNERSHIP_CHANGED',
      );
    }
    if (observed.block.in_trash && observed.block.archived) {
      return this.deletionObservation(intent, observed.block);
    }
    if (!observed.block.in_trash && !observed.block.archived) {
      return {
        responseClassification: 'exact-live-delete-target',
        type: 'PROVEN_UNEXECUTED',
      };
    }
    return this.uncertain(
      'delete-trash-fields-inconsistent',
      'DELETE_STATE_UNKNOWN',
    );
  }
}
