import { expect, it } from 'vitest';
import Fastify from 'fastify';
import { createServer } from '../../server/src/app.js';
import { createDashboard } from './app.js';
import { HealthMonitor } from './health-monitor.js';

it('displays sustained failure in the same page and returns to quiet after confirmed recovery', async () => {
  let now = Date.now();
  let status = 200;
  const source = Fastify();
  source.get('/health', (_request, reply) =>
    reply.code(status).send('PRIVATE_BODY_CANARY'),
  );
  const sourceUrl = await source.listen({ host: '127.0.0.1', port: 0 });
  const monitor = new HealthMonitor(
    JSON.stringify([
      { id: 'test', name: '確認用', url: sourceUrl + '/health' },
    ]),
    () => now,
  );
  const gateway = await createServer({ apiToken: 'fixture' });
  const gatewayUrl = await gateway.listen({ host: '127.0.0.1', port: 0 });
  const dashboard = createDashboard({
    serverUrl: gatewayUrl,
    apiToken: 'fixture',
    healthMonitor: monitor,
    intervalMs: 25,
  });
  const check = async () => {
    now += 30_000;
    await monitor.refresh();
  };
  try {
    await monitor.refresh();
    await dashboard.ready();
    expect(monitor.panel().online).toBe('');
    status = 503;
    await check();
    await check();
    expect(monitor.status().targets[0]?.state).toBe('suspect');
    expect(monitor.panel().online).toBe('');
    await check();
    expect(monitor.status().targets[0]?.state).toBe('unavailable');
    await expect
      .poll(
        async () =>
          (await gateway.inject('/api/display')).json().pages[0].content,
      )
      .toContain('確認用 HTTP 503');
    const display = (await gateway.inject('/api/display')).json();
    expect(display.pages).toHaveLength(1);
    expect(
      display.pages[0].scene.elements.some(
        (e: { id: string }) => e.id === 'nebi-middle',
      ),
    ).toBe(true);
    const health = (await dashboard.inject('/health')).json();
    expect(health.monitoring.targets[0].state).toBe('unavailable');
    expect(JSON.stringify([display, health])).not.toMatch(
      /PRIVATE_BODY|127\.0\.0\.1/,
    );
    status = 200;
    await check();
    expect(monitor.panel().online).toContain('復旧を確認中');
    await check();
    expect(monitor.panel().online).toBe('');
    await expect
      .poll(async () =>
        (await gateway.inject('/api/display'))
          .json()
          .pages[0].scene.elements.some(
            (e: { id: string }) => e.id === 'nebi-middle',
          ),
      )
      .toBe(false);
    now += 90_000;
    expect(monitor.panel().online).toContain('監視の更新停止');
    await check();
    expect(monitor.status().targets[0]?.state).toBe('ok');
  } finally {
    await dashboard.close();
    await gateway.close();
    await source.close();
  }
});

it('does not follow redirects, coalesces checks, expires evidence and stops polling', async () => {
  let now = 0;
  let calls = 0;
  let redirects = 0;
  const source = Fastify();
  source.get('/health', (_request, reply) => {
    calls++;
    return reply.redirect('/other');
  });
  source.get('/other', () => {
    redirects++;
    return 'PRIVATE';
  });
  const url = await source.listen({ host: '127.0.0.1', port: 0 });
  const monitor = new HealthMonitor(
    JSON.stringify([{ id: 'one', name: 'One', url: url + '/health' }]),
    () => now,
  );
  try {
    await Promise.all([monitor.refresh(), monitor.refresh()]);
    expect(calls).toBe(1);
    now += 30_000;
    await monitor.refresh();
    now += 90_000;
    await monitor.refresh(); // An observation gap resets the consecutive count.
    expect(monitor.status().targets[0]?.failures).toBe(1);
    now += 30_000;
    await monitor.refresh();
    now += 30_000;
    await monitor.refresh();
    expect(
      monitor.panel({
        online: 'Nebi\n必要な用事\n別の用事',
        offline: 'offline',
      }).online,
    ).toBe('Nebi 要確認 / ほかあり\nOne HTTP 302\n必要な用事');
    expect(redirects).toBe(0);
    await source.close();
    now += 30_000;
    await monitor.refresh();
    expect(monitor.panel().online).toContain('接続できません');
    await monitor.stop();
    const checks = calls;
    now += 30_000;
    await monitor.refresh();
    expect(calls).toBe(checks);
    expect(monitor.status().targets[0]?.state).toBe('stale');
  } finally {
    await monitor.stop();
    await source.close();
  }
});

it('keeps disabled configuration quiet and reports invalid configuration without exposing it', () => {
  const base = { online: 'Nebi\n表示依頼', offline: 'offline' };
  expect(new HealthMonitor().enabled).toBe(false);
  expect(new HealthMonitor().panel(base)).toEqual(base);
  for (const value of [
    'not json',
    '{}',
    JSON.stringify([
      { id: 'one', name: 'One', url: 'http://user:secret@example.test/health' },
    ]),
    JSON.stringify([
      { id: 'one', name: 'One', url: 'http://example.test/health?key=secret' },
    ]),
    JSON.stringify([{ id: 'one', name: 'One', url: 'file:///health' }]),
  ]) {
    const monitor = new HealthMonitor(value);
    expect(monitor.status().configurationError).toBe(true);
    expect(monitor.panel().online).toContain('監視設定');
    expect(JSON.stringify(monitor.status())).not.toContain('secret');
  }
});
