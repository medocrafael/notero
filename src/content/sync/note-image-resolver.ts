import type { EmbeddedImageReference } from './html-to-notion';
import {
  createZoteroDOMParser,
  createZoteroTextDecoder,
  createZoteroTextEncoder,
  getZoteroCrypto,
} from './zotero-web-api';

export const MAX_DIRECT_UPLOAD_SIZE = 20 * 1024 * 1024;

const MIME_EXTENSIONS = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
} as const;

type SupportedImageMimeType = keyof typeof MIME_EXTENSIONS;

export type ResolvedNoteImage = {
  alt?: string;
  attachmentKey: string;
  bytes: Uint8Array<ArrayBuffer>;
  contentHash: string;
  contentType: SupportedImageMimeType;
  filename: string;
  size: number;
};

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function hasAscii(bytes: Uint8Array, offset: number, value: string): boolean {
  return Array.from(value).every(
    (character, index) => bytes[offset + index] === character.charCodeAt(0),
  );
}

function isSupportedImageMimeType(
  contentType: string,
): contentType is SupportedImageMimeType {
  return contentType in MIME_EXTENSIONS;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, false);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, true);
}

function isValidPng(bytes: Uint8Array): boolean {
  if (
    bytes.length < 45 ||
    !hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return false;
  }

  let offset = 8;
  let firstChunk = true;
  let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = readUint32BE(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    if (firstChunk) {
      if (type !== 'IHDR' || length !== 13) return false;
      if (
        !readUint32BE(bytes, offset + 8) ||
        !readUint32BE(bytes, offset + 12)
      ) {
        return false;
      }
      firstChunk = false;
    }
    if (type === 'IDAT') hasImageData = true;
    if (type === 'IEND') {
      return length === 0 && hasImageData && end === bytes.length;
    }
    offset = end;
  }
  return false;
}

function isValidJpeg(bytes: Uint8Array): boolean {
  if (
    bytes.length < 16 ||
    !hasPrefix(bytes, [0xff, 0xd8]) ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    return false;
  }

  let offset = 2;
  let hasFrame = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined) return false;
    if (marker === 0xda) return hasFrame;
    if (marker === 0xd9) return hasFrame;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return false;
    const lengthHigh = bytes[offset];
    const lengthLow = bytes[offset + 1];
    if (lengthHigh === undefined || lengthLow === undefined) return false;
    const length = (lengthHigh << 8) | lengthLow;
    if (length < 2 || offset + length > bytes.length) return false;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      hasFrame = true;
    }
    offset += length;
  }
  return false;
}

function skipGifSubBlocks(
  bytes: Uint8Array,
  start: number,
): number | undefined {
  let offset = start;
  while (offset < bytes.length) {
    const length = bytes[offset++];
    if (length === undefined) return undefined;
    if (length === 0) return offset;
    offset += length;
    if (offset > bytes.length) return undefined;
  }
  return undefined;
}

function isValidGif(bytes: Uint8Array): boolean {
  if (
    bytes.length < 20 ||
    (!hasAscii(bytes, 0, 'GIF87a') && !hasAscii(bytes, 0, 'GIF89a'))
  ) {
    return false;
  }
  const packed = bytes[10];
  if (packed === undefined) return false;
  let offset = 13;
  if (packed & 0x80) offset += 3 * 2 ** ((packed & 0x07) + 1);
  let hasImage = false;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) return hasImage && offset === bytes.length;
    if (marker === 0x21) {
      offset += 1;
      const next = skipGifSubBlocks(bytes, offset);
      if (next === undefined) return false;
      offset = next;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) return false;
    hasImage = true;
    const imagePacked = bytes[offset + 8];
    offset += 9;
    if (imagePacked === undefined) return false;
    if (imagePacked & 0x80) {
      offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
    }
    if (offset >= bytes.length) return false;
    offset += 1;
    const next = skipGifSubBlocks(bytes, offset);
    if (next === undefined) return false;
    offset = next;
  }
  return false;
}

function isValidWebp(bytes: Uint8Array): boolean {
  if (
    bytes.length < 20 ||
    !hasAscii(bytes, 0, 'RIFF') ||
    !hasAscii(bytes, 8, 'WEBP') ||
    readUint32LE(bytes, 4) + 8 !== bytes.length
  ) {
    return false;
  }
  let offset = 12;
  let hasImage = false;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const length = readUint32LE(bytes, offset + 4);
    const end = offset + 8 + length;
    if (end > bytes.length) return false;
    if (['VP8 ', 'VP8L', 'VP8X'].includes(type)) hasImage = true;
    offset = end + (length % 2);
  }
  return hasImage && offset === bytes.length;
}

