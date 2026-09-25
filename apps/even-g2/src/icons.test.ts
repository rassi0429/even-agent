import { afterEach, expect, it, vi } from 'vitest';
import {
  ImageRawDataUpdateResult,
  StartUpPageCreateResult,
  validateEvenHubPageContainer,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import {
  sceneSchema,
  frameIndex,
  type ImageElement,
} from '@even-agent/protocol';
import { G2Renderer, sceneContainers } from './renderer.js';
const image = {
  type: 'image' as const,
  id: 'arbitrary-image',
  x: 50,
  y: 20,
  width: 20,
  height: 20,
  frames: ['0'.repeat(400), 'f'.repeat(400)],
  frameMs: 500,
  loop: true,
};
const scene = sceneSchema.parse({
  elements: [
    {
      type: 'text',
      id: 'title',
      x: 80,
      y: 20,
      width: 300,
      height: 32,
      text: 'Any application',
    },
    image,
  ],
});
afterEach(() => vi.useRealTimers());
function mockBridge() {
  return {
    createStartUpPageContainer: vi.fn<
      EvenAppBridge['createStartUpPageContainer']
    >(async () => StartUpPageCreateResult.success),
    rebuildPageContainer: vi.fn<EvenAppBridge['rebuildPageContainer']>(
      async () => true,
    ),
    textContainerUpgrade: vi.fn<EvenAppBridge['textContainerUpgrade']>(
      async () => true,
    ),
    updateImageRawData: vi.fn<EvenAppBridge['updateImageRawData']>(
      async () => ImageRawDataUpdateResult.success,
    ),
  };
}
it('animates arbitrary server frames without resending text, and stops offline, in menus and on exit', async () => {
  vi.useFakeTimers();
  const bridge = mockBridge();
  const renderer = new G2Renderer(bridge, vi.fn());
  renderer.show('fallback', scene);
  await vi.advanceTimersByTimeAsync(0);
  expect(
    validateEvenHubPageContainer(
      bridge.createStartUpPageContainer.mock.calls[0]![0],
    ).valid,
  ).toBe(true);
  expect(bridge.updateImageRawData).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(bridge.updateImageRawData).toHaveBeenCalledTimes(3);
  expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
  expect(bridge.rebuildPageContainer).not.toHaveBeenCalled();
  renderer.show('OFFLINE', scene, false);
  await vi.advanceTimersByTimeAsync(0);
  const count = bridge.updateImageRawData.mock.calls.length;
  await vi.advanceTimersByTimeAsync(3000);
  expect(bridge.updateImageRawData).toHaveBeenCalledTimes(count);
  renderer.show('online', scene);
  await vi.advanceTimersByTimeAsync(0);
  renderer.setOverlayOpen(true);
  const paused = bridge.updateImageRawData.mock.calls.length;
  await vi.advanceTimersByTimeAsync(2000);
  expect(bridge.updateImageRawData).toHaveBeenCalledTimes(paused);
  renderer.setOverlayOpen(false);
  await vi.advanceTimersByTimeAsync(500);
  expect(bridge.updateImageRawData.mock.calls.length).toBeGreaterThan(paused);
  renderer.stop();
  const stopped = bridge.updateImageRawData.mock.calls.length;
  await vi.advanceTimersByTimeAsync(2000);
  expect(bridge.updateImageRawData).toHaveBeenCalledTimes(stopped);
});
it('serializes slow images, coalesces page updates, and rebuilds when geometry changes', async () => {
  vi.useFakeTimers();
  const bridge = mockBridge();
  let finish!: (v: ImageRawDataUpdateResult) => void;
  bridge.updateImageRawData.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const renderer = new G2Renderer(bridge, vi.fn());
  renderer.show('first', scene);
  await vi.advanceTimersByTimeAsync(0);
  const latest = sceneSchema.parse({
    elements: [{ ...image, x: 200, frames: ['a'.repeat(400)] }],
  });
  renderer.show('latest', latest);
  await vi.advanceTimersByTimeAsync(2000);
  expect(bridge.updateImageRawData).toHaveBeenCalledTimes(1);
  finish(ImageRawDataUpdateResult.success);
  await vi.advanceTimersByTimeAsync(0);
  expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(1);
  expect(bridge.updateImageRawData.mock.calls.at(-1)![0].imageData).toEqual(
    new Uint8Array(200).fill(0xaa),
  );
  renderer.show('plain text');
  await vi.advanceTimersByTimeAsync(0);
  expect(bridge.rebuildPageContainer.mock.calls.at(-1)![0].imageObject).toEqual(
    [],
  );
  expect(bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
  renderer.stop();
});
it('falls back to readable text after image failure without endless image retries', async () => {
  vi.useFakeTimers();
  const bridge = mockBridge();
  bridge.updateImageRawData.mockResolvedValueOnce(
    ImageRawDataUpdateResult.sendFailed,
  );
  const renderer = new G2Renderer(bridge, vi.fn());
  renderer.show('readable alternative', scene);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(3000);
  expect(bridge.updateImageRawData).toHaveBeenCalledTimes(1);
  renderer.show('readable alternative', scene);
  await vi.advanceTimersByTimeAsync(0);
  expect(bridge.rebuildPageContainer).toHaveBeenCalledWith(
    expect.objectContaining({
      containerTotalNum: 1,
      textObject: [
        expect.objectContaining({ content: 'readable alternative' }),
      ],
    }),
  );
  renderer.stop();
});
it('supports independent timing, one-shot animations, and image-only full-screen tiling', async () => {
  expect(frameIndex({ ...image, frameMs: 250 } as ImageElement, 750)).toBe(1);
  expect(frameIndex({ ...image, loop: false } as ImageElement, 100000)).toBe(1);
  const tiles = sceneSchema.parse({
    elements: Array.from({ length: 4 }, (_, i) => ({
      ...image,
      id: `tile${i}`,
      x: (i % 2) * 288,
      y: Math.floor(i / 2) * 144,
      width: 288,
      height: 144,
      frames: ['f'.repeat(288 * 144)],
    })),
  });
  const config = sceneContainers(tiles.elements);
  expect(config.textObject).toHaveLength(1);
  expect(config.textObject[0]?.isEventCapture).toBe(1);
  expect(config.imageObject).toHaveLength(4);
  expect(validateEvenHubPageContainer(config).valid).toBe(true);
  vi.useFakeTimers();
  const bridge = mockBridge();
  const renderer = new G2Renderer(bridge, vi.fn());
  renderer.show(
    'once',
    sceneSchema.parse({ elements: [{ ...image, loop: false }] }),
  );
  await vi.advanceTimersByTimeAsync(5000);
  expect(bridge.updateImageRawData).toHaveBeenCalledTimes(2);
  renderer.stop();
});
