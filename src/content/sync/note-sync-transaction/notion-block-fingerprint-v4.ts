import { digestCanonical } from './canonical';

type JsonRecord = Record<string, unknown>;

const BLOCK_TYPES = [
  'bookmark',
  'bulleted_list_item',
  'callout',
  'code',
  'divider',
  'embed',
  'equation',
  'heading_1',
  'heading_2',
  'heading_3',
  'image',
  'numbered_list_item',
  'paragraph',
  'quote',
  'table',
  'table_of_contents',
  'table_row',
  'to_do',
  'toggle',
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeAnnotations(value: unknown): JsonRecord {
  const annotations = isRecord(value) ? value : {};
  return {
    bold: annotations.bold === true,
    code: annotations.code === true,
    color:
      typeof annotations.color === 'string' ? annotations.color : 'default',
    italic: annotations.italic === true,
    strikethrough: annotations.strikethrough === true,
    underline: annotations.underline === true,
  };
}

function normalizeRichText(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (!isRecord(entry)) return { type: 'invalid' };
    const type = typeof entry.type === 'string' ? entry.type : 'text';
    const normalized: JsonRecord = {
      annotations: normalizeAnnotations(entry.annotations),
      type,
    };
    if (type === 'text') {
      const text = isRecord(entry.text) ? entry.text : {};
      const link = isRecord(text.link) ? text.link : null;
      normalized.text = {
        content:
          typeof text.content === 'string'
            ? text.content
            : typeof entry.plain_text === 'string'
              ? entry.plain_text
              : '',
        link: link && typeof link.url === 'string' ? { url: link.url } : null,
      };
    } else if (type === 'equation') {
      const equation = isRecord(entry.equation) ? entry.equation : {};
      normalized.equation = {
        expression:
          typeof equation.expression === 'string' ? equation.expression : '',
      };
    } else if (type === 'mention') {
      normalized.mention = normalizeUnknown(entry.mention);
    }
    return normalized;
  });
}

function normalizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeUnknown);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            'archived',
            'created_by',
            'created_time',
            'has_children',
            'href',
            'in_trash',
            'last_edited_by',
            'last_edited_time',
            'object',
            'parent',
            'plain_text',
          ].includes(key),
      )
      .map(([key, child]) => [key, normalizeUnknown(child)]),
  );
}

function blockType(block: JsonRecord): string {
  if (typeof block.type === 'string' && isRecord(block[block.type])) {
    return block.type;
  }
  return BLOCK_TYPES.find((type) => isRecord(block[type])) ?? 'unsupported';
}

function normalizeChildren(data: JsonRecord): unknown[] {
  if (!Array.isArray(data.children)) return [];
  return data.children.map(normalizeBlock);
}

function normalizeBlock(value: unknown): unknown {
  if (!isRecord(value)) return { type: 'invalid' };
  const type = blockType(value);
  const data = isRecord(value[type]) ? value[type] : {};
  const children = normalizeChildren(data);
  const withChildren = (body: JsonRecord): JsonRecord => ({
    ...body,
    ...(children.length > 0 && { children }),
    type,
  });
  switch (type) {
    case 'paragraph':
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'bulleted_list_item':
    case 'numbered_list_item':
    case 'quote':
    case 'toggle':
      return withChildren({ richText: normalizeRichText(data.rich_text) });
    case 'to_do':
      return withChildren({
        checked: data.checked === true,
        richText: normalizeRichText(data.rich_text),
      });
    case 'code':
      return withChildren({
        caption: normalizeRichText(data.caption),
        language:
          typeof data.language === 'string' ? data.language : 'plain text',
        richText: normalizeRichText(data.rich_text),
      });
    case 'equation':
      return withChildren({
        expression: typeof data.expression === 'string' ? data.expression : '',
      });
    case 'image':
      // Notion replaces a file_upload reference with a hosted file URL after
      // attachment. The upload ID is proven separately by durable upload and
      // batch evidence, so the semantic block proof covers position/caption.
      return withChildren({ caption: normalizeRichText(data.caption) });
    case 'divider':
    case 'table_of_contents':
      return withChildren({});
    case 'bookmark':
    case 'embed':
      return withChildren({
        caption: normalizeRichText(data.caption),
        url: typeof data.url === 'string' ? data.url : '',
      });
    case 'table':
      return withChildren({
        hasColumnHeader: data.has_column_header === true,
        hasRowHeader: data.has_row_header === true,
        tableWidth: typeof data.table_width === 'number' ? data.table_width : 0,
      });
    case 'table_row':
      return withChildren({
        cells: Array.isArray(data.cells)
          ? data.cells.map(normalizeRichText)
          : [],
      });
    default:
      return withChildren({ data: normalizeUnknown(data) });
  }
}

export function deriveNotionBlockFingerprint(
  block: unknown,
  identity: {
    batchIndex: number;
    blockIndex: number;
    sourceVersion: string;
  },
): string {
  return digestCanonical('notero-block-v4', {
    ...identity,
    block: normalizeBlock(block),
  });
}
