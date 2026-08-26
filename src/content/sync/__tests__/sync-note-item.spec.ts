import {
  APIErrorCode,
  APIResponseError,
  RequestTimeoutError,
  type Client,
} from '@notionhq/client';
import type {
  AppendBlockChildrenResponse,
  BlockObjectResponse,
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
import { syncNoteItem } from '../sync-note-item';

vi.mock('../../data/item-data');

const fakePageID = 'page-a';
const fakeContainerID = 'container-a';
const fakeOldBlockID = 'old-note';
const fakeNoteTitle = 'Synthetic note';
const target = {
  connectionID: 'bot-a',
  databaseID: 'database-a',
  pageID: fakePageID,
  workspaceID: 'workspace-a',
};
const noOp = () => undefined;
const pngHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const objectNotFoundError = apiError(APIErrorCode.ObjectNotFound, 404);

function appendResponse(id: string): AppendBlockChildrenResponse {
  return {
    has_more: false,
    next_cursor: null,
    object: 'list',
    results: [fullBlock(id)],
    type: 'block',
    block: {},
  };
}

function fullBlock(
  id: string,
  parentID = fakeContainerID,
  title?: string,
): Extract<BlockObjectResponse, { type: 'heading_1' }> {
  return {
    archived: false,
    created_by: { id: 'bot-a', object: 'user' },
    created_time: new Date(0).toISOString(),
    has_children: true,
    heading_1: {
      color: 'default',
      is_toggleable: true,
      rich_text: title
        ? [
            {
              annotations: {
                bold: false,
                code: false,
                color: 'default',
                italic: false,
                strikethrough: false,
                underline: false,
              },
              href: null,
              plain_text: title,
              text: { content: title, link: null },
              type: 'text',
            },
          ]
        : [],
    },
    id,
    in_trash: false,
    last_edited_by: { id: 'bot-a', object: 'user' },
    last_edited_time: new Date(0).toISOString(),
    object: 'block',
    parent: { block_id: parentID, type: 'block_id' },
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
}: {
  existing?: SyncedNote;
  noteHTML?: string;
} = {}) {
  vi.clearAllMocks();

  const regularItem = createZoteroItemMock({ libraryID: 1 });
  const noteItem = createZoteroItemMock({ libraryID: 1 });
  noteItem.isTopLevelItem.mockReturnValue(false);
  noteItem.topLevelItem = regularItem;
  noteItem.getNote.mockReturnValue(noteHTML);
  noteItem.getNoteTitle.mockReturnValue(fakeNoteTitle);

  let stored: SyncedNotes = {
    containerBlockID: existing ? fakeContainerID : undefined,
    notes: existing ? { [noteItem.key]: existing } : {},
  };
  vi.mocked(getNotionPageID).mockReturnValue(fakePageID);
  vi.mocked(getSyncedNotes).mockImplementation(() => stored);
  vi.mocked(saveSyncedNoteRecord).mockImplementation(
    async (_item, containerBlockID, noteItemKey, note) => {
      stored = {
        containerBlockID,
        notes: { ...stored.notes, [noteItemKey]: note },
      };
    },
  );

  const notion = mockDeep<Client>();
  const candidateIDs = ['candidate-a', 'candidate-b', 'candidate-c'];
  notion.blocks.children.append.mockImplementation(async (request) => {
    if (request.block_id === fakePageID) {
      return appendResponse(fakeContainerID);
    }
    if (request.block_id === fakeContainerID) {
      return appendResponse(candidateIDs.shift() || 'candidate-extra');
    }
    return appendResponse('content-child');
  });
  notion.blocks.retrieve.mockImplementation(async ({ block_id }) =>
    fullBlock(block_id),
  );
  notion.blocks.update.mockImplementation(async () => fullBlock('candidate-a'));
  notion.blocks.delete.mockImplementation(async () => fullBlock('deleted'));

  return {
    getStored: () => stored,
    noteItem,
    notion,
    regularItem,
  };
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
    const updateOrder = notion.blocks.update.mock.invocationCallOrder[0];
    const saveOrder = vi.mocked(saveSyncedNoteRecord).mock.invocationCallOrder;
    expect(appendOrder).toHaveLength(3);
    expect(updateOrder).toBeGreaterThan(appendOrder[2] || 0);
    expect(saveOrder[0]).toBeGreaterThan(updateOrder || 0);
    expect(getStored().notes?.[noteItem.key]).toMatchObject({
      blockID: 'candidate-a',
      images: [],
      target,
    });
    expect(getStored().notes?.[noteItem.key]?.candidate).toBeUndefined();
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
    expect(saveOrders).toHaveLength(2);
    expect(deleteOrder).toBeGreaterThan(saveOrders[0] || 0);
    expect(saveOrders[1]).toBeGreaterThan(deleteOrder || 0);
    expect(notion.blocks.delete).toHaveBeenCalledWith({
      block_id: fakeOldBlockID,
    });
    expect(getStored().notes?.[noteItem.key]?.blockID).toBe('candidate-a');
  });

  it('does not save or delete the old mapping when candidate creation fails', async () => {
    const { noteItem, notion } = setup({
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
    expect(saveSyncedNoteRecord).not.toHaveBeenCalled();
    expect(notion.blocks.delete).not.toHaveBeenCalled();
  });

  it('removes a newly created empty container when candidate creation fails', async () => {
    const { noteItem, notion } = setup();
    notion.blocks.children.append.mockImplementation(async (request) => {
      if (request.block_id === fakePageID) {
        return appendResponse(fakeContainerID);
      }
      throw new Error('Candidate create failed');
    });

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow('Candidate create failed');
    expect(notion.blocks.delete).toHaveBeenCalledExactlyOnceWith({
      block_id: fakeContainerID,
    });
    expect(saveSyncedNoteRecord).not.toHaveBeenCalled();
  });

  it('recovers an ambiguously created candidate by its unique staging title', async () => {
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    let stagingTitle = '';
    notion.blocks.children.append.mockImplementation(async (request) => {
      if (request.block_id === fakeContainerID) {
        const first = request.children[0];
        if (first && 'heading_1' in first) {
          const richText = first.heading_1.rich_text[0];
          if (richText && 'text' in richText) {
            stagingTitle = richText.text.content;
          }
        }
        throw new RequestTimeoutError();
      }
      return appendResponse('content-child');
    });
    notion.blocks.children.list.mockImplementation(async () => ({
      has_more: false,
      next_cursor: null,
      object: 'list',
      results: [
        fullBlock('candidate-recovered', fakeContainerID, stagingTitle),
      ],
      type: 'block',
      block: {},
    }));

    await syncNoteItem(noteItem, notion, {
      ...target,
      imageSyncEnabled: false,
    });

    expect(stagingTitle).toMatch(/^Notero sync in progress \[[\da-f-]+\]$/);
    expect(notion.blocks.children.list).toHaveBeenCalledExactlyOnceWith({
      block_id: fakeContainerID,
      page_size: 100,
    });
    expect(getStored().notes?.[noteItem.key]?.blockID).toBe(
      'candidate-recovered',
    );
  });

  it('records a newly created container when its cleanup fails', async () => {
    const { getStored, noteItem, notion } = setup();
    notion.blocks.children.append.mockImplementation(async (request) => {
      if (request.block_id === fakePageID) {
        return appendResponse(fakeContainerID);
      }
      throw new Error('Candidate create failed');
    });
    notion.blocks.delete.mockRejectedValue(
      apiError(APIErrorCode.RestrictedResource, 403),
    );

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow('Candidate create failed');
    expect(getStored().notes?.[noteItem.key]).toStrictEqual({
      orphanBlockIDs: [fakeContainerID],
    });
  });

  it('discards the whole candidate without committing after append failure', async () => {
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    notion.blocks.children.append.mockImplementation(async (request) => {
      if (request.block_id === fakeContainerID) {
        return appendResponse('candidate-a');
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
    expect(saveSyncedNoteRecord).not.toHaveBeenCalled();
    expect(getStored().notes?.[noteItem.key]?.blockID).toBe(fakeOldBlockID);
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
        return appendResponse('candidate-a');
      }
      contentBatches += 1;
      if (contentBatches === 2) throw new Error('Later append failed');
      return appendResponse('content-child');
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
  });

  it('never retries an ambiguous content append and discards the candidate', async () => {
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    notion.blocks.children.append.mockImplementation(async (request) => {
      if (request.block_id === fakeContainerID) {
        return appendResponse('candidate-a');
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
  });

  it('rolls back a complete candidate when old-block deletion is denied', async () => {
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    notion.blocks.delete.mockImplementation(async ({ block_id }) => {
      if (block_id === fakeOldBlockID) {
        throw apiError(APIErrorCode.RestrictedResource, 403);
      }
      return fullBlock(block_id);
    });

    await expect(
      syncNoteItem(noteItem, notion, {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow('Synthetic Notion failure');
    expect(notion.blocks.delete).toHaveBeenCalledWith({
      block_id: 'candidate-a',
    });
    expect(getStored().notes?.[noteItem.key]).toStrictEqual({
      blockID: fakeOldBlockID,
      candidate: undefined,
    });
  });

  it('records an orphan when candidate cleanup also fails', async () => {
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
      orphanBlockIDs: ['candidate-a'],
    });
  });

  it('keeps a complete candidate as recovery state when old deletion is uncertain', async () => {
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    notion.blocks.delete.mockRejectedValue(new RequestTimeoutError());
    notion.blocks.retrieve
      .mockResolvedValueOnce(fullBlock(fakeOldBlockID))
      .mockRejectedValue(apiError(APIErrorCode.InternalServerError, 503));

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

  it('recreates an unchanged note when its active block was deleted', async () => {
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

    await syncNoteItem(noteItem, notion, {
      ...target,
      imageSyncEnabled: false,
    });

    expect(notion.blocks.children.append).toHaveBeenCalledWith(
      expect.objectContaining({ block_id: fakeContainerID }),
    );
    expect(getStored().notes?.[noteItem.key]?.blockID).toBe('candidate-a');
    expect(notion.blocks.delete).not.toHaveBeenCalledWith({
      block_id: fakeOldBlockID,
    });
  });

  it('stages the replacement beside an active note that was manually moved', async () => {
    const movedContainerID = 'moved-container';
    const { getStored, noteItem, notion } = setup({
      existing: { blockID: fakeOldBlockID },
    });
    notion.blocks.retrieve.mockImplementation(async ({ block_id }) => {
      if (block_id === fakeOldBlockID) {
        return fullBlock(fakeOldBlockID, movedContainerID);
      }
      return fullBlock(block_id);
    });
    notion.blocks.children.append.mockImplementation(async (request) => {
      if (request.block_id === movedContainerID) {
        return appendResponse('candidate-moved');
      }
      return appendResponse('content-child');
    });

    await syncNoteItem(noteItem, notion, {
      ...target,
      imageSyncEnabled: false,
    });

    expect(notion.blocks.children.append).toHaveBeenCalledWith(
      expect.objectContaining({ block_id: movedContainerID }),
    );
    expect(getStored().containerBlockID).toBe(movedContainerID);
    expect(getStored().notes?.[noteItem.key]?.blockID).toBe('candidate-moved');
  });

  it('does not resolve or upload images when the preference is disabled', async () => {
    const { noteItem, notion } = setup({
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
      path.endsWith('.png')
        ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
        : new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0]),
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
    expect(saveSyncedNoteRecord).not.toHaveBeenCalled();
  });

  it('reuses an unchanged image only within the same Notion target', async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0,
    ]);
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
    await syncNoteItem(noteItem, notion, {
      ...otherWorkspace,
      imageSyncEnabled: true,
      uploadService,
    });
    expect(uploadService.upload).toHaveBeenCalledTimes(1);

    const otherDatabase = {
      ...otherWorkspace,
      databaseID: 'database-b',
    };
    await syncNoteItem(noteItem, notion, {
      ...otherDatabase,
      imageSyncEnabled: true,
      uploadService,
    });
    expect(uploadService.upload).toHaveBeenCalledTimes(2);

    const otherConnection = {
      ...otherDatabase,
      connectionID: 'bot-b',
    };
    await syncNoteItem(noteItem, notion, {
      ...otherConnection,
      imageSyncEnabled: true,
      uploadService,
    });
    expect(uploadService.upload).toHaveBeenCalledTimes(3);

    const otherTarget = { ...otherConnection, pageID: 'page-b' };
    vi.mocked(getNotionPageID).mockReturnValue('page-b');
    await syncNoteItem(noteItem, notion, {
      ...otherTarget,
      imageSyncEnabled: true,
      uploadService,
    });
    expect(uploadService.upload).toHaveBeenCalledTimes(4);
  });

  it('handles image add, delete, replacement, and reorder without duplicate uploads', async () => {
    const bytesByKey = new Map<string, Uint8Array<ArrayBuffer>>([
      ['A', new Uint8Array([...pngHeader, 1])],
      ['B', new Uint8Array([...pngHeader, 2])],
      ['C', new Uint8Array([...pngHeader, 3])],
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
    bytesByKey.set('B', new Uint8Array([...pngHeader, 9]));
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

  it('promotes a complete recovery candidate when the old block is gone', async () => {
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
    const { getStored, noteItem, notion } = setup({
      existing: {
        blockID: fakeOldBlockID,
        candidate,
      },
      noteHTML,
    });
    notion.blocks.retrieve.mockImplementation(async ({ block_id }) => {
      if (block_id === fakeOldBlockID) throw objectNotFoundError;
      return fullBlock(block_id);
    });

    await syncNoteItem(noteItem, notion, {
      ...target,
      imageSyncEnabled: false,
    });

    expect(getStored().notes?.[noteItem.key]).toMatchObject({
      blockID: 'candidate-recovery',
      sourceHash,
      target,
    });
    expect(getStored().notes?.[noteItem.key]?.candidate).toBeUndefined();
    expect(notion.blocks.children.append).not.toHaveBeenCalled();
  });
});
