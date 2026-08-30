import { APIErrorCode, APIResponseError, type Client } from '@notionhq/client';
import type {
  AppendBlockChildrenParameters,
  AppendBlockChildrenResponse,
  BlockObjectRequest,
  BlockObjectResponse,
  FileUploadObjectResponse,
  ListBlockChildrenResponse,
} from '@notionhq/client/build/src/api-endpoints';
import { mockDeep } from 'vitest-mock-extended';

import { isObject } from '../../utils';

type StoredBlock = {
  children: string[];
  request: BlockObjectRequest;
  response: BlockObjectResponse;
};

type HeadingRequest = Extract<BlockObjectRequest, { heading_1: unknown }>;

type FailureInjection = {
  afterWrite: boolean;
  error: Error;
};

export type StatefulNotionEvent = {
  operation:
    | 'append'
    | 'create-upload'
    | 'delete'
    | 'list-children'
    | 'retrieve'
    | 'retrieve-upload'
    | 'send-upload'
    | 'update';
  target: string;
  type:
    | 'remote-mutation-committed'
    | 'remote-operation'
    | 'response-delivered'
    | 'response-lost';
};

type UploadLifecycle =
  | 'attached-persistent'
  | 'expired'
  | 'failed'
  | 'pending'
  | 'uploaded-unattached';

export class StatefulNotionServer {
  public readonly blocks = new Map<string, StoredBlock>();
  public readonly children = new Map<string, string[]>();
  public readonly events: StatefulNotionEvent[] = [];
  public readonly pages: ReadonlySet<string>;
  public readonly uploads = new Map<string, FileUploadObjectResponse>();
  public appendCount = 0;
  public createUploadCount = 0;
  public deleteCount = 0;
  public sendUploadCount = 0;

  private appendFailure?: FailureInjection;
  private appendFailureAt?: number;
  private blockCounter = 0;
  private clockOffsetMilliseconds = 0;
  private createUploadFailure?: FailureInjection;
  private deleteFailure?: FailureInjection;
  private incompletePagination = false;
  private nextUploadContentLength: null | number = null;
  private permissionFailure?: Error;
  private readonly uploadLifecycles = new Map<string, UploadLifecycle>();
  private readonly uploadWorkspaces = new Map<string, string>();
  private sendUploadFailure?: FailureInjection;
  private updateFailure?: FailureInjection;
  private uploadCounter = 0;

  public constructor(
    public readonly botID = 'bot-a',
    public readonly pageID = 'page-a',
    public readonly workspaceID = 'workspace-a',
    private readonly clock: () => number = Date.now,
  ) {
    this.pages = new Set([pageID]);
  }

  public client(): Client {
    const notion = mockDeep<Client>();
    notion.blocks.children.append.mockImplementation((request) =>
      this.append(request),
    );
    notion.blocks.children.list.mockImplementation((request) =>
      this.listChildren(request.block_id),
    );
    notion.blocks.retrieve.mockImplementation(({ block_id }) =>
      this.retrieve(block_id),
    );
    notion.blocks.update.mockImplementation((request) =>
      this.updateHeading(request.block_id, request),
    );
    notion.blocks.delete.mockImplementation(({ block_id }) =>
      this.delete(block_id),
    );
    notion.fileUploads.create.mockImplementation((request) =>
      this.createUpload(request.filename || null, request.content_type || null),
    );
    notion.fileUploads.send.mockImplementation((request) => {
      const data = request.file.data;
      const size =
        typeof data === 'string'
          ? new TextEncoder().encode(data).byteLength
          : data.size;
      return this.sendUpload(request.file_upload_id, size);
    });
    notion.fileUploads.retrieve.mockImplementation(({ file_upload_id }) =>
      this.retrieveUpload(file_upload_id),
    );
    notion.fileUploads.list.mockImplementation(() => {
      for (const id of this.uploads.keys()) this.refreshUpload(id);
      return Promise.resolve({
        file_upload: {},
        has_more: false,
        next_cursor: null,
        object: 'list',
        results: Array.from(this.uploads.values()),
        type: 'file_upload',
      });
    });
    return notion;
  }

