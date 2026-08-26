import { NOTION_TAG_NAME } from '../constants';
import type { NotionTarget } from '../sync/notion-image-upload-service';
import {
  getPageIDFromURL,
  isNotionPageURL,
  normalizeID,
} from '../sync/notion-utils';
import { isObject } from '../utils';
import { logger } from '../utils';

const SYNCED_NOTES_ID = 'notero-synced-notes';

export type SyncedNoteImage = {
  attachmentKey: string;
  contentHash: string;
  contentType: string;
  fileUploadID: string;
  filename: string;
  size: number;
};

export type SyncedNoteCandidate = {
  blockID: string;
  completedAt: Date;
  images: SyncedNoteImage[];
  previousBlockID?: string;
  sourceHash: string;
  target: NotionTarget;
};

export type SyncedNote = {
  blockID?: string;
  candidate?: SyncedNoteCandidate;
  images?: SyncedNoteImage[];
  orphanBlockIDs?: string[];
  sourceHash?: string;
  syncedAt?: Date;
  target?: NotionTarget;
};

export type SyncedNotes = {
  containerBlockID?: string;
  metadataCorrupt?: boolean;
  notes?: {
    [noteItemKey: Zotero.DataObjectKey]: SyncedNote;
  };
};

function getAllNotionLinkAttachments(item: Zotero.Item): Zotero.Item[] {
  const attachmentIDs = item
    .getAttachments(false)
    .slice()
    // Sort to get largest ID first
    .toSorted((a, b) => b - a);

  return Zotero.Items.get(attachmentIDs).filter((attachment) =>
    isNotionPageURL(attachment.getField('url')),
  );
}

export function getNotionLinkAttachment(
  item: Zotero.Item,
): Zotero.Item | undefined {
  return getAllNotionLinkAttachments(item)[0];
}

/**
 * Returns the Notion URL for the given item, if one exists.
 *
 * For regular items, this is the URL of the page.
 * For notes, this is the URL of the note block within the page.
 *
 * @param item The Zotero item to get the Notion URL for.
 * @returns The Notion URL, or `undefined` if one does not exist.
 */
export function getNotionURL(item: Zotero.Item): string | undefined {
  if (item.isRegularItem()) {
    return getNotionLinkAttachment(item)?.getField('url');
  }
  if (item.isNote()) {
    const attachment = getNotionLinkAttachment(item.topLevelItem);
    if (!attachment) return undefined;
    const pageURL = attachment.getField('url');
    if (!pageURL) return undefined;
    const syncedNotes = getSyncedNotesFromAttachment(attachment);
    const blockID = syncedNotes.notes?.[item.key]?.blockID;
    if (!blockID) return undefined;
    return `${pageURL}#${normalizeID(blockID)}`;
  }
  return undefined;
}

export function getNotionPageID(item: Zotero.Item): string | undefined {
  const notionURL = getNotionURL(item);
  return notionURL && getPageIDFromURL(notionURL);
}

export async function saveNotionLinkAttachment(
  item: Zotero.Item,
  url: string,
): Promise<void> {
  const attachments = getAllNotionLinkAttachments(item);

  if (attachments.length > 1) {
    const attachmentIDs = attachments.slice(1).map(({ id }) => id);
    await Zotero.Items.erase(attachmentIDs);
  }

  let attachment = attachments[0];
  let pageIDChanged = false;

  if (attachment) {
    const currentURL = attachment.getField('url');
    pageIDChanged =
      !currentURL || getPageIDFromURL(currentURL) !== getPageIDFromURL(url);
    attachment.setField('url', url);
  } else {
    attachment = await Zotero.Attachments.linkFromURL({
      parentItemID: item.id,
      title: 'Notion',
      url,
      saveOptions: {
        skipNotifier: true,
      },
    });
  }

  const syncedNotes = pageIDChanged ? {} : undefined;
  updateNotionLinkAttachmentNote(attachment, syncedNotes);

  await attachment.saveTx();
}

