import { getMainWindow } from '../utils';

type WebApiRealm = {
  Blob: typeof Blob;
  DOMParser: typeof DOMParser;
  FormData: typeof FormData;
  TextDecoder: typeof TextDecoder;
  TextEncoder: typeof TextEncoder;
};

function requireWebApi<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`Zotero main-window ${name} is unavailable`);
  return value;
}

function getWebApiRealm(
  window: Window = getMainWindow(),
): Partial<WebApiRealm> {
  // Zotero's ambient Window declaration omits constructor-valued properties
  // that are present on the Gecko main-window object at runtime.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return window as unknown as Partial<WebApiRealm>;
}

export function createZoteroBlob(
  parts: BlobPart[],
  options?: BlobPropertyBag,
): Blob {
  const BlobConstructor = requireWebApi(getWebApiRealm().Blob, 'Blob');
  return new BlobConstructor(parts, options);
}

export function createZoteroDOMParser(): DOMParser {
  const DOMParserConstructor = requireWebApi(
    getWebApiRealm().DOMParser,
    'DOMParser',
  );
  return new DOMParserConstructor();
}

export function createZoteroTextDecoder(): TextDecoder {
  const TextDecoderConstructor = requireWebApi(
    getWebApiRealm().TextDecoder,
    'TextDecoder',
  );
  return new TextDecoderConstructor();
}

export function createZoteroTextEncoder(): TextEncoder {
  const TextEncoderConstructor = requireWebApi(
    getWebApiRealm().TextEncoder,
    'TextEncoder',
  );
  return new TextEncoderConstructor();
}

export function getZoteroCrypto(): Crypto {
  const crypto = getMainWindow().crypto;
  if (!crypto?.subtle || !crypto.randomUUID) {
    throw new Error('Zotero main-window crypto is unavailable');
  }
  return crypto;
}

/**
 * The Notion SDK creates multipart objects from its module realm. Point that
 * realm at the same constructors as the bound Zotero window fetch before a
 * client is created, avoiding Gecko cross-realm BodyInit failures.
 */
export function configureNotionWebApiRealm(window: Window): void {
  const realm = getWebApiRealm(window);
  installConstructor('Blob', requireWebApi(realm.Blob, 'Blob'));
  installConstructor('FormData', requireWebApi(realm.FormData, 'FormData'));
}

function installConstructor(
  name: 'Blob' | 'FormData',
  constructor: typeof Blob | typeof FormData,
): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: constructor,
    writable: true,
  });
}
