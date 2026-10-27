import { expect, it } from 'vitest';
import Fastify from 'fastify';
import { liveDisplaySchema } from '@even-agent/protocol';
import { createServer } from '../../server/src/app.js';
import { createDashboard } from './app.js';
import { NebiMonitor } from './nebi.js';

it('adds a bounded read-only Nebi page through the existing publisher and preserves custom screens', async () => {
  let now = Date.now();
  let responseStatus = 200;
  let text = 'TODO 確認用の用事';
  let extraLines: string[] = [];
  const key = 'read-fixture-012345678901234567890123456789';
  const source = Fastify();
  source.get('/v1/views/g2', (request, reply) => {
    expect(request.headers.authorization).toBe(`Bearer ${key}`);
    if (responseStatus !== 200)
      return reply
        .code(responseStatus)
        .send({ error: 'PRIVATE_FAILURE_CANARY' });
    return {
      version: 1,
      viewId: 'g2',
      revision: 'a'.repeat(64),
      generatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      timeZone: 'Asia/Tokyo',
      items: text
        ? [text, ...extraLines].map((line, index) => ({
            id: `task:${index + 1}`,
            text: line,
            revision: 'b'.repeat(64),
          }))
        : [],
      hidden: 'PRIVATE_SOURCE_CANARY',
    };
  });
  const sourceUrl = await source.listen({ host: '127.0.0.1', port: 0 });
  const gateway = await createServer({ apiToken: 'gateway-key' });
  const gatewayUrl = await gateway.listen({ host: '127.0.0.1', port: 0 });
  const nebi = new NebiMonitor(sourceUrl, key, () => now);
  const dashboard = createDashboard({
    serverUrl: gatewayUrl,
    apiToken: 'gateway-key',
    nebi,
    intervalMs: 25,
  });
  try {
    await dashboard.ready();
    await expect
      .poll(async () =>
        JSON.stringify((await gateway.inject('/api/display')).json()),
      )
      .toContain(text);
    let display = (await gateway.inject('/api/display')).json();
    expect(display.pages).toHaveLength(1);
    expect(
      display.pages[0].scene.elements.some(
        (element: { id: string }) => element.id === 'nebi-middle',
      ),
    ).toBe(true);
    expect(display.pages[0].id).toBe('page-0');
    expect(JSON.stringify(display)).not.toMatch(/PRIVATE_|read-fixture/);
    expect(
      liveDisplaySchema.safeParse({
        publisherId: crypto.randomUUID(),
        ttlSeconds: 20,
        display,
      }).success,
    ).toBe(true);
    const publisher = (await gateway.inject('/api/display/live')).json()
      .publisherId;
    expect(nebi.panel().online).toBe(text);
    extraLines = ['確認用の2行目', '確認用の3行目'];
    now += 5001;
    await nebi.refresh();
    await expect
      .poll(async () => {
        const current = (await gateway.inject('/api/display')).json();
        return current.pages[0].scene.elements.find(
          (element: { id: string }) => element.id === 'nebi-middle',
        )?.text;
      })
      .toBe([text, ...extraLines].join('\n'));
    extraLines = [];
    text = '';
    now += 5001;
    await nebi.refresh();
    expect(nebi.panel().online).toBe('');
    await expect
      .poll(async () =>
        JSON.stringify((await gateway.inject('/api/display')).json()),
      )
      .not.toContain('確認用の用事');
    expect((await gateway.inject('/api/display/live')).json().publisherId).toBe(
      publisher,
    );
    const custom = await gateway.inject({
      method: 'PUT',
      url: '/api/screen',
      headers: { authorization: 'Bearer gateway-key' },
      payload: {
        pages: [
          {
            id: 'manual',
            content: 'Manual screen',
            offlineContent: 'Offline manual',
            scene: {
              elements: [
                {
                  type: 'text',
                  id: 'manual',
                  x: 0,
                  y: 0,
                  width: 576,
                  height: 100,
                  text: 'Manual screen',
                },
              ],
            },
          },
        ],
      },
    });
    expect(custom.statusCode).toBe(200);
    text = 'TODO 次の用事';
    now += 5001;
    await nebi.refresh();
    await expect
      .poll(async () =>
        JSON.stringify((await dashboard.inject('/api/display')).json()),
      )
      .toContain(text);
    expect((await gateway.inject('/api/display')).json().pages[0].content).toBe(
      'Manual screen',
    );
    responseStatus = 401;
    now += 5001;
    await nebi.refresh();
    expect(nebi.status().state).toBe('unauthorized');
    expect(nebi.page().content).not.toContain('次の用事');
    expect(nebi.page().content).toContain('表示キー');
    expect(JSON.stringify(nebi.page())).not.toContain('PRIVATE_FAILURE');
    responseStatus = 503;
    now += 5001;
    await nebi.refresh();
    expect(nebi.panel().online).toContain('Nebiに接続できません');
    responseStatus = 200;
    now += 5001;
    await nebi.refresh();
    now += 60_001;
    expect(nebi.status().state).toBe('expired');
    expect(nebi.page().content).not.toContain('次の用事');
    expect(nebi.page().offlineContent).toContain('OFFLINE');
    expect((await dashboard.inject('/health')).statusCode).toBe(200);
    display = (await gateway.inject('/api/display')).json();
    expect(display.pages[0].id).toBe('manual');
  } finally {
    await dashboard.close();
    await gateway.close();
    await source.close();
  }
});

it('refuses remote origins, URL credentials and weak tokens before sending credentials', () => {
  for (const url of [
    'http://example.com',
    'http://127.0.0.1@evil.invalid',
    'http://user:pass@127.0.0.1',
    'http://127.0.0.1/path',
  ]) {
    expect(() => new NebiMonitor(url, 'a'.repeat(32))).toThrow();
  }
  expect(() => new NebiMonitor('http://127.0.0.1:8788', '')).toThrow();
});
