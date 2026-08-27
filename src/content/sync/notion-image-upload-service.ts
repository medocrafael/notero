import {
  APIResponseError,
  RequestTimeoutError,
  type Client,
} from '@notionhq/client';
import type { FileUploadObjectResponse } from '@notionhq/client/build/src/api-endpoints';

import type { ResolvedNoteImage } from './note-image-resolver';
import { createZoteroBlob } from './zotero-web-api';

export type NotionTarget = {
  connectionID: string;
  databaseID: string;
  pageID: string;
  workspaceID: string;
};

export type UploadJournalHooks = {
  onCreated?: (upload: FileUploadObjectResponse) => Promise<void>;
  onStatus?: (upload: FileUploadObjectResponse) => Promise<void>;
};

export type RetryRuntime = {
  maxAttempts: number;
  maxTotalWaitMilliseconds: number;
  now: () => number;
  random: () => number;
  sleep: (delayMilliseconds: number) => Promise<void>;
};

const DEFAULT_RETRY_RUNTIME: RetryRuntime = {
  maxAttempts: 3,
  maxTotalWaitMilliseconds: 30_000,
  now: Date.now,
  random: Math.random,
  sleep: (delayMilliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, delayMilliseconds);
    }),
};
const CREATE_RECONCILIATION_WINDOW_MS = 2 * 60 * 1000;
const MAX_UPLOAD_LIST_PAGES = 3;

export function isSameNotionTarget(
  left: NotionTarget | undefined,
  right: NotionTarget | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.connectionID === right.connectionID &&
    left.workspaceID === right.workspaceID &&
    left.databaseID === right.databaseID &&
    left.pageID === right.pageID,
  );
}

function isNetworkAmbiguous(error: unknown): boolean {
  return (
    RequestTimeoutError.isRequestTimeoutError(error) ||
    error instanceof TypeError
  );
}

function isRetryableResponse(error: unknown): boolean {
  return (
    error instanceof APIResponseError &&
    [409, 429, 500, 502, 503, 504, 529].includes(error.status)
  );
}

function getHeader(error: APIResponseError, name: string): string | undefined {
  const headers = error.headers;
  if (headers instanceof Headers) return headers.get(name) || undefined;
  if (!headers || typeof headers !== 'object') return undefined;
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

export function parseRetryAfter(
  value: string | undefined,
  nowMilliseconds: number,
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : undefined;
  }
  const dateMilliseconds = Date.parse(value);
  if (Number.isNaN(dateMilliseconds)) return undefined;
  return Math.max(0, dateMilliseconds - nowMilliseconds);
}

function getRetryDelay(
  error: unknown,
  attempt: number,
  runtime: RetryRuntime,
): number {
  if (error instanceof APIResponseError && error.status === 429) {
    const retryAfter = parseRetryAfter(
      getHeader(error, 'retry-after'),
      runtime.now(),
    );
    if (retryAfter !== undefined) return retryAfter;
  }
  const exponential = 100 * 2 ** (attempt - 1);
  return Math.round(exponential * (0.5 + runtime.random()));
}

async function waitForRetry(
  error: unknown,
  attempt: number,
  startedAt: number,
  runtime: RetryRuntime,
): Promise<void> {
  const delay = getRetryDelay(error, attempt, runtime);
  if (runtime.now() - startedAt + delay > runtime.maxTotalWaitMilliseconds) {
    throw new Error('Notion retry wait budget exceeded', { cause: error });
  }
  await runtime.sleep(delay);
}

export class NotionImageUploadService {
  private readonly runtime: RetryRuntime;

  public constructor(
    private readonly notion: Client,
    runtime: Partial<RetryRuntime> = {},
  ) {
    this.runtime = { ...DEFAULT_RETRY_RUNTIME, ...runtime };
  }

  public async upload(
    image: ResolvedNoteImage,
    hooks: UploadJournalHooks = {},
  ): Promise<string> {
    const created = await this.createSafely(image);
    await hooks.onCreated?.(created);

    try {
      const uploaded = await this.notion.fileUploads.send({
        file: {
          data: createZoteroBlob([image.bytes], { type: image.contentType }),
          filename: image.filename,
        },
        file_upload_id: created.id,
      });
      await hooks.onStatus?.(uploaded);
      if (uploaded.status === 'uploaded') return uploaded.id;
    } catch (error) {
      if (!isNetworkAmbiguous(error) && !isRetryableResponse(error)) {
        throw error;
      }
    }

    const upload = await this.retrieveWithRetry(created.id);
    await hooks.onStatus?.(upload);
    if (upload.status !== 'uploaded') {
      throw new Error(`Notion file upload did not complete: ${upload.status}`);
    }
    return upload.id;
  }

