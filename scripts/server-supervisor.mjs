import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = join(root, '.local');
mkdirSync(local, { recursive: true });
let stopping = false;
const workers = {
  server: {
    entry: 'apps/server/src/main.ts',
    child: undefined,
    retry: undefined,
  },
  dashboard: {
    entry: 'apps/dashboard/src/main.ts',
    child: undefined,
    retry: undefined,
  },
};
function log(name, content) {
  const path = join(local, name);
  if (existsSync(path) && statSync(path).size > 5 * 1024 * 1024) {
    writeFileSync(path, readFileSync(path).subarray(-2 * 1024 * 1024));
  }
  appendFileSync(path, content);
}
function status() {
  writeFileSync(
    join(local, 'supervisor.json'),
    JSON.stringify(
      {
        supervisorPid: process.pid,
        serverPid: workers.server.child?.pid ?? null,
        dashboardPid: workers.dashboard.child?.pid ?? null,
        root,
        stopping,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
function start(name) {
  const worker = workers[name];
  if (stopping) return;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(root, worker.entry)],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  worker.child = child;
  status();
  log(
    'supervisor.log',
    `${new Date().toISOString()} started ${name} ${child.pid}\n`,
  );
  child.stdout.on('data', (chunk) => log(`${name}.log`, chunk));
  child.stderr.on('data', (chunk) => log(`${name}-error.log`, chunk));
  child.on('error', (error) => log('supervisor.log', `${error.message}\n`));
  child.on('close', (code) => {
    worker.child = undefined;
    status();
    log(
      'supervisor.log',
      `${new Date().toISOString()} ${name} exited ${code}\n`,
    );
    if (!stopping) worker.retry = setTimeout(() => start(name), 3000);
  });
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    stopping = true;
    for (const worker of Object.values(workers)) {
      clearTimeout(worker.retry);
      worker.child?.kill();
    }
    status();
  });
start('server');
start('dashboard');
