import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { StateMessage } from '@even-agent/protocol';
import { createServer } from './app.js';

const servers: Awaited<ReturnType<typeof createServer>>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
async function setup(options: Parameters<typeof createServer>[0] = {}) {
  const app = await createServer(options);
  servers.push(app);
  return app;
}
const input = {
  title: 'Hello G2',
  description: '日本語テスト',
  priority: 'normal',
  section: 'now',
  source: 'test',
};
function inbox(socket: WebSocket) {
  const queue: StateMessage[] = [];
  let waiter: ((message: StateMessage) => void) | undefined;
  socket.on('message', (data) => {
    const message = JSON.parse(String(data)) as StateMessage;
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve(message);
    } else queue.push(message);
  });
  return () =>
    new Promise<StateMessage>((resolve, reject) => {
      const message = queue.shift();
      if (message) {
        resolve(message);
        return;
      }
      const timer = setTimeout(
        () => reject(new Error('No state received')),
        2000,
      );
      waiter = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
    });
}
describe('Agent Server', () => {
  it('validates input, supports CRUD, null clearing, and stable revision', async () => {
    const app = await setup();
    for (const payload of [
      {},
      { ...input, section: 'bad' },
      { ...input, id: 'injected' },
      { ...input, title: ' ' },
    ]) {
      expect(
        (await app.inject({ method: 'POST', url: '/api/items', payload }))
          .statusCode,
      ).toBe(400);
    }
    const created = await app.inject({
      method: 'POST',
      url: '/api/items',
      payload: input,
    });
    expect(created.statusCode).toBe(201);
    const item = created.json();
    expect(item.id).toBeTruthy();
    const first = (await app.inject('/api/state')).json();
    expect(first.now[0].description).toBe('日本語テスト');
    expect((await app.inject('/api/state')).json().updatedAt).toBe(
      first.updatedAt,
    );
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/items/${item.id}`,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/items/${item.id}`,
      payload: { section: 'waiting', description: null },
    });
    expect(patched.json().description).toBeUndefined();
    const next = (await app.inject('/api/state')).json();
    expect(next.now).toHaveLength(0);
    expect(next.waiting).toHaveLength(1);
    expect(next.updatedAt).toBeGreaterThan(first.updatedAt);
    expect((await app.inject('/api/items')).json()).toHaveLength(1);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/items/${item.id}` }))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/items/${item.id}` }))
        .statusCode,
    ).toBe(404);
  });
  it('broadcasts full snapshots to multiple clients, including reconnect, update, and delete', async () => {
    const app = await setup();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const wsUrl = address.replace('http:', 'ws:') + '/ws';
    const a = new WebSocket(wsUrl);
    const b = new WebSocket(wsUrl);
    const nextA = inbox(a),
      nextB = inbox(b);
    expect((await nextA()).data.now).toEqual([]);
    await nextB();
    const result = await app.inject({
      method: 'POST',
      url: '/api/items',
      payload: input,
    });
    const item = result.json();
    expect((await nextA()).data.now[0]?.id).toBe(item.id);
    expect((await nextB()).data.now[0]?.id).toBe(item.id);
    a.close();
    await app.inject({
      method: 'PATCH',
      url: `/api/items/${item.id}`,
      payload: { section: 'soon' },
    });
    expect((await nextB()).data.soon[0]?.id).toBe(item.id);
    const c = new WebSocket(wsUrl);
    expect((await inbox(c)()).data.soon[0]?.id).toBe(item.id);
    await app.inject({ method: 'DELETE', url: `/api/items/${item.id}` });
    expect((await nextB()).data.soon).toEqual([]);
    b.close();
    c.close();
  });
  it('persists across restart and expires without any HTTP request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'even-agent-test-'));
    dirs.push(dir);
    const databasePath = join(dir, 'store.db');
    let now = 1000;
    const first = await setup({ databasePath, now: () => now });
    await first.inject({
      method: 'POST',
      url: '/api/items',
      payload: { ...input, expiresAt: 2000 },
    });
    const revision = (await first.inject('/api/state')).json().updatedAt;
    await first.close();
    servers.splice(servers.indexOf(first), 1);
    const second = await setup({
      databasePath,
      now: () => now,
      expiryIntervalMs: 20,
    });
    const address = await second.listen({ port: 0, host: '127.0.0.1' });
    const socket = new WebSocket(address.replace('http:', 'ws:') + '/ws');
    const next = inbox(socket);
    const restored = await next();
    expect(restored.data.now).toHaveLength(1);
    expect(restored.data.updatedAt).toBe(revision);
    now = 2001;
    const expired = await next();
    expect(expired.data.now).toEqual([]);
    expect(expired.data.updatedAt).toBeGreaterThan(revision);
    socket.close();
  });
  it('sorts by priority and restricts mutations with the configured token', async () => {
    const app = await setup({
      apiToken: 'test-secret',
      corsOrigins: ['https://plugin.example'],
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/items', payload: input }))
        .statusCode,
    ).toBe(401);
    for (const priority of ['low', 'high', 'normal'])
      await app.inject({
        method: 'POST',
        url: '/api/items',
        headers: { authorization: 'Bearer test-secret' },
        payload: { ...input, priority },
      });
    expect(
      (await app.inject('/api/state'))
        .json()
        .now.map((item: { priority: string }) => item.priority),
    ).toEqual(['high', 'normal', 'low']);
    const cors = await app.inject({
      method: 'OPTIONS',
      url: '/api/items',
      headers: {
        origin: 'https://plugin.example',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'Content-Type, Authorization',
      },
    });
    expect(cors.statusCode).toBe(204);
    expect(cors.headers['access-control-allow-origin']).toBe(
      'https://plugin.example',
    );
  });
});
