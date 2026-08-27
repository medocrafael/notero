import { describe, expect, it } from 'vite-plus/test';

import { createZoteroItemMock, mockZoteroPrefs } from '../../../../test/utils';
import { NoteroPref, setNoteroPref } from '../../prefs/notero-pref';
import {
  getSyncedNotesFromAttachment,
  saveNotionLinkAttachment,
} from '../item-data';

describe('getSyncedNotesFromAttachment', () => {
  it('returns an empty state for corrupt JSON instead of throwing', () => {
    const attachment = createZoteroItemMock();
    attachment.getNote.mockReturnValue(
      '<pre id="notero-synced-notes">{broken json</pre>',
    );

    expect(getSyncedNotesFromAttachment(attachment)).toStrictEqual({
      diagnostics: [
        {
          path: '$',
          reason: 'invalid-json',
          summary: 'string(length=12)',
        },
      ],
      metadataCorrupt: true,
    });
  });

  it.each([
    { containerBlockID: 123 },
    { noteBlockIDs: { keyA: false } },
    { notes: { keyA: { blockID: 123 } } },
    { notes: { keyA: { blockID: 'block-a', images: [{}] } } },
    { notes: { keyA: { blockID: 'block-a', syncedAt: 'invalid' } } },
  ])(
    'isolates structurally corrupt metadata fields with diagnostics',
    (value) => {
      const attachment = createZoteroItemMock();
      attachment.getNote.mockReturnValue(
        `<pre id="notero-synced-notes">${JSON.stringify(value)}</pre>`,
      );

      const parsed = getSyncedNotesFromAttachment(attachment);
      expect(parsed.metadataCorrupt).not.toBe(true);
      expect(parsed.diagnostics).toHaveLength(1);
      expect(parsed.schemaVersion).toBe(1);
    },
  );

  it('loads expected data when synced notes are saved in original format', () => {
    const json = JSON.stringify({
      containerBlockID: 'container',
      noteBlockIDs: {
        keyA: 'blockA',
        keyB: 'blockB',
      },
    });
    const attachment = createZoteroItemMock();
    attachment.getNote.mockReturnValue(
      `<pre id="notero-synced-notes">${json}</pre>`,
    );

    expect(getSyncedNotesFromAttachment(attachment)).toStrictEqual({
      containerBlockID: 'container',
      notes: {
        keyA: {
          blockID: 'blockA',
          ownershipStatus: 'legacy-unverified',
        },
        keyB: {
          blockID: 'blockB',
          ownershipStatus: 'legacy-unverified',
        },
      },
      schemaVersion: 1,
    });
  });

  it('loads expected data when synced notes are saved in updated format', () => {
    const dateA = new Date(1000000000000);
    const dateB = new Date(1777777777777);
    const json = JSON.stringify({
      containerBlockID: 'container',
      notes: {
        keyA: {
          blockID: 'blockA',
          ownershipStatus: 'legacy-unverified',
          syncedAt: dateA,
        },
        keyB: {
          blockID: 'blockB',
          ownershipStatus: 'legacy-unverified',
          syncedAt: dateB,
        },
      },
      schemaVersion: 1,
    });
    const attachment = createZoteroItemMock();
    attachment.getNote.mockReturnValue(
      `<pre id="notero-synced-notes">${json}</pre>`,
    );

    expect(getSyncedNotesFromAttachment(attachment)).toStrictEqual({
      containerBlockID: 'container',
      notes: {
        keyA: {
          blockID: 'blockA',
          ownershipStatus: 'legacy-unverified',
          syncedAt: dateA,
        },
        keyB: {
          blockID: 'blockB',
          ownershipStatus: 'legacy-unverified',
          syncedAt: dateB,
        },
      },
      schemaVersion: 1,
    });
  });

  it('loads target-scoped image cache and complete candidate metadata', () => {
    const completedAt = new Date(1700000000000);
    const target = {
      connectionID: 'bot-a',
      databaseID: 'database-a',
      pageID: 'page-a',
      workspaceID: 'workspace-a',
    };
    const image = {
      attachmentKey: 'IMAGEA',
      contentHash: 'hash-a',
      contentType: 'image/png',
      fileUploadID: 'upload-a',
      filename: 'IMAGEA.png',
      size: 9,
    };
    const json = JSON.stringify({
      containerBlockID: 'container',
      notes: {
        keyA: {
          blockID: 'old-block',
          candidate: {
            blockID: 'candidate-block',
            completedAt,
            images: [image],
            ownershipStatus: 'legacy-unverified',
            previousBlockID: 'old-block',
            sourceHash: 'source-a',
            target,
          },
          images: [image],
          orphanBlockIDs: ['orphan-a'],
          ownershipStatus: 'legacy-unverified',
          sourceHash: 'old-source',
          target,
        },
      },
      schemaVersion: 1,
    });
    const attachment = createZoteroItemMock();
    attachment.getNote.mockReturnValue(
      `<pre id="notero-synced-notes">${json}</pre>`,
    );

    expect(getSyncedNotesFromAttachment(attachment)).toStrictEqual({
      containerBlockID: 'container',
      notes: {
        keyA: {
          blockID: 'old-block',
          candidate: {
            blockID: 'candidate-block',
            completedAt,
            images: [image],
            ownershipStatus: 'legacy-unverified',
            previousBlockID: 'old-block',
            sourceHash: 'source-a',
            target,
          },
          images: [image],
          orphanBlockIDs: ['orphan-a'],
          ownershipStatus: 'legacy-unverified',
          sourceHash: 'old-source',
          target,
        },
      },
      schemaVersion: 1,
    });
  });

  it('isolates one corrupt note while preserving another valid note', () => {
    const attachment = createZoteroItemMock();
    attachment.getNote.mockReturnValue(
      `<pre id="notero-synced-notes">${JSON.stringify({
        schemaVersion: 2,
        notes: {
          bad: { blockID: 'bad-block', images: [{}] },
          good: { blockID: 'good-block', syncedAt: new Date(0) },
        },
      })}</pre>`,
    );

    const parsed = getSyncedNotesFromAttachment(attachment);

    expect(parsed.metadataCorrupt).not.toBe(true);
    expect(parsed.notes?.good).toMatchObject({ blockID: 'good-block' });
    expect(parsed.notes?.bad).toMatchObject({ blockID: 'bad-block' });
    expect(parsed.notes?.bad?.images).toBeUndefined();
    expect(parsed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'notes.bad.images' }),
      ]),
    );
  });

  it('keeps legacy records explicitly unverified instead of granting mutation authority', () => {
    const attachment = createZoteroItemMock();
    attachment.getNote.mockReturnValue(
      '<pre id="notero-synced-notes">{"containerBlockID":"legacy-container","noteBlockIDs":{"keyA":"legacy-note"}}</pre>',
    );

    expect(getSyncedNotesFromAttachment(attachment)).toMatchObject({
      notes: {
        keyA: {
          blockID: 'legacy-note',
          ownershipStatus: 'legacy-unverified',
        },
      },
      schemaVersion: 1,
    });
  });

  it('accepts unknown future fields without corrupting known safe records', () => {
    const attachment = createZoteroItemMock();
    attachment.getNote.mockReturnValue(
      `<pre id="notero-synced-notes">${JSON.stringify({
        futureTopLevel: { enabled: true },
        notes: {
          keyA: {
            blockID: 'block-a',
            futureNoteField: { value: 7 },
          },
        },
        schemaVersion: 99,
      })}</pre>`,
    );

    const parsed = getSyncedNotesFromAttachment(attachment);

    expect(parsed.metadataCorrupt).not.toBe(true);
    expect(parsed.notes?.keyA).toMatchObject({ blockID: 'block-a' });
    expect(parsed.preservedUnknown).toMatchObject({
      futureTopLevel: { enabled: true },
    });
  });
});