function isValidSvg(bytes: Uint8Array): boolean {
  const source = createZoteroTextDecoder().decode(bytes);
  if (/<!DOCTYPE/i.test(source)) return false;
  const document = createZoteroDOMParser().parseFromString(
    source,
    'image/svg+xml',
  );
  if (document.querySelector('parsererror')) return false;
  const root = document.documentElement;
  if (root.localName.toLowerCase() !== 'svg') return false;

  const unsafeElements = new Set([
    'audio',
    'embed',
    'foreignobject',
    'iframe',
    'object',
    'script',
    'video',
  ]);
  for (const element of Array.from(document.querySelectorAll('*'))) {
    if (unsafeElements.has(element.localName.toLowerCase())) return false;
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on')) return false;
      if (
        (name === 'href' || name === 'xlink:href') &&
        !value.startsWith('#')
      ) {
        return false;
      }
      if (
        (name === 'style' ||
          name === 'fill' ||
          name === 'filter' ||
          name === 'stroke') &&
        /url\(\s*["']?(?!#)/i.test(value)
      ) {
        return false;
      }
      if (name === 'style' && /@import/i.test(value)) return false;
    }
  }
  return true;
}

function matchesMimeType(
  bytes: Uint8Array,
  contentType: SupportedImageMimeType,
): boolean {
  switch (contentType) {
    case 'image/gif':
      return isValidGif(bytes);
    case 'image/jpeg':
      return isValidJpeg(bytes);
    case 'image/png':
      return isValidPng(bytes);
    case 'image/svg+xml':
      return isValidSvg(bytes);
    case 'image/webp':
      return isValidWebp(bytes);
  }
  return false;
}

export function validateImageBytes(
  bytes: Uint8Array,
  contentType: string,
  maxSize: number,
): string {
  if (!isSupportedImageMimeType(contentType)) {
    throw new Error(`Unsupported embedded image MIME type: ${contentType}`);
  }
  if (!bytes.byteLength) throw new Error('Embedded image file is empty');
  if (bytes.byteLength > Math.min(maxSize, MAX_DIRECT_UPLOAD_SIZE)) {
    throw new Error('Embedded image exceeds the Notion upload limit');
  }
  if (!matchesMimeType(bytes, contentType)) {
    throw new Error('Embedded image content does not match MIME type');
  }

  return MIME_EXTENSIONS[contentType];
}

export async function hashBytes(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await getZoteroCrypto().subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}

export async function hashText(value: string): Promise<string> {
  return hashBytes(createZoteroTextEncoder().encode(value));
}

export async function resolveNoteImage(
  noteItem: Zotero.Item,
  reference: EmbeddedImageReference,
  maxSize = MAX_DIRECT_UPLOAD_SIZE,
): Promise<ResolvedNoteImage> {
  const attachmentKey = reference.attachmentKey;
  if (!attachmentKey) {
    throw new Error('Embedded image is missing data-attachment-key');
  }

  const attachment = Zotero.Items.getByLibraryAndKey(
    noteItem.libraryID,
    attachmentKey,
  );

  if (
    !attachment ||
    attachment.libraryID !== noteItem.libraryID ||
    attachment.parentItemID !== noteItem.id ||
    attachment.deleted ||
    !attachment.isEmbeddedImageAttachment()
  ) {
    throw new Error(`Invalid embedded image attachment: ${attachmentKey}`);
  }

  const filePath = await attachment.getFilePathAsync();
  if (!filePath) {
    throw new Error(`Embedded image file is unavailable: ${attachmentKey}`);
  }

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await IOUtils.read(filePath);
  } catch (error) {
    // oxlint-disable-next-line eslint/preserve-caught-error -- Native I/O errors can contain complete local paths.
    throw new Error(`Embedded image file is unreadable: ${attachmentKey}`, {
      cause: new Error(
        error instanceof Error
          ? `Local file read failed (${error.name})`
          : 'Local file read failed',
      ),
    });
  }

  const contentType = attachment.attachmentContentType;
  if (!isSupportedImageMimeType(contentType)) {
    throw new Error(`Unsupported embedded image MIME type: ${contentType}`);
  }
  const extension = validateImageBytes(bytes, contentType, maxSize);

  return {
    alt: reference.alt,
    attachmentKey,
    bytes,
    contentHash: await hashBytes(bytes),
    contentType,
    filename: `${attachmentKey}.${extension}`,
    size: bytes.byteLength,
  };
}
