import {
  APIErrorCode,
  RequestTimeoutError,
  type Client,
} from '@notionhq/client';
import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { createZoteroItemMock, zoteroMock } from '../../../../test/utils';
import {
  type LegacySyncEvidence,
  type SyncedNote,
  type SyncedNotes,
  getNotionPageID,
  getSyncedNotes,
  saveSyncedNoteRecord,
} from '../../data/item-data';
import {
  type BlockOwnershipIdentity,
  buildManagedHeadingRichText,
  createManagedBlockReference,
} from '../notion-block-ownership';
import {
  JournalPersistenceError,
  RemoteWriteResultUncertainError,
  UploadReconciliationAmbiguousError,
} from '../notion-image-upload-service';
import type { NotionTarget } from '../notion-image-upload-service';
import type { ChildBlock } from '../notion-types';
import { syncNoteItem } from '../sync-note-item';

import { validPngBytes } from './fixtures/image-fixtures';
import {
  DurableMetadataStore,
  StatefulNotionServer,
  notionError,
} from './stateful-notion-fake';

type HeadingRequest = Extract<BlockObjectRequest, { heading_1: unknown }>;

vi.mock('../../data/item-data');

const target = {
  connectionID: 'bot-a',
  databaseID: 'database-a',
  pageID: 'page-a',
  workspaceID: 'workspace-a',
};

type Harness = ReturnType<typeof createHarness>;

function createHarness(
  noteHTML = '<div><p>Synthetic text</p></div>',
  harnessTarget: NotionTarget = target,
): {
  failJournalOnce: (predicate: (note: SyncedNote) => boolean) => void;
  noteItem: Zotero.Item;
  regularItem: Zotero.Item;
  restart: () => Client;
  server: StatefulNotionServer;
  store: DurableMetadataStore<SyncedNotes>;
  target: NotionTarget;
} {
  const regularItem = createZoteroItemMock({ libraryID: 1 });
  const noteItem = createZoteroItemMock({ libraryID: 1 });
  noteItem.isTopLevelItem.mockReturnValue(false);
  noteItem.topLevelItem = regularItem;
  noteItem.getNote.mockReturnValue(noteHTML);
  noteItem.getNoteTitle.mockReturnValue('Synthetic note');

  const server = new StatefulNotionServer(
    harnessTarget.connectionID,
    harnessTarget.pageID,
  );
  const store = new DurableMetadataStore<SyncedNotes>(
    JSON.stringify({ notes: {}, schemaVersion: 2 }),
  );
  let journalFailure: ((note: SyncedNote) => boolean) | undefined;

  vi.mocked(getNotionPageID).mockReturnValue(harnessTarget.pageID);
  vi.mocked(getSyncedNotes).mockImplementation(() => store.read());
  vi.mocked(saveSyncedNoteRecord).mockImplementation(
    async (_item, containerBlockID, noteItemKey, note, container, legacy) => {
      if (journalFailure?.(note)) {
        journalFailure = undefined;
        throw new Error('Synthetic durable journal failure');
      }
      const current = store.read();
      store.write({
        ...(container && { container }),
        containerBlockID,
        ...(legacy || current.legacy
          ? { legacy: legacy || current.legacy }
          : {}),
        notes: { ...current.notes, [noteItemKey]: note },
        schemaVersion: 2,
      });
    },
  );

  return {
    failJournalOnce: (predicate) => {
      journalFailure = predicate;
    },
    noteItem,
    regularItem,
    restart: () => server.client(),
    server,
    store,
    target: harnessTarget,
  };
}

function identity(
  harness: Harness,
  kind: BlockOwnershipIdentity['kind'],
  attemptID?: string,
): BlockOwnershipIdentity {
  return {
    ...(attemptID && { attemptID }),
    kind,
    libraryID: harness.noteItem.libraryID,
    ...(kind !== 'container' && { noteItemKey: harness.noteItem.key }),
    parentItemKey: harness.regularItem.key,
    target: harness.target,
  };
}

