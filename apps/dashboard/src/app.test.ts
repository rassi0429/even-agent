import { expect, it } from 'vitest';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { displaySchema } from '@even-agent/protocol';
import { createServer } from '../../server/src/app.js';
import { createDashboard } from './app.js';

it('publishes through HTTP, composes device telemetry/items and survives gateway restart without sharing runtime state', async () => {
  let gateway = await createServer({ apiToken: 'key' });
  const url = await gateway.listen({ host: '127.0.0.1', port: 0 });
  const task = {
    id: 'task',
    agent: 'Claude' as const,
    surface: 'Code',
    project: 'project',
    status: 'running' as const,
    updatedAt: Date.now(),
  };
  const monitor = {
    read: async () => ({
      tasks: [task],
      sources: { codex: 'ok', claude: 'ok' },
      observedAt: Date.now(),
    }),
  };
  const dashboard = createDashboard({
    serverUrl: url,
    apiToken: 'key',
    agentMonitor: monitor,
    intervalMs: 25,
    agentPollMs: 25,
  });
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws/display');
  await once(socket, 'open');
  await dashboard.ready();
  try {
    await expect
      .poll(async () => (await gateway.inject('/health')).json().screenMode)
      .toBe('live');
    socket.send(
      JSON.stringify({
        type: 'deviceStatus',
        data: {
          model: 'g2',
          connected: true,
          batteryLevel: 75,
          isCharging: false,
        },
      }),
    );
    await expect
      .poll(
        async () =>
          (await gateway.inject('/api/display')).json().pages[0].content,
      )
      .toContain('G2 75%');
    expect(
      (await dashboard.inject('/api/agents')).json().tasks[0].project,
    ).toBe('project');
    expect((await gateway.inject('/api/agents')).statusCode).toBe(404);
    expect(
      displaySchema.safeParse((await gateway.inject('/api/display')).json())
        .success,
    ).toBe(true);
    await gateway.inject({
      method: 'POST',
      url: '/api/items',
      headers: { authorization: 'Bearer key' },
      payload: {
        title: 'Notification',
        section: 'now',
        priority: 'high',
        source: 'test',
      },
    });
    await expect
      .poll(
        async () =>
          (await gateway.inject('/api/display')).json().pages[0].content,
      )
      .toContain('Notification');
    const custom = {
      pages: [
        {
          id: 'custom',
          content: 'Custom',
          offlineContent: 'Offline',
          scene: {
            elements: [
              {
                type: 'text',
                id: 't',
                x: 0,
                y: 0,
                width: 576,
                height: 100,
                text: 'Custom',
              },
            ],
          },
        },
      ],
    };
    await gateway.inject({
      method: 'PUT',
      url: '/api/screen',
      headers: { authorization: 'Bearer key' },
      payload: custom,
    });
    await new Promise((r) => setTimeout(r, 80));
    expect((await gateway.inject('/api/display')).json().pages[0].content).toBe(
      'Custom',
    );
    await gateway.inject({
      method: 'DELETE',
      url: '/api/screen',
      headers: { authorization: 'Bearer key' },
    });
    expect(
      (await gateway.inject('/api/display')).json().pages[0].content,
    ).toContain('Claude 実行 project');
    await gateway.close();
    const port = Number(new URL(url).port);
    gateway = await createServer({ apiToken: 'key' });
    await gateway.listen({ host: '127.0.0.1', port });
    await expect
      .poll(async () => (await gateway.inject('/health')).json().screenMode, {
        timeout: 8000,
      })
      .toBe('live');
    expect(
      (await gateway.inject('/api/display')).json().pages[0].content,
    ).toContain('Claude 実行 project');
    expect((await dashboard.inject('/health')).statusCode).toBe(200);
    await dashboard.close();
    expect((await gateway.inject('/health')).json().screenMode).toBe('offline');
    expect(
      (await gateway.inject('/api/display')).json().pages[0].content,
    ).toContain('OFFLINE');
    expect((await gateway.inject('/api/device/streams')).statusCode).toBe(200);
  } finally {
    socket.terminate();
    await dashboard.close();
    await gateway.close();
  }
});
