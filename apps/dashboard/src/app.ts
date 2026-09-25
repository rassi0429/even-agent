import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  stateSchema,
  deviceTelemetrySchema,
  type DisplayState,
} from '@even-agent/protocol';
import type { AgentSnapshot } from './agents.js';
import { composeAgentDisplay, composeDisplay } from './display.js';
import type { UsageSnapshot } from './usage.js';

export interface DashboardOptions {
  serverUrl: string;
  apiToken?: string;
  agentMonitor?: { read(): Promise<AgentSnapshot> };
  now?: () => number;
  intervalMs?: number;
  agentPollMs?: number;
  usageMonitor?: {
    refresh(): Promise<void>;
    snapshot(): UsageSnapshot;
    stop(): void;
  };
}

// The only runtime link to the gateway is its documented HTTP API.
export function createDashboard(options: DashboardOptions) {
  const app = Fastify();
  const now = options.now ?? Date.now;
  const publisherId = randomUUID();
  let snapshot: AgentSnapshot = {
    tasks: [],
    sources: { codex: 'checking', claude: 'checking' },
    observedAt: 0,
  };
  let stopped = false,
    reading = false,
    publishing = false;
  let lastPublishedAt: number | null = null;
  let lastPages = '';
  let error: string | null = 'Waiting for API server';
  let latest: DisplayState | undefined;
  let update: Promise<void> | undefined;
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(new URL(path, options.serverUrl), {
      method,
      headers: {
        ...(options.apiToken
          ? { Authorization: `Bearer ${options.apiToken}` }
          : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok)
      throw new Error(`API ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  };
  const refreshAgents = async () => {
    if (stopped || reading || !options.agentMonitor) return;
    reading = true;
    try {
      const next = await options.agentMonitor.read();
      if (!stopped) snapshot = next;
    } catch {
      snapshot = {
        tasks: [],
        sources: { codex: 'read-error', claude: 'read-error' },
        observedAt: now(),
      };
    } finally {
      reading = false;
    }
  };
  const tick = async () => {
    if (stopped || publishing) return;
    publishing = true;
    try {
      const [rawState, rawDevice] = await Promise.all([
        request('/api/state'),
        request('/api/device'),
      ]);
      if (stopped) return;
      const state = stateSchema.parse(rawState);
      const device = rawDevice.device
        ? deviceTelemetrySchema.parse(rawDevice.device)
        : undefined;
      const display = options.agentMonitor
        ? composeAgentDisplay(
            state,
            snapshot,
            new Date(now()),
            device,
            options.usageMonitor?.snapshot(),
          )
        : composeDisplay(state, new Date(now()));
      const pages = JSON.stringify(display.pages);
      if (
        pages !== lastPages ||
        lastPublishedAt === null ||
        now() - lastPublishedAt >= 5000 ||
        error
      ) {
        await request('/api/display/live', 'PUT', {
          publisherId,
          ttlSeconds: 20,
          display,
        });
        lastPublishedAt = now();
        lastPages = pages;
      }
      latest = display;
      error = null;
    } catch (e) {
      // No tokens, response bodies, prompts or session contents are logged.
      error =
        e instanceof Error && e.message.startsWith('API ')
          ? e.message
          : 'API unavailable or invalid response';
    } finally {
      publishing = false;
    }
  };
  app.get('/health', async (_request, reply) => {
    const connected =
      !error && lastPublishedAt !== null && now() - lastPublishedAt < 20_000;
    return reply.code(connected ? 200 : 503).send({
      status: connected ? 'ok' : 'degraded',
      service: 'even-agent-dashboard',
      publisherId,
      lastPublishedAt,
      error,
      agentMonitor: options.agentMonitor
        ? {
            sources: snapshot.sources,
            tasks: snapshot.tasks.length,
            observedAt: snapshot.observedAt,
          }
        : null,
    });
  });
  app.get('/api/agents', async () =>
    options.agentMonitor
      ? snapshot
      : {
          tasks: [],
          sources: { codex: 'disabled', claude: 'disabled' },
          observedAt: 0,
        },
  );
  app.get('/api/display', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return latest ?? null;
  });
  app.get('/api/usage', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return options.usageMonitor?.snapshot() ?? null;
  });
  const timer = setInterval(() => {
    void options.usageMonitor?.refresh();
    if (!publishing) update = tick();
  }, options.intervalMs ?? 1000);
  const agentTimer = setInterval(() => {
    void refreshAgents();
  }, options.agentPollMs ?? 3000);
  timer.unref();
  agentTimer.unref();
  app.addHook('onReady', async () => {
    void options.usageMonitor?.refresh();
    void refreshAgents();
    update = tick();
  });
  app.addHook('onClose', async () => {
    stopped = true;
    options.usageMonitor?.stop();
    clearInterval(timer);
    clearInterval(agentTimer);
    await update;
    // Releasing our lease never modifies a custom screen or another publisher.
    if (lastPublishedAt !== null)
      try {
        await request('/api/display/live', 'DELETE', { publisherId });
      } catch {
        /* Lease expires after 20 seconds even if the gateway is down. */
      }
  });
  return app;
}
