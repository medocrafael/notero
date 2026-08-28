import {
  APIErrorCode,
  APIResponseError,
  RequestTimeoutError,
  type Client,
  isFullBlock,
} from '@notionhq/client';
import type {
  AppendBlockChildrenParameters,
  AppendBlockChildrenResponse,
  BlockObjectResponse,
  FileUploadObjectResponse,
} from '@notionhq/client/build/src/api-endpoints';
import { describe, expect, it, vi } from 'vite-plus/test';
import { mockDeep } from 'vitest-mock-extended';

import { createZoteroItemMock, zoteroMock } from '../../../../test/utils';
import {
  type SyncedNote,
  type SyncedNotes,
  getNotionPageID,
  getSyncedNotes,
  saveSyncedNoteRecord,
} from '../../data/item-data';
import {
  type ResolvedNoteImage,
  hashBytes,
  hashText,
} from '../note-image-resolver';
import {
  type BlockOwnershipIdentity,
  createManagedBlockReference,
  createOwnershipMarker,
  ownershipMarkerURL,
} from '../notion-block-ownership';
import type { UploadJournalHooks } from '../notion-image-upload-service';
import { syncNoteItem } from '../sync-note-item';

import { validJpegBytes, validPngBytes } from './fixtures/image-fixtures';

vi.mock('../../data/item-data');

const fakePageID = 'page-a';
const fakeContainerID = 'container-a';
const fakeOldBlockID = 'old-note';
const fakeNoteTitle = 'Synthetic note';
const STAGING_NOTE_TITLE_FOR_TEST = 'Notero sync in progress';
const target = {
  connectionID: 'bot-a',
  databaseID: 'database-a',
  pageID: fakePageID,
  workspaceID: 'workspace-a',
};
const noOp = () => undefined;

const objectNotFoundError = apiError(APIErrorCode.ObjectNotFound, 404);

type UploadImage = (
  image: ResolvedNoteImage,
  hooks?: UploadJournalHooks,
) => Promise<string>;
type RetrieveUpload = (
  fileUploadID: string,
) => Promise<FileUploadObjectResponse>;

function fileUploadResponse(
  status: FileUploadObjectResponse['status'],
  id = 'upload-A',
): FileUploadObjectResponse {
  return {
    archived: false,
    content_length: validPngBytes.byteLength,
    content_type: 'image/png',
    created_by: { id: target.connectionID, type: 'bot' },
    created_time: new Date().toISOString(),
    expiry_time:
      status === 'uploaded'
        ? new Date(Date.now() + 55 * 60 * 1000).toISOString()
        : new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    filename: 'notero-synthetic.png',
    id,
    last_edited_time: new Date().toISOString(),
    object: 'file_upload',
    status,
  };
}

function appendResponse(
  id: string,
  request?: AppendBlockChildrenParameters,
): AppendBlockChildrenResponse {
  const first = request?.children[0];
  const heading = first && 'heading_1' in first ? first.heading_1 : undefined;
  const richText = heading?.rich_text || [];
  const contents = richText.flatMap((value) =>
    'text' in value ? [value.text.content] : [],
  );
  const title = contents[0];
  const markers = richText.flatMap((value) => {
    if (!('text' in value) || !value.text.link?.url) return [];
    const encoded = value.text.link.url.split('notero-owner=')[1];
    return encoded ? [decodeURIComponent(encoded)] : [];
  });
  const parentID = request?.block_id || fakeContainerID;
  return {
    has_more: false,
    next_cursor: null,
    object: 'list',
    results: [
      fullBlock(
        id,
        parentID,
        title,
        markers,
        parentID === fakePageID ? 'page_id' : 'block_id',
      ),
    ],
    type: 'block',
    block: {},
  };
}

function fullBlock(
  id: string,
  parentID = fakeContainerID,
  title?: string,
  markers: string[] = [],
  parentType: 'block_id' | 'page_id' = 'block_id',
  inTrash = false,
): Extract<BlockObjectResponse, { type: 'heading_1' }> {
  return {
    archived: false,
    created_by: { id: 'bot-a', object: 'user' },
    created_time: new Date(0).toISOString(),
    has_children: true,
    heading_1: {
      color: 'default',
      is_toggleable: true,
      rich_text: [
        ...(title
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
                href: null,
                plain_text: title,
                text: { content: title, link: null },
                type: 'text' as const,
              },
            ]
          : []),
        ...markers.map((marker) => ({
          annotations: {
            bold: false,
            code: false,
            color: 'default' as const,
            italic: false,
            strikethrough: false,
            underline: false,
          },
          href: ownershipMarkerURL(marker),
          plain_text: '\u2063',
          text: {
            content: '\u2063',
            link: { url: ownershipMarkerURL(marker) },
          },
          type: 'text' as const,
        })),
      ],
    },
    id,
    in_trash: inTrash,
    last_edited_by: { id: 'bot-a', object: 'user' },
    last_edited_time: new Date(0).toISOString(),
    object: 'block',
    parent:
      parentType === 'page_id'
        ? { page_id: parentID, type: 'page_id' }
        : { block_id: parentID, type: 'block_id' },
    type: 'heading_1',
  };
}

function apiError(code: APIErrorCode, status: number) {
  return new APIResponseError({
    code,
    headers: {},
    message: 'Synthetic Notion failure',
    rawBodyText: 'redacted test body',
    status,
  });
}

function setup({
  existing,
  noteHTML = '<div><p>Synthetic text</p></div>',
  unverifiedExisting = false,
}: {
  existing?: SyncedNote;
  noteHTML?: string;
  unverifiedExisting?: boolean;
} = {}) {
  vi.clearAllMocks();

  const regularItem = createZoteroItemMock({ libraryID: 1 });
  const noteItem = createZoteroItemMock({ libraryID: 1 });
  noteItem.isTopLevelItem.mockReturnValue(false);
  noteItem.topLevelItem = regularItem;
  noteItem.getNote.mockReturnValue(noteHTML);
  noteItem.getNoteTitle.mockReturnValue(fakeNoteTitle);

  const containerIdentity = ownershipIdentity(noteItem, 'container');
  const noteIdentity = ownershipIdentity(noteItem, 'note');
  const containerReference = createManagedBlockReference(
    fakeContainerID,
    containerIdentity,
  );
  const managedExisting =
    existing && !unverifiedExisting
      ? {
          ...existing,
          ownership:
            existing.ownership ||
            (existing.blockID
              ? createManagedBlockReference(existing.blockID, noteIdentity)
              : undefined),
          ...(existing.blockID && { ownershipStatus: 'managed' as const }),
        }
      : existing;
  const remoteBlocks = new Map<string, BlockObjectResponse>();
  let stored: SyncedNotes = {
    ...(existing && !unverifiedExisting && { container: containerReference }),
    containerBlockID: existing ? fakeContainerID : undefined,
    notes: managedExisting ? { [noteItem.key]: managedExisting } : {},
  };
  vi.mocked(getNotionPageID).mockReturnValue(fakePageID);
  vi.mocked(getSyncedNotes).mockImplementation(() => stored);
  vi.mocked(saveSyncedNoteRecord).mockImplementation(
    async (_item, containerBlockID, noteItemKey, note, savedContainer) => {
      stored = {
        ...(savedContainer && { container: savedContainer }),
        containerBlockID,
        notes: { ...stored.notes, [noteItemKey]: note },
      };
      if (savedContainer && !remoteBlocks.has(savedContainer.blockID)) {
        remoteBlocks.set(
          savedContainer.blockID,
          fullBlock(
            savedContainer.blockID,
            fakePageID,
            'Zotero Notes',
            [savedContainer.marker],
            'page_id',
          ),
        );
      }
      if (
        note.transaction?.candidate &&
        !remoteBlocks.has(note.transaction.candidate.blockID)
      ) {
        remoteBlocks.set(
          note.transaction.candidate.blockID,
          fullBlock(
            note.transaction.candidate.blockID,
            containerBlockID,
            STAGING_NOTE_TITLE_FOR_TEST,
            [
              createOwnershipMarker(ownershipIdentity(noteItem, 'note')),
              note.transaction.candidate.marker,
            ],
          ),
        );
      }
    },
  );

  const notion = mockDeep<Client>();
  if (existing && !unverifiedExisting) {
    remoteBlocks.set(
      fakeContainerID,
      fullBlock(
        fakeContainerID,
        fakePageID,
        'Zotero Notes',
        [createOwnershipMarker(containerIdentity)],
        'page_id',
      ),
    );
    if (managedExisting?.blockID) {
      remoteBlocks.set(
        managedExisting.blockID,
        fullBlock(managedExisting.blockID, fakeContainerID, fakeNoteTitle, [
          createOwnershipMarker(noteIdentity),
        ]),
      );
    }
  }
  const candidateIDs = ['candidate-a', 'candidate-b', 'candidate-c'];
  notion.blocks.children.append.mockImplementation(async (request) => {
    let response;
    if (request.block_id === fakePageID) {
      response = appendResponse(fakeContainerID, request);
    } else if (request.block_id === fakeContainerID) {
      response = appendResponse(
        candidateIDs.shift() || 'candidate-extra',
        request,
      );
    } else {
      return appendResponse('content-child', request);
    }
    const created = response.results[0];
    if (created && isFullBlock(created)) remoteBlocks.set(created.id, created);
    return response;
  });
  notion.blocks.retrieve.mockImplementation(async ({ block_id }) => {
    const block = remoteBlocks.get(block_id);
    return block || fullBlock(block_id);
  });
  notion.blocks.update.mockImplementation(async (request) => {
    const existingBlock = remoteBlocks.get(request.block_id);
    const heading = 'heading_1' in request ? request.heading_1 : undefined;
    const response = appendResponse(request.block_id, {
      block_id:
        existingBlock && 'block_id' in existingBlock.parent
          ? existingBlock.parent.block_id
          : fakeContainerID,
      children: [
        {
          heading_1: {
            is_toggleable: heading?.is_toggleable ?? true,
            rich_text: heading?.rich_text || [],
          },
          object: 'block',
          type: 'heading_1',
        },
      ],
    });
    const updated = response.results[0];
    if (updated && isFullBlock(updated)) remoteBlocks.set(updated.id, updated);
    return updated || fullBlock(request.block_id);
  });
  notion.blocks.delete.mockImplementation(async ({ block_id }) => {
    const existingBlock = remoteBlocks.get(block_id) || fullBlock(block_id);
    return fullBlock(
      block_id,
      'block_id' in existingBlock.parent
        ? existingBlock.parent.block_id
        : fakeContainerID,
      existingBlock.type === 'heading_1'
        ? existingBlock.heading_1.rich_text[0]?.plain_text
        : undefined,
      existingBlock.type === 'heading_1'
        ? existingBlock.heading_1.rich_text
            .slice(1)
            .map(({ plain_text }) => plain_text.replace(/^\u2063/, ''))
        : [],
      'block_id',
      true,
    );
  });

  return {
    getStored: () => stored,
    noteItem,
    notion,
    regularItem,
    remoteBlocks,
  };
}