function headingRequest(title: string, markers: string[]): HeadingRequest {
  return {
    heading_1: {
      is_toggleable: true,
      rich_text: buildManagedHeadingRichText(title, markers),
    },
  };
}

function seedManagedActive(
  harness: Harness,
  sourceHash: string,
): { activeID: string; containerID: string } {
  const containerID = `container-${harness.regularItem.key}`;
  const activeID = `active-${harness.noteItem.key}`;
  const container = createManagedBlockReference(
    containerID,
    identity(harness, 'container'),
  );
  const ownership = createManagedBlockReference(
    activeID,
    identity(harness, 'note'),
  );
  harness.server.seedHeading(
    containerID,
    harness.target.pageID,
    'page_id',
    headingRequest('Zotero Notes', [container.marker]),
  );
  harness.server.seedHeading(
    activeID,
    containerID,
    'block_id',
    headingRequest('Synthetic note', [ownership.marker]),
  );
  harness.store.write({
    container,
    containerBlockID: containerID,
    notes: {
      [harness.noteItem.key]: {
        blockID: activeID,
        ownership,
        ownershipStatus: 'managed',
        sourceHash,
        syncedAt: new Date(),
      },
    },
    schemaVersion: 2,
  });
  return { activeID, containerID };
}

function installImage(harness: Harness): void {
  const attachment = createZoteroItemMock({
    attachmentContentType: 'image/png',
    deleted: false,
    libraryID: harness.noteItem.libraryID,
    parentItemID: harness.noteItem.id,
  });
  Object.defineProperty(attachment, 'key', { value: 'IMAGEA' });
  attachment.isEmbeddedImageAttachment.mockReturnValue(true);
  attachment.getFilePathAsync.mockResolvedValue('synthetic-image.png');
  zoteroMock.Items.getByLibraryAndKey.mockReturnValue(attachment);
  // oxlint-disable-next-line typescript/unbound-method
  vi.mocked(IOUtils.read).mockResolvedValue(validPngBytes);
}

