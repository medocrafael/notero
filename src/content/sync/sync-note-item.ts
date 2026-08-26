import {
  APIResponseError,
  RequestTimeoutError,
  type Client,
  isFullBlock,
} from '@notionhq/client';
import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints';

import {
  type SyncedNote,
  type SyncedNoteCandidate,
  type SyncedNoteImage,
  getNotionPageID,
  getSyncedNotes,
  saveSyncedNoteRecord,
} from '../data/item-data';
import { LocalizableError } from '../errors';
import { NoteroPref, getNoteroPref } from '../prefs/notero-pref';

import {
  type PreparedNotionImage,
  convertHtmlToBlocks,
  findEmbeddedImages,
} from './html-to-notion';
import {
  MAX_DIRECT_UPLOAD_SIZE,
  type ResolvedNoteImage,
  hashText,
  resolveNoteImage,
} from './note-image-resolver';
import { withNoteSyncLock } from './note-sync-lock';
import {
  type NotionTarget,
  NotionImageUploadService,
  isSameNotionTarget,
} from './notion-image-upload-service';
import { LIMITS } from './notion-limits';
import type { ChildBlock } from './notion-types';
import { isArchivedOrNotFoundError } from './notion-utils';

const STAGING_NOTE_TITLE = 'Notero sync in progress';
const BLOCK_STATUS_ATTEMPTS = 3;
const MAX_CHILD_LIST_PAGES = 20;

type ImageUploader = Pick<NotionImageUploadService, 'upload'>;

export type NoteSyncOptions = {
  connectionID?: string;
  databaseID?: string;
  imageSyncEnabled?: boolean;
  maxFileUploadSize?: number;
  uploadService?: ImageUploader;
  workspaceID?: string;
};

class BlockDeleteUncertainError extends Error {
  public readonly name = 'BlockDeleteUncertainError';
}

/**
 * Synchronize one child note using a complete-candidate transaction. Work for
 * the same parent is serialized because all child-note mappings share one
 * Zotero link attachment; the nested note key keeps the lock identity explicit.
 */
export async function syncNoteItem(
  noteItem: Zotero.Item,
  notion: Client,
  options: NoteSyncOptions = {},
): Promise<void> {
  if (noteItem.isTopLevelItem()) {
    throw new LocalizableError(
      'Cannot sync note without a parent item',
      'notero-error-note-without-parent',
    );
  }

  const regularItem = noteItem.topLevelItem;
  await withNoteSyncLock(noteItem.libraryID, `parent:${regularItem.key}`, () =>
    withNoteSyncLock(noteItem.libraryID, `note:${noteItem.key}`, () =>
      syncNoteItemLocked(noteItem, notion, options),
    ),
  );
}

