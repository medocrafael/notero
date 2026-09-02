import { APIErrorCode } from '@notionhq/client';
import { APIResponseError } from '@notionhq/client/build/src/errors';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  createZoteroItemMock,
  FakeRuntimeClock,
  zoteroMock,
} from '../../../../test/utils';
import {
  getRawSyncedNotesMetadata,
  getSyncedNotes,
} from '../../data/item-data';
import { isObject } from '../../utils/is-object';
import { buildManagedHeadingRichText } from '../notion-block-ownership';
import type { ChildBlock } from '../notion-types';
import { syncNoteItem, type NoteSyncOptions } from '../sync-note-item';

import { validJpegBytes, validPngBytes } from './fixtures/image-fixtures';
import { StatefulNotionServer } from './stateful-notion-fake';

const pageID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const target: Required<
  Pick<NoteSyncOptions, 'connectionID' | 'databaseID' | 'workspaceID'>
> = {
  connectionID: 'bot-a',
  databaseID: 'database-a',
  workspaceID: 'workspace-a',
};

type Harness = ReturnType<typeof createHarness>;

type StoredNoteProjection = {
  active: {
    block: { blockID: string };
    completionEvidence: {
      expectedBlockCount: number;
      verifiedAt: string;
    };
    imageAssetIdentities: string[];
  };
  cleanupLedger: Array<Record<string, unknown>>;
  featurePolicy: string;
  mainState: string;
  uploadAssets: Array<Record<string, unknown>>;
};

type NativeRootProjection = {
  legacy?: unknown;
  notes: Record<string, unknown>;
  schemaVersion: number;
};

function createHarness(
  initialNoteHTML = '<p>Synthetic text</p>',
  serverClock: () => number = Date.now,
) {
  const parentItem = createZoteroItemMock({ libraryID: 1 });
  parentItem.isRegularItem.mockReturnValue(true);
  const noteItem = createNote(parentItem, initialNoteHTML);
  const attachment = createZoteroItemMock({ libraryID: 1 });
  const pageURL = `https://www.notion.so/${pageID}`;
  let attachmentNote = '';
  parentItem.getAttachments.mockReturnValue([attachment.id]);
  attachment.getField.mockImplementation((field) =>
    field === 'url' ? pageURL : '',
  );
  attachment.getNote.mockImplementation(() => attachmentNote);
  attachment.setNote.mockImplementation((value) => {
    attachmentNote = value;
    return true;
  });
  const server = new StatefulNotionServer(
    target.connectionID,
    pageID,
    'workspace-a',
    serverClock,
  );
  return {
    attachment,
    noteItem,
    parentItem,
    server,
    setMetadata: (value: unknown) => {
      attachmentNote = `<pre id="notero-synced-notes">${JSON.stringify(value)}</pre>`;
    },
    setNoteHTML: (html: string) => {
      noteItem.getNote.mockReturnValue(html);
    },
  };
}

function createNote(parentItem: Zotero.Item, html: string) {
  const note = createZoteroItemMock({ libraryID: parentItem.libraryID });
  note.isNote.mockReturnValue(true);
  note.isTopLevelItem.mockReturnValue(false);
  note.topLevelItem = parentItem;
  note.getNote.mockReturnValue(html);
  note.getNoteTitle.mockReturnValue('Synthetic note');
  return note;
}

function nativeRoot(harness: Harness): NativeRootProjection {
  const raw = getRawSyncedNotesMetadata(harness.parentItem);
  if (!raw) throw new Error('Expected native metadata');
  const value: unknown = JSON.parse(raw);
  if (
    !isObject(value) ||
    typeof value.schemaVersion !== 'number' ||
    !isObject(value.notes)
  ) {
    throw new Error('Expected a native v4 metadata root');
  }
  return {
    ...value,
    notes: value.notes,
    schemaVersion: value.schemaVersion,
  };
}

