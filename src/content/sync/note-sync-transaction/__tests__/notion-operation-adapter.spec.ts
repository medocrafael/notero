import { APIErrorCode } from '@notionhq/client';
import type {
  BlockObjectResponse,
  FileUploadObjectResponse,
} from '@notionhq/client/build/src/api-endpoints';
import { APIResponseError } from '@notionhq/client/build/src/errors';
import { describe, expect, it, vi } from 'vite-plus/test';

import { buildManagedHeadingRichText } from '../../notion-block-ownership';
import {
  type NotionBlocksClient,
  NotionOperationAdapter,
  type NotionUploadGateway,
  type OperationPayloadProvider,
} from '../notion-operation-adapter';

import { intent, now, resource, target } from './fixtures';

function emptyMock<T extends (...args: never[]) => unknown>() {
  return vi.fn<T>();
}

function implementationMock<T extends (...args: never[]) => unknown>(
  implementation: T,
) {
  return vi.fn<T>(implementation);
}

function heading(
  blockID: string,
  markers: string[],
  options: {
    creator?: string;
    editedAt?: string;
    inTrash?: boolean;
    parentID?: string;
    parentType?: 'block_id' | 'page_id';
    title?: string;
  } = {},
): Extract<BlockObjectResponse, { type: 'heading_1' }> {
  const title = options.title || 'Synthetic';
  return {
    archived: false,
    created_by: { id: options.creator || target.connectionID, object: 'user' },
    created_time: now,
    has_children: true,
    heading_1: {
      color: 'default',
      is_toggleable: true,
      rich_text: buildManagedHeadingRichText(title, markers).map((value) => ({
        annotations: {
          bold: false,
          code: false,
          color: 'default',
          italic: false,
          strikethrough: false,
          underline: false,
        },
        href: value.text.link?.url || null,
        plain_text: value.text.content,
        text: { content: value.text.content, link: value.text.link || null },
        type: 'text' as const,
      })),
    },
    id: blockID,
    in_trash: options.inTrash || false,
    last_edited_by: { id: target.connectionID, object: 'user' },
    last_edited_time: options.editedAt || now,
    object: 'block',
    parent:
      options.parentType === 'page_id'
        ? { page_id: options.parentID || target.pageID, type: 'page_id' }
        : {
            block_id: options.parentID || 'container-block',
            type: 'block_id',
          },
    type: 'heading_1',
  };
}

function objectNotFound(): APIResponseError {
  return new APIResponseError({
    code: APIErrorCode.ObjectNotFound,
    headers: new Headers(),
    message: 'not found',
    rawBodyText: 'not found',
    status: 404,
  });
}

function upload(status: FileUploadObjectResponse['status']) {
  return {
    archived: false,
    content_length: 4,
    content_type: 'image/png',
    created_by: { id: target.connectionID, type: 'bot' },
    created_time: now,
    expiry_time: status === 'uploaded' ? null : '2026-08-30T01:00:00.000Z',
    filename: 'notero-image.png',
    id: 'upload-test',
    last_edited_time: now,
    object: 'file_upload',
    status,
  } as FileUploadObjectResponse;
}

function adapter(
  blockOverrides: Partial<Omit<NotionBlocksClient['blocks'], 'children'>> & {
    children?: Partial<NotionBlocksClient['blocks']['children']>;
  } = {},
  uploadOverrides: Partial<NotionUploadGateway> = {},
) {
  const blocks: NotionBlocksClient['blocks'] = {
    children: {
      append:
        blockOverrides.children?.append ||
        emptyMock<NotionBlocksClient['blocks']['children']['append']>(),
      list:
        blockOverrides.children?.list ||
        emptyMock<NotionBlocksClient['blocks']['children']['list']>(),
    },
    delete:
      blockOverrides.delete ||
      emptyMock<NotionBlocksClient['blocks']['delete']>(),
    retrieve:
      blockOverrides.retrieve ||
      emptyMock<NotionBlocksClient['blocks']['retrieve']>(),
    update:
      blockOverrides.update ||
      emptyMock<NotionBlocksClient['blocks']['update']>(),
  };
  const notion: NotionBlocksClient = { blocks };
  const uploads: NotionUploadGateway = {
    create:
      uploadOverrides.create || emptyMock<NotionUploadGateway['create']>(),
    reconcileCreate:
      uploadOverrides.reconcileCreate ||
      emptyMock<NotionUploadGateway['reconcileCreate']>(),
    retrieve:
      uploadOverrides.retrieve || emptyMock<NotionUploadGateway['retrieve']>(),
    sendCreated:
      uploadOverrides.sendCreated ||
      emptyMock<NotionUploadGateway['sendCreated']>(),
  };
  const payloads = {
    getAppendBatch: implementationMock<
      OperationPayloadProvider['getAppendBatch']
    >(async () => []),
    getUploadBytes: emptyMock<OperationPayloadProvider['getUploadBytes']>(),
  };
  return {
    blocks,
    payloads,
    remote: new NotionOperationAdapter(notion, payloads, uploads, {
      now: () => now,
    }),
    uploads,
  };
}

