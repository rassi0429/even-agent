// Explicitly configured read-only health URLs. No LLM, task creation or gateway writes here.
type Target = { id: string; name: string; url: string; expectedStatus: number };
type Observation = {
  target: Target;
  failures: number;
  successes: number;
  alert: boolean;
  lastCheck: number | null;
  lastSuccess: number | null;
  reason: 'connection' | 'http' | null;
  httpStatus: number | null;
};
type Panel = { online: string; offline: string };
const interval = 30_000;
const staleAfter = 90_000;

function parseTargets(raw: string): Target[] {
  const values: unknown = JSON.parse(raw || '[]');
  if (!Array.isArray(values) || values.length > 4)
    throw new Error('Invalid health targets');
  const targets = values.map((value: unknown): Target => {
    if (!value || typeof value !== 'object')
      throw new Error('Invalid health target');
    const v = value as Record<string, unknown>;
    if (
      Object.keys(v).some(
        (k) => !['id', 'name', 'url', 'expectedStatus'].includes(k),
      ) ||
      typeof v.id !== 'string' ||
      !/^[a-z0-9-]{1,32}$/.test(v.id) ||
      typeof v.name !== 'string' ||
      !v.name.trim() ||
      [...v.name].length > 12 ||
      /[\p{Cc}\p{Cf}]/u.test(v.name) ||
      typeof v.url !== 'string'
    )
      throw new Error('Invalid health target');
    const url = new URL(v.url);
    const expectedStatus = v.expectedStatus ?? 200;
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !Number.isInteger(expectedStatus) ||
      Number(expectedStatus) < 200 ||
      Number(expectedStatus) > 299
    )
      throw new Error('Invalid health target');
    return {
      id: v.id,
      name: v.name.trim(),
      url: url.href,
      expectedStatus: Number(expectedStatus),
    };
  });
  if (new Set(targets.map((t) => t.id)).size !== targets.length)
    throw new Error('Duplicate health target');
  return targets;
}

export class HealthMonitor {
  private readonly observations: Observation[];
  private readonly configurationError: boolean;
  private lastAttempt = -Infinity;
  private pending?: Promise<void>;
  private controller?: AbortController;
  private stopped = false;
  constructor(
    raw = '',
    private readonly now = Date.now,
  ) {
    let targets: Target[] = [];
    let error = false;
    try {
      targets = parseTargets(raw);
    } catch {
      error = true;
    }
    this.configurationError = error;
    this.observations = targets.map((target) => ({
      target,
      failures: 0,
      successes: 0,
      alert: false,
      lastCheck: null,
      lastSuccess: null,
      reason: null,
      httpStatus: null,
    }));
  }
  get enabled() {
    return this.configurationError || this.observations.length > 0;
  }
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (
      this.stopped ||
      !this.observations.length ||
      this.now() - this.lastAttempt < interval
    )
      return Promise.resolve();
    this.lastAttempt = this.now();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.pending = Promise.all(
      this.observations.map((row) => this.check(row, signal)),
    )
      .then(() => {})
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async check(row: Observation, signal: AbortSignal) {
    let status: number | null = null;
    try {
      const response = await fetch(row.target.url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      });
      status = response.status;
      // Headers/status suffice. Never read or log a health endpoint's body.
      await response.body?.cancel();
    } catch {
      /* Report inability to connect, not an inferred server failure. */
    }
    if (this.stopped) return;
    if (row.lastCheck !== null && this.now() - row.lastCheck >= staleAfter) {
      row.failures = 0;
      row.successes = 0;
    }
    row.lastCheck = this.now();
    row.httpStatus = status;
    if (status === row.target.expectedStatus) {
      row.lastSuccess = row.lastCheck;
      row.successes++;
      row.failures = 0;
      row.reason = null;
      if (row.successes >= 2) row.alert = false;
    } else {
      row.failures++;
      row.successes = 0;
      row.reason = status === null ? 'connection' : 'http';
      if (row.failures >= 3) row.alert = true;
    }
  }
  status() {
    return {
      enabled: this.enabled,
      configurationError: this.configurationError,
      intervalMs: interval,
      staleAfterMs: staleAfter,
      targets: this.observations.map((row) => ({
        id: row.target.id,
        name: row.target.name,
        state:
          this.stopped ||
          (row.lastCheck !== null && this.now() - row.lastCheck >= staleAfter)
            ? 'stale'
            : row.alert
              ? row.successes
                ? 'recovering'
                : 'unavailable'
              : row.lastCheck === null
                ? 'checking'
                : row.failures
                  ? 'suspect'
                  : 'ok',
        failures: row.failures,
        successes: row.successes,
        lastCheck: row.lastCheck,
        lastSuccess: row.lastSuccess,
        reason: row.reason,
        httpStatus: row.httpStatus,
      })),
    };
  }
  panel(base?: Panel): Panel {
    const status = this.status();
    const alerts = status.configurationError
      ? ['監視設定の確認が必要です']
      : status.targets.flatMap((row) => {
          if (row.state === 'stale') return [`${row.name} 監視の更新停止`];
          if (row.state === 'recovering') return [`${row.name} 復旧を確認中`];
          if (row.state !== 'unavailable') return [];
          return [
            row.reason === 'http'
              ? `${row.name} HTTP ${row.httpStatus}`
              : `${row.name} 接続できません`,
          ];
        });
    if (!alerts.length)
      return base ?? { online: '', offline: '画面配信が止まっています' };
    const lines = [...alerts, ...(base?.online.split('\n').slice(1) ?? [])];
    return {
      online: [
        `Nebi 要確認${lines.length > 2 ? ' / ほかあり' : ''}`,
        ...lines.slice(0, 2),
      ].join('\n'),
      offline:
        base?.offline ??
        '画面配信が止まっています\n配信元との接続を確認してください',
    };
  }
  async stop() {
    this.stopped = true;
    this.controller?.abort();
    await this.pending;
  }
}
