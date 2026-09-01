import { APIErrorCode, type Client } from '@notionhq/client';
import type {
  BlockObjectRequest,
  BlockObjectResponse,
  FileUploadObjectResponse,
} from '@notionhq/client/build/src/api-endpoints';
import { APIResponseError } from '@notionhq/client/build/src/errors';
import { describe, expect, it, vi } from 'vite-plus/test';

import { buildManagedHeadingRichText } from '../../notion-block-ownership';
import { deriveFileUploadBindingDigest } from '../identity-v4';
import { createOperationIntent } from '../model-v4';
import { deriveNotionBlockFingerprint } from '../notion-block-fingerprint-v4';
import {
  type NotionBlocksClientV4,
  NotionOperationAdapterV2,
  type NotionUploadGatewayV4,
  type OperationPayloadProviderV4,
} from '../notion-operation-adapter-v4';
import type {
  CleanupWorkerLease,
  MutationAuthorization,
  SealedOperationIntent,
} from '../types-v4';

import {
  candidateResourceV4,
  clockV4,
  containerV4,
  finalizeIntentV4,
  leaseV4,
  manifestDigestV4,
  sourceDescriptorV4,
  sourceVersionV4,
  targetV4,
} from './fixtures-v4';

function emptyMock<T extends (...args: never[]) => unknown>() {
  return vi.fn<T>();
}

function implementationMock<T extends (...args: never[]) => unknown>(
  implementation: T,
) {
  return vi.fn<T>(implementation);
}

function heading(
  resource: ReturnType<typeof candidateResourceV4>,
  title: string,
  options: { archived?: boolean; inTrash?: boolean } = {},
): Extract<BlockObjectResponse, { type: 'heading_1' }> {
  return {
    archived: options.archived ?? false,
    created_by: { id: resource.createdByID, object: 'user' },
    created_time: clockV4.nowISOString(),
    has_children: true,
    heading_1: {
      color: 'default',
      is_toggleable: true,
      rich_text: buildManagedHeadingRichText(title, [
        resource.operationMarker,
        resource.ownershipMarker,
        resource.versionMarker,
      ]).map((value) => ({
        annotations: {
          bold: false,
          code: false,
          color: 'default',
          italic: false,
          strikethrough: false,
          underline: false,
        },
        href: value.text.link?.url || null,
        plain_text: value.text.content,
        text: { content: value.text.content, link: value.text.link || null },
        type: 'text' as const,
      })),
    },
    id: resource.blockID,
    in_trash: options.inTrash ?? false,
    last_edited_by: { id: resource.createdByID, object: 'user' },
    last_edited_time: resource.lastEditedTime,
    object: 'block',
    parent:
      resource.parent.type === 'page_id'
        ? { page_id: resource.parent.id, type: 'page_id' }
        : { block_id: resource.parent.id, type: 'block_id' },
    type: 'heading_1',
  };
}

function paragraph(
  blockID: string,
  parentID: string,
  text: string,
): Extract<BlockObjectResponse, { type: 'paragraph' }> {
  const now = clockV4.nowISOString();
  return {
    archived: false,
    created_by: { id: containerV4().createdByID, object: 'user' },
    created_time: now,
    has_children: false,
    id: blockID,
    in_trash: false,
    last_edited_by: { id: containerV4().createdByID, object: 'user' },
    last_edited_time: now,
    object: 'block',
    paragraph: {
      color: 'default',
      rich_text: [
        {
          annotations: {
            bold: false,
            code: false,
            color: 'default',
            italic: false,
            strikethrough: false,
            underline: false,
          },
          href: null,
          plain_text: text,
          text: { content: text, link: null },
          type: 'text',
        },
      ],
    },
    parent: { block_id: parentID, type: 'block_id' },
    type: 'paragraph',
  };
}

function image(
  blockID: string,
  parentID: string,
): Extract<BlockObjectResponse, { type: 'image' }> {
  const now = clockV4.nowISOString();
  return {
    archived: false,
    created_by: { id: containerV4().createdByID, object: 'user' },
    created_time: now,
    has_children: false,
    id: blockID,
    image: {
      caption: [],
      file: {
        expiry_time: clockV4.addMs(now, 60_000),
        url: 'https://synthetic.invalid/notion/asset-a',
      },
      type: 'file',
    },
    in_trash: false,
    last_edited_by: { id: containerV4().createdByID, object: 'user' },
    last_edited_time: now,
    object: 'block',
    parent: { block_id: parentID, type: 'block_id' },
    type: 'image',
  };
}

