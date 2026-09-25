import { expect, it } from 'vitest';
import { createServer } from './app.js';
const display = {
  version: 1,
  updatedAt: 1,
  generatedAt: 1,
  pages: [{ id: 'test', content: 'Running', offlineContent: 'App offline' }],
};
it('validates/authenticates publishers, enforces ownership and expires into the supplied offline screen', async () => {
  let now = 1000;
  const app = await createServer({ apiToken: 'key', now: () => now });
  const owner = crypto.randomUUID(),
    other = crypto.randomUUID();
  const headers = { authorization: 'Bearer key' };
  const publish = (publisherId: string, value: unknown = display) =>
    app.inject({
      method: 'PUT',
      url: '/api/display/live',
      headers,
      payload: { publisherId, ttlSeconds: 5, display: value },
    });
  try {
    expect((await app.inject('/health')).json().screenMode).toBe('idle');
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/display/live',
          payload: { publisherId: owner, display },
        })
      ).statusCode,
    ).toBe(401);
    expect((await publish(owner, { ...display, pages: [] })).statusCode).toBe(
      400,
    );
    expect((await publish(owner)).statusCode).toBe(200);
    expect((await publish(other)).statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/display/live',
          headers,
          payload: { publisherId: other },
        })
      ).statusCode,
    ).toBe(409);
    expect((await app.inject('/api/display')).json().pages[0].content).toBe(
      'Running',
    );
    now = 6001;
    expect((await app.inject('/health')).json().screenMode).toBe('offline');
    expect((await app.inject('/api/display')).json().pages[0].content).toBe(
      'App offline',
    );
    expect((await publish(other)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/display/live',
          headers,
          payload: { publisherId: other },
        })
      ).statusCode,
    ).toBe(204);
    expect((await app.inject('/health')).json().publisher.online).toBe(false);
  } finally {
    await app.close();
  }
});
