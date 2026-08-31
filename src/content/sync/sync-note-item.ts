import type { Client } from '@notionhq/client';

import { getNotionPageID } from '../data/item-data';
import { LocalizableError } from '../errors';
import { logger } from '../utils/logger';

import type { HtmlConversionOptions } from './html-to-notion';
import { withNoteSyncLock } from './note-sync-lock';
import { CleanupWorkerV2 } from './note-sync-transaction/cleanup-worker-v4';
import { MainCoordinatorV2 } from './note-sync-transaction/coordinator-v4';
import { MainTransactionExecutorV2 } from './note-sync-transaction/executor-v4';
import {
  asLocalConnectionIdentity,
  asRemoteCreatorIdentity,
} from './note-sync-transaction/identity-v4';
import {
  QuarantinedMetadataError,
  ZoteroTransactionalMetadataStoreV4,
} from './note-sync-transaction/metadata-store-adapter';
import {
  createIdleRecordV4,
  createProcessSession,
  type RuntimeIdentityFactory,
} from './note-sync-transaction/model-v4';
import { NotionOperationAdapterV2 } from './note-sync-transaction/notion-operation-adapter-v4';
import {
  SYSTEM_RUNTIME_CLOCK,
  type RuntimeClock,
} from './note-sync-transaction/runtime-clock';
import {
  NoteSourceAdapter,
  type NoteSourceOptions,
} from './note-sync-transaction/source-adapter';
import type { TargetIdentity } from './note-sync-transaction/types-v4';
import { NotionImageUploadService } from './notion-image-upload-service';
import type { ChildBlock } from './notion-types';
import { getZoteroCrypto } from './zotero-web-api';

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
  remoteCreatorID?: string;
  runtimeClock?: RuntimeClock;
  runtimeIdentity?: RuntimeIdentityFactory;
  targetIdentityType?: 'legacy-local';
  uploadService?: NotionImageUploadService;
  workspaceID?: string;
};

/**
 * Synchronize one Zotero child note through the seven-state FSM v2. Parent and
 * note locks reduce local contention; the metadata store provides the actual
 * atomic compare-merge-write boundary inside Zotero.DB.executeTransaction().
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
  const remoteCreatorID = options.remoteCreatorID
    ? asRemoteCreatorIdentity(options.remoteCreatorID)
    : targetIdentity.identityType === 'legacy-local'
      ? undefined
      : asRemoteCreatorIdentity(targetIdentity.connectionID);
  const clock = options.runtimeClock || SYSTEM_RUNTIME_CLOCK;
  const identity =
    options.runtimeIdentity ||
    ({
      randomUUID: () => getZoteroCrypto().randomUUID(),
    } satisfies RuntimeIdentityFactory);
  const session = createProcessSession(clock, identity);
  const sourceOptions: NoteSourceOptions = {
    blockConverter: options.blockConverter,
    imageSyncEnabled: options.imageSyncEnabled === true,
    maxFileUploadSize: options.maxFileUploadSize,
    maxNoteImageCount: options.maxNoteImageCount,
    maxNoteImageTotalSize: options.maxNoteImageTotalSize,
    clock,
  };
  const source = await NoteSourceAdapter.create(
    noteItem,
    targetIdentity,
    sourceOptions,
  );
  const initial = createIdleRecordV4(targetIdentity, clock);
  const store = new ZoteroTransactionalMetadataStoreV4(
    parentItem,
    noteItem.key,
    initial,
    clock,
  );

  try {
    const loaded = await store.load();
    const coordinator = new MainCoordinatorV2(
      source.snapshot,
      targetIdentity,
      session,
      clock,
      identity,
      {
        legacyMigrationRequired: loaded.legacyMigrationRequired,
        remoteCreatorID,
        resumeHalted: true,
      },
    );
    const uploadService =
      options.uploadService ||
      new NotionImageUploadService(notion, { clock }, remoteCreatorID);
    const remote = new NotionOperationAdapterV2(
      notion,
      source,
      uploadService,
      clock,
    );
    const result = await new MainTransactionExecutorV2(
      store,
      coordinator,
      remote,
      session,
      clock,
      identity,
    ).runUntilStable();

    if (result.status === 'QUARANTINED') {
      const reason =
        result.snapshot.record.quarantineEvidence.at(-1)?.reasonCode ||
        'unknown evidence';
      throw new LocalizableError(
        `Note synchronization was quarantined: ${reason}`,
        'notero-error-note-recovery-required',
      );
    }
    if (result.status === 'HALTED') {
      const halt = result.snapshot.record.mainTransaction?.runHalt;
      throw new LocalizableError(
        `Note synchronization halted: ${halt?.classification || 'unknown classification'}`,
        'notero-error-note-recovery-required',
      );
    }
    if (
      result.status !== 'STABLE' ||
      result.snapshot.record.mainState !== 'IDLE'
    ) {
      throw new LocalizableError(
        'Note synchronization stopped at its bounded execution limit',
        'notero-error-note-recovery-required',
      );
    }
    try {
      const cleanup = await new CleanupWorkerV2(
        store,
        remote,
        session,
        clock,
        identity,
      ).runBounded();
      if (cleanup.errors.length) {
        logger.warn('Bounded note cleanup retained recoverable errors', {
          errorCount: cleanup.errors.length,
        });
      }
    } catch (error) {
      logger.warn(
        'Bounded note cleanup could not start; durable cleanup entries remain',
        error instanceof Error ? error.name : 'UnknownError',
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
    connectionID: asLocalConnectionIdentity(options.connectionID),
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
