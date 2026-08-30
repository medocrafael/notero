import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints';

import { LocalizableError } from '../../errors';
import type {
  EmbeddedImageReference,
  HtmlConversionOptions,
  PreparedNotionImage,
} from '../html-to-notion';
import { convertHtmlToBlocks, findEmbeddedImages } from '../html-to-notion';
import {
  MAX_DIRECT_UPLOAD_SIZE,
  type ResolvedNoteImage,
  hashText,
  resolveNoteImage,
} from '../note-image-resolver';
import { LIMITS } from '../notion-limits';
import type { ChildBlock } from '../notion-types';

import { digestCanonical } from './canonical';
import { deriveAssetID, deriveTargetIdentityDigest } from './identity-v4';
import type { OperationPayloadProviderV4 } from './notion-operation-adapter-v4';
import { SYSTEM_RUNTIME_CLOCK, type RuntimeClock } from './runtime-clock';
import type {
  NoteSyncRecordV4,
  SourceSnapshotV4,
  TargetIdentity,
  UploadAssetRecordV4,
} from './types-v4';

const DEFAULT_MAX_NOTE_IMAGE_COUNT = 32;
const DEFAULT_MAX_NOTE_IMAGE_TOTAL_SIZE = 100 * 1024 * 1024;

export type NoteSourceOptions = {
  blockConverter?: (
    html: string,
    options?: HtmlConversionOptions,
  ) => ChildBlock[];
  imageSyncEnabled: boolean;
  maxFileUploadSize?: number;
  maxNoteImageCount?: number;
  maxNoteImageTotalSize?: number;
  clock?: RuntimeClock;
};

export type ImageDescriptor = Omit<ResolvedNoteImage, 'bytes'> & {
  reference: EmbeddedImageReference;
};

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function countImages(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (total, child) => total + countImages(child),
      0,
    );
  }
  const ownImage =
    ('type' in value && value.type === 'image') || 'image' in value ? 1 : 0;
  return (
    ownImage +
    Object.entries(value).reduce(
      (total, [key, child]) =>
        total + (key === 'image' ? 0 : countImages(child)),
      0,
    )
  );
}

function batches(blocks: ChildBlock[]): BlockObjectRequest[][] {
  const result: BlockObjectRequest[][] = [];
  for (
    let offset = 0;
    offset < blocks.length;
    offset += LIMITS.BLOCK_ARRAY_ELEMENTS
  ) {
    // @ts-expect-error Nested HTML can exceed the SDK's two-level type.
    result.push(blocks.slice(offset, offset + LIMITS.BLOCK_ARRAY_ELEMENTS));
  }
  return result;
}

export class NoteSourceAdapter implements OperationPayloadProviderV4 {
  private constructor(
    private readonly noteItem: Zotero.Item,
    private readonly noteHTML: string,
    private readonly noteTitle: string,
    private readonly options: Required<
      Pick<
        NoteSourceOptions,
        | 'imageSyncEnabled'
        | 'maxFileUploadSize'
        | 'maxNoteImageCount'
        | 'maxNoteImageTotalSize'
      >
    > &
      Pick<NoteSourceOptions, 'blockConverter'>,
    public readonly descriptors: ImageDescriptor[],
    public readonly snapshot: SourceSnapshotV4,
    private readonly clock: RuntimeClock,
  ) {}