function ownershipIdentity(
  noteItem: Zotero.Item,
  kind: BlockOwnershipIdentity['kind'],
  attemptID?: string,
): BlockOwnershipIdentity {
  return {
    ...(attemptID && { attemptID }),
    kind,
    libraryID: noteItem.libraryID,
    ...(kind !== 'container' && { noteItemKey: noteItem.key }),
    parentItemKey: noteItem.topLevelItem.key,
    target,
  };
}

function pngVariant(seed: number): Uint8Array<ArrayBuffer> {
  const bytes = validPngBytes.slice();
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(offset, false);
    const type = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8));
    if (type === 'IDAT' && length) {
      bytes[offset + 8] = (bytes[offset + 8] || 0) ^ seed;
      view.setUint32(
        offset + 8 + length,
        testCrc32(bytes, offset + 4, offset + 8 + length),
        false,
      );
      return bytes;
    }
    offset += length + 12;
  }
  return bytes;
}

function testCrc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index] || 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function installEmbeddedImageFixtures(
  noteItem: Zotero.Item,
  bytesByKey: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
): void {
  const attachments = new Map(
    Array.from(bytesByKey.keys(), (key) => {
      const attachment = createZoteroItemMock({
        attachmentContentType: 'image/png',
        deleted: false,
        libraryID: noteItem.libraryID,
        parentItemID: noteItem.id,
      });
      Object.defineProperty(attachment, 'key', { value: key });
      attachment.isEmbeddedImageAttachment.mockReturnValue(true);
      attachment.getFilePathAsync.mockResolvedValue(`synthetic-${key}.png`);
      return [key, attachment] as const;
    }),
  );
  zoteroMock.Items.getByLibraryAndKey.mockImplementation(
    (_libraryID, key) => attachments.get(key) || false,
  );
  // oxlint-disable-next-line typescript/unbound-method
  vi.mocked(IOUtils.read).mockImplementation(async (path) => {
    const key = /synthetic-(.+)\.png$/.exec(path)?.[1];
    const bytes = key && bytesByKey.get(key);
    if (!bytes) throw new Error('Synthetic image is missing');
    return bytes;
  });
}

