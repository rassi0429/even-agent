import { expect, it } from 'vitest';
import { displaySchema } from '@even-agent/protocol';
import { createServer } from './app.js';

it('serves composed pages to installed WebView origins without opening write CORS', async () => {
  const app = await createServer();
  try {
    const origin = 'https://installed-plugin.example';
    await app.inject({
      method: 'PUT',
      url: '/api/display/live',
      payload: {
        publisherId: crypto.randomUUID(),
        display: {
          version: 1,
          updatedAt: 0,
          generatedAt: 0,
          pages: [
            { id: 'test', content: '! PC composed', offlineContent: 'OFFLINE' },
          ],
        },
      },
    });
    const response = await app.inject({
      url: '/api/display',
      headers: { origin },
    });
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['cache-control']).toBe('no-store');
    const display = displaySchema.parse(response.json());
    expect(display.pages[0]?.content).toContain('! PC composed');
    expect(display.pages[0]?.offlineContent).toContain('OFFLINE');
    const writes = await app.inject({
      method: 'OPTIONS',
      url: '/api/items',
      headers: { origin, 'access-control-request-method': 'POST' },
    });
    expect(writes.headers['access-control-allow-origin']).toBeUndefined();
  } finally {
    await app.close();
  }
});
