import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sceneSchema } from '@even-agent/protocol';
import { getTextWidth } from '@evenrealities/pretext';
import {
  claudeWindows,
  codexWindows,
  UsageMonitor,
  UsageReadError,
  type UsageSnapshot,
} from './usage.js';
import { readClaudeUsage } from './usage-readers.js';
import { windowRemaining } from './header-usage.js';
import { agentScene } from './agent-scene.js';
import { agentFlowPages } from './agent-flow.js';

it('normalizes only the core quota bucket and never treats missing windows as unused quota', () => {
  expect(
    codexWindows({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: 2000 },
      },
    }),
  ).toEqual([{ minutes: 10080, usedPercent: 45, resetsAt: 2000000 }]);
  expect(
    codexWindows({
      rateLimits: {
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 2000 },
      },
      rateLimitsByLimitId: { other: {} },
    }),
  ).toEqual([]);
  expect(
    claudeWindows({
      five_hour: {
        utilization: null,
        resets_at: new Date(2000000).toISOString(),
      },
      seven_day: { utilization: 3, resets_at: new Date(2000000).toISOString() },
    }),
  ).toEqual([{ minutes: 10080, usedPercent: 3, resetsAt: 2000000 }]);
  expect(
    codexWindows({
      rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } },
    }),
  ).toEqual([]);
});

it('keeps independent poll intervals, expires values at reset and clears failures with backoff', async () => {
  let now = 1000;
  const window = { minutes: 300, usedPercent: 41, resetsAt: 1_000_000 };
  const claude = vi
    .fn()
    .mockResolvedValue([
      window,
      { ...window, minutes: 10080, usedPercent: 50 },
    ]);
  const codex = vi.fn().mockResolvedValue([{ ...window, usedPercent: 45 }]);
  const monitor = new UsageMonitor({ claude, codex }, () => now);
  await Promise.all([monitor.refresh(), monitor.refresh()]);
  expect(claude).toHaveBeenCalledTimes(1);
  expect(codex).toHaveBeenCalledTimes(1);
  expect(monitor.snapshot().claude.remainingPercent).toBe(50);
  expect(windowRemaining(monitor.snapshot().claude, 300)).toBe(59);
  now += 60_000;
  await monitor.refresh();
  expect(codex).toHaveBeenCalledTimes(2);
  expect(claude).toHaveBeenCalledTimes(1);
  now = 301000;
  claude.mockRejectedValueOnce(new UsageReadError('rate-limited', 600000));
  await monitor.refresh();
  expect(monitor.snapshot().claude.remainingPercent).toBeNull();
  expect(monitor.snapshot().claude.status).toBe('rate-limited');
  now = 601000;
  await monitor.refresh();
  expect(claude).toHaveBeenCalledTimes(2);
  now = 1_000_000;
  expect(monitor.snapshot().codex.status).toBe('stale');
  monitor.stop();
  await monitor.refresh();
  expect(claude).toHaveBeenCalledTimes(2);
});

it('uses fixed-origin Claude metadata GET without persisting or returning credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'even-usage-'));
  try {
    const path = join(dir, 'auth.json');
    await writeFile(
      path,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'TEST-SECRET',
          expiresAt: Date.now() + 60000,
        },
      }),
    );
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          five_hour: {
            utilization: 0,
            resets_at: new Date(Date.now() + 300000).toISOString(),
          },
          private: 'TEST-SECRET',
        }),
      ),
    );
    const windows = await readClaudeUsage(
      path,
      new AbortController().signal,
      request,
    );
    expect(request).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        redirect: 'error',
        headers: {
          Authorization: 'Bearer TEST-SECRET',
          'anthropic-beta': 'oauth-2025-04-20',
        },
      }),
    );
    expect(JSON.stringify(windows)).not.toContain('TEST-SECRET');
    request.mockResolvedValue(
      new Response('', { status: 429, headers: { 'retry-after': '900' } }),
    );
    await expect(
      readClaudeUsage(path, new AbortController().signal, request),
    ).rejects.toMatchObject({ status: 'rate-limited', retryMs: 900000 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('fits native header labels and retains every task within the container budget', () => {
  const value = {
    status: 'ok' as const,
    remainingPercent: 100,
    observedAt: 1,
    windows: [
      { minutes: 300, usedPercent: 0, resetsAt: 999999 },
      { minutes: 10080, usedPercent: 0, resetsAt: 999999 },
    ],
  };
  const usage: UsageSnapshot = { claude: value, codex: value };
  const clock = '2026/12/31 木 23:59   G2 100% +';
  expect(getTextWidth(clock)).toBeLessThanOrEqual(292);
  const rows = Array.from({ length: 30 }, (_, i) => ({
    agent: 'codex' as const,
    icon: 'running' as const,
    text: 'long task name ' + i,
  }));
  const pages = agentFlowPages(rows, 5);
  expect(pages.flat()).toEqual(rows);
  for (const page of pages)
    for (const footer of ['', '2/5', 'OFFLINE'])
      for (const online of [true, false]) {
        const scene = sceneSchema.parse(
          agentScene(page, footer, online, clock, usage),
        );
        const clockElement = scene.elements.find((e) => e.id === 'clock')!;
        for (const element of scene.elements.filter((e) =>
          e.id.startsWith('usage-'),
        )) {
          if (element.type !== 'text' || clockElement.type !== 'text')
            throw new Error('Expected native text');
          expect(element.y).toBe(clockElement.y);
          expect(element.padding).toBe(clockElement.padding);
          expect(element.brightness).toBe(clockElement.brightness);
          // A shorter G2 line box creates scrollbars even when the text width fits.
          expect(element.height - 2 * element.padding).toBeGreaterThanOrEqual(
            28,
          );
          expect(getTextWidth(element.text)).toBeLessThanOrEqual(
            element.width - element.padding * 2,
          );
          if (!online) expect(element.text).toContain('--%');
        }
        expect(clockElement.x + clockElement.width).toBeLessThanOrEqual(306);
        if (clockElement.type !== 'text')
          throw new Error('Expected native clock');
        expect(
          clockElement.height - 2 * clockElement.padding,
        ).toBeGreaterThanOrEqual(footer ? 56 : 28);
        expect(scene.elements[0]!.id).toBe('header-rule-0');
        expect(
          scene.elements.filter((e) => e.type === 'text').length,
        ).toBeLessThanOrEqual(8);
        expect(
          scene.elements.filter((e) => e.type === 'image').length,
        ).toBeLessThanOrEqual(4);
      }
  const unknown = {
    ...usage,
    claude: {
      ...value,
      status: 'unavailable' as const,
      remainingPercent: null,
      windows: [],
    },
  };
  expect(
    agentScene([], '', true, clock, unknown).elements.find(
      (e) => e.id === 'usage-claude',
    ),
  ).toMatchObject({ text: '5H --% W --%' });
  expect(agentScene([], '', false, clock, usage)).toEqual(
    agentScene([], '', false, clock, unknown),
  );
});
