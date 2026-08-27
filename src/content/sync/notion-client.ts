import { Client, Logger, LogLevel } from '@notionhq/client';

import { logger } from '../utils';

import { configureNotionWebApiRealm } from './zotero-web-api';

const notionLogger: Logger = (level, message) => {
  level = level === LogLevel.INFO ? LogLevel.DEBUG : level;
  logger[level](message);
};

export function getNotionClient(authToken: string, window: Window) {
  configureNotionWebApiRealm(window);
  return new Client({
    auth: authToken,
    fetch: window.fetch.bind(window),
    logger: notionLogger,
    logLevel: LogLevel.WARN,
  });
}