describe('stateful note synchronization recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([500, 503, 504, 529])(
    'reconciles an HTTP %i create result after the server created it and converges without a second create',
    async (status) => {
      const harness = createHarness(
        '<div><p>Before</p><img data-attachment-key="IMAGEA"><p>After</p></div>',
      );
      installImage(harness);
      harness.server.setNextUploadContentLength(validPngBytes.byteLength);
      harness.server.failNextCreateUpload(
        notionError(APIErrorCode.InternalServerError, status),
        true,
      );

      await syncNoteItem(harness.noteItem, harness.restart(), {
        ...target,
        imageSyncEnabled: true,
      });

      expect(harness.server.createUploadCount).toBe(1);
      expect(harness.server.sendUploadCount).toBe(1);
      const state = harness.store.read();
      const activeID = state.notes?.[harness.noteItem.key]?.blockID;
      expect(activeID).toBeTruthy();
      expect(
        harness.server
          .visibleChildren(activeID || '')
          .map(({ request }) => ('image' in request ? 'image' : 'text')),
      ).toStrictEqual(['text', 'image', 'text']);

      const appendCount = harness.server.appendCount;
      await syncNoteItem(harness.noteItem, harness.restart(), {
        ...target,
        imageSyncEnabled: true,
      });
      expect(harness.server.appendCount).toBe(appendCount);
      expect(harness.server.createUploadCount).toBe(1);
    },
  );

  it('keeps a zero-match create result isolated across a durable restart', async () => {
    const harness = createHarness(
      '<div><img data-attachment-key="IMAGEA"></div>',
    );
    installImage(harness);
    harness.server.failNextCreateUpload(new RequestTimeoutError());

    await expect(
      syncNoteItem(harness.noteItem, harness.restart(), {
        ...target,
        imageSyncEnabled: true,
      }),
    ).rejects.toBeInstanceOf(RemoteWriteResultUncertainError);
    expect(
      harness.store.read().notes?.[harness.noteItem.key]
        ?.provisionalUploads?.[0],
    ).toMatchObject({
      isolationDeadline: expect.any(Date),
      requestStartedAt: expect.any(Date),
      status: 'create-uncertain',
    });
    expect(harness.server.createUploadCount).toBe(1);

    await expect(
      syncNoteItem(harness.noteItem, harness.restart(), {
        ...target,
        imageSyncEnabled: true,
      }),
    ).rejects.toBeInstanceOf(RemoteWriteResultUncertainError);
    expect(harness.server.createUploadCount).toBe(1);
    expect(harness.server.sendUploadCount).toBe(0);
  });

  it('stops on multiple durable reconciliation matches without creating or sending again', async () => {
    const harness = createHarness(
      '<div><img data-attachment-key="IMAGEA"></div>',
    );
    installImage(harness);
    harness.server.failNextCreateUpload(new RequestTimeoutError());
    await expect(
      syncNoteItem(harness.noteItem, harness.restart(), {
        ...target,
        imageSyncEnabled: true,
      }),
    ).rejects.toBeInstanceOf(RemoteWriteResultUncertainError);
    const provisional =
      harness.store.read().notes?.[harness.noteItem.key]
        ?.provisionalUploads?.[0];
    if (!provisional) throw new Error('Missing synthetic upload journal');
    for (const id of ['remote-match-a', 'remote-match-b']) {
      harness.server.uploads.set(id, {
        archived: false,
        content_length: provisional.contentLength,
        content_type: provisional.contentType,
        created_by: { id: target.connectionID, type: 'bot' },
        created_time: new Date().toISOString(),
        expiry_time: provisional.isolationDeadline?.toISOString() || null,
        filename: provisional.filename,
        id,
        last_edited_time: new Date().toISOString(),
        object: 'file_upload',
        status: 'pending',
      });
    }

    await expect(
      syncNoteItem(harness.noteItem, harness.restart(), {
        ...target,
        imageSyncEnabled: true,
      }),
    ).rejects.toBeInstanceOf(UploadReconciliationAmbiguousError);
    expect(harness.server.createUploadCount).toBe(1);
    expect(harness.server.sendUploadCount).toBe(0);
  });

  it('retains pre-create evidence when saving the created upload ID fails', async () => {
    const harness = createHarness(
      '<div><img data-attachment-key="IMAGEA"></div>',
    );
    installImage(harness);
    harness.server.setNextUploadContentLength(validPngBytes.byteLength);
    harness.failJournalOnce((note) =>
      Boolean(note.provisionalUploads?.some((upload) => upload.fileUploadID)),
    );

    const error = await syncNoteItem(harness.noteItem, harness.restart(), {
      ...target,
      imageSyncEnabled: true,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(JournalPersistenceError);
    expect(harness.server.createUploadCount).toBe(1);
    expect(harness.server.sendUploadCount).toBe(0);
    expect(
      harness.store.read().notes?.[harness.noteItem.key]
        ?.provisionalUploads?.[0],
    ).toMatchObject({
      isolationDeadline: expect.any(Date),
      requestStartedAt: expect.any(Date),
      status: 'create-uncertain',
    });
    expect(
      harness.store.read().notes?.[harness.noteItem.key]
        ?.provisionalUploads?.[0],
    ).not.toHaveProperty('fileUploadID');

    await expect(
      syncNoteItem(harness.noteItem, harness.restart(), {
        ...target,
        imageSyncEnabled: true,
      }),
    ).rejects.toThrow(/pending|resume/i);
    expect(harness.server.createUploadCount).toBe(1);
    expect(harness.server.sendUploadCount).toBe(0);

    await expect(
      syncNoteItem(harness.noteItem, harness.restart(), {
        ...target,
        imageSyncEnabled: true,
      }),
    ).rejects.toThrow(/pending|resume/i);
    expect(harness.server.createUploadCount).toBe(1);
    expect(harness.server.sendUploadCount).toBe(0);
  });

  it('retrieves instead of resending when the uploaded-status journal save fails', async () => {
    const harness = createHarness(
      '<div><img data-attachment-key="IMAGEA"></div>',
    );
    installImage(harness);
    harness.server.setNextUploadContentLength(validPngBytes.byteLength);
    harness.failJournalOnce((note) =>
      Boolean(
        note.provisionalUploads?.some((upload) => upload.status === 'uploaded'),
      ),
    );

    await expect(
      syncNoteItem(harness.noteItem, harness.restart(), {
        ...target,
        imageSyncEnabled: true,
      }),
    ).rejects.toBeInstanceOf(JournalPersistenceError);
    expect(harness.server.createUploadCount).toBe(1);
    expect(harness.server.sendUploadCount).toBe(1);
    expect(
      harness.store.read().notes?.[harness.noteItem.key]
        ?.provisionalUploads?.[0],
    ).toMatchObject({ fileUploadID: 'upload-1', status: 'send-uncertain' });

    await syncNoteItem(harness.noteItem, harness.restart(), {
      ...target,
      imageSyncEnabled: true,
    });
    expect(harness.server.createUploadCount).toBe(1);
    expect(harness.server.sendUploadCount).toBe(1);
  });

  it.each([
    {
      imageSyncEnabled: false,
      label: 'text edit',
      noteHTML: '<div><p>Current text revision</p></div>',
      needsImage: false,
    },
    {
      imageSyncEnabled: true,
      label: 'image deletion',
      noteHTML: '<div><p>The prior image was removed</p></div>',
      needsImage: false,
    },
    {
      imageSyncEnabled: true,
      label: 'image replacement with the same attachment identity',
      noteHTML: '<div><img data-attachment-key="IMAGEA"></div>',
      needsImage: true,
    },
    {
      imageSyncEnabled: false,
      label: 'image sync ON to OFF',
      noteHTML: '<div><img data-attachment-key="IMAGEA"></div>',
      needsImage: false,
    },
    {
      imageSyncEnabled: true,
      label: 'image sync OFF to ON',
      noteHTML: '<div><img data-attachment-key="IMAGEA"></div>',
      needsImage: true,
    },
  ])(
    'cleans a superseded $label attempt after restart and commits only the current source',
    async ({ imageSyncEnabled, needsImage, noteHTML }) => {
      const harness = createHarness(noteHTML);
      if (needsImage) {
        installImage(harness);
        harness.server.setNextUploadContentLength(validPngBytes.byteLength);
      }
      const { activeID, containerID } = seedManagedActive(
        harness,
        'last-good-source',
      );
      const attemptID = 'superseded-attempt';
      const candidate = createManagedBlockReference(
        'superseded-candidate',
        identity(harness, 'candidate', attemptID),
      );
      harness.server.seedHeading(
        candidate.blockID,
        containerID,
        'block_id',
        headingRequest('Notero sync in progress', [candidate.marker]),
      );
      const state = harness.store.read();
      const existing = state.notes?.[harness.noteItem.key];
      if (!existing || !state.container)
        throw new Error('Missing fixture state');
      harness.store.write({
        ...state,
        notes: {
          ...state.notes,
          [harness.noteItem.key]: {
            ...existing,
            transaction: {
              attemptID,
              candidate,
              container: state.container,
              sourceHash: 'superseded-source',
              stage: 'content-partial',
              startedAt: new Date(0),
              target,
            },
          },
        },
      });

      await syncNoteItem(harness.noteItem, harness.restart(), {
        ...target,
        imageSyncEnabled,
      });

      expect(
        harness.server.blocks.get(candidate.blockID)?.response.in_trash,
      ).toBe(true);
      const recovered = harness.store.read().notes?.[harness.noteItem.key];
      expect(recovered?.blockID).not.toBe(activeID);
      expect(recovered?.blockID).not.toBe(candidate.blockID);
      expect(recovered?.transaction).toBeUndefined();
      expect(harness.server.createUploadCount).toBe(needsImage ? 1 : 0);
    },
  );

  it('bounds cleanup of an unverified superseded candidate and resumes the current source without deleting it', async () => {
    const harness = createHarness('<div><p>Current source</p></div>');
    const { activeID, containerID } = seedManagedActive(
      harness,
      'last-good-source',
    );
    const attemptID = 'unverified-superseded-attempt';
    const candidate = createManagedBlockReference(
      'unverified-superseded-candidate',
      identity(harness, 'candidate', attemptID),
    );
    harness.server.seedHeading(
      candidate.blockID,
      containerID,
      'block_id',
      headingRequest('User changed this marker', []),
      'user-a',
    );
    const state = harness.store.read();
    const existing = state.notes?.[harness.noteItem.key];
    if (!existing || !state.container) throw new Error('Missing fixture state');
    harness.store.write({
      ...state,
      notes: {
        ...state.notes,
        [harness.noteItem.key]: {
          ...existing,
          transaction: {
            attemptID,
            candidate,
            container: state.container,
            sourceHash: 'superseded-source',
            stage: 'content-partial',
            startedAt: new Date(0),
            target,
          },
        },
      },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        syncNoteItem(harness.noteItem, harness.restart(), {
          ...target,
          imageSyncEnabled: false,
        }),
      ).rejects.toThrow(/cleanup|isolated/i);
      expect(harness.store.read().notes?.[harness.noteItem.key]?.blockID).toBe(
        activeID,
      );
    }

    await syncNoteItem(harness.noteItem, harness.restart(), {
      ...target,
      imageSyncEnabled: false,
    });

    const recovered = harness.store.read().notes?.[harness.noteItem.key];
    expect(recovered?.blockID).not.toBe(activeID);
    expect(recovered?.blockID).not.toBe(candidate.blockID);
    expect(recovered?.transaction).toBeUndefined();
    expect(recovered?.unverifiedOrphanBlocks).toContainEqual(candidate);
    expect(
      harness.server.blocks.get(candidate.blockID)?.response.in_trash,
    ).toBe(false);
  });

  it('persists a real orphan-cleanup stage, restarts from JSON, and fast-paths after cleanup', async () => {
    const harness = createHarness('<div><p>Changed source</p></div>');
    seedManagedActive(harness, 'last-good-source');
    harness.server.failAppendAt(2, new Error('Synthetic content failure'));
    harness.server.failNextDelete(new Error('Synthetic cleanup failure'));

    await expect(
      syncNoteItem(harness.noteItem, harness.restart(), {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow('Synthetic content failure');
    expect(
      harness.store.read().notes?.[harness.noteItem.key]?.transaction,
    ).toMatchObject({
      orphanCleanupAttempts: 1,
      stage: 'orphan-cleanup',
    });

    await syncNoteItem(harness.noteItem, harness.restart(), {
      ...target,
      imageSyncEnabled: false,
    });
    const converged = harness.store.read().notes?.[harness.noteItem.key];
    expect(converged?.orphanBlocks).toBeUndefined();
    expect(converged?.transaction).toBeUndefined();
    const appendCount = harness.server.appendCount;

    await syncNoteItem(harness.noteItem, harness.restart(), {
      ...target,
      imageSyncEnabled: false,
    });
    expect(harness.server.appendCount).toBe(appendCount);
  });

  it.each([false, true])(
    'migrates legacy metadata non-destructively with image sync %s',
    async (imageSyncEnabled) => {
      const harness = createHarness(
        imageSyncEnabled
          ? '<div><p>Legacy source copy</p><img data-attachment-key="IMAGEA"></div>'
          : '<div><p>Legacy source copy</p></div>',
      );
      if (imageSyncEnabled) {
        installImage(harness);
        harness.server.setNextUploadContentLength(validPngBytes.byteLength);
      }
      const legacy: LegacySyncEvidence = {
        containerBlockID: 'legacy-container',
        noteBlockIDs: {
          [harness.noteItem.key]: 'legacy-user-note',
          OTHER: 'inaccessible-legacy-note',
        },
      };
      harness.store.write({
        containerBlockID: 'legacy-container',
        legacy,
        notes: {
          [harness.noteItem.key]: {
            blockID: 'legacy-user-note',
            ownershipStatus: 'legacy-unverified',
          },
          OTHER: {
            blockID: 'inaccessible-legacy-note',
            ownershipStatus: 'legacy-unverified',
          },
        },
        schemaVersion: 1,
      });
      harness.server.seedHeading(
        'legacy-container',
        target.pageID,
        'page_id',
        headingRequest('User legacy container', []),
        'user-a',
      );
      harness.server.seedHeading(
        'legacy-user-note',
        'legacy-container',
        'block_id',
        headingRequest('User legacy note', []),
        'user-a',
      );

      await syncNoteItem(harness.noteItem, harness.restart(), {
        ...target,
        imageSyncEnabled,
      });

      expect(
        harness.server.blocks.get('legacy-container')?.response.in_trash,
      ).toBe(false);
      expect(
        harness.server.blocks.get('legacy-user-note')?.response.in_trash,
      ).toBe(false);
      const migrated = harness.store.read();
      expect(migrated.legacy).toMatchObject(legacy);
      expect(migrated.container?.blockID).not.toBe('legacy-container');
      expect(migrated.notes?.[harness.noteItem.key]?.blockID).not.toBe(
        'legacy-user-note',
      );
      expect(migrated.notes?.OTHER).toEqual({
        blockID: 'inaccessible-legacy-note',
        ownershipStatus: 'legacy-unverified',
      });
      expect(harness.server.createUploadCount).toBe(imageSyncEnabled ? 1 : 0);
      const notice = harness.server
        .visibleChildren(migrated.container?.blockID || '')
        .find(({ request }) => 'paragraph' in request);
      expect(JSON.stringify(notice?.request)).toContain(
        'left all legacy synchronized blocks unchanged',
      );
      const appendCount = harness.server.appendCount;

      await syncNoteItem(harness.noteItem, harness.restart(), {
        ...target,
        imageSyncEnabled,
      });
      expect(harness.server.appendCount).toBe(appendCount);
    },
  );

  it('keeps multiple notes and parent items isolated in one stateful page tree', async () => {
    const server = new StatefulNotionServer(target.connectionID, target.pageID);
    const parentA = createZoteroItemMock({ libraryID: 1 });
    const parentB = createZoteroItemMock({ libraryID: 1 });
    const noteA1 = createZoteroItemMock({ libraryID: 1 });
    const noteA2 = createZoteroItemMock({ libraryID: 1 });
    const noteB1 = createZoteroItemMock({ libraryID: 1 });
    for (const [note, parent, title] of [
      [noteA1, parentA, 'Parent A note 1'],
      [noteA2, parentA, 'Parent A note 2'],
      [noteB1, parentB, 'Parent B note 1'],
    ] as const) {
      note.isTopLevelItem.mockReturnValue(false);
      note.topLevelItem = parent;
      note.getNote.mockReturnValue(`<div><p>${title}</p></div>`);
      note.getNoteTitle.mockReturnValue(title);
    }
    const stores = new Map([
      [
        parentA.key,
        new DurableMetadataStore<SyncedNotes>(
          JSON.stringify({ notes: {}, schemaVersion: 2 }),
        ),
      ],
      [
        parentB.key,
        new DurableMetadataStore<SyncedNotes>(
          JSON.stringify({ notes: {}, schemaVersion: 2 }),
        ),
      ],
    ]);
    vi.mocked(getNotionPageID).mockReturnValue(target.pageID);
    vi.mocked(getSyncedNotes).mockImplementation((item) => {
      const store = stores.get(item.key);
      if (!store) throw new Error('Missing synthetic parent metadata store');
      return store.read();
    });
    vi.mocked(saveSyncedNoteRecord).mockImplementation(
      async (item, containerBlockID, noteItemKey, note, container, legacy) => {
        const store = stores.get(item.key);
        if (!store) throw new Error('Missing synthetic parent metadata store');
        const current = store.read();
        store.write({
          ...(container && { container }),
          containerBlockID,
          ...(legacy || current.legacy
            ? { legacy: legacy || current.legacy }
            : {}),
          notes: { ...current.notes, [noteItemKey]: note },
          schemaVersion: 2,
        });
      },
    );
    server.seedHeading(
      'user-page-block',
      target.pageID,
      'page_id',
      headingRequest('User-owned content', []),
      'user-a',
    );

    for (const note of [noteA1, noteA2, noteB1]) {
      await syncNoteItem(note, server.client(), {
        ...target,
        imageSyncEnabled: false,
      });
    }

    const stateA = stores.get(parentA.key)?.read();
    const stateB = stores.get(parentB.key)?.read();
    expect(Object.keys(stateA?.notes || {})).toHaveLength(2);
    expect(Object.keys(stateB?.notes || {})).toHaveLength(1);
    expect(stateA?.container?.blockID).not.toBe(stateB?.container?.blockID);
    expect(
      server
        .visibleChildren(stateA?.container?.blockID || '')
        .map(({ response }) => response.id),
    ).toEqual(
      expect.arrayContaining(
        Object.values(stateA?.notes || {}).map(({ blockID }) => blockID),
      ),
    );
    expect(
      server
        .visibleChildren(stateB?.container?.blockID || '')
        .map(({ response }) => response.id),
    ).toEqual(
      expect.arrayContaining(
        Object.values(stateB?.notes || {}).map(({ blockID }) => blockID),
      ),
    );
    expect(server.blocks.get('user-page-block')?.response.in_trash).toBe(false);
  });

  it.each([
    target,
    {
      connectionID: 'bot-b',
      databaseID: 'database-b',
      pageID: 'page-b',
      workspaceID: 'workspace-b',
    },
  ])(
    'keeps the image mapping scoped to target $workspaceID/$databaseID/$pageID',
    async (harnessTarget) => {
      const harness = createHarness(
        '<div><p>Before</p><img data-attachment-key="IMAGEA"><p>After</p></div>',
        harnessTarget,
      );
      installImage(harness);
      harness.server.setNextUploadContentLength(validPngBytes.byteLength);

      await syncNoteItem(harness.noteItem, harness.restart(), {
        ...harnessTarget,
        imageSyncEnabled: true,
      });

      const state = harness.store.read();
      expect(harness.server.pages.has(harnessTarget.pageID)).toBe(true);
      expect(state.notes?.[harness.noteItem.key]?.target).toEqual(
        harnessTarget,
      );
      expect(harness.server.createUploadCount).toBe(1);
      expect(harness.server.sendUploadCount).toBe(1);
    },
  );

  it('rejects future metadata without changing its bytes or the remote tree', async () => {
    const harness = createHarness();
    const raw = JSON.stringify({
      future: { retained: true },
      schemaVersion: 99,
    });
    harness.store.write({
      schemaVersion: 99,
      unsupportedFutureSchema: { rawJSON: raw, schemaVersion: 99 },
    });
    const before = harness.store.raw();

    await expect(
      syncNoteItem(harness.noteItem, harness.restart(), {
        ...target,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow(/newer Notero|schema v99/i);

    expect(harness.store.raw()).toBe(before);
    expect(harness.server.appendCount).toBe(0);
    expect(harness.server.createUploadCount).toBe(0);
    expect(harness.server.deleteCount).toBe(0);
  });

  it('never promotes a partial 101-block candidate after an uncertain middle append', async () => {
    const harness = createHarness('<div><p>Changed source</p></div>');
    const { activeID } = seedManagedActive(harness, 'last-good-source');
    harness.server.failAppendAt(2, new RequestTimeoutError(), true);
    const blocks: ChildBlock[] = Array.from({ length: 101 }, (_, index) => ({
      paragraph: {
        rich_text: [
          { text: { content: `Block ${index}` }, type: 'text' as const },
        ],
      },
    }));

    await expect(
      syncNoteItem(harness.noteItem, harness.restart(), {
        ...target,
        blockConverter: () => blocks,
        imageSyncEnabled: false,
      }),
    ).rejects.toThrow(/timed out/i);

    expect(harness.store.read().notes?.[harness.noteItem.key]?.blockID).toBe(
      activeID,
    );
    expect(
      harness.server.visibleChildren(
        harness.store.read().container?.blockID || '',
      ),
    ).toHaveLength(1);
  });
});