async function syncNoteItemLocked(
  noteItem: Zotero.Item,
  notion: Client,
  options: NoteSyncOptions,
): Promise<void> {
  const regularItem = noteItem.topLevelItem;
  const pageID = getNotionPageID(regularItem);

  if (!pageID) {
    throw new LocalizableError(
      'Cannot sync note because its parent item is not synced',
      'notero-error-note-parent-not-synced',
    );
  }

  const target: NotionTarget = {
    connectionID: options.connectionID || 'legacy-connection',
    databaseID: options.databaseID || 'legacy-database',
    pageID,
    workspaceID: options.workspaceID || 'legacy-workspace',
  };

  let syncedNotes = getSyncedNotes(regularItem);
  if (syncedNotes.metadataCorrupt) {
    throw new LocalizableError(
      'Cannot sync note because Notero metadata is corrupt',
      'notero-error-note-metadata-corrupt',
    );
  }
  let current = syncedNotes.notes?.[noteItem.key];
  if (current) {
    current = await recoverNoteState(
      notion,
      regularItem,
      syncedNotes.containerBlockID,
      noteItem.key,
      current,
    );
    syncedNotes = getSyncedNotes(regularItem);
    if (current.orphanBlockIDs?.length) {
      throw new LocalizableError(
        'Cannot sync note until a previous candidate block is cleaned up',
        'notero-error-note-sync-failed',
      );
    }
  }

  const noteHTML = noteItem.getNote();
  const noteTitle = noteItem.getNoteTitle();
  const imageSyncEnabled =
    options.imageSyncEnabled ??
    Boolean(getNoteroPref(NoteroPref.syncNoteImages));
  const maxFileUploadSize = Math.min(
    options.maxFileUploadSize ?? MAX_DIRECT_UPLOAD_SIZE,
    MAX_DIRECT_UPLOAD_SIZE,
  );

  const resolvedImages = imageSyncEnabled
    ? await resolveEmbeddedImages(noteItem, noteHTML, maxFileUploadSize)
    : [];
  const sourceHash = await buildSourceHash(noteTitle, noteHTML, resolvedImages);

  if (
    current?.blockID &&
    current.sourceHash === sourceHash &&
    isSameNotionTarget(current.target, target) &&
    !current.candidate &&
    !current.orphanBlockIDs?.length
  ) {
    if (await blockExistsWithRetry(notion, current.blockID)) return;
    current = { ...current, blockID: undefined };
  }

  const uploadService =
    options.uploadService || new NotionImageUploadService(notion);
  const prepared = await prepareImages(
    resolvedImages,
    current,
    target,
    uploadService,
  );
  const blocks = buildNoteBlocks(noteHTML, prepared.imageMap);

  let containerBlockID = syncedNotes.containerBlockID;
  const previousBlockID = current?.blockID;
  if (previousBlockID && containerBlockID) {
    containerBlockID = await getEffectiveContainerBlockID(
      notion,
      previousBlockID,
      containerBlockID,
    );
  }
  let createdContainerBlockID: string | undefined;
  if (!containerBlockID) {
    containerBlockID = await createContainerBlock(notion, pageID);
    createdContainerBlockID = containerBlockID;
  }

  let candidateBlockID: string | undefined;
  let candidatePersisted = false;
  let oldRemovalComplete = !previousBlockID;

  try {
    try {
      candidateBlockID = await createNoteBlock(
        notion,
        containerBlockID,
        STAGING_NOTE_TITLE,
      );
    } catch (error) {
      if (!isArchivedOrNotFoundError(error)) throw error;
      containerBlockID = await createContainerBlock(notion, pageID);
      createdContainerBlockID = containerBlockID;
      candidateBlockID = await createNoteBlock(
        notion,
        containerBlockID,
        STAGING_NOTE_TITLE,
      );
    }

    await appendNoteBlockContent(notion, candidateBlockID, blocks);
    await finalizeNoteBlock(notion, candidateBlockID, noteTitle);

    const candidate: SyncedNoteCandidate = {
      blockID: candidateBlockID,
      completedAt: new Date(),
      images: prepared.metadata,
      ...(previousBlockID && { previousBlockID }),
      sourceHash,
      target,
    };
    await saveSyncedNoteRecord(regularItem, containerBlockID, noteItem.key, {
      ...current,
      candidate,
    });
    candidatePersisted = true;

    if (previousBlockID) {
      await deleteBlockWithVerification(notion, previousBlockID);
      oldRemovalComplete = true;
    }

    await saveSyncedNoteRecord(
      regularItem,
      containerBlockID,
      noteItem.key,
      promoteCandidate(candidate, current?.orphanBlockIDs),
    );
  } catch (error) {
    let candidateRemoved = !candidateBlockID;
    if (
      candidateBlockID &&
      !oldRemovalComplete &&
      !(error instanceof BlockDeleteUncertainError)
    ) {
      candidateRemoved = await rollbackCandidate(
        notion,
        regularItem,
        containerBlockID,
        noteItem.key,
        current,
        candidateBlockID,
        candidatePersisted,
      );
    } else if (candidateBlockID && !candidatePersisted) {
      candidateRemoved = await rollbackCandidate(
        notion,
        regularItem,
        containerBlockID,
        noteItem.key,
        current,
        candidateBlockID,
        candidatePersisted,
      );
    }
    if (createdContainerBlockID && candidateRemoved) {
      await cleanupCreatedContainer(
        notion,
        regularItem,
        createdContainerBlockID,
        noteItem.key,
        current,
      );
    }
    throw error;
  }
}

function promoteCandidate(
  candidate: SyncedNoteCandidate,
  orphanBlockIDs?: string[],
): SyncedNote {
  return {
    blockID: candidate.blockID,
    images: candidate.images,
    ...(orphanBlockIDs?.length && { orphanBlockIDs }),
    sourceHash: candidate.sourceHash,
    syncedAt: new Date(),
    target: candidate.target,
  };
}

