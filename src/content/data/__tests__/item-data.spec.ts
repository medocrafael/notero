import { describe, expect, it, vi } from 'vite-plus/test';

import { createZoteroItemMock, mockZoteroPrefs } from '../../../../test/utils';
import { NoteroPref, setNoteroPref } from '../../prefs/notero-pref';
import {
  record,
  target,
  version,
} from '../../sync/note-sync-transaction/__tests__/fixtures';
import { serializeNoteSyncRecord } from '../../sync/note-sync-transaction/schema';
import {
  getSyncedNotesFromAttachment,
  saveNotionLinkAttachment,
  saveRawSyncedNotesMetadata,
} from '../item-data';

function attachmentWithMetadata(value: unknown): Zotero.Item {
  const attachment = createZoteroItemMock();
  attachment.getNote.mockReturnValue(
    `<pre id="notero-synced-notes">${typeof value === 'string' ? value : JSON.stringify(value)}</pre>`,
  );
  return attachment;
}

describe('getSyncedNotesFromAttachment', () => {
  it('reports malformed JSON without throwing or rewriting bytes', () => {
    const attachment = attachmentWithMetadata('{broken json');

    expect(getSyncedNotesFromAttachment(attachment)).toEqual({
      diagnostics: [
        {
          path: '$',
          reason: 'invalid-json',
          summary: 'string(length=12)',
        },
      ],
      metadataCorrupt: true,
    });
    expect(vi.mocked(attachment).setNote.mock.calls).toHaveLength(0);
  });

  it('projects formal main legacy IDs only as immutable evidence', () => {
    const attachment = attachmentWithMetadata({
      containerBlockID: 'legacy-container',
      noteBlockIDs: { NOTE: 'legacy-note' },
    });

    expect(getSyncedNotesFromAttachment(attachment)).toEqual({
      containerBlockID: 'legacy-container',
      legacy: {
        containerBlockID: 'legacy-container',
        noteBlockIDs: { NOTE: 'legacy-note' },
      },
      notes: { NOTE: { blockID: 'legacy-note' } },
      schemaVersion: 1,
    });
  });

  it('quarantines unpublished feature-v2 metadata instead of parsing stages', () => {
    const attachment = attachmentWithMetadata({
      notes: { NOTE: { transaction: { stage: 'candidate-persisted' } } },
      schemaVersion: 2,
    });

    expect(getSyncedNotesFromAttachment(attachment)).toMatchObject({
      diagnostics: [
        { path: '$', reason: 'feature-v2-transaction-unsupported' },
      ],
      metadataCorrupt: true,
    });
  });

  it('projects a native v3 authoritative active for UI and queue consumers', () => {
    const active = version();
    const native = record('IDLE', { active });
    const attachment = attachmentWithMetadata({
      container: active.container,
      notes: {
        [target.noteItemKey]: JSON.parse(serializeNoteSyncRecord(native)),
      },
      schemaVersion: 3,
    });

    expect(getSyncedNotesFromAttachment(attachment)).toMatchObject({
      containerBlockID: active.container.blockID,
      notes: {
        [target.noteItemKey]: {
          blockID: active.block.blockID,
          state: 'IDLE',
          syncedAt: new Date('2026-08-30T00:00:00.000Z'),
        },
      },
      schemaVersion: 3,
    });
  });

  it('preserves an unsupported future schema as a read-only record', () => {
    const attachment = attachmentWithMetadata({ notes: {}, schemaVersion: 99 });

    expect(getSyncedNotesFromAttachment(attachment)).toMatchObject({
      unsupportedFutureSchema: {
        rawJSON: expect.any(String),
        schemaVersion: 99,
      },
    });
    expect(vi.mocked(attachment).setNote.mock.calls).toHaveLength(0);
  });
});

describe('raw note metadata persistence', () => {
  it('writes an exact object root and refuses invalid JSON', async () => {
    const item = createZoteroItemMock();
    const attachment = createZoteroItemMock();
    let note = '';
    item.getAttachments.mockReturnValue([attachment.id]);
    attachment.getField.mockReturnValue(
      'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    attachment.getNote.mockImplementation(() => note);
    attachment.setNote.mockImplementation((value) => {
      note = value;
      return true;
    });

    await saveRawSyncedNotesMetadata(
      item,
      JSON.stringify({ notes: {}, schemaVersion: 3 }),
    );
    expect(note).toContain(
      '<pre id="notero-synced-notes">{"notes":{},"schemaVersion":3}</pre>',
    );
    await expect(saveRawSyncedNotesMetadata(item, '{broken')).rejects.toThrow(
      'invalid note sync metadata JSON',
    );
  });
});

describe('saveNotionLinkAttachment', () => {
  it('preserves raw metadata when note sync is disabled and the page is unchanged', async () => {
    mockZoteroPrefs();
    setNoteroPref(NoteroPref.syncNotes, false);
    const pageURL = 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const item = createZoteroItemMock();
    const attachment = createZoteroItemMock();
    item.getAttachments.mockReturnValue([attachment.id]);
    attachment.getField.mockReturnValue(pageURL);
    attachment.getNote.mockReturnValue(
      '<pre id="notero-synced-notes">{"notes":{},"schemaVersion":3}</pre>',
    );

    await saveNotionLinkAttachment(item, pageURL);

    expect(vi.mocked(attachment).setNote.mock.lastCall?.[0]).toEqual(
      expect.stringContaining('{"notes":{},"schemaVersion":3}'),
    );
  });
});