  public static async create(
    noteItem: Zotero.Item,
    targetIdentity: TargetIdentity,
    options: NoteSourceOptions,
  ): Promise<NoteSourceAdapter> {
    const normalized = {
      blockConverter: options.blockConverter,
      imageSyncEnabled: options.imageSyncEnabled,
      maxFileUploadSize: Math.min(
        options.maxFileUploadSize ?? MAX_DIRECT_UPLOAD_SIZE,
        MAX_DIRECT_UPLOAD_SIZE,
      ),
      maxNoteImageCount:
        options.maxNoteImageCount ?? DEFAULT_MAX_NOTE_IMAGE_COUNT,
      maxNoteImageTotalSize:
        options.maxNoteImageTotalSize ?? DEFAULT_MAX_NOTE_IMAGE_TOTAL_SIZE,
    };
    const clock = options.clock ?? SYSTEM_RUNTIME_CLOCK;
    const noteHTML = noteItem.getNote();
    const noteTitle = noteItem.getNoteTitle();
    const descriptors = normalized.imageSyncEnabled
      ? await inspectImages(noteItem, noteHTML, normalized)
      : [];
    const placeholders = new Map<string, PreparedNotionImage>();
    for (const descriptor of descriptors) {
      placeholders.set(descriptor.attachmentKey, {
        fileUploadID: `notero-placeholder-${descriptor.attachmentKey}`,
      });
    }
    const converter = normalized.blockConverter || convertHtmlToBlocks;
    const templateBlocks = convert(noteHTML, placeholders, converter);
    const renderedImages = countImages(templateBlocks);
    if (normalized.imageSyncEnabled && renderedImages !== descriptors.length) {
      throw new Error(
        `Embedded image pipeline is incomplete: discovered=${descriptors.length}, rendered=${renderedImages}`,
      );
    }
    const featurePolicy = normalized.imageSyncEnabled
      ? 'embedded-images-v1'
      : 'text-only-v1';
    const orderedImages = descriptors
      .map(
        ({ alt, attachmentKey, contentHash }) =>
          `${attachmentKey}:${contentHash}:${alt || ''}`,
      )
      .join('\n');
    const sourceVersion = await hashText(
      [
        'notero-note-source:v4',
        targetIdentity.libraryID,
        targetIdentity.parentItemKey,
        targetIdentity.noteItemKey,
        noteTitle,
        noteHTML,
        featurePolicy,
        orderedImages,
        'converter-v4',
      ].join('\u0000'),
    );
    const manifestDigest = await hashText(
      `notero-note-manifest:v4\u0000${sourceVersion}\u0000${JSON.stringify(templateBlocks)}`,
    );
    const imageAssets: SourceSnapshotV4['imageAssets'][number][] = [];
    const seenAssets = new Set<string>();
    const targetIdentityDigest = deriveTargetIdentityDigest(targetIdentity);
    for (const descriptor of descriptors) {
      const key = `${descriptor.attachmentKey}:${descriptor.contentHash}`;
      if (seenAssets.has(key)) continue;
      seenAssets.add(key);
      const attachmentIdentity = digestCanonical('zotero-attachment-v4', {
        attachmentKey: descriptor.attachmentKey,
        libraryID: noteItem.libraryID,
      });
      const sourceIdentity = digestCanonical('zotero-note-image-source-v4', {
        attachmentKey: descriptor.attachmentKey,
        libraryID: noteItem.libraryID,
        noteItemKey: noteItem.key,
        parentItemKey: noteItem.topLevelItem.key,
      });
      const assetIdentity = {
        attachmentIdentity,
        contentHash: descriptor.contentHash,
        contentLength: descriptor.size,
        contentType: descriptor.contentType,
        sourceIdentity,
        targetIdentityDigest,
      };
      imageAssets.push({
        assetID: deriveAssetID(assetIdentity),
        ...assetIdentity,
        attachmentKey: descriptor.attachmentKey,
        filename: await deterministicFilename(
          descriptor,
          noteItem,
          targetIdentity,
        ),
      });
    }
    const templateBatches = batches(templateBlocks);
    const assetByPlaceholder = new Map(
      imageAssets.map((asset) => [
        `notero-placeholder-${asset.attachmentKey}`,
        asset.assetID,
      ]),
    );
    const imageAssetIDsByBatch = templateBatches.map((batch) =>
      collectImageAssetIDs(batch, assetByPlaceholder),
    );
    if (imageAssetIDsByBatch.flat().length !== descriptors.length) {
      throw new Error(
        'Embedded image occurrence identity mapping is incomplete',
      );
    }
    const snapshot: SourceSnapshotV4 = {
      batches: templateBatches,
      featurePolicy,
      imageAssetIDsByBatch,
      imageAssets,
      imageOccurrenceCount: descriptors.length,
      manifestDigest,
      sourceVersion,
      title: noteTitle,
    };
    return new NoteSourceAdapter(
      noteItem,
      noteHTML,
      noteTitle,
      normalized,
      descriptors,
      snapshot,
      clock,
    );
  }