function storedNote(
  harness: Harness,
  noteItem: Zotero.Item = harness.noteItem,
): StoredNoteProjection {
  const record = nativeRoot(harness).notes[noteItem.key];
  if (
    !isObject(record) ||
    !isObject(record.active) ||
    !isObject(record.active.block) ||
    typeof record.active.block.blockID !== 'string' ||
    !isObject(record.active.completionEvidence) ||
    typeof record.active.completionEvidence.expectedBlockCount !== 'number' ||
    typeof record.active.completionEvidence.verifiedAt !== 'string' ||
    !Array.isArray(record.active.imageAssetIdentities) ||
    !Array.isArray(record.cleanupLedger) ||
    !isObject(record.requestedSource) ||
    typeof record.requestedSource.featurePolicy !== 'string' ||
    typeof record.mainState !== 'string' ||
    !Array.isArray(record.uploadAssets)
  ) {
    throw new Error(`Missing or invalid stored note ${noteItem.key}`);
  }
  return {
    active: {
      block: { blockID: record.active.block.blockID },
      completionEvidence: {
        expectedBlockCount: record.active.completionEvidence.expectedBlockCount,
        verifiedAt: record.active.completionEvidence.verifiedAt,
      },
      imageAssetIdentities: record.active.imageAssetIdentities.filter(
        (value): value is string => typeof value === 'string',
      ),
    },
    cleanupLedger: record.cleanupLedger.filter(isObject),
    featurePolicy: record.requestedSource.featurePolicy,
    mainState: record.mainState,
    uploadAssets: record.uploadAssets.filter(isObject),
  };
}

function installImage(harness: Harness, key = 'IMAGEA'): void {
  const image = createZoteroItemMock({
    attachmentContentType: 'image/png',
    deleted: false,
    libraryID: harness.noteItem.libraryID,
    parentItemID: harness.noteItem.id,
  });
  Object.defineProperty(image, 'key', { value: key });
  image.isEmbeddedImageAttachment.mockReturnValue(true);
  image.getFilePathAsync.mockResolvedValue(`synthetic-${key}.png`);
  zoteroMock.Items.getByLibraryAndKey.mockImplementation(
    (_libraryID, requestedKey) => (requestedKey === key ? image : false),
  );
  vi.mocked(IOUtils).read.mockResolvedValue(validPngBytes);
  harness.server.setNextUploadContentLength(validPngBytes.byteLength);
}

function installMutableImages(harness: Harness) {
  const images = new Map<string, Zotero.Item>();
  const bytes = new Map<string, Uint8Array<ArrayBuffer>>();
  const put = (
    key: string,
    contentType: 'image/jpeg' | 'image/png',
    content: Uint8Array<ArrayBuffer>,
  ) => {
    const image = createZoteroItemMock({
      attachmentContentType: contentType,
      deleted: false,
      libraryID: harness.noteItem.libraryID,
      parentItemID: harness.noteItem.id,
    });
    Object.defineProperty(image, 'key', { value: key });
    image.isEmbeddedImageAttachment.mockReturnValue(true);
    image.getFilePathAsync.mockResolvedValue(`synthetic-${key}`);
    images.set(key, image);
    bytes.set(key, content);
    harness.server.setNextUploadContentLength(content.byteLength);
  };
  zoteroMock.Items.getByLibraryAndKey.mockImplementation(
    (_libraryID, key) => images.get(key) || false,
  );
  vi.mocked(IOUtils).read.mockImplementation(async (path) => {
    const key = /synthetic-(.+)$/.exec(path)?.[1];
    const content = key && bytes.get(key);
    if (!content) throw new Error('Synthetic image bytes are missing');
    return content;
  });
  return { put };
}

const blocks101: ChildBlock[] = Array.from({ length: 101 }, (_, index) => ({
  paragraph: {
    rich_text: [
      { text: { content: `Synthetic ${index}` }, type: 'text' as const },
    ],
  },
}));

function validationFailure(): APIResponseError {
  return new APIResponseError({
    code: APIErrorCode.ValidationError,
    headers: new Headers(),
    message: 'Synthetic validation failure',
    rawBodyText: 'Synthetic validation failure',
    status: 400,
  });
}

