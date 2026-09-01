import {
  APIErrorCode,
  APIResponseError,
  RequestTimeoutError,
  type Client,
} from '@notionhq/client';
import type { FileUploadObjectResponse } from '@notionhq/client/build/src/api-endpoints';
import { describe, expect, it, vi } from 'vite-plus/test';
import { mockDeep } from 'vitest-mock-extended';

import { FakeRuntimeClock } from '../../../../../test/utils';
import type { ResolvedNoteImage } from '../../note-image-resolver';
import {
  NotionImageUploadService,
  type UploadJournalHooks,
} from '../../notion-image-upload-service';
import { createOperationIntent } from '../model-v4';
import {
  NotionOperationAdapterV2,
  type NotionUploadGatewayV4,
  type OperationPayloadProviderV4,
} from '../notion-operation-adapter-v4';
import type { MutationAuthorization, SealedOperationIntent } from '../types-v4';

import { clockV4, containerV4, leaseV4, sourceVersionV4 } from './fixtures-v4';

type AttemptContext = {
  attempt: number;
  mutation: 'file_uploads.create' | 'file_uploads.send';
};

type AttemptAudit = AttemptContext & {
  leaseEpoch: number;
  leaseID: string;
  noteRevision: number;
  operationID: string;
  operationSequence: number;
  rootRevision: number;
};

const image: ResolvedNoteImage = {
  alt: 'Synthetic image',
  attachmentKey: 'IMAGE_AUTHORIZATION',
  bytes: new Uint8Array([1, 2, 3, 4]),
  contentHash: 'content:upload-authorization',
  contentType: 'image/png',
  filename: 'notero-upload-authorization.png',
  size: 4,
};

function uploadResponse(
  status: FileUploadObjectResponse['status'],
): FileUploadObjectResponse {
  return {
    archived: status === 'expired',
    content_length: image.size,
    content_type: image.contentType,
    created_by: { id: containerV4().createdByID, type: 'bot' },
    created_time: clockV4.nowISOString(),
    expiry_time:
      status === 'uploaded'
        ? null
        : clockV4.addMs(clockV4.nowISOString(), 60 * 60_000),
    filename: image.filename,
    id: 'upload-authorization',
    last_edited_time: clockV4.nowISOString(),
    object: 'file_upload',
    status,
  };
}

function intentBase() {
  const lease = leaseV4();
  return {
    createdAt: clockV4.nowISOString(),
    generation: lease.generation,
    leaseEpoch: lease.leaseEpoch,
    leaseID: lease.leaseID,
    operationSequence: 4,
    owner: 'MAIN' as const,
    processSessionID: lease.processSessionID,
    sourceVersion: sourceVersionV4,
    targetIdentityDigest: 'target:upload-authorization',
    transactionID: lease.transactionID,
  };
}

function uploadCreateIntent(): Extract<
  SealedOperationIntent,
  { kind: 'UPLOAD_CREATE' }
> {
  const intent = createOperationIntent({
    ...intentBase(),
    details: {
      assetID: 'asset:upload-authorization',
      assetIdentityDigest: 'asset:upload-authorization',
      attachmentIdentity: 'attachment:upload-authorization',
      attachmentKey: image.attachmentKey,
      contentHash: image.contentHash,
      contentLength: image.size,
      contentType: image.contentType,
      expectedCreator: containerV4().createdByID,
      filename: image.filename,
      isolationDeadline: clockV4.addMs(clockV4.nowISOString(), 65 * 60_000),
      requestStartedAt: clockV4.nowISOString(),
      sourceIdentity: 'source-image:upload-authorization',
    },
    kind: 'UPLOAD_CREATE',
    operationID: 'operation:upload-create-authorization',
  });
  if (intent.kind !== 'UPLOAD_CREATE') throw new Error('Bad create fixture');
  return intent;
}

function uploadSendIntent(): Extract<
  SealedOperationIntent,
  { kind: 'UPLOAD_SEND' }
> {
  const intent = createOperationIntent({
    ...intentBase(),
    details: {
      assetID: 'asset:upload-authorization',
      assetIdentityDigest: 'asset:upload-authorization',
      attachmentIdentity: 'attachment:upload-authorization',
      attachmentKey: image.attachmentKey,
      contentHash: image.contentHash,
      contentLength: image.size,
      contentType: image.contentType,
      createOperationID: 'operation:upload-create-authorization',
      expectedCreator: containerV4().createdByID,
      fileUploadID: uploadResponse('pending').id,
      filename: image.filename,
      sourceIdentity: 'source-image:upload-authorization',
    },
    kind: 'UPLOAD_SEND',
    operationID: 'operation:upload-send-authorization',
  });
  if (intent.kind !== 'UPLOAD_SEND') throw new Error('Bad send fixture');
  return intent;
}

function authorize(
  intent: SealedOperationIntent,
  overrides: Partial<MutationAuthorization> = {},
): MutationAuthorization {
  return {
    authorizedAt: clockV4.nowISOString(),
    intent,
    lease: leaseV4(),
    noteRevision: 11,
    oneTimeToken: `authorization:${intent.operationID}`,
    rootRevision: 17,
    ...overrides,
  };
}

