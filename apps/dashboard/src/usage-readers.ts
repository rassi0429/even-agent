import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  codexWindows,
  claudeWindows,
  UsageReadError,
  type UsageWindow,
} from './usage.js';

export function codexBinary(): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const installed = join(
    process.env.LOCALAPPDATA || '',
    'Programs',
    'OpenAI',
    'Codex',
    'bin',
    'codex.exe',
  );
  return process.platform === 'win32' && existsSync(installed)
    ? installed
    : process.platform === 'win32'
      ? 'codex.exe'
      : 'codex';
}
// Only initialize + metadata read. No turn, account reset, auth export or agent run.
export function readCodexUsage(
  signal: AbortSignal,
  binary = codexBinary(),
): Promise<UsageWindow[]> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new UsageReadError('unavailable'));
      return;
    }
    const child = spawn(binary, ['app-server', '--stdio'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = createInterface({ input: child.stdout });
    let settled = false,
      bytes = 0;
    const finish = (windows?: UsageWindow[], error?: UsageReadError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      lines.close();
      child.stdin.destroy();
      child.kill();
      if (error) reject(error);
      else resolve(windows ?? []);
    };
    const abort = () => finish(undefined, new UsageReadError('unavailable'));
    const timer = setTimeout(abort, 15_000);
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', abort);
    child.once('exit', () => {
      if (!settled) abort();
    });
    child.stdin.on('error', abort);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) abort();
    });
    const send = (data: unknown) => {
      if (!settled) child.stdin.write(JSON.stringify(data) + '\n');
    };
    lines.on('line', (line) => {
      if (settled) return;
      try {
        const message = JSON.parse(line);
        if (message.id !== 1 && message.id !== 2) return;
        if (message.error) {
          finish(undefined, new UsageReadError('unavailable'));
          return;
        }
        if (message.id === 1) {
          send({ method: 'initialized', params: {} });
          send({ method: 'account/rateLimits/read', id: 2 });
        } else finish(codexWindows(message.result));
      } catch {
        finish(undefined, new UsageReadError('unavailable'));
      }
    });
    send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'even_agent_usage',
          title: 'Even Agent usage monitor',
          version: '0.1.0',
        },
      },
    });
  });
}
export async function readClaudeUsage(
  path: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<UsageWindow[]> {
  const credentials = JSON.parse(await readFile(path, 'utf8'));
  const oauth = credentials.claudeAiOauth;
  if (
    typeof oauth?.accessToken !== 'string' ||
    !oauth.accessToken ||
    (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now())
  )
    throw new UsageReadError('auth-required');
  // Existing Claude Code account metadata endpoint; private and subject to change.
  const response = await request('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${oauth.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (response.status === 401 || response.status === 403)
    throw new UsageReadError('auth-required');
  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after')) * 1000;
    throw new UsageReadError(
      'rate-limited',
      Number.isFinite(retry) ? Math.max(300_000, retry) : 300_000,
    );
  }
  if (!response.ok) throw new UsageReadError('unavailable');
  return claudeWindows(await response.json());
}