function httpFailure(
  code: APIErrorCode,
  status: number,
  retryAfter?: string,
): APIResponseError {
  const headers = new Headers();
  if (retryAfter) headers.set('retry-after', retryAfter);
  return new APIResponseError({
    code,
    headers,
    message: 'Synthetic HTTP failure',
    rawBodyText: 'redacted',
    status,
  });
}

function visibleNoteTitles(harness: Harness, containerID: string): string[] {
  return harness.server
    .visibleChildren(containerID)
    .flatMap(({ response }) =>
      response.type === 'heading_1'
        ? [response.heading_1.rich_text[0]?.plain_text || '']
        : [],
    );
}

describe('syncNoteItem FSM v2 stateful integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let inTransaction = false;
    zoteroMock.DB.inTransaction.mockImplementation(() => inTransaction);
    zoteroMock.DB.executeTransaction.mockImplementation(async (callback) => {
      inTransaction = true;
      try {
        return await callback();
      } finally {
        inTransaction = false;
      }
    });
    zoteroMock.Items.reload.mockResolvedValue();
  });

  it('learns the real remote creator while preserving a distinct legacy local identity', async () => {
    const harness = createHarness();
    const localIdentity = 'legacy-local:synthetic-connection';

    await expect(
      syncNoteItem(harness.noteItem, harness.server.client(), {
        connectionID: localIdentity,
        databaseID: target.databaseID,
        imageSyncEnabled: false,
        targetIdentityType: 'legacy-local',
        workspaceID: localIdentity,
      }),
    ).resolves.toBeUndefined();

    const value = nativeRoot(harness).notes[harness.noteItem.key];
    if (!isObject(value) || !isObject(value.targetIdentity)) {
      throw new Error('Expected a durable note record');
    }
    expect(value.targetIdentity.connectionID).toBe(localIdentity);
    expect(value.container).toMatchObject({
      createdByID: harness.server.botID,
    });
    expect(value.active).toMatchObject({
      block: { createdByID: harness.server.botID },
    });
    expect(harness.server.botID).not.toBe(localIdentity);
  });

  it('fails closed on token rotation to a different remote creator without deleting the prior active', async () => {
    const harness = createHarness();
    const options = {
      ...target,
      imageSyncEnabled: false,
      remoteCreatorID: harness.server.botID,
    };
    await syncNoteItem(harness.noteItem, harness.server.client(), options);
    const oldActiveID = storedNote(harness).active.block.blockID;
    const mutationsBefore = harness.server.events.filter(
      ({ type }) => type === 'remote-mutation-committed',
    ).length;
    harness.setNoteHTML('<p>Changed after synthetic token rotation</p>');

    await expect(
      syncNoteItem(harness.noteItem, harness.server.client(), {
        ...options,
        remoteCreatorID: 'bot-after-token-rotation',
      }),
    ).rejects.toThrow(/explicit rebind or a new managed copy/i);

    expect(
      harness.server.events.filter(
        ({ type }) => type === 'remote-mutation-committed',
      ),
    ).toHaveLength(mutationsBefore);
    expect(storedNote(harness).active.block.blockID).toBe(oldActiveID);
    expect(harness.server.blocks.get(oldActiveID)?.response.in_trash).toBe(
      false,
    );
  });

  it('preserves Zotero receivers on the production syncNoteItem metadata path', async () => {
    const harness = createHarness();
    Reflect.set(zoteroMock.DB, 'connection', 'production-db-receiver');
    Reflect.set(zoteroMock.Items, 'connection', 'production-items-receiver');
    let inTransaction = false;
    const executeTransaction = vi
      .spyOn(zoteroMock.DB, 'executeTransaction')
      .mockImplementation(
        async function (this: typeof zoteroMock.DB, callback) {
          if (Reflect.get(this, 'connection') !== 'production-db-receiver') {
            throw new Error('Production DB receiver was lost');
          }
          inTransaction = true;
          try {
            return await callback();
          } finally {
            inTransaction = false;
          }
        },
      );
    vi.spyOn(zoteroMock.DB, 'inTransaction').mockImplementation(
      function (this: typeof zoteroMock.DB) {
        if (Reflect.get(this, 'connection') !== 'production-db-receiver') {
          throw new Error('Production DB receiver was lost');
        }
        return inTransaction;
      },
    );
    const reloadItems = vi
      .spyOn(zoteroMock.Items, 'reload')
      .mockImplementation(async function (this: typeof zoteroMock.Items) {
        if (Reflect.get(this, 'connection') !== 'production-items-receiver') {
          throw new Error('Production Items receiver was lost');
        }
      });

    await expect(
      syncNoteItem(harness.noteItem, harness.server.client(), {
        ...target,
        imageSyncEnabled: false,
      }),
    ).resolves.toBeUndefined();
    expect(reloadItems).toHaveBeenCalled();
    expect(executeTransaction).toHaveBeenCalled();
  });

  it('keeps a failed replacement visibly staged and outside the active mapping', async () => {
    const harness = createHarness();
    const options = { ...target, imageSyncEnabled: false };
    await syncNoteItem(harness.noteItem, harness.server.client(), options);
    const oldActiveID = storedNote(harness).active.block.blockID;
    harness.setNoteHTML('<p>Changed text that must not partially replace</p>');
    harness.server.failAppendAt(
      harness.server.appendCount + 2,
      validationFailure(),
    );

    await expect(
      syncNoteItem(harness.noteItem, harness.server.client(), options),
    ).rejects.toThrow('Note synchronization halted: VALIDATION_FAILED');

    const root = nativeRoot(harness);
    const value = root.notes[harness.noteItem.key];
    if (
      !isObject(value) ||
      !isObject(value.active) ||
      !isObject(value.container)
    ) {
      throw new Error('Expected prior durable active and container');
    }
    const containerID = value.container.blockID;
    if (typeof containerID !== 'string')
      throw new Error('Missing container ID');
    const visibleTitles = harness.server
      .visibleChildren(containerID)
      .flatMap(({ response }) =>
        response.type === 'heading_1'
          ? [response.heading_1.rich_text[0]?.plain_text || '']
          : [],
      );

    expect(value.active).toMatchObject({ block: { blockID: oldActiveID } });
    expect(value.mainTransaction).toMatchObject({ candidate: null });
    expect(value.cleanupLedger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'ABORTED_ATTEMPT' }),
      ]),
    );
    expect(visibleTitles).toContain('Notero Sync Incomplete — Synthetic note');
    expect(
      visibleTitles.filter((title) => title === 'Synthetic note'),
    ).toHaveLength(1);
  });

  it('retains an explicit staging title through finalization failure and cleans it on a later success', async () => {
    const harness = createHarness();
    const options = { ...target, imageSyncEnabled: false };
    await syncNoteItem(harness.noteItem, harness.server.client(), options);
    const oldActiveID = storedNote(harness).active.block.blockID;
    harness.setNoteHTML('<p>Changed before finalization failure</p>');
    harness.server.failNextUpdate(validationFailure());

    await expect(
      syncNoteItem(harness.noteItem, harness.server.client(), options),
    ).rejects.toThrow('Note synchronization halted: VALIDATION_FAILED');

    let root = nativeRoot(harness);
    let value = root.notes[harness.noteItem.key];
    if (!isObject(value) || !isObject(value.container)) {
      throw new Error('Expected retained v4 note state');
    }
    const containerID = value.container.blockID;
    if (typeof containerID !== 'string') throw new Error('Missing container');
    expect(storedNote(harness).active.block.blockID).toBe(oldActiveID);
    expect(value.mainTransaction).toMatchObject({ candidate: null });
    expect(value.cleanupLedger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'ABORTED_ATTEMPT' }),
      ]),
    );
    expect(visibleNoteTitles(harness, containerID)).toContain(
      'Notero Sync Incomplete — Synthetic note',
    );

    await syncNoteItem(harness.noteItem, harness.server.client(), options);
    root = nativeRoot(harness);
    value = root.notes[harness.noteItem.key];
    if (!isObject(value)) throw new Error('Expected completed v4 note state');
    expect(value.mainState).toBe('IDLE');
    expect(storedNote(harness).active.block.blockID).not.toBe(oldActiveID);
    expect(visibleNoteTitles(harness, containerID)).toEqual(['Synthetic note']);
  });

  it('keeps a first-sync image candidate staged when image attachment fails', async () => {
    const harness = createHarness(
      '<p>Before</p><img data-attachment-key="IMAGEA"><p>After</p>',
    );
    installImage(harness);
    harness.server.failAppendAt(
      harness.server.appendCount + 3,
      validationFailure(),
    );

    await expect(
      syncNoteItem(harness.noteItem, harness.server.client(), {
        ...target,
        imageSyncEnabled: true,
      }),
    ).rejects.toThrow('Note synchronization halted: VALIDATION_FAILED');

    const value = nativeRoot(harness).notes[harness.noteItem.key];
    if (!isObject(value) || !isObject(value.container)) {
      throw new Error('Expected failed first-sync metadata');
    }
    const containerID = value.container.blockID;
    if (typeof containerID !== 'string') throw new Error('Missing container');
    expect(value.active).toBeNull();
    expect(value.mainTransaction).toMatchObject({ candidate: null });
    expect(value.cleanupLedger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'ABORTED_ATTEMPT' }),
      ]),
    );
    expect(visibleNoteTitles(harness, containerID)).toEqual([
      'Notero Sync Incomplete — Synthetic note',
    ]);
  });

  for (const failure of [
    {
      classification: 'TRANSIENT_RETRY_SCHEDULED',
      code: APIErrorCode.ConflictError,
      latestHTML: '<p>Latest source after conflict halt</p>',
      retryAfter: undefined,
      status: 409,
      waitMs: 1_000,
    },
    {
      classification: 'TRANSIENT_RETRY_SCHEDULED',
      code: APIErrorCode.RateLimited,
      latestHTML: '<p>Latest source after rate-limit halt</p>',
      retryAfter: '7',
      status: 429,
      waitMs: 7_000,
    },
  ] as const) {
    it(`halts candidate creation once on transient HTTP ${failure.status}, waits, then recovers with the latest source`, async () => {
      const clock = new FakeRuntimeClock();
      const harness = createHarness('<p>Synthetic text</p>', () =>
        clock.nowEpochMs(),
      );
      const options = {
        ...target,
        imageSyncEnabled: false,
        runtimeClock: clock,
      };
      await syncNoteItem(harness.noteItem, harness.server.client(), options);
      const oldActiveID = storedNote(harness).active.block.blockID;
      harness.setNoteHTML(`<p>Changed before HTTP ${failure.status}</p>`);
      harness.server.failNextAppend(
        httpFailure(failure.code, failure.status, failure.retryAfter),
      );
      const appendCountBefore = harness.server.appendCount;

      await expect(
        syncNoteItem(harness.noteItem, harness.server.client(), options),
      ).rejects.toThrow(
        `Note synchronization halted: ${failure.classification}`,
      );

      const halted = nativeRoot(harness).notes[harness.noteItem.key];
      if (!isObject(halted) || !isObject(halted.mainTransaction)) {
        throw new Error('Expected a halted candidate transaction');
      }
      expect(halted.mainState).toBe('CANDIDATE_CREATING');
      expect(halted.mainTransaction).toMatchObject({
        candidate: null,
        operationIntent: null,
        runHalt: {
          classification: failure.classification,
          nextRetryAt: expect.any(String),
        },
      });
      expect(storedNote(harness).active.block.blockID).toBe(oldActiveID);
      expect(harness.server.appendCount).toBe(appendCountBefore + 1);

      await expect(
        syncNoteItem(harness.noteItem, harness.server.client(), options),
      ).rejects.toThrow(
        'Note synchronization halted: TRANSIENT_RETRY_SCHEDULED',
      );
      expect(harness.server.appendCount).toBe(appendCountBefore + 1);
      harness.setNoteHTML(failure.latestHTML);
      clock.advance(failure.waitMs);

      await expect(
        syncNoteItem(harness.noteItem, harness.server.client(), options),
      ).resolves.toBeUndefined();
      expect(storedNote(harness).mainState).toBe('IDLE');
      expect(storedNote(harness).active.block.blockID).not.toBe(oldActiveID);
    });
  }

  for (const failure of [
    {
      classification: 'AUTH_REQUIRED',
      code: APIErrorCode.Unauthorized,
      status: 401,
    },
    {
      classification: 'PERMISSION_REQUIRED',
      code: APIErrorCode.RestrictedResource,
      status: 403,
    },
    {
      classification: 'VALIDATION_FAILED',
      code: APIErrorCode.ValidationError,
      status: 400,
    },
  ] as const) {
    it(`halts candidate creation once on permanent HTTP ${failure.status} and permits explicit recovery in a new invocation`, async () => {
      const clock = new FakeRuntimeClock();
      const harness = createHarness('<p>Synthetic text</p>', () =>
        clock.nowEpochMs(),
      );
      const options = {
        ...target,
        imageSyncEnabled: false,
        runtimeClock: clock,
      };
      await syncNoteItem(harness.noteItem, harness.server.client(), options);
      const oldActiveID = storedNote(harness).active.block.blockID;
      harness.setNoteHTML(`<p>Changed before HTTP ${failure.status}</p>`);
      harness.server.failNextAppend(
        httpFailure(failure.code, failure.status, undefined),
      );
      const appendCountBefore = harness.server.appendCount;

      await expect(
        syncNoteItem(harness.noteItem, harness.server.client(), options),
      ).rejects.toThrow(
        `Note synchronization halted: ${failure.classification}`,
      );

      const halted = nativeRoot(harness).notes[harness.noteItem.key];
      if (!isObject(halted) || !isObject(halted.mainTransaction)) {
        throw new Error('Expected a halted candidate transaction');
      }
      expect(halted.mainState).toBe('CANDIDATE_CREATING');
      expect(halted.mainTransaction).toMatchObject({
        candidate: null,
        operationIntent: null,
        runHalt: {
          classification: failure.classification,
          nextRetryAt: null,
        },
      });
      expect(storedNote(harness).active.block.blockID).toBe(oldActiveID);
      expect(harness.server.appendCount).toBe(appendCountBefore + 1);

      await expect(
        syncNoteItem(harness.noteItem, harness.server.client(), options),
      ).resolves.toBeUndefined();
      expect(storedNote(harness).mainState).toBe('IDLE');
      expect(storedNote(harness).active.block.blockID).not.toBe(oldActiveID);
    });
  }

  it('creates a native v4 active, skips an unchanged resync, and safely replaces changed text', async () => {
    const harness = createHarness();
    const options = { ...target, imageSyncEnabled: false };

    await syncNoteItem(harness.noteItem, harness.server.client(), options);
    const first = nativeRoot(harness);
    const oldActiveID = storedNote(harness).active.block.blockID;
    const mutationCount = harness.server.events.filter(
      ({ type }) => type === 'remote-mutation-committed',
    ).length;
    expect(first.schemaVersion).toBe(4);
    expect(first.notes[harness.noteItem.key]).toMatchObject({
      mainState: 'IDLE',
      active: { sourceVersion: expect.any(String) },
    });

    await syncNoteItem(harness.noteItem, harness.server.client(), options);
    expect(
      harness.server.events.filter(
        ({ type }) => type === 'remote-mutation-committed',
      ),
    ).toHaveLength(mutationCount);

    harness.setNoteHTML('<p>Changed synthetic text</p>');
    await syncNoteItem(harness.noteItem, harness.server.client(), options);
    const replaced = storedNote(harness);
    expect(replaced.active.block.blockID).not.toBe(oldActiveID);
    expect(harness.server.blocks.get(oldActiveID)?.response.in_trash).toBe(
      true,
    );
    expect(replaced.cleanupLedger).toMatchObject([
      { resource: { blockID: oldActiveID }, state: 'CONFIRMED' },
    ]);
    expect(
      getSyncedNotes(harness.parentItem).notes?.[harness.noteItem.key],
    ).toMatchObject({
      blockID: replaced.active.block.blockID,
      state: 'IDLE',
    });
  });

  it('batches 101 content blocks without exposing a partial candidate', async () => {
    const harness = createHarness();
    const converter = vi.fn<NonNullable<NoteSyncOptions['blockConverter']>>(
      () => blocks101,
    );

    await syncNoteItem(harness.noteItem, harness.server.client(), {
      ...target,
      blockConverter: converter,
      imageSyncEnabled: false,
    });

    const record = storedNote(harness);
    expect(record.active).not.toBeNull();
    expect(
      harness.server.visibleChildren(record.active.block.blockID),
    ).toHaveLength(101);
    expect(record.active.completionEvidence.expectedBlockCount).toBe(101);
    expect(record.active.completionEvidence.verifiedAt).toEqual(
      expect.any(String),
    );
    const finalizationEvents = harness.server.events.filter(
      ({ operation }) => operation === 'update',
    );
    expect(
      finalizationEvents.filter(
        ({ type }) => type === 'remote-mutation-committed',
      ),
    ).toHaveLength(1);
    expect(
      finalizationEvents.filter(({ type }) => type === 'response-delivered'),
    ).toHaveLength(1);
  });

  it('Feature OFF never resolves or uploads an embedded image', async () => {
    const harness = createHarness(
      '<p>Before</p><img data-attachment-key="IMAGEA"><p>After</p>',
    );

    await syncNoteItem(harness.noteItem, harness.server.client(), {
      ...target,
      imageSyncEnabled: false,
    });

    expect(zoteroMock.Items.getByLibraryAndKey.mock.calls).toHaveLength(0);
    expect(harness.server.createUploadCount).toBe(0);
    expect(nativeRoot(harness).notes[harness.noteItem.key]).toMatchObject({
      requestedSource: { featurePolicy: 'text-only-v1' },
      uploadAssets: [],
    });
  });

  it('uploads one image once and reuses attached evidence after a text-only change', async () => {
    const harness = createHarness(
      '<p>Before</p><img data-attachment-key="IMAGEA"><p>After</p>',
    );
    installImage(harness);
    const options = { ...target, imageSyncEnabled: true };

    await syncNoteItem(harness.noteItem, harness.server.client(), options);
    expect(harness.server.createUploadCount).toBe(1);
    expect(harness.server.sendUploadCount).toBe(1);
    let record = storedNote(harness);
    expect(record.uploadAssets).toMatchObject([
      { attachedAt: expect.any(String), expiryTime: null, status: 'ATTACHED' },
    ]);

    harness.setNoteHTML(
      '<p>Changed</p><img data-attachment-key="IMAGEA"><p>After</p>',
    );
    await syncNoteItem(harness.noteItem, harness.server.client(), options);

    expect(harness.server.createUploadCount).toBe(1);
    expect(harness.server.sendUploadCount).toBe(1);
    record = storedNote(harness);
    expect(record.active.imageAssetIdentities).toHaveLength(1);
    expect(record.uploadAssets).toHaveLength(1);
  });

  it('handles image add, delete, reorder, and same-key content replacement without duplicate uploads', async () => {
    const harness = createHarness(
      '<p>A</p><img data-attachment-key="IMAGEA"><p>Z</p>',
    );
    const images = installMutableImages(harness);
    images.put('IMAGEA', 'image/png', validPngBytes);
    const options = { ...target, imageSyncEnabled: true };

    await syncNoteItem(harness.noteItem, harness.server.client(), options);
    expect(harness.server.createUploadCount).toBe(1);

    images.put('IMAGEB', 'image/png', validPngBytes);
    harness.setNoteHTML(
      '<img data-attachment-key="IMAGEA"><p>middle</p><img data-attachment-key="IMAGEB">',
    );
    await syncNoteItem(harness.noteItem, harness.server.client(), options);
    expect(harness.server.createUploadCount).toBe(2);
    expect(storedNote(harness).active.imageAssetIdentities).toHaveLength(2);

    harness.setNoteHTML(
      '<img data-attachment-key="IMAGEB"><p>middle</p><img data-attachment-key="IMAGEA">',
    );
    await syncNoteItem(harness.noteItem, harness.server.client(), options);
    expect(harness.server.createUploadCount).toBe(2);

    harness.setNoteHTML('<p>only B</p><img data-attachment-key="IMAGEB">');
    await syncNoteItem(harness.noteItem, harness.server.client(), options);
    expect(harness.server.createUploadCount).toBe(2);
    expect(storedNote(harness).active.imageAssetIdentities).toHaveLength(1);

    images.put('IMAGEB', 'image/jpeg', validJpegBytes);
    await syncNoteItem(harness.noteItem, harness.server.client(), options);
    expect(harness.server.createUploadCount).toBe(3);
    expect(storedNote(harness).active.imageAssetIdentities).toHaveLength(1);
  });

  it('migrates bare legacy IDs as immutable evidence without adopting or deleting them', async () => {
    const harness = createHarness();
    const legacyContainer = 'legacy-container';
    const legacyNote = 'legacy-note';
    harness.setMetadata({
      containerBlockID: legacyContainer,
      noteBlockIDs: { [harness.noteItem.key]: legacyNote },
    });
    harness.server.seedHeading(
      legacyContainer,
      pageID,
      'page_id',
      {
        heading_1: {
          is_toggleable: true,
          rich_text: buildManagedHeadingRichText('Legacy', ['legacy-marker']),
        },
      },
      'legacy-creator',
    );
    harness.server.seedHeading(
      legacyNote,
      legacyContainer,
      'block_id',
      {
        heading_1: {
          is_toggleable: true,
          rich_text: buildManagedHeadingRichText('Legacy note', [
            'legacy-note-marker',
          ]),
        },
      },
      'legacy-creator',
    );

    await syncNoteItem(harness.noteItem, harness.server.client(), {
      ...target,
      imageSyncEnabled: false,
    });

    const root = nativeRoot(harness);
    expect(root.legacy).toEqual({
      containerBlockID: legacyContainer,
      noteBlockIDs: { [harness.noteItem.key]: legacyNote },
    });
    expect(storedNote(harness).active.block.blockID).not.toBe(legacyNote);
    expect(harness.server.blocks.get(legacyContainer)?.response.in_trash).toBe(
      false,
    );
    expect(harness.server.blocks.get(legacyNote)?.response.in_trash).toBe(
      false,
    );
  });

  it('shares one managed container while keeping two child-note records independent', async () => {
    const harness = createHarness();
    const secondNote = createNote(harness.parentItem, '<p>Second note</p>');
    const options = { ...target, imageSyncEnabled: false };

    await syncNoteItem(harness.noteItem, harness.server.client(), options);
    await syncNoteItem(secondNote, harness.server.client(), options);

    const root = nativeRoot(harness);
    expect(Object.keys(root.notes)).toEqual(
      expect.arrayContaining([harness.noteItem.key, secondNote.key]),
    );
    expect(storedNote(harness).active.block.blockID).not.toBe(
      storedNote(harness, secondNote).active.block.blockID,
    );
    expect(harness.server.visibleChildren(pageID)).toHaveLength(1);
  });

  it('refuses to adopt a canonical container from another target scope', async () => {
    const harness = createHarness();
    await syncNoteItem(harness.noteItem, harness.server.client(), {
      ...target,
      imageSyncEnabled: false,
    });
    const mutationCount = harness.server.events.filter(
      ({ type }) => type === 'remote-mutation-committed',
    ).length;
    const secondNote = createNote(harness.parentItem, '<p>Other target</p>');

    await expect(
      syncNoteItem(secondNote, harness.server.client(), {
        ...target,
        imageSyncEnabled: false,
        workspaceID: 'workspace-b',
      }),
    ).rejects.toThrow(/target (?:digest|scope)/i);

    expect(
      harness.server.events.filter(
        ({ type }) => type === 'remote-mutation-committed',
      ),
    ).toHaveLength(mutationCount);
    expect(nativeRoot(harness).notes[secondNote.key]).toBeUndefined();
  });
});