describe('saveNotionLinkAttachment', () => {
  it('preserves synced notes when `syncNotes` is disabled', async () => {
    mockZoteroPrefs();
    setNoteroPref(NoteroPref.syncNotes, false);
    const pageURL =
      'notion://www.notion.so/page-00000000000000000000000000000000';
    const syncedNotes =
      '<pre id="notero-synced-notes">{"existing":"notes"}</pre>';
    const item = createZoteroItemMock();
    const attachment = createZoteroItemMock();
    item.getAttachments.mockReturnValue([attachment.id]);
    attachment.getField.calledWith('url').mockReturnValue(pageURL);
    attachment.getNote.mockReturnValue(syncedNotes);

    await saveNotionLinkAttachment(item, pageURL);

    // oxlint-disable-next-line typescript/unbound-method
    expect(attachment.setNote).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(syncedNotes),
    );
  });

  it('preserves synced notes when page ID does not change', async () => {
    mockZoteroPrefs();
    setNoteroPref(NoteroPref.syncNotes, true);
    const pageURL =
      'notion://www.notion.so/page-00000000000000000000000000000000';
    const syncedNotes =
      '<pre id="notero-synced-notes">{"existing":"notes"}</pre>';
    const item = createZoteroItemMock();
    const attachment = createZoteroItemMock();
    item.getAttachments.mockReturnValue([attachment.id]);
    attachment.getField.calledWith('url').mockReturnValue(pageURL);
    attachment.getNote.mockReturnValue(syncedNotes);

    await saveNotionLinkAttachment(item, pageURL);

    // oxlint-disable-next-line typescript/unbound-method
    expect(attachment.setNote).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(syncedNotes),
    );
  });

  it('resets synced notes when page ID changes', async () => {
    mockZoteroPrefs();
    setNoteroPref(NoteroPref.syncNotes, true);
    const oldPageURL =
      'notion://www.notion.so/old-page-00000000000000000000000000000000';
    const newPageURL =
      'notion://www.notion.so/new-page-77777777777777777777777777777777';
    const syncedNotes =
      '<pre id="notero-synced-notes">{"existing":"notes"}</pre>';
    const item = createZoteroItemMock();
    const attachment = createZoteroItemMock();
    item.getAttachments.mockReturnValue([attachment.id]);
    attachment.getField.calledWith('url').mockReturnValue(oldPageURL);
    attachment.getNote.mockReturnValue(syncedNotes);

    await saveNotionLinkAttachment(item, newPageURL);

    // oxlint-disable-next-line typescript/unbound-method
    expect(attachment.setNote).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('<pre id="notero-synced-notes">{}</pre>'),
    );
  });
});
