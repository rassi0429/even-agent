import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  createItemSchema,
  patchItemSchema,
  screenDocumentSchema,
  deviceTelemetryMessageSchema,
  deviceEventMessageSchema,
  sensorRequestSchema,
  type DeviceTelemetry,
} from '@even-agent/protocol';
import { ItemStore } from './store.js';
import { LiveDisplay } from './live-display.js';
import { DeviceEventLog } from './device-events.js';
import { SensorHub } from './sensors.js';

export interface ServerOptions {
  databasePath?: string;
  apiToken?: string;
  corsOrigins?: string[];
  staticRoot?: string;
  expiryIntervalMs?: number;
  logger?: boolean;
  now?: () => number;
}
export async function createServer(options: ServerOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 16 * 1024,
  });
  const store = new ItemStore(options.databasePath ?? ':memory:', options.now);
  let customScreen = store.screen();
  const clients = new Set<WebSocket>();
  const displayClients = new Set<WebSocket>();
  const alive = new WeakSet<WebSocket>();
  const deviceReports = new Map<
    WebSocket,
    { data: DeviceTelemetry; observedAt: number; sessionId: string }
  >();
  const nowMs = options.now ?? Date.now;
  const deviceEvents = new DeviceEventLog(nowMs);
  const sensors = new SensorHub(nowMs);
  const liveDisplay = new LiveDisplay(nowMs);
  const freshReports = () =>
    [...deviceReports.values()]
      .filter((report) => nowMs() - report.observedAt < 90_000)
      .sort((a, b) => b.observedAt - a.observedAt);
  const activeDevice = () =>
    freshReports().find((report) => report.data.connected);
  await app.register(cors, {
    origin: options.corsOrigins ?? [],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  if (options.staticRoot)
    await app.register(staticFiles, { root: options.staticRoot });

  app.addHook('onRequest', async (request, reply) => {
    if (
      !options.apiToken ||
      (['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
        request.url.split('?')[0] !== '/ws/device/stream')
    )
      return;
    const actual = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${options.apiToken}`);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });
  const send = (targets: Set<WebSocket>, payload: string) => {
    for (const client of targets) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > 8 * 1024 * 1024) {
        client.terminate();
        continue;
      }
      client.send(payload, (error) => {
        if (error) client.terminate();
      });
    }
  };
  let closing = false;
  const display = () => {
    const now = new Date((options.now ?? Date.now)());
    if (customScreen)
      return {
        version: 1 as const,
        updatedAt: customScreen.updatedAt,
        generatedAt: now.getTime(),
        pages: customScreen.document.pages,
      };
    return liveDisplay.display();
  };
  const broadcastDisplay = () =>
    send(displayClients, JSON.stringify({ type: 'display', data: display() }));
  const broadcast = () => {
    send(clients, JSON.stringify({ type: 'state', data: store.state() }));
    if (!customScreen) broadcastDisplay();
  };
  const expire = () => {
    if (store.expire()) broadcast();
  };
  const screenMode = () =>
    customScreen
      ? 'custom'
      : liveDisplay.online
        ? 'live'
        : liveDisplay.status().publisherId
          ? 'offline'
          : 'idle';
  app.get('/health', async () => ({
    status: 'ok',
    service: 'even-agent',
    displayProtocol: 1,
    sceneProtocol: 1,
    screenMode: screenMode(),
    clients: clients.size + displayClients.size,
    displayClients: displayClients.size,
    publisher: liveDisplay.status(),
  }));
  app.get('/api/display/live', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return liveDisplay.status();
  });
  app.put(
    '/api/display/live',
    { bodyLimit: 4 * 1024 * 1024 },
    async (request, reply) => {
      const result = liveDisplay.publish(request.body);
      if (result.changed && !customScreen) broadcastDisplay();
      return reply.code(result.status).send(result.body);
    },
  );
  app.delete('/api/display/live', async (request, reply) => {
    const status = liveDisplay.release(
      (request.body as { publisherId?: unknown } | null)?.publisherId,
    );
    if (status === 204 && !customScreen) broadcastDisplay();
    return reply
      .code(status)
      .send(
        status === 204
          ? undefined
          : { error: 'Publisher does not own the lease' },
      );
  });
  app.get('/api/device', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const report = activeDevice();
    return {
      version: 1,
      source: 'client-reported',
      device: report?.data ?? null,
      observedAt: report?.observedAt ?? null,
      latestReport: freshReports()[0] ?? null,
    };
  });
  app.get('/api/device/events', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = request.query as { after?: string };
    const after = query.after === undefined ? 0 : Number(query.after);
    if (
      query.after !== undefined &&
      (typeof query.after !== 'string' ||
        !/^\d+$/.test(query.after) ||
        !Number.isSafeInteger(after) ||
        after < 0)
    )
      return reply
        .code(400)
        .send({ error: 'after must be a non-negative integer' });
    return {
      version: 1,
      source: 'client-reported',
      ...deviceEvents.read(after),
    };
  });
  app.get('/api/device/streams', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return sensors.list();
  });
  app.post('/api/device/commands', async (request, reply) => {
    const parsed = sensorRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'Invalid sensor command', issues: parsed.error.issues });
    const result = await sensors.command(parsed.data);
    return reply.code(result.status).send(result.body);
  });
  app.get('/ws/device/stream', { websocket: true }, (socket) =>
    sensors.subscribe(socket),
  );
  app.get('/api/display', async (_request, reply) => {
    // Installed .ehpk WebViews have a different origin from the PC server.
    // Only this public, read-only projection permits arbitrary browser origins.
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Cache-Control', 'no-store');
    expire();
    return display();
  });
  app.get('/api/state', async () => {
    expire();
    return store.state();
  });
  app.get('/api/screen', async () => ({
    mode: screenMode(),
    document: customScreen?.document ?? null,
    updatedAt: customScreen?.updatedAt ?? null,
  }));
  app.put(
    '/api/screen',
    { bodyLimit: 4 * 1024 * 1024 },
    async (request, reply) => {
      const parsed = screenDocumentSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: 'Invalid screen', issues: parsed.error.issues });
      customScreen = store.setScreen(parsed.data);
      broadcastDisplay();
      return { mode: 'custom', ...customScreen };
    },
  );
  app.delete('/api/screen', async (_request, reply) => {
    store.clearScreen();
    customScreen = undefined;
    broadcastDisplay();
    return reply.code(204).send();
  });
  app.get('/api/items', async () => {
    expire();
    const state = store.state();
    return [...state.now, ...state.soon, ...state.waiting];
  });
  app.post('/api/items', async (request, reply) => {
    const result = createItemSchema.safeParse(request.body);
    if (!result.success)
      return reply
        .code(400)
        .send({ error: 'Invalid item', issues: result.error.issues });
    const item = store.create(result.data);
    store.expire();
    broadcast();
    return reply.code(201).send(item);
  });
  app.patch<{ Params: { id: string } }>(
    '/api/items/:id',
    async (request, reply) => {
      const result = patchItemSchema.safeParse(request.body);
      if (!result.success)
        return reply
          .code(400)
          .send({ error: 'Invalid patch', issues: result.error.issues });
      expire();
      const item = store.patch(request.params.id, result.data);
      if (!item) return reply.code(404).send({ error: 'Item not found' });
      store.expire();
      broadcast();
      return item;
    },
  );
  app.delete<{ Params: { id: string } }>(
    '/api/items/:id',
    async (request, reply) => {
      expire();
      if (!store.delete(request.params.id))
        return reply.code(404).send({ error: 'Item not found' });
      broadcast();
      return reply.code(204).send();
    },
  );
  app.get('/ws', { websocket: true }, (socket) => {
    expire();
    clients.add(socket);
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
    socket.on('error', () => socket.terminate());
    socket.on('close', () => clients.delete(socket));
    socket.send(JSON.stringify({ type: 'state', data: store.state() }));
  });
  app.get('/ws/display', { websocket: true }, (socket) => {
    const sessionId = randomUUID();
    sensors.add(sessionId, socket);
    expire();
    displayClients.add(socket);
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      displayClients.delete(socket);
      deviceReports.delete(socket);
      sensors.remove(sessionId);
    });
    let reportWindow = nowMs();
    let reportCount = 0;
    let eventWindow = nowMs();
    let eventCount = 0;
    socket.on('message', (raw) => {
      // Advisory telemetry only. This channel cannot write items or custom screens.
      if (closing) return;
      try {
        const rawText = String(raw);
        const bytes = Buffer.byteLength(rawText);
        const payload: unknown = JSON.parse(rawText);
        if (sensors.receive(sessionId, payload, bytes)) return;
        if (bytes > 1024) return;
        const event = deviceEventMessageSchema.safeParse(payload);
        if (event.success) {
          if (nowMs() - eventWindow >= 1000) {
            eventWindow = nowMs();
            eventCount = 0;
          }
          if (eventCount++ < 20)
            deviceEvents.append(sessionId, event.data.data);
          return;
        }
        const message = deviceTelemetryMessageSchema.safeParse(payload);
        if (!message.success) return;
        if (nowMs() - reportWindow >= 1000) {
          reportWindow = nowMs();
          reportCount = 0;
        }
        if (message.data.data.connected && reportCount++ >= 20) return;
        deviceReports.set(socket, {
          data: message.data.data,
          observedAt: nowMs(),
          sessionId,
        });
        sensors.available(
          sessionId,
          message.data.data.connected && message.data.data.controlVersion === 1,
        );
      } catch {
        /* Invalid or unrelated messages do not change any state. */
      }
    });
    socket.send(JSON.stringify({ type: 'display', data: display() }));
  });
  const expiry = setInterval(expire, options.expiryIntervalMs ?? 1000);
  expiry.unref();
  // Transport heartbeat; the publisher owns clocks and presentation.
  const displayRefresh = setInterval(broadcastDisplay, 15000);
  displayRefresh.unref();
  let publisherOnline = liveDisplay.online;
  const publisherExpiry = setInterval(() => {
    const online = liveDisplay.online;
    if (online !== publisherOnline) {
      publisherOnline = online;
      if (!customScreen) broadcastDisplay();
    }
  }, 1000);
  publisherExpiry.unref();
  const heartbeat = setInterval(() => {
    for (const client of [...clients, ...displayClients]) {
      if (!alive.has(client)) {
        client.terminate();
        continue;
      }
      alive.delete(client);
      client.ping();
    }
  }, 15000);
  heartbeat.unref();
  app.addHook('preClose', async () => {
    closing = true;
    sensors.close();
    clearInterval(expiry);
    clearInterval(displayRefresh);
    clearInterval(publisherExpiry);
    clearInterval(heartbeat);
    for (const client of [...clients, ...displayClients]) client.terminate();
  });
  app.addHook('onClose', async () => store.close());
  return app;
}
