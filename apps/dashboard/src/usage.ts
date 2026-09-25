export type UsageProvider = 'claude' | 'codex';
export type UsageWindow = {
  minutes: number;
  usedPercent: number;
  resetsAt: number;
};
export type UsageStatus =
  | 'ok'
  | 'checking'
  | 'unavailable'
  | 'auth-required'
  | 'rate-limited'
  | 'stale';
export type UsageValue = {
  status: UsageStatus;
  remainingPercent: number | null;
  windows: UsageWindow[];
  observedAt: number | null;
};
export type UsageSnapshot = Record<UsageProvider, UsageValue>;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
function windowValue(
  minutes: unknown,
  used: unknown,
  resetsAt: unknown,
): UsageWindow[] {
  if (
    typeof minutes !== 'number' ||
    !Number.isFinite(minutes) ||
    minutes <= 0 ||
    typeof used !== 'number' ||
    !Number.isFinite(used) ||
    used < 0 ||
    typeof resetsAt !== 'number' ||
    !Number.isFinite(resetsAt) ||
    resetsAt <= 0
  )
    return [];
  return [{ minutes, usedPercent: Math.min(100, used), resetsAt }];
}
export function codexWindows(raw: unknown): UsageWindow[] {
  const result = object(raw);
  // Never substitute a model-specific or unrelated bucket for the core Codex limit.
  const buckets = result.rateLimitsByLimitId;
  const limits = object(
    buckets !== undefined && buckets !== null
      ? object(buckets).codex
      : result.rateLimits,
  );
  if (limits.limitId && limits.limitId !== 'codex') return [];
  return [limits.primary, limits.secondary].flatMap((raw) => {
    const w = object(raw);
    return windowValue(
      w.windowDurationMins,
      w.usedPercent,
      typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null,
    );
  });
}
export function claudeWindows(raw: unknown): UsageWindow[] {
  const result = object(raw);
  return [
    ['five_hour', 300],
    ['seven_day', 10080],
  ].flatMap(([key, minutes]) => {
    const w = object(result[key!]);
    return windowValue(
      minutes,
      w.utilization,
      typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : null,
    );
  });
}
export class UsageReadError extends Error {
  constructor(
    readonly status: 'unavailable' | 'auth-required' | 'rate-limited',
    readonly retryMs = 300_000,
  ) {
    super(status);
  }
}
type Reader = (signal: AbortSignal) => Promise<UsageWindow[]>;
export class UsageMonitor {
  private readonly controller = new AbortController();
  private stopped = false;
  private state: UsageSnapshot = {
    claude: {
      status: 'checking',
      remainingPercent: null,
      windows: [],
      observedAt: null,
    },
    codex: {
      status: 'checking',
      remainingPercent: null,
      windows: [],
      observedAt: null,
    },
  };
  private next: Record<UsageProvider, number> = { claude: 0, codex: 0 };
  private pending: Partial<Record<UsageProvider, Promise<void>>> = {};
  constructor(
    private readonly readers: Record<UsageProvider, Reader>,
    private readonly now = Date.now,
  ) {}
  refresh(): Promise<void> {
    return Promise.all(
      (['claude', 'codex'] as const).map((provider) => {
        if (this.stopped) return Promise.resolve();
        if (this.pending[provider]) return this.pending[provider];
        if (this.now() < this.next[provider]) return Promise.resolve();
        this.next[provider] =
          this.now() + (provider === 'claude' ? 300_000 : 60_000);
        const promise = this.collect(provider).finally(() => {
          delete this.pending[provider];
        });
        this.pending[provider] = promise;
        return promise;
      }),
    ).then(() => {});
  }
  private async collect(provider: UsageProvider) {
    try {
      const windows = await this.readers[provider](this.controller.signal);
      if (this.stopped) return;
      this.state[provider] = {
        status: windows.length ? 'ok' : 'unavailable',
        remainingPercent: null,
        windows,
        observedAt: this.now(),
      };
    } catch (error) {
      if (this.stopped) return;
      const status =
        error instanceof UsageReadError ? error.status : 'unavailable';
      if (error instanceof UsageReadError)
        this.next[provider] =
          this.now() + Math.max(60_000, Math.min(1800_000, error.retryMs));
      this.state[provider] = {
        status,
        remainingPercent: null,
        windows: [],
        observedAt: null,
      };
    }
  }
  snapshot(): UsageSnapshot {
    const value = (provider: UsageProvider): UsageValue => {
      const state = this.state[provider];
      if (state.status !== 'ok') return { ...state };
      const stale =
        state.observedAt === null ||
        this.now() - state.observedAt >= 600_000 ||
        state.windows.some((w) => w.resetsAt <= this.now());
      return {
        ...state,
        status: stale ? 'stale' : 'ok',
        remainingPercent: stale
          ? null
          : Math.floor(
              Math.min(...state.windows.map((w) => 100 - w.usedPercent)),
            ),
      };
    };
    return { claude: value('claude'), codex: value('codex') };
  }
  stop() {
    this.stopped = true;
    this.controller.abort();
  }
}
