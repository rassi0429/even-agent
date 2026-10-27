import { expect, it, vi } from 'vitest';
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

it.each([false, true])(
  'recovers from a silent socket without a close event (initial snapshot received: %s)',
  async (received) => {
    vi.useFakeTimers();
    class SilentSocket {
      static OPEN = 1;
      static instances: SilentSocket[] = [];
      readyState = 1;
      bufferedAmount = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn(); // Deliberately never emits close (black-holed connection).
      constructor() {
        SilentSocket.instances.push(this);
      }
    }
    const snapshot: DisplayState = {
      version: 1,
      updatedAt: 1,
      generatedAt: 1,
      pages: [
        {
          id: 'test',
          content: 'current',
          offlineContent: '配信に接続できません',
        },
      ],
    };
    vi.stubGlobal('WebSocket', SilentSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(snapshot))),
    );
    let online = false;
    let latest = snapshot;
    const disconnected = vi.fn();
    const client = new DisplaySync(
      'http://localhost',
      (state) => {
        latest = state;
      },
      (value) => {
        online = value;
      },
    );
    client.onSensorDisconnect = disconnected;
    const message = (content: string) => ({
      data: JSON.stringify({
        type: 'display',
        data: {
          ...snapshot,
          pages: [{ ...snapshot.pages[0], content }],
        },
      }),
    });
    try {
      client.start();
      await vi.advanceTimersByTimeAsync(0);
      const first = SilentSocket.instances[0]!;
      const lateMessage = first.onmessage!;
      if (received) first.onmessage!(message('before'));
      expect(online).toBe(received);
      disconnected.mockClear();
      await vi.advanceTimersByTimeAsync(received ? 45000 : 10000);
      expect(online).toBe(false);
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(disconnected).toHaveBeenCalledTimes(1);
      expect(first.onmessage).toBeNull();
      expect(first.onclose).toBeNull();
      lateMessage(message('late obsolete frame'));
      expect(online).toBe(false);
      expect(latest.pages[0]?.content).not.toBe('late obsolete frame');
      await vi.advanceTimersByTimeAsync(1300);
      const second = SilentSocket.instances[1]!;
      expect(second).toBeDefined();
      expect(online).toBe(false); // REST and socket creation do not imply a live stream.
      second.onmessage!(message('recovered'));
      expect(online).toBe(true);
      expect(latest.pages[0]?.content).toBe('recovered');
      client.stop();
      await vi.advanceTimersByTimeAsync(60000);
      expect(SilentSocket.instances).toHaveLength(2);
    } finally {
      client.stop();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  },
);