  public failNextAppend(error: Error, afterWrite = false): void {
    this.appendFailure = { afterWrite, error };
    this.appendFailureAt = this.appendCount + 1;
  }

  public failAppendAt(
    appendNumber: number,
    error: Error,
    afterWrite = false,
  ): void {
    this.appendFailure = { afterWrite, error };
    this.appendFailureAt = appendNumber;
  }

  public failNextCreateUpload(error: Error, afterWrite = false): void {
    this.createUploadFailure = { afterWrite, error };
  }

  public failNextDelete(error: Error, afterWrite = false): void {
    this.deleteFailure = { afterWrite, error };
  }

  public failNextSendUpload(error: Error, afterWrite = false): void {
    this.sendUploadFailure = { afterWrite, error };
  }

  public failNextUpdate(error: Error, afterWrite = false): void {
    this.updateFailure = { afterWrite, error };
  }

  public setIncompletePagination(enabled: boolean): void {
    this.incompletePagination = enabled;
  }

  public losePermission(
    error: Error = notionError(APIErrorCode.RestrictedResource, 403),
  ): void {
    this.permissionFailure = error;
  }

  public restorePermission(): void {
    this.permissionFailure = undefined;
  }

  public touchBlock(blockID: string): void {
    const stored = this.blocks.get(blockID);
    if (!stored) throw new Error(`Synthetic block ${blockID} is missing`);
    stored.response = {
      ...stored.response,
      last_edited_time: new Date(this.now() + 1).toISOString(),
    };
  }

  public setTrashState(
    blockID: string,
    state: { archived: boolean; inTrash: boolean },
  ): void {
    const stored = this.blocks.get(blockID);
    if (!stored) throw new Error(`Synthetic block ${blockID} is missing`);
    stored.response = {
      ...stored.response,
      archived: state.archived,
      in_trash: state.inTrash,
    };
  }

  public corruptHeadingOwnership(blockID: string): void {
    const stored = this.blocks.get(blockID);
    if (!stored || stored.response.type !== 'heading_1') {
      throw new Error(`Synthetic heading ${blockID} is missing`);
    }
    const richText = stored.response.heading_1.rich_text.slice();
    const marker = richText.at(-2);
    if (!marker || marker.type !== 'text') {
      throw new Error(`Synthetic heading ${blockID} has no ownership marker`);
    }
    richText[richText.length - 2] = {
      ...marker,
      plain_text: `${marker.plain_text}:user-edited`,
      text: {
        ...marker.text,
        content: `${marker.text.content}:user-edited`,
      },
    };
    stored.response = {
      ...stored.response,
      heading_1: { ...stored.response.heading_1, rich_text: richText },
      last_edited_time: new Date(this.now() + 1).toISOString(),
    };
  }

  public duplicateHeading(blockID: string, duplicateID: string): void {
    const stored = this.blocks.get(blockID);
    if (!stored || !('heading_1' in stored.request)) {
      throw new Error(`Synthetic heading ${blockID} is missing`);
    }
    const parent = stored.response.parent;
    if (parent.type !== 'block_id' && parent.type !== 'page_id') {
      throw new Error(`Synthetic heading ${blockID} has unsupported parent`);
    }
    this.seedHeading(
      duplicateID,
      parent.type === 'page_id' ? parent.page_id : parent.block_id,
      parent.type,
      structuredClone(stored.request),
      stored.response.created_by.id,
    );
  }