function getSyncedNotesJSON(attachment: Zotero.Item): string | undefined {
  const domParser = new DOMParser();
  const doc = domParser.parseFromString(attachment.getNote(), 'text/html');

  return doc.getElementById(SYNCED_NOTES_ID)?.innerHTML;
}

export function getSyncedNotes(item: Zotero.Item): SyncedNotes {
  const attachment = getNotionLinkAttachment(item);
  if (!attachment) return {};

  return getSyncedNotesFromAttachment(attachment);
}

export function getSyncedNotesFromAttachment(
  attachment: Zotero.Item,
): SyncedNotes {
  const syncedNotesJSON = getSyncedNotesJSON(attachment);
  if (!syncedNotesJSON) return {};

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(syncedNotesJSON);
  } catch {
    return corruptSyncedNotes();
  }

  if (!isObject(parsedValue)) return corruptSyncedNotes();

  let containerBlockID;
  const notes: Required<SyncedNotes>['notes'] = {};

  if (typeof parsedValue.containerBlockID === 'string') {
    containerBlockID = parsedValue.containerBlockID;
  } else if (parsedValue.containerBlockID !== undefined) {
    return corruptSyncedNotes();
  }

  if (isObject(parsedValue.noteBlockIDs)) {
    // Convert from original format
    Object.entries(parsedValue.noteBlockIDs).forEach(([key, value]) => {
      if (typeof value === 'string') {
        notes[key] = { blockID: value };
      }
    });
    if (
      Object.values(parsedValue.noteBlockIDs).some(
        (value) => typeof value !== 'string',
      )
    ) {
      return corruptSyncedNotes();
    }
  } else if (parsedValue.noteBlockIDs !== undefined) {
    return corruptSyncedNotes();
  }

  if (isObject(parsedValue.notes)) {
    for (const [key, value] of Object.entries(parsedValue.notes)) {
      if (!isObject(value)) return corruptSyncedNotes();

      const {
        blockID,
        candidate,
        images,
        orphanBlockIDs,
        sourceHash,
        syncedAt,
        target,
      } = value;
      const parsedCandidate = parseSyncedNoteCandidate(candidate);
      const parsedImages = parseSyncedNoteImages(images);
      const parsedSyncedAt = parseDate(syncedAt);
      if (
        (blockID !== undefined && typeof blockID !== 'string') ||
        (candidate !== undefined && !parsedCandidate) ||
        (images !== undefined && !parsedImages) ||
        (orphanBlockIDs !== undefined &&
          (!Array.isArray(orphanBlockIDs) ||
            orphanBlockIDs.some((id) => typeof id !== 'string'))) ||
        (sourceHash !== undefined && typeof sourceHash !== 'string') ||
        (syncedAt !== undefined && !parsedSyncedAt) ||
        (target !== undefined && !isNotionTarget(target))
      ) {
        return corruptSyncedNotes();
      }

      notes[key] = {
        ...(typeof blockID === 'string' && { blockID }),
        ...(parsedCandidate && { candidate: parsedCandidate }),
        ...(parsedImages && { images: parsedImages }),
        ...(Array.isArray(orphanBlockIDs) &&
          orphanBlockIDs.every((id) => typeof id === 'string') && {
            orphanBlockIDs,
          }),
        ...(typeof sourceHash === 'string' && { sourceHash }),
        ...(parsedSyncedAt && { syncedAt: parsedSyncedAt }),
        ...(isNotionTarget(target) && { target }),
      };
    }
  } else if (parsedValue.notes !== undefined) {
    return corruptSyncedNotes();
  }

  return { containerBlockID, notes };
}

