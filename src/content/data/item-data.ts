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
export const SYNCED_NOTES_SCHEMA_VERSION = 2;

export type MetadataDiagnostic = {
  path: string;
  reason: string;
  summary: string;
};

export type ManagedBlockReference = {
  attemptID?: string;
  blockID: string;
  kind: 'candidate' | 'container' | 'note';
  marker: string;
};

export type SyncedNoteImage = {
  attachmentKey: string;
  contentHash: string;
  contentType: string;
  fileUploadID: string;
  filename: string;
  size: number;
};

export type SyncedNoteCandidate = {
  attemptID?: string;
  blockID: string;
  completedAt: Date;
  images: SyncedNoteImage[];
  ownership?: ManagedBlockReference;
  ownershipStatus?: 'legacy-unverified' | 'managed';
  previousBlockID?: string;
  sourceHash: string;
  target: NotionTarget;
};

export type ProvisionalFileUpload = {
  attachmentKey: string;
  attemptID: string;
  contentHash: string;
  contentLength: number;
  contentType: string;
  createdAt?: Date;
  expiryTime?: Date | null;
  fileUploadID?: string;
  filename: string;
  isolationDeadline?: Date;
  libraryID: number;
  noteItemKey: string;
  parentItemKey: string;
  requestStartedAt?: Date;
  status:
    | 'create-uncertain'
    | 'expired'
    | 'failed'
    | 'pending'
    | 'send-uncertain'
    | 'uploaded';
  target: NotionTarget;
};

export type NoteSyncTransaction = {
  attemptID: string;
  candidate?: ManagedBlockReference;
  container?: ManagedBlockReference;
  expectedImageCount?: number;
  orphanCleanupAttempts?: number;
  preparedImageCount?: number;
  previous?: ManagedBlockReference;
  renderedImageCount?: number;
  resolvedImageCount?: number;
  sourceHash: string;
  stage: string;
  startedAt: Date;
  target: NotionTarget;
};

export type SyncedNote = {
  blockID?: string;
  candidate?: SyncedNoteCandidate;
  images?: SyncedNoteImage[];
  orphanBlocks?: ManagedBlockReference[];
  orphanBlockIDs?: string[];
  ownership?: ManagedBlockReference;
  ownershipStatus?: 'legacy-unverified' | 'managed';
  preservedUnknown?: Record<string, unknown>;
  provisionalUploads?: ProvisionalFileUpload[];
  sourceHash?: string;
  syncedAt?: Date;
  target?: NotionTarget;
  transaction?: NoteSyncTransaction;
  unverifiedOrphanBlocks?: ManagedBlockReference[];
};

export type LegacySyncEvidence = {
  containerBlockID?: string;
  migrationNoticeDisplayedAt?: Date;
  noteBlockIDs?: Record<string, string>;
};

