import {
  APIErrorCode,
  APIResponseError,
  RequestTimeoutError,
  type Client,
} from '@notionhq/client';
import type { FileUploadObjectResponse } from '@notionhq/client/build/src/api-endpoints';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { mockDeep } from 'vitest-mock-extended';

import { createWindowMock, zoteroMock } from '../../../../test/utils';
import type { ResolvedNoteImage } from '../note-image-resolver';
import { hashBytes } from '../note-image-resolver';
import {
  NotionImageUploadService,
  isSameNotionTarget,
  parseRetryAfter,
} from '../notion-image-upload-service';

const target = {
  connectionID: 'bot-a',
  databaseID: 'database-a',
  pageID: 'page-a',
  workspaceID: 'workspace-a',
};
const image: ResolvedNoteImage = {
  alt: 'Synthetic image',
  attachmentKey: 'IMAGEA',
  bytes: new Uint8Array([1, 2, 3]),
  contentHash: 'hash-a',
  contentType: 'image/png',
  filename: 'IMAGEA.png',
  size: 3,
};

function uploadResponse(
  status: FileUploadObjectResponse['status'],
): FileUploadObjectResponse {
  return {
    archived: false,
    content_length: 3,
    content_type: 'image/png',
    created_by: { id: 'bot-a', type: 'bot' },
    created_time: new Date(0).toISOString(),
    expiry_time: status === 'uploaded' ? null : new Date(3600000).toISOString(),
    filename: 'IMAGEA.png',
    id: 'upload-a',
    last_edited_time: new Date(0).toISOString(),
    object: 'file_upload',
    status,
  };
}

function setup() {
  const notion = mockDeep<Client>();
  notion.fileUploads.create.mockResolvedValue(uploadResponse('pending'));
  notion.fileUploads.send.mockResolvedValue(uploadResponse('uploaded'));
  return { notion, service: new NotionImageUploadService(notion) };
}

