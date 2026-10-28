import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush, installChromeMock, type ChromeMock, type FakeTab } from './helpers/chrome-mock';
import type { ToOverlayMessage } from '../src/shared/types';

/**
 * Drives the background service worker through the mocked `chrome` event
 * surface, the way the browser would: activate tabs, press the hotkey, step
 * with Tab, then release to commit.
 */

const tab = (id: number, windowId: number, active = false, url?: string): FakeTab => ({
  id,
  windowId,
  active,
  title: `Tab ${id}`,
  url: url ?? `https://example.test/${id}`,
});

let chromeMock: ChromeMock;

async function loadBackground(tabs: FakeTab[], focusedWindowId = 1): Promise<void> {
  vi.resetModules();
  chromeMock = installChromeMock(tabs, focusedWindowId);
  await import('../src/background/index');
  await flush();
}

async function activate(...entries: [tabId: number, windowId: number][]): Promise<void> {
  for (const [tabId, windowId] of entries) {
    await chromeMock.tabs.onActivated.dispatch({ tabId, windowId });
  }
}

const sentToTab = (): ToOverlayMessage[] =>
  chromeMock.tabs.sendMessage.mock.calls.map((call) => call[1] as ToOverlayMessage);

const shows = () =>
  sentToTab().filter((m): m is Extract<ToOverlayMessage, { type: 'SHOW' }> => m.type === 'SHOW');

const lastShow = () => shows().at(-1);

async function fromOverlay(message: unknown): Promise<void> {
  await chromeMock.runtime.onMessage.dispatch(message, {}, () => {});
  await flush();
}

const press = () => chromeMock.commands.onCommand.dispatch('open-switcher');

beforeEach(() => {
  // Thumbnail capture is debounced; freezing time keeps it out of these tests.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MRU tracking through browser events', () => {
  it('records activations and persists them', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1), tab(3, 1)]);

    await activate([2, 1], [3, 1]);

    expect(chromeMock.storage.session._data['mru:order']).toEqual([
      { tabId: 3, windowId: 1 },
      { tabId: 2, windowId: 1 },
      { tabId: 1, windowId: 1 },
    ]);
  });

  it('forgets a tab once it is closed', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1), tab(3, 1)]);
    await activate([2, 1], [3, 1]);

    await chromeMock.tabs.onRemoved.dispatch(3, { windowId: 1, isWindowClosing: false });

    expect(chromeMock.storage.session._data['mru:order']).toEqual([
      { tabId: 2, windowId: 1 },
      { tabId: 1, windowId: 1 },
    ]);
  });

  it('forgets every tab of a closed window', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 2)]);
    await activate([2, 2]);

    await chromeMock.windows.onRemoved.dispatch(2);

    expect(chromeMock.storage.session._data['mru:order']).toEqual([{ tabId: 1, windowId: 1 }]);
  });

  it('promotes the active tab when a window takes focus', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 2, true)]);

    await chromeMock.windows.onFocusChanged.dispatch(2);

    expect(chromeMock.storage.session._data['mru:order']).toEqual([
      { tabId: 2, windowId: 2 },
      { tabId: 1, windowId: 1 },
    ]);
  });

  it('ignores focus moving away from Chrome entirely', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    const before = chromeMock.storage.session._data['mru:order'];

    await chromeMock.windows.onFocusChanged.dispatch(chromeMock.windows.WINDOW_ID_NONE);

    expect(chromeMock.storage.session._data['mru:order']).toEqual(before);
  });

  it('never lets its own fallback window into the recent tabs', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    chromeMock._tabs.push({
      id: 90,
      windowId: 99,
      active: true,
      title: 'Switch tab',
      url: 'chrome-extension://fake/src/fallback/index.html',
    });

    await chromeMock.windows.onFocusChanged.dispatch(99);

    const order = chromeMock.storage.session._data['mru:order'] as { tabId: number }[];
    expect(order.map((e) => e.tabId)).not.toContain(90);
  });
});

