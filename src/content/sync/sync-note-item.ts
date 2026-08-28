import {
  APIResponseError,
  RequestTimeoutError,
  type Client,
  isFullBlock,
} from '@notionhq/client';
import type {
  BlockObjectRequest,
  FileUploadObjectResponse,
} from '@notionhq/client/build/src/api-endpoints';

import {
  type ManagedBlockReference,
  type NoteSyncTransaction,
  type ProvisionalFileUpload,
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
  type EmbeddedImageReference,
  type HtmlConversionOptions,
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
  type BlockOwnershipIdentity,
  buildManagedHeadingRichText,
  createManagedBlockReference,
  createOwnershipMarker,
  hasExactOwnershipMarker,
  verifyManagedHeadingBlock,
} from './notion-block-ownership';
import {
  CREATE_ISOLATION_MS,
  JournalPersistenceError,
  type NotionTarget,
  RemoteWriteResultUncertainError,
  type UploadReconciliationCriteria,
  UploadReconciliationAmbiguousError,
  type UploadJournalHooks,
  NotionImageUploadService,
  isSameNotionTarget,
} from './notion-image-upload-service';
import { LIMITS } from './notion-limits';
import type { ChildBlock } from './notion-types';
import { getZoteroCrypto } from './zotero-web-api';

const STAGING_NOTE_TITLE = 'Notero sync in progress';
const MAX_CHILD_LIST_PAGES = 20;
const DEFAULT_MAX_NOTE_IMAGE_COUNT = 32;
const DEFAULT_MAX_NOTE_IMAGE_TOTAL_SIZE = 100 * 1024 * 1024;
const MAX_ORPHAN_CLEANUP_ATTEMPTS = 5;
const MAX_ORPHANS_PER_RECOVERY = 4;
const BLOCK_CREATE_ISOLATION_MS = 2 * 60 * 1000;
const LEGACY_MIGRATION_NOTICE =
  'Notero created new managed note copies and left all legacy synchronized blocks unchanged. Duplicate note content may remain until you manually review and remove the legacy blocks.';

type HeadingRequest = Extract<BlockObjectRequest, { heading_1: unknown }>;
type HeadingChildren = NonNullable<HeadingRequest['heading_1']['children']>;

type ImageUploader = {
  reconcileCreate?: (
    criteria: UploadReconciliationCriteria,
  ) => Promise<FileUploadObjectResponse | undefined>;
  retrieve?: (fileUploadID: string) => Promise<FileUploadObjectResponse>;
  sendCreated?: (
    image: ResolvedNoteImage,
    created: FileUploadObjectResponse,
    hooks?: UploadJournalHooks,
  ) => Promise<string>;
  upload: (
    image: ResolvedNoteImage,
    hooks?: UploadJournalHooks,
  ) => Promise<string>;
};

type ResolvedImageDescriptor = Omit<ResolvedNoteImage, 'bytes'> & {
  reference: EmbeddedImageReference;
};

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
  uploadService?: ImageUploader;
  workspaceID?: string;
};

class BlockDeleteUncertainError extends Error {
  public readonly name = 'BlockDeleteUncertainError';
}

class ManagedBlockUncertainError extends Error {
  public readonly name = 'ManagedBlockUncertainError';
}