function gatewayWithHooks(
  service: NotionImageUploadService,
  journalHooks: UploadJournalHooks,
): NotionUploadGatewayV4 {
  return {
    create: (descriptor, hooks) =>
      service.create(descriptor, { ...hooks, ...journalHooks }),
    reconcileCreate: (criteria) => service.reconcileCreate(criteria),
    retrieve: (fileUploadID) => service.retrieve(fileUploadID),
    sendCreated: (resolved, upload, hooks) =>
      service.sendCreated(resolved, upload, { ...hooks, ...journalHooks }),
  };
}

function adapterHarness(input: {
  clock?: FakeRuntimeClock;
  journalHooks?: UploadJournalHooks;
  notion?: Client;
}) {
  const notion = input.notion ?? mockDeep<Client>();
  const clock = input.clock ?? new FakeRuntimeClock(clockV4.nowISOString());
  const service = new NotionImageUploadService(notion, {
    clock,
    maxAttempts: 3,
    maxTotalWaitMilliseconds: 30_000,
    random: () => 0,
  });
  const payloads: OperationPayloadProviderV4 = {
    getAppendBatch: vi.fn<OperationPayloadProviderV4['getAppendBatch']>(
      async () => [],
    ),
    getUploadBytes: vi.fn<OperationPayloadProviderV4['getUploadBytes']>(
      async () => image,
    ),
  };
  const adapter = new NotionOperationAdapterV2(
    notion,
    payloads,
    gatewayWithHooks(service, input.journalHooks ?? {}),
    clock,
  );
  return { adapter, clock, notion, service };
}

function changedAuthorization(
  initial: MutationAuthorization,
  change: 'intent' | 'lease' | 'session',
  sequence: number,
): MutationAuthorization {
  if (change === 'intent') {
    return {
      ...initial,
      noteRevision: initial.noteRevision + 1,
      oneTimeToken: `${initial.oneTimeToken}:changed:${sequence}`,
    };
  }
  if (change === 'session') {
    return {
      ...initial,
      lease: {
        ...initial.lease,
        processSessionID: 'process-replaced',
      },
      oneTimeToken: `${initial.oneTimeToken}:changed:${sequence}`,
    };
  }
  return {
    ...initial,
    lease: { ...initial.lease, leaseEpoch: initial.lease.leaseEpoch + 1 },
    oneTimeToken: `${initial.oneTimeToken}:changed:${sequence}`,
  };
}