async function recoverNoteState(
  notion: Client,
  regularItem: Zotero.Item,
  containerBlockID: string | undefined,
  noteItemKey: Zotero.DataObjectKey,
  current: SyncedNote,
): Promise<SyncedNote> {
  if (!current.candidate && !current.orphanBlockIDs?.length) return current;

  const remainingOrphans: string[] = [];
  for (const orphanBlockID of current.orphanBlockIDs || []) {
    try {
      await deleteBlockWithVerification(notion, orphanBlockID);
    } catch {
      remainingOrphans.push(orphanBlockID);
    }
  }

  const candidate = current.candidate;
  let recovered: SyncedNote = {
    ...current,
    candidate: undefined,
    orphanBlockIDs: remainingOrphans.length ? remainingOrphans : undefined,
  };

  if (candidate) {
    const candidateExists = await blockExistsWithRetry(
      notion,
      candidate.blockID,
    );
    const previousExists = candidate.previousBlockID
      ? await blockExistsWithRetry(notion, candidate.previousBlockID)
      : false;

    if (candidateExists && !previousExists) {
      recovered = promoteCandidate(candidate, remainingOrphans);
    } else if (candidateExists) {
      try {
        await deleteBlockWithVerification(notion, candidate.blockID);
      } catch {
        recovered.orphanBlockIDs = [...remainingOrphans, candidate.blockID];
      }
    }
  }

  await saveSyncedNoteRecord(
    regularItem,
    containerBlockID || '',
    noteItemKey,
    recovered,
  );
  return recovered;
}

async function resolveEmbeddedImages(
  noteItem: Zotero.Item,
  noteHTML: string,
  maxFileUploadSize: number,
): Promise<ResolvedNoteImage[]> {
  let references;
  try {
    references = findEmbeddedImages(noteHTML);
  } catch (error) {
    throw new LocalizableError(
      'Failed to parse embedded note images',
      'notero-error-note-conversion-failed',
      { cause: error },
    );
  }

  const resolvedByKey = new Map<string, ResolvedNoteImage>();
  const resolvedInOrder: ResolvedNoteImage[] = [];
  for (const reference of references) {
    const attachmentKey = reference.attachmentKey;
    if (!attachmentKey) {
      throw new LocalizableError(
        'Embedded image is missing data-attachment-key',
        'notero-error-note-sync-failed',
      );
    }

    let image = resolvedByKey.get(attachmentKey);
    if (!image) {
      image = await resolveNoteImage(noteItem, reference, maxFileUploadSize);
      resolvedByKey.set(attachmentKey, image);
    }
    resolvedInOrder.push({ ...image, alt: reference.alt });
  }
  return resolvedInOrder;
}

async function buildSourceHash(
  noteTitle: string,
  noteHTML: string,
  images: ResolvedNoteImage[],
): Promise<string> {
  const imageIdentity = images
    .map(({ attachmentKey, contentHash }) => `${attachmentKey}:${contentHash}`)
    .join('\n');
  return hashText(`${noteTitle}\u0000${noteHTML}\u0000${imageIdentity}`);
}

async function prepareImages(
  images: ResolvedNoteImage[],
  current: SyncedNote | undefined,
  target: NotionTarget,
  uploadService: ImageUploader,
): Promise<{
  imageMap: ReadonlyMap<string, PreparedNotionImage>;
  metadata: SyncedNoteImage[];
}> {
  const cachedImages = isSameNotionTarget(current?.target, target)
    ? current?.images || []
    : [];
  const cache = new Map(
    cachedImages.map((image) => [
      `${image.attachmentKey}:${image.contentHash}`,
      image,
    ]),
  );
  const preparedByKey = new Map<string, PreparedNotionImage>();
  const metadataByKey = new Map<string, SyncedNoteImage>();

  for (const image of images) {
    if (preparedByKey.has(image.attachmentKey)) continue;
    const cached = cache.get(`${image.attachmentKey}:${image.contentHash}`);
    const fileUploadID =
      cached?.fileUploadID || (await uploadService.upload(image));
    preparedByKey.set(image.attachmentKey, { fileUploadID });
    metadataByKey.set(image.attachmentKey, {
      attachmentKey: image.attachmentKey,
      contentHash: image.contentHash,
      contentType: image.contentType,
      fileUploadID,
      filename: image.filename,
      size: image.size,
    });
  }

  return {
    imageMap: preparedByKey,
    metadata: Array.from(metadataByKey.values()),
  };
}

