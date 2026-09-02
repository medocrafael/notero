import { describe, expect, it, vi } from 'vite-plus/test';

import { createZoteroItemMock, mockZoteroPrefs } from '../../../../test/utils';
import { NoteroPref, setNoteroPref } from '../../prefs/notero-pref';
import {
  candidateV4,
  clockV4,
  sourceVersionV4,
  targetV4,
} from '../../sync/note-sync-transaction/__tests__/fixtures-v4';
import {
  createIdleRecordV4,
  deriveDurableActive,
} from '../../sync/note-sync-transaction/model-v4';
import { serializeSyncedNotesRootV4 } from '../../sync/note-sync-transaction/schema-v4';
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

  it('quarantines unpublished feature-v3 metadata', () => {
    const attachment = attachmentWithMetadata({ notes: {}, schemaVersion: 3 });

    expect(getSyncedNotesFromAttachment(attachment)).toMatchObject({
      diagnostics: [
        { path: '$', reason: 'feature-v3-transaction-unsupported' },
      ],
      metadataCorrupt: true,
    });
  });

  it('projects a native v4 authoritative active for UI and queue consumers', () => {
    const candidate = candidateV4('DURABLE');
    const active = deriveDurableActive(
      candidate,
      'text-only-v1',
      clockV4.nowISOString(),
    );
    const native = {
      ...createIdleRecordV4(targetV4, clockV4),
      active,
      container: active.container,
      requestedSource: {
        featurePolicy: 'text-only-v1' as const,
        manifestDigest: active.manifestDigest,
        observedAt: clockV4.nowISOString(),
        sourceDescriptor: active.sourceDescriptor,
        sourceVersion: sourceVersionV4,
      },
    };
    const attachment = attachmentWithMetadata(
      serializeSyncedNotesRootV4({
        container: active.container,
        notes: { [targetV4.noteItemKey]: native },
        rootRevision: 0,
        schemaVersion: 4,
      }),
    );

    expect(getSyncedNotesFromAttachment(attachment)).toMatchObject({
      containerBlockID: active.container.blockID,
      notes: {
        [targetV4.noteItemKey]: {
          blockID: active.block.blockID,
          state: 'IDLE',
          syncedAt: new Date('2026-08-30T00:00:00.000Z'),
        },
      },
      schemaVersion: 4,
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
      JSON.stringify({ notes: {}, schemaVersion: 4 }),
    );
    expect(note).toContain(
      '<pre id="notero-synced-notes">{"notes":{},"schemaVersion":4}</pre>',
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
      '<pre id="notero-synced-notes">{"notes":{},"schemaVersion":4}</pre>',
    );

    await saveNotionLinkAttachment(item, pageURL);

    expect(vi.mocked(attachment).setNote.mock.lastCall?.[0]).toEqual(
      expect.stringContaining('{"notes":{},"schemaVersion":4}'),
    );
  });
});
