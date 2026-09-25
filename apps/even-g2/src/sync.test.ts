import { expect, it } from 'vitest';
import type { DisplayState } from '@even-agent/protocol';
import { createServer } from '../../server/src/app.js';
import { DisplaySync } from './sync.js';

it('restores authoritative state after disconnect, accepts reset revisions, and stops reconnecting', async () => {
  const server = await createServer();
  const address = await server.listen({ port: 0, host: '127.0.0.1' });
  let latest: DisplayState | undefined;
  let online = false;
  let deliveries = 0;
  const client = new DisplaySync(
    address,
    (state) => {
      latest = state;
      deliveries++;
    },
    (value) => {
      online = value;
    },
  );
  const publisherId = crypto.randomUUID();
  const publish = (content: string) =>
    server.inject({
      method: 'PUT',
      url: '/api/display/live',
      payload: {
        publisherId,
        display: {
          version: 1,
          updatedAt: Date.now(),
          generatedAt: Date.now(),
          pages: [{ id: 'test', content, offlineContent: 'OFFLINE' }],
        },
      },
    });
  try {
    client.start();
    await expect.poll(() => online).toBe(true);
    await publish('before');
    await expect.poll(() => latest?.pages[0]?.content).toContain('before');
    for (const socket of server.websocketServer.clients) socket.terminate();
    await expect.poll(() => online).toBe(false);
    await publish('after');
    await expect.poll(() => online, { timeout: 4000 }).toBe(true);
    expect(latest?.pages[0]?.content).toContain('after');
    expect(latest?.pages[0]?.content).not.toContain('before');
    // A restored/new database may have a lower revision: a new snapshot wins.
    for (const socket of server.websocketServer.clients)
      socket.send(
        JSON.stringify({
          type: 'display',
          data: {
            version: 1,
            pages: [
              { id: 'reset', content: 'reset', offlineContent: 'OFFLINE' },
            ],
            updatedAt: 0,
            generatedAt: 0,
          },
        }),
      );
    await expect.poll(() => latest?.updatedAt).toBe(0);
    client.stop();
    const stoppedCount = deliveries;
    await publish('after-stop');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deliveries).toBe(stoppedCount);
  } finally {
    client.stop();
    await server.close();
  }
});