function buildNoteBlocks(
  noteHTML: string,
  images: ReadonlyMap<string, PreparedNotionImage>,
): ChildBlock[] {
  try {
    return convertHtmlToBlocks(noteHTML, images.size ? { images } : {});
  } catch (error) {
    throw new LocalizableError(
      'Failed to convert note content to Notion blocks',
      'notero-error-note-conversion-failed',
      { cause: error },
    );
  }
}

async function createContainerBlock(
  notion: Client,
  pageID: string,
): Promise<string> {
  const { results } = await notion.blocks.children.append({
    block_id: pageID,
    children: [
      {
        heading_1: {
          rich_text: [{ text: { content: 'Zotero Notes' } }],
          is_toggleable: true,
        },
      },
    ],
  });

  if (!results[0]) {
    throw new LocalizableError(
      'Failed to create container block',
      'notero-error-note-sync-failed',
    );
  }
  return results[0].id;
}

async function createNoteBlock(
  notion: Client,
  containerBlockID: string,
  titlePrefix: string,
): Promise<string> {
  const title = `${titlePrefix} [${globalThis.crypto.randomUUID()}]`;
  try {
    const { results } = await notion.blocks.children.append({
      block_id: containerBlockID,
      children: [
        {
          heading_1: {
            rich_text: [{ text: { content: title } }],
            is_toggleable: true,
          },
        },
      ],
    });
    if (!results[0]) {
      throw new LocalizableError(
        'Failed to create note block',
        'notero-error-note-sync-failed',
      );
    }
    return results[0].id;
  } catch (error) {
    if (!isRetryableBlockError(error)) throw error;
    const recoveredBlockID = await findChildHeadingWithRetry(
      notion,
      containerBlockID,
      title,
    );
    if (recoveredBlockID) return recoveredBlockID;
    throw error;
  }
}

async function findChildHeadingWithRetry(
  notion: Client,
  parentBlockID: string,
  title: string,
): Promise<string | undefined> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= BLOCK_STATUS_ATTEMPTS; attempt += 1) {
    try {
      const found = await findChildHeading(notion, parentBlockID, title);
      if (found || attempt === BLOCK_STATUS_ATTEMPTS) return found;
    } catch (error) {
      lastError = error;
      if (!isRetryableBlockError(error) || attempt === BLOCK_STATUS_ATTEMPTS) {
        throw error;
      }
    }
    await waitForStatus(attempt);
  }
  throw lastError;
}

async function findChildHeading(
  notion: Client,
  parentBlockID: string,
  title: string,
): Promise<string | undefined> {
  let startCursor: string | undefined;
  for (let page = 0; page < MAX_CHILD_LIST_PAGES; page += 1) {
    const response = await notion.blocks.children.list({
      block_id: parentBlockID,
      page_size: 100,
      ...(startCursor && { start_cursor: startCursor }),
    });
    const match = response.results.find(
      (block) =>
        isFullBlock(block) &&
        block.type === 'heading_1' &&
        block.heading_1.rich_text
          .map(({ plain_text }) => plain_text)
          .join('') === title,
    );
    if (match) return match.id;
    if (!response.has_more) return undefined;
    if (!response.next_cursor) {
      throw new Error('Notion child block pagination cursor is missing');
    }
    startCursor = response.next_cursor;
  }
  throw new Error('Notion child block recovery exceeded its page limit');
}

async function appendNoteBlockContent(
  notion: Client,
  noteBlockID: string,
  blocks: ChildBlock[],
): Promise<void> {
  for (const batch of buildBlockBatches(blocks)) {
    // Append is intentionally never retried. A timeout has an ambiguous
    // result, so the complete candidate is discarded instead.
    await notion.blocks.children.append({
      block_id: noteBlockID,
      children: batch,
    });
  }
}

function buildBlockBatches(blocks: ChildBlock[]): BlockObjectRequest[][] {
  const batches: BlockObjectRequest[][] = [];
  for (
    let offset = 0;
    offset < blocks.length;
    offset += LIMITS.BLOCK_ARRAY_ELEMENTS
  ) {
    // @ts-expect-error Nested HTML can exceed the SDK's two-level type.
    batches.push(blocks.slice(offset, offset + LIMITS.BLOCK_ARRAY_ELEMENTS));
  }
  return batches;
}

