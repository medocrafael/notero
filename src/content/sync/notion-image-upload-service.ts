import {
  APIResponseError,
  RequestTimeoutError,
  type Client,
} from '@notionhq/client';

import type { ResolvedNoteImage } from './note-image-resolver';

export type NotionTarget = {
  connectionID: string;
  databaseID: string;
  pageID: string;
  workspaceID: string;
};

const MAX_API_ATTEMPTS = 3;

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

function isRetryableError(error: unknown): boolean {
  if (RequestTimeoutError.isRequestTimeoutError(error)) return true;
  if (error instanceof TypeError) return true;
  if (!(error instanceof APIResponseError)) return false;
  return [409, 429, 500, 502, 503, 504, 529].includes(error.status);
}

function wait(delayMilliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMilliseconds);
  });
}

export class NotionImageUploadService {
  public constructor(private readonly notion: Client) {}

  public async upload(image: ResolvedNoteImage): Promise<string> {
    const created = await this.createWithRetry(image);

    try {
      const uploaded = await this.notion.fileUploads.send({
        file: {
          data: new Blob([image.bytes], { type: image.contentType }),
          filename: image.filename,
        },
        file_upload_id: created.id,
      });

      if (uploaded.status === 'uploaded') return uploaded.id;
    } catch (error) {
      if (!isRetryableError(error)) throw error;
    }

    const upload = await this.retrieveWithRetry(created.id);
    if (upload.status !== 'uploaded') {
      throw new Error(`Notion file upload did not complete: ${upload.status}`);
    }

    return upload.id;
  }

  private async createWithRetry(image: ResolvedNoteImage) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt += 1) {
      try {
        return await this.notion.fileUploads.create({
          content_type: image.contentType,
          filename: image.filename,
          mode: 'single_part',
        });
      } catch (error) {
        lastError = error;
        if (!isRetryableError(error) || attempt === MAX_API_ATTEMPTS) {
          throw error;
        }
        await wait(50 * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }

  private async retrieveWithRetry(fileUploadID: string) {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt += 1) {
      try {
        const upload = await this.notion.fileUploads.retrieve({
          file_upload_id: fileUploadID,
        });
        if (upload.status !== 'pending' || attempt === MAX_API_ATTEMPTS) {
          return upload;
        }
      } catch (error) {
        lastError = error;
        if (!isRetryableError(error) || attempt === MAX_API_ATTEMPTS) {
          throw error;
        }
      }
      await wait(50 * 2 ** (attempt - 1));
    }

    throw lastError;
  }
}
