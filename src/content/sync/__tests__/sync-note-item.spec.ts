import { describe, expect, it } from 'vite-plus/test';

import { createZoteroItemMock } from '../../../../test/utils';
import { syncNoteItem } from '../sync-note-item';

import { StatefulNotionServer } from './stateful-notion-fake';

const pageID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const options = {
  connectionID: 'bot-a',
  databaseID: 'database-a',
  imageSyncEnabled: false,
  workspaceID: 'workspace-a',
};

function setup(metadata?: string) {
  const parent = createZoteroItemMock({ libraryID: 1 });
  const note = createZoteroItemMock({ libraryID: 1 });
  const link = createZoteroItemMock({ libraryID: 1 });
  note.isTopLevelItem.mockReturnValue(false);
  parent.isRegularItem.mockReturnValue(true);
  note.topLevelItem = parent;
  note.getNote.mockReturnValue('<p>Synthetic</p>');
  note.getNoteTitle.mockReturnValue('Synthetic');
  parent.getAttachments.mockReturnValue([link.id]);
  link.getField.mockImplementation((field) =>
    field === 'url' ? `https://www.notion.so/${pageID}` : '',
  );
  link.getNote.mockReturnValue(
    metadata ? `<pre id="notero-synced-notes">${metadata}</pre>` : '',
  );
  const server = new StatefulNotionServer(options.connectionID, pageID);
  return { link, note, parent, server };
}

describe('syncNoteItem transaction boundary', () => {
  it('rejects a top-level note before any remote access', async () => {
    const { note, server } = setup();
    note.isTopLevelItem.mockReturnValue(true);

    await expect(syncNoteItem(note, server.client(), options)).rejects.toThrow(
      'Cannot sync note without a parent item',
    );
    expect(server.events).toEqual([]);
  });

  it('rejects an unsynchronized parent before any remote access', async () => {
    const { note, parent, server } = setup();
    parent.getAttachments.mockReturnValue([]);

    await expect(syncNoteItem(note, server.client(), options)).rejects.toThrow(
      'parent item is not synced',
    );
    expect(server.events).toEqual([]);
  });

  it('quarantines feature-v2 transaction metadata without running old stage recovery', async () => {
    const { link, note, server } = setup(
      JSON.stringify({
        notes: {
          [noteKeyPlaceholder]: {
            stage: 'candidate-persisted',
            transaction: { stage: 'old-delete-confirmed' },
          },
        },
        schemaVersion: 2,
      }).replace(noteKeyPlaceholder, 'synthetic-note'),
    );
    // The actual key is intentionally irrelevant: v2 is rejected at root.
    link.getNote.mockReturnValue(
      '<pre id="notero-synced-notes">{"schemaVersion":2,"notes":{}}</pre>',
    );

    await expect(syncNoteItem(note, server.client(), options)).rejects.toThrow(
      /feature-v2 transaction metadata is quarantined/i,
    );
    expect(server.events).toEqual([]);
  });

  it.each([
    ['malformed JSON', '{broken'],
    ['future schema', JSON.stringify({ notes: {}, schemaVersion: 99 })],
  ])(
    'preserves %s metadata and performs no remote mutation',
    async (_name, raw) => {
      const { link, note, server } = setup(raw);
      const before = link.getNote();

      await expect(
        syncNoteItem(note, server.client(), options),
      ).rejects.toThrow(/metadata|schema|JSON/i);

      expect(link.getNote()).toBe(before);
      expect(server.events).toEqual([]);
      expect(link.setNote.mock.calls).toHaveLength(0);
    },
  );

  it('requires a complete target identity before source or remote mutation', async () => {
    const { note, server } = setup();

    await expect(
      syncNoteItem(note, server.client(), { imageSyncEnabled: false }),
    ).rejects.toThrow(/connection, database, and workspace identity/i);
    expect(server.events).toEqual([]);
  });
});

const noteKeyPlaceholder = 'synthetic-note';