async function finalizeNoteBlock(
  notion: Client,
  blockID: string,
  title: string,
): Promise<void> {
  await notion.blocks.update({
    block_id: blockID,
    heading_1: {
      rich_text: [{ text: { content: title } }],
      is_toggleable: true,
    },
  });
}

async function rollbackCandidate(
  notion: Client,
  regularItem: Zotero.Item,
  containerBlockID: string,
  noteItemKey: Zotero.DataObjectKey,
  current: SyncedNote | undefined,
  candidateBlockID: string,
  candidateWasPersisted: boolean,
): Promise<boolean> {
  let cleanupFailed = false;
  try {
    await deleteBlockWithVerification(notion, candidateBlockID);
  } catch {
    cleanupFailed = true;
  }

  const orphanBlockIDs = [
    ...(current?.orphanBlockIDs || []),
    ...(cleanupFailed ? [candidateBlockID] : []),
  ];
  const boundedOrphanBlockIDs = Array.from(new Set(orphanBlockIDs)).slice(-20);
  if (candidateWasPersisted || cleanupFailed) {
    await saveSyncedNoteRecord(regularItem, containerBlockID, noteItemKey, {
      ...current,
      ...(boundedOrphanBlockIDs.length && {
        orphanBlockIDs: boundedOrphanBlockIDs,
      }),
      candidate: undefined,
    });
  }
  return !cleanupFailed;
}

async function cleanupCreatedContainer(
  notion: Client,
  regularItem: Zotero.Item,
  containerBlockID: string,
  noteItemKey: Zotero.DataObjectKey,
  current: SyncedNote | undefined,
): Promise<void> {
  try {
    await deleteBlockWithVerification(notion, containerBlockID);
  } catch {
    const orphanBlockIDs = Array.from(
      new Set([...(current?.orphanBlockIDs || []), containerBlockID]),
    ).slice(-20);
    await saveSyncedNoteRecord(regularItem, containerBlockID, noteItemKey, {
      ...current,
      orphanBlockIDs,
    });
  }
}

async function deleteBlockWithVerification(
  notion: Client,
  blockID: string,
): Promise<void> {
  try {
    await notion.blocks.delete({ block_id: blockID });
    return;
  } catch (error) {
    if (isArchivedOrNotFoundError(error)) return;
    if (!isRetryableBlockError(error)) throw error;

    try {
      if (!(await blockExistsWithRetry(notion, blockID))) return;
    } catch (statusError) {
      throw new BlockDeleteUncertainError(
        'Unable to determine whether Notion block deletion completed',
        { cause: statusError },
      );
    }
    throw error;
  }
}

function isRetryableBlockError(error: unknown): boolean {
  if (RequestTimeoutError.isRequestTimeoutError(error)) return true;
  if (error instanceof TypeError) return true;
  return (
    error instanceof APIResponseError &&
    [409, 429, 500, 502, 503, 504, 529].includes(error.status)
  );
}

async function blockExistsWithRetry(
  notion: Client,
  blockID: string,
): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= BLOCK_STATUS_ATTEMPTS; attempt += 1) {
    try {
      const block = await notion.blocks.retrieve({ block_id: blockID });
      return !(isFullBlock(block) && block.in_trash);
    } catch (error) {
      if (isArchivedOrNotFoundError(error)) return false;
      lastError = error;
      if (!isRetryableBlockError(error) || attempt === BLOCK_STATUS_ATTEMPTS) {
        throw error;
      }
      await waitForStatus(attempt);
    }
  }
  throw lastError;
}

function waitForStatus(attempt: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 50 * 2 ** (attempt - 1));
  });
}

async function getEffectiveContainerBlockID(
  notion: Client,
  noteBlockID: string,
  containerBlockID: string,
): Promise<string> {
  let block;
  try {
    block = await notion.blocks.retrieve({ block_id: noteBlockID });
  } catch (error) {
    if (isArchivedOrNotFoundError(error)) return containerBlockID;
    throw error;
  }

  if (
    isFullBlock(block) &&
    'block_id' in block.parent &&
    block.parent.block_id !== containerBlockID
  ) {
    const parentBlock = await notion.blocks.retrieve({
      block_id: block.parent.block_id,
    });
    if (isFullBlock(parentBlock) && !parentBlock.in_trash) {
      return parentBlock.id;
    }
  }
  return containerBlockID;
}
