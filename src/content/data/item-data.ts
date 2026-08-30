import { NOTION_TAG_NAME } from '../constants';
import { validateNoteSyncRecordJSON } from '../sync/note-sync-transaction/schema';
import { NOTE_SYNC_SCHEMA_VERSION } from '../sync/note-sync-transaction/types';
import {
  getPageIDFromURL,
  isNotionPageURL,
  normalizeID,
} from '../sync/notion-utils';
import { isObject } from '../utils';

const SYNCED_NOTES_ID = 'notero-synced-notes';
export const SYNCED_NOTES_SCHEMA_VERSION = NOTE_SYNC_SCHEMA_VERSION;

export type MetadataDiagnostic = {
  path: string;
  reason: string;
  summary: string;
};

export type SyncedNoteSummary = {
  blockID?: string;
  state?: string;
  syncedAt?: Date;
};

export type LegacySyncEvidence = {
  containerBlockID?: string;
  noteBlockIDs?: Record<string, string>;
};

/** Read-only projection for UI link generation and the sync queue. */
export type SyncedNotes = {
  containerBlockID?: string;
  diagnostics?: MetadataDiagnostic[];
  legacy?: LegacySyncEvidence;
  metadataCorrupt?: boolean;
  notes?: Record<Zotero.DataObjectKey, SyncedNoteSummary>;
  schemaVersion?: number;
  unsupportedFutureSchema?: {
    rawJSON: string;
    schemaVersion: number;
  };
};

function getAllNotionLinkAttachments(item: Zotero.Item): Zotero.Item[] {
  const attachmentIDs = item
    .getAttachments(false)
    .slice()
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

export function getNotionURL(item: Zotero.Item): string | undefined {
  if (item.isRegularItem()) {
    return getNotionLinkAttachment(item)?.getField('url');
  }
  if (item.isNote()) {
    const attachment = getNotionLinkAttachment(item.topLevelItem);
    if (!attachment) return undefined;
    const pageURL = attachment.getField('url');
    if (!pageURL) return undefined;
    const blockID =
      getSyncedNotesFromAttachment(attachment).notes?.[item.key]?.blockID;
    return blockID ? `${pageURL}#${normalizeID(blockID)}` : undefined;
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
    await Zotero.Items.erase(attachments.slice(1).map(({ id }) => id));
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
      saveOptions: { skipNotifier: true },
      title: 'Notion',
      url,
    });
  }

  updateNotionLinkAttachmentNote(attachment, pageIDChanged ? {} : undefined);
  await attachment.saveTx();
}

function getSyncedNotesJSON(attachment: Zotero.Item): string | undefined {
  const doc = new DOMParser().parseFromString(
    attachment.getNote(),
    'text/html',
  );
  return doc.getElementById(SYNCED_NOTES_ID)?.innerHTML;
}

export function getRawSyncedNotesMetadata(
  item: Zotero.Item,
): string | undefined {
  const attachment = getNotionLinkAttachment(item);
  return attachment ? getSyncedNotesJSON(attachment) : undefined;
}

export async function saveRawSyncedNotesMetadata(
  item: Zotero.Item,
  rawJSON: string,
): Promise<void> {
  const attachment = getNotionLinkAttachment(item);
  if (!attachment) {
    throw new Error('Cannot save note sync state without a Notion link');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJSON);
  } catch (error) {
    throw new Error('Cannot persist invalid note sync metadata JSON', {
      cause: error,
    });
  }
  if (!isObject(parsed)) {
    throw new Error('Cannot persist a non-object note sync metadata root');
  }
  updateNotionLinkAttachmentNote(attachment, parsed);
  await attachment.saveTx();
}

export function getSyncedNotes(item: Zotero.Item): SyncedNotes {
  const attachment = getNotionLinkAttachment(item);
  return attachment ? getSyncedNotesFromAttachment(attachment) : {};
}

export function getSyncedNotesFromAttachment(
  attachment: Zotero.Item,
): SyncedNotes {
  const raw = getSyncedNotesJSON(attachment);
  if (!raw) return {};

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return corrupt('invalid-json', `string(length=${raw.length})`);
  }
  if (!isObject(value)) return corrupt('invalid-root', summarize(value));

  const schemaVersion =
    typeof value.schemaVersion === 'number' ? value.schemaVersion : 1;
  if (schemaVersion > NOTE_SYNC_SCHEMA_VERSION) {
    return {
      unsupportedFutureSchema: { rawJSON: raw, schemaVersion },
    };
  }
  if (schemaVersion === 2) {
    return corrupt(
      'feature-v2-transaction-unsupported',
      'unpublished feature-v2 metadata is quarantined',
    );
  }
  return schemaVersion === NOTE_SYNC_SCHEMA_VERSION
    ? projectV3(value)
    : projectLegacy(value);
}

