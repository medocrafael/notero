import { describe, expect, it } from 'vite-plus/test';

import { convertHtmlToBlocks, findEmbeddedImages } from '../html-to-notion';

const blockTypeKeys = new Set([
  'bulleted_list_item',
  'heading_1',
  'heading_2',
  'heading_3',
  'image',
  'numbered_list_item',
  'paragraph',
  'quote',
]);

function flattenBlockTypes(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(flattenBlockTypes);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(blockTypeKeys.has(key) ? [key] : []),
    ...flattenBlockTypes(child),
  ]);
}

describe('embedded note images', () => {
  it('finds standard and PDF area-annotation images in document order', () => {
    const html = `
      <div data-schema-version="9">
        <p>Before<img data-attachment-key="IMAGEA" alt="Figure A">After</p>
        <p><img data-attachment-key="IMAGEB" data-annotation="%7B%7D"></p>
      </div>
    `;

    expect(findEmbeddedImages(html)).toStrictEqual([
      {
        alt: 'Figure A',
        attachmentKey: 'IMAGEA',
        hasAnnotation: false,
      },
      {
        alt: undefined,
        attachmentKey: 'IMAGEB',
        hasAnnotation: true,
      },
    ]);
  });

  it('reports malformed and unsupported image elements', () => {
    const html = `
      <div>
        <img src="data:image/png;base64,AAAA">
        <img src="https://example.invalid/private.png">
      </div>
    `;

    expect(findEmbeddedImages(html)).toStrictEqual([
      { alt: undefined, attachmentKey: undefined, hasAnnotation: false },
      { alt: undefined, attachmentKey: undefined, hasAnnotation: false },
    ]);
  });

  it('preserves text-image-text ordering with a prepared upload', () => {
    const html = `
      <div>
        <p>Before <img data-attachment-key="IMAGEA" alt="Figure A"> after</p>
      </div>
    `;
    const images = new Map([
      ['IMAGEA', { fileUploadID: 'upload-a', caption: 'Figure A' }],
    ]);

    expect(convertHtmlToBlocks(html, { images })).toStrictEqual([
      { paragraph: { rich_text: [{ text: { content: 'Before' } }] } },
      {
        image: {
          caption: [{ text: { content: 'Figure A' } }],
          file_upload: { id: 'upload-a' },
          type: 'file_upload',
        },
      },
      { paragraph: { rich_text: [{ text: { content: 'after' } }] } },
    ]);
  });

  it('preserves multiple images around headings, lists, and quotes', () => {
    const html = `
      <div>
        <h2>Heading</h2>
        <p><img data-attachment-key="A"></p>
        <ul><li>List<img data-attachment-key="B"></li></ul>
        <blockquote>Quote</blockquote>
      </div>
    `;
    const images = new Map([
      ['A', { fileUploadID: 'upload-a' }],
      ['B', { fileUploadID: 'upload-b' }],
    ]);

    const blocks = convertHtmlToBlocks(html, { images });

    expect(blocks.map((block) => Object.keys(block)[0])).toStrictEqual([
      'heading_2',
      'image',
      'bulleted_list_item',
      'quote',
    ]);
    expect(blocks[2]).toStrictEqual({
      bulleted_list_item: {
        children: [
          {
            image: {
              file_upload: { id: 'upload-b' },
              type: 'file_upload',
            },
          },
        ],
        rich_text: [{ text: { content: 'List' } }],
      },
    });
  });

  it('keeps legacy text-only output when image preparation is absent', () => {
    const html = '<div><p>Before<img data-attachment-key="A">After</p></div>';

    expect(convertHtmlToBlocks(html)).toStrictEqual([
      {
        paragraph: {
          rich_text: [
            { text: { content: 'Before' } },
            { text: { content: 'After' } },
          ],
        },
      },
    ]);
  });

  it.each([
    ['paragraph', '<p><img data-attachment-key="A"></p>'],
    ['mixed paragraph', '<p>before<img data-attachment-key="A">after</p>'],
    [
      'linked image',
      '<p><a href="https://example.test"><img data-attachment-key="A"></a>after</p>',
    ],
    ['span image', '<p><span><img data-attachment-key="A"></span>after</p>'],
    ['strong image', '<p><strong><img data-attachment-key="A"></strong></p>'],
    ['heading image', '<h2>before<img data-attachment-key="A">after</h2>'],
    [
      'list image',
      '<ul><li>before<img data-attachment-key="A">after</li></ul>',
    ],
    [
      'quote image',
      '<blockquote>before<img data-attachment-key="A">after</blockquote>',
    ],
    [
      'deep wrappers',
      '<p>one<a href="https://example.test"><strong><span><img data-attachment-key="A"></span></strong></a>two</p>',
    ],
  ])('renders an image found inside a %s wrapper', (_name, content) => {
    const html = `<div>${content}</div>`;
    const images = new Map([['A', { fileUploadID: 'upload-a' }]]);

    expect(findEmbeddedImages(html)).toHaveLength(1);
    expect(flattenBlockTypes(convertHtmlToBlocks(html, { images }))).toContain(
      'image',
    );
  });

  it('preserves multiple deeply wrapped text/image segments in exact order', () => {
    const html = `
      <div>
        <p>one<span><strong><img data-attachment-key="A"></strong></span>two<a href="https://example.test"><img data-attachment-key="B"></a>three</p>
      </div>
    `;
    const images = new Map([
      ['A', { fileUploadID: 'upload-a' }],
      ['B', { fileUploadID: 'upload-b' }],
    ]);

    expect(convertHtmlToBlocks(html, { images })).toStrictEqual([
      { paragraph: { rich_text: [{ text: { content: 'one' } }] } },
      { image: { file_upload: { id: 'upload-a' }, type: 'file_upload' } },
      { paragraph: { rich_text: [{ text: { content: 'two' } }] } },
      { image: { file_upload: { id: 'upload-b' }, type: 'file_upload' } },
      { paragraph: { rich_text: [{ text: { content: 'three' } }] } },
    ]);
  });
});