describe('opening the strip', () => {
  it('shows recent tabs with the previous one preselected', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1), tab(3, 1)]);
    await activate([2, 1], [3, 1]);

    await press();

    const show = lastShow();
    expect(show?.items.map((i) => i.tabId)).toEqual([3, 2, 1]);
    expect(show?.selectedIndex).toBe(1);
  });

  it('sends no thumbnails in the first message, so the strip can paint', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);

    await press();

    const show = lastShow()!;
    expect(show.items.every((i) => !('thumbnail' in i))).toBe(true);
    expect(JSON.stringify(show).length).toBeLessThan(1000);
  });

  it('follows up with thumbnails once the strip is up', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    chromeMock.storage.session._data['thumb:2'] = 'BASE64DATA';

    await press();

    const thumbs = sentToTab().find((m) => m.type === 'THUMBS');
    expect(thumbs).toMatchObject({ thumbs: { 2: 'BASE64DATA' }, mime: 'image/webp' });
    // Order matters: paint first, decorate second.
    expect(sentToTab().indexOf(thumbs!)).toBeGreaterThan(sentToTab().indexOf(lastShow()!));
  });

  it('tells the overlay which modifier release should commit', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);

    await press();

    expect(lastShow()?.commitModifiers).toEqual(['Alt']);
  });

  it('follows a rebound shortcut', async () => {
    chromeMock = installChromeMock([tab(1, 1, true), tab(2, 1)]);
    chromeMock.commands.getAll.mockResolvedValue([
      { name: 'open-switcher', shortcut: 'Ctrl+Period' },
    ]);
    vi.resetModules();
    (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
    await import('../src/background/index');
    await flush();

    await press();

    expect(lastShow()?.commitModifiers).toEqual(['Control']);
  });

  it('caps the strip at six tabs', async () => {
    await loadBackground(Array.from({ length: 10 }, (_, i) => tab(i + 1, 1, i === 0)));

    await press();

    expect(lastShow()?.items).toHaveLength(6);
  });

  it('stays shut when there is nothing to switch to', async () => {
    await loadBackground([tab(1, 1, true)]);

    await press();

    expect(lastShow()).toBeUndefined();
  });

  it('only offers tabs from the focused window', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1), tab(3, 2, true), tab(4, 2)], 2);
    await activate([1, 1], [2, 1], [4, 2], [3, 2]);

    await press();

    expect(lastShow()?.items.map((i) => i.tabId)).toEqual([3, 4]);
  });

  it('is a no-op while the strip is already open', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1), tab(3, 1)]);
    await press();

    await press();

    expect(shows()).toHaveLength(1);
    expect(lastShow()?.selectedIndex).toBe(1);
  });

  it('gives each session a fresh epoch', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    await press();
    const first = lastShow()!.epoch;
    await fromOverlay({ type: 'COMMIT', epoch: first, tabId: 2 });

    await press();

    expect(lastShow()!.epoch).toBeGreaterThan(first);
  });
});

describe('stepping and committing', () => {
  async function open() {
    await loadBackground([tab(1, 1, true), tab(2, 1), tab(3, 1), tab(4, 1)]);
    await activate([2, 1], [3, 1], [4, 1]); // MRU: 4, 3, 2, 1
    await press();
    return lastShow()!.epoch;
  }

  it('advances the selection on Tab', async () => {
    const epoch = await open();

    await fromOverlay({ type: 'STEP', epoch, delta: 1 });
    await fromOverlay({ type: 'STEP', epoch, delta: 1 });

    const updates = sentToTab().filter((m) => m.type === 'UPDATE');
    expect(updates.map((m) => (m as { selectedIndex: number }).selectedIndex)).toEqual([2, 3]);
  });

  it('moves backward on Shift+Tab', async () => {
    const epoch = await open();

    await fromOverlay({ type: 'STEP', epoch, delta: -1 });

    expect(sentToTab().filter((m) => m.type === 'UPDATE').at(-1)).toMatchObject({
      selectedIndex: 0,
    });
  });

  it('switches to the tab the overlay reports', async () => {
    const epoch = await open();

    await fromOverlay({ type: 'COMMIT', epoch, tabId: 3 });

    expect(chromeMock.tabs.update).toHaveBeenCalledWith(3, { active: true });
    expect(chromeMock.windows.update).toHaveBeenCalledWith(1, { focused: true });
  });

  // The reported bug: the committed tab was a neighbour of the highlighted
  // one. Commit carries a tab id, so the index can no longer drift.
  it('commits the highlighted tile, not its neighbour, after stepping', async () => {
    const epoch = await open(); // items [4,3,2,1], selection on 3
    await fromOverlay({ type: 'STEP', epoch, delta: 1 }); // -> index 2, tab 2

    const show = lastShow()!;
    const highlighted = show.items[2]!.tabId;
    await fromOverlay({ type: 'COMMIT', epoch, tabId: highlighted });

    expect(highlighted).toBe(2);
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(2, { active: true });
    expect(chromeMock.tabs.update).toHaveBeenCalledTimes(1);
  });

  it('refuses a commit for a tab outside the session', async () => {
    const epoch = await open();

    await fromOverlay({ type: 'COMMIT', epoch, tabId: 999 });

    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
  });

  it('ignores messages from a stale session', async () => {
    const epoch = await open();

    await fromOverlay({ type: 'STEP', epoch: epoch - 1, delta: 1 });
    await fromOverlay({ type: 'COMMIT', epoch: epoch - 1, tabId: 1 });

    expect(sentToTab().filter((m) => m.type === 'UPDATE')).toHaveLength(0);
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
  });

  it('hides the strip after committing', async () => {
    const epoch = await open();

    await fromOverlay({ type: 'COMMIT', epoch, tabId: 3 });

    expect(sentToTab().at(-1)).toMatchObject({ type: 'HIDE' });
  });

  it('ignores a commit when no strip is open', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);

    await fromOverlay({ type: 'COMMIT', epoch: 1, tabId: 2 });

    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
  });

  it('still commits the right tab when another closes mid-session', async () => {
    const epoch = await open(); // items [4,3,2,1], selection index 1 = tab 3

    await chromeMock.tabs.onRemoved.dispatch(2, { windowId: 1, isWindowClosing: false });
    await fromOverlay({ type: 'COMMIT', epoch, tabId: 3 });

    expect(chromeMock.tabs.update).toHaveBeenCalledWith(3, { active: true });
  });

  it('closes the strip when every other tab goes away', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    await activate([2, 1], [1, 1]);
    await press();

    await chromeMock.tabs.onRemoved.dispatch(1, { windowId: 1, isWindowClosing: false });
    await chromeMock.tabs.onRemoved.dispatch(2, { windowId: 1, isWindowClosing: false });

    expect(sentToTab().at(-1)).toMatchObject({ type: 'HIDE' });
  });
});