  public canonicalProjection(): unknown {
    return {
      blocks: Array.from(this.blocks.entries())
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([id, stored]) => ({
          children: stored.children.slice(),
          id,
          request: structuredClone(stored.request),
          response: structuredClone(stored.response),
        })),
      children: Array.from(this.children.entries())
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([id, children]) => [id, children.slice()]),
      uploads: Array.from(this.uploads.entries())
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([id, upload]) => [id, structuredClone(upload)]),
    };
  }

  public fork(clock: () => number = this.clock): StatefulNotionServer {
    const copy = new StatefulNotionServer(
      this.botID,
      this.pageID,
      this.workspaceID,
      clock,
    );
    for (const [id, stored] of this.blocks) {
      copy.blocks.set(id, structuredClone(stored));
    }
    for (const [id, children] of this.children) {
      copy.children.set(id, children.slice());
    }
    copy.events.push(...structuredClone(this.events));
    for (const [id, upload] of this.uploads) {
      copy.uploads.set(id, structuredClone(upload));
    }
    copy.appendCount = this.appendCount;
    copy.createUploadCount = this.createUploadCount;
    copy.deleteCount = this.deleteCount;
    copy.sendUploadCount = this.sendUploadCount;
    copy.appendFailure = this.appendFailure;
    copy.appendFailureAt = this.appendFailureAt;
    copy.blockCounter = this.blockCounter;
    copy.clockOffsetMilliseconds = this.clockOffsetMilliseconds;
    copy.createUploadFailure = this.createUploadFailure;
    copy.deleteFailure = this.deleteFailure;
    copy.incompletePagination = this.incompletePagination;
    copy.nextUploadContentLength = this.nextUploadContentLength;
    copy.permissionFailure = this.permissionFailure;
    copy.sendUploadFailure = this.sendUploadFailure;
    copy.updateFailure = this.updateFailure;
    copy.uploadCounter = this.uploadCounter;
    for (const [id, lifecycle] of this.uploadLifecycles) {
      copy.uploadLifecycles.set(id, lifecycle);
    }
    for (const [id, workspace] of this.uploadWorkspaces) {
      copy.uploadWorkspaces.set(id, workspace);
    }
    return copy;
  }

  public moveBlock(
    blockID: string,
    parentID: string,
    parentType: 'block_id' | 'page_id' = 'block_id',
  ): void {
    const stored = this.blocks.get(blockID);
    if (!stored) throw new Error(`Synthetic block ${blockID} is missing`);
    stored.response = {
      ...stored.response,
      parent:
        parentType === 'page_id'
          ? { page_id: parentID, type: 'page_id' }
          : { block_id: parentID, type: 'block_id' },
    };
  }

  public setNextUploadContentLength(length: null | number): void {
    this.nextUploadContentLength = length;
  }

  public seedUpload(
    upload: FileUploadObjectResponse,
    workspaceID = this.workspaceID,
  ): void {
    this.uploads.set(upload.id, upload);
    this.uploadWorkspaces.set(upload.id, workspaceID);
    this.uploadLifecycles.set(upload.id, this.inferUploadLifecycle(upload));
  }

  public advanceTime(milliseconds: number): void {
    this.clockOffsetMilliseconds += milliseconds;
    for (const id of this.uploads.keys()) this.refreshUpload(id);
  }

  public seedHeading(
    id: string,
    parentID: string,
    parentType: 'block_id' | 'page_id',
    request: HeadingRequest,
    creator = this.botID,
  ): void {
    const response = this.headingResponse(
      id,
      parentID,
      parentType,
      request.heading_1.rich_text,
      creator,
    );
    this.blocks.set(id, { children: [], request, response });
    this.addChild(parentID, id);
  }

  public visibleChildren(parentID: string): StoredBlock[] {
    return (this.children.get(parentID) || [])
      .map((id) => this.blocks.get(id))
      .filter((block): block is StoredBlock =>
        Boolean(block && !block.response.in_trash && !block.response.archived),
      );
  }

  private async append(
    request: AppendBlockChildrenParameters,
  ): Promise<AppendBlockChildrenResponse> {
    this.event('remote-operation', 'append', request.block_id);
    this.assertPermission();
    this.appendCount += 1;
    const uploadIDs = this.collectFileUploadIDs(request.children);
    for (const uploadID of uploadIDs) this.assertAttachableUpload(uploadID);
    const failure =
      this.appendFailureAt === this.appendCount
        ? this.appendFailure
        : undefined;
    if (failure && !failure.afterWrite) {
      this.appendFailure = undefined;
      this.event('response-lost', 'append', request.block_id);
      throw failure.error;
    }
    const results = request.children.map((child) =>
      this.storeRequestBlock(request.block_id, child),
    );
    for (const uploadID of uploadIDs) this.attachUpload(uploadID);
    this.event('remote-mutation-committed', 'append', request.block_id);
    if (failure?.afterWrite) {
      this.appendFailure = undefined;
      this.event('response-lost', 'append', request.block_id);
      throw failure.error;
    }
    this.event('response-delivered', 'append', request.block_id);
    return {
      block: {},
      has_more: false,
      next_cursor: null,
      object: 'list',
      results,
      type: 'block',
    };
  }

  private storeRequestBlock(parentID: string, request: BlockObjectRequest) {
    const id = `block-${++this.blockCounter}`;
    if ('heading_1' in request) {
      const response = this.headingResponse(
        id,
        parentID,
        parentID === this.pageID ? 'page_id' : 'block_id',
        request.heading_1.rich_text,
      );
      const stored: StoredBlock = { children: [], request, response };
      this.blocks.set(id, stored);
      this.addChild(parentID, id);
      for (const child of request.heading_1.children || []) {
        this.storeRequestBlock(id, child);
      }
      return response;
    }
    const response = this.genericResponse(
      id,
      parentID,
      parentID === this.pageID ? 'page_id' : 'block_id',
      request,
    );
    this.blocks.set(id, { children: [], request, response });
    this.addChild(parentID, id);
    return response;
  }

  private async listChildren(
    parentID: string,
  ): Promise<ListBlockChildrenResponse> {
    this.event('remote-operation', 'list-children', parentID);
    this.assertPermission();
    if (this.incompletePagination) {
      return {
        block: {},
        has_more: true,
        next_cursor: null,
        object: 'list',
        results: this.visibleChildren(parentID).map(({ response }) => response),
        type: 'block',
      };
    }
    return {
      block: {},
      has_more: false,
      next_cursor: null,
      object: 'list',
      results: this.visibleChildren(parentID).map(({ response }) => response),
      type: 'block',
    };
  }

  private async retrieve(id: string): Promise<BlockObjectResponse> {
    this.event('remote-operation', 'retrieve', id);
    this.assertPermission();
    const block = this.blocks.get(id)?.response;
    if (!block) throw notionError(APIErrorCode.ObjectNotFound, 404);
    this.event('response-delivered', 'retrieve', id);
    return block;
  }

  private async updateHeading(
    id: string,
    request: Parameters<Client['blocks']['update']>[0],
  ): Promise<BlockObjectResponse> {
    this.event('remote-operation', 'update', id);
    this.assertPermission();
    const failure = this.updateFailure;
    this.updateFailure = undefined;
    if (failure && !failure.afterWrite) {
      this.event('response-lost', 'update', id);
      throw failure.error;
    }
    const stored = this.blocks.get(id);
    if (!stored || !('heading_1' in request)) {
      throw notionError(APIErrorCode.ObjectNotFound, 404);
    }
    const parent = stored.response.parent;
    if (parent.type !== 'page_id' && parent.type !== 'block_id') {
      throw new Error(`Unexpected heading parent type: ${parent.type}`);
    }
    const parentID =
      parent.type === 'page_id' ? parent.page_id : parent.block_id;
    const response = this.headingResponse(
      id,
      parentID,
      parent.type === 'page_id' ? 'page_id' : 'block_id',
      request.heading_1.rich_text || [],
    );
    stored.response = response;
    this.event('remote-mutation-committed', 'update', id);
    if (failure?.afterWrite) {
      this.event('response-lost', 'update', id);
      throw failure.error;
    }
    this.event('response-delivered', 'update', id);
    return response;
  }

  private async delete(id: string): Promise<BlockObjectResponse> {
    this.event('remote-operation', 'delete', id);
    this.assertPermission();
    this.deleteCount += 1;
    const failure = this.deleteFailure;
    this.deleteFailure = undefined;
    if (failure && !failure.afterWrite) {
      this.event('response-lost', 'delete', id);
      throw failure.error;
    }
    const stored = this.blocks.get(id);
    if (!stored) throw notionError(APIErrorCode.ObjectNotFound, 404);
    stored.response = {
      ...stored.response,
      archived: true,
      in_trash: true,
    };
    this.event('remote-mutation-committed', 'delete', id);
    if (failure?.afterWrite) {
      this.event('response-lost', 'delete', id);
      throw failure.error;
    }
    this.event('response-delivered', 'delete', id);
    return stored.response;
  }

  private async createUpload(
    filename: null | string,
    contentType: null | string,
  ): Promise<FileUploadObjectResponse> {
    this.event('remote-operation', 'create-upload', filename || 'unnamed');
    this.assertPermission();
    this.createUploadCount += 1;
    const failure = this.createUploadFailure;
    this.createUploadFailure = undefined;
    if (failure && !failure.afterWrite) throw failure.error;
    const now = new Date(this.now());
    const upload: FileUploadObjectResponse = {
      archived: false,
      content_length: this.nextUploadContentLength,
      content_type: contentType,
      created_by: { id: this.botID, type: 'bot' },
      created_time: now.toISOString(),
      expiry_time: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      filename,
      id: `upload-${++this.uploadCounter}`,
      last_edited_time: now.toISOString(),
      object: 'file_upload',
      status: 'pending',
    };
    this.uploads.set(upload.id, upload);
    this.uploadLifecycles.set(upload.id, 'pending');
    this.uploadWorkspaces.set(upload.id, this.workspaceID);
    this.event('remote-mutation-committed', 'create-upload', upload.id);
    if (failure?.afterWrite) {
      this.event('response-lost', 'create-upload', upload.id);
      throw failure.error;
    }
    this.event('response-delivered', 'create-upload', upload.id);
    return upload;
  }

  private async sendUpload(
    id: string,
    contentLength: number,
  ): Promise<FileUploadObjectResponse> {
    this.event('remote-operation', 'send-upload', id);
    this.assertPermission();
    const failure = this.sendUploadFailure;
    this.sendUploadFailure = undefined;
    if (failure && !failure.afterWrite) {
      this.event('response-lost', 'send-upload', id);
      throw failure.error;
    }
    const upload = this.refreshUpload(id);
    if (!upload) throw notionError(APIErrorCode.ObjectNotFound, 404);
    if (this.getUploadLifecycle(id, upload) !== 'pending') {
      throw notionError(APIErrorCode.ValidationError, 400);
    }
    this.sendUploadCount += 1;
    const uploaded: FileUploadObjectResponse = {
      ...upload,
      content_length: contentLength,
      status: 'uploaded',
    };
    this.uploads.set(id, uploaded);
    this.uploadLifecycles.set(id, 'uploaded-unattached');
    this.event('remote-mutation-committed', 'send-upload', id);
    if (failure?.afterWrite) {
      this.event('response-lost', 'send-upload', id);
      throw failure.error;
    }
    this.event('response-delivered', 'send-upload', id);
    return uploaded;
  }

  private async retrieveUpload(id: string): Promise<FileUploadObjectResponse> {
    this.event('remote-operation', 'retrieve-upload', id);
    this.assertPermission();
    const upload = this.refreshUpload(id);
    if (!upload) throw notionError(APIErrorCode.ObjectNotFound, 404);
    this.event('response-delivered', 'retrieve-upload', id);
    return upload;
  }

  private assertAttachableUpload(id: string): void {
    const upload = this.refreshUpload(id);
    if (!upload) throw notionError(APIErrorCode.ObjectNotFound, 404);
    const lifecycle = this.getUploadLifecycle(id, upload);
    if (
      this.uploadWorkspaces.get(id) !== this.workspaceID ||
      upload.created_by.id !== this.botID ||
      !['attached-persistent', 'uploaded-unattached'].includes(lifecycle)
    ) {
      throw notionError(APIErrorCode.ValidationError, 400);
    }
  }

  private attachUpload(id: string): void {
    const upload = this.uploads.get(id);
    if (!upload) return;
    this.uploads.set(id, { ...upload, expiry_time: null, status: 'uploaded' });
    this.uploadLifecycles.set(id, 'attached-persistent');
  }

  private collectFileUploadIDs(value: unknown): string[] {
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value)) {
      return value.flatMap((child) => this.collectFileUploadIDs(child));
    }
    if (!isObject(value)) return [];
    const record = value;
    const fileUpload = isObject(record.file_upload)
      ? record.file_upload
      : undefined;
    const ownID =
      record.type === 'file_upload' &&
      fileUpload &&
      typeof fileUpload.id === 'string'
        ? [fileUpload.id]
        : [];
    return [
      ...ownID,
      ...Object.values(record).flatMap((child) =>
        this.collectFileUploadIDs(child),
      ),
    ];
  }

  private getUploadLifecycle(
    id: string,
    upload: FileUploadObjectResponse,
  ): UploadLifecycle {
    const existing = this.uploadLifecycles.get(id);
    if (existing) return existing;
    const inferred = this.inferUploadLifecycle(upload);
    this.uploadLifecycles.set(id, inferred);
    if (!this.uploadWorkspaces.has(id)) {
      this.uploadWorkspaces.set(id, this.workspaceID);
    }
    return inferred;
  }

  private inferUploadLifecycle(
    upload: FileUploadObjectResponse,
  ): UploadLifecycle {
    if (upload.status === 'pending') return 'pending';
    if (upload.status === 'failed') return 'failed';
    if (upload.status === 'expired') return 'expired';
    if (upload.expiry_time === null) return 'attached-persistent';
    return upload.expiry_time && Date.parse(upload.expiry_time) <= this.now()
      ? 'expired'
      : 'uploaded-unattached';
  }

  private refreshUpload(id: string): FileUploadObjectResponse | undefined {
    const upload = this.uploads.get(id);
    if (!upload) return undefined;
    const lifecycle = this.getUploadLifecycle(id, upload);
    if (
      lifecycle !== 'attached-persistent' &&
      upload.expiry_time &&
      Date.parse(upload.expiry_time) <= this.now()
    ) {
      const expired = { ...upload, status: 'expired' as const };
      this.uploads.set(id, expired);
      this.uploadLifecycles.set(id, 'expired');
      return expired;
    }
    return upload;
  }

  private now(): number {
    return this.clock() + this.clockOffsetMilliseconds;
  }

  private event(
    type: StatefulNotionEvent['type'],
    operation: StatefulNotionEvent['operation'],
    target: string,
  ): void {
    this.events.push({ operation, target, type });
  }

  private assertPermission(): void {
    if (this.permissionFailure) throw this.permissionFailure;
  }

  private addChild(parentID: string, id: string): void {
    this.children.set(parentID, [...(this.children.get(parentID) || []), id]);
  }

  private headingResponse(
    id: string,
    parentID: string,
    parentType: 'block_id' | 'page_id',
    richText: Extract<
      BlockObjectRequest,
      { heading_1: unknown }
    >['heading_1']['rich_text'],
    creator = this.botID,
  ): Extract<BlockObjectResponse, { type: 'heading_1' }> {
    const now = new Date(this.now()).toISOString();
    return {
      archived: false,
      created_by: { id: creator, object: 'user' },
      created_time: now,
      has_children: true,
      heading_1: {
        color: 'default',
        is_toggleable: true,
        rich_text: richText.flatMap((value) =>
          'text' in value
            ? [
                {
                  annotations: {
                    bold: value.annotations?.bold || false,
                    code: value.annotations?.code || false,
                    color: value.annotations?.color || 'default',
                    italic: value.annotations?.italic || false,
                    strikethrough: value.annotations?.strikethrough || false,
                    underline: value.annotations?.underline || false,
                  },
                  href: value.text.link?.url || null,
                  plain_text: value.text.content,
                  text: {
                    content: value.text.content,
                    link: value.text.link || null,
                  },
                  type: 'text' as const,
                },
              ]
            : [],
        ),
      },
      id,
      in_trash: false,
      last_edited_by: { id: creator, object: 'user' },
      last_edited_time: now,
      object: 'block',
      parent:
        parentType === 'page_id'
          ? { page_id: parentID, type: 'page_id' }
          : { block_id: parentID, type: 'block_id' },
      type: 'heading_1',
    };
  }

  private genericResponse(
    id: string,
    parentID: string,
    parentType: 'block_id' | 'page_id',
    request: BlockObjectRequest,
  ): BlockObjectResponse {
    const now = new Date(this.now()).toISOString();
    const base = {
      archived: false,
      created_by: { id: this.botID, object: 'user' as const },
      created_time: now,
      has_children: false,
      id,
      in_trash: false,
      last_edited_by: { id: this.botID, object: 'user' as const },
      last_edited_time: now,
      object: 'block' as const,
      parent:
        parentType === 'page_id'
          ? ({ page_id: parentID, type: 'page_id' } as const)
          : ({ block_id: parentID, type: 'block_id' } as const),
    };
    if ('paragraph' in request) {
      return {
        ...base,
        paragraph: {
          color: 'default',
          rich_text: request.paragraph.rich_text.flatMap((value) =>
            'text' in value
              ? [
                  {
                    annotations: {
                      bold: false,
                      code: false,
                      color: 'default' as const,
                      italic: false,
                      strikethrough: false,
                      underline: false,
                    },
                    href: value.text.link?.url || null,
                    plain_text: value.text.content,
                    text: {
                      content: value.text.content,
                      link: value.text.link || null,
                    },
                    type: 'text' as const,
                  },
                ]
              : [],
          ),
        },
        type: 'paragraph',
      };
    }
    if ('image' in request) {
      return {
        ...base,
        image: {
          caption: (request.image.caption || []).flatMap((value) =>
            'text' in value
              ? [
                  {
                    annotations: {
                      bold: value.annotations?.bold || false,
                      code: value.annotations?.code || false,
                      color: value.annotations?.color || ('default' as const),
                      italic: value.annotations?.italic || false,
                      strikethrough: value.annotations?.strikethrough || false,
                      underline: value.annotations?.underline || false,
                    },
                    href: value.text.link?.url || null,
                    plain_text: value.text.content,
                    text: {
                      content: value.text.content,
                      link: value.text.link || null,
                    },
                    type: 'text' as const,
                  },
                ]
              : [],
          ),
          file: {
            expiry_time: new Date(this.now() + 60 * 60 * 1000).toISOString(),
            url: `https://synthetic.invalid/notion/${id}`,
          },
          type: 'file',
        },
        type: 'image',
      };
    }
    // The coordinator never retrieves non-heading content blocks. Keeping the
    // original request in StoredBlock is what state assertions inspect.
    return {
      ...base,
      paragraph: { color: 'default', rich_text: [] },
      type: 'paragraph',
    };
  }
}

export function notionError(
  code: APIErrorCode,
  status: number,
): APIResponseError {
  return new APIResponseError({
    code,
    headers: {},
    message: 'Synthetic Notion failure',
    rawBodyText: 'redacted',
    status,
  });
}
