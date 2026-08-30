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

import type { OperationPayloadProvider } from './notion-operation-adapter';
import type {
  NoteSyncRecordV3,
  SourceSnapshot,
  TargetIdentity,
  UploadAssetRecord,
} from './types';

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
};

export type ImageDescriptor = Omit<ResolvedNoteImage, 'bytes'> & {
  reference: EmbeddedImageReference;
};

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

export class NoteSourceAdapter implements OperationPayloadProvider {
  private readonly appendPayloads = new Map<string, BlockObjectRequest[]>();

  private constructor(
    private readonly noteItem: Zotero.Item,
    private readonly noteHTML: string,
    private readonly noteTitle: string,
    private readonly targetIdentity: TargetIdentity,
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
    public readonly snapshot: SourceSnapshot,
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
        'notero-note-source:v3',
        targetIdentity.libraryID,
        targetIdentity.parentItemKey,
        targetIdentity.noteItemKey,
        noteTitle,
        noteHTML,
        featurePolicy,
        orderedImages,
        'converter-v3',
      ].join('\u0000'),
    );
    const manifestDigest = await hashText(
      `notero-note-manifest:v3\u0000${sourceVersion}\u0000${JSON.stringify(templateBlocks)}`,
    );
    const imageAssets: SourceSnapshot['imageAssets'][number][] = [];
    const seenAssets = new Set<string>();
    for (const descriptor of descriptors) {
      const key = `${descriptor.attachmentKey}:${descriptor.contentHash}`;
      if (seenAssets.has(key)) continue;
      seenAssets.add(key);
      imageAssets.push({
        attachmentKey: descriptor.attachmentKey,
        contentHash: descriptor.contentHash,
        contentLength: descriptor.size,
        contentType: descriptor.contentType,
        filename: await deterministicFilename(
          descriptor,
          noteItem,
          targetIdentity,
        ),
      });
    }
    const snapshot: SourceSnapshot = {
      batches: batches(templateBlocks),
      featurePolicy,
      imageAssets,
      manifestDigest,
      sourceVersion,
      title: noteTitle,
    };
    return new NoteSourceAdapter(
      noteItem,
      noteHTML,
      noteTitle,
      targetIdentity,
      normalized,
      descriptors,
      snapshot,
    );
  }

  public buildBatches(record: NoteSyncRecordV3): BlockObjectRequest[][] {
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

  public registerAppendPayload(
    operationID: string,
    payload: BlockObjectRequest[],
  ): void {
    this.appendPayloads.set(operationID, payload);
  }

  public async getAppendBatch(
    intent: Parameters<OperationPayloadProvider['getAppendBatch']>[0],
  ): Promise<BlockObjectRequest[]> {
    const payload = this.appendPayloads.get(intent.operationID);
    if (!payload) {
      throw new Error(`Append payload ${intent.operationID} is not available`);
    }
    return payload;
  }

  public async getUploadBytes(
    intent: Parameters<OperationPayloadProvider['getUploadBytes']>[0],
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
    record: NoteSyncRecordV3,
    descriptor: Pick<ImageDescriptor, 'attachmentKey' | 'contentHash'>,
  ): UploadAssetRecord | undefined {
    return record.uploads.find(
      (upload) =>
        upload.attachmentKey === descriptor.attachmentKey &&
        upload.contentHash === descriptor.contentHash &&
        upload.targetIdentity.connectionID ===
          this.targetIdentity.connectionID &&
        upload.targetIdentity.workspaceID === this.targetIdentity.workspaceID &&
        upload.targetIdentity.databaseID === this.targetIdentity.databaseID &&
        upload.targetIdentity.pageID === this.targetIdentity.pageID &&
        ['attached', 'created-unsent', 'uploaded'].includes(upload.status) &&
        (upload.expiryTime === null ||
          !upload.expiryTime ||
          Date.parse(upload.expiryTime) > Date.now()),
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
