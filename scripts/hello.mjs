import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const url =
  process.env.AGENT_SERVER_URL ||
  `http://127.0.0.1:${process.env.PORT || 3000}`;
const response = await fetch(new URL('/api/items', url), {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(process.env.API_TOKEN
      ? { Authorization: `Bearer ${process.env.API_TOKEN}` }
      : {}),
  },
  body: JSON.stringify({
    title: 'Hello G2',
    description: 'Agent Serverからのテスト',
    priority: 'normal',
    section: 'now',
    source: 'test',
  }),
});
if (!response.ok)
  throw new Error(`HTTP ${response.status}: ${await response.text()}`);
console.log(await response.json());
