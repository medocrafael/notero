import { type Client } from '@notionhq/client';

import type { NotionAuthContext } from '../auth';
import { APA_STYLE } from '../constants';
import { ItemSyncError } from '../errors';
import {
  NoteroPref,
  PageTitleFormat,
  getNoteroPref,
  getRequiredNoteroPref,
} from '../prefs/notero-pref';
import { getLocalizedErrorMessage, logger } from '../utils';

import { MAX_DIRECT_UPLOAD_SIZE } from './note-image-resolver';
import { getNotionClient } from './notion-client';
import type { DatabaseProperties } from './notion-types';
import { ProgressWindow } from './progress-window';
import { syncNoteItem } from './sync-note-item';
import { syncRegularItem } from './sync-regular-item';

export type SyncJobParams = {
  citationFormat: string;
  connectionID: string;
  databaseID: string;
  databaseProperties: DatabaseProperties;
  notion: Client;
  maxFileUploadSize: number;
  pageTitleFormat: PageTitleFormat;
  workspaceID: string;
};

export async function performSyncJob(
  itemIDs: Set<Zotero.Item['id']>,
  getNotionAuthContext: () => Promise<NotionAuthContext>,
  window: Window,
): Promise<void> {
  const items = Zotero.Items.get(Array.from(itemIDs));
  if (!items.length) return;

  const progressWindow = new ProgressWindow(items.length, window);
  await progressWindow.show();

  try {
    const params = await prepareSyncJob(getNotionAuthContext, window);
    await syncItems(items, progressWindow, params, window);
  } catch (error) {
    await handleError(error, progressWindow, window);
  }
}

async function prepareSyncJob(
  getNotionAuthContext: () => Promise<NotionAuthContext>,
  window: Window,
): Promise<SyncJobParams> {
  const authContext = await getNotionAuthContext();
  const notion = getNotionClient(authContext.accessToken, window);
  const imageSyncEnabled = Boolean(getNoteroPref(NoteroPref.syncNoteImages));
  const needsIdentityFallback =
    !authContext.connectionID || !authContext.workspaceID;
  const user =
    imageSyncEnabled || needsIdentityFallback
      ? await notion.users.me({})
      : undefined;
  const databaseID = getRequiredNoteroPref(NoteroPref.notionDatabaseID);
  const databaseProperties = await retrieveDatabaseProperties(
    notion,
    databaseID,
  );
  const citationFormat = getCitationFormat();
  const pageTitleFormat = getPageTitleFormat();

  return {
    citationFormat,
    connectionID: authContext.connectionID || user?.id || '',
    databaseID,
    databaseProperties,
    notion,
    maxFileUploadSize:
      imageSyncEnabled && user?.type === 'bot' && 'workspace_limits' in user.bot
        ? Math.min(
            user.bot.workspace_limits.max_file_upload_size_in_bytes,
            MAX_DIRECT_UPLOAD_SIZE,
          )
        : MAX_DIRECT_UPLOAD_SIZE,
    pageTitleFormat,
    workspaceID: authContext.workspaceID || user?.id || '',
  };
}

function getCitationFormat(): string {
  const format = Zotero.Prefs.get('export.quickCopy.setting');

  if (typeof format === 'string' && format) return format;

  return APA_STYLE;
}

function getPageTitleFormat(): PageTitleFormat {
  return getNoteroPref(NoteroPref.pageTitleFormat) || PageTitleFormat.itemTitle;
}

async function retrieveDatabaseProperties(
  notion: Client,
  databaseID: string,
): Promise<DatabaseProperties> {
  const database = await notion.databases.retrieve({
    database_id: databaseID,
  });

  return database.properties;
}

export async function syncItems(
  items: Zotero.Item[],
  progressWindow: ProgressWindow,
  params: SyncJobParams,
  window: Window,
) {
  let hasFailures = false;
  for (const [index, item] of items.entries()) {
    const step = index + 1;
    logger.groupCollapsed(
      `Syncing item ${step} of ${items.length} with ID`,
      item.id,
    );
    logger.debug(item.getDisplayTitle());

    await progressWindow.updateText(step);

    try {
      if (item.isNote()) {
        await syncNoteItem(item, params.notion, {
          connectionID: params.connectionID,
          databaseID: params.databaseID,
          imageSyncEnabled: Boolean(getNoteroPref(NoteroPref.syncNoteImages)),
          maxFileUploadSize: params.maxFileUploadSize,
          workspaceID: params.workspaceID,
        });
      } else {
        await syncRegularItem(item, params);
      }
    } catch (error) {
      hasFailures = true;
      await handleError(new ItemSyncError(error, item), progressWindow, window);
    } finally {
      logger.groupEnd();
    }

    progressWindow.updateProgress(step);
  }

  if (!hasFailures) progressWindow.complete();
}

async function handleError(
  error: unknown,
  progressWindow: ProgressWindow,
  window: Window,
) {
  let cause = error;
  let failedItem: Zotero.Item | undefined;

  if (error instanceof ItemSyncError) {
    cause = error.cause;
    failedItem = error.item;
  }

  const errorMessage = await getLocalizedErrorMessage(
    cause,
    window.document.l10n,
  );

  logger.error(error, failedItem?.getDisplayTitle());

  progressWindow.fail(errorMessage, failedItem);
}