function projectV3(value: Record<string, unknown>): SyncedNotes {
  if (!isObject(value.notes)) {
    return corrupt('invalid-v3-notes', summarize(value.notes));
  }
  const diagnostics: MetadataDiagnostic[] = [];
  const notes: Record<string, SyncedNoteSummary> = {};
  for (const [key, rawRecord] of Object.entries(value.notes)) {
    const parsed = validateNoteSyncRecordJSON(JSON.stringify(rawRecord));
    if (parsed.validation === 'quarantined') {
      diagnostics.push({
        path: `notes.${key}`,
        reason: parsed.diagnostic.code,
        summary: parsed.diagnostic.message,
      });
      continue;
    }
    notes[key] = {
      ...(parsed.record.active && {
        blockID: parsed.record.active.block.blockID,
        syncedAt: new Date(parsed.record.active.committedAt),
      }),
      state: parsed.record.state,
    };
  }
  const legacy = parseLegacyEvidence(value.legacy);
  const containerBlockID =
    isObject(value.container) && typeof value.container.blockID === 'string'
      ? value.container.blockID
      : undefined;
  return {
    ...(containerBlockID && { containerBlockID }),
    ...(diagnostics.length && { diagnostics }),
    ...(legacy && { legacy }),
    notes,
    schemaVersion: NOTE_SYNC_SCHEMA_VERSION,
  };
}

function projectLegacy(value: Record<string, unknown>): SyncedNotes {
  const diagnostics: MetadataDiagnostic[] = [];
  const noteBlockIDs: Record<string, string> = {};
  const notes: Record<string, SyncedNoteSummary> = {};
  if (isObject(value.noteBlockIDs)) {
    for (const [key, blockID] of Object.entries(value.noteBlockIDs)) {
      if (typeof blockID === 'string') {
        noteBlockIDs[key] = blockID;
        notes[key] = { blockID };
      } else {
        diagnostics.push({
          path: `noteBlockIDs.${key}`,
          reason: 'invalid-block-id',
          summary: summarize(blockID),
        });
      }
    }
  }
  if (isObject(value.notes)) {
    for (const [key, note] of Object.entries(value.notes)) {
      if (!isObject(note) || typeof note.blockID !== 'string') continue;
      const syncedAt = parseDate(note.syncedAt);
      noteBlockIDs[key] = note.blockID;
      notes[key] = {
        blockID: note.blockID,
        ...(syncedAt && { syncedAt }),
      };
    }
  }
  const containerBlockID =
    typeof value.containerBlockID === 'string'
      ? value.containerBlockID
      : undefined;
  return {
    ...(containerBlockID && { containerBlockID }),
    ...(diagnostics.length && { diagnostics }),
    ...((containerBlockID || Object.keys(noteBlockIDs).length) && {
      legacy: {
        ...(containerBlockID && { containerBlockID }),
        noteBlockIDs,
      },
    }),
    notes,
    schemaVersion: 1,
  };
}

function parseLegacyEvidence(value: unknown): LegacySyncEvidence | undefined {
  if (!isObject(value)) return undefined;
  const noteBlockIDs = isObject(value.noteBlockIDs)
    ? Object.fromEntries(
        Object.entries(value.noteBlockIDs).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : {};
  const containerBlockID =
    typeof value.containerBlockID === 'string'
      ? value.containerBlockID
      : undefined;
  return containerBlockID || Object.keys(noteBlockIDs).length
    ? { ...(containerBlockID && { containerBlockID }), noteBlockIDs }
    : undefined;
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function corrupt(reason: string, summary: string): SyncedNotes {
  return {
    diagnostics: [{ path: '$', reason, summary }],
    metadataCorrupt: true,
  };
}

function summarize(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(length=${value.length})`;
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return `string(length=${value.length})`;
  return typeof value;
}

function updateNotionLinkAttachmentNote(
  attachment: Zotero.Item,
  syncedNotes?: unknown,
): void {
  let note = `
<h2 style="background-color: #ff666680;">Do not modify or delete!</h2>
<p>This link attachment serves as a reference for
<a href="https://github.com/dvanoni/notero">Notero</a>
so that it can properly update the Notion page for this item.</p>
<p>Last synced: ${new Date().toLocaleString()}</p>
`;

  const raw =
    syncedNotes === undefined
      ? getSyncedNotesJSON(attachment)
      : JSON.stringify(syncedNotes);
  if (raw) note += `<pre id="${SYNCED_NOTES_ID}">${raw}</pre>`;
  attachment.setNote(note);
}

export async function saveNotionTag(item: Zotero.Item): Promise<void> {
  item.addTag(NOTION_TAG_NAME);
  await item.saveTx({ skipNotifier: true });
}
