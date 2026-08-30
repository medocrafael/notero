import type { Client } from '@notionhq/client';

import { getNotionPageID } from '../data/item-data';
import { LocalizableError } from '../errors';

import type { HtmlConversionOptions } from './html-to-notion';
import { withNoteSyncLock } from './note-sync-lock';
import { NoteTransactionCoordinator } from './note-sync-transaction/coordinator';
import { NoteSyncTransactionExecutor } from './note-sync-transaction/executor';
import {
  QuarantinedMetadataError,
  ZoteroMetadataStoreAdapter,
} from './note-sync-transaction/metadata-store-adapter';
import { createIdleRecord } from './note-sync-transaction/model';
import { NotionOperationAdapter } from './note-sync-transaction/notion-operation-adapter';
import {
  NoteSourceAdapter,
  type NoteSourceOptions,
} from './note-sync-transaction/source-adapter';
import type { TargetIdentity } from './note-sync-transaction/types';
import { NotionImageUploadService } from './notion-image-upload-service';
import type { ChildBlock } from './notion-types';

export type NoteSyncOptions = {
  blockConverter?: (
    html: string,
    options?: HtmlConversionOptions,
  ) => ChildBlock[];
  connectionID?: string;
  databaseID?: string;
  imageSyncEnabled?: boolean;
  maxFileUploadSize?: number;
  maxNoteImageCount?: number;
  maxNoteImageTotalSize?: number;
  targetIdentityType?: 'legacy-local';
  uploadService?: NotionImageUploadService;
  workspaceID?: string;
};

/**
 * Synchronize one Zotero child note through the explicit v3 transaction state
 * machine. The parent and note locks protect the single metadata CAS boundary;
 * all remote mutations are planned and durably journaled by the executor.
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

  const parentItem = noteItem.topLevelItem;
  await withNoteSyncLock(noteItem.libraryID, `parent:${parentItem.key}`, () =>
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
  const parentItem = noteItem.topLevelItem;
  const pageID = getNotionPageID(parentItem);
  if (!pageID) {
    throw new LocalizableError(
      'Cannot sync note because its parent item is not synced',
      'notero-error-note-parent-not-synced',
    );
  }

  const targetIdentity = getRequiredTarget(noteItem, pageID, options);
  const sourceOptions: NoteSourceOptions = {
    blockConverter: options.blockConverter,
    imageSyncEnabled: options.imageSyncEnabled === true,
    maxFileUploadSize: options.maxFileUploadSize,
    maxNoteImageCount: options.maxNoteImageCount,
    maxNoteImageTotalSize: options.maxNoteImageTotalSize,
  };
  const source = await NoteSourceAdapter.create(
    noteItem,
    targetIdentity,
    sourceOptions,
  );
  const initial = createIdleRecord(
    targetIdentity,
    source.snapshot.featurePolicy,
    new Date().toISOString(),
  );
  const store = new ZoteroMetadataStoreAdapter(
    parentItem,
    noteItem.key,
    initial,
  );

  try {
    const coordinator = new NoteTransactionCoordinator(
      source,
      targetIdentity,
      store.hasLegacyEvidence(),
    );
    const uploadService =
      options.uploadService ||
      new NotionImageUploadService(notion, {}, targetIdentity.connectionID);
    const remote = new NotionOperationAdapter(notion, source, uploadService);
    const result = await new NoteSyncTransactionExecutor(
      store,
      remote,
    ).runUntilStable(coordinator.selector());

    if (result.state === 'QUARANTINED') {
      const reason = result.quarantine.at(-1)?.message || 'unknown evidence';
      throw new LocalizableError(
        `Note synchronization was quarantined: ${reason}`,
        'notero-error-note-recovery-required',
      );
    }
    if (result.operationIntent?.phase === 'UNCERTAIN') {
      throw new LocalizableError(
        `Notion operation ${result.operationIntent.kind} remains uncertain; retry only after reconciliation`,
        'notero-error-note-recovery-required',
      );
    }
  } catch (error) {
    if (error instanceof QuarantinedMetadataError) {
      throw new LocalizableError(
        error.message,
        'notero-error-note-metadata-corrupt',
      );
    }
    throw error;
  }
}

function getRequiredTarget(
  noteItem: Zotero.Item,
  pageID: string,
  options: NoteSyncOptions,
): TargetIdentity {
  if (!options.connectionID || !options.databaseID || !options.workspaceID) {
    throw new LocalizableError(
      'Cannot verify block ownership without connection, database, and workspace identity',
      'notero-error-note-recovery-required',
    );
  }
  return {
    connectionID: options.connectionID,
    databaseID: options.databaseID,
    ...(options.targetIdentityType && {
      identityType: options.targetIdentityType,
    }),
    libraryID: noteItem.libraryID,
    noteItemKey: noteItem.key,
    pageID,
    parentItemKey: noteItem.topLevelItem.key,
    workspaceID: options.workspaceID,
  };
}
