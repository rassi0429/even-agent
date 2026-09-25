import { expect, it, vi } from 'vitest';
import { emptyState } from '@even-agent/protocol';
import {
  OsEventTypeList,
  StartUpPageCreateResult,
  Sys_ItemEvent,
  Text_ItemEvent,
  type TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk';
import { pagesFor, composeDisplay } from '../../dashboard/src/display.js';
import { inputAction } from './input.js';
import { G2Renderer } from './renderer.js';

it('paginates all items and keeps multilingual long text within startup limits', () => {
  const state = emptyState();
  for (let index = 0; index < 10; index++) {
    state.now.push({
      id: String(index),
      title: `${index} ${'日本語'.repeat(60)}`,
      description: 'x'.repeat(1000),
      priority: 'high',
      section: 'now',
      source: 'test',
      createdAt: 0,
    });
  }
  expect(pagesFor(state)).toHaveLength(10);
  const display = composeDisplay(state);
  expect(display.pages[9]?.content).toContain('! 9');
  for (let index = 0; index < 10; index++)
    expect(
      new TextEncoder().encode(display.pages[index]!.content).length,
    ).toBeLessThan(1000);
  expect(display.pages[9]?.offlineContent).toContain('OFFLINE  10/10');
});
it('handles protobuf omitted click values without interpreting scroll or audio as taps', () => {
  expect(inputAction({ sysEvent: new Sys_ItemEvent() })).toBe('next');
  expect(inputAction({})).toBeNull();
  expect(
    inputAction({
      textEvent: new Text_ItemEvent({
        eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT,
      }),
    }),
  ).toBeNull();
  expect(
    inputAction({
      sysEvent: new Sys_ItemEvent(),
      textEvent: new Text_ItemEvent({
        eventType: OsEventTypeList.DOUBLE_CLICK_EVENT,
      }),
    }),
  ).toBe('exit');
  expect(
    inputAction({
      sysEvent: new Sys_ItemEvent({
        eventType: OsEventTypeList.SYSTEM_EXIT_EVENT,
      }),
    }),
  ).toBe('stop');
});
it('treats foreground enter/exit as overlay open/close, not app suspension', () => {
  expect(
    inputAction({
      sysEvent: new Sys_ItemEvent({
        eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT,
      }),
    }),
  ).toBe('overlay-open');
  expect(
    inputAction({
      sysEvent: new Sys_ItemEvent({
        eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT,
      }),
    }),
  ).toBe('overlay-close');
});
it('sends the latest queued state when the system menu closes and continues live updates', async () => {
  const bridge = {
    createStartUpPageContainer: vi.fn(
      async () => StartUpPageCreateResult.success,
    ),
    textContainerUpgrade: vi.fn<
      (input: TextContainerUpgrade) => Promise<boolean>
    >(async () => true),
  };
  const status = vi.fn();
  const renderer = new G2Renderer(bridge, status);
  renderer.show('Hello G2');
  await vi.waitFor(() =>
    expect(status).toHaveBeenCalledWith('G2: SDK accepted the display update'),
  );
  renderer.setOverlayOpen(true);
  renderer.show('intermediate');
  renderer.show('Live update OK');
  expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
  renderer.setOverlayOpen(false);
  await vi.waitFor(() =>
    expect(bridge.textContainerUpgrade).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Live update OK' }),
    ),
  );
  renderer.show('another notification');
  await vi.waitFor(() =>
    expect(bridge.textContainerUpgrade).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'another notification' }),
    ),
  );
  expect(bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
});
it('creates once, serializes slow SDK writes, and coalesces to the latest state', async () => {
  let finish!: (value: StartUpPageCreateResult) => void;
  const bridge = {
    createStartUpPageContainer: vi.fn(
      () =>
        new Promise<StartUpPageCreateResult>((resolve) => {
          finish = resolve;
        }),
    ),
    textContainerUpgrade: vi.fn<
      (input: TextContainerUpgrade) => Promise<boolean>
    >(async () => true),
  };
  const renderer = new G2Renderer(bridge, vi.fn());
  renderer.show('first');
  renderer.show('second');
  renderer.show('latest');
  expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
  finish(StartUpPageCreateResult.success);
  await vi.waitFor(() =>
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1),
  );
  expect(bridge.textContainerUpgrade.mock.calls[0]?.[0]).toMatchObject({
    content: 'latest',
  });
  renderer.show('latest');
  expect(bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
  expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1);
  renderer.stop();
  renderer.show('after exit');
  expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1);
});
it('reports startup rejection and never retries one-shot creation', async () => {
  const bridge = {
    createStartUpPageContainer: vi.fn(
      async () => StartUpPageCreateResult.invalid,
    ),
    textContainerUpgrade: vi.fn(async () => true),
  };
  const status = vi.fn();
  const renderer = new G2Renderer(bridge, status);
  renderer.show('test');
  await vi.waitFor(() =>
    expect(status).toHaveBeenCalledWith(
      expect.stringContaining('Startup code 1'),
    ),
  );
  renderer.show('retry');
  expect(bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
});
