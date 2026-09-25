import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import {
  sceneSchema,
  screenDocumentSchema,
  decodeGray4,
  paintGray4,
} from '@even-agent/protocol';
import { createServer } from './app.js';
const image = {
  type: 'image',
  id: 'i',
  x: 0,
  y: 0,
  width: 20,
  height: 20,
  frames: ['f'.repeat(400)],
};
const doc = {
  pages: [
    {
      id: 'demo',
      content: 'Demo fallback',
      offlineContent: 'OFFLINE Demo',
      scene: { elements: [image] },
    },
  ],
};
const servers: Awaited<ReturnType<typeof createServer>>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup(options: Parameters<typeof createServer>[0] = {}) {
  const app = await createServer(options);
  servers.push(app);
  return app;
}
it('rejects invalid geometry, oversized UTF-8 text, frames, duplicate IDs and too many containers', () => {
  for (const elements of [
    [{ ...image, x: 570 }],
    [{ ...image, y: 280 }],
    [{ ...image, width: 21 }],
    [{ ...image, frames: ['f'.repeat(398)] }],
    [{ ...image, frames: ['https://example.com/image'] }],
    [{ ...image, frameMs: 20 }],
    [image, image],
    Array.from({ length: 5 }, (_, i) => ({ ...image, id: String(i) })),
    [
      {
        type: 'text',
        id: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 30,
        text: '字'.repeat(334),
      },
    ],
  ])
    expect(sceneSchema.safeParse({ elements }).success).toBe(false);
  expect(
    screenDocumentSchema.safeParse({ pages: [doc.pages[0], doc.pages[0]] })
      .success,
  ).toBe(false);
  expect([...decodeGray4(paintGray4(2, 1, (x) => (x ? 15 : 0)))]).toEqual([15]);
});
it('authenticates screen writes, atomically rejects invalid input, preserves items, and persists across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'even-screen-'));
  dirs.push(dir);
  const options = {
    databasePath: join(dir, 'screen.db'),
    apiToken: 'test-key',
    now: () => 1000,
  };
  const app = await setup(options);
  const headers = { authorization: 'Bearer test-key' };
  expect(
    (await app.inject({ method: 'PUT', url: '/api/screen', payload: doc }))
      .statusCode,
  ).toBe(401);
  const before = (await app.inject('/api/state')).json();
  const put = await app.inject({
    method: 'PUT',
    url: '/api/screen',
    payload: doc,
    headers,
  });
  expect(put.statusCode).toBe(200);
  const revision = put.json().updatedAt;
  expect(
    (await app.inject('/api/display')).json().pages[0].scene.elements[0].frames,
  ).toEqual(image.frames);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/screen',
        payload: { pages: [] },
        headers,
      })
    ).statusCode,
  ).toBe(400);
  expect((await app.inject('/api/screen')).json().updatedAt).toBe(revision);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/screen',
        payload: doc,
        headers,
      })
    ).json().updatedAt,
  ).toBeGreaterThan(revision);
  expect((await app.inject('/api/state')).json()).toEqual(before);
  await app.close();
  servers.splice(servers.indexOf(app), 1);
  const restored = await setup(options);
  expect((await restored.inject('/api/screen')).json().mode).toBe('custom');
  expect(
    (await restored.inject({ method: 'DELETE', url: '/api/screen' }))
      .statusCode,
  ).toBe(401);
  expect(
    (await restored.inject({ method: 'DELETE', url: '/api/screen', headers }))
      .statusCode,
  ).toBe(204);
  expect((await restored.inject('/api/screen')).json().document).toBeNull();
  expect((await restored.inject('/health')).json().screenMode).toBe('idle');
});
it('broadcasts custom writes and reset without overriding a live publisher', async () => {
  const app = await setup();
  const live = {
    version: 1,
    updatedAt: 0,
    generatedAt: 1000,
    pages: [
      {
        id: 'live',
        content: 'Published screen',
        offlineContent: 'Publisher offline',
      },
    ],
  };
  const result = await app.inject({
    method: 'PUT',
    url: '/api/display/live',
    payload: { publisherId: crypto.randomUUID(), display: live },
  });
  expect(result.statusCode).toBe(200);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(address.replace('http:', 'ws:') + '/ws/display');
  try {
    await once(socket, 'message');
    const next = once(socket, 'message');
    await app.inject({ method: 'PUT', url: '/api/screen', payload: doc });
    expect(
      JSON.parse(String((await next)[0])).data.pages[0].scene.elements[0].id,
    ).toBe('i');
    const reset = once(socket, 'message');
    await app.inject({ method: 'DELETE', url: '/api/screen' });
    expect(JSON.parse(String((await reset)[0])).data.pages[0].content).toBe(
      'Published screen',
    );
    expect((await app.inject('/health')).json().screenMode).toBe('live');
  } finally {
    socket.close();
  }
});
