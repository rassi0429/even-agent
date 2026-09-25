import { existsSync } from 'node:fs';
import { WebSocket } from 'ws';
if (existsSync('.env')) process.loadEnvFile('.env');
const [action = 'status', sensor, duration = '60', sessionId] =
  process.argv.slice(2);
const base =
  process.env.AGENT_SERVER_URL ||
  `http://127.0.0.1:${process.env.PORT || 3000}`;
const headers = process.env.API_TOKEN
  ? { Authorization: `Bearer ${process.env.API_TOKEN}` }
  : {};
if (action === 'listen') {
  const url = new URL('/ws/device/stream', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url, { headers });
  socket.on('message', (data) => process.stdout.write(String(data) + '\n'));
  socket.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  process.once('SIGINT', () => socket.close());
} else {
  const endpoint = {
    status: '/api/device',
    events: '/api/device/events',
    streams: '/api/device/streams',
    start: '/api/device/commands',
    stop: '/api/device/commands',
  }[action];
  if (
    !endpoint ||
    (['start', 'stop'].includes(action) && !['audio', 'imu'].includes(sensor))
  )
    throw new Error(
      'Usage: pnpm device status|events|streams|listen | start audio|imu [seconds] [sessionId] | stop audio|imu',
    );
  const body = ['start', 'stop'].includes(action)
    ? JSON.stringify({
        sensor,
        action,
        durationSeconds: Number(duration),
        ...(sessionId ? { sessionId } : {}),
      })
    : undefined;
  const response = await fetch(new URL(endpoint, base), {
    method: body ? 'POST' : 'GET',
    headers: {
      ...headers,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
    signal: AbortSignal.timeout(12000),
    redirect: 'error',
  });
  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
  if (!response.ok) process.exitCode = 1;
}