function objectNotFound(): APIResponseError {
  return new APIResponseError({
    code: APIErrorCode.ObjectNotFound,
    headers: new Headers(),
    message: 'not found',
    rawBodyText: 'not found',
    status: 404,
  });
}

function harness(
  blockOverrides: Partial<Omit<NotionBlocksClientV4['blocks'], 'children'>> & {
    children?: Partial<NotionBlocksClientV4['blocks']['children']>;
  } = {},
  pageRetrieve: Client['pages']['retrieve'] = emptyMock<
    Client['pages']['retrieve']
  >(),
) {
  const blocks: NotionBlocksClientV4['blocks'] = {
    children: {
      append:
        blockOverrides.children?.append ||
        emptyMock<NotionBlocksClientV4['blocks']['children']['append']>(),
      list:
        blockOverrides.children?.list ||
        emptyMock<NotionBlocksClientV4['blocks']['children']['list']>(),
    },
    delete:
      blockOverrides.delete ||
      emptyMock<NotionBlocksClientV4['blocks']['delete']>(),
    retrieve:
      blockOverrides.retrieve ||
      emptyMock<NotionBlocksClientV4['blocks']['retrieve']>(),
    update:
      blockOverrides.update ||
      emptyMock<NotionBlocksClientV4['blocks']['update']>(),
  };
  const uploads: NotionUploadGatewayV4 = {
    create: emptyMock<NotionUploadGatewayV4['create']>(),
    reconcileCreate: emptyMock<NotionUploadGatewayV4['reconcileCreate']>(),
    retrieve: emptyMock<NotionUploadGatewayV4['retrieve']>(),
    sendCreated: emptyMock<NotionUploadGatewayV4['sendCreated']>(),
  };
  const payloads: OperationPayloadProviderV4 = {
    getAppendBatch: emptyMock<OperationPayloadProviderV4['getAppendBatch']>(),
    getUploadBytes: emptyMock<OperationPayloadProviderV4['getUploadBytes']>(),
  };
  const notion = { blocks, pages: { retrieve: pageRetrieve } };
  const adapter = new NotionOperationAdapterV2(
    notion,
    payloads,
    uploads,
    clockV4,
  );
  const executeWithReauthorization: (
    authorization: MutationAuthorization,
    reauthorize: () => Promise<MutationAuthorization>,
  ) => ReturnType<NotionOperationAdapterV2['execute']> =
    adapter.execute.bind(adapter);
  return {
    adapter,
    blocks,
    executeWithReauthorization,
    pages: notion.pages,
    payloads,
    uploads,
  };
}

function mainBase() {
  const lease = leaseV4();
  return {
    createdAt: clockV4.nowISOString(),
    generation: lease.generation,
    leaseEpoch: lease.leaseEpoch,
    leaseID: lease.leaseID,
    operationSequence: 1,
    owner: 'MAIN' as const,
    processSessionID: lease.processSessionID,
    sourceVersion: sourceVersionV4,
    targetIdentityDigest: candidateResourceV4().targetIdentityDigest,
    transactionID: lease.transactionID,
  };
}

function authorize(
  intent: SealedOperationIntent,
  lease: MutationAuthorization['lease'] = leaseV4(),
): MutationAuthorization {
  return {
    authorizedAt: clockV4.nowISOString(),
    intent,
    lease,
    noteRevision: 4,
    oneTimeToken: `authorization:${intent.operationID}`,
    rootRevision: 7,
  };
}

