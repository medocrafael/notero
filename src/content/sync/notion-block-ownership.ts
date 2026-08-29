import { isFullBlock } from '@notionhq/client';

import type { ManagedBlockReference } from '../data/item-data';

import type { NotionTarget } from './notion-image-upload-service';

const OWNERSHIP_MARKER_PREFIX = 'notero-owner:v1';
const OWNERSHIP_MARKER_SEPARATOR = '\u2063';
const OWNERSHIP_MARKER_URL_PREFIX =
  'https://github.com/dvanoni/notero#notero-owner=';

export type BlockOwnershipIdentity = {
  attemptID?: string;
  kind: ManagedBlockReference['kind'];
  libraryID: number;
  noteItemKey?: string;
  parentItemKey: string;
  target: NotionTarget;
};

export type BlockOwnershipVerification =
  | { verified: true }
  | { reason: string; verified: false };

export type ManagedHeadingText = {
  text: { content: string; link?: { url: string } | null };
  type: 'text';
};

/**
 * Produce a stable opaque marker without persisting a token, source text, or a
 * local path. This marker is an identity checksum, not a secret or a bearer
 * credential; mutation still requires matching the remote block creator,
 * parent, type, target and the independently reconstructed Zotero identity.
 */
export function createOwnershipMarker(
  identity: BlockOwnershipIdentity,
): string {
  const payload = JSON.stringify([
    identity.kind,
    identity.target.connectionID,
    identity.target.workspaceID,
    identity.target.databaseID,
    identity.target.pageID,
    identity.libraryID,
    identity.parentItemKey,
    identity.noteItemKey || '',
    identity.attemptID || '',
  ]);
  return `${OWNERSHIP_MARKER_PREFIX}:${identity.kind}:${checksum64(payload)}`;
}

export function createManagedBlockReference(
  blockID: string,
  identity: BlockOwnershipIdentity,
  createdByID?: string,
): ManagedBlockReference {
  return {
    ...(identity.attemptID && { attemptID: identity.attemptID }),
    blockID,
    ...(createdByID && { createdByID }),
    kind: identity.kind,
    marker: createOwnershipMarker(identity),
  };
}

export function ownershipMarkerURL(marker: string): string {
  return `${OWNERSHIP_MARKER_URL_PREFIX}${encodeURIComponent(marker)}`;
}

export function buildManagedHeadingRichText(
  title: string,
  markers: string[],
): ManagedHeadingText[] {
  return [
    { text: { content: title }, type: 'text' as const },
    ...markers.map((marker) => ({
      text: {
        content: OWNERSHIP_MARKER_SEPARATOR,
        link: { url: ownershipMarkerURL(marker) },
      },
      type: 'text' as const,
    })),
  ];
}

export function hasExactOwnershipMarker(
  richText: readonly {
    href: null | string;
    plain_text: string;
    text?: { content: string; link: null | { url: string } };
    type: string;
  }[],
  marker: string,
): boolean {
  const expectedURL = ownershipMarkerURL(marker);
  const markerSegments = richText.filter(
    (value) =>
      value.href === expectedURL || value.text?.link?.url === expectedURL,
  );
  return (
    markerSegments.length === 1 &&
    markerSegments[0]?.type === 'text' &&
    markerSegments[0].plain_text === OWNERSHIP_MARKER_SEPARATOR &&
    markerSegments[0].href === expectedURL &&
    markerSegments[0].text?.content === OWNERSHIP_MARKER_SEPARATOR &&
    markerSegments[0].text.link?.url === expectedURL
  );
}

export function verifyManagedHeadingBlock(
  block: Parameters<typeof isFullBlock>[0],
  reference: ManagedBlockReference,
  expected: {
    allowTrashed?: boolean;
    connectionID?: string;
    marker: string;
    parentID: string;
    parentType: 'block_id' | 'page_id';
  },
): BlockOwnershipVerification {
  if (reference.marker !== expected.marker) {
    return {
      reason: 'metadata marker does not match the expected identity',
      verified: false,
    };
  }
  if (!isFullBlock(block)) {
    return { reason: 'Notion returned a partial block', verified: false };
  }
  if (block.id !== reference.blockID) {
    return { reason: 'Notion returned a different block ID', verified: false };
  }
  if (block.type !== 'heading_1' || !block.heading_1.is_toggleable) {
    return { reason: 'managed block has an unexpected type', verified: false };
  }
  if ((block.in_trash || block.archived) && !expected.allowTrashed) {
    return { reason: 'managed block is archived', verified: false };
  }
  if (expected.connectionID && block.created_by.id !== expected.connectionID) {
    return {
      reason: 'managed block was created by another connection',
      verified: false,
    };
  }
  const parentMatches =
    expected.parentType === 'page_id'
      ? block.parent.type === 'page_id' &&
        block.parent.page_id === expected.parentID
      : block.parent.type === 'block_id' &&
        block.parent.block_id === expected.parentID;
  if (!parentMatches) {
    return {
      reason: 'managed block has an unexpected parent',
      verified: false,
    };
  }
  const markerFound = hasExactOwnershipMarker(
    block.heading_1.rich_text,
    expected.marker,
  );
  return markerFound
    ? { verified: true }
    : { reason: 'remote ownership marker is missing', verified: false };
}

function checksum64(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
    right ^= right >>> 13;
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}
