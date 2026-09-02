import { describe, expect, it, vi } from 'vite-plus/test';

import { createWindowMock } from '../../../../test/utils';
import { logger } from '../../utils';
import { NOTION_API_VERSION, getNotionClient } from '../notion-client';

function uploadResponse(status: 'pending' | 'uploaded') {
  return {
    archived: false,
    content_length: status === 'uploaded' ? 3 : null,
    content_type: 'image/png',
    created_by: { id: 'bot-test', type: 'bot' },
    created_time: '2026-08-30T00:00:00.000Z',
    expiry_time: status === 'uploaded' ? null : '2026-08-30T01:00:00.000Z',
    filename: 'synthetic.png',
    id: 'upload-test',
    last_edited_time: '2026-08-30T00:00:00.000Z',
    object: 'file_upload',
    status,
  };
}

function notionVersionHeader(options: RequestInit | undefined): string | null {
  return new Headers(options?.headers).get('notion-version');
}

describe('Notion client logging', () => {
  it('does not forward response bodies, tokens, or note text to logs', async () => {
    const window = createWindowMock();
    const privateResponse = {
      code: 'internal_server_error',
      message: 'Synthetic failure',
      note: 'private note body',
      object: 'error',
      status: 500,
      token: 'secret-token',
    };
    window.fetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(privateResponse), {
        headers: { 'content-type': 'application/json' },
        status: 500,
      }),
    );
    const notion = getNotionClient('secret-token', window);

    await expect(notion.users.me({})).rejects.toThrow('Synthetic failure');

    expect(logger.warn).toHaveBeenCalledWith('request fail');
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).not.toContain('private note body');
    expect(logged).not.toContain('secret-token');
    expect(logged).not.toContain('Synthetic failure');
  });

  it('pins the JSON transport to the audited Notion API version', async () => {
    const window = createWindowMock();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(uploadResponse('pending')), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );
    window.fetch = fetchMock;
    const notion = getNotionClient('synthetic-token', window);

    await notion.fileUploads.create({
      content_type: 'image/png',
      filename: 'synthetic.png',
      mode: 'single_part',
    });

    const call = fetchMock.mock.calls[0];
    expect(notionVersionHeader(call?.[1])).toBe(NOTION_API_VERSION);
    const body = call?.[1]?.body;
    if (typeof body !== 'string') throw new Error('Expected JSON request body');
    expect(JSON.parse(body)).toStrictEqual({
      content_type: 'image/png',
      filename: 'synthetic.png',
      mode: 'single_part',
    });
  });

  it('pins the multipart transport to the same audited API version', async () => {
    const window = createWindowMock();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(uploadResponse('uploaded')), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );
    window.fetch = fetchMock;
    const notion = getNotionClient('synthetic-token', window);

    await notion.fileUploads.send({
      file: {
        data: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
        filename: 'synthetic.png',
      },
      file_upload_id: 'upload-test',
    });

    const call = fetchMock.mock.calls[0];
    expect(notionVersionHeader(call?.[1])).toBe(NOTION_API_VERSION);
    expect(call?.[1]?.body).toBeInstanceOf(FormData);
  });
});
