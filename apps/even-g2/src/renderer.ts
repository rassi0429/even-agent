import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  StartUpPageCreateResult,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import {
  decodeGray4,
  frameIndex,
  type Scene,
  type SceneElement,
} from '@even-agent/protocol';

type DisplayBridge = Pick<
  EvenAppBridge,
  'createStartUpPageContainer' | 'textContainerUpgrade'
> &
  Partial<Pick<EvenAppBridge, 'rebuildPageContainer' | 'updateImageRawData'>>;
export function sceneContainers(elements: SceneElement[]) {
  const hasText = elements.some((e) => e.type === 'text');
  let captures = false;
  const textObject: TextContainerProperty[] = [];
  const imageObject: ImageContainerProperty[] = [];
  elements.forEach((element, index) => {
    const base = {
      containerID: index + 1,
      containerName: `e-${index}`,
      xPosition: element.x,
      yPosition: element.y,
      width: element.width,
      height: element.height,
      zOrderIndex: index + 1,
    };
    if (element.type === 'text') {
      textObject.push(
        new TextContainerProperty({
          ...base,
          content: element.text,
          paddingLength: element.padding,
          borderWidth: element.border,
          textColor: element.brightness,
          isEventCapture: captures ? 0 : 1,
        }),
      );
      captures = true;
    } else imageObject.push(new ImageContainerProperty(base));
  });
  if (!hasText)
    textObject.push(
      new TextContainerProperty({
        containerID: 12,
        containerName: 'capture',
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        zOrderIndex: 0,
        content: ' ',
        borderWidth: 0,
        paddingLength: 0,
        isEventCapture: 1,
      }),
    );
  return {
    containerTotalNum: textObject.length + imageObject.length,
    textObject,
    imageObject,
  };
}
const fallback = (text: string): SceneElement[] => [
  {
    type: 'text',
    id: 'fallback',
    x: 0,
    y: 0,
    width: 576,
    height: 288,
    text: text || ' ',
    padding: 4,
    border: 0,
    brightness: 4,
  },
];
const geometry = (elements: SceneElement[]) =>
  JSON.stringify(
    elements.map((e) =>
      e.type === 'text'
        ? {
            id: e.id,
            type: e.type,
            x: e.x,
            y: e.y,
            width: e.width,
            height: e.height,
            padding: e.padding,
            border: e.border,
          }
        : {
            id: e.id,
            type: e.type,
            x: e.x,
            y: e.y,
            width: e.width,
            height: e.height,
          },
    ),
  );