export type SyncedNotes = {
  container?: ManagedBlockReference;
  containerBlockID?: string;
  diagnostics?: MetadataDiagnostic[];
  legacy?: LegacySyncEvidence;
  metadataCorrupt?: boolean;
  notes?: {
    [noteItemKey: Zotero.DataObjectKey]: SyncedNote;
  };
  preservedUnknown?: Record<string, unknown>;
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
    return corruptSyncedNotes(
      'invalid-json',
      `string(length=${syncedNotesJSON.length})`,
    );
  }

  if (!isObject(parsedValue)) {
    return corruptSyncedNotes('invalid-root', summarizeValue(parsedValue));
  }

  const diagnostics = parseDiagnostics(parsedValue.diagnostics);
  const schemaVersion =
    typeof parsedValue.schemaVersion === 'number' &&
    Number.isSafeInteger(parsedValue.schemaVersion) &&
    parsedValue.schemaVersion > 0
      ? parsedValue.schemaVersion
      : 1;
  if (schemaVersion > SYNCED_NOTES_SCHEMA_VERSION) {
    return {
      schemaVersion,
      unsupportedFutureSchema: { rawJSON: syncedNotesJSON, schemaVersion },
    };
  }
  if (
    parsedValue.schemaVersion !== undefined &&
    schemaVersion !== parsedValue.schemaVersion
  ) {
    diagnostics.push(
      buildDiagnostic(
        'schemaVersion',
        'invalid-schema-version',
        parsedValue.schemaVersion,
      ),
    );
  }

  let containerBlockID: string | undefined;
  let container: ManagedBlockReference | undefined;
  let legacy = parseLegacySyncEvidence(parsedValue.legacy);
  const notes: Required<SyncedNotes>['notes'] = {};

  if (typeof parsedValue.containerBlockID === 'string') {
    containerBlockID = parsedValue.containerBlockID;
  } else if (parsedValue.containerBlockID !== undefined) {
    diagnostics.push(
      buildDiagnostic(
        'containerBlockID',
        'invalid-container-block-id',
        parsedValue.containerBlockID,
      ),
    );
  }
  if (parsedValue.container !== undefined) {
    container = parseManagedBlockReference(parsedValue.container);
    if (!container || container.kind !== 'container') {
      diagnostics.push(
        buildDiagnostic(
          'container',
          'invalid-managed-container',
          parsedValue.container,
        ),
      );
      container = undefined;
    } else {
      containerBlockID = container.blockID;
    }
  }

  if (isObject(parsedValue.noteBlockIDs)) {
    Object.entries(parsedValue.noteBlockIDs).forEach(([key, value]) => {
      if (typeof value === 'string') {
        notes[key] = {
          blockID: value,
          ownershipStatus: 'legacy-unverified',
        };
        legacy = addLegacyNoteBlock(legacy, key, value);
      } else {
        diagnostics.push(
          buildDiagnostic(
            `noteBlockIDs.${key}`,
            'invalid-legacy-note-block-id',
            value,
          ),
        );
      }
    });
  } else if (parsedValue.noteBlockIDs !== undefined) {
    diagnostics.push(
      buildDiagnostic(
        'noteBlockIDs',
        'invalid-legacy-note-records',
        parsedValue.noteBlockIDs,
      ),
    );
  }

  if (isObject(parsedValue.notes)) {
    for (const [key, value] of Object.entries(parsedValue.notes)) {
      if (!isObject(value)) {
        diagnostics.push(
          buildDiagnostic(`notes.${key}`, 'invalid-note-record', value),
        );
        continue;
      }
      notes[key] = parseSyncedNote(key, value, diagnostics);
      if (
        notes[key]?.blockID &&
        notes[key]?.ownershipStatus === 'legacy-unverified'
      ) {
        legacy = addLegacyNoteBlock(legacy, key, notes[key].blockID);
      }
    }
  } else if (parsedValue.notes !== undefined) {
    diagnostics.push(
      buildDiagnostic('notes', 'invalid-note-records', parsedValue.notes),
    );
  }

  const knownRootFields = new Set([
    'container',
    'containerBlockID',
    'diagnostics',
    'legacy',
    'noteBlockIDs',
    'notes',
    'preservedUnknown',
    'schemaVersion',
  ]);
  const preservedUnknown = {
    ...(isObject(parsedValue.preservedUnknown)
      ? parsedValue.preservedUnknown
      : {}),
    ...Object.fromEntries(
      Object.entries(parsedValue).filter(([key]) => !knownRootFields.has(key)),
    ),
  };

  return {
    ...(container && { container }),
    ...(containerBlockID && { containerBlockID }),
    ...(diagnostics.length && { diagnostics }),
    ...((legacy || (containerBlockID && !container)) && {
      legacy: {
        ...legacy,
        ...(!container && containerBlockID && { containerBlockID }),
      },
    }),
    notes,
    ...(Object.keys(preservedUnknown).length && { preservedUnknown }),
    schemaVersion,
  };
}