describe('Notion FSM v2 operation adapter', () => {
  it('fails closed when the container parent page preflight is partial', async () => {
    const container = containerV4();
    const append = implementationMock<
      NotionBlocksClientV4['blocks']['children']['append']
    >(async () => ({
      block: {},
      has_more: false,
      next_cursor: null,
      object: 'list',
      results: [heading(container, 'Zotero Notes')],
      type: 'block',
    }));
    const retrievePage = implementationMock<Client['pages']['retrieve']>(
      async () => ({ id: targetV4.pageID, object: 'page' }),
    );
    const test = harness({ children: { append } }, retrievePage);
    const intent = createOperationIntent({
      ...mainBase(),
      details: {
        expectedCreator: container.createdByID,
        isolationDeadline: clockV4.addMs(clockV4.nowISOString(), 60_000),
        migrationNotice: false,
        operationMarker: container.operationMarker,
        ownershipMarker: container.ownershipMarker,
        parent: container.parent,
        requestStartedAt: clockV4.nowISOString(),
        resourceTargetIdentityDigest: container.targetIdentityDigest,
        title: 'Zotero Notes',
        versionMarker: container.versionMarker,
      },
      kind: 'CREATE_CONTAINER',
      operationID: container.operationMarker,
    });

    const result = await test.adapter.execute(authorize(intent));

    expect(result.type).toBe('REJECTED');
    expect(retrievePage.mock.calls).toHaveLength(1);
    expect(append.mock.calls).toHaveLength(0);
  });

  it('does not append after post-preflight durable authorization changes', async () => {
    const resource = candidateResourceV4();
    const append =
      emptyMock<NotionBlocksClientV4['blocks']['children']['append']>();
    const test = harness({
      children: { append },
      retrieve: implementationMock(async () =>
        heading(resource, 'Synthetic note'),
      ),
    });
    const intent = createOperationIntent({
      ...mainBase(),
      details: {
        batchDigest: 'batch:post-preflight',
        batchIndex: 0,
        blockFingerprints: [],
        candidate: resource,
        expectedBlockCount: 0,
        expectedTitle: 'Synthetic note',
        fileUploads: [],
        precedingBlockIDs: [],
      },
      kind: 'APPEND_BATCH',
      operationID: 'operation:post-preflight-changed',
    });
    test.payloads.getAppendBatch = implementationMock(async () => []);
    const initial = authorize(intent);

    const result = await test.executeWithReauthorization(initial, async () => ({
      ...initial,
      noteRevision: initial.noteRevision + 1,
      oneTimeToken: `${initial.oneTimeToken}:fresh`,
    }));

    expect(result.type).toBe('PROVEN_UNEXECUTED');
    expect(append.mock.calls).toHaveLength(0);
  });

  it('revalidates the complete candidate manifest immediately before finalization update', async () => {
    const resource = candidateResourceV4();
    const list = implementationMock<
      NotionBlocksClientV4['blocks']['children']['list']
    >(async () => ({
      block: {},
      has_more: false,
      next_cursor: null,
      object: 'list',
      results: [paragraph('child:0', resource.blockID, 'user-edited text')],
      type: 'block',
    }));
    const update = implementationMock<NotionBlocksClientV4['blocks']['update']>(
      async () => heading(resource, 'Synthetic note'),
    );
    const test = harness({
      children: { list },
      retrieve: implementationMock(async () =>
        heading(resource, 'Notero Sync Incomplete — Synthetic note'),
      ),
      update,
    });

    const result = await test.adapter.execute(authorize(finalizeIntentV4()));

    expect(result.type).toBe('UNCERTAIN');
    expect(list.mock.calls).toHaveLength(1);
    expect(update.mock.calls).toHaveLength(0);
  });

  it('prevalidates candidate ownership immediately before append and verifies exact content', async () => {
    const request: BlockObjectRequest = {
      paragraph: {
        rich_text: [{ text: { content: 'safe text' }, type: 'text' }],
      },
    };
    const resource = candidateResourceV4();
    const response = paragraph('child-1', resource.blockID, 'safe text');
    const retrieve = implementationMock<
      NotionBlocksClientV4['blocks']['retrieve']
    >(async () => heading(resource, 'Synthetic note'));
    const append = implementationMock<
      NotionBlocksClientV4['blocks']['children']['append']
    >(async () => ({
      block: {},
      has_more: false,
      next_cursor: null,
      object: 'list',
      results: [response],
      type: 'block',
    }));
    const list = implementationMock<
      NotionBlocksClientV4['blocks']['children']['list']
    >(async () => ({
      block: {},
      has_more: false,
      next_cursor: null,
      object: 'list',
      results: [response],
      type: 'block',
    }));
    const test = harness({ children: { append, list }, retrieve });
    test.payloads.getAppendBatch = implementationMock(async () => [request]);
    const intent = createOperationIntent({
      ...mainBase(),
      details: {
        batchDigest: 'batch:0',
        batchIndex: 0,
        blockFingerprints: [
          deriveNotionBlockFingerprint(request, {
            batchIndex: 0,
            blockIndex: 0,
            sourceVersion: sourceVersionV4,
          }),
        ],
        candidate: resource,
        expectedBlockCount: 1,
        expectedTitle: 'Synthetic note',
        fileUploads: [],
        precedingBlockIDs: [],
      },
      kind: 'APPEND_BATCH',
      operationID: 'operation:append-v4',
    });

    const result = await test.adapter.execute(authorize(intent));

    expect(result.type).toBe('OBSERVED');
    expect(result.type === 'OBSERVED' && result.observation.outcome).toBe(
      'APPENDED',
    );
    expect(retrieve.mock.invocationCallOrder[0]).toBeLessThan(
      append.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    {
      name: 'an attached File Upload ID whose observable asset identity belongs to another image',
      remoteContentLength: 8,
      remoteContentType: 'image/jpeg',
      remoteCreator: 'other-bot',
      remoteFilename: 'notero-asset-b.jpg',
    },
    {
      name: 'an attached File Upload whose official content_length is null',
      remoteContentLength: null,
      remoteContentType: 'image/png',
      remoteCreator: null,
      remoteFilename: 'notero-asset-a.png',
    },
  ])('rejects $name', async (remoteIdentity) => {
    const request: BlockObjectRequest = {
      image: {
        caption: [],
        file_upload: { id: 'upload-asset-a' },
        type: 'file_upload',
      },
      type: 'image',
    };
    const resource = candidateResourceV4();
    const response = image('child-upload-binding', resource.blockID);
    const list = implementationMock<
      NotionBlocksClientV4['blocks']['children']['list']
    >(async () => ({
      block: {},
      has_more: false,
      next_cursor: null,
      object: 'list',
      results: [response],
      type: 'block',
    }));
    const test = harness({
      children: { list },
      retrieve: implementationMock(async () =>
        heading(resource, 'Synthetic note'),
      ),
    });
    test.uploads.retrieve = implementationMock<
      NotionUploadGatewayV4['retrieve']
    >(async () => ({
      archived: false,
      content_length: remoteIdentity.remoteContentLength,
      content_type: remoteIdentity.remoteContentType,
      created_by: {
        id: remoteIdentity.remoteCreator || resource.createdByID,
        type: 'bot',
      },
      created_time: clockV4.nowISOString(),
      expiry_time: null,
      filename: remoteIdentity.remoteFilename,
      id: 'upload-asset-a',
      last_edited_time: clockV4.nowISOString(),
      object: 'file_upload',
      status: 'uploaded',
    }));
    const intent = createOperationIntent({
      ...mainBase(),
      details: {
        batchDigest: 'batch:upload-binding',
        batchIndex: 0,
        blockFingerprints: [
          deriveNotionBlockFingerprint(request, {
            batchIndex: 0,
            blockIndex: 0,
            sourceVersion: sourceVersionV4,
          }),
        ],
        candidate: resource,
        expectedBlockCount: 1,
        expectedTitle: 'Synthetic note',
        fileUploads: [
          {
            assetID: 'asset:a',
            assetIdentityDigest: 'asset:a',
            contentHash: 'content:a',
            contentLength: 4,
            contentType: 'image/png',
            expectedCreator: resource.createdByID,
            fileUploadBindingDigest: deriveFileUploadBindingDigest({
              assetIdentityDigest: 'asset:a',
              fileUploadID: 'upload-asset-a',
              targetIdentityDigest: resource.targetIdentityDigest,
            }),
            fileUploadID: 'upload-asset-a',
            filename: 'notero-asset-a.png',
          },
        ],
        precedingBlockIDs: [],
      },
      kind: 'APPEND_BATCH',
      operationID: 'operation:append-upload-binding',
    });

    const result = await test.adapter.observe(intent);

    expect(result.type).toBe('UNCERTAIN');
    expect(result.type === 'UNCERTAIN' ? result.reasonCode : '').toBe(
      'UPLOAD_IDENTITY_CHANGED',
    );
  });

  it('does not append after a candidate ownership mismatch', async () => {
    const resource = candidateResourceV4();
    const append =
      emptyMock<NotionBlocksClientV4['blocks']['children']['append']>();
    const changed = heading(
      { ...resource, ownershipMarker: 'foreign-owner' },
      'Synthetic note',
    );
    const test = harness({
      children: { append },
      retrieve: implementationMock(async () => changed),
    });
    const intent = createOperationIntent({
      ...mainBase(),
      details: {
        batchDigest: 'batch:0',
        batchIndex: 0,
        blockFingerprints: [],
        candidate: resource,
        expectedBlockCount: 0,
        expectedTitle: 'Synthetic note',
        fileUploads: [],
        precedingBlockIDs: [],
      },
      kind: 'APPEND_BATCH',
      operationID: 'operation:blocked-append-v4',
    });
    test.payloads.getAppendBatch = implementationMock(async () => []);

    const result = await test.adapter.execute(authorize(intent));

    expect(result.type).toBe('UNCERTAIN');
    expect(append.mock.calls).toHaveLength(0);
  });

  it('creates a candidate with an explicit staging title, never its final title', async () => {
    const container = containerV4();
    const candidate = candidateResourceV4();
    const stagingTitle = 'Notero Sync Incomplete — Final note title';
    const retrieve = implementationMock(async () =>
      heading(container, 'Zotero Notes'),
    );
    const append = implementationMock<
      NotionBlocksClientV4['blocks']['children']['append']
    >(async () => ({
      block: {},
      has_more: false,
      next_cursor: null,
      object: 'list',
      results: [heading(candidate, stagingTitle)],
      type: 'block',
    }));
    const test = harness({ children: { append }, retrieve });
    const intent = createOperationIntent({
      ...mainBase(),
      details: {
        container,
        expectedBatchCount: 1,
        expectedBlockCount: 1,
        expectedCreator: candidate.createdByID,
        expectedImageCount: 0,
        expectedImageUploadIDs: [],
        finalTitle: 'Final note title',
        imageAssetIdentities: [],
        isolationDeadline: clockV4.addMs(clockV4.nowISOString(), 60_000),
        manifestDigest: manifestDigestV4,
        operationMarker: candidate.operationMarker,
        ownershipMarker: candidate.ownershipMarker,
        parent: candidate.parent,
        previousActiveBlockID: null,
        requestStartedAt: clockV4.nowISOString(),
        sourceDescriptor: sourceDescriptorV4,
        stagingTitle,
        versionMarker: candidate.versionMarker,
      },
      kind: 'CREATE_CANDIDATE',
      operationID: candidate.operationMarker,
    });

    const result = await test.adapter.execute(authorize(intent));

    expect(result.type).toBe('OBSERVED');
    const request = append.mock.calls[0]?.[0];
    const created = request?.children[0];
    if (!created || !('heading_1' in created)) {
      throw new Error('Expected candidate heading request');
    }
    expect(created.heading_1.rich_text[0]).toMatchObject({
      text: { content: stagingTitle },
    });
    expect(created.heading_1.rich_text[0]).not.toMatchObject({
      text: { content: 'Final note title' },
    });
    expect(created.heading_1.rich_text).toHaveLength(4);
  });

  it('recognizes the official expired plus archived File Upload lifecycle', async () => {
    const test = harness();
    const expired: FileUploadObjectResponse = {
      archived: true,
      content_length: 4,
      content_type: 'image/png',
      created_by: { id: containerV4().createdByID, type: 'bot' },
      created_time: clockV4.nowISOString(),
      expiry_time: clockV4.addMs(clockV4.nowISOString(), -1),
      filename: 'notero-expired.png',
      id: 'upload-expired-v4',
      last_edited_time: clockV4.nowISOString(),
      object: 'file_upload',
      status: 'expired',
    };
    test.uploads.retrieve = implementationMock(async () => expired);
    const intent = createOperationIntent({
      ...mainBase(),
      details: {
        assetID: 'asset:expired-v4',
        assetIdentityDigest: 'asset:expired-v4',
        attachmentIdentity: 'attachment:expired-v4',
        attachmentKey: 'IMAGE_EXPIRED',
        contentHash: 'content:expired-v4',
        contentLength: 4,
        contentType: 'image/png',
        createOperationID: 'operation:create-expired-v4',
        expectedCreator: containerV4().createdByID,
        fileUploadID: expired.id,
        filename: expired.filename || 'notero-expired.png',
        sourceIdentity: 'source-image:expired-v4',
      },
      kind: 'UPLOAD_SEND',
      operationID: 'operation:send-expired-v4',
    });

    const result = await test.adapter.observe(intent);

    expect(result.type).toBe('OBSERVED');
    expect(
      result.type === 'OBSERVED' && result.observation.upload,
    ).toMatchObject({
      fileUploadID: expired.id,
      status: 'EXPIRED',
    });
  });

  it('fails closed for archived-only delete evidence and never issues delete', async () => {
    const resource = candidateResourceV4('cleanup-block');
    const deleteBlock = emptyMock<NotionBlocksClientV4['blocks']['delete']>();
    const test = harness({
      delete: deleteBlock,
      retrieve: implementationMock(async () =>
        heading(resource, 'Old note', { archived: true, inTrash: false }),
      ),
    });
    const lease: CleanupWorkerLease = {
      acquiredAt: clockV4.nowISOString(),
      cleanupID: 'cleanup-v4',
      expiresAt: clockV4.addMs(clockV4.nowISOString(), 60_000),
      leaseEpoch: 1,
      leaseID: 'cleanup-lease-v4',
      processSessionID: 'process-test',
    };
    const intent = createOperationIntent({
      createdAt: clockV4.nowISOString(),
      details: {
        cleanupID: lease.cleanupID,
        exactBlockID: resource.blockID,
        ownership: { ...resource },
        reason: 'REPLACED_ACTIVE',
      },
      generation: 1,
      kind: 'DELETE_BLOCK',
      leaseEpoch: lease.leaseEpoch,
      leaseID: lease.leaseID,
      operationID: 'operation:delete-v4',
      operationSequence: 1,
      owner: 'CLEANUP',
      processSessionID: lease.processSessionID,
      sourceVersion: sourceVersionV4,
      targetIdentityDigest: resource.targetIdentityDigest,
      transactionID: 'transaction:cleanup-v4',
    });

    const result = await test.adapter.execute(authorize(intent, lease));

    expect(result.type).toBe('UNCERTAIN');
    expect(deleteBlock.mock.calls).toHaveLength(0);
  });

  it('accepts deletion only with exact in_trash=true evidence', async () => {
    const resource = candidateResourceV4('cleanup-trashed');
    const test = harness({
      retrieve: implementationMock(async () =>
        heading(resource, 'Old note', { archived: true, inTrash: true }),
      ),
    });
    const lease: CleanupWorkerLease = {
      acquiredAt: clockV4.nowISOString(),
      cleanupID: 'cleanup-trashed',
      expiresAt: clockV4.addMs(clockV4.nowISOString(), 60_000),
      leaseEpoch: 1,
      leaseID: 'cleanup-lease-trashed',
      processSessionID: 'process-test',
    };
    const intent = createOperationIntent({
      createdAt: clockV4.nowISOString(),
      details: {
        cleanupID: lease.cleanupID,
        exactBlockID: resource.blockID,
        ownership: { ...resource },
        reason: 'REPLACED_ACTIVE',
      },
      generation: 1,
      kind: 'DELETE_BLOCK',
      leaseEpoch: lease.leaseEpoch,
      leaseID: lease.leaseID,
      operationID: 'operation:observe-delete-v4',
      operationSequence: 1,
      owner: 'CLEANUP',
      processSessionID: lease.processSessionID,
      sourceVersion: sourceVersionV4,
      targetIdentityDigest: resource.targetIdentityDigest,
      transactionID: 'transaction:cleanup-trashed',
    });

    const result = await test.adapter.observe(intent);

    expect(result.type).toBe('OBSERVED');
    expect(
      result.type === 'OBSERVED' ? result.observation.deletionProof : null,
    ).toStrictEqual({
      archived: true,
      exactBlockID: resource.blockID,
      inTrash: true,
    });
  });

  it('treats delete 404 as uncertain, never as deletion proof', async () => {
    const resource = candidateResourceV4('cleanup-404');
    const test = harness({
      retrieve: implementationMock(async () => {
        throw objectNotFound();
      }),
    });
    const lease: CleanupWorkerLease = {
      acquiredAt: clockV4.nowISOString(),
      cleanupID: 'cleanup-404',
      expiresAt: clockV4.addMs(clockV4.nowISOString(), 60_000),
      leaseEpoch: 1,
      leaseID: 'cleanup-lease-404',
      processSessionID: 'process-test',
    };
    const intent = createOperationIntent({
      createdAt: clockV4.nowISOString(),
      details: {
        cleanupID: lease.cleanupID,
        exactBlockID: resource.blockID,
        ownership: { ...resource },
        reason: 'REPLACED_ACTIVE',
      },
      generation: 1,
      kind: 'DELETE_BLOCK',
      leaseEpoch: lease.leaseEpoch,
      leaseID: lease.leaseID,
      operationID: 'operation:delete-404-v4',
      operationSequence: 1,
      owner: 'CLEANUP',
      processSessionID: lease.processSessionID,
      sourceVersion: sourceVersionV4,
      targetIdentityDigest: resource.targetIdentityDigest,
      transactionID: 'transaction:cleanup-404',
    });

    const result = await test.adapter.observe(intent);

    expect(result.type).toBe('UNCERTAIN');
    expect(
      result.type === 'UNCERTAIN' ? result.lastObservation : null,
    ).toBeNull();
  });
});