describe('syncNoteItem safe replacement', () => {
  it('stops safely when synchronization metadata is corrupt', async () => {
    const { noteItem, notion } = setup();
    vi.mocked(getSyncedNotes).mockReturnValue({ metadataCorrupt: true });

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow('Cannot sync note because Notero metadata is corrupt');
    expect(notion.blocks.children.append).not.toHaveBeenCalled();
    expect(saveSyncedNoteRecord).not.toHaveBeenCalled();
  });

  it('rejects a top-level note and a note whose parent is not synced', async () => {
    const { noteItem, notion } = setup();
    noteItem.isTopLevelItem.mockReturnValue(true);
    await expect(syncNoteItem(noteItem, notion)).rejects.toThrow(
      'Cannot sync note without a parent item',
    );

    noteItem.isTopLevelItem.mockReturnValue(false);
    vi.mocked(getNotionPageID).mockReturnValue(undefined);
    await expect(syncNoteItem(noteItem, notion)).rejects.toThrow(
      'Cannot sync note because its parent item is not synced',
    );
  });

  it('commits a first sync only after content append and title finalization', async () => {
    const { getStored, noteItem, notion } = setup();

    await syncNoteItem(noteItem, notion, {
      ...target,
      imageSyncEnabled: false,
    });

    const appendOrder = notion.blocks.children.append.mock.invocationCallOrder;
    const updateOrders = notion.blocks.update.mock.invocationCallOrder;
    const saveOrder = vi.mocked(saveSyncedNoteRecord).mock.invocationCallOrder;
    expect(appendOrder).toHaveLength(3);
    expect(updateOrders[0]).toBeGreaterThan(appendOrder[2] || 0);
    expect(saveOrder[0]).toBeLessThan(appendOrder[0] || 0);
    expect(saveOrder.at(-1)).toBeGreaterThan(updateOrders.at(-1) || 0);
    expect(getStored().notes?.[noteItem.key]).toMatchObject({
      blockID: 'candidate-a',
      ownership: expect.objectContaining({ kind: 'note' }),
    });
    expect(getStored().notes?.[noteItem.key]?.images).toBeUndefined();
    expect(getStored().notes?.[noteItem.key]?.target).toBeUndefined();
    expect(getStored().notes?.[noteItem.key]?.candidate).toBeUndefined();
    const candidateHeading = notion.blocks.update.mock.calls[0]?.[0];
    const promotedHeading = notion.blocks.update.mock.calls[1]?.[0];
    expect(
      candidateHeading &&
        'heading_1' in candidateHeading &&
        candidateHeading.heading_1.rich_text,
    ).toHaveLength(3);
    expect(
      promotedHeading &&
        'heading_1' in promotedHeading &&
        promotedHeading.heading_1.rich_text,
    ).toHaveLength(2);
  });

  it('keeps the old block until the complete candidate is persisted', async () => {
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
    });

    await syncNoteItem(noteItem, notion, {
      ...target,
      imageSyncEnabled: false,
    });

    const deleteOrder = notion.blocks.delete.mock.invocationCallOrder[0];
    const saveOrders = vi.mocked(saveSyncedNoteRecord).mock.invocationCallOrder;
    const candidateSaveIndex = vi
      .mocked(saveSyncedNoteRecord)
      .mock.calls.findIndex(([, , , note]) => Boolean(note.candidate));
    expect(candidateSaveIndex).toBeGreaterThanOrEqual(0);
    expect(deleteOrder).toBeGreaterThan(saveOrders[candidateSaveIndex] || 0);
    expect(saveOrders.at(-1)).toBeGreaterThan(deleteOrder || 0);
    expect(notion.blocks.delete).toHaveBeenCalledWith({
      block_id: fakeOldBlockID,
    });
    expect(getStored().notes?.[noteItem.key]?.blockID).toBe('candidate-a');
  });

  it('journals but does not delete the old mapping when candidate creation fails', async () => {
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    notion.blocks.children.append.mockRejectedValueOnce(
      new Error('Candidate create failed'),
    );

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow('Candidate create failed');
    expect(getStored().notes?.[noteItem.key]).toMatchObject({
      blockID: fakeOldBlockID,
      transaction: { stage: 'candidate-create-uncertain' },
    });
    expect(notion.blocks.delete).not.toHaveBeenCalled();
  });

  it('retains a managed container recovery record when candidate creation fails', async () => {
    const { getStored, noteItem, notion } = setup();
    notion.blocks.children.append.mockImplementation(async (request) => {
      if (request.block_id === fakePageID) {
        return appendResponse(fakeContainerID, request);
      }
      throw new Error('Candidate create failed');
    });

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow('Candidate create failed');
    expect(notion.blocks.delete).not.toHaveBeenCalled();
    expect(getStored().notes?.[noteItem.key]).toMatchObject({
      transaction: {
        container: { blockID: fakeContainerID, kind: 'container' },
        stage: 'candidate-create-uncertain',
      },
    });
  });

  it('recovers an ambiguously created candidate by its unique staging title', async () => {
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    let stagingTitle = '';
    let stagingMarkers: string[] = [];
    notion.blocks.children.append.mockImplementation(async (request) => {
      if (request.block_id === fakeContainerID) {
        const first = request.children[0];
        if (first && 'heading_1' in first) {
          const richText = first.heading_1.rich_text[0];
          if (richText && 'text' in richText) {
            stagingTitle = richText.text.content;
          }
          stagingMarkers = first.heading_1.rich_text
            .slice(1)
            .flatMap((value) => {
              if (!('text' in value) || !value.text.link?.url) return [];
              const encoded = value.text.link.url.split('notero-owner=')[1];
              return encoded ? [decodeURIComponent(encoded)] : [];
            });
        }
        throw new RequestTimeoutError();
      }
      return appendResponse('content-child', request);
    });
    notion.blocks.children.list.mockImplementation(async () => ({
      has_more: false,
      next_cursor: null,
      object: 'list',
      results: [
        fullBlock(
          'candidate-recovered',
          fakeContainerID,
          stagingTitle,
          stagingMarkers,
        ),
      ],
      type: 'block',
      block: {},
    }));

    await syncNoteItem(noteItem, notion, {
      ...target,
      imageSyncEnabled: false,
    });

    expect(stagingTitle).toBe('Notero sync in progress');
    expect(stagingMarkers).toHaveLength(2);
    expect(notion.blocks.children.list).toHaveBeenCalledExactlyOnceWith({
      block_id: fakeContainerID,
      page_size: 100,
    });
    expect(getStored().notes?.[noteItem.key]?.blockID).toBe(
      'candidate-recovered',
    );
  });

  it('does not delete a newly created canonical container after candidate failure', async () => {
    const { getStored, noteItem, notion } = setup();
    notion.blocks.children.append.mockImplementation(async (request) => {
      if (request.block_id === fakePageID) {
        return appendResponse(fakeContainerID, request);
      }
      throw new Error('Candidate create failed');
    });
    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow('Candidate create failed');
    expect(notion.blocks.delete).not.toHaveBeenCalled();
    expect(getStored().notes?.[noteItem.key]).toMatchObject({
      transaction: {
        container: { blockID: fakeContainerID },
        stage: 'candidate-create-uncertain',
      },
    });
  });

  it('discards the whole candidate without committing after append failure', async () => {
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    notion.blocks.children.append.mockImplementation(async (request) => {
      if (request.block_id === fakeContainerID) {
        return appendResponse('candidate-a', request);
      }
      throw new Error('Append failed');
    });

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow('Append failed');
    expect(notion.blocks.delete).toHaveBeenCalledExactlyOnceWith({
      block_id: 'candidate-a',
    });
    expect(getStored().notes?.[noteItem.key]?.blockID).toBe(fakeOldBlockID);
    expect(getStored().notes?.[noteItem.key]?.transaction).toBeUndefined();
  });

  it('discards a candidate when a later block batch fails', async () => {
    const noteHTML = `<div>${Array.from(
      { length: 101 },
      (_, index) => `<p>Paragraph ${index}</p>`,
    ).join('')}</div>`;
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
      noteHTML,
    });
    let contentBatches = 0;
    notion.blocks.children.append.mockImplementation(async (request) => {
      if (request.block_id === fakeContainerID) {
        return appendResponse('candidate-a', request);
      }
      contentBatches += 1;
      if (contentBatches === 2) throw new Error('Later append failed');
      return appendResponse('content-child', request);
    });

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow('Later append failed');
    expect(contentBatches).toBe(2);
    expect(notion.blocks.delete).toHaveBeenCalledExactlyOnceWith({
      block_id: 'candidate-a',
    });
    expect(getStored().notes?.[noteItem.key]?.blockID).toBe(fakeOldBlockID);
    expect(getStored().notes?.[noteItem.key]?.transaction).toBeUndefined();
  });

  it('never retries an ambiguous content append and discards the candidate', async () => {
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    notion.blocks.children.append.mockImplementation(async (request) => {
      if (request.block_id === fakeContainerID) {
        return appendResponse('candidate-a', request);
      }
      throw new RequestTimeoutError();
    });

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(
      notion.blocks.children.append.mock.calls.filter(
        ([request]) => request.block_id === 'candidate-a',
      ),
    ).toHaveLength(1);
    expect(notion.blocks.delete).toHaveBeenCalledExactlyOnceWith({
      block_id: 'candidate-a',
    });
    expect(getStored().notes?.[noteItem.key]?.blockID).toBe(fakeOldBlockID);
    expect(getStored().notes?.[noteItem.key]?.transaction).toBeUndefined();
  });

  it('retains a complete candidate when old-block deletion is denied', async () => {
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    notion.blocks.delete.mockImplementation(async ({ block_id }) => {
      if (block_id === fakeOldBlockID) {
        throw apiError(APIErrorCode.RestrictedResource, 403);
      }
      return fullBlock(
        block_id,
        fakeContainerID,
        STAGING_NOTE_TITLE_FOR_TEST,
        [],
        'block_id',
        true,
      );
    });

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow('Synthetic Notion failure');
    expect(notion.blocks.delete).not.toHaveBeenCalledWith({
      block_id: 'candidate-a',
    });
    expect(getStored().notes?.[noteItem.key]).toMatchObject({
      blockID: fakeOldBlockID,
      candidate: { blockID: 'candidate-a' },
      transaction: { stage: 'candidate-persisted' },
    });
  });

  it('retains recovery state when all deletion requests are denied', async () => {
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    notion.blocks.delete.mockRejectedValue(
      apiError(APIErrorCode.RestrictedResource, 403),
    );

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow('Synthetic Notion failure');
    expect(getStored().notes?.[noteItem.key]).toMatchObject({
      blockID: fakeOldBlockID,
      candidate: { blockID: 'candidate-a' },
      transaction: { stage: 'candidate-persisted' },
    });
  });

  it('keeps a complete candidate as recovery state when old deletion is uncertain', async () => {
    const { getStored, noteItem, notion, remoteBlocks } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    notion.blocks.delete.mockRejectedValue(new RequestTimeoutError());
    let oldBlockReads = 0;
    notion.blocks.retrieve.mockImplementation(async ({ block_id }) => {
      if (block_id === fakeOldBlockID && ++oldBlockReads > 2) {
        throw apiError(APIErrorCode.InternalServerError, 503);
      }
      return remoteBlocks.get(block_id) || fullBlock(block_id);
    });

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow(
      'Unable to determine whether Notion block deletion completed',
    );
    expect(getStored().notes?.[noteItem.key]).toMatchObject({
      blockID: fakeOldBlockID,
      candidate: {
        blockID: 'candidate-a',
        previousBlockID: fakeOldBlockID,
      },
    });
    expect(notion.blocks.delete).toHaveBeenCalledTimes(1);
  });

  it('skips an unchanged successful note without uploads or mapping writes', async () => {
    const { noteItem, notion } = setup();
    const options = { ...target, imageSyncEnabled: false };

    await syncNoteItem(noteItem, notion, options);
    const appendCalls = notion.blocks.children.append.mock.calls.length;
    const saveCalls = vi.mocked(saveSyncedNoteRecord).mock.calls.length;
    await syncNoteItem(noteItem, notion, options);

    expect(notion.blocks.children.append).toHaveBeenCalledTimes(appendCalls);
    expect(saveSyncedNoteRecord).toHaveBeenCalledTimes(saveCalls);
  });

  it('does not treat an active-block 404 as proof that it was deleted', async () => {
    const noteHTML = '<div><p>Synthetic text</p></div>';
    const sourceHash = await hashText(
      `${fakeNoteTitle}\u0000${noteHTML}\u0000`,
    );
    const { getStored, noteItem, notion } = setup({
      existing: {
        blockID: fakeOldBlockID,
        images: [],
        sourceHash,
        target,
      },
      noteHTML,
    });
    notion.blocks.retrieve.mockRejectedValue(objectNotFoundError);

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow(/404|permission/i);

    expect(notion.blocks.children.append).not.toHaveBeenCalled();
    expect(getStored().notes?.[noteItem.key]?.blockID).toBe(fakeOldBlockID);
  });

  it('revalidates candidate ownership before deleting the active block', async () => {
    const { noteItem, notion, remoteBlocks } = setup({
      existing: { blockID: fakeOldBlockID, sourceHash: 'previous-source' },
      noteHTML: '<div><p>Changed text</p></div>',
    });
    const updateImplementation = notion.blocks.update.getMockImplementation();
    if (!updateImplementation) {
      throw new Error('Synthetic block update implementation is missing');
    }
    let candidateUpdates = 0;
    notion.blocks.update.mockImplementation(async (request) => {
      const result = await updateImplementation(request);
      if (request.block_id === 'candidate-a' && candidateUpdates++ === 0) {
        const candidate = remoteBlocks.get('candidate-a');
        if (!candidate || candidate.type !== 'heading_1') {
          throw new Error('Synthetic candidate block is missing');
        }
        remoteBlocks.set(
          'candidate-a',
          fullBlock(
            'candidate-a',
            'user-toggle',
            candidate.heading_1.rich_text[0]?.plain_text,
            candidate.heading_1.rich_text
              .slice(1)
              .map(({ plain_text }) => plain_text.replace(/^\u2063/, '')),
          ),
        );
      }
      return result;
    });

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow(/ownership|parent/i);

    expect(notion.blocks.delete).not.toHaveBeenCalledWith({
      block_id: fakeOldBlockID,
    });
  });

  it('does not adopt the parent of a manually moved note as canonical', async () => {
    const movedContainerID = 'moved-container';
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    notion.blocks.retrieve.mockImplementation(async ({ block_id }) => {
      if (block_id === fakeOldBlockID) {
        return fullBlock(fakeOldBlockID, movedContainerID);
      }
      return fullBlock(
        block_id,
        fakePageID,
        'Zotero Notes',
        [createOwnershipMarker(ownershipIdentity(noteItem, 'container'))],
        'page_id',
      );
    });

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow(/parent|ownership|managed/i);

    expect(notion.blocks.children.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ block_id: movedContainerID }),
    );
    expect(getStored().containerBlockID).toBe(fakeContainerID);
  });

  it('does not resolve or upload images when the preference is disabled', async () => {
    const { getStored, noteItem, notion } = setup({
      noteHTML:
        '<div><p>Before<img data-attachment-key="IMAGEA">After</p></div>',
    });
    const uploadService = {
      upload: vi.fn<(image: ResolvedNoteImage) => Promise<string>>(),
    };

    await syncNoteItem(noteItem, notion, {
      ...target,
      uploadService,
    });

    /* oxlint-disable typescript/unbound-method */
    expect(zoteroMock.Items.getByLibraryAndKey).not.toHaveBeenCalled();
    expect(IOUtils.read).not.toHaveBeenCalled();
    /* oxlint-enable typescript/unbound-method */
    expect(uploadService.upload).not.toHaveBeenCalled();
    expect(getStored().notes?.[noteItem.key]).not.toHaveProperty('images');
    expect(getStored().notes?.[noteItem.key]).not.toHaveProperty('target');
  });

  it('does not create a candidate when one of multiple uploads fails', async () => {
    const { noteItem, notion } = setup({
      noteHTML:
        '<div><img data-attachment-key="IMAGEA"><img data-attachment-key="IMAGEB"></div>',
    });
    const firstAttachment = createZoteroItemMock({
      attachmentContentType: 'image/png',
      deleted: false,
      libraryID: noteItem.libraryID,
      parentItemID: noteItem.id,
    });
    const secondAttachment = createZoteroItemMock({
      attachmentContentType: 'image/jpeg',
      deleted: false,
      libraryID: noteItem.libraryID,
      parentItemID: noteItem.id,
    });
    Object.defineProperty(firstAttachment, 'key', { value: 'IMAGEA' });
    Object.defineProperty(secondAttachment, 'key', { value: 'IMAGEB' });
    firstAttachment.isEmbeddedImageAttachment.mockReturnValue(true);
    secondAttachment.isEmbeddedImageAttachment.mockReturnValue(true);
    firstAttachment.getFilePathAsync.mockResolvedValue('synthetic-a.png');
    secondAttachment.getFilePathAsync.mockResolvedValue('synthetic-b.jpg');
    zoteroMock.Items.getByLibraryAndKey.mockImplementation((_libraryID, key) =>
      key === 'IMAGEA' ? firstAttachment : secondAttachment,
    );
    // oxlint-disable-next-line typescript/unbound-method
    vi.mocked(IOUtils.read).mockImplementation(async (path) =>
      path.endsWith('.png') ? validPngBytes : validJpegBytes,
    );
    const uploadService = {
      upload: vi
        .fn<(image: ResolvedNoteImage) => Promise<string>>()
        .mockResolvedValueOnce('upload-a')
        .mockRejectedValueOnce(new Error('Second upload failed')),
    };

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: true,
        uploadService,
      }),
    ).rejects.toThrow('Second upload failed');
    expect(uploadService.upload).toHaveBeenCalledTimes(2);
    expect(notion.blocks.children.append).not.toHaveBeenCalled();
    expect(
      getSyncedNotes(noteItem.topLevelItem).notes?.[noteItem.key],
    ).toMatchObject({
      provisionalUploads: expect.any(Array),
      transaction: expect.objectContaining({ stage: 'prepared' }),
    });
  });

  it('reuses an unchanged image only for the verified Notion target', async () => {
    const pngBytes = validPngBytes;
    const contentHash = await hashBytes(pngBytes);
    const { noteItem, notion } = setup({
      existing: {
        blockID: fakeOldBlockID,
        images: [
          {
            attachmentKey: 'IMAGEA',
            contentHash,
            contentType: 'image/png',
            fileUploadID: 'cached-upload',
            filename: 'IMAGEA.png',
            size: pngBytes.byteLength,
          },
        ],
        target,
      },
      noteHTML:
        '<div><p>Changed text<img data-attachment-key="IMAGEA"></p></div>',
    });
    const attachment = createZoteroItemMock({
      attachmentContentType: 'image/png',
      deleted: false,
      libraryID: noteItem.libraryID,
      parentItemID: noteItem.id,
    });
    Object.defineProperty(attachment, 'key', { value: 'IMAGEA' });
    attachment.isEmbeddedImageAttachment.mockReturnValue(true);
    attachment.getFilePathAsync.mockResolvedValue('C:\\synthetic\\image.png');
    zoteroMock.Items.getByLibraryAndKey.mockReturnValue(attachment);
    // oxlint-disable-next-line typescript/unbound-method
    vi.mocked(IOUtils.read).mockResolvedValue(pngBytes);
    const uploadService = {
      upload: vi
        .fn<(image: ResolvedNoteImage) => Promise<string>>()
        .mockResolvedValue('new-upload'),
    };

    await syncNoteItem(noteItem, notion, {
      ...target,
      imageSyncEnabled: true,
      uploadService,
    });
    expect(uploadService.upload).not.toHaveBeenCalled();
    expect(notion.blocks.children.append).toHaveBeenCalledWith(
      expect.objectContaining({
        block_id: 'candidate-a',
        children: expect.arrayContaining([
          {
            image: {
              file_upload: { id: 'cached-upload' },
              type: 'file_upload',
            },
          },
        ]),
      }),
    );

    const otherWorkspace = { ...target, workspaceID: 'workspace-b' };
    await expect(
      syncNoteItem(noteItem, notion, {
        ...otherWorkspace,
        imageSyncEnabled: true,
        uploadService,
      }),
    ).rejects.toThrow(/identity|ownership|managed/i);
    expect(uploadService.upload).not.toHaveBeenCalled();
  });

  it('handles image add, delete, replacement, and reorder without duplicate uploads', async () => {
    const bytesByKey = new Map<string, Uint8Array<ArrayBuffer>>([
      ['A', pngVariant(1)],
      ['B', pngVariant(2)],
      ['C', pngVariant(3)],
    ]);
    const { getStored, noteItem, notion } = setup({
      noteHTML:
        '<div><img data-attachment-key="A"><p>Middle</p><img data-attachment-key="B"></div>',
    });
    installEmbeddedImageFixtures(noteItem, bytesByKey);
    const uploadService = {
      upload: vi.fn<(image: ResolvedNoteImage) => Promise<string>>(
        async (image: ResolvedNoteImage) =>
          `upload-${image.attachmentKey}-${image.contentHash.slice(0, 8)}`,
      ),
    };
    const options = { ...target, imageSyncEnabled: true, uploadService };

    await syncNoteItem(noteItem, notion, options);
    expect(uploadService.upload).toHaveBeenCalledTimes(2);

    noteItem.getNote.mockReturnValue(
      '<div><img data-attachment-key="B"><p>Middle</p><img data-attachment-key="A"></div>',
    );
    await syncNoteItem(noteItem, notion, options);
    expect(uploadService.upload).toHaveBeenCalledTimes(2);
    const reorderAppend = notion.blocks.children.append.mock.calls.find(
      ([request]) => request.block_id === 'candidate-b',
    )?.[0];
    const reorderedIDs = (reorderAppend?.children || []).flatMap((block) =>
      'image' in block && 'file_upload' in block.image
        ? [block.image.file_upload.id]
        : [],
    );
    expect(reorderedIDs).toStrictEqual([
      expect.stringContaining('upload-B-'),
      expect.stringContaining('upload-A-'),
    ]);

    noteItem.getNote.mockReturnValue(
      '<div><p>Middle</p><img data-attachment-key="B"></div>',
    );
    await syncNoteItem(noteItem, notion, options);
    expect(uploadService.upload).toHaveBeenCalledTimes(2);
    expect(
      getStored().notes?.[noteItem.key]?.images?.map(
        ({ attachmentKey }) => attachmentKey,
      ),
    ).toStrictEqual(['B']);

    noteItem.getNote.mockReturnValue(
      '<div><img data-attachment-key="B"><img data-attachment-key="C"></div>',
    );
    await syncNoteItem(noteItem, notion, options);
    expect(uploadService.upload).toHaveBeenCalledTimes(3);
    expect(
      getStored().notes?.[noteItem.key]?.images?.map(
        ({ attachmentKey }) => attachmentKey,
      ),
    ).toStrictEqual(['B', 'C']);

    const previousHash =
      getStored().notes?.[noteItem.key]?.images?.[0]?.contentHash;
    bytesByKey.set('B', pngVariant(9));
    await syncNoteItem(noteItem, notion, options);
    expect(uploadService.upload).toHaveBeenCalledTimes(4);
    expect(
      getStored().notes?.[noteItem.key]?.images?.[0]?.contentHash,
    ).not.toBe(previousHash);
  });

  it('serializes overlapping syncs and converges on the latest source', async () => {
    const { getStored, noteItem, notion } = setup({
      noteHTML: '<div><p>Version one</p></div>',
    });
    let releaseFirst: () => void = noOp;
    let markFirstStarted: () => void = noOp;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    notion.blocks.update
      .mockImplementationOnce(async () => {
        markFirstStarted();
        await firstGate;
        return fullBlock('candidate-a');
      })
      .mockResolvedValue(fullBlock('candidate-b'));

    const first = syncNoteItem(noteItem, notion, {
      ...target,
      imageSyncEnabled: false,
    });
    await firstStarted;
    noteItem.getNote.mockReturnValue('<div><p>Version two</p></div>');
    const second = syncNoteItem(noteItem, notion, {
      ...target,
      imageSyncEnabled: false,
    });
    releaseFirst();
    await Promise.all([first, second]);

    expect(getStored().notes?.[noteItem.key]?.blockID).toBe('candidate-b');
    expect(notion.blocks.delete).toHaveBeenCalledExactlyOnceWith({
      block_id: 'candidate-a',
    });
    expect(getStored().notes?.[noteItem.key]?.candidate).toBeUndefined();
  });

  it('updates one child note without changing another note mapping', async () => {
    const { getStored, noteItem, notion, regularItem } = setup();
    const secondNote = createZoteroItemMock({ libraryID: noteItem.libraryID });
    secondNote.isTopLevelItem.mockReturnValue(false);
    secondNote.topLevelItem = regularItem;
    secondNote.getNote.mockReturnValue('<div><p>Second note</p></div>');
    secondNote.getNoteTitle.mockReturnValue('Second synthetic note');

    await syncNoteItem(noteItem, notion, {
      ...target,
      imageSyncEnabled: false,
    });
    await syncNoteItem(secondNote, notion, {
      ...target,
      imageSyncEnabled: false,
    });
    const secondBlockID = getStored().notes?.[secondNote.key]?.blockID;

    noteItem.getNote.mockReturnValue('<div><p>Updated first note</p></div>');
    await syncNoteItem(noteItem, notion, {
      ...target,
      imageSyncEnabled: false,
    });

    expect(getStored().notes?.[secondNote.key]?.blockID).toBe(secondBlockID);
    expect(notion.blocks.delete).not.toHaveBeenCalledWith({
      block_id: secondBlockID,
    });
  });

  it('does not promote a recovery candidate when the old block returns 404', async () => {
    const noteHTML = '<div><p>Recovered version</p></div>';
    const sourceHash = await hashText(
      `${fakeNoteTitle}\u0000${noteHTML}\u0000`,
    );
    const candidate = {
      blockID: 'candidate-recovery',
      completedAt: new Date(),
      images: [],
      previousBlockID: fakeOldBlockID,
      sourceHash,
      target,
    };
    const { getStored, noteItem, notion, remoteBlocks } = setup({
      existing: {
        blockID: fakeOldBlockID,
        candidate,
      },
      noteHTML,
    });
    notion.blocks.retrieve.mockImplementation(async ({ block_id }) => {
      if (block_id === fakeOldBlockID) throw objectNotFoundError;
      return remoteBlocks.get(block_id) || fullBlock(block_id);
    });

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow(/404|permission/i);

    expect(getStored().notes?.[noteItem.key]).toMatchObject({
      blockID: fakeOldBlockID,
      candidate: { blockID: 'candidate-recovery' },
    });
    expect(notion.blocks.children.append).not.toHaveBeenCalled();
    expect(notion.blocks.delete).not.toHaveBeenCalled();
  });

  it('never uses an unmarked metadata block ID as delete authority', async () => {
    const { noteItem, notion } = setup({
      existing: { blockID: 'user-authored-block' },
      unverifiedExisting: true,
    });
    notion.blocks.retrieve.mockResolvedValue(
      fullBlock('user-authored-block', fakeContainerID, 'User heading'),
    );

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow(/ownership|managed/i);

    expect(notion.blocks.delete).not.toHaveBeenCalledWith({
      block_id: 'user-authored-block',
    });
  });

  it('does not delete candidate or orphan IDs that lack verified remote markers', async () => {
    const candidate = {
      blockID: 'another-note-candidate',
      completedAt: new Date(),
      images: [],
      previousBlockID: fakeOldBlockID,
      sourceHash: 'source-a',
      target,
    };
    const { noteItem, notion } = setup({
      existing: {
        blockID: fakeOldBlockID,
        candidate,
        orphanBlockIDs: ['user-orphan'],
      },
    });

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow(/ownership|managed/i);

    expect(notion.blocks.delete).not.toHaveBeenCalledWith({
      block_id: 'another-note-candidate',
    });
    expect(notion.blocks.delete).not.toHaveBeenCalledWith({
      block_id: 'user-orphan',
    });
  });

  it('rejects a managed-shaped note reference for another note identity', async () => {
    const { getStored, noteItem, notion, regularItem } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    const otherNote = createZoteroItemMock({ libraryID: noteItem.libraryID });
    otherNote.topLevelItem = regularItem;
    const storedNote = getStored().notes?.[noteItem.key];
    if (!storedNote) throw new Error('Synthetic note state is missing');
    storedNote.ownership = createManagedBlockReference(
      fakeOldBlockID,
      ownershipIdentity(otherNote, 'note'),
    );

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow(/identity|ownership|managed/i);
    expect(notion.blocks.children.append).not.toHaveBeenCalled();
    expect(notion.blocks.update).not.toHaveBeenCalled();
    expect(notion.blocks.delete).not.toHaveBeenCalled();
  });

  it('rejects a canonical-container reference for another parent item', async () => {
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    const otherParent = createZoteroItemMock({ libraryID: noteItem.libraryID });
    const otherNote = createZoteroItemMock({ libraryID: noteItem.libraryID });
    otherNote.topLevelItem = otherParent;
    getStored().container = createManagedBlockReference(
      fakeContainerID,
      ownershipIdentity(otherNote, 'container'),
    );

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow(/identity|ownership|managed/i);
    expect(notion.blocks.children.append).not.toHaveBeenCalled();
    expect(notion.blocks.update).not.toHaveBeenCalled();
    expect(notion.blocks.delete).not.toHaveBeenCalled();
  });

  it('rejects a canonical-container reference for another Notion page', async () => {
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    const foreignPageIdentity = {
      ...ownershipIdentity(noteItem, 'container'),
      target: { ...target, pageID: 'page-b' },
    };
    getStored().container = createManagedBlockReference(
      fakeContainerID,
      foreignPageIdentity,
    );

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow(/identity|ownership|managed/i);
    expect(notion.blocks.children.append).not.toHaveBeenCalled();
    expect(notion.blocks.update).not.toHaveBeenCalled();
    expect(notion.blocks.delete).not.toHaveBeenCalled();
  });

  it('rejects a remotely marked block created by another bot identity', async () => {
    const { noteItem, notion, remoteBlocks } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    const remote = remoteBlocks.get(fakeOldBlockID);
    if (!remote) throw new Error('Synthetic remote block is missing');
    remoteBlocks.set(fakeOldBlockID, {
      ...remote,
      created_by: { id: 'bot-b', object: 'user' },
    });

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow(/connection|ownership|managed/i);
    expect(notion.blocks.children.append).not.toHaveBeenCalled();
    expect(notion.blocks.update).not.toHaveBeenCalled();
    expect(notion.blocks.delete).not.toHaveBeenCalled();
  });

  it('rejects committing a changed source when an image block is missing', async () => {
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID, sourceHash: 'previous-source' },
      noteHTML: '<div><p>Changed<img data-attachment-key="A">source</p></div>',
    });
    installEmbeddedImageFixtures(noteItem, new Map([['A', validPngBytes]]));
    const uploadService = {
      upload: vi.fn<UploadImage>(async () => 'upload-a'),
    };

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        blockConverter: () => [],
        imageSyncEnabled: true,
        uploadService,
      }),
    ).rejects.toThrow(/pipeline is incomplete|rendered=0/i);

    expect(getStored().notes?.[noteItem.key]?.blockID).toBe(fakeOldBlockID);
    expect(notion.blocks.children.append).not.toHaveBeenCalled();
    expect(notion.blocks.delete).not.toHaveBeenCalled();
  });

  it.each([
    'candidate-created',
    'content-partial',
    'content-complete',
    'title-finalized',
  ])(
    'removes a verified incomplete %s candidate after restart',
    async (stage) => {
      const noteHTML = '<div><p>Synthetic text</p></div>';
      const sourceHash = await hashText(
        `${fakeNoteTitle}\u0000${noteHTML}\u0000`,
      );
      const { getStored, noteItem, notion, remoteBlocks } = setup({
        existing: { blockID: fakeOldBlockID, sourceHash },
        noteHTML,
      });
      const attemptID = 'attempt-restart';
      const candidateReference = createManagedBlockReference(
        'candidate-restart',
        ownershipIdentity(noteItem, 'candidate', attemptID),
      );
      const storedNote = getStored().notes?.[noteItem.key];
      const container = getStored().container;
      if (!storedNote?.ownership || !container) {
        throw new Error('Synthetic managed state is missing');
      }
      storedNote.transaction = {
        attemptID,
        candidate: candidateReference,
        container,
        expectedImageCount: 0,
        preparedImageCount: 0,
        previous: storedNote.ownership,
        renderedImageCount: 0,
        resolvedImageCount: 0,
        sourceHash,
        stage,
        startedAt: new Date(),
        target,
      };
      remoteBlocks.set(
        candidateReference.blockID,
        fullBlock(
          candidateReference.blockID,
          fakeContainerID,
          STAGING_NOTE_TITLE_FOR_TEST,
          [
            createOwnershipMarker(ownershipIdentity(noteItem, 'note')),
            candidateReference.marker,
          ],
        ),
      );

      await expect(
        syncNoteItem(noteItem, notion, {
          ...target,
          imageSyncEnabled: false,
        }),
      ).rejects.toThrow(/incomplete candidate.*retry/i);

      expect(notion.blocks.delete).toHaveBeenCalledExactlyOnceWith({
        block_id: candidateReference.blockID,
      });
      expect(notion.blocks.children.append).not.toHaveBeenCalled();
      expect(getStored().notes?.[noteItem.key]?.blockID).toBe(fakeOldBlockID);
      expect(getStored().notes?.[noteItem.key]?.transaction).toBeUndefined();
    },
  );

  it('reconciles and removes a candidate whose create response was lost', async () => {
    const noteHTML = '<div><p>Synthetic text</p></div>';
    const sourceHash = await hashText(
      `${fakeNoteTitle}\u0000${noteHTML}\u0000`,
    );
    const { getStored, noteItem, notion, remoteBlocks } = setup({
      existing: { blockID: fakeOldBlockID, sourceHash },
      noteHTML,
    });
    const attemptID = 'attempt-create-lost';
    const candidateReference = createManagedBlockReference(
      'candidate-create-lost',
      ownershipIdentity(noteItem, 'candidate', attemptID),
    );
    const storedNote = getStored().notes?.[noteItem.key];
    const container = getStored().container;
    if (!storedNote?.ownership || !container) {
      throw new Error('Synthetic managed state is missing');
    }
    storedNote.transaction = {
      attemptID,
      container,
      expectedImageCount: 0,
      preparedImageCount: 0,
      previous: storedNote.ownership,
      renderedImageCount: 0,
      resolvedImageCount: 0,
      sourceHash,
      stage: 'candidate-create-uncertain',
      startedAt: new Date(),
      target,
    };
    const remoteCandidate = fullBlock(
      candidateReference.blockID,
      fakeContainerID,
      STAGING_NOTE_TITLE_FOR_TEST,
      [
        createOwnershipMarker(ownershipIdentity(noteItem, 'note')),
        candidateReference.marker,
      ],
    );
    remoteBlocks.set(candidateReference.blockID, remoteCandidate);
    notion.blocks.children.list.mockResolvedValue({
      block: {},
      has_more: false,
      next_cursor: null,
      object: 'list',
      results: [remoteCandidate],
      type: 'block',
    });

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow(/ambiguously created candidate.*retry/i);
    expect(notion.blocks.children.append).not.toHaveBeenCalled();
    expect(notion.blocks.delete).toHaveBeenCalledExactlyOnceWith({
      block_id: candidateReference.blockID,
    });
  });

  it.each(['candidate-persisted', 'old-delete-confirmed'])(
    'promotes a complete verified candidate after restarting at %s',
    async (stage) => {
      const noteHTML = '<div><p>Synthetic text</p></div>';
      const sourceHash = await hashText(
        `${fakeNoteTitle}\u0000${noteHTML}\u0000`,
      );
      const { getStored, noteItem, notion, remoteBlocks } = setup({
        existing: { blockID: fakeOldBlockID, sourceHash },
        noteHTML,
      });
      const attemptID = `attempt-${stage}`;
      const candidateReference = createManagedBlockReference(
        'candidate-complete',
        ownershipIdentity(noteItem, 'candidate', attemptID),
      );
      const storedNote = getStored().notes?.[noteItem.key];
      const container = getStored().container;
      if (!storedNote?.ownership || !container) {
        throw new Error('Synthetic managed state is missing');
      }
      const candidate = {
        attemptID,
        blockID: candidateReference.blockID,
        completedAt: new Date(),
        images: [],
        ownership: candidateReference,
        ownershipStatus: 'managed' as const,
        previousBlockID: fakeOldBlockID,
        sourceHash,
        target,
      };
      storedNote.candidate = candidate;
      storedNote.transaction = {
        attemptID,
        candidate: candidateReference,
        container,
        expectedImageCount: 0,
        preparedImageCount: 0,
        previous: storedNote.ownership,
        renderedImageCount: 0,
        resolvedImageCount: 0,
        sourceHash,
        stage,
        startedAt: new Date(),
        target,
      };
      remoteBlocks.set(
        candidateReference.blockID,
        fullBlock(candidateReference.blockID, fakeContainerID, fakeNoteTitle, [
          createOwnershipMarker(ownershipIdentity(noteItem, 'note')),
          candidateReference.marker,
        ]),
      );
      if (stage === 'old-delete-confirmed') {
        remoteBlocks.delete(fakeOldBlockID);
      }

      await syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      });

      expect(getStored().notes?.[noteItem.key]).toMatchObject({
        blockID: candidateReference.blockID,
        ownership: { kind: 'note' },
        sourceHash,
      });
      expect(getStored().notes?.[noteItem.key]?.candidate).toBeUndefined();
      expect(getStored().notes?.[noteItem.key]?.transaction).toBeUndefined();
      expect(notion.blocks.children.append).not.toHaveBeenCalled();
      expect(
        notion.blocks.delete.mock.calls.map(([request]) => request),
      ).toEqual(
        stage === 'candidate-persisted' ? [{ block_id: fakeOldBlockID }] : [],
      );
    },
  );

  it('reconciles a container whose create response was lost without duplicating it', async () => {
    const noteHTML = '<div><p>Synthetic text</p></div>';
    const sourceHash = await hashText(
      `${fakeNoteTitle}\u0000${noteHTML}\u0000`,
    );
    const { getStored, noteItem, notion, remoteBlocks } = setup({ noteHTML });
    const attemptID = 'attempt-container-lost';
    getStored().notes = {
      [noteItem.key]: {
        transaction: {
          attemptID,
          expectedImageCount: 0,
          preparedImageCount: 0,
          renderedImageCount: 0,
          resolvedImageCount: 0,
          sourceHash,
          stage: 'container-create-uncertain',
          startedAt: new Date(),
          target,
        },
      },
    };
    const containerReference = createManagedBlockReference(
      fakeContainerID,
      ownershipIdentity(noteItem, 'container'),
    );
    const remoteContainer = fullBlock(
      fakeContainerID,
      fakePageID,
      'Zotero Notes',
      [containerReference.marker],
      'page_id',
    );
    remoteBlocks.set(fakeContainerID, remoteContainer);
    notion.blocks.children.list.mockResolvedValue({
      block: {},
      has_more: false,
      next_cursor: null,
      object: 'list',
      results: [remoteContainer],
      type: 'block',
    });

    await syncNoteItem(noteItem, notion, {
      ...target,
      imageSyncEnabled: false,
    });

    expect(
      notion.blocks.children.append.mock.calls.filter(
        ([request]) => request.block_id === fakePageID,
      ),
    ).toHaveLength(0);
    expect(getStored().container).toMatchObject({
      blockID: fakeContainerID,
      kind: 'container',
    });
    expect(getStored().notes?.[noteItem.key]?.blockID).toBe('candidate-a');
  });

  it('resumes verified orphan cleanup without touching the active note', async () => {
    const noteHTML = '<div><p>Synthetic text</p></div>';
    const sourceHash = await hashText(
      `${fakeNoteTitle}\u0000${noteHTML}\u0000`,
    );
    const { getStored, noteItem, notion, remoteBlocks } = setup({
      existing: { blockID: fakeOldBlockID, sourceHash },
      noteHTML,
    });
    const attemptID = 'attempt-orphan';
    const orphan = createManagedBlockReference(
      'candidate-orphan',
      ownershipIdentity(noteItem, 'candidate', attemptID),
    );
    const storedNote = getStored().notes?.[noteItem.key];
    const container = getStored().container;
    if (!storedNote?.ownership || !container) {
      throw new Error('Synthetic managed state is missing');
    }
    storedNote.orphanBlocks = [orphan];
    storedNote.transaction = {
      attemptID,
      container,
      expectedImageCount: 0,
      preparedImageCount: 0,
      previous: storedNote.ownership,
      renderedImageCount: 0,
      resolvedImageCount: 0,
      sourceHash,
      stage: 'orphan-cleanup',
      startedAt: new Date(),
      target,
    };
    remoteBlocks.set(
      orphan.blockID,
      fullBlock(orphan.blockID, fakeContainerID, STAGING_NOTE_TITLE_FOR_TEST, [
        createOwnershipMarker(ownershipIdentity(noteItem, 'note')),
        orphan.marker,
      ]),
    );

    await syncNoteItem(noteItem, notion, {
      ...target,
      imageSyncEnabled: false,
    });

    expect(notion.blocks.delete).toHaveBeenCalledExactlyOnceWith({
      block_id: orphan.blockID,
    });
    expect(notion.blocks.delete).not.toHaveBeenCalledWith({
      block_id: fakeOldBlockID,
    });
    expect(notion.blocks.children.append).not.toHaveBeenCalled();
    expect(getStored().notes?.[noteItem.key]?.orphanBlocks).toBeUndefined();
    expect(getStored().notes?.[noteItem.key]?.transaction).toBeUndefined();
  });

  it('persists an attempt journal before the first remote write', async () => {
    const { noteItem, notion } = setup();
    notion.blocks.children.append.mockImplementation(async (request) => {
      expect(saveSyncedNoteRecord).toHaveBeenCalled();
      return appendResponse(
        request.block_id === fakePageID ? fakeContainerID : 'candidate-a',
        request,
      );
    });

    await syncNoteItem(noteItem, notion, {
      ...target,
      imageSyncEnabled: false,
    });

    expect(vi.mocked(saveSyncedNoteRecord).mock.calls[0]?.[3]).toMatchObject({
      transaction: {
        attemptID: expect.any(String),
        stage: 'prepared',
      },
    });
  });

  it.each([
    'container-create-uncertain',
    'candidate-created',
    'content-partial',
    'content-complete',
    'title-finalized',
    'candidate-persisted',
    'old-delete-confirmed',
    'orphan-cleanup',
  ])(
    'isolates an unverifiable %s restart journal without new writes',
    async (stage) => {
      const { noteItem, notion } = setup({
        existing: { blockID: fakeOldBlockID },
      });
      vi.mocked(getSyncedNotes).mockReturnValue({
        containerBlockID: fakeContainerID,
        notes: {
          [noteItem.key]: {
            blockID: fakeOldBlockID,
            transaction: {
              attemptID: 'attempt-restart',
              sourceHash: 'source-a',
              stage,
              startedAt: new Date(),
              target,
            },
          },
        },
      });

      await expect(
        syncNoteItem(noteItem, notion, {
          ...target,
          imageSyncEnabled: false,
        }),
      ).rejects.toThrow(/recover|ownership|transaction/i);

      expect(notion.blocks.children.append).not.toHaveBeenCalled();
      expect(notion.blocks.delete).not.toHaveBeenCalled();
    },
  );

  it('keeps deletion uncertain when a lost delete response is followed by 404', async () => {
    const { getStored, noteItem, notion, remoteBlocks } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    notion.blocks.delete.mockRejectedValue(new RequestTimeoutError());
    let oldBlockReads = 0;
    notion.blocks.retrieve.mockImplementation(async ({ block_id }) => {
      if (block_id === fakeOldBlockID && ++oldBlockReads > 2) {
        throw objectNotFoundError;
      }
      return remoteBlocks.get(block_id) || fullBlock(block_id);
    });

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow(/uncertain|determine/i);

    expect(getStored().notes?.[noteItem.key]).toMatchObject({
      blockID: fakeOldBlockID,
      candidate: { blockID: 'candidate-a' },
    });
  });

  it('requires a successful delete response to report in_trash true', async () => {
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    notion.blocks.delete.mockResolvedValue(fullBlock(fakeOldBlockID));

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow(/deletion|trash|uncertain/i);

    expect(getStored().notes?.[noteItem.key]?.blockID).toBe(fakeOldBlockID);
  });

  it('reuses a provisional upload after a later image fails', async () => {
    const bytesByKey = new Map<string, Uint8Array<ArrayBuffer>>([
      ['A', validPngBytes],
      ['B', validPngBytes],
    ]);
    const { getStored, noteItem, notion } = setup({
      noteHTML:
        '<div><img data-attachment-key="A"><img data-attachment-key="B"></div>',
    });
    installEmbeddedImageFixtures(noteItem, bytesByKey);
    let bAttempts = 0;
    const uploadService = {
      upload: vi.fn<UploadImage>(async (image) => {
        if (image.attachmentKey === 'B' && bAttempts++ === 0) {
          throw new Error('Synthetic second upload failure');
        }
        return `upload-${image.attachmentKey}`;
      }),
    };
    const options = { ...target, imageSyncEnabled: true, uploadService };

    await expect(syncNoteItem(noteItem, notion, options)).rejects.toThrow(
      'Synthetic second upload failure',
    );
    const provisionalA = getStored().notes?.[
      noteItem.key
    ]?.provisionalUploads?.find(({ attachmentKey }) => attachmentKey === 'A');
    expect(provisionalA).toMatchObject({
      attachmentKey: 'A',
      attemptID: expect.any(String),
      contentHash: expect.any(String),
      contentLength: validPngBytes.byteLength,
      contentType: 'image/png',
      fileUploadID: 'upload-A',
      filename: expect.stringMatching(/^notero-[\da-f]+\.png$/),
      libraryID: noteItem.libraryID,
      noteItemKey: noteItem.key,
      parentItemKey: noteItem.topLevelItem.key,
      status: 'uploaded',
      target,
    });
    await syncNoteItem(noteItem, notion, options);

    expect(
      uploadService.upload.mock.calls.filter(
        ([image]) => image.attachmentKey === 'A',
      ),
    ).toHaveLength(1);
    expect(
      getStored().notes?.[noteItem.key]?.provisionalUploads,
    ).toBeUndefined();
  });

  it('reconciles a known provisional upload after a process exits during send', async () => {
    const { getStored, noteItem, notion } = setup({
      noteHTML: '<div><img data-attachment-key="A"></div>',
    });
    installEmbeddedImageFixtures(noteItem, new Map([['A', validPngBytes]]));
    const uploadService = {
      retrieve: vi.fn<RetrieveUpload>(async () =>
        fileUploadResponse('uploaded'),
      ),
      upload: vi.fn<UploadImage>(async (_image, hooks) => {
        await hooks?.onCreated?.(fileUploadResponse('pending'));
        throw new RequestTimeoutError();
      }),
    };
    const options = { ...target, imageSyncEnabled: true, uploadService };

    await expect(syncNoteItem(noteItem, notion, options)).rejects.toThrow(
      /timed out/i,
    );
    expect(
      getStored().notes?.[noteItem.key]?.provisionalUploads?.[0],
    ).toMatchObject({
      fileUploadID: 'upload-A',
      status: 'create-uncertain',
    });

    await syncNoteItem(noteItem, notion, options);

    expect(uploadService.retrieve).toHaveBeenCalledExactlyOnceWith('upload-A');
    expect(uploadService.upload).toHaveBeenCalledTimes(1);
    expect(getStored().notes?.[noteItem.key]?.images).toEqual([
      expect.objectContaining({ fileUploadID: 'upload-A' }),
    ]);
  });

  it('does not repeat an unprovable upload create before its quarantine expires', async () => {
    const { getStored, noteItem, notion } = setup({
      noteHTML: '<div><img data-attachment-key="A"></div>',
    });
    installEmbeddedImageFixtures(noteItem, new Map([['A', validPngBytes]]));
    const uploadService = {
      upload: vi.fn<UploadImage>(async () => {
        throw new RequestTimeoutError();
      }),
    };
    const options = { ...target, imageSyncEnabled: true, uploadService };

    await expect(syncNoteItem(noteItem, notion, options)).rejects.toThrow(
      /timed out/i,
    );
    const provisional =
      getStored().notes?.[noteItem.key]?.provisionalUploads?.[0];
    expect(provisional).toMatchObject({
      isolationDeadline: expect.any(Date),
      requestStartedAt: expect.any(Date),
      status: 'create-uncertain',
    });
    expect(provisional).not.toHaveProperty('fileUploadID');

    await expect(syncNoteItem(noteItem, notion, options)).rejects.toThrow(
      /upload creation.*uncertain/i,
    );
    expect(uploadService.upload).toHaveBeenCalledTimes(1);
  });

  it.each(['expired', 'failed'] as const)(
    'does not reuse a %s provisional upload',
    async (status) => {
      const contentHash = await hashBytes(validPngBytes);
      const { getStored, noteItem, notion } = setup({
        existing: { blockID: fakeOldBlockID, sourceHash: 'previous-source' },
        noteHTML: '<div><img data-attachment-key="A"></div>',
      });
      installEmbeddedImageFixtures(noteItem, new Map([['A', validPngBytes]]));
      const storedNote = getStored().notes?.[noteItem.key];
      if (!storedNote) throw new Error('Synthetic note state is missing');
      storedNote.provisionalUploads = [
        {
          attachmentKey: 'A',
          attemptID: 'old-attempt',
          contentHash,
          contentLength: validPngBytes.byteLength,
          contentType: 'image/png',
          expiryTime:
            status === 'expired'
              ? new Date(Date.now() - 1000)
              : new Date(Date.now() + 60_000),
          fileUploadID: 'stale-upload',
          filename: 'notero-stale.png',
          libraryID: noteItem.libraryID,
          noteItemKey: noteItem.key,
          parentItemKey: noteItem.topLevelItem.key,
          status,
          target,
        },
      ];
      const uploadService = {
        upload: vi.fn<UploadImage>(async () => 'fresh-upload'),
      };

      await syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: true,
        uploadService,
      });

      expect(uploadService.upload).toHaveBeenCalledTimes(1);
      expect(getStored().notes?.[noteItem.key]?.images).toEqual([
        expect.objectContaining({ fileUploadID: 'fresh-upload' }),
      ]);
    },
  );

  it('keeps the canonical container when one note was moved under a user block', async () => {
    const movedParentID = 'user-toggle';
    const { getStored, noteItem, notion, regularItem, remoteBlocks } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    notion.blocks.retrieve.mockImplementation(async ({ block_id }) => {
      if (block_id === fakeOldBlockID) {
        return fullBlock(fakeOldBlockID, movedParentID, fakeNoteTitle, [
          createOwnershipMarker(ownershipIdentity(noteItem, 'note')),
        ]);
      }
      return remoteBlocks.get(block_id) || fullBlock(block_id);
    });

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow(/moved|ownership|managed/i);

    const secondNote = createZoteroItemMock({ libraryID: noteItem.libraryID });
    secondNote.isTopLevelItem.mockReturnValue(false);
    secondNote.topLevelItem = regularItem;
    secondNote.getNote.mockReturnValue('<div><p>Second note</p></div>');
    secondNote.getNoteTitle.mockReturnValue('Second note');
    await syncNoteItem(secondNote, notion, {
      ...target,
      imageSyncEnabled: false,
    });

    expect(getStored().containerBlockID).toBe(fakeContainerID);
    expect(notion.blocks.children.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ block_id: movedParentID }),
    );
  });

  it('rejects notes above the configured image-count limit before upload', async () => {
    const bytesByKey = new Map<string, Uint8Array<ArrayBuffer>>([
      ['A', validPngBytes],
      ['B', validPngBytes],
      ['C', validPngBytes],
    ]);
    const { noteItem, notion } = setup({
      noteHTML:
        '<div><img data-attachment-key="A"><img data-attachment-key="B"><img data-attachment-key="C"></div>',
    });
    installEmbeddedImageFixtures(noteItem, bytesByKey);
    const uploadService = {
      upload: vi.fn<UploadImage>(async () => 'upload-a'),
    };
    const options = {
      ...target,
      imageSyncEnabled: true,
      maxNoteImageCount: 2,
      uploadService,
    } as Parameters<typeof syncNoteItem>[2] & { maxNoteImageCount: number };

    await expect(syncNoteItem(noteItem, notion, options)).rejects.toThrow(
      /too many embedded images|image count/i,
    );
    expect(uploadService.upload).not.toHaveBeenCalled();
  });

  it('rejects notes above the configured aggregate image-byte limit', async () => {
    const bytesByKey = new Map<string, Uint8Array<ArrayBuffer>>([
      ['A', validPngBytes],
      ['B', validPngBytes],
    ]);
    const { noteItem, notion } = setup({
      noteHTML:
        '<div><img data-attachment-key="A"><img data-attachment-key="B"></div>',
    });
    installEmbeddedImageFixtures(noteItem, bytesByKey);
    const uploadService = {
      upload: vi.fn<UploadImage>(async () => 'upload-a'),
    };
    const options = {
      ...target,
      imageSyncEnabled: true,
      maxNoteImageTotalSize: validPngBytes.byteLength,
      uploadService,
    } as Parameters<typeof syncNoteItem>[2] & {
      maxNoteImageTotalSize: number;
    };

    await expect(syncNoteItem(noteItem, notion, options)).rejects.toThrow(
      /total embedded image size|aggregate/i,
    );
    expect(uploadService.upload).not.toHaveBeenCalled();
  });

  it('re-reads and uploads image bytes through a serial bounded pipeline', async () => {
    const bytesByKey = new Map<string, Uint8Array<ArrayBuffer>>([
      ['A', pngVariant(1)],
      ['B', pngVariant(2)],
      ['C', pngVariant(3)],
    ]);
    const { noteItem, notion } = setup({
      noteHTML:
        '<div><img data-attachment-key="A"><img data-attachment-key="B"><img data-attachment-key="C"></div>',
    });
    installEmbeddedImageFixtures(noteItem, bytesByKey);
    let activeUploads = 0;
    let maxActiveUploads = 0;
    const order: string[] = [];
    const uploadService = {
      upload: vi.fn<UploadImage>(async (image) => {
        activeUploads += 1;
        maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
        order.push(`start-${image.attachmentKey}`);
        await Promise.resolve();
        order.push(`end-${image.attachmentKey}`);
        activeUploads -= 1;
        return `upload-${image.attachmentKey}`;
      }),
    };

    await syncNoteItem(noteItem, notion, {
      ...target,
      imageSyncEnabled: true,
      uploadService,
    });

    expect(maxActiveUploads).toBe(1);
    expect(order).toStrictEqual([
      'start-A',
      'end-A',
      'start-B',
      'end-B',
      'start-C',
      'end-C',
    ]);
    /* oxlint-disable typescript/unbound-method */
    expect(IOUtils.read).toHaveBeenCalledTimes(6);
    /* oxlint-enable typescript/unbound-method */
  });
});
