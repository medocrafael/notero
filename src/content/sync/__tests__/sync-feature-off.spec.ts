import { type Client } from '@notionhq/client';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { mockDeep } from 'vitest-mock-extended';

import {
  createWindowMock,
  createZoteroItemMock,
  mockZoteroPrefs,
  zoteroMock,
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

function setupNotion(): Client {
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
  return notion;
}

async function authenticateWithLegacyToken() {
  return { accessToken: 'synthetic-legacy-token' };
}

describe('feature-off preparation compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockZoteroPrefs();
    setNoteroPref(NoteroPref.notionDatabaseID, 'database-a');
    setNoteroPref(NoteroPref.pageTitleFormat, PageTitleFormat.itemTitle);
    setNoteroPref(NoteroPref.syncNoteImages, false);
  });

  it('does not request image-only workspace limits from users.me()', async () => {
    const notion = setupNotion();
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

  it('keeps legacy manual-token text sync independent of users.me and File Upload APIs', async () => {
    const notion = setupNotion();
    vi.mocked(notion.users.me).mockRejectedValue(
      new Error('Synthetic users.me permission failure'),
    );
    const note = createZoteroItemMock();
    note.isNote.mockReturnValue(true);

    await performSyncJob(
      new Set([note.id]),
      async () => ({ accessToken: 'synthetic-legacy-token' }),
      createWindowMock(),
    );

    expect(notion.users.me).not.toHaveBeenCalled();
    expect(notion.fileUploads.create).not.toHaveBeenCalled();
    expect(notion.fileUploads.send).not.toHaveBeenCalled();
    expect(mocks.syncNoteItem).toHaveBeenCalledWith(
      note,
      notion,
      expect.objectContaining({
        connectionID: expect.stringMatching(/^legacy-local:/),
        imageSyncEnabled: false,
        workspaceID: expect.stringMatching(/^legacy-local:/),
      }),
    );
  });

  it('keeps the local connection identity stable across Feature OFF to ON', async () => {
    const notion = setupNotion();
    const note = createZoteroItemMock();
    note.isNote.mockReturnValue(true);
    const window = createWindowMock();

    await performSyncJob(
      new Set([note.id]),
      authenticateWithLegacyToken,
      window,
    );
    const offOptions = mocks.syncNoteItem.mock.calls[0]?.[2];
    vi.mocked(notion.users.me).mockResolvedValue({
      avatar_url: null,
      bot: {
        owner: { type: 'workspace', workspace: true },
        workspace_limits: { max_file_upload_size_in_bytes: 20 * 1024 * 1024 },
        workspace_name: 'Synthetic workspace',
      },
      id: 'bot-real-after-enable',
      name: 'Synthetic integration',
      object: 'user',
      type: 'bot',
    });
    setNoteroPref(NoteroPref.syncNoteImages, true);

    await performSyncJob(
      new Set([note.id]),
      authenticateWithLegacyToken,
      window,
    );
    const onOptions = mocks.syncNoteItem.mock.calls[1]?.[2];

    expect(notion.users.me).toHaveBeenCalledTimes(1);
    expect(onOptions).toMatchObject({
      connectionID: offOptions?.connectionID,
      remoteCreatorID: 'bot-real-after-enable',
      workspaceID: offOptions?.workspaceID,
    });
  });

  it('falls back to a domain-separated identity when local legacy identity persistence fails without deleting remote content', async () => {
    const notion = setupNotion();
    vi.mocked(notion.users.me).mockRejectedValue(
      new Error('Synthetic users.me permission failure'),
    );
    zoteroMock.Prefs.set.mockImplementation((name) => {
      if (name.endsWith('.notionLegacyTargetID')) {
        throw new Error('Synthetic local identity persistence failure');
      }
      return undefined;
    });
    const note = createZoteroItemMock();
    note.isNote.mockReturnValue(true);

    await performSyncJob(
      new Set([note.id]),
      async () => ({ accessToken: 'synthetic-legacy-token' }),
      createWindowMock(),
    );

    expect(notion.users.me).not.toHaveBeenCalled();
    expect(notion.blocks.delete).not.toHaveBeenCalled();
    expect(mocks.syncNoteItem).toHaveBeenCalledWith(
      note,
      notion,
      expect.objectContaining({
        connectionID: expect.stringMatching(/^legacy-token-fallback:/),
        imageSyncEnabled: false,
        workspaceID: expect.stringMatching(/^legacy-token-fallback:/),
      }),
    );
  });
});
