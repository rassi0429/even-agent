import {
  waitForEvenAppBridge,
  DeviceConnectType,
} from '@evenrealities/even_hub_sdk';
import {
  displaySchema,
  type DisplayState,
  type Scene,
} from '@even-agent/protocol';
import { DisplaySync } from './sync.js';
import { G2Renderer } from './renderer.js';
import { renderPreview } from './preview.js';
import { inputAction } from './input.js';
import { DeviceReporter } from './device.js';
import { deviceEvents } from './device-events.js';
import { SensorController } from './sensors.js';
import './style.css';

const screen = document.querySelector<HTMLPreElement>('#screen')!;
const connection = document.querySelector<HTMLParagraphElement>('#connection')!;
const device = document.querySelector<HTMLParagraphElement>('#device')!;
let state: DisplayState | undefined;
let page = 0;
let online = false;
let disposed = false;
let renderer: G2Renderer | undefined;
let deviceReporter: DeviceReporter | undefined;
let sensors: SensorController | undefined;
let g2Connected = false;
const cleanup: (() => void)[] = [];
let previewText = '';
let previewScene: Scene | undefined;
let previewKey = '';
let previewOrigin = Date.now();
const cacheKey = `even-agent-display-v1:${import.meta.env.VITE_AGENT_SERVER_URL || window.location.origin}`;
try {
  const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
  const result = displaySchema.safeParse(cached?.display);
  if (result.success) {
    state = result.data;
    page = Number.isInteger(cached.page) ? cached.page : 0;
  }
} catch {
  /* Storage may be unavailable in a restricted WebView. */
}
function save() {
  try {
    if (state)
      localStorage.setItem(cacheKey, JSON.stringify({ display: state, page }));
  } catch {
    /* Server remains authoritative. */
  }
}
function render() {
  if (disposed) return;
  const count = state?.pages.length ?? 1;
  page = ((page % count) + count) % count;
  const selected = state?.pages[page];
  const text = selected
    ? online
      ? selected.content
      : selected.offlineContent
    : 'Agent Dashboard\nConnecting to PC...';
  previewText = text;
  previewScene = online ? selected?.scene : selected?.offlineScene;
  const key = JSON.stringify([previewScene, online]);
  if (key !== previewKey) {
    previewKey = key;
    previewOrigin = Date.now();
  }
  renderPreview(
    screen,
    previewText,
    previewScene,
    Date.now() - previewOrigin,
    online,
  );
  renderer?.show(text, previewScene, online);
}
const serverUrl =
  import.meta.env.VITE_AGENT_SERVER_URL?.trim() || window.location.origin;
const sync = new DisplaySync(
  serverUrl,
  (next) => {
    state = next;
    render();
    save();
  },
  (connected, message) => {
    online = connected;
    connection.textContent = `Server: ${message}`;
    render();
  },
);
document.querySelector('#next')!.addEventListener('click', () => {
  page++;
  render();
  save();
});
document.querySelector('#previous')!.addEventListener('click', () => {
  page--;
  render();
  save();
});
const interval = setInterval(render, 3000); // Retry failed SDK writes; content/clock come from the PC.
const previewInterval = setInterval(() => {
  if (
    !online ||
    !previewScene?.elements.some(
      (e) =>
        e.type === 'image' &&
        e.frames.length > 1 &&
        (e.loop || Date.now() - previewOrigin < e.frameMs * e.frames.length),
    )
  )
    return;
  renderPreview(
    screen,
    previewText,
    previewScene,
    Date.now() - previewOrigin,
    online,
  );
}, 100);
function dispose() {
  if (disposed) return;
  disposed = true;
  sync.stop();
  renderer?.stop();
  deviceReporter?.stop();
  clearInterval(interval);
  clearInterval(previewInterval);
  cleanup.forEach((fn) => fn());
}
function reconnect() {
  if (!disposed) {
    sync.start();
    renderer?.invalidate();
    void deviceReporter?.refresh();
  }
}
window.addEventListener('online', reconnect);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) reconnect();
});
window.addEventListener('pagehide', dispose, { once: true });
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});
render();
sync.start();

// Browser preview works while the native bridge is absent. A normal browser
// is never reported as a connected G2 device.
void waitForEvenAppBridge()
  .then((bridge) => {
    if (disposed) return;
    sensors = new SensorController(
      bridge,
      () => !disposed && g2Connected && online && !!renderer?.ready,
      (message) => sync.sendSensor(message),
    );
    sync.onSensorCommand = (command) => {
      void sensors?.command(command);
    };
    sync.onSensorDisconnect = () => sensors?.stopAll();
    deviceReporter = new DeviceReporter(bridge, (report) => {
      g2Connected = report.connected;
      if (!report.connected) sensors?.stopAll('device-disconnected');
      sync.reportDevice(report);
    });
    deviceReporter.start();
    renderer = new G2Renderer(bridge, (message) => {
      device.textContent = message;
    });
    cleanup.push(
      bridge.onEvenHubEvent((event) => {
        sensors?.onEvent(event);
        for (const report of deviceEvents(event)) sync.reportEvent(report);
        switch (inputAction(event)) {
          case 'exit':
            void bridge.shutDownPageContainer(1).catch((error: unknown) => {
              device.textContent = `G2: ${String(error)}`;
            });
            break;
          case 'stop':
            dispose();
            break;
          case 'overlay-open':
            renderer?.setOverlayOpen(true);
            break;
          case 'overlay-close':
            renderer?.setOverlayOpen(false);
            break;
          case 'next':
            page++;
            render();
            save();
            break;
        }
      }),
    );
    cleanup.push(
      bridge.onDeviceStatusChanged((status) => {
        if (status.connectType === DeviceConnectType.Connected)
          renderer?.invalidate();
      }),
    );
    render();
  })
  .catch((error: unknown) => {
    device.textContent = `G2: ${String(error)}`;
  });