function addLegacyNoteBlock(
  legacy: LegacySyncEvidence | undefined,
  key: string,
  blockID: string,
): LegacySyncEvidence {
  return {
    ...legacy,
    noteBlockIDs: { ...legacy?.noteBlockIDs, [key]: blockID },
  };
}

function parseLegacySyncEvidence(
  value: unknown,
): LegacySyncEvidence | undefined {
  if (!isObject(value)) return undefined;
  const noteBlockIDs = isObject(value.noteBlockIDs)
    ? Object.fromEntries(
        Object.entries(value.noteBlockIDs).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : undefined;
  const migrationNoticeDisplayedAt = parseDate(
    value.migrationNoticeDisplayedAt,
  );
  if (
    typeof value.containerBlockID !== 'string' &&
    !Object.keys(noteBlockIDs || {}).length &&
    !migrationNoticeDisplayedAt
  ) {
    return undefined;
  }
  return {
    ...(typeof value.containerBlockID === 'string' && {
      containerBlockID: value.containerBlockID,
    }),
    ...(migrationNoticeDisplayedAt && { migrationNoticeDisplayedAt }),
    ...(Object.keys(noteBlockIDs || {}).length && { noteBlockIDs }),
  };
}

function corruptSyncedNotes(reason: string, summary: string): SyncedNotes {
  logger.warn('Ignoring corrupt Notero note synchronization metadata');
  return {
    diagnostics: [{ path: '$', reason, summary }],
    metadataCorrupt: true,
  };
}

function summarizeValue(value: unknown): string {
  if (Array.isArray(value)) return `array(length=${value.length})`;
  if (isObject(value)) {
    return `object(keys=${Object.keys(value).toSorted().join(',')})`;
  }
  if (typeof value === 'string') return `string(length=${value.length})`;
  return typeof value;
}

function buildDiagnostic(
  path: string,
  reason: string,
  value: unknown,
): MetadataDiagnostic {
  return { path, reason, summary: summarizeValue(value) };
}

function parseDiagnostics(value: unknown): MetadataDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((diagnostic) =>
    isObject(diagnostic) &&
    typeof diagnostic.path === 'string' &&
    typeof diagnostic.reason === 'string' &&
    typeof diagnostic.summary === 'string'
      ? [
          {
            path: diagnostic.path,
            reason: diagnostic.reason,
            summary: diagnostic.summary,
          },
        ]
      : [],
  );
}