  public buildBatches(record: NoteSyncRecordV4): BlockObjectRequest[][] {
    const imageMap = new Map<string, PreparedNotionImage>();
    for (const descriptor of this.descriptors) {
      const upload = this.findReusableUpload(record, descriptor);
      if (!upload?.fileUploadID) {
        throw new Error(
          `Embedded image ${descriptor.attachmentKey} has no prepared File Upload`,
        );
      }
      imageMap.set(descriptor.attachmentKey, {
        fileUploadID: upload.fileUploadID,
      });
    }
    const converter = this.options.blockConverter || convertHtmlToBlocks;
    const blocks = convert(this.noteHTML, imageMap, converter);
    if (
      this.options.imageSyncEnabled &&
      countImages(blocks) !== this.descriptors.length
    ) {
      throw new Error(
        'Rendered image count changed after File Upload preparation',
      );
    }
    return batches(blocks);
  }

  public async getAppendBatch(
    intent: Parameters<OperationPayloadProviderV4['getAppendBatch']>[0],
  ): Promise<BlockObjectRequest[]> {
    const images = new Map<string, PreparedNotionImage>();
    for (const descriptor of this.descriptors) {
      const asset = this.snapshot.imageAssets.find(
        (candidate) =>
          candidate.attachmentKey === descriptor.attachmentKey &&
          candidate.contentHash === descriptor.contentHash,
      );
      if (!asset) throw new Error('Frozen image asset is unavailable');
      const upload = intent.details.fileUploads.find(
        ({ assetID }) => assetID === asset.assetID,
      );
      images.set(descriptor.attachmentKey, {
        fileUploadID:
          upload?.fileUploadID ||
          `notero-placeholder-${descriptor.attachmentKey}`,
      });
    }
    const converter = this.options.blockConverter || convertHtmlToBlocks;
    const rendered = batches(convert(this.noteHTML, images, converter));
    const payload = rendered[intent.details.batchIndex];
    if (!payload) {
      throw new Error(
        `Frozen append batch ${intent.details.batchIndex} is unavailable`,
      );
    }
    return payload;
  }

  public async getUploadBytes(
    intent: Parameters<OperationPayloadProviderV4['getUploadBytes']>[0],
  ): Promise<ResolvedNoteImage> {
    const descriptor = this.descriptors.find(
      (entry) =>
        entry.attachmentKey === intent.details.attachmentKey &&
        entry.contentHash === intent.details.contentHash,
    );
    if (!descriptor) {
      throw new Error(
        'Upload intent does not match the current source snapshot',
      );
    }
    const resolved = await resolveNoteImage(
      this.noteItem,
      descriptor.reference,
      this.options.maxFileUploadSize,
    );
    if (
      resolved.contentHash !== descriptor.contentHash ||
      resolved.size !== descriptor.size ||
      resolved.contentType !== descriptor.contentType
    ) {
      throw new Error(
        'Embedded image changed after source snapshot was frozen',
      );
    }
    return {
      ...resolved,
      filename: intent.details.filename,
    };
  }

  public findReusableUpload(
    record: NoteSyncRecordV4,
    descriptor: Pick<ImageDescriptor, 'attachmentKey' | 'contentHash'>,
  ): UploadAssetRecordV4 | undefined {
    const sourceAsset = this.snapshot.imageAssets.find(
      (asset) =>
        asset.attachmentKey === descriptor.attachmentKey &&
        asset.contentHash === descriptor.contentHash,
    );
    if (!sourceAsset) return undefined;
    return record.uploadAssets.find(
      (upload) =>
        upload.assetID === sourceAsset.assetID &&
        ['ATTACHED', 'CREATED_UNSENT', 'UPLOADED'].includes(upload.status) &&
        (upload.expiryTime === null ||
          !upload.expiryTime ||
          this.clock.compare(upload.expiryTime, this.clock.nowISOString()) > 0),
    );
  }

