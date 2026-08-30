import type { BlockObjectResponse } from '@notionhq/client/build/src/api-endpoints';
import { describe, expect, it } from 'vite-plus/test';

import {
  type BlockOwnershipIdentity,
  buildManagedHeadingRichText,
  createManagedBlockReference,
  createOwnershipMarker,
  ownershipMarkerURL,
  verifyManagedHeadingBlock,
} from '../notion-block-ownership';

const target = {
  connectionID: 'bot-a',
  databaseID: 'database-a',
  pageID: 'page-a',
  workspaceID: 'workspace-a',
};

function managedBlock(
  markerText: string,
): Extract<BlockObjectResponse, { type: 'heading_1' }> {
  return {
    archived: false,
    created_by: { id: target.connectionID, object: 'user' },
    created_time: new Date(0).toISOString(),
    has_children: true,
    heading_1: {
      color: 'default',
      is_toggleable: true,
      rich_text: [
        {
          annotations: {
            bold: false,
            code: true,
            color: 'gray',
            italic: false,
            strikethrough: false,
            underline: false,
          },
          href: null,
          plain_text: markerText,
          text: { content: markerText, link: null },
          type: 'text',
        },
      ],
    },
    id: 'candidate-a',
    in_trash: false,
    last_edited_by: { id: target.connectionID, object: 'user' },
    last_edited_time: new Date(0).toISOString(),
    object: 'block',
    parent: { block_id: 'container-a', type: 'block_id' },
    type: 'heading_1',
  };
}

describe('Notion managed block ownership', () => {
  it('keeps the ASCII ownership identity out of heading plain text', () => {
    const identity: BlockOwnershipIdentity = {
      kind: 'note',
      libraryID: 1,
      noteItemKey: 'NOTE',
      parentItemKey: 'PARENT',
      target,
    };
    const marker = createOwnershipMarker(identity);
    const richText = buildManagedHeadingRichText('User title', [marker]);

    expect(richText.map(({ text }) => text.content).join('')).toBe(
      'User title\u2063',
    );
    expect(JSON.stringify(richText)).not.toContain(marker);
    expect(richText[1]).toMatchObject({
      text: { content: '\u2063', link: { url: ownershipMarkerURL(marker) } },
    });
  });

  it('recognizes an exact invisible linked attempt marker', () => {
    const stableIdentity: BlockOwnershipIdentity = {
      kind: 'note',
      libraryID: 1,
      noteItemKey: 'NOTE',
      parentItemKey: 'PARENT',
      target,
    };
    const attemptIdentity: BlockOwnershipIdentity = {
      ...stableIdentity,
      attemptID: 'attempt-a',
      kind: 'note',
    };
    const reference = createManagedBlockReference(
      'candidate-a',
      attemptIdentity,
    );
    const block = managedBlock('\u2063');
    block.heading_1.rich_text[0] = {
      annotations: {
        bold: false,
        code: false,
        color: 'default',
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: ownershipMarkerURL(reference.marker),
      plain_text: '\u2063',
      text: {
        content: '\u2063',
        link: { url: ownershipMarkerURL(reference.marker) },
      },
      type: 'text',
    };

    expect(
      verifyManagedHeadingBlock(block, reference, {
        connectionID: target.connectionID,
        marker: reference.marker,
        parentID: 'container-a',
        parentType: 'block_id',
      }),
    ).toEqual({ verified: true });
  });

  it('allows the user-visible title to change while the exact marker remains intact', () => {
    const identity: BlockOwnershipIdentity = {
      kind: 'note',
      libraryID: 1,
      noteItemKey: 'NOTE',
      parentItemKey: 'PARENT',
      target,
    };
    const reference = createManagedBlockReference('candidate-a', identity);
    const block = managedBlock('User-renamed title');
    block.heading_1.rich_text.push({
      annotations: {
        bold: false,
        code: false,
        color: 'default',
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: ownershipMarkerURL(reference.marker),
      plain_text: '\u2063',
      text: {
        content: '\u2063',
        link: { url: ownershipMarkerURL(reference.marker) },
      },
      type: 'text',
    });

    expect(
      verifyManagedHeadingBlock(block, reference, {
        connectionID: target.connectionID,
        marker: reference.marker,
        parentID: 'container-a',
        parentType: 'block_id',
      }),
    ).toEqual({ verified: true });
  });

  it('stops safely when Notion returns duplicate marker segments', () => {
    const identity: BlockOwnershipIdentity = {
      attemptID: 'attempt-a',
      kind: 'note',
      libraryID: 1,
      noteItemKey: 'NOTE',
      parentItemKey: 'PARENT',
      target,
    };
    const reference = createManagedBlockReference('candidate-a', identity);
    const block = managedBlock('User title');
    const markerURL = ownershipMarkerURL(reference.marker);
    for (const plainText of ['\u2063', '\u2063']) {
      block.heading_1.rich_text.push({
        annotations: {
          bold: false,
          code: false,
          color: 'default',
          italic: false,
          strikethrough: false,
          underline: false,
        },
        href: markerURL,
        plain_text: plainText,
        text: { content: plainText, link: { url: markerURL } },
        type: 'text',
      });
    }

    expect(
      verifyManagedHeadingBlock(block, reference, {
        connectionID: target.connectionID,
        marker: reference.marker,
        parentID: 'container-a',
        parentType: 'block_id',
      }),
    ).toMatchObject({ verified: false });
  });

  it.each([
    ['prefix', `x\u2063`, undefined],
    ['suffix', `\u2063x`, undefined],
    ['changed href', '\u2063', ownershipMarkerURL('changed')],
    ['deleted link', '\u2063', null],
  ])('rejects a marker with %s', (_case, plainText, linkOverride) => {
    const identity: BlockOwnershipIdentity = {
      attemptID: 'attempt-a',
      kind: 'note',
      libraryID: 1,
      noteItemKey: 'NOTE',
      parentItemKey: 'PARENT',
      target,
    };
    const reference = createManagedBlockReference('candidate-a', identity);
    const expectedURL = ownershipMarkerURL(reference.marker);
    const block = managedBlock(plainText);
    block.heading_1.rich_text[0] = {
      annotations: {
        bold: false,
        code: false,
        color: 'default',
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: linkOverride === undefined ? expectedURL : linkOverride,
      plain_text: plainText,
      text: {
        content: plainText,
        link:
          linkOverride === null
            ? null
            : { url: linkOverride === undefined ? expectedURL : linkOverride },
      },
      type: 'text',
    };

    expect(
      verifyManagedHeadingBlock(block, reference, {
        connectionID: target.connectionID,
        marker: reference.marker,
        parentID: 'container-a',
        parentType: 'block_id',
      }),
    ).toMatchObject({ verified: false });
  });
});
