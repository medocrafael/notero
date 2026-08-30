export type ZoteroRuntimeCapabilities = {
  executeTransaction: boolean;
  getItems: boolean;
  inTransaction: boolean;
  itemGetNote: boolean;
  itemSave: boolean;
  itemSetNote: boolean;
  linkedURLAttachments: boolean;
  mainWindowWebAPIs: boolean;
  reloadItems: boolean;
};

export type ZoteroRuntimeSurface = {
  Attachments?: {
    linkFromURL?: typeof Zotero.Attachments.linkFromURL;
  };
  DB?: {
    executeTransaction?: <Result>(
      callback: () => Promise<Result>,
    ) => Promise<Result>;
    inTransaction?: () => boolean;
  };
  Items?: {
    get?: typeof Zotero.Items.get;
    reload?: (ids: Zotero.DataObjectID[]) => Promise<void>;
  };
  getMainWindow?: typeof Zotero.getMainWindow;
};

export type TransactionalZoteroItem = Zotero.Item & {
  save: (
    options?: Zotero.DataObject.SaveOptions,
  ) => Promise<boolean | Zotero.DataObjectID>;
};

type CapabilitySampleItem = Partial<Zotero.Item> & {
  save?: TransactionalZoteroItem['save'];
};

export class ZoteroRuntimeCapabilityError extends Error {
  public readonly name = 'ZoteroRuntimeCapabilityError';
}

export function inspectZoteroRuntimeCapabilities(
  surface: ZoteroRuntimeSurface,
  sampleItem?: CapabilitySampleItem,
): ZoteroRuntimeCapabilities {
  const mainWindow = surface.getMainWindow?.();
  return {
    executeTransaction: typeof surface.DB?.executeTransaction === 'function',
    getItems: typeof surface.Items?.get === 'function',
    inTransaction: typeof surface.DB?.inTransaction === 'function',
    itemGetNote: typeof sampleItem?.getNote === 'function',
    itemSave: typeof sampleItem?.save === 'function',
    itemSetNote: typeof sampleItem?.setNote === 'function',
    linkedURLAttachments:
      typeof surface.Attachments?.linkFromURL === 'function',
    mainWindowWebAPIs: Boolean(
      mainWindow?.fetch && mainWindow.Blob && mainWindow.FormData,
    ),
    reloadItems: typeof surface.Items?.reload === 'function',
  };
}

export function assertZoteroRuntimeCapabilities(
  capabilities: ZoteroRuntimeCapabilities,
): void {
  const missing = Object.entries(capabilities)
    .filter(([, available]) => !available)
    .map(([name]) => name);
  if (missing.length) {
    throw new ZoteroRuntimeCapabilityError(
      `Zotero runtime lacks required note-sync capabilities: ${missing.join(', ')}`,
    );
  }
}

export class ZoteroRuntimeAdapter {
  private readonly surface: ZoteroRuntimeSurface;

  public constructor(surface: ZoteroRuntimeSurface = Zotero) {
    this.surface = surface;
  }

  public assertCapabilities(sampleItem: Zotero.Item): void {
    assertZoteroRuntimeCapabilities(
      inspectZoteroRuntimeCapabilities(this.surface, sampleItem),
    );
  }

  public async executeTransaction<Result>(
    callback: () => Promise<Result>,
  ): Promise<Result> {
    const executeTransaction = this.surface.DB?.executeTransaction;
    if (!executeTransaction) {
      throw new ZoteroRuntimeCapabilityError(
        'Zotero.DB.executeTransaction is unavailable',
      );
    }
    return executeTransaction(callback);
  }

  public getItem(id: Zotero.DataObjectID): Zotero.Item {
    const item = this.surface.Items?.get?.(id);
    if (!item || Array.isArray(item)) {
      throw new ZoteroRuntimeCapabilityError(
        `Zotero item ${id} is unavailable`,
      );
    }
    return item;
  }

  public inTransaction(): boolean {
    const inTransaction = this.surface.DB?.inTransaction;
    if (!inTransaction) {
      throw new ZoteroRuntimeCapabilityError(
        'Zotero.DB.inTransaction is unavailable',
      );
    }
    return inTransaction();
  }

  public async reloadItems(ids: Zotero.DataObjectID[]): Promise<void> {
    const reload = this.surface.Items?.reload;
    if (!reload) {
      throw new ZoteroRuntimeCapabilityError(
        'Zotero.Items.reload is unavailable',
      );
    }
    await reload(ids);
  }

  public asTransactionalItem(item: Zotero.Item): TransactionalZoteroItem {
    if (typeof (item as CapabilitySampleItem).save !== 'function') {
      throw new ZoteroRuntimeCapabilityError(
        'Zotero item.save is unavailable inside DB transactions',
      );
    }
    return item as TransactionalZoteroItem;
  }

  public async saveItem(
    item: TransactionalZoteroItem,
    options: Zotero.DataObject.SaveOptions,
  ): Promise<void> {
    if (!this.inTransaction()) {
      throw new ZoteroRuntimeCapabilityError(
        'Metadata attachment save must run inside Zotero.DB.executeTransaction',
      );
    }
    await item.save(options);
  }
}
