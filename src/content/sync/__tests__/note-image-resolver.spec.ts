import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { createZoteroItemMock, zoteroMock } from '../../../../test/utils';
import {
  MAX_DIRECT_UPLOAD_SIZE,
  hashBytes,
  resolveNoteImage,
  validateImageBytes,
} from '../note-image-resolver';

const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00]);

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
    ['image/gif', new TextEncoder().encode('GIF89a synthetic'), 'gif'],
    [
      'image/webp',
      new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      ]),
      'webp',
    ],
    ['image/svg+xml', new TextEncoder().encode('<svg></svg>'), 'svg'],
  ])('validates supported %s bytes', (contentType, bytes, extension) => {
    expect(validateImageBytes(bytes, contentType, MAX_DIRECT_UPLOAD_SIZE)).toBe(
      extension,
    );
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