describe('NotionImageUploadService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates and sends a single-part upload with raw bytes', async () => {
    const { notion, service } = setup();

    await expect(service.upload(image)).resolves.toBe('upload-a');
    expect(notion.fileUploads.create).toHaveBeenCalledExactlyOnceWith({
      content_type: 'image/png',
      filename: 'IMAGEA.png',
      mode: 'single_part',
    });
    expect(notion.fileUploads.send).toHaveBeenCalledTimes(1);
    expect(notion.fileUploads.send.mock.calls[0]?.[0]).toMatchObject({
      file: { filename: 'IMAGEA.png' },
      file_upload_id: 'upload-a',
    });
    expect(notion.fileUploads.send.mock.calls[0]?.[0].file.data).toBeInstanceOf(
      Blob,
    );
  });

  it('retrieves status after an ambiguous send timeout without resending', async () => {
    const { notion, service } = setup();
    notion.fileUploads.send.mockRejectedValue(new RequestTimeoutError());
    notion.fileUploads.retrieve.mockResolvedValue(uploadResponse('uploaded'));

    await expect(service.upload(image)).resolves.toBe('upload-a');
    expect(notion.fileUploads.send).toHaveBeenCalledTimes(1);
    expect(notion.fileUploads.retrieve).toHaveBeenCalledExactlyOnceWith({
      file_upload_id: 'upload-a',
    });
  });

  it.each([
    [APIErrorCode.Unauthorized, 401],
    [APIErrorCode.RestrictedResource, 403],
  ])('does not retry %s errors', async (code, status) => {
    const { notion, service } = setup();
    notion.fileUploads.create.mockRejectedValue(
      new APIResponseError({
        code,
        headers: {},
        message: 'Denied',
        rawBodyText: 'private response body',
        status,
      }),
    );

    await expect(service.upload(image)).rejects.toThrow('Denied');
    expect(notion.fileUploads.create).toHaveBeenCalledTimes(1);
  });

  it('bounds status retries for transient errors', async () => {
    const { notion, service } = setup();
    notion.fileUploads.send.mockRejectedValue(new RequestTimeoutError());
    notion.fileUploads.retrieve.mockRejectedValue(
      new APIResponseError({
        code: APIErrorCode.RateLimited,
        headers: {},
        message: 'Limited',
        rawBodyText: 'private response body',
        status: 429,
      }),
    );

    await expect(service.upload(image)).rejects.toThrow('Limited');
    expect(notion.fileUploads.retrieve).toHaveBeenCalledTimes(3);
  });

  it.each([
    [APIErrorCode.ConflictError, 409],
    [APIErrorCode.RateLimited, 429],
    [APIErrorCode.InternalServerError, 500],
    [APIErrorCode.InternalServerError, 503],
    [APIErrorCode.InternalServerError, 504],
    [APIErrorCode.InternalServerError, 529],
  ])('bounds create retries for HTTP %s/%i', async (code, status) => {
    const { notion, service } = setup();
    notion.fileUploads.create.mockRejectedValue(
      new APIResponseError({
        code,
        headers: {},
        message: 'Transient create failure',
        rawBodyText: 'private response body',
        status,
      }),
    );

    await expect(service.upload(image)).rejects.toThrow(
      'Transient create failure',
    );
    expect(notion.fileUploads.create).toHaveBeenCalledTimes(3);
    expect(notion.fileUploads.send).not.toHaveBeenCalled();
  });

  it.each([
    [APIErrorCode.ConflictError, 409],
    [APIErrorCode.RateLimited, 429],
    [APIErrorCode.InternalServerError, 500],
    [APIErrorCode.InternalServerError, 503],
    [APIErrorCode.InternalServerError, 504],
    [APIErrorCode.InternalServerError, 529],
  ])(
    'checks status instead of blindly resending after HTTP %s/%i',
    async (code, status) => {
      const { notion, service } = setup();
      notion.fileUploads.send.mockRejectedValue(
        new APIResponseError({
          code,
          headers: {},
          message: 'Transient send failure',
          rawBodyText: 'private response body',
          status,
        }),
      );
      notion.fileUploads.retrieve.mockResolvedValue(uploadResponse('uploaded'));

      await expect(service.upload(image)).resolves.toBe('upload-a');
      expect(notion.fileUploads.send).toHaveBeenCalledTimes(1);
      expect(notion.fileUploads.retrieve).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects expired uploads', async () => {
    const { notion, service } = setup();
    notion.fileUploads.send.mockResolvedValue(uploadResponse('pending'));
    notion.fileUploads.retrieve.mockResolvedValue(uploadResponse('expired'));

    await expect(service.upload(image)).rejects.toThrow(
      'Notion file upload did not complete: expired',
    );
  });

  it('polls a pending upload with bounded attempts', async () => {
    const { notion, service } = setup();
    notion.fileUploads.send.mockResolvedValue(uploadResponse('pending'));
    notion.fileUploads.retrieve.mockResolvedValue(uploadResponse('pending'));

    await expect(service.upload(image)).rejects.toThrow(
      'Notion file upload did not complete: pending',
    );
    expect(notion.fileUploads.retrieve).toHaveBeenCalledTimes(3);
  });

  it('honors Retry-After before retrying a 429 create response', async () => {
    vi.useFakeTimers();
    const { notion, service } = setup();
    notion.fileUploads.create
      .mockRejectedValueOnce(
        new APIResponseError({
          code: APIErrorCode.RateLimited,
          headers: { 'retry-after': '2' },
          message: 'Limited',
          rawBodyText: 'private response body',
          status: 429,
        }),
      )
      .mockResolvedValue(uploadResponse('pending'));

    const result = service.upload(image);
    await vi.advanceTimersByTimeAsync(1999);
    expect(notion.fileUploads.create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('upload-a');
    expect(notion.fileUploads.create).toHaveBeenCalledTimes(2);
  });

  it('parses Retry-After seconds and HTTP dates and rejects invalid values', () => {
    const now = Date.parse('2026-08-27T00:00:00.000Z');

    expect(parseRetryAfter('2.5', now)).toBe(2500);
    expect(parseRetryAfter('Thu, 27 Aug 2026 00:00:03 GMT', now)).toBe(3000);
    expect(parseRetryAfter('-1', now)).toBeUndefined();
    expect(parseRetryAfter('not-a-delay', now)).toBeUndefined();
  });

  it('falls back to bounded jittered backoff for an invalid Retry-After', async () => {
    const notion = mockDeep<Client>();
    const sleep = vi.fn<(delayMilliseconds: number) => Promise<void>>(
      async () => undefined,
    );
    notion.fileUploads.create
      .mockRejectedValueOnce(
        new APIResponseError({
          code: APIErrorCode.RateLimited,
          headers: { 'retry-after': 'invalid' },
          message: 'Limited',
          rawBodyText: 'redacted',
          status: 429,
        }),
      )
      .mockResolvedValue(uploadResponse('pending'));
    notion.fileUploads.send.mockResolvedValue(uploadResponse('uploaded'));
    const service = new NotionImageUploadService(notion, {
      now: () => 0,
      random: () => 0,
      sleep,
    });

    await expect(service.upload(image)).resolves.toBe('upload-a');
    expect(sleep).toHaveBeenCalledExactlyOnceWith(50);
  });

  it('stops before sleeping beyond the total retry wait budget', async () => {
    const notion = mockDeep<Client>();
    const sleep = vi.fn<(delayMilliseconds: number) => Promise<void>>(
      async () => undefined,
    );
    notion.fileUploads.create.mockRejectedValue(
      new APIResponseError({
        code: APIErrorCode.RateLimited,
        headers: { 'retry-after': '2' },
        message: 'Limited',
        rawBodyText: 'redacted',
        status: 429,
      }),
    );
    const service = new NotionImageUploadService(notion, {
      maxTotalWaitMilliseconds: 1000,
      now: () => 0,
      random: () => 0,
      sleep,
    });

    await expect(service.upload(image)).rejects.toThrow(/wait budget/i);
    expect(notion.fileUploads.create).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('reconciles an ambiguous create response by a unique listed upload', async () => {
    const { notion, service } = setup();
    notion.fileUploads.create.mockRejectedValue(new RequestTimeoutError());
    notion.fileUploads.list.mockResolvedValue({
      file_upload: {},
      has_more: false,
      next_cursor: null,
      object: 'list',
      results: [
        {
          ...uploadResponse('pending'),
          created_time: new Date().toISOString(),
        },
      ],
      type: 'file_upload',
    });

    await expect(service.upload(image)).resolves.toBe('upload-a');
    expect(notion.fileUploads.create).toHaveBeenCalledTimes(1);
    expect(notion.fileUploads.list).toHaveBeenCalled();
    expect(notion.fileUploads.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ file_upload_id: 'upload-a' }),
    );
  });

  it('stops when ambiguous create reconciliation is not a unique match', async () => {
    const { notion, service } = setup();
    notion.fileUploads.create.mockRejectedValue(new RequestTimeoutError());
    notion.fileUploads.list.mockResolvedValue({
      file_upload: {},
      has_more: false,
      next_cursor: null,
      object: 'list',
      results: [
        {
          ...uploadResponse('pending'),
          created_time: new Date().toISOString(),
        },
        {
          ...uploadResponse('pending'),
          created_time: new Date().toISOString(),
          id: 'upload-b',
        },
      ],
      type: 'file_upload',
    });

    await expect(service.upload(image)).rejects.toThrow(/ambiguous|unique/i);
    expect(notion.fileUploads.create).toHaveBeenCalledTimes(1);
    expect(notion.fileUploads.send).not.toHaveBeenCalled();
  });

  it('constructs upload payloads and hashes in the Zotero main-window realm', async () => {
    const { notion, service } = setup();
    const realmBlob = class RealmBlob extends Blob {};
    const digest = vi.fn<
      (
        algorithm: AlgorithmIdentifier,
        data: BufferSource,
      ) => Promise<ArrayBuffer>
    >(async () => new Uint8Array(32).buffer);
    const randomUUID = vi.fn<Crypto['randomUUID']>(
      () => '00000000-0000-4000-8000-000000000000',
    );
    const realmWindow = createWindowMock();
    Object.defineProperties(realmWindow, {
      Blob: { configurable: true, value: realmBlob },
      crypto: {
        configurable: true,
        value: { randomUUID, subtle: { digest } },
      },
    });
    zoteroMock.getMainWindow.mockReturnValue(realmWindow);

    await service.upload(image);
    await hashBytes(image.bytes);

    const sentBlob = notion.fileUploads.send.mock.calls[0]?.[0].file.data;
    expect(sentBlob).toBeInstanceOf(realmBlob);
    expect(digest).toHaveBeenCalled();
  });
});

describe('Notion target isolation', () => {
  it('requires connection, database, and page identity to match', () => {
    expect(isSameNotionTarget(target, { ...target })).toBe(true);
    expect(
      isSameNotionTarget(target, { ...target, connectionID: 'bot-b' }),
    ).toBe(false);
    expect(
      isSameNotionTarget(target, { ...target, workspaceID: 'workspace-b' }),
    ).toBe(false);
    expect(
      isSameNotionTarget(target, { ...target, databaseID: 'database-b' }),
    ).toBe(false);
    expect(isSameNotionTarget(target, { ...target, pageID: 'page-b' })).toBe(
      false,
    );
  });
});