describe('Notion operation adapter', () => {
  it('DELETE_INTENT deletes only an exact live resource and requires in_trash proof', async () => {
    const deleteIntent = intent('DELETE_BLOCK');
    if (deleteIntent.kind !== 'DELETE_BLOCK') throw new Error('bad fixture');
    const exact = heading(deleteIntent.details.exactBlockID, [
      deleteIntent.details.expectedOwnershipMarker,
      deleteIntent.details.expectedVersionMarker,
    ]);
    const trashed = { ...exact, in_trash: true };
    const fixture = adapter({
      delete: implementationMock(async () => trashed),
      retrieve: implementationMock(async () => exact),
    });

    const result = await fixture.remote.execute(deleteIntent);

    expect(result).toMatchObject({
      evidence: { result: 'deleted' },
      type: 'success',
    });
    expect(fixture.blocks.delete).toHaveBeenCalledExactlyOnceWith({
      block_id: deleteIntent.details.exactBlockID,
    });
  });

  it('404 remains unknown and never calls delete or fabricates success', async () => {
    const deleteIntent = intent('DELETE_BLOCK');
    const fixture = adapter({
      retrieve: implementationMock(async () => {
        throw objectNotFound();
      }),
    });

    const result = await fixture.remote.observe(deleteIntent);

    expect(result).toMatchObject({
      diagnostic: { code: 'REMOTE_NOT_FOUND' },
      type: 'uncertain',
    });
    expect(fixture.blocks.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['creator', { creator: 'another-bot' }],
    ['parent', { parentID: 'moved-container' }],
    ['lastEditedTime', { editedAt: '2026-08-30T00:00:01.000Z' }],
  ])(
    'quarantines a live delete target with changed %s',
    async (_label, change) => {
      const deleteIntent = intent('DELETE_BLOCK');
      if (deleteIntent.kind !== 'DELETE_BLOCK') throw new Error('bad fixture');
      const changed = heading(
        deleteIntent.details.exactBlockID,
        [
          deleteIntent.details.expectedOwnershipMarker,
          deleteIntent.details.expectedVersionMarker,
        ],
        change,
      );
      const fixture = adapter({
        retrieve: implementationMock(async () => changed),
      });

      const result = await fixture.remote.execute(deleteIntent);

      expect(result).toMatchObject({
        diagnostic: { code: 'OWNERSHIP_CHANGED' },
        type: 'uncertain',
      });
      expect(fixture.blocks.delete).not.toHaveBeenCalled();
    },
  );

  it('accepts exact already-trashed evidence only under the persisted intent', async () => {
    const deleteIntent = intent('DELETE_BLOCK');
    if (deleteIntent.kind !== 'DELETE_BLOCK') throw new Error('bad fixture');
    const exact = heading(
      deleteIntent.details.exactBlockID,
      [
        deleteIntent.details.expectedOwnershipMarker,
        deleteIntent.details.expectedVersionMarker,
      ],
      { inTrash: true },
    );
    const fixture = adapter({
      retrieve: implementationMock(async () => exact),
    });

    const result = await fixture.remote.observe(deleteIntent);

    expect(result).toMatchObject({
      evidence: { result: 'deleted' },
      type: 'success',
    });
    expect(fixture.blocks.delete).not.toHaveBeenCalled();
  });

  it('never replays an append while observing an uncertain APPEND_BATCH', async () => {
    const appendIntent = intent('APPEND_BATCH');
    const fixture = adapter();

    const result = await fixture.remote.observe(appendIntent);

    expect(result).toMatchObject({ type: 'append-unknown' });
    expect(fixture.blocks.children.append).not.toHaveBeenCalled();
    expect(fixture.payloads.getAppendBatch).not.toHaveBeenCalled();
  });

  it('abandons a staging candidate edited after its exact evidence was saved', async () => {
    const appendIntent = intent('APPEND_BATCH');
    if (appendIntent.kind !== 'APPEND_BATCH') throw new Error('bad fixture');
    const edited = heading(
      appendIntent.details.candidate.blockID,
      [
        appendIntent.details.candidate.marker,
        appendIntent.details.candidate.versionMarker,
      ],
      { editedAt: '2026-08-30T00:00:01.000Z' },
    );
    const fixture = adapter({
      retrieve: implementationMock(async () => edited),
    });

    const result = await fixture.remote.execute(appendIntent);

    expect(result).toMatchObject({ type: 'append-unknown' });
    expect(fixture.blocks.children.append).not.toHaveBeenCalled();
  });

  it('never commits a finalized-looking candidate that is archived or trashed', async () => {
    const finalizeIntent = intent('FINALIZE_CANDIDATE');
    if (finalizeIntent.kind !== 'FINALIZE_CANDIDATE') {
      throw new Error('bad fixture');
    }
    const trashed = heading(
      finalizeIntent.details.candidate.blockID,
      [
        finalizeIntent.details.ownershipMarker,
        finalizeIntent.details.versionMarker,
      ],
      { inTrash: true, title: finalizeIntent.details.finalTitle },
    );
    const fixture = adapter({
      retrieve: implementationMock(async () => trashed),
    });

    const result = await fixture.remote.observe(finalizeIntent);

    expect(result).toMatchObject({
      diagnostic: { code: 'OWNERSHIP_CHANGED' },
      type: 'finalization-unknown',
    });
  });

  it('never resends bytes while observing an uncertain UPLOAD_SEND', async () => {
    const sendIntent = intent('UPLOAD_SEND');
    const fixture = adapter(
      {},
      { retrieve: implementationMock(async () => upload('pending')) },
    );

    const result = await fixture.remote.observe(sendIntent);

    expect(result).toMatchObject({ type: 'uncertain' });
    expect(vi.mocked(fixture.uploads).sendCreated.mock.calls).toHaveLength(0);
    expect(vi.mocked(fixture.payloads).getUploadBytes.mock.calls).toHaveLength(
      0,
    );
  });

  it('treats duplicate exact create markers as ambiguous', async () => {
    const createIntent = intent('CREATE_CANDIDATE');
    if (createIntent.kind !== 'CREATE_CANDIDATE')
      throw new Error('bad fixture');
    const container = resource('container', 'container-block');
    const containerBlock = heading(
      container.blockID,
      [container.marker, container.versionMarker],
      { parentID: target.pageID, parentType: 'page_id' },
    );
    const duplicate = heading('candidate-duplicate', [
      createIntent.details.marker,
      createIntent.details.versionMarker,
    ]);
    const fixture = adapter({
      children: {
        append: emptyMock<NotionBlocksClient['blocks']['children']['append']>(),
        list: implementationMock<
          NotionBlocksClient['blocks']['children']['list']
        >(async () => ({
          block: {},
          has_more: false,
          next_cursor: null,
          object: 'list',
          results: [
            { ...duplicate, id: 'candidate-a' },
            { ...duplicate, id: 'candidate-b' },
          ],
          type: 'block',
        })),
      },
      retrieve: implementationMock(async () => containerBlock),
    });

    const result = await fixture.remote.observe(createIntent);

    expect(result).toMatchObject({
      diagnostic: { code: 'AMBIGUOUS_REMOTE_RESULT' },
      type: 'uncertain',
    });
  });
});
