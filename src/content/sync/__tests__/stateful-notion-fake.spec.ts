import type {
  BlockObjectRequest,
  FileUploadObjectResponse,
} from '@notionhq/client/build/src/api-endpoints';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { NotionImageUploadService } from '../notion-image-upload-service';

import { StatefulNotionServer } from './stateful-notion-fake';

function imageBlock(fileUploadID: string): BlockObjectRequest {
  return {
    image: {
      file_upload: { id: fileUploadID },
      type: 'file_upload',
    },
  };
}

function uploadResponse(
  id: string,
  status: FileUploadObjectResponse['status'],
): FileUploadObjectResponse {
  return {
    archived: false,
    content_length: 3,
    content_type: 'image/png',
    created_by: { id: 'bot-a', type: 'bot' },
    created_time: new Date().toISOString(),
    expiry_time:
      status === 'expired'
        ? new Date(Date.now() - 1).toISOString()
        : new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    filename: 'synthetic.png',
    id,
    last_edited_time: new Date().toISOString(),
    object: 'file_upload',
    status,
  };
}

describe('StatefulNotionServer File Upload lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves nullable content_length through create, list, and retrieve', async () => {
    const server = new StatefulNotionServer();
    server.setNextUploadContentLength(null);
    const client = server.client();

    const created = await client.fileUploads.create({
      content_type: 'image/png',
      filename: 'synthetic.png',
      mode: 'single_part',
    });
    const listed = await client.fileUploads.list({});
    const retrieved = await client.fileUploads.retrieve({
      file_upload_id: created.id,
    });

    expect(created.content_length).toBeNull();
    expect(listed.results[0]?.content_length).toBeNull();
    expect(retrieved.content_length).toBeNull();
  });

  it('does not claim a nullable-content-length upload during strict create reconciliation', async () => {
    const server = new StatefulNotionServer();
    const client = server.client();
    const created = await client.fileUploads.create({
      content_type: 'image/png',
      filename: 'synthetic.png',
      mode: 'single_part',
    });
    const service = new NotionImageUploadService(client, {}, server.botID);

    await expect(
      service.reconcileCreate({
        connectionID: server.botID,
        contentLength: 3,
        contentType: 'image/png',
        filename: 'synthetic.png',
        isolationDeadline: new Date(Date.now() + 60_000),
        requestStartedAt: new Date(Date.parse(created.created_time) - 1),
      }),
    ).resolves.toBeUndefined();
  });

  it('allows send only for a pending upload', async () => {
    const server = new StatefulNotionServer();
    const client = server.client();
    const created = await client.fileUploads.create({ mode: 'single_part' });
    const request = {
      file: { data: new Blob([new Uint8Array([1, 2, 3])]), filename: 'a.png' },
      file_upload_id: created.id,
    };

    await client.fileUploads.send(request);
    await expect(client.fileUploads.send(request)).rejects.toBeInstanceOf(
      Error,
    );
  });

  it.each(['pending', 'uploaded-unattached'] as const)(
    'expires a $status upload when the fake clock passes its deadline',
    async (lifecycle) => {
      const server = new StatefulNotionServer();
      const client = server.client();
      const created = await client.fileUploads.create({ mode: 'single_part' });
      if (lifecycle === 'uploaded-unattached') {
        await client.fileUploads.send({
          file: {
            data: new Blob([new Uint8Array([1, 2, 3])]),
            filename: 'a.png',
          },
          file_upload_id: created.id,
        });
      }

      server.advanceTime(61 * 60 * 1000);

      await expect(
        client.fileUploads.retrieve({ file_upload_id: created.id }),
      ).resolves.toMatchObject({ status: 'expired' });
    },
  );

  it.each([
    { id: 'missing-upload', status: undefined },
    { id: 'pending-upload', status: 'pending' },
    { id: 'failed-upload', status: 'failed' },
    { id: 'expired-upload', status: 'expired' },
  ] as const)(
    'rejects an image block that references a $status upload',
    async ({ id, status }) => {
      const server = new StatefulNotionServer();
      if (status) server.uploads.set(id, uploadResponse(id, status));
      const client = server.client();

      await expect(
        client.blocks.children.append({
          block_id: 'candidate-a',
          children: [imageBlock(id)],
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(server.visibleChildren('candidate-a')).toHaveLength(0);
    },
  );

  it.each([
    { creator: 'bot-a', label: 'another workspace', workspace: 'workspace-b' },
    { creator: 'bot-b', label: 'another connection', workspace: 'workspace-a' },
  ])(
    'rejects an uploaded image owned by $label',
    async ({ creator, workspace }) => {
      const server = new StatefulNotionServer();
      const upload = {
        ...uploadResponse('foreign-upload', 'uploaded'),
        created_by: { id: creator, type: 'bot' as const },
      };
      server.seedUpload(upload, workspace);
      const client = server.client();

      await expect(
        client.blocks.children.append({
          block_id: 'candidate-a',
          children: [imageBlock(upload.id)],
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(server.visibleChildren('candidate-a')).toHaveLength(0);
    },
  );

  it('turns an uploaded file into an attached persistent upload and keeps it persistent after candidate deletion and time advance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
    const server = new StatefulNotionServer();
    const client = server.client();
    server.seedHeading('candidate-a', 'page-a', 'page_id', {
      heading_1: {
        is_toggleable: true,
        rich_text: [{ text: { content: 'Candidate' }, type: 'text' }],
      },
    });
    const created = await client.fileUploads.create({
      content_type: 'image/png',
      filename: 'synthetic.png',
      mode: 'single_part',
    });
    await client.fileUploads.send({
      file: {
        data: new Blob([new Uint8Array([1, 2, 3])]),
        filename: 'synthetic.png',
      },
      file_upload_id: created.id,
    });
    await client.blocks.children.append({
      block_id: 'candidate-a',
      children: [imageBlock(created.id)],
    });

    expect(
      await client.fileUploads.retrieve({ file_upload_id: created.id }),
    ).toMatchObject({ expiry_time: null, status: 'uploaded' });

    await client.blocks.delete({ block_id: 'candidate-a' });
    server.advanceTime(2 * 60 * 60 * 1000);
    expect(
      await client.fileUploads.retrieve({ file_upload_id: created.id }),
    ).toMatchObject({ expiry_time: null, status: 'uploaded' });
  });
});