/**
 * Synchronize one child note using an on-disk transaction journal and remotely
 * verifiable ownership markers. The shared parent metadata is protected by a
 * parent lock, while the nested note lock keeps the transaction identity clear.
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

  const target = getRequiredTarget(pageID, options);
  const syncedNotes = getSyncedNotes(regularItem);
  if (syncedNotes.unsupportedFutureSchema) {
    throw new LocalizableError(
      `Notero metadata schema v${syncedNotes.unsupportedFutureSchema.schemaVersion} requires a newer Notero version`,
      'notero-error-note-metadata-future',
    );
  }
  if (syncedNotes.metadataCorrupt) {
    throw new LocalizableError(
      'Cannot sync note because Notero metadata is corrupt',
      'notero-error-note-metadata-corrupt',
    );
  }

  let current = syncedNotes.notes?.[noteItem.key];
  let container = syncedNotes.container;
  let legacy = syncedNotes.legacy;
  if (current?.ownershipStatus === 'legacy-unverified') {
    legacy = {
      ...legacy,
      ...(syncedNotes.containerBlockID && {
        containerBlockID: syncedNotes.containerBlockID,
      }),
      ...(current.blockID && {
        noteBlockIDs: {
          ...legacy?.noteBlockIDs,
          [noteItem.key]: current.blockID,
        },
      }),
    };
    current = undefined;
  }
  const requiresLegacyMigration = Boolean(
    !container &&
    (legacy?.containerBlockID ||
      Object.keys(legacy?.noteBlockIDs || {}).length ||
      syncedNotes.containerBlockID),
  );
  if (container) {
    await retrieveAndVerifyManagedBlock(
      notion,
      container,
      containerIdentity(noteItem, target),
      pageID,
      'page_id',
    );
  }
  if (
    current?.blockID &&
    current.transaction?.stage !== 'old-delete-confirmed'
  ) {
    if (!container || !current.ownership) {
      throw ownershipError(
        'Legacy note ownership metadata cannot authorize changes to a Notion block',
      );
    }
    await retrieveAndVerifyManagedBlock(
      notion,
      current.ownership,
      noteIdentity(noteItem, target),
      container.blockID,
      'block_id',
    );
  }
  assertNoUnverifiedRecoveryReferences(current);

  const noteHTML = noteItem.getNote();
  const noteTitle = noteItem.getNoteTitle();
  const imageSyncEnabled =
    options.imageSyncEnabled ??
    Boolean(getNoteroPref(NoteroPref.syncNoteImages));
  const maxFileUploadSize = Math.min(
    options.maxFileUploadSize ?? MAX_DIRECT_UPLOAD_SIZE,
    MAX_DIRECT_UPLOAD_SIZE,
  );
  const descriptors = imageSyncEnabled
    ? await inspectEmbeddedImages(
        noteItem,
        noteHTML,
        maxFileUploadSize,
        options.maxNoteImageCount ?? DEFAULT_MAX_NOTE_IMAGE_COUNT,
        options.maxNoteImageTotalSize ?? DEFAULT_MAX_NOTE_IMAGE_TOTAL_SIZE,
      )
    : [];
  const sourceHash = await buildSourceHash(noteTitle, noteHTML, descriptors);

  if (current?.transaction) {
    const recovery = await recoverTransaction(
      notion,
      regularItem,
      noteItem,
      current,
      container,
      sourceHash,
      target,
      noteTitle,
      imageSyncEnabled,
    );
    current = recovery.current;
    container = recovery.container;
  }

  if (
    current?.blockID &&
    current.sourceHash === sourceHash &&
    !current.candidate &&
    !current.orphanBlocks?.length &&
    (!imageSyncEnabled || isSameNotionTarget(current.target, target))
  ) {
    return;
  }

  const attemptID = current?.transaction?.attemptID || randomUUID();
  let transaction: NoteSyncTransaction = current?.transaction || {
    attemptID,
    expectedImageCount: descriptors.length,
    resolvedImageCount: descriptors.length,
    sourceHash,
    stage: 'prepared',
    startedAt: new Date(),
    target,
    ...(container && { container }),
    ...(current?.ownership && { previous: current.ownership }),
  };

  const saveState = async (note: SyncedNote): Promise<void> => {
    try {
      await saveSyncedNoteRecord(
        regularItem,
        container?.blockID || '',
        noteItem.key,
        note,
        container,
        legacy,
      );
      current = note;
    } catch (error) {
      throw new JournalPersistenceError(
        'Unable to persist the note synchronization journal',
        note,
        { cause: error },
      );
    }
  };

  // The durable journal always precedes File Upload creation or block append.
  await saveState({ ...current, transaction });

  const uploadService =
    options.uploadService ||
    new NotionImageUploadService(notion, {}, target.connectionID);
  const prepared = imageSyncEnabled
    ? await prepareImagesSequentially(
        noteItem,
        descriptors,
        current,
        target,
        attemptID,
        maxFileUploadSize,
        uploadService,
        saveState,
      )
    : { imageMap: new Map<string, PreparedNotionImage>(), metadata: [] };
  transaction = { ...transaction, preparedImageCount: descriptors.length };
  await saveState({ ...current, transaction });

  const converter = options.blockConverter || convertHtmlToBlocks;
  const blocks = buildNoteBlocks(noteHTML, prepared.imageMap, converter);
  const renderedImageCount = countImageBlocks(blocks);
  assertImagePipelineComplete({
    discovered: descriptors.length,
    prepared: descriptors.length,
    rendered: renderedImageCount,
    resolved: descriptors.length,
  });
  transaction = { ...transaction, renderedImageCount };
  await saveState({ ...current, transaction });

  if (!container) {
    transaction = { ...transaction, stage: 'container-create-uncertain' };
    await saveState({ ...current, transaction });
    container = await createManagedHeadingBlock(
      notion,
      pageID,
      'page_id',
      'Zotero Notes',
      [createOwnershipMarker(containerIdentity(noteItem, target))],
      containerIdentity(noteItem, target),
      requiresLegacyMigration
        ? [
            {
              paragraph: {
                rich_text: [
                  { text: { content: LEGACY_MIGRATION_NOTICE }, type: 'text' },
                ],
              },
            },
          ]
        : undefined,
    );
    if (requiresLegacyMigration) {
      legacy = { ...legacy, migrationNoticeDisplayedAt: new Date() };
    }
    transaction = { ...transaction, container, stage: 'container-created' };
    await saveState({ ...current, transaction });
  }

  const stableIdentity = noteIdentity(noteItem, target);
  const candidateBlockIdentity = candidateIdentity(noteItem, target, attemptID);
  transaction = { ...transaction, stage: 'candidate-create-uncertain' };
  await saveState({ ...current, transaction });
  const candidateReference = await createManagedHeadingBlock(
    notion,
    container.blockID,
    'block_id',
    STAGING_NOTE_TITLE,
    [
      createOwnershipMarker(stableIdentity),
      createOwnershipMarker(candidateBlockIdentity),
    ],
    candidateBlockIdentity,
  );
  transaction = {
    ...transaction,
    candidate: candidateReference,
    stage: 'candidate-created',
  };
  await saveState({ ...current, transaction });

  try {
    const batches = buildBlockBatches(blocks);
    for (const [index, batch] of batches.entries()) {
      // Append is never replayed after an ambiguous response. Recovery deletes
      // the incomplete attempt by its independently reconstructed marker.
      await notion.blocks.children.append({
        block_id: candidateReference.blockID,
        children: batch,
      });
      transaction = {
        ...transaction,
        stage:
          index === batches.length - 1 ? 'content-complete' : 'content-partial',
      };
      await saveState({ ...current, transaction });
    }
    if (!batches.length) {
      transaction = { ...transaction, stage: 'content-complete' };
      await saveState({ ...current, transaction });
    }

    await retrieveAndVerifyManagedBlock(
      notion,
      candidateReference,
      candidateBlockIdentity,
      container.blockID,
      'block_id',
    );
    await updateManagedNoteHeading(
      notion,
      candidateReference.blockID,
      noteTitle,
      [
        createOwnershipMarker(stableIdentity),
        createOwnershipMarker(candidateBlockIdentity),
      ],
    );
    transaction = { ...transaction, stage: 'title-finalized' };
    const candidate: SyncedNoteCandidate = {
      attemptID,
      blockID: candidateReference.blockID,
      completedAt: new Date(),
      images: prepared.metadata,
      ownership: candidateReference,
      ownershipStatus: 'managed',
      ...(current?.blockID && { previousBlockID: current.blockID }),
      sourceHash,
      target,
    };
    await saveState({ ...current, candidate, transaction });
    transaction = { ...transaction, stage: 'candidate-persisted' };
    await saveState({ ...current, candidate, transaction });

    if (current?.blockID && current.ownership) {
      await retrieveAndVerifyManagedBlock(
        notion,
        candidateReference,
        candidateBlockIdentity,
        container.blockID,
        'block_id',
      );
      await deleteManagedBlockWithConfirmation(
        notion,
        current.ownership,
        stableIdentity,
        container.blockID,
      );
      transaction = { ...transaction, stage: 'old-delete-confirmed' };
      await saveState({ ...current, candidate, transaction });
    }

    await retrieveAndVerifyManagedBlock(
      notion,
      candidateReference,
      candidateBlockIdentity,
      container.blockID,
      'block_id',
    );
    await updateManagedNoteHeading(
      notion,
      candidateReference.blockID,
      noteTitle,
      [createOwnershipMarker(stableIdentity)],
    );
    await saveState(
      promoteCandidate(
        candidate,
        createManagedBlockReference(candidateReference.blockID, stableIdentity),
        imageSyncEnabled,
        current?.orphanBlocks,
        current?.unverifiedOrphanBlocks,
      ),
    );
  } catch (error) {
    if (
      transaction.stage !== 'candidate-persisted' &&
      transaction.stage !== 'old-delete-confirmed'
    ) {
      try {
        await deleteManagedBlockWithConfirmation(
          notion,
          candidateReference,
          candidateBlockIdentity,
          container.blockID,
        );
        await saveState({
          ...current,
          candidate: undefined,
          transaction: undefined,
        });
      } catch (cleanupError) {
        transaction = {
          ...transaction,
          orphanCleanupAttempts: (transaction.orphanCleanupAttempts || 0) + 1,
          stage: 'orphan-cleanup',
        };
        await saveState({
          ...current,
          orphanBlocks: uniqueManagedReferences([
            ...(current?.orphanBlocks || []),
            candidateReference,
          ]),
          transaction,
        });
        if (cleanupError instanceof JournalPersistenceError) {
          throw cleanupError;
        }
      }
    }
    throw error;
  }
}

function getRequiredTarget(
  pageID: string,
  options: NoteSyncOptions,
): NotionTarget {
  if (!options.connectionID || !options.databaseID || !options.workspaceID) {
    throw ownershipError(
      'Cannot verify block ownership without connection, database, and workspace identity',
    );
  }
  return {
    connectionID: options.connectionID,
    databaseID: options.databaseID,
    pageID,
    workspaceID: options.workspaceID,
  };
}

function containerIdentity(
  noteItem: Zotero.Item,
  target: NotionTarget,
): BlockOwnershipIdentity {
  return {
    kind: 'container',
    libraryID: noteItem.libraryID,
    parentItemKey: noteItem.topLevelItem.key,
    target,
  };
}

function noteIdentity(
  noteItem: Zotero.Item,
  target: NotionTarget,
): BlockOwnershipIdentity {
  return {
    kind: 'note',
    libraryID: noteItem.libraryID,
    noteItemKey: noteItem.key,
    parentItemKey: noteItem.topLevelItem.key,
    target,
  };
}

function candidateIdentity(
  noteItem: Zotero.Item,
  target: NotionTarget,
  attemptID: string,
): BlockOwnershipIdentity {
  return {
    attemptID,
    kind: 'candidate',
    libraryID: noteItem.libraryID,
    noteItemKey: noteItem.key,
    parentItemKey: noteItem.topLevelItem.key,
    target,
  };
}

function assertNoUnverifiedRecoveryReferences(
  current: SyncedNote | undefined,
): void {
  if (
    current?.candidate &&
    (!current.candidate.ownership || !current.transaction)
  ) {
    throw ownershipError(
      'Legacy candidate ownership metadata is unverified and has been isolated',
    );
  }
  if (current?.orphanBlockIDs?.length) {
    throw ownershipError(
      'Legacy orphan ownership metadata is unverified and has been isolated',
    );
  }
}

async function inspectEmbeddedImages(
  noteItem: Zotero.Item,
  noteHTML: string,
  maxFileUploadSize: number,
  maxImageCount: number,
  maxTotalSize: number,
): Promise<ResolvedImageDescriptor[]> {
  let references: EmbeddedImageReference[];
  try {
    references = findEmbeddedImages(noteHTML);
  } catch (error) {
    throw new LocalizableError(
      'Failed to parse embedded note images',
      'notero-error-note-conversion-failed',
      { cause: error },
    );
  }
  if (references.length > maxImageCount) {
    throw new LocalizableError(
      `Note has too many embedded images (${references.length}; limit ${maxImageCount})`,
      'notero-error-note-image-count-limit',
    );
  }

  const byKey = new Map<string, ResolvedImageDescriptor>();
  const inOrder: ResolvedImageDescriptor[] = [];
  let totalSize = 0;
  for (const reference of references) {
    if (!reference.attachmentKey) {
      throw new LocalizableError(
        'Embedded image is missing data-attachment-key',
        'notero-error-note-sync-failed',
      );
    }
    let descriptor = byKey.get(reference.attachmentKey);
    if (!descriptor) {
      const resolved = await resolveNoteImage(
        noteItem,
        reference,
        maxFileUploadSize,
      );
      const { bytes: _releasedBytes, ...withoutBytes } = resolved;
      descriptor = { ...withoutBytes, reference };
      byKey.set(reference.attachmentKey, descriptor);
    }
    totalSize += descriptor.size;
    if (totalSize > maxTotalSize) {
      throw new LocalizableError(
        `Note aggregate embedded image size exceeds ${maxTotalSize} bytes`,
        'notero-error-note-image-total-size-limit',
      );
    }
    inOrder.push({ ...descriptor, alt: reference.alt, reference });
  }
  return inOrder;
}

async function buildSourceHash(
  noteTitle: string,
  noteHTML: string,
  images: ResolvedImageDescriptor[],
): Promise<string> {
  const identity = images
    .map(({ attachmentKey, contentHash }) => `${attachmentKey}:${contentHash}`)
    .join('\n');
  return hashText(`${noteTitle}\u0000${noteHTML}\u0000${identity}`);
}

async function prepareImagesSequentially(
  noteItem: Zotero.Item,
  descriptors: ResolvedImageDescriptor[],
  current: SyncedNote | undefined,
  target: NotionTarget,
  attemptID: string,
  maxFileUploadSize: number,
  uploadService: ImageUploader,
  saveState: (note: SyncedNote) => Promise<void>,
): Promise<{
  imageMap: ReadonlyMap<string, PreparedNotionImage>;
  metadata: SyncedNoteImage[];
}> {
  const cache = new Map(
    (isSameNotionTarget(current?.target, target)
      ? current?.images || []
      : []
    ).map((image) => [`${image.attachmentKey}:${image.contentHash}`, image]),
  );
  let provisionalUploads = current?.provisionalUploads || [];
  const preparedByKey = new Map<string, PreparedNotionImage>();
  const metadataByKey = new Map<string, SyncedNoteImage>();

  for (const descriptor of descriptors) {
    if (preparedByKey.has(descriptor.attachmentKey)) continue;
    const cached = cache.get(
      `${descriptor.attachmentKey}:${descriptor.contentHash}`,
    );
    const filename = await buildDeterministicFilename(
      descriptor,
      noteItem,
      target,
    );
    const provisional = provisionalUploads.find((upload) =>
      isMatchingProvisionalUpload(
        upload,
        descriptor,
        filename,
        noteItem,
        target,
      ),
    );
    let fileUploadID = cached?.fileUploadID;
    if (
      !fileUploadID &&
      provisional &&
      isReusableProvisionalUpload(
        provisional,
        descriptor,
        filename,
        noteItem,
        target,
      )
    ) {
      fileUploadID = provisional.fileUploadID;
    }

    if (!fileUploadID && provisional) {
      const isolationDeadline =
        provisional.isolationDeadline || provisional.expiryTime;
      const notExpired =
        !isolationDeadline || isolationDeadline.getTime() > Date.now();
      if (
        provisional.status === 'create-uncertain' &&
        !provisional.fileUploadID
      ) {
        if (!uploadService.reconcileCreate) {
          throw recoveryError(
            'File upload creation remains uncertain and requires deterministic reconciliation',
          );
        }
        const match = await uploadService.reconcileCreate(
          provisionalReconciliationCriteria(provisional),
        );
        if (!match) {
          if (notExpired) {
            throw new RemoteWriteResultUncertainError(
              'File upload creation remains isolated after zero reconciliation matches',
              provisionalReconciliationCriteria(provisional),
            );
          }
          provisionalUploads = replaceProvisionalUpload(provisionalUploads, {
            ...provisional,
            status: 'expired',
          });
          await saveState({ ...current, provisionalUploads });
        } else {
          const reconciled = provisionalFromResponse(provisional, match);
          provisionalUploads = replaceProvisionalUpload(
            provisionalUploads,
            reconciled,
          );
          await saveState({ ...current, provisionalUploads });
          if (reconciled.status === 'uploaded') {
            fileUploadID = reconciled.fileUploadID;
          } else {
            throw recoveryError(
              'A reconciled upload is pending and must resume in a later synchronization',
            );
          }
        }
      }
      if (
        provisional.fileUploadID &&
        ['create-uncertain', 'pending', 'send-uncertain'].includes(
          provisional.status,
        ) &&
        notExpired
      ) {
        if (!uploadService.retrieve) {
          throw recoveryError(
            'A provisional file upload requires status reconciliation',
          );
        }
        let upload: FileUploadObjectResponse;
        try {
          upload = await uploadService.retrieve(provisional.fileUploadID);
        } catch (error) {
          throw new LocalizableError(
            'Unable to reconcile a provisional Notion file upload',
            'notero-error-note-recovery-required',
            { cause: error },
          );
        }
        const reconciled = provisionalFromResponse(provisional, upload);
        provisionalUploads = replaceProvisionalUpload(
          provisionalUploads,
          reconciled,
        );
        await saveState({ ...current, provisionalUploads });
        if (reconciled.status === 'uploaded') {
          fileUploadID = reconciled.fileUploadID;
        } else if (reconciled.status === 'pending') {
          throw recoveryError(
            'A provisional Notion file upload is still pending',
          );
        }
      }
    }

    if (!fileUploadID) {
      const pending = buildProvisionalUpload(
        descriptor,
        filename,
        noteItem,
        target,
        attemptID,
      );
      provisionalUploads = replaceProvisionalUpload(
        provisionalUploads,
        pending,
      );
      await saveState({ ...current, provisionalUploads });

      // Only one image byte buffer is live during upload. It is re-read after
      // preflight and its content hash must still match before any bytes leave.
      const resolved = await resolveNoteImage(
        noteItem,
        descriptor.reference,
        maxFileUploadSize,
      );
      if (resolved.contentHash !== descriptor.contentHash) {
        throw new Error('Embedded image changed during synchronization');
      }
      let journalEntry = pending;
      const hooks: UploadJournalHooks = {
        onCreateStarted: async (requestStartedAt, isolationDeadline) => {
          journalEntry = {
            ...pending,
            isolationDeadline,
            requestStartedAt,
            status: 'create-uncertain',
          };
          provisionalUploads = replaceProvisionalUpload(
            provisionalUploads,
            journalEntry,
          );
          await persistUploadJournal(
            saveState,
            current,
            provisionalUploads,
            journalEntry,
          );
        },
        onCreated: async (upload) => {
          journalEntry = provisionalFromResponse(pending, upload);
          provisionalUploads = replaceProvisionalUpload(
            provisionalUploads,
            journalEntry,
          );
          await persistUploadJournal(
            saveState,
            current,
            provisionalUploads,
            journalEntry,
          );
        },
        onSendStarted: async (upload) => {
          journalEntry = {
            ...provisionalFromResponse(pending, upload),
            status: 'send-uncertain',
          };
          provisionalUploads = replaceProvisionalUpload(
            provisionalUploads,
            journalEntry,
          );
          await persistUploadJournal(
            saveState,
            current,
            provisionalUploads,
            journalEntry,
          );
        },
        onStatus: async (upload) => {
          journalEntry = provisionalFromResponse(pending, upload);
          provisionalUploads = replaceProvisionalUpload(
            provisionalUploads,
            journalEntry,
          );
          await persistUploadJournal(
            saveState,
            current,
            provisionalUploads,
            journalEntry,
          );
        },
      };
      try {
        fileUploadID = await uploadService.upload(
          { ...resolved, filename },
          hooks,
        );
        journalEntry = {
          ...journalEntry,
          expiryTime:
            journalEntry.expiryTime || new Date(Date.now() + 55 * 60 * 1000),
          fileUploadID,
          status: 'uploaded',
        };
        provisionalUploads = replaceProvisionalUpload(
          provisionalUploads,
          journalEntry,
        );
        await saveState({ ...current, provisionalUploads });
      } catch (error) {
        if (
          error instanceof JournalPersistenceError ||
          error instanceof RemoteWriteResultUncertainError ||
          error instanceof UploadReconciliationAmbiguousError
        ) {
          throw error;
        }
        journalEntry = {
          ...journalEntry,
          status:
            journalEntry.status === 'expired' ||
            journalEntry.status === 'failed'
              ? journalEntry.status
              : isAmbiguousWriteError(error)
                ? 'create-uncertain'
                : 'failed',
        };
        provisionalUploads = replaceProvisionalUpload(
          provisionalUploads,
          journalEntry,
        );
        await saveState({ ...current, provisionalUploads });
        throw error;
      }
    }

    preparedByKey.set(descriptor.attachmentKey, { fileUploadID });
    metadataByKey.set(descriptor.attachmentKey, {
      attachmentKey: descriptor.attachmentKey,
      contentHash: descriptor.contentHash,
      contentType: descriptor.contentType,
      fileUploadID,
      filename,
      size: descriptor.size,
    });
  }

  return {
    imageMap: preparedByKey,
    metadata: Array.from(metadataByKey.values()),
  };
}

function buildProvisionalUpload(
  descriptor: ResolvedImageDescriptor,
  filename: string,
  noteItem: Zotero.Item,
  target: NotionTarget,
  attemptID: string,
): ProvisionalFileUpload {
  const requestStartedAt = new Date();
  return {
    attachmentKey: descriptor.attachmentKey,
    attemptID,
    contentHash: descriptor.contentHash,
    contentLength: descriptor.size,
    contentType: descriptor.contentType,
    filename,
    isolationDeadline: new Date(
      requestStartedAt.getTime() + CREATE_ISOLATION_MS,
    ),
    libraryID: noteItem.libraryID,
    noteItemKey: noteItem.key,
    parentItemKey: noteItem.topLevelItem.key,
    requestStartedAt,
    status: 'create-uncertain',
    target,
  };
}

function provisionalReconciliationCriteria(
  upload: ProvisionalFileUpload,
): UploadReconciliationCriteria {
  const requestStartedAt =
    upload.requestStartedAt || upload.createdAt || new Date(0);
  const isolationDeadline =
    upload.isolationDeadline ||
    upload.expiryTime ||
    new Date(requestStartedAt.getTime() + CREATE_ISOLATION_MS);
  return {
    connectionID: upload.target.connectionID,
    contentLength: upload.contentLength,
    contentType: upload.contentType,
    filename: upload.filename,
    isolationDeadline,
    requestStartedAt,
  };
}

async function persistUploadJournal(
  saveState: (note: SyncedNote) => Promise<void>,
  current: SyncedNote | undefined,
  provisionalUploads: ProvisionalFileUpload[],
  journalEntry: ProvisionalFileUpload,
): Promise<void> {
  try {
    await saveState({ ...current, provisionalUploads });
  } catch (error) {
    if (error instanceof JournalPersistenceError) {
      throw new JournalPersistenceError(
        'Unable to persist a remote file-upload result',
        journalEntry,
        { cause: error },
      );
    }
    throw error;
  }
}

function provisionalFromResponse(
  base: ProvisionalFileUpload,
  upload: FileUploadObjectResponse,
): ProvisionalFileUpload {
  const expiryTime = upload.expiry_time
    ? new Date(upload.expiry_time)
    : upload.expiry_time === null
      ? null
      : undefined;
  return {
    ...base,
    createdAt: new Date(upload.created_time),
    ...(expiryTime !== undefined && { expiryTime }),
    fileUploadID: upload.id,
    status:
      upload.status === 'uploaded'
        ? 'uploaded'
        : upload.status === 'failed'
          ? 'failed'
          : upload.status === 'expired'
            ? 'expired'
            : 'pending',
  };
}

function replaceProvisionalUpload(
  uploads: ProvisionalFileUpload[],
  replacement: ProvisionalFileUpload,
): ProvisionalFileUpload[] {
  const key = provisionalKey(replacement);
  return [
    ...uploads.filter((upload) => provisionalKey(upload) !== key),
    replacement,
  ].slice(-64);
}

function provisionalKey(upload: ProvisionalFileUpload): string {
  return [
    upload.target.connectionID,
    upload.target.workspaceID,
    upload.target.databaseID,
    upload.target.pageID,
    upload.libraryID,
    upload.parentItemKey,
    upload.noteItemKey,
    upload.attachmentKey,
    upload.contentHash,
  ].join(':');
}

function isReusableProvisionalUpload(
  upload: ProvisionalFileUpload,
  descriptor: ResolvedImageDescriptor,
  filename: string,
  noteItem: Zotero.Item,
  target: NotionTarget,
): boolean {
  return Boolean(
    upload.fileUploadID &&
    upload.status === 'uploaded' &&
    (!upload.expiryTime || upload.expiryTime.getTime() > Date.now()) &&
    isMatchingProvisionalUpload(upload, descriptor, filename, noteItem, target),
  );
}

function isMatchingProvisionalUpload(
  upload: ProvisionalFileUpload,
  descriptor: ResolvedImageDescriptor,
  filename: string,
  noteItem: Zotero.Item,
  target: NotionTarget,
): boolean {
  return (
    isSameNotionTarget(upload.target, target) &&
    upload.libraryID === noteItem.libraryID &&
    upload.parentItemKey === noteItem.topLevelItem.key &&
    upload.noteItemKey === noteItem.key &&
    upload.attachmentKey === descriptor.attachmentKey &&
    upload.contentHash === descriptor.contentHash &&
    upload.contentLength === descriptor.size &&
    upload.contentType === descriptor.contentType &&
    upload.filename === filename
  );
}

async function buildDeterministicFilename(
  descriptor: ResolvedImageDescriptor,
  noteItem: Zotero.Item,
  target: NotionTarget,
): Promise<string> {
  const extension = /\.[a-z0-9]+$/i.exec(descriptor.filename)?.[0] || '';
  const identityHash = await hashText(
    [
      target.connectionID,
      target.workspaceID,
      target.databaseID,
      target.pageID,
      noteItem.libraryID,
      noteItem.topLevelItem.key,
      noteItem.key,
      descriptor.attachmentKey,
      descriptor.contentHash,
      descriptor.contentType,
      descriptor.size,
    ].join('\u0000'),
  );
  return `notero-${identityHash.slice(0, 40)}${extension}`;
}

function buildNoteBlocks(
  noteHTML: string,
  images: ReadonlyMap<string, PreparedNotionImage>,
  converter: (html: string, options?: HtmlConversionOptions) => ChildBlock[],
): ChildBlock[] {
  try {
    return converter(noteHTML, images.size ? { images } : {});
  } catch (error) {
    throw new LocalizableError(
      'Failed to convert note content to Notion blocks',
      'notero-error-note-conversion-failed',
      { cause: error },
    );
  }
}

export function assertImagePipelineComplete(counts: {
  discovered: number;
  prepared: number;
  rendered: number;
  resolved: number;
}): void {
  if (
    counts.discovered !== counts.resolved ||
    counts.discovered !== counts.prepared ||
    counts.discovered !== counts.rendered
  ) {
    throw new Error(
      `Embedded image pipeline is incomplete: discovered=${counts.discovered}, resolved=${counts.resolved}, prepared=${counts.prepared}, rendered=${counts.rendered}`,
    );
  }
}

function countImageBlocks(blocks: ChildBlock[]): number {
  return blocks.reduce((total, block) => total + countImagesInValue(block), 0);
}

function countImagesInValue(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (total, child) => total + countImagesInValue(child),
      0,
    );
  }
  const ownImage =
    ('type' in value && value.type === 'image') || 'image' in value ? 1 : 0;
  return (
    ownImage +
    Object.entries(value).reduce(
      (total, [key, child]) =>
        total + (key === 'image' ? 0 : countImagesInValue(child)),
      0,
    )
  );
}

async function createManagedHeadingBlock(
  notion: Client,
  parentID: string,
  parentType: 'block_id' | 'page_id',
  title: string,
  markers: string[],
  identity: BlockOwnershipIdentity,
  children?: HeadingChildren,
): Promise<ManagedBlockReference> {
  const marker = createOwnershipMarker(identity);
  try {
    const response = await notion.blocks.children.append({
      block_id: parentID,
      children: [
        {
          heading_1: {
            ...(children?.length && { children }),
            is_toggleable: true,
            rich_text: buildManagedHeadingRichText(title, markers),
          },
        },
      ],
    });
    const block = response.results[0];
    if (!block) throw new Error('Notion returned no created block');
    const reference = createManagedBlockReference(block.id, identity);
    const verification = verifyManagedHeadingBlock(block, reference, {
      connectionID: identity.target.connectionID,
      marker,
      parentID,
      parentType,
    });
    if (!verification.verified) {
      throw new ManagedBlockUncertainError(
        `Created block ownership could not be verified: ${verification.reason}`,
      );
    }
    return reference;
  } catch (error) {
    if (!isAmbiguousWriteError(error)) throw error;
    const matches = await findManagedChildren(notion, parentID, marker);
    if (matches.length !== 1) {
      throw new ManagedBlockUncertainError(
        `Managed block creation is uncertain; found ${matches.length} marker matches`,
        { cause: error },
      );
    }
    const match = matches[0];
    if (!match)
      throw new ManagedBlockUncertainError('Recovered block is missing');
    const reference = createManagedBlockReference(match.id, identity);
    const verification = verifyManagedHeadingBlock(match, reference, {
      connectionID: identity.target.connectionID,
      marker,
      parentID,
      parentType,
    });
    if (!verification.verified) {
      throw new ManagedBlockUncertainError(
        `Recovered block ownership could not be verified: ${verification.reason}`,
        { cause: error },
      );
    }
    return reference;
  }
}

async function findManagedChildren(
  notion: Client,
  parentID: string,
  marker: string,
) {
  const matches: Parameters<typeof isFullBlock>[0][] = [];
  let startCursor: string | undefined;
  for (let page = 0; page < MAX_CHILD_LIST_PAGES; page += 1) {
    const response = await notion.blocks.children.list({
      block_id: parentID,
      page_size: 100,
      ...(startCursor && { start_cursor: startCursor }),
    });
    for (const block of response.results) {
      if (
        isFullBlock(block) &&
        block.type === 'heading_1' &&
        hasExactOwnershipMarker(block.heading_1.rich_text, marker)
      ) {
        matches.push(block);
      }
    }
    if (!response.has_more) return matches;
    if (!response.next_cursor) {
      throw new Error('Notion child block pagination cursor is missing');
    }
    startCursor = response.next_cursor;
  }
  throw new Error('Notion child block recovery exceeded its page limit');
}

async function updateManagedNoteHeading(
  notion: Client,
  blockID: string,
  title: string,
  markers: string[],
): Promise<void> {
  await notion.blocks.update({
    block_id: blockID,
    heading_1: {
      is_toggleable: true,
      rich_text: buildManagedHeadingRichText(title, markers),
    },
  });
}

async function retrieveAndVerifyManagedBlock(
  notion: Client,
  reference: ManagedBlockReference,
  identity: BlockOwnershipIdentity,
  parentID: string,
  parentType: 'block_id' | 'page_id',
  allowTrashed = false,
) {
  const expectedMarker = createOwnershipMarker(identity);
  if (
    reference.kind !== identity.kind ||
    reference.marker !== expectedMarker ||
    reference.attemptID !== identity.attemptID
  ) {
    throw ownershipError(
      'Managed block metadata does not match this Zotero note identity',
    );
  }
  let block;
  try {
    block = await notion.blocks.retrieve({ block_id: reference.blockID });
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new ManagedBlockUncertainError(
        'Notion returned 404; the managed block may be hidden by permissions',
        { cause: error },
      );
    }
    throw error;
  }
  const verification = verifyManagedHeadingBlock(block, reference, {
    connectionID: identity.target.connectionID,
    allowTrashed,
    marker: expectedMarker,
    parentID,
    parentType,
  });
  if (!verification.verified) throw ownershipError(verification.reason);
  return block;
}

async function deleteManagedBlockWithConfirmation(
  notion: Client,
  reference: ManagedBlockReference,
  identity: BlockOwnershipIdentity,
  parentID: string,
): Promise<void> {
  const existing = await retrieveAndVerifyManagedBlock(
    notion,
    reference,
    identity,
    parentID,
    'block_id',
    true,
  );
  if (isFullBlock(existing) && (existing.in_trash || existing.archived)) return;
  try {
    const deleted = await notion.blocks.delete({ block_id: reference.blockID });
    if (
      !isFullBlock(deleted) ||
      deleted.id !== reference.blockID ||
      !deleted.in_trash
    ) {
      throw new BlockDeleteUncertainError(
        'Notion block deletion did not return an in_trash=true confirmation',
      );
    }
  } catch (error) {
    if (error instanceof BlockDeleteUncertainError) throw error;
    if (isAmbiguousWriteError(error) || isNotFoundError(error)) {
      // A follow-up 404 cannot distinguish deletion from permission hiding.
      try {
        await notion.blocks.retrieve({ block_id: reference.blockID });
      } catch {
        // Diagnostic only; the mutation remains uncertain.
      }
      throw new BlockDeleteUncertainError(
        'Unable to determine whether Notion block deletion completed',
        { cause: error },
      );
    }
    throw error;
  }
}

async function recoverTransaction(
  notion: Client,
  regularItem: Zotero.Item,
  noteItem: Zotero.Item,
  current: SyncedNote,
  container: ManagedBlockReference | undefined,
  sourceHash: string,
  target: NotionTarget,
  noteTitle: string,
  imageSyncEnabled: boolean,
): Promise<{ current: SyncedNote; container?: ManagedBlockReference }> {
  const transaction = current.transaction;
  if (!transaction) return { current, container };
  if (!isSameNotionTarget(transaction.target, target)) {
    throw recoveryError(
      'A pending transaction belongs to another Notion target',
    );
  }
  const sourceChanged = transaction.sourceHash !== sourceHash;
  const saveRecovered = async (note: SyncedNote): Promise<void> => {
    await saveSyncedNoteRecord(
      regularItem,
      container?.blockID || '',
      noteItem.key,
      note,
      container,
    );
  };
  if (
    transaction.stage === 'prepared' &&
    !transaction.container &&
    !transaction.candidate
  ) {
    if (sourceChanged) {
      const recovered = { ...current, transaction: undefined };
      await saveRecovered(recovered);
      return { container, current: recovered };
    }
    return { current, container };
  }
  if (
    !transaction.container &&
    transaction.stage !== 'container-create-uncertain'
  ) {
    throw recoveryError(
      'Pending transaction has no verifiable container ownership',
    );
  }

  if (!container && transaction.stage === 'container-create-uncertain') {
    const identity = containerIdentity(noteItem, target);
    const matches = await findManagedChildren(
      notion,
      target.pageID,
      createOwnershipMarker(identity),
    );
    if (
      sourceChanged &&
      matches.length === 0 &&
      Date.now() - transaction.startedAt.getTime() >= BLOCK_CREATE_ISOLATION_MS
    ) {
      const recovered = { ...current, transaction: undefined };
      await saveRecovered(recovered);
      return { container, current: recovered };
    }
    if (matches.length !== 1) {
      throw recoveryError(
        `Container creation cannot be reconciled safely (${matches.length} matches)`,
      );
    }
    const match = matches[0];
    if (!match) throw recoveryError('Recovered container match is missing');
    container = createManagedBlockReference(match.id, identity);
  }
  const transactionContainer = transaction.container || container;
  if (
    !transactionContainer ||
    !container ||
    transactionContainer.blockID !== container.blockID
  ) {
    throw recoveryError(
      'Pending transaction container does not match the canonical container',
    );
  }
  await retrieveAndVerifyManagedBlock(
    notion,
    container,
    containerIdentity(noteItem, target),
    target.pageID,
    'page_id',
  );

  if (transaction.stage === 'orphan-cleanup') {
    const attempts = transaction.orphanCleanupAttempts || 0;
    if (attempts >= MAX_ORPHAN_CLEANUP_ATTEMPTS) {
      const recovered: SyncedNote = {
        ...current,
        orphanBlocks: undefined,
        transaction: undefined,
        unverifiedOrphanBlocks: uniqueManagedReferences([
          ...(current.unverifiedOrphanBlocks || []),
          ...(current.orphanBlocks || []),
        ]),
      };
      await saveRecovered(recovered);
      return { container, current: recovered };
    }
    let remaining = current.orphanBlocks || [];
    for (const orphan of remaining.slice(0, MAX_ORPHANS_PER_RECOVERY)) {
      const identity =
        orphan.kind === 'candidate' && orphan.attemptID
          ? candidateIdentity(noteItem, target, orphan.attemptID)
          : orphan.kind === 'note'
            ? noteIdentity(noteItem, target)
            : undefined;
      if (!identity) {
        throw recoveryError('Orphan cleanup ownership metadata is incomplete');
      }
      try {
        await deleteManagedBlockWithConfirmation(
          notion,
          orphan,
          identity,
          container.blockID,
        );
      } catch {
        const pending: SyncedNote = {
          ...current,
          orphanBlocks: remaining,
          transaction: {
            ...transaction,
            orphanCleanupAttempts: attempts + 1,
          },
        };
        await saveRecovered(pending);
        throw recoveryError(
          `Managed orphan cleanup remains incomplete after ${attempts + 1} attempts`,
        );
      }
      remaining = remaining.filter(({ blockID }) => blockID !== orphan.blockID);
      await saveRecovered({ ...current, orphanBlocks: remaining, transaction });
    }
    if (remaining.length) {
      throw recoveryError(
        'Managed orphan cleanup will continue in a later sync',
      );
    }
    const recovered: SyncedNote = {
      ...current,
      orphanBlocks: undefined,
      transaction: undefined,
    };
    await saveRecovered(recovered);
    return { container, current: recovered };
  }

  if (sourceChanged) {
    return recoverSupersededTransaction(
      notion,
      noteItem,
      current,
      container,
      saveRecovered,
    );
  }

  if (!transaction.candidate) {
    if (transaction.stage === 'container-create-uncertain') {
      const resumed: SyncedNote = {
        ...current,
        transaction: {
          ...transaction,
          container,
          stage: 'container-created',
        },
      };
      await saveRecovered(resumed);
      return { container, current: resumed };
    }
    if (transaction.stage === 'container-created') {
      return { container, current };
    }
    if (transaction.stage === 'candidate-create-uncertain') {
      const identity = candidateIdentity(
        noteItem,
        target,
        transaction.attemptID,
      );
      const matches = await findManagedChildren(
        notion,
        container.blockID,
        createOwnershipMarker(identity),
      );
      if (matches.length !== 1) {
        throw recoveryError(
          `Candidate creation cannot be reconciled safely (${matches.length} matches)`,
        );
      }
      const match = matches[0];
      if (!match) throw recoveryError('Recovered candidate match is missing');
      const recoveredCandidate = createManagedBlockReference(
        match.id,
        identity,
      );
      await retrieveAndVerifyManagedBlock(
        notion,
        recoveredCandidate,
        identity,
        container.blockID,
        'block_id',
      );
      await deleteManagedBlockWithConfirmation(
        notion,
        recoveredCandidate,
        identity,
        container.blockID,
      );
      const recovered: SyncedNote = {
        ...current,
        candidate: undefined,
        transaction: undefined,
      };
      await saveRecovered(recovered);
      throw recoveryError(
        'An ambiguously created candidate was removed; retry synchronization',
      );
    }
    throw recoveryError(
      'Pending transaction has no verifiable candidate ownership',
    );
  }

  const attemptIdentity = candidateIdentity(
    noteItem,
    target,
    transaction.attemptID,
  );
  let hasAttemptMarker = true;
  try {
    await retrieveAndVerifyManagedBlock(
      notion,
      transaction.candidate,
      attemptIdentity,
      container.blockID,
      'block_id',
    );
  } catch (error) {
    if (transaction.stage !== 'old-delete-confirmed') throw error;
    hasAttemptMarker = false;
    const stableIdentity = noteIdentity(noteItem, target);
    await retrieveAndVerifyManagedBlock(
      notion,
      createManagedBlockReference(
        transaction.candidate.blockID,
        stableIdentity,
      ),
      stableIdentity,
      container.blockID,
      'block_id',
    );
  }

  if (
    [
      'candidate-created',
      'content-partial',
      'content-complete',
      'title-finalized',
    ].includes(transaction.stage)
  ) {
    await deleteManagedBlockWithConfirmation(
      notion,
      transaction.candidate,
      attemptIdentity,
      container.blockID,
    );
    const recovered: SyncedNote = {
      ...current,
      candidate: undefined,
      transaction: undefined,
    };
    await saveRecovered(recovered);
    throw recoveryError(
      'An incomplete candidate was removed; retry synchronization',
    );
  }

  const candidate = current.candidate;
  if (
    !candidate ||
    candidate.ownership?.blockID !== transaction.candidate.blockID
  ) {
    throw recoveryError('Complete candidate recovery metadata is missing');
  }
  assertImagePipelineComplete({
    discovered: transaction.expectedImageCount || 0,
    prepared: transaction.preparedImageCount || 0,
    rendered: transaction.renderedImageCount || 0,
    resolved: transaction.resolvedImageCount || 0,
  });

  let recoveredTransaction = transaction;
  if (transaction.stage === 'candidate-persisted' && transaction.previous) {
    await deleteManagedBlockWithConfirmation(
      notion,
      transaction.previous,
      noteIdentity(noteItem, target),
      container.blockID,
    );
    recoveredTransaction = {
      ...transaction,
      stage: 'old-delete-confirmed',
    };
    await saveRecovered({ ...current, transaction: recoveredTransaction });
  }
  if (
    recoveredTransaction.stage !== 'candidate-persisted' &&
    recoveredTransaction.stage !== 'old-delete-confirmed'
  ) {
    throw recoveryError(
      `Unsupported transaction recovery stage: ${transaction.stage}`,
    );
  }
  if (hasAttemptMarker) {
    await updateManagedNoteHeading(notion, candidate.blockID, noteTitle, [
      createOwnershipMarker(noteIdentity(noteItem, target)),
    ]);
  }
  const promoted = promoteCandidate(
    candidate,
    createManagedBlockReference(
      candidate.blockID,
      noteIdentity(noteItem, target),
    ),
    imageSyncEnabled,
    current.orphanBlocks,
    current.unverifiedOrphanBlocks,
  );
  await saveRecovered(promoted);
  return { container, current: promoted };
}

async function recoverSupersededTransaction(
  notion: Client,
  noteItem: Zotero.Item,
  current: SyncedNote,
  container: ManagedBlockReference,
  saveRecovered: (note: SyncedNote) => Promise<void>,
): Promise<{ current: SyncedNote; container: ManagedBlockReference }> {
  const transaction = current.transaction;
  if (!transaction) return { container, current };
  let candidate = transaction.candidate;
  if (!candidate && transaction.stage === 'candidate-create-uncertain') {
    const identity = candidateIdentity(
      noteItem,
      transaction.target,
      transaction.attemptID,
    );
    const matches = await findManagedChildren(
      notion,
      container.blockID,
      createOwnershipMarker(identity),
    );
    if (!matches.length) {
      if (
        Date.now() - transaction.startedAt.getTime() <
        BLOCK_CREATE_ISOLATION_MS
      ) {
        throw recoveryError(
          'The superseded candidate create remains in its isolation window',
        );
      }
    } else {
      const orphans = matches.map((block) =>
        createManagedBlockReference(block.id, identity),
      );
      const pending: SyncedNote = {
        ...current,
        orphanBlocks: uniqueManagedReferences([
          ...(current.orphanBlocks || []),
          ...orphans,
        ]),
        transaction: {
          ...transaction,
          candidate: orphans[0],
          orphanCleanupAttempts: 0,
          stage: 'orphan-cleanup',
        },
      };
      await saveRecovered(pending);
      throw recoveryError(
        'The superseded candidate was isolated for bounded cleanup',
      );
    }
  }
  if (candidate) {
    const identity = candidateIdentity(
      noteItem,
      transaction.target,
      transaction.attemptID,
    );
    try {
      await deleteManagedBlockWithConfirmation(
        notion,
        candidate,
        identity,
        container.blockID,
      );
    } catch {
      const pending: SyncedNote = {
        ...current,
        orphanBlocks: uniqueManagedReferences([
          ...(current.orphanBlocks || []),
          candidate,
        ]),
        transaction: {
          ...transaction,
          orphanCleanupAttempts: (transaction.orphanCleanupAttempts || 0) + 1,
          stage: 'orphan-cleanup',
        },
      };
      await saveRecovered(pending);
      throw recoveryError(
        'The superseded candidate was isolated for bounded cleanup',
      );
    }
  }
  const oldActiveWasDeleted = transaction.stage === 'old-delete-confirmed';
  const recovered: SyncedNote = {
    ...current,
    ...(oldActiveWasDeleted && {
      blockID: undefined,
      ownership: undefined,
      ownershipStatus: undefined,
      sourceHash: undefined,
    }),
    candidate: undefined,
    transaction: undefined,
  };
  await saveRecovered(recovered);
  return { container, current: recovered };
}

function promoteCandidate(
  candidate: SyncedNoteCandidate,
  ownership: ManagedBlockReference,
  imageSyncEnabled: boolean,
  orphanBlocks?: ManagedBlockReference[],
  unverifiedOrphanBlocks?: ManagedBlockReference[],
): SyncedNote {
  return {
    blockID: candidate.blockID,
    ...(imageSyncEnabled && {
      images: candidate.images,
      target: candidate.target,
    }),
    ...(orphanBlocks?.length && { orphanBlocks }),
    ...(unverifiedOrphanBlocks?.length && { unverifiedOrphanBlocks }),
    ownership,
    ownershipStatus: 'managed',
    sourceHash: candidate.sourceHash,
    syncedAt: new Date(),
  };
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

function uniqueManagedReferences(
  references: ManagedBlockReference[],
): ManagedBlockReference[] {
  return Array.from(
    new Map(
      references.map((reference) => [reference.blockID, reference]),
    ).values(),
  ).slice(-20);
}

function randomUUID(): string {
  return getZoteroCrypto().randomUUID();
}

function isAmbiguousWriteError(error: unknown): boolean {
  if (
    RequestTimeoutError.isRequestTimeoutError(error) ||
    error instanceof TypeError
  ) {
    return true;
  }
  return (
    error instanceof APIResponseError &&
    [409, 429, 500, 502, 503, 504, 529].includes(error.status)
  );
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof APIResponseError && error.status === 404;
}

function ownershipError(message: string): LocalizableError {
  return new LocalizableError(
    message,
    'notero-error-note-ownership-unverified',
  );
}

function recoveryError(message: string): LocalizableError {
  return new LocalizableError(message, 'notero-error-note-recovery-required');
}
