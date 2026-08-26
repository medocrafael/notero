import { describe, expect, it, vi } from 'vite-plus/test';

import { createWindowMock } from '../../../../test/utils';
import { logger } from '../../utils';
import { getNotionClient } from '../notion-client';

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
});
