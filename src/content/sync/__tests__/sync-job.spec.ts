import { type Client } from '@notionhq/client';
import { describe, expect, it, vi } from 'vite-plus/test';
import { mock, mockDeep } from 'vitest-mock-extended';

import { createWindowMock, createZoteroItemMock } from '../../../../test/utils';
import { PageTitleFormat } from '../../prefs/notero-pref';
import { asLocalConnectionIdentity } from '../note-sync-transaction/identity-v4';
import { ProgressWindow } from '../progress-window';
import { type SyncJobParams, syncItems } from '../sync-job';
import { syncNoteItem } from '../sync-note-item';
import { syncRegularItem } from '../sync-regular-item';

vi.mock('../sync-note-item');
vi.mock('../sync-regular-item');

describe('syncItems error isolation', () => {
  it('continues with unrelated items after one item fails', async () => {
    const first = createZoteroItemMock({ itemType: 'journalArticle' });
    const second = createZoteroItemMock({ itemType: 'journalArticle' });
    first.isNote.mockReturnValue(false);
    second.isNote.mockReturnValue(false);
    vi.mocked(syncRegularItem)
      .mockRejectedValueOnce(new Error('Synthetic item failure'))
      .mockResolvedValueOnce();

    const progressWindow = mock<ProgressWindow>();
    const params: SyncJobParams = {
      citationFormat: 'bibliography=synthetic',
      connectionID: asLocalConnectionIdentity('bot-a'),
      databaseID: 'database-a',
      databaseProperties: {},
      maxFileUploadSize: 5 * 1024 * 1024,
      notion: mockDeep<Client>(),
      pageTitleFormat: PageTitleFormat.itemTitle,
      workspaceID: 'workspace-a',
    };

    await syncItems(
      [first, second],
      progressWindow,
      params,
      createWindowMock(),
    );

    expect(syncRegularItem).toHaveBeenCalledTimes(2);
    expect(syncRegularItem).toHaveBeenNthCalledWith(2, second, params);
    expect(syncNoteItem).not.toHaveBeenCalled();
    /* oxlint-disable typescript/unbound-method */
    expect(progressWindow.fail).toHaveBeenCalledTimes(1);
    expect(progressWindow.updateProgress).toHaveBeenCalledTimes(2);
    expect(progressWindow.complete).not.toHaveBeenCalled();
    /* oxlint-enable typescript/unbound-method */
  });
});
