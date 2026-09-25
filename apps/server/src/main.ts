import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createServer } from './app.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
if (existsSync(resolve(root, '.env')))
  process.loadEnvFile(resolve(root, '.env'));
const staticRoot = resolve(root, 'apps/even-g2/dist');
const app = await createServer({
  databasePath: resolve(
    root,
    process.env.DATABASE_PATH || '.local/dashboard.db',
  ),
  apiToken: process.env.API_TOKEN || undefined,
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  staticRoot: existsSync(staticRoot) ? staticRoot : undefined,
  logger: true,
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
try {
  await app.listen({
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 3000),
  });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