export class G2Renderer {
  private desired = '';
  private scene?: Scene;
  private sceneKey = '';
  private online = true;
  private phaseOrigin = Date.now();
  private sentText = new Map<number, string>();
  private sentImages = new Map<number, string>();
  private geometryKey = '';
  private running = false;
  private stopped = false;
  private started = false;
  private failedStartup = false;
  private overlayOpen = false;
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private epoch = 0;
  private imagesFailed = false;
  constructor(
    private readonly bridge: DisplayBridge,
    private readonly status: (message: string) => void,
  ) {}
  get ready() {
    return this.started && !this.stopped && !this.failedStartup;
  }
  show(text: string, scene?: Scene, online = true) {
    const key = JSON.stringify(scene) || '';
    if (key !== this.sceneKey || online !== this.online)
      this.phaseOrigin = Date.now();
    if (
      text !== this.desired ||
      key !== this.sceneKey ||
      online !== this.online
    )
      this.revision++;
    this.desired = text;
    this.scene = scene;
    this.sceneKey = key;
    this.online = online;
    this.kick();
  }
  private kick() {
    if (
      !this.running &&
      !this.stopped &&
      !this.failedStartup &&
      !this.overlayOpen
    )
      void this.flush();
  }
  private clearTimer() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  setOverlayOpen(open: boolean) {
    this.overlayOpen = open;
    this.clearTimer();
    if (open) this.status('G2: メニューを閉じると最新の内容を表示します');
    else this.invalidate();
  }
  stop() {
    this.stopped = true;
    this.clearTimer();
  }
  invalidate() {
    this.epoch++;
    this.revision++;
    this.sentText.clear();
    this.sentImages.clear();
    this.imagesFailed = false;
    this.kick();
  }
  private scheduleAnimation() {
    this.clearTimer();
    if (
      this.stopped ||
      this.overlayOpen ||
      this.failedStartup ||
      this.imagesFailed ||
      !this.online ||
      !this.bridge.updateImageRawData
    )
      return;
    const elapsed = Date.now() - this.phaseOrigin;
    const delays = (this.scene?.elements || []).flatMap((e) =>
      e.type === 'image' &&
      e.frames.length > 1 &&
      (e.loop || elapsed < e.frameMs * (e.frames.length - 1))
        ? [e.frameMs - (elapsed % e.frameMs)]
        : [],
    );
    if (delays.length)
      this.timer = setTimeout(
        () => this.kick(),
        Math.max(50, Math.min(...delays)),
      );
  }
  private async flush() {
    this.running = true;
    this.clearTimer();
    try {
      let revision: number;
      do {
        revision = this.revision;
        const epoch = this.epoch;
        const hasImages = this.scene?.elements.some((e) => e.type === 'image');
        const elements =
          this.scene &&
          (!hasImages || (this.bridge.updateImageRawData && !this.imagesFailed))
            ? this.scene.elements
            : fallback(this.desired);
        const layoutKey = geometry(elements);
        const elapsed = Date.now() - this.phaseOrigin;
        if (!this.started || this.geometryKey !== layoutKey) {
          const config = sceneContainers(elements);
          if (!this.started) {
            this.failedStartup = true;
            const result = await this.bridge.createStartUpPageContainer(
              new CreateStartUpPageContainer(config),
            );
            if (result !== StartUpPageCreateResult.success)
              throw new Error(`Startup code ${result}; reopen Plugin`);
            this.started = true;
            this.failedStartup = false;
          } else if (
            !(await this.bridge.rebuildPageContainer?.(
              new RebuildPageContainer(config),
            ))
          )
            throw new Error('Page rebuild failed; retrying');
          this.geometryKey = layoutKey;
          this.sentText.clear();
          this.sentImages.clear();
          if (epoch === this.epoch)
            elements.forEach((e, i) => {
              if (e.type === 'text')
                this.sentText.set(i, JSON.stringify([e.text, e.brightness]));
            });
        }
        for (let i = 0; i < elements.length; i++) {
          if (this.stopped || this.overlayOpen || revision !== this.revision)
            break;
          const element = elements[i]!;
          if (element.type === 'text') {
            const key = JSON.stringify([element.text, element.brightness]);
            if (this.sentText.get(i) === key) continue;
            const ok = await this.bridge.textContainerUpgrade(
              new TextContainerUpgrade({
                containerID: i + 1,
                containerName: `e-${i}`,
                content: element.text,
                textColor: element.brightness,
              }),
            );
            if (!ok) throw new Error('Text update failed; retrying');
            if (epoch === this.epoch) this.sentText.set(i, key);
          } else {
            const frame =
              element.frames[frameIndex(element, elapsed, this.online)]!;
            if (this.sentImages.get(i) === frame) continue;
            const result = await this.bridge.updateImageRawData!(
              new ImageRawDataUpdate({
                containerID: i + 1,
                containerName: `e-${i}`,
                imageData: decodeGray4(frame),
              }),
            );
            if (result !== ImageRawDataUpdateResult.success) {
              this.imagesFailed = true;
              throw new Error(
                'Image update failed; falling back to text on next retry',
              );
            }
            if (epoch === this.epoch) this.sentImages.set(i, frame);
          }
        }
        if (!this.stopped && !this.overlayOpen)
          this.status(
            this.imagesFailed
              ? 'G2: テキスト表示中。画像を再開するにはPluginを開き直してください'
              : 'G2: SDK accepted the display update',
          );
      } while (
        !this.stopped &&
        !this.overlayOpen &&
        revision !== this.revision
      );
    } catch (error) {
      if (!this.stopped)
        this.status(
          `G2: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
      this.running = false;
      this.scheduleAnimation();
    }
  }
}