describe('choosing the in-page overlay or the fallback window', () => {
  it('retries a tab whose content script is still loading instead of falling back', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    // The bundler loads the content script via a dynamic import, so the first
    // few sends can land before the listener exists.
    chromeMock.tabs.sendMessage
      .mockRejectedValueOnce(new Error('Receiving end does not exist'))
      .mockRejectedValueOnce(new Error('Receiving end does not exist'))
      .mockResolvedValue(undefined);

    await press();
    await vi.advanceTimersByTimeAsync(300);
    await flush();

    expect(shows().length).toBeGreaterThan(0);
    expect(chromeMock.windows.create).not.toHaveBeenCalled();
  });

  it('injects the content script before retrying', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    chromeMock.tabs.sendMessage
      .mockRejectedValueOnce(new Error('Receiving end does not exist'))
      .mockResolvedValue(undefined);

    await press();
    await vi.advanceTimersByTimeAsync(100);
    await flush();

    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 1 },
      files: ['content.js'],
    });
    expect(chromeMock.windows.create).not.toHaveBeenCalled();
  });

  it('uses the fallback window only where Chrome forbids content scripts', async () => {
    await loadBackground([
      tab(1, 1, true, 'chrome://settings/appearance'),
      tab(2, 1),
    ]);

    await press();

    expect(chromeMock.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'popup', focused: true }),
    );
    // No pointless injection attempt on a page that cannot accept one.
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('serves session state to the fallback page on request', async () => {
    await loadBackground([tab(1, 1, true, 'chrome://settings'), tab(2, 1)]);
    await press();

    const sendResponse = vi.fn();
    await chromeMock.runtime.onMessage.dispatch({ type: 'GET_SESSION' }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SHOW', selectedIndex: 1 }),
    );
  });

  it('sends thumbnails to the fallback page, which loads too late to catch the push', async () => {
    await loadBackground([tab(1, 1, true, 'chrome://settings'), tab(2, 1)]);
    chromeMock.storage.session._data['thumb:2'] = 'BASE64DATA';
    await press();
    chromeMock.runtime.sendMessage.mockClear();

    await chromeMock.runtime.onMessage.dispatch({ type: 'GET_SESSION' }, {}, vi.fn());
    await flush();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'THUMBS', thumbs: { 2: 'BASE64DATA' } }),
    );
  });

  it('closes the popup when the session ends', async () => {
    await loadBackground([tab(1, 1, true, 'chrome://settings'), tab(2, 1)]);
    await press();
    const sendResponse = vi.fn();
    await chromeMock.runtime.onMessage.dispatch({ type: 'GET_SESSION' }, {}, sendResponse);
    const epoch = sendResponse.mock.calls[0]![0].epoch;

    await fromOverlay({ type: 'COMMIT', epoch, tabId: 2 });

    expect(chromeMock.windows.remove).toHaveBeenCalledWith(99);
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(2, { active: true });
  });
});
