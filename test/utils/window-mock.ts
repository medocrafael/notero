import { JSDOM } from 'jsdom';

export function createWindowMock(): Zotero.ZoteroWindow {
  const dom = new JSDOM();
  Object.defineProperty(dom.window, 'createImageBitmap', {
    configurable: true,
    value: async () => ({ close: () => undefined }),
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return dom.window as unknown as Zotero.ZoteroWindow;
}
