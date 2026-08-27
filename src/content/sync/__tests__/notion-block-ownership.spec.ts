import type { BlockObjectResponse } from '@notionhq/client/build/src/api-endpoints';
import { describe, expect, it } from 'vite-plus/test';

import {
  type BlockOwnershipIdentity,
  createManagedBlockReference,
  createOwnershipMarker,
  verifyManagedHeadingBlock,
} from '../notion-block-ownership';

const target = {
  connectionID: 'bot-a',
  databaseID: 'database-a',
  pageID: 'page-a',
  workspaceID: 'workspace-a',
};

function managedBlock(markerText: string): BlockObjectResponse {
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
  it('recognizes an attempt marker when Notion merges adjacent marker runs', () => {
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
      kind: 'candidate',
    };
    const reference = createManagedBlockReference(
      'candidate-a',
      attemptIdentity,
    );
    const block = managedBlock(
      `\u2063${createOwnershipMarker(stableIdentity)}\u2063${reference.marker}`,
    );

    expect(
      verifyManagedHeadingBlock(block, reference, {
        connectionID: target.connectionID,
        marker: reference.marker,
        parentID: 'container-a',
        parentType: 'block_id',
      }),
    ).toEqual({ verified: true });
  });
});