describe('final File Upload SDK mutation reauthorization', () => {
  it('blocks create when a competing writer supersedes the lease after onCreateStarted', async () => {
    let superseded = false;
    let authorizationSequence = 0;
    const notion = mockDeep<Client>();
    notion.fileUploads.create.mockResolvedValue(uploadResponse('pending'));
    const test = adapterHarness({
      journalHooks: {
        onCreateStarted: async () => {
          superseded = true;
        },
      },
      notion,
    });
    const initial = authorize(uploadCreateIntent());

    const result = await test.adapter.execute(
      initial,
      async (_attempt?: unknown) => {
        authorizationSequence += 1;
        return superseded
          ? changedAuthorization(initial, 'lease', authorizationSequence)
          : {
              ...initial,
              oneTimeToken: `${initial.oneTimeToken}:fresh:${authorizationSequence}`,
            };
      },
    );

    expect(result.type).toBe('PROVEN_UNEXECUTED');
    expect(notion.fileUploads.create).toHaveBeenCalledTimes(0);
  });

  it('reauthorizes after 429 backoff and blocks a second create after intent replacement', async () => {
    let intentReplaced = false;
    let authorizationSequence = 0;
    const clock = new FakeRuntimeClock(clockV4.nowISOString());
    vi.spyOn(clock, 'sleep').mockImplementation(async () => {
      intentReplaced = true;
    });
    const notion = mockDeep<Client>();
    notion.fileUploads.create
      .mockRejectedValueOnce(
        new APIResponseError({
          code: APIErrorCode.RateLimited,
          headers: { 'retry-after': '0' },
          message: 'Synthetic rate limit',
          rawBodyText: 'redacted',
          status: 429,
        }),
      )
      .mockResolvedValue(uploadResponse('pending'));
    const test = adapterHarness({ clock, notion });
    const initial = authorize(uploadCreateIntent());

    const result = await test.adapter.execute(
      initial,
      async (_attempt?: unknown) => {
        authorizationSequence += 1;
        return intentReplaced
          ? changedAuthorization(initial, 'intent', authorizationSequence)
          : {
              ...initial,
              oneTimeToken: `${initial.oneTimeToken}:fresh:${authorizationSequence}`,
            };
      },
    );

    expect(result.type).toBe('PROVEN_UNEXECUTED');
    expect(notion.fileUploads.create).toHaveBeenCalledTimes(1);
  });

  it('blocks send when the process session changes after onSendStarted', async () => {
    let sessionReplaced = false;
    let authorizationSequence = 0;
    const notion = mockDeep<Client>();
    notion.fileUploads.retrieve.mockResolvedValue(uploadResponse('pending'));
    notion.fileUploads.send.mockResolvedValue(uploadResponse('uploaded'));
    const test = adapterHarness({
      journalHooks: {
        onSendStarted: async () => {
          sessionReplaced = true;
        },
      },
      notion,
    });
    const initial = authorize(uploadSendIntent());

    const result = await test.adapter.execute(
      initial,
      async (_attempt?: unknown) => {
        authorizationSequence += 1;
        return sessionReplaced
          ? changedAuthorization(initial, 'session', authorizationSequence)
          : {
              ...initial,
              oneTimeToken: `${initial.oneTimeToken}:fresh:${authorizationSequence}`,
            };
      },
    );

    expect(result.type).toBe('PROVEN_UNEXECUTED');
    expect(notion.fileUploads.send).toHaveBeenCalledTimes(0);
  });

  it('restarts an unknown send through retrieve only and never resends bytes', async () => {
    const notion = mockDeep<Client>();
    notion.fileUploads.retrieve.mockResolvedValue(uploadResponse('pending'));
    notion.fileUploads.send.mockRejectedValue(new RequestTimeoutError());
    const first = adapterHarness({ notion });
    const intent = uploadSendIntent();
    const initial = authorize(intent);

    const uncertain = await first.adapter.execute(initial, async () => ({
      ...initial,
      oneTimeToken: `${initial.oneTimeToken}:fresh`,
    }));
    expect(uncertain.type).toBe('UNCERTAIN');
    expect(notion.fileUploads.send).toHaveBeenCalledTimes(1);

    notion.fileUploads.retrieve.mockResolvedValue(uploadResponse('uploaded'));
    const restarted = adapterHarness({ notion });
    const observed = await restarted.adapter.observe(intent);

    expect(observed.type).toBe('OBSERVED');
    expect(notion.fileUploads.send).toHaveBeenCalledTimes(1);
  });

  it('places an exact durable audit immediately before every SDK create attempt', async () => {
    const events: Array<
      | { audit: AttemptAudit; type: 'durable-audit' }
      | { attempt: number; type: 'sdk-create' }
      | { type: 'create-started' | 'retry-sleep' }
    > = [];
    let sdkAttempt = 0;
    let authorizationSequence = 0;
    const clock = new FakeRuntimeClock(clockV4.nowISOString());
    vi.spyOn(clock, 'sleep').mockImplementation(async () => {
      events.push({ type: 'retry-sleep' });
    });
    const notion = mockDeep<Client>();
    notion.fileUploads.create.mockImplementation(async () => {
      sdkAttempt += 1;
      events.push({ attempt: sdkAttempt, type: 'sdk-create' });
      if (sdkAttempt === 1) {
        throw new APIResponseError({
          code: APIErrorCode.ConflictError,
          headers: {},
          message: 'Synthetic conflict',
          rawBodyText: 'redacted',
          status: 409,
        });
      }
      return uploadResponse('pending');
    });
    const test = adapterHarness({
      clock,
      journalHooks: {
        onCreateStarted: async () => {
          events.push({ type: 'create-started' });
        },
      },
      notion,
    });
    const initial = authorize(uploadCreateIntent());

    const result = await test.adapter.execute(
      initial,
      async (rawAttempt?: unknown) => {
        authorizationSequence += 1;
        const attempt = rawAttempt as AttemptContext | undefined;
        const refreshed = {
          ...initial,
          oneTimeToken: `${initial.oneTimeToken}:fresh:${authorizationSequence}`,
        };
        events.push({
          audit: {
            attempt: attempt?.attempt ?? 0,
            leaseEpoch: refreshed.lease.leaseEpoch,
            leaseID: refreshed.lease.leaseID,
            mutation: attempt?.mutation ?? 'file_uploads.create',
            noteRevision: refreshed.noteRevision,
            operationID: refreshed.intent.operationID,
            operationSequence: refreshed.intent.operationSequence,
            rootRevision: refreshed.rootRevision,
          },
          type: 'durable-audit',
        });
        return refreshed;
      },
    );

    expect(result.type).toBe('OBSERVED');
    const sdkIndexes = events.flatMap((event, index) =>
      event.type === 'sdk-create' ? [index] : [],
    );
    expect(sdkIndexes).toHaveLength(2);
    for (const [expectedAttempt, sdkIndex] of sdkIndexes.entries()) {
      const preceding = events[sdkIndex - 1];
      expect(preceding).toMatchObject({
        audit: {
          attempt: expectedAttempt + 1,
          leaseEpoch: initial.lease.leaseEpoch,
          leaseID: initial.lease.leaseID,
          mutation: 'file_uploads.create',
          noteRevision: initial.noteRevision,
          operationID: initial.intent.operationID,
          operationSequence: initial.intent.operationSequence,
          rootRevision: initial.rootRevision,
        },
        type: 'durable-audit',
      });
    }
  });
});
