import type { EmbeddedImageReference } from './html-to-notion';

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

function matchesMimeType(
  bytes: Uint8Array,
  contentType: SupportedImageMimeType,
): boolean {
  switch (contentType) {
    case 'image/gif':
      return hasAscii(bytes, 0, 'GIF87a') || hasAscii(bytes, 0, 'GIF89a');
    case 'image/jpeg':
      return hasPrefix(bytes, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/svg+xml': {
      const prefix = new TextDecoder().decode(bytes.slice(0, 1024));
      return /<(?:\?xml[^>]*>\s*)?svg(?:\s|>)/i.test(prefix);
    }
    case 'image/webp':
      return (
        bytes.length >= 12 &&
        hasAscii(bytes, 0, 'RIFF') &&
        hasAscii(bytes, 8, 'WEBP')
      );
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
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}

export async function hashText(value: string): Promise<string> {
  return hashBytes(new TextEncoder().encode(value));
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
