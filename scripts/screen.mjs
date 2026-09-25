import { existsSync, readFileSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const [action = 'status', path] = process.argv.slice(2);
if (
  !['set', 'reset', 'status'].includes(action) ||
  (action === 'set' && !path)
) {
  throw new Error('Usage: pnpm screen set <file.json> | reset | status');
}
const base =
  process.env.AGENT_SERVER_URL ||
  `http://127.0.0.1:${process.env.PORT || 3000}`;
const body =
  action === 'set'
    ? JSON.stringify(JSON.parse(readFileSync(path, 'utf8')))
    : undefined;
const response = await fetch(new URL('/api/screen', base), {
  method: action === 'set' ? 'PUT' : action === 'reset' ? 'DELETE' : 'GET',
  headers: {
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(process.env.API_TOKEN
      ? { Authorization: `Bearer ${process.env.API_TOKEN}` }
      : {}),
  },
  body,
  redirect: 'error',
  signal: AbortSignal.timeout(10000),
});
if (!response.ok)
  throw new Error(`HTTP ${response.status}: ${await response.text()}`);
if (response.status === 204)
  console.log('Custom screen cleared. Automatic display restored.');
else {
  const result = await response.json();
  console.log(
    JSON.stringify(
      {
        mode: result.mode,
        updatedAt: result.updatedAt,
        pages:
          result.document?.pages.map((p) => ({
            id: p.id,
            elements: p.scene.elements.length,
          })) ?? [],
      },
      null,
      2,
    ),
  );
}
