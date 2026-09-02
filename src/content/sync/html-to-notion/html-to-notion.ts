import { keyValue } from '../../utils';
import {
  ChildBlock,
  ParagraphBlock,
  RichText,
  RichTextOptions,
  isBlockType,
} from '../notion-types';
import { buildRichText } from '../notion-utils';

import {
  BlockResult,
  ContentResult,
  ListResult,
  RichTextResult,
  blockResult,
  isBlockResult,
  isListResult,
  isRichTextResult,
  listResult,
  richTextResult,
} from './content-result';
import { getRootElement } from './dom-utils';
import {
  BlockElement,
  EmbeddedImageReference,
  ImageElement,
  ListElement,
  ParentElement,
  ParsedNode,
  parseNode,
} from './parse-node';

export type PreparedNotionImage = {
  caption?: string;
  fileUploadID: string;
};

export type HtmlConversionOptions = {
  images?: ReadonlyMap<string, PreparedNotionImage>;
};

type ConversionOptions = HtmlConversionOptions & RichTextOptions;

export function findEmbeddedImages(
  htmlString: string,
): EmbeddedImageReference[] {
  const root = getRootElement(htmlString);
  if (!root) throw new Error('Failed to load HTML content');

  return Array.from(root.querySelectorAll('img')).map((element) => {
    const parsed = parseNode(element);
    if (parsed?.type !== 'image') {
      throw new Error('Failed to parse embedded image');
    }

    const { alt, attachmentKey, hasAnnotation } = parsed;
    return { alt, attachmentKey, hasAnnotation };
  });
}

export function convertHtmlToBlocks(
  htmlString: string,
  options: HtmlConversionOptions = {},
): ChildBlock[] {
  const root = getRootElement(htmlString);
  if (!root) throw new Error('Failed to load HTML content');

  const result = convertNode(root, options);

  if (
    !result ||
    !isBlockResult(result) ||
    !isBlockType('paragraph', result.block)
  ) {
    throw new Error('Unexpected HTML content');
  }

  const { children, rich_text } = result.block.paragraph;

  return [
    ...(rich_text.length ? [paragraphBlock(rich_text)] : []),
    ...(children || []),
  ];
}

function convertNode(
  node: Node,
  options: ConversionOptions = {},
): ContentResult | undefined {
  const parsedNode = parseNode(node);

  if (!parsedNode) return undefined;

  switch (parsedNode.type) {
    case 'block':
      return parsedNode.supportsChildren
        ? convertParentElement(parsedNode, options)
        : convertBlockElement(parsedNode, options);
    case 'list':
      return convertListElement(parsedNode, options);
    case 'image':
      return convertImageElement(parsedNode, options);
    case 'math_block':
      return blockResult({ equation: { expression: parsedNode.expression } });
    default:
      return richTextResult(convertRichTextNode(parsedNode, options));
  }
}

function convertParentElement(
  { annotations, blockType, color, element }: ParentElement,
  options: ConversionOptions,
): BlockResult {
  const updatedOptions = {
    ...options,
    annotations: {
      ...options.annotations,
      ...annotations,
    },
  };

  let rich_text: RichText = [];
  let children: ChildBlock[] | undefined;

  convertChildNodes(element, updatedOptions).forEach((result) => {
    let childBlock: ChildBlock;

    if (isRichTextResult(result)) {
      const trimmedRichText = trimRichText(result.richText);
      if (!trimmedRichText.length) return;

      if (!children) {
        rich_text = [...rich_text, ...trimmedRichText];
        return;
      }
      childBlock = paragraphBlock(trimmedRichText);
    } else {
      childBlock = result.block;
    }

    if (
      isBlockType('paragraph', childBlock) &&
      !childBlock.paragraph.rich_text.length &&
      childBlock.paragraph.children
    ) {
      children = [...(children || []), ...childBlock.paragraph.children];
      return;
    }

    if (
      !children &&
      !rich_text.length &&
      isBlockType('paragraph', childBlock)
    ) {
      rich_text = childBlock.paragraph.rich_text;
      children = childBlock.paragraph.children;
      return;
    }

    children = [...(children || []), childBlock];
  });

  return blockResult(
    keyValue(blockType, {
      rich_text,
      ...(children && { children }),
      ...(color && { color }),
    }),
  );
}

function convertBlockElement(
  { annotations, blockType, color, element }: BlockElement,
  options: ConversionOptions,
): BlockResult | ListResult {
  const preserveWhitespace = blockType === 'code';

  const updatedOptions = {
    ...options,
    annotations: {
      ...options.annotations,
      ...annotations,
    },
    preserveWhitespace,
  };

  const orderedResults = convertChildNodes(element, updatedOptions);
  const hasBlockBoundary = orderedResults.some(isBlockResult);

  if (hasBlockBoundary) {
    if (blockType === 'code') {
      throw new Error('Embedded images inside code blocks are not supported');
    }

    return listResult(
      orderedResults.flatMap((result) => {
        if (isBlockResult(result)) return [result];
        const rich_text = trimRichText(result.richText);
        if (!rich_text.length) return [];
        return [
          blockResult(
            keyValue(blockType, {
              rich_text,
              ...(color && { color }),
            }),
          ),
        ];
      }),
    );
  }

  let rich_text = orderedResults.flatMap((result) =>
    isRichTextResult(result) ? result.richText : [],
  );

  if (!preserveWhitespace) {
    rich_text = trimRichText(rich_text);
  }

  if (blockType === 'code') {
    return blockResult(
      keyValue(blockType, { rich_text, language: 'plain text' }),
    );
  }

  return blockResult(
    keyValue(blockType, {
      rich_text,
      ...(color && { color }),
    }),
  );
}

