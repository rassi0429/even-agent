import type { DisplayState } from '@even-agent/protocol';

interface NebiView {
  version: 1;
  viewId: 'g2';
  revision: string;
  generatedAt: string;
  expiresAt: string;
  timeZone: string;
  items: { id: string; text: string; revision: string }[];
}
type State = 'connecting' | 'ok' | 'unavailable' | 'unauthorized' | 'expired';

function parseView(value: unknown, now: number): NebiView {
  const view = value as NebiView | null;
  const hash = (v: unknown) =>
    typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const generated = Date.parse(view?.generatedAt ?? '');
  const expires = Date.parse(view?.expiresAt ?? '');
  if (
    !view ||
    view.version !== 1 ||
    view.viewId !== 'g2' ||
    !hash(view.revision) ||
    !Number.isFinite(generated) ||
    !Number.isFinite(expires) ||
    generated > now + 5000 ||
    expires <= now ||
    expires <= generated ||
    expires - generated > 60_000 ||
    typeof view.timeZone !== 'string' ||
    !Array.isArray(view.items) ||
    view.items.length > 4 ||
    view.items.some(
      (item) =>
        !item ||
        typeof item.id !== 'string' ||
        item.id.length > 128 ||
        !hash(item.revision) ||
        typeof item.text !== 'string' ||
        !item.text.length ||
        Buffer.byteLength(item.text) > 160 ||
        /[\p{Cc}\p{Cf}]/u.test(item.text),
    ) ||
    new Set(view.items.map((item) => item.id)).size !== view.items.length
  )
    throw new Error('Invalid Nebi view');
  new Intl.DateTimeFormat('ja-JP', { timeZone: view.timeZone }).format(0);
  // Copy only the display contract. Extra source fields never reach the gateway.
  return {
    version: 1,
    viewId: 'g2',
    revision: view.revision,
    generatedAt: view.generatedAt,
    expiresAt: view.expiresAt,
    timeZone: view.timeZone,
    items: view.items.map(({ id, text, revision }) => ({ id, text, revision })),
  };
}

export class NebiMonitor {
  private view?: NebiView;
  private state: State = 'connecting';
  private lastAttempt = -Infinity;
  private lastSuccess: number | null = null;
  private pending?: Promise<void>;
  private controller?: AbortController;
  private stopped = false;
  private readonly url: URL;
  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly now = Date.now,
  ) {
    this.url = new URL(baseUrl);
    if (
      this.url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(this.url.hostname) ||
      this.url.username ||
      this.url.password ||
      this.url.pathname !== '/' ||
      this.url.search ||
      this.url.hash ||
      token.length < 32
    ) {
      throw new Error(
        'Nebi requires a loopback HTTP origin and a separate read token',
      );
    }
    this.url.pathname = '/v1/views/g2';
  }
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.stopped || this.now() - this.lastAttempt < 5000)
      return Promise.resolve();
    this.lastAttempt = this.now();
    this.controller = new AbortController();
    this.pending = this.read(this.controller.signal).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async read(signal: AbortSignal): Promise<void> {
    try {
      const response = await fetch(this.url, {
        headers: { Authorization: `Bearer ${this.token}` },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      });
      if (!response.ok) {
        this.state =
          response.status === 401 || response.status === 403
            ? 'unauthorized'
            : 'unavailable';
        this.view = undefined;
        await response.body?.cancel();
        return;
      }
      // Bound even a malformed local response; never print its body.
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > 8192) throw new Error('Nebi view too large');
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      const view = parseView(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
        this.now(),
      );
      if (!this.stopped) {
        this.view = view;
        this.lastSuccess = this.now();
        this.state = 'ok';
      }
    } catch {
      this.view = undefined;
      this.state = 'unavailable';
    }
  }
  status() {
    return {
      state:
        this.view && Date.parse(this.view.expiresAt) <= this.now()
          ? ('expired' as const)
          : this.state,
      lastSuccess: this.lastSuccess,
      revision: this.view?.revision ?? null,
    };
  }
  page(): DisplayState['pages'][number] {
    const { state } = this.status();
    const view = state === 'ok' ? this.view : undefined;
    const time =
      this.lastSuccess === null
        ? '未取得'
        : new Intl.DateTimeFormat('ja-JP', {
            timeZone: this.view?.timeZone ?? 'Asia/Tokyo',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).format(this.lastSuccess);
    const title = view ? 'Nebi' : 'Nebi 同期待ち';
    const lines = view
      ? view.items.length
        ? view.items.map((item) => item.text)
        : ['今表示するTODOはありません']
      : [
          state === 'unauthorized'
            ? '表示キーの確認が必要です'
            : state === 'expired'
              ? '情報の更新が止まっています'
              : 'Nebiに接続できません',
        ];
    const footer = `最終取得 ${time}`;
    const content = [title, ...lines, footer].join('\n');
    return {
      id: 'nebi',
      content,
      offlineContent: `Nebi OFFLINE\n表示アプリとの接続を確認してください\n${footer}`,
      scene: {
        elements: [
          {
            type: 'text',
            id: 'title',
            x: 16,
            y: 8,
            width: 544,
            height: 36,
            text: title,
            padding: 0,
            border: 0,
            brightness: 4,
          },
          {
            type: 'text',
            id: 'body',
            x: 16,
            y: 48,
            width: 544,
            height: 184,
            text: lines.join('\n'),
            padding: 0,
            border: 0,
            brightness: 4,
          },
          {
            type: 'text',
            id: 'footer',
            x: 16,
            y: 244,
            width: 544,
            height: 36,
            text: footer,
            padding: 0,
            border: 0,
            brightness: 4,
          },
        ],
      },
    };
  }
  async stop() {
    this.stopped = true;
    this.controller?.abort();
    await this.pending;
  }
  panel() {
    const lines = this.page().content.split('\n').slice(1, -1);
    const quiet =
      this.status().state === 'connecting' ||
      (this.status().state === 'ok' && !this.view?.items.length);
    return {
      online: quiet ? '' : lines.slice(0, 3).join('\n'),
      offline: '画面配信が止まっています\n配信元との接続を確認してください',
    };
  }
}
