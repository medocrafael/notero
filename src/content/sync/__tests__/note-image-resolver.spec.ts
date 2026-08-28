import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { createZoteroItemMock, zoteroMock } from '../../../../test/utils';
import {
  MAX_DIRECT_UPLOAD_SIZE,
  hashBytes,
  resolveNoteImage,
  validateImageBytes,
} from '../note-image-resolver';

import {
  validGifBytes,
  validJpegBytes,
  validPngBytes,
  validWebpBytes,
} from './fixtures/image-fixtures';

const pngBytes = validPngBytes;
const jpegBytes = validJpegBytes;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function insertValidApngControlChunk(png: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(20);
  writeUint32(chunk, 0, 8);
  chunk.set(new TextEncoder().encode('acTL'), 4);
  writeUint32(chunk, 8, 1);
  writeUint32(chunk, 12, 0);
  writeUint32(chunk, 16, crc32(chunk.slice(4, 16)));
  const offsetAfterIhdr = 33;
  const result = new Uint8Array(png.byteLength + chunk.byteLength);
  result.set(png.slice(0, offsetAfterIhdr));
  result.set(chunk, offsetAfterIhdr);
  result.set(png.slice(offsetAfterIhdr), offsetAfterIhdr + chunk.byteLength);
  return result;
}