  public async retrieve(
    fileUploadID: string,
  ): Promise<FileUploadObjectResponse> {
    return this.retrieveWithRetry(fileUploadID);
  }

  private async createSafely(
    image: ResolvedNoteImage,
  ): Promise<FileUploadObjectResponse> {
    const startedAt = this.runtime.now();
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.runtime.maxAttempts; attempt += 1) {
      try {
        return await this.notion.fileUploads.create({
          content_type: image.contentType,
          filename: image.filename,
          mode: 'single_part',
        });
      } catch (error) {
        lastError = error;
        if (isNetworkAmbiguous(error)) {
          return this.reconcileAmbiguousCreate(image, startedAt);
        }
        if (
          !isRetryableResponse(error) ||
          attempt === this.runtime.maxAttempts
        ) {
          throw error;
        }
        await waitForRetry(error, attempt, startedAt, this.runtime);
      }
    }
    throw lastError;
  }

  private async reconcileAmbiguousCreate(
    image: ResolvedNoteImage,
    requestStartedAt: number,
  ): Promise<FileUploadObjectResponse> {
    const matches: FileUploadObjectResponse[] = [];
    let startCursor: string | undefined;
    for (let page = 0; page < MAX_UPLOAD_LIST_PAGES; page += 1) {
      const response = await this.listWithRetry(startCursor);
      for (const upload of response.results) {
        const createdAt = Date.parse(upload.created_time);
        if (
          upload.filename === image.filename &&
          upload.content_type === image.contentType &&
          upload.content_length === image.size &&
          Number.isFinite(createdAt) &&
          createdAt >= requestStartedAt - CREATE_RECONCILIATION_WINDOW_MS &&
          createdAt <= this.runtime.now() + CREATE_RECONCILIATION_WINDOW_MS
        ) {
          matches.push(upload);
        }
      }
      if (!response.has_more) break;
      if (!response.next_cursor) {
        throw new Error('Notion upload reconciliation cursor is missing');
      }
      startCursor = response.next_cursor;
    }

    if (matches.length !== 1) {
      throw new Error(
        `Ambiguous Notion file upload creation: expected one match, found ${matches.length}`,
      );
    }
    const match = matches[0];
    if (!match)
      throw new Error('Notion upload reconciliation match is missing');
    return match;
  }

  private async listWithRetry(startCursor?: string) {
    return this.retryRead(() =>
      this.notion.fileUploads.list({
        page_size: 100,
        ...(startCursor && { start_cursor: startCursor }),
      }),
    );
  }

  private async retrieveWithRetry(fileUploadID: string) {
    let lastError: unknown;
    const startedAt = this.runtime.now();
    for (let attempt = 1; attempt <= this.runtime.maxAttempts; attempt += 1) {
      try {
        const upload = await this.notion.fileUploads.retrieve({
          file_upload_id: fileUploadID,
        });
        if (
          upload.status !== 'pending' ||
          attempt === this.runtime.maxAttempts
        ) {
          return upload;
        }
        lastError = new Error('Notion file upload is still pending');
      } catch (error) {
        lastError = error;
        if (
          (!isNetworkAmbiguous(error) && !isRetryableResponse(error)) ||
          attempt === this.runtime.maxAttempts
        ) {
          throw error;
        }
      }
      await waitForRetry(lastError, attempt, startedAt, this.runtime);
    }
    throw lastError;
  }

  private async retryRead<T>(request: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    const startedAt = this.runtime.now();
    for (let attempt = 1; attempt <= this.runtime.maxAttempts; attempt += 1) {
      try {
        return await request();
      } catch (error) {
        lastError = error;
        if (
          (!isNetworkAmbiguous(error) && !isRetryableResponse(error)) ||
          attempt === this.runtime.maxAttempts
        ) {
          throw error;
        }
        await waitForRetry(error, attempt, startedAt, this.runtime);
      }
    }
    throw lastError;
  }
}
