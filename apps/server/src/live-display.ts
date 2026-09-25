import { liveDisplaySchema, type DisplayState } from '@even-agent/protocol';

// Transport-owned lease only: no clock, agent collection or application layout.
export class LiveDisplay {
  private current?: {
    publisherId: string;
    expiresAt: number;
    display: DisplayState;
  };
  constructor(private readonly now: () => number) {}
  get online() {
    return !!this.current && this.current.expiresAt > this.now();
  }
  status() {
    return {
      online: this.online,
      publisherId: this.current?.publisherId ?? null,
      expiresAt: this.current?.expiresAt ?? null,
    };
  }
  publish(input: unknown) {
    const parsed = liveDisplaySchema.safeParse(input);
    if (!parsed.success)
      return {
        status: 400,
        body: { error: 'Invalid live display', issues: parsed.error.issues },
      };
    const { publisherId, ttlSeconds, display } = parsed.data;
    if (this.online && this.current?.publisherId !== publisherId)
      return {
        status: 409,
        body: { error: 'Another display publisher holds the lease' },
      };
    const changed =
      !this.online ||
      JSON.stringify(this.current?.display.pages) !==
        JSON.stringify(display.pages);
    this.current = {
      publisherId,
      expiresAt: this.now() + ttlSeconds * 1000,
      display,
    };
    return { status: 200, body: this.status(), changed };
  }
  release(publisherId: unknown) {
    if (typeof publisherId !== 'string') return 400;
    if (this.current?.publisherId !== publisherId) return 409;
    this.current.expiresAt = 0;
    return 204;
  }
  display(): DisplayState {
    if (!this.current)
      return {
        version: 1,
        updatedAt: 0,
        generatedAt: this.now(),
        pages: [
          {
            id: 'idle',
            content: 'Waiting for display app',
            offlineContent: 'OFFLINE\nWaiting for display app',
          },
        ],
      };
    const display = this.current.display;
    return {
      ...display,
      generatedAt: this.now(),
      pages: this.online
        ? display.pages
        : display.pages.map((page) => ({
            ...page,
            content: page.offlineContent,
            scene: page.offlineScene,
            iconRows: undefined,
          })),
    };
  }
}