describe('note image resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['personal', 1],
    ['group', 42],
  ])(
    'resolves a valid embedded image in a synthetic %s library',
    async (_libraryType, libraryID) => {
      const note = createZoteroItemMock({ libraryID });
      const attachment = createZoteroItemMock({
        attachmentContentType: 'image/png',
        deleted: false,
        libraryID,
        parentItemID: note.id,
      });
      attachment.isEmbeddedImageAttachment.mockReturnValue(true);
      attachment.getFilePathAsync.mockResolvedValue('C:\\synthetic\\image.png');
      zoteroMock.Items.getByLibraryAndKey.mockReturnValue(attachment);
      // oxlint-disable-next-line typescript/unbound-method
      vi.mocked(IOUtils.read).mockResolvedValue(pngBytes);

      const image = await resolveNoteImage(note, {
        alt: 'Synthetic figure',
        attachmentKey: attachment.key,
        hasAnnotation: false,
      });

      /* oxlint-disable typescript/unbound-method */
      expect(
        zoteroMock.Items.getByLibraryAndKey,
      ).toHaveBeenCalledExactlyOnceWith(libraryID, attachment.key);
      /* oxlint-enable typescript/unbound-method */
      expect(image).toMatchObject({
        attachmentKey: attachment.key,
        bytes: pngBytes,
        contentType: 'image/png',
        filename: `${attachment.key}.png`,
        size: pngBytes.byteLength,
      });
      expect(image.contentHash).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it('rejects a missing attachment item', async () => {
    const note = createZoteroItemMock({ libraryID: 7 });
    zoteroMock.Items.getByLibraryAndKey.mockReturnValue(false);

    await expect(
      resolveNoteImage(note, {
        alt: undefined,
        attachmentKey: 'MISSING',
        hasAnnotation: false,
      }),
    ).rejects.toThrow('Invalid embedded image attachment: MISSING');
  });

  it.each([
    ['different library', { libraryID: 8 }],
    ['different parent', { parentItemID: 999 }],
    ['deleted attachment', { deleted: true }],
  ])('rejects an attachment from the %s', async (_, overrides) => {
    const note = createZoteroItemMock({ libraryID: 7 });
    const attachment = createZoteroItemMock({
      attachmentContentType: 'image/png',
      deleted: false,
      libraryID: 7,
      parentItemID: note.id,
      ...overrides,
    });
    attachment.isEmbeddedImageAttachment.mockReturnValue(true);
    zoteroMock.Items.getByLibraryAndKey.mockReturnValue(attachment);

    await expect(
      resolveNoteImage(note, {
        alt: undefined,
        attachmentKey: attachment.key,
        hasAnnotation: false,
      }),
    ).rejects.toThrow('Invalid embedded image attachment');
    // oxlint-disable-next-line typescript/unbound-method
    expect(IOUtils.read).not.toHaveBeenCalled();
  });

  it('rejects a non-embedded attachment and missing local file', async () => {
    const note = createZoteroItemMock({ libraryID: 7 });
    const attachment = createZoteroItemMock({
      attachmentContentType: 'image/png',
      deleted: false,
      libraryID: 7,
      parentItemID: note.id,
    });
    zoteroMock.Items.getByLibraryAndKey.mockReturnValue(attachment);

    attachment.isEmbeddedImageAttachment.mockReturnValue(false);
    await expect(
      resolveNoteImage(note, {
        alt: undefined,
        attachmentKey: attachment.key,
        hasAnnotation: false,
      }),
    ).rejects.toThrow('Invalid embedded image attachment');

    attachment.isEmbeddedImageAttachment.mockReturnValue(true);
    attachment.getFilePathAsync.mockResolvedValue(false);
    await expect(
      resolveNoteImage(note, {
        alt: undefined,
        attachmentKey: attachment.key,
        hasAnnotation: false,
      }),
    ).rejects.toThrow('Embedded image file is unavailable');
  });

  it('validates PNG and JPEG magic bytes and rejects mismatches', () => {
    expect(
      validateImageBytes(pngBytes, 'image/png', MAX_DIRECT_UPLOAD_SIZE),
    ).toBe('png');
    expect(
      validateImageBytes(jpegBytes, 'image/jpeg', MAX_DIRECT_UPLOAD_SIZE),
    ).toBe('jpg');
    expect(() =>
      validateImageBytes(jpegBytes, 'image/png', MAX_DIRECT_UPLOAD_SIZE),
    ).toThrow('content does not match MIME type');
  });

  it.each([
    ['image/gif', validGifBytes, 'gif'],
    ['image/webp', validWebpBytes, 'webp'],
  ])(
    'validates a real decodable %s fixture',
    (contentType, bytes, extension) => {
      expect(
        validateImageBytes(bytes, contentType, MAX_DIRECT_UPLOAD_SIZE),
      ).toBe(extension);
    },
  );

  it.each([
    ['image/png', validPngBytes.slice(0, 20)],
    ['image/jpeg', validJpegBytes.slice(0, -2)],
    ['image/gif', validGifBytes.slice(0, -1)],
    ['image/webp', validWebpBytes.slice(0, -1)],
  ])('rejects a truncated %s container', (contentType, bytes) => {
    expect(() =>
      validateImageBytes(bytes, contentType, MAX_DIRECT_UPLOAD_SIZE),
    ).toThrow('content does not match MIME type');
  });

  it('rejects SVG for this release candidate, including active content', () => {
    for (const value of [
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/private.png"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
      '<?xml version="1.0"?><html></html>',
    ]) {
      expect(() =>
        validateImageBytes(
          new TextEncoder().encode(value),
          'image/svg+xml',
          MAX_DIRECT_UPLOAD_SIZE,
        ),
      ).toThrow('Unsupported embedded image MIME type');
    }
  });

  it('rejects a PNG with a corrupt chunk CRC and a valid APNG control chunk', () => {
    const crcCorrupt = validPngBytes.slice();
    crcCorrupt[29] = (crcCorrupt[29] || 0) ^ 1;
    expect(() =>
      validateImageBytes(crcCorrupt, 'image/png', MAX_DIRECT_UPLOAD_SIZE),
    ).toThrow('content does not match MIME type');

    const forgedApng = insertValidApngControlChunk(validPngBytes);
    expect(() =>
      validateImageBytes(forgedApng, 'image/png', MAX_DIRECT_UPLOAD_SIZE),
    ).toThrow('content does not match MIME type');
  });

  it('rejects a structurally valid image when the Zotero decoder rejects it', async () => {
    const note = createZoteroItemMock({ libraryID: 7 });
    const attachment = createZoteroItemMock({
      attachmentContentType: 'image/png',
      deleted: false,
      libraryID: 7,
      parentItemID: note.id,
    });
    attachment.isEmbeddedImageAttachment.mockReturnValue(true);
    attachment.getFilePathAsync.mockResolvedValue('synthetic-image.png');
    zoteroMock.Items.getByLibraryAndKey.mockReturnValue(attachment);
    // oxlint-disable-next-line typescript/unbound-method
    vi.mocked(IOUtils.read).mockResolvedValue(validPngBytes);
    const decode = vi
      .spyOn(window, 'createImageBitmap')
      .mockRejectedValueOnce(new Error('Synthetic decoder rejection'));

    await expect(
      resolveNoteImage(note, {
        alt: undefined,
        attachmentKey: attachment.key,
        hasAnnotation: false,
      }),
    ).rejects.toThrow('Embedded image cannot be decoded');
    decode.mockRestore();
  });

  it('rejects a JPEG whose entropy-coded scan is truncated before EOI', () => {
    const scanStart = validJpegBytes.indexOf(0xda);
    expect(scanStart).toBeGreaterThan(0);
    const truncated = validJpegBytes.slice(0, scanStart + 12);
    expect(() =>
      validateImageBytes(truncated, 'image/jpeg', MAX_DIRECT_UPLOAD_SIZE),
    ).toThrow('content does not match MIME type');
  });

  it('rejects unsupported, empty, corrupt, and oversized files', () => {
    for (const contentType of ['image/tiff', 'image/avif', 'image/bmp']) {
      expect(() =>
        validateImageBytes(pngBytes, contentType, MAX_DIRECT_UPLOAD_SIZE),
      ).toThrow('Unsupported embedded image MIME type');
    }
    expect(() =>
      validateImageBytes(new Uint8Array(), 'image/png', MAX_DIRECT_UPLOAD_SIZE),
    ).toThrow('empty');
    expect(() =>
      validateImageBytes(new Uint8Array([1, 2, 3]), 'image/png', 100),
    ).toThrow('content does not match MIME type');
    expect(() => validateImageBytes(pngBytes, 'image/png', 4)).toThrow(
      'exceeds the Notion upload limit',
    );
    expect(validateImageBytes(pngBytes, 'image/png', pngBytes.byteLength)).toBe(
      'png',
    );
  });

  it('redacts the local path when file reading fails', async () => {
    const note = createZoteroItemMock({ libraryID: 7 });
    const attachment = createZoteroItemMock({
      attachmentContentType: 'image/png',
      deleted: false,
      libraryID: 7,
      parentItemID: note.id,
    });
    attachment.isEmbeddedImageAttachment.mockReturnValue(true);
    attachment.getFilePathAsync.mockResolvedValue(
      'C:\\private\\library\\secret.png',
    );
    zoteroMock.Items.getByLibraryAndKey.mockReturnValue(attachment);
    // oxlint-disable-next-line typescript/unbound-method
    vi.mocked(IOUtils.read).mockRejectedValue(new Error('Access denied'));

    const error = await resolveNoteImage(note, {
      alt: undefined,
      attachmentKey: attachment.key,
      hasAnnotation: false,
    }).catch((cause: unknown) => cause);

    expect(String(error)).not.toContain('C:\\private');
    expect(String(error)).toContain(attachment.key);
  });

  it('produces stable content hashes that change with the bytes', async () => {
    await expect(hashBytes(pngBytes)).resolves.toBe(await hashBytes(pngBytes));
    await expect(hashBytes(jpegBytes)).resolves.not.toBe(
      await hashBytes(pngBytes),
    );
  });
});