function parseSyncedNote(
  key: string,
  value: Record<string, unknown>,
  diagnostics: MetadataDiagnostic[],
): SyncedNote {
  const note: SyncedNote = {};
  if (typeof value.blockID === 'string') note.blockID = value.blockID;
  else if (value.blockID !== undefined) {
    diagnostics.push(
      buildDiagnostic(
        `notes.${key}.blockID`,
        'invalid-note-block-id',
        value.blockID,
      ),
    );
  }

  const ownership = parseManagedBlockReference(value.ownership);
  if (value.ownership !== undefined && !ownership) {
    diagnostics.push(
      buildDiagnostic(
        `notes.${key}.ownership`,
        'invalid-note-ownership',
        value.ownership,
      ),
    );
  }
  if (
    ownership &&
    ownership.kind === 'note' &&
    ownership.blockID === note.blockID
  ) {
    note.ownership = ownership;
    note.ownershipStatus = 'managed';
  } else if (note.blockID) {
    note.ownershipStatus = 'legacy-unverified';
  }

  const candidate = parseSyncedNoteCandidate(value.candidate);
  if (candidate) note.candidate = candidate;
  else if (value.candidate !== undefined) {
    diagnostics.push(
      buildDiagnostic(
        `notes.${key}.candidate`,
        'invalid-candidate',
        value.candidate,
      ),
    );
  }

  const images = parseSyncedNoteImages(value.images);
  if (images) note.images = images;
  else if (value.images !== undefined) {
    diagnostics.push(
      buildDiagnostic(
        `notes.${key}.images`,
        'invalid-image-cache',
        value.images,
      ),
    );
  }

  const orphanBlocks = parseManagedBlockReferences(value.orphanBlocks);
  if (orphanBlocks) note.orphanBlocks = orphanBlocks;
  else if (value.orphanBlocks !== undefined) {
    diagnostics.push(
      buildDiagnostic(
        `notes.${key}.orphanBlocks`,
        'invalid-managed-orphans',
        value.orphanBlocks,
      ),
    );
  }
  if (
    Array.isArray(value.orphanBlockIDs) &&
    value.orphanBlockIDs.every((id) => typeof id === 'string')
  ) {
    note.orphanBlockIDs = value.orphanBlockIDs;
  } else if (value.orphanBlockIDs !== undefined) {
    diagnostics.push(
      buildDiagnostic(
        `notes.${key}.orphanBlockIDs`,
        'invalid-legacy-orphans',
        value.orphanBlockIDs,
      ),
    );
  }

  if (typeof value.sourceHash === 'string') note.sourceHash = value.sourceHash;
  else if (value.sourceHash !== undefined) {
    diagnostics.push(
      buildDiagnostic(
        `notes.${key}.sourceHash`,
        'invalid-source-hash',
        value.sourceHash,
      ),
    );
  }
  const syncedAt = parseDate(value.syncedAt);
  if (syncedAt) note.syncedAt = syncedAt;
  else if (value.syncedAt !== undefined) {
    diagnostics.push(
      buildDiagnostic(
        `notes.${key}.syncedAt`,
        'invalid-sync-date',
        value.syncedAt,
      ),
    );
  }
  if (isNotionTarget(value.target)) note.target = value.target;
  else if (value.target !== undefined) {
    diagnostics.push(
      buildDiagnostic(
        `notes.${key}.target`,
        'invalid-notion-target',
        value.target,
      ),
    );
  }

  const transaction = parseNoteSyncTransaction(value.transaction);
  if (transaction) note.transaction = transaction;
  else if (value.transaction !== undefined) {
    diagnostics.push(
      buildDiagnostic(
        `notes.${key}.transaction`,
        'invalid-transaction',
        value.transaction,
      ),
    );
  }
  const provisionalUploads = parseProvisionalUploads(value.provisionalUploads);
  if (provisionalUploads) note.provisionalUploads = provisionalUploads;
  else if (value.provisionalUploads !== undefined) {
    diagnostics.push(
      buildDiagnostic(
        `notes.${key}.provisionalUploads`,
        'invalid-provisional-uploads',
        value.provisionalUploads,
      ),
    );
  }

  const knownFields = new Set([
    'blockID',
    'candidate',
    'images',
    'orphanBlockIDs',
    'orphanBlocks',
    'ownership',
    'ownershipStatus',
    'preservedUnknown',
    'provisionalUploads',
    'sourceHash',
    'syncedAt',
    'target',
    'transaction',
    'unverifiedOrphanBlocks',
  ]);
  const preservedUnknown = {
    ...(isObject(value.preservedUnknown) ? value.preservedUnknown : {}),
    ...Object.fromEntries(
      Object.entries(value).filter(([field]) => !knownFields.has(field)),
    ),
  };
  if (Object.keys(preservedUnknown).length) {
    note.preservedUnknown = preservedUnknown;
  }
  const unverifiedOrphanBlocks = parseManagedBlockReferences(
    value.unverifiedOrphanBlocks,
  );
  if (unverifiedOrphanBlocks) {
    note.unverifiedOrphanBlocks = unverifiedOrphanBlocks;
  }
  return note;
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

function parseManagedBlockReference(
  value: unknown,
): ManagedBlockReference | undefined {
  if (
    !isObject(value) ||
    typeof value.blockID !== 'string' ||
    typeof value.marker !== 'string' ||
    !['candidate', 'container', 'note'].includes(String(value.kind)) ||
    (value.attemptID !== undefined && typeof value.attemptID !== 'string')
  ) {
    return undefined;
  }
  return {
    ...(typeof value.attemptID === 'string' && { attemptID: value.attemptID }),
    blockID: value.blockID,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    kind: value.kind as ManagedBlockReference['kind'],
    marker: value.marker,
  };
}

function parseManagedBlockReferences(
  value: unknown,
): ManagedBlockReference[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const references = value.map(parseManagedBlockReference);
  if (references.some((reference) => !reference)) return undefined;
  return references.filter(Boolean);
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
  const ownership = parseManagedBlockReference(value.ownership);
  if (
    typeof value.blockID !== 'string' ||
    typeof value.sourceHash !== 'string' ||
    !completedAt ||
    !images ||
    !isNotionTarget(value.target) ||
    (value.attemptID !== undefined && typeof value.attemptID !== 'string') ||
    (value.ownership !== undefined && !ownership) ||
    (value.previousBlockID !== undefined &&
      typeof value.previousBlockID !== 'string')
  ) {
    return undefined;
  }

  return {
    ...(typeof value.attemptID === 'string' && {
      attemptID: value.attemptID,
    }),
    blockID: value.blockID,
    completedAt,
    images,
    ...(ownership && { ownership }),
    ownershipStatus:
      ownership?.kind === 'candidate' && ownership.blockID === value.blockID
        ? 'managed'
        : 'legacy-unverified',
    ...(value.previousBlockID && { previousBlockID: value.previousBlockID }),
    sourceHash: value.sourceHash,
    target: value.target,
  };
}

function parseNoteSyncTransaction(
  value: unknown,
): NoteSyncTransaction | undefined {
  if (!isObject(value)) return undefined;
  const startedAt = parseDate(value.startedAt);
  if (
    typeof value.attemptID !== 'string' ||
    typeof value.sourceHash !== 'string' ||
    typeof value.stage !== 'string' ||
    !startedAt ||
    !isNotionTarget(value.target)
  ) {
    return undefined;
  }
  const candidate = parseManagedBlockReference(value.candidate);
  const container = parseManagedBlockReference(value.container);
  const previous = parseManagedBlockReference(value.previous);
  if (
    (value.candidate !== undefined && !candidate) ||
    (value.container !== undefined && !container) ||
    (value.previous !== undefined && !previous)
  ) {
    return undefined;
  }
  const counts = [
    'expectedImageCount',
    'preparedImageCount',
    'renderedImageCount',
    'resolvedImageCount',
    'orphanCleanupAttempts',
  ] as const;
  if (
    counts.some(
      (field) =>
        value[field] !== undefined &&
        (!Number.isSafeInteger(value[field]) || Number(value[field]) < 0),
    )
  ) {
    return undefined;
  }
  return {
    attemptID: value.attemptID,
    ...(candidate && { candidate }),
    ...(container && { container }),
    ...(typeof value.expectedImageCount === 'number' && {
      expectedImageCount: value.expectedImageCount,
    }),
    ...(typeof value.preparedImageCount === 'number' && {
      preparedImageCount: value.preparedImageCount,
    }),
    ...(previous && { previous }),
    ...(typeof value.orphanCleanupAttempts === 'number' && {
      orphanCleanupAttempts: value.orphanCleanupAttempts,
    }),
    ...(typeof value.renderedImageCount === 'number' && {
      renderedImageCount: value.renderedImageCount,
    }),
    ...(typeof value.resolvedImageCount === 'number' && {
      resolvedImageCount: value.resolvedImageCount,
    }),
    sourceHash: value.sourceHash,
    stage: value.stage,
    startedAt,
    target: value.target,
  };
}

function parseProvisionalUploads(
  value: unknown,
): ProvisionalFileUpload[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const uploads: ProvisionalFileUpload[] = [];
  for (const upload of value) {
    if (
      !isObject(upload) ||
      typeof upload.attachmentKey !== 'string' ||
      typeof upload.attemptID !== 'string' ||
      typeof upload.contentHash !== 'string' ||
      typeof upload.contentLength !== 'number' ||
      typeof upload.contentType !== 'string' ||
      typeof upload.filename !== 'string' ||
      typeof upload.libraryID !== 'number' ||
      typeof upload.noteItemKey !== 'string' ||
      typeof upload.parentItemKey !== 'string' ||
      ![
        'create-uncertain',
        'expired',
        'failed',
        'pending',
        'send-uncertain',
        'uploaded',
      ].includes(String(upload.status)) ||
      !isNotionTarget(upload.target) ||
      (upload.fileUploadID !== undefined &&
        typeof upload.fileUploadID !== 'string')
    ) {
      return undefined;
    }
    const createdAt = parseDate(upload.createdAt);
    const isolationDeadline = parseDate(upload.isolationDeadline);
    const requestStartedAt = parseDate(upload.requestStartedAt);
    const expiryTime =
      upload.expiryTime === null ? null : parseDate(upload.expiryTime);
    if (
      (upload.createdAt !== undefined && !createdAt) ||
      (upload.isolationDeadline !== undefined && !isolationDeadline) ||
      (upload.requestStartedAt !== undefined && !requestStartedAt) ||
      (upload.expiryTime !== undefined &&
        upload.expiryTime !== null &&
        !expiryTime)
    ) {
      return undefined;
    }
    uploads.push({
      attachmentKey: upload.attachmentKey,
      attemptID: upload.attemptID,
      contentHash: upload.contentHash,
      contentLength: upload.contentLength,
      contentType: upload.contentType,
      ...(createdAt && { createdAt }),
      ...(upload.expiryTime !== undefined && { expiryTime }),
      ...(typeof upload.fileUploadID === 'string' && {
        fileUploadID: upload.fileUploadID,
      }),
      filename: upload.filename,
      ...(isolationDeadline && { isolationDeadline }),
      libraryID: upload.libraryID,
      noteItemKey: upload.noteItemKey,
      parentItemKey: upload.parentItemKey,
      ...(requestStartedAt && { requestStartedAt }),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      status: upload.status as ProvisionalFileUpload['status'],
      target: upload.target,
    });
  }
  return uploads;
}

export async function saveSyncedNoteRecord(
  item: Zotero.Item,
  containerBlockID: string,
  noteItemKey: Zotero.DataObjectKey,
  note: SyncedNote,
  container?: ManagedBlockReference,
  legacy?: LegacySyncEvidence,
): Promise<void> {
  const attachment = getNotionLinkAttachment(item);
  if (!attachment) {
    throw new Error('Cannot save note sync state without a Notion link');
  }

  const syncedNotes = getSyncedNotesFromAttachment(attachment);
  if (syncedNotes.unsupportedFutureSchema) {
    throw new Error(
      `Cannot overwrite unsupported future Notero metadata schema v${syncedNotes.unsupportedFutureSchema.schemaVersion}`,
    );
  }
  if (syncedNotes.metadataCorrupt) {
    throw new Error('Cannot overwrite corrupt Notero synchronization metadata');
  }
  const { notes } = syncedNotes;
  updateNotionLinkAttachmentNote(attachment, {
    ...(container && { container }),
    containerBlockID,
    ...(syncedNotes.diagnostics && {
      diagnostics: syncedNotes.diagnostics,
    }),
    ...((legacy || syncedNotes.legacy) && {
      legacy: legacy || syncedNotes.legacy,
    }),
    notes: { ...notes, [noteItemKey]: note },
    ...(syncedNotes.preservedUnknown && {
      preservedUnknown: syncedNotes.preservedUnknown,
    }),
    schemaVersion: SYNCED_NOTES_SCHEMA_VERSION,
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
