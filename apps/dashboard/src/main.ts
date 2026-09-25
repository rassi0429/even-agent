import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createDashboard } from './app.js';
import { LocalAgentMonitor, defaultMonitorPaths } from './agents.js';
import { ClaudeCloudMonitor, CombinedAgentMonitor } from './claude-cloud.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
if (existsSync(resolve(root, '.env')))
  process.loadEnvFile(resolve(root, '.env'));
const paths = await defaultMonitorPaths();
const local = new LocalAgentMonitor(paths);
const monitor =
  process.env.LOCAL_AGENT_MONITOR !== '1'
    ? undefined
    : process.env.CLAUDE_CLOUD_MONITOR === '1'
      ? new CombinedAgentMonitor(
          local,
          new ClaudeCloudMonitor(
            resolve(paths.claudeHomes[0]!, '.credentials.json'),
          ),
        )
      : local;
const app = createDashboard({
  serverUrl:
    process.env.DASHBOARD_SERVER_URL ||
    `http://127.0.0.1:${process.env.PORT || 3000}`,
  apiToken: process.env.API_TOKEN || undefined,
  agentMonitor: monitor,
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
try {
  await app.listen({
    host: '127.0.0.1',
    port: Number(process.env.DASHBOARD_PORT || 3001),
  });
  console.log('Dashboard running; publishing through the display API');
} catch {
  console.error('Dashboard failed to listen; check DASHBOARD_PORT');
  await app.close();
  process.exitCode = 1;
}
