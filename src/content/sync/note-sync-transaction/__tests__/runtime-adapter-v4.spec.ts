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

describe('Zotero 9/10 compatibility adapter', () => {
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