function convertListElement(
  node: ListElement,
  options: ConversionOptions,
): ListResult {
  return listResult(
    Array.from(node.element.children)
      .map((element) => {
        const parsedChild = parseNode(element);

        if (
          parsedChild?.type === 'block' &&
          parsedChild.supportsChildren &&
          parsedChild.blockType.endsWith('list_item')
        ) {
          return convertParentElement(parsedChild, options);
        }
        return undefined;
      })
      .filter(Boolean),
  );
}

function convertChildNodes(
  node: Node,
  options: ConversionOptions,
): (BlockResult | RichTextResult)[] {
  return Array.from(node.childNodes).reduce<(BlockResult | RichTextResult)[]>(
    (results, childNode) => {
      const childResults = convertNodeToOrderedResults(childNode, options);

      for (const result of childResults) {
        const prevResult = results[results.length - 1];
        if (
          isRichTextResult(result) &&
          prevResult &&
          isRichTextResult(prevResult)
        ) {
          results[results.length - 1] = richTextResult([
            ...prevResult.richText,
            ...result.richText,
          ]);
        } else {
          results.push(result);
        }
      }
      return results;
    },
    [],
  );
}

function convertNodeToOrderedResults(
  node: Node,
  options: ConversionOptions,
): (BlockResult | RichTextResult)[] {
  const parsedNode = parseNode(node);
  if (!parsedNode) return [];

  if (parsedNode.type === 'rich_text') {
    const updatedOptions = {
      ...options,
      annotations: {
        ...options.annotations,
        ...parsedNode.annotations,
      },
      ...(parsedNode.link && { link: parsedNode.link }),
    };
    return convertChildNodes(parsedNode.element, updatedOptions);
  }

  const result = convertNode(node, options);
  if (!result) return [];
  if (isListResult(result)) return result.results;
  return [result];
}

function convertRichTextChildNodes(
  node: Node,
  options: ConversionOptions,
): RichText {
  return Array.from(node.childNodes).reduce<RichText>(
    (combinedRichText, childNode) => {
      const parsedNode = parseNode(childNode);

      if (!parsedNode) return combinedRichText;

      if (parsedNode.type === 'image') {
        throw new Error(
          'Embedded image reached rich-text conversion without a block boundary',
        );
      }

      return [...combinedRichText, ...convertRichTextNode(parsedNode, options)];
    },
    [],
  );
}

function convertRichTextNode(
  node: ParsedNode,
  options: ConversionOptions,
): RichText {
  if (node.type === 'text') {
    return buildRichText(node.textContent, options);
  }

  if (node.type === 'br') {
    return buildRichText('\n', { ...options, preserveWhitespace: true });
  }

  if (node.type === 'inline_math') {
    return [{ equation: { expression: node.expression } }];
  }

  if (node.type === 'image') {
    throw new Error(
      'Embedded image reached rich-text conversion without a block boundary',
    );
  }

  const updatedOptions = { ...options };

  if (node.type === 'rich_text') {
    updatedOptions.annotations = {
      ...options.annotations,
      ...node.annotations,
    };
    if (node.link) {
      updatedOptions.link = node.link;
    }
  }

  return convertRichTextChildNodes(node.element, updatedOptions);
}

function convertImageElement(
  node: ImageElement,
  options: ConversionOptions,
): BlockResult | RichTextResult {
  if (!options.images) return richTextResult([]);

  const attachmentKey = node.attachmentKey;
  if (!attachmentKey) {
    throw new Error('Embedded image is missing data-attachment-key');
  }

  const preparedImage = options.images.get(attachmentKey);
  if (!preparedImage) {
    throw new Error(`Embedded image ${attachmentKey} is not prepared`);
  }

  const caption = preparedImage.caption || node.alt;

  return blockResult({
    image: {
      ...(caption && { caption: buildRichText(caption) }),
      file_upload: { id: preparedImage.fileUploadID },
      type: 'file_upload',
    },
  });
}

function paragraphBlock(richText: RichText): ParagraphBlock {
  return { paragraph: { rich_text: richText } };
}

function trimRichText(richText: RichText): RichText {
  function updateContent(
    index: number,
    updater: (content: string) => string,
  ): RichText {
    const richTextPart = richText[index];

    if (!richTextPart) return [];

    if (!('text' in richTextPart)) return [richTextPart];

    const content = updater(richTextPart.text.content);

    if (!content) return [];

    return [
      {
        ...richTextPart,
        text: { ...richTextPart.text, content },
      },
    ];
  }

  if (richText.length === 0) return richText;

  if (richText.length === 1) {
    return updateContent(0, (content) => content.trim());
  }

  const first = updateContent(0, (content) => content.trimStart());
  const middle = richText.slice(1, -1);
  const last = updateContent(richText.length - 1, (content) =>
    content.trimEnd(),
  );

  return [...first, ...middle, ...last];
}