  public get title(): string {
    return this.noteTitle;
  }
}

async function inspectImages(
  noteItem: Zotero.Item,
  noteHTML: string,
  options: Required<
    Pick<
      NoteSourceOptions,
      'maxFileUploadSize' | 'maxNoteImageCount' | 'maxNoteImageTotalSize'
    >
  >,
): Promise<ImageDescriptor[]> {
  let references: EmbeddedImageReference[];
  try {
    references = findEmbeddedImages(noteHTML);
  } catch (error) {
    throw new LocalizableError(
      'Failed to parse embedded note images',
      'notero-error-note-conversion-failed',
      { cause: error },
    );
  }
  if (references.length > options.maxNoteImageCount) {
    throw new LocalizableError(
      `Note has too many embedded images (${references.length}; limit ${options.maxNoteImageCount})`,
      'notero-error-note-image-count-limit',
    );
  }
  const byKey = new Map<string, Omit<ResolvedNoteImage, 'bytes'>>();
  const ordered: ImageDescriptor[] = [];
  let totalSize = 0;
  for (const reference of references) {
    if (!reference.attachmentKey) {
      throw new LocalizableError(
        'Embedded image is missing data-attachment-key',
        'notero-error-note-sync-failed',
      );
    }
    let descriptor = byKey.get(reference.attachmentKey);
    if (!descriptor) {
      const resolved = await resolveNoteImage(
        noteItem,
        reference,
        options.maxFileUploadSize,
      );
      const { bytes: _releasedBytes, ...withoutBytes } = resolved;
      descriptor = withoutBytes;
      byKey.set(reference.attachmentKey, descriptor);
    }
    totalSize += descriptor.size;
    if (totalSize > options.maxNoteImageTotalSize) {
      throw new LocalizableError(
        `Note aggregate embedded image size exceeds ${options.maxNoteImageTotalSize} bytes`,
        'notero-error-note-image-total-size-limit',
      );
    }
    ordered.push({ ...descriptor, alt: reference.alt, reference });
  }
  return ordered;
}

async function deterministicFilename(
  descriptor: ImageDescriptor,
  noteItem: Zotero.Item,
  targetIdentity: TargetIdentity,
): Promise<string> {
  const extension = /\.[a-z0-9]+$/i.exec(descriptor.filename)?.[0] || '';
  const identityHash = await hashText(
    [
      targetIdentity.connectionID,
      targetIdentity.workspaceID,
      targetIdentity.databaseID,
      targetIdentity.pageID,
      noteItem.libraryID,
      noteItem.topLevelItem.key,
      noteItem.key,
      descriptor.attachmentKey,
      descriptor.contentHash,
      descriptor.contentType,
      descriptor.size,
    ].join('\u0000'),
  );
  return `notero-${identityHash.slice(0, 40)}${extension}`;
}

function convert(
  noteHTML: string,
  images: ReadonlyMap<string, PreparedNotionImage>,
  converter: (html: string, options?: HtmlConversionOptions) => ChildBlock[],
): ChildBlock[] {
  try {
    return converter(noteHTML, images.size ? { images } : {});
  } catch (error) {
    throw new LocalizableError(
      'Failed to convert note content to Notion blocks',
      'notero-error-note-conversion-failed',
      { cause: error },
    );
  }
}

function collectImageAssetIDs(
  value: unknown,
  assetByPlaceholder: ReadonlyMap<string, string>,
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((child) =>
      collectImageAssetIDs(child, assetByPlaceholder),
    );
  }
  if (!isUnknownRecord(value)) return [];
  const fileUpload =
    value.type === 'file_upload' && isUnknownRecord(value.file_upload)
      ? value.file_upload
      : null;
  const ownAssetID =
    fileUpload && typeof fileUpload.id === 'string'
      ? assetByPlaceholder.get(fileUpload.id)
      : undefined;
  const nested = Object.entries(value).flatMap(([key, child]) =>
    key === 'file_upload'
      ? []
      : collectImageAssetIDs(child, assetByPlaceholder),
  );
  return ownAssetID ? [ownAssetID, ...nested] : nested;
}
