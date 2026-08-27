import { type Client } from '@notionhq/client';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { mockDeep } from 'vitest-mock-extended';

import {
  createWindowMock,
  createZoteroItemMock,
  mockZoteroPrefs,
} from '../../../../test/utils';
import {
  NoteroPref,
  PageTitleFormat,
  setNoteroPref,
} from '../../prefs/notero-pref';

type GetNotionClient = typeof import('../notion-client').getNotionClient;
type SyncNoteItem = typeof import('../sync-note-item').syncNoteItem;

const mocks = vi.hoisted(() => ({
  getNotionClient: vi.fn<GetNotionClient>(),
  progressWindow: {
    complete: vi.fn<() => void>(),
    fail: vi.fn<() => void>(),
    show: vi.fn<() => Promise<void>>(async () => undefined),
    updateProgress: vi.fn<(step: number) => void>(),
    updateText: vi.fn<(step: number) => Promise<void>>(async () => undefined),
  },
  syncNoteItem: vi.fn<SyncNoteItem>(async () => undefined),
}));

vi.mock('../notion-client', () => ({
  getNotionClient: mocks.getNotionClient,
}));
vi.mock('../progress-window', () => ({
  ProgressWindow: function ProgressWindowMock() {
    return mocks.progressWindow;
  },
}));
vi.mock('../sync-note-item', () => ({ syncNoteItem: mocks.syncNoteItem }));

import { performSyncJob } from '../sync-job';

describe('feature-off preparation compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockZoteroPrefs();
    setNoteroPref(NoteroPref.notionDatabaseID, 'database-a');
    setNoteroPref(NoteroPref.pageTitleFormat, PageTitleFormat.itemTitle);
    setNoteroPref(NoteroPref.syncNoteImages, false);
  });

  it('does not request image-only workspace limits from users.me()', async () => {
    const notion = mockDeep<Client>();
    notion.databases.retrieve.mockResolvedValue({
      archived: false,
      cover: null,
      created_by: { id: 'bot-a', object: 'user' },
      created_time: new Date(0).toISOString(),
      description: [],
      icon: null,
      id: 'database-a',
      in_trash: false,
      is_inline: false,
      last_edited_by: { id: 'bot-a', object: 'user' },
      last_edited_time: new Date(0).toISOString(),
      object: 'database',
      parent: { page_id: 'parent-a', type: 'page_id' },
      properties: {},
      public_url: null,
      title: [],
      url: 'https://www.notion.so/database-a',
    });
    mocks.getNotionClient.mockReturnValue(notion);
    const note = createZoteroItemMock();
    note.isNote.mockReturnValue(true);

    await performSyncJob(
      new Set([note.id]),
      async () => ({
        accessToken: 'synthetic-token',
        connectionID: 'bot-a',
        workspaceID: 'workspace-a',
      }),
      createWindowMock(),
    );

    expect(notion.users.me).not.toHaveBeenCalled();
    expect(mocks.syncNoteItem).toHaveBeenCalledWith(
      note,
      notion,
      expect.objectContaining({ imageSyncEnabled: false }),
    );
  });
});