function corruptSyncedNotes(): SyncedNotes {
  logger.warn('Ignoring corrupt Notero note synchronization metadata');
  return { metadataCorrupt: true };
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function isNotionTarget(value: unknown): value is NotionTarget {
  return (
    isObject(value) &&
    typeof value.connectionID === 'string' &&
    typeof value.databaseID === 'string' &&
    typeof value.pageID === 'string' &&
    typeof value.workspaceID === 'string'
  );
}

function parseSyncedNoteImages(value: unknown): SyncedNoteImage[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const images: SyncedNoteImage[] = [];
  for (const image of value) {
    if (
      !isObject(image) ||
      typeof image.attachmentKey !== 'string' ||
      typeof image.contentHash !== 'string' ||
      typeof image.contentType !== 'string' ||
      typeof image.fileUploadID !== 'string' ||
      typeof image.filename !== 'string' ||
      typeof image.size !== 'number'
    ) {
      return undefined;
    }
    images.push({
      attachmentKey: image.attachmentKey,
      contentHash: image.contentHash,
      contentType: image.contentType,
      fileUploadID: image.fileUploadID,
      filename: image.filename,
      size: image.size,
    });
  }
  return images;
}

function parseSyncedNoteCandidate(
  value: unknown,
): SyncedNoteCandidate | undefined {
  if (!isObject(value)) return undefined;
  const images = parseSyncedNoteImages(value.images);
  const completedAt = parseDate(value.completedAt);
  if (
    typeof value.blockID !== 'string' ||
    typeof value.sourceHash !== 'string' ||
    !completedAt ||
    !images ||
    !isNotionTarget(value.target) ||
    (value.previousBlockID !== undefined &&
      typeof value.previousBlockID !== 'string')
  ) {
    return undefined;
  }

  return {
    blockID: value.blockID,
    completedAt,
    images,
    ...(value.previousBlockID && { previousBlockID: value.previousBlockID }),
    sourceHash: value.sourceHash,
    target: value.target,
  };
}

export async function saveSyncedNoteRecord(
  item: Zotero.Item,
  containerBlockID: string,
  noteItemKey: Zotero.DataObjectKey,
  note: SyncedNote,
): Promise<void> {
  const attachment = getNotionLinkAttachment(item);
  if (!attachment) {
    throw new Error('Cannot save note sync state without a Notion link');
  }

  const syncedNotes = getSyncedNotesFromAttachment(attachment);
  if (syncedNotes.metadataCorrupt) {
    throw new Error('Cannot overwrite corrupt Notero synchronization metadata');
  }
  const { notes } = syncedNotes;
  updateNotionLinkAttachmentNote(attachment, {
    containerBlockID,
    notes: { ...notes, [noteItemKey]: note },
  });
  await attachment.saveTx();
}

export async function saveSyncedNote(
  item: Zotero.Item,
  containerBlockID: string,
  noteBlockID: string | undefined,
  noteItemKey: Zotero.DataObjectKey,
) {
  const attachment = getNotionLinkAttachment(item);
  if (!attachment) return;

  if (!noteBlockID) return;
  await saveSyncedNoteRecord(item, containerBlockID, noteItemKey, {
    blockID: noteBlockID,
    syncedAt: new Date(),
  });
}

function updateNotionLinkAttachmentNote(
  attachment: Zotero.Item,
  syncedNotes?: SyncedNotes,
) {
  let note = `
<h2 style="background-color: #ff666680;">Do not modify or delete!</h2>
<p>This link attachment serves as a reference for
<a href="https://github.com/dvanoni/notero">Notero</a>
so that it can properly update the Notion page for this item.</p>
<p>Last synced: ${new Date().toLocaleString()}</p>
`;

  const syncedNotesJSON = syncedNotes
    ? JSON.stringify(syncedNotes)
    : getSyncedNotesJSON(attachment);

  if (syncedNotesJSON) {
    note += `<pre id="${SYNCED_NOTES_ID}">${syncedNotesJSON}</pre>`;
  }

  attachment.setNote(note);
}

export async function saveNotionTag(item: Zotero.Item): Promise<void> {
  item.addTag(NOTION_TAG_NAME);
  await item.saveTx({ skipNotifier: true });
}
