import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';
import { mockDeep } from 'vitest-mock-extended';

import {
  ZoteroRuntimeAdapter,
  ZoteroRuntimeCapabilityError,
  assertZoteroRuntimeCapabilities,
  inspectZoteroRuntimeCapabilities,
  type TransactionalZoteroItem,
  type ZoteroRuntimeSurface,
} from '../zotero-runtime-adapter';

function completeSurface(inTransaction = true) {
  const item = mockDeep<TransactionalZoteroItem>();
  item.getNote.mockReturnValue('');
  item.save.mockResolvedValue(true);
  item.setNote.mockReturnValue(true);
  const database: NonNullable<ZoteroRuntimeSurface['DB']> = {
    executeTransaction: async <Result>(callback: () => Promise<Result>) =>
      callback(),
    inTransaction: () => inTransaction,
  };
  const surface: ZoteroRuntimeSurface = {
    Attachments: Zotero.Attachments,
    DB: database,
    Items: Zotero.Items,
    getMainWindow: () => Zotero.getMainWindow(),
  };
  return { item, surface };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

describe('Zotero 9 initial RC and Zotero 10 code compatibility adapter', () => {
  it('preserves DB and Items receivers for runtime adapter calls', async () => {
    const database = {
      connection: 'receiver-sensitive-db',
      async executeTransaction<Result>(
        this: { connection: string },
        callback: () => Promise<Result>,
      ): Promise<Result> {
        if (this.connection !== 'receiver-sensitive-db') {
          throw new Error('Zotero.DB receiver was lost');
        }
        return callback();
      },
      inTransaction(this: { connection: string }): boolean {
        if (this.connection !== 'receiver-sensitive-db') {
          throw new Error('Zotero.DB receiver was lost');
        }
        return true;
      },
    };
    const items = {
      connection: 'receiver-sensitive-items',
      async reload(
        this: { connection: string },
        _ids: Zotero.DataObjectID[],
      ): Promise<void> {
        if (this.connection !== 'receiver-sensitive-items') {
          throw new Error('Zotero.Items receiver was lost');
        }
      },
    };
    const adapter = new ZoteroRuntimeAdapter({ DB: database, Items: items });

    await expect(
      adapter.executeTransaction(async () => 'transaction-result'),
    ).resolves.toBe('transaction-result');
    expect(adapter.inTransaction()).toBe(true);
    await expect(adapter.reloadItems([1])).resolves.toBeUndefined();
  });

  it('scopes the first isolated RC manifest to the runtime-testable Zotero 9 series', () => {
    const packageJSON: unknown = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    );
    if (!isUnknownRecord(packageJSON) || !isUnknownRecord(packageJSON.xpi)) {
      throw new Error('package.json omitted its xpi compatibility object');
    }

    expect(packageJSON.xpi).toMatchObject({
      zoteroMaxVersion: '9.0.*',
      zoteroMinVersion: '9.0',
    });
  });

  it.each(['9.0.6', '10.x code surface'])(
    '%s exposes the required shared APIs',
    () => {
      const { item, surface } = completeSurface();

      expect(inspectZoteroRuntimeCapabilities(surface, item)).toStrictEqual({
        executeTransaction: true,
        getItems: true,
        inTransaction: true,
        itemGetNote: true,
        itemSave: true,
        itemSetNote: true,
        linkedURLAttachments: true,
        mainWindowWebAPIs: true,
        reloadItems: true,
      });
    },
  );

  it('fails closed when a required runtime capability is absent', () => {
    expect(() =>
      assertZoteroRuntimeCapabilities({
        ...inspectZoteroRuntimeCapabilities({}, {}),
        executeTransaction: true,
      }),
    ).toThrow(ZoteroRuntimeCapabilityError);
  });

  it('uses item.save only inside an already active DB transaction', async () => {
    const { item, surface } = completeSurface(true);
    const adapter = new ZoteroRuntimeAdapter(surface);

    await adapter.saveItem(item, { skipNotifier: true });

    expect(item.save.mock.calls).toStrictEqual([[{ skipNotifier: true }]]);
  });

  it('rejects item.save when the runtime has no active transaction', async () => {
    const { item, surface } = completeSurface(false);
    const adapter = new ZoteroRuntimeAdapter(surface);

    await expect(adapter.saveItem(item, {})).rejects.toThrow(
      ZoteroRuntimeCapabilityError,
    );
    expect(item.save.mock.calls).toHaveLength(0);
  });
});
