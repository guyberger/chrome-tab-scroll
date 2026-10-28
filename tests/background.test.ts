import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush, installChromeMock, type ChromeMock, type FakeTab } from './helpers/chrome-mock';
import type { ToOverlayMessage } from '../src/shared/types';

/**
 * Drives the background service worker through the mocked `chrome` event
 * surface, the way the browser would.
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
    const target = chromeMock._tabs.find((t) => t.id === tabId);
    for (const t of chromeMock._tabs) if (t.windowId === windowId) t.active = t === target;
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
const pressBack = () => chromeMock.commands.onCommand.dispatch('cycle-backward');

interface LoggedEntry {
  event: string;
  data?: Record<string, unknown>;
}

/** The log flushes on a debounce, so let it land before reading. */
async function logEntries(): Promise<LoggedEntry[]> {
  await vi.advanceTimersByTimeAsync(150);
  await flush();
  return (chromeMock.storage.local._data['debug:log'] as LoggedEntry[]) ?? [];
}

const logEvents = async (): Promise<string[]> => (await logEntries()).map((e) => e.event);

beforeEach(() => {
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

  // Tabs that predate the extension have no activation history, so the seed
  // order is all there is. Using tab-strip order made "the previous tab" the
  // leftmost tab until the user had switched around a few times.
  it('seeds pre-existing tabs in last-accessed order, not tab-strip order', async () => {
    await loadBackground([
      { ...tab(1, 1), lastAccessed: 1000 },
      { ...tab(2, 1), lastAccessed: 3000 },
      { ...tab(3, 1, true), lastAccessed: 5000 },
      { ...tab(4, 1), lastAccessed: 2000 },
    ]);

    await press();

    expect(lastShow()?.items.map((i) => i.tabId)).toEqual([3, 2, 4, 1]);
    // Index 1 is what a press-and-release lands on: the genuinely previous tab.
    expect(lastShow()?.selectedIndex).toBe(1);
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

  it('never lets its own pages into the recent tabs', async () => {
    await loadBackground([
      tab(1, 1, true),
      tab(2, 1),
      tab(90, 1, false, 'chrome-extension://fake/src/setup/index.html'),
    ]);

    await press();

    expect(lastShow()?.items.map((i) => i.tabId)).not.toContain(90);
  });
});

describe('routing to the in-page overlay', () => {
  it('uses the overlay on an ordinary page', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1), tab(3, 1)]);

    await press();

    expect(lastShow()).toBeDefined();
    expect(chromeMock.windows.create).not.toHaveBeenCalled();
    expect(await logEvents()).toContain('route:overlay');
  });

  // The scenario under suspicion: a tab that was already open when the
  // extension loaded has no content script at all.
  it('injects on demand for a tab that predates the extension, then shows', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    chromeMock.tabs.sendMessage
      .mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'))
      .mockResolvedValue(undefined);

    await press();
    await vi.advanceTimersByTimeAsync(200);
    await flush();

    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 1 },
      files: ['content.js'],
    });
    expect(shows().length).toBeGreaterThan(0);
    expect(chromeMock.windows.create).not.toHaveBeenCalled();
    expect(await logEvents()).toEqual(expect.arrayContaining(['show:no-listener', 'inject:ok', 'show:ready']));
  });

  it('keeps retrying while a slow content script loads', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    let attempts = 0;
    chromeMock.tabs.sendMessage.mockImplementation(async () => {
      attempts += 1;
      if (attempts < 25) throw new Error('Receiving end does not exist.');
      return undefined;
    });

    await press();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    expect(shows().length).toBeGreaterThan(0);
    expect(chromeMock.windows.create).not.toHaveBeenCalled();
  });

  // Opening a window on top of an ordinary page is worse than doing nothing,
  // so an injectable page never falls back however badly it goes.
  it('never opens the popup for an http(s) page, even when the overlay fails', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist.'));

    await press();
    await vi.advanceTimersByTimeAsync(4000);
    await flush();

    expect(chromeMock.windows.create).not.toHaveBeenCalled();
    expect(await logEvents()).toContain('route:none');
  });

  it('records the exact failure when injection is refused', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist.'));
    chromeMock.scripting.executeScript.mockRejectedValue(
      new Error('Cannot access contents of the page.'),
    );

    await press();
    await flush();

    const failure = (await logEntries()).find((e) => e.event === 'inject:failed');
    expect(failure?.data?.error).toContain('Cannot access contents of the page');
  });

  // A stale or missing cached URL used to classify as restricted and route a
  // perfectly ordinary page to the popup.
  it('tries the overlay first when the URL is unknown', async () => {
    await loadBackground([tab(1, 1, true, ''), tab(2, 1)]);

    await press();

    expect(chromeMock.tabs.sendMessage).toHaveBeenCalled();
    expect(chromeMock.windows.create).not.toHaveBeenCalled();
  });

  it('asks Chrome which tab is active rather than trusting cached order', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    chromeMock.tabs.query.mockClear();

    await press();

    expect(chromeMock.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
  });
});

describe('the fallback window', () => {
  it('is used only where Chrome forbids content scripts', async () => {
    await loadBackground([tab(1, 1, true, 'chrome://settings/appearance'), tab(2, 1)]);

    await press();

    expect(chromeMock.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'popup', focused: true }),
    );
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(await logEvents()).toContain('route:popup');
  });

  it('is centred on the browser window', async () => {
    await loadBackground([tab(1, 1, true, 'chrome://settings'), tab(2, 1)]);

    await press();

    // Browser window is 1200x800 at (100,50); popup is 820x240.
    expect(chromeMock.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ left: 290, top: 330, width: 820, height: 240 }),
    );
  });

  it('is centred on a monitor left of the primary', async () => {
    await loadBackground([tab(1, 1, true, 'chrome://settings'), tab(2, 1)]);
    chromeMock.windows.getLastFocused.mockResolvedValue({
      id: 1,
      left: -1920,
      top: 0,
      width: 1920,
      height: 1080,
    });

    await press();

    expect(chromeMock.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ left: -1370, top: 420 }),
    );
  });

  it('serves session state and thumbnails to the fallback page on request', async () => {
    await loadBackground([tab(1, 1, true, 'chrome://settings'), tab(2, 1)]);
    chromeMock.storage.session._data['thumb:2'] = 'BASE64DATA';
    await press();
    chromeMock.runtime.sendMessage.mockClear();

    const sendResponse = vi.fn();
    await chromeMock.runtime.onMessage.dispatch({ type: 'GET_SESSION' }, {}, sendResponse);
    await flush();

    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SHOW', selectedIndex: 1 }),
    );
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

describe('opening the strip', () => {
  it('shows recent tabs with the previous one preselected', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1), tab(3, 1)]);
    await activate([2, 1], [3, 1]);

    await press();

    expect(lastShow()?.items.map((i) => i.tabId)).toEqual([3, 2, 1]);
    expect(lastShow()?.selectedIndex).toBe(1);
  });

  it('opens backwards onto the least recent tab', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1), tab(3, 1)]);
    await activate([2, 1], [3, 1]);

    await pressBack();

    expect(lastShow()?.selectedIndex).toBe(2);
  });

  it('sends no thumbnails in the first message, so the strip can paint', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);

    await press();

    expect(JSON.stringify(lastShow())).not.toContain('thumbnail');
  });

  it('follows up with thumbnails once the strip is up', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    chromeMock.storage.session._data['thumb:2'] = 'BASE64DATA';

    await press();

    const thumbs = sentToTab().find((m) => m.type === 'THUMBS');
    expect(thumbs).toMatchObject({ thumbs: { 2: 'BASE64DATA' }, mime: 'image/webp' });
    expect(sentToTab().indexOf(thumbs!)).toBeGreaterThan(sentToTab().indexOf(lastShow()!));
  });

  it('tells the overlay which modifier release should commit', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);

    await press();

    expect(lastShow()?.commitModifiers).toEqual(['Alt']);
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
    expect(await logEvents()).toContain('open:too-few-tabs');
  });

  it('only offers tabs from the focused window', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1), tab(3, 2, true), tab(4, 2)], 2);
    await activate([1, 1], [2, 1], [4, 2], [3, 2]);

    await press();

    expect(lastShow()?.items.map((i) => i.tabId)).toEqual([3, 4]);
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

  const selections = () =>
    sentToTab()
      .filter((m) => m.type === 'UPDATE')
      .map((m) => (m as { selectedIndex: number }).selectedIndex);

  it('advances the selection on a further press of the command', async () => {
    await open();

    await press();
    await vi.advanceTimersByTimeAsync(60);
    await press();

    expect(selections()).toEqual([2, 3]);
  });

  it('moves backward on the backward command', async () => {
    await open();

    await pressBack();

    expect(selections()).toEqual([0]);
  });

  it('advances when the overlay reports the keypress itself', async () => {
    const epoch = await open();

    await fromOverlay({ type: 'STEP', epoch, delta: 1 });

    expect(selections()).toEqual([2]);
  });

  // Chrome delivers either the command or the page keydown, not both; this
  // only matters if that ever changes.
  it('collapses the same step arriving twice at once', async () => {
    const epoch = await open();

    await press();
    await fromOverlay({ type: 'STEP', epoch, delta: 1 });

    expect(selections()).toEqual([2]);
    expect(await logEvents()).toContain('step:deduped');
  });

  it('does not collapse deliberate repeats', async () => {
    const epoch = await open();

    await fromOverlay({ type: 'STEP', epoch, delta: 1 });
    await vi.advanceTimersByTimeAsync(80);
    await fromOverlay({ type: 'STEP', epoch, delta: 1 });

    expect(selections()).toEqual([2, 3]);
  });

  it('switches to the tab the overlay reports', async () => {
    const epoch = await open();

    await fromOverlay({ type: 'COMMIT', epoch, tabId: 3 });

    expect(chromeMock.tabs.update).toHaveBeenCalledWith(3, { active: true });
    expect(chromeMock.windows.update).toHaveBeenCalledWith(1, { focused: true });
  });

  it('commits the highlighted tile, not its neighbour, after stepping', async () => {
    const epoch = await open(); // items [4,3,2,1], selection on 3
    await fromOverlay({ type: 'STEP', epoch, delta: 1 }); // -> index 2, tab 2

    const highlighted = lastShow()!.items[2]!.tabId;
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

    expect(selections()).toHaveLength(0);
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
  });

  it('hides the strip after committing', async () => {
    const epoch = await open();

    await fromOverlay({ type: 'COMMIT', epoch, tabId: 3 });

    expect(sentToTab().at(-1)).toMatchObject({ type: 'HIDE' });
  });

  it('still commits the right tab when another closes mid-session', async () => {
    const epoch = await open();

    await chromeMock.tabs.onRemoved.dispatch(2, { windowId: 1, isWindowClosing: false });
    await fromOverlay({ type: 'COMMIT', epoch, tabId: 3 });

    expect(chromeMock.tabs.update).toHaveBeenCalledWith(3, { active: true });
  });
});

describe('first-run shortcut setup', () => {
  it('opens the shortcuts page on install when nothing is bound', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    chromeMock.commands.getAll.mockResolvedValue([{ name: 'open-switcher', shortcut: '' }]);

    await chromeMock.runtime.onInstalled.dispatch({ reason: 'install' });

    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: 'chrome://extensions/shortcuts',
    });
    expect(await logEvents()).toContain('install:shortcut-unbound');
  });

  it('leaves the user alone when a shortcut is already bound', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    chromeMock.commands.getAll.mockResolvedValue([
      { name: 'open-switcher', shortcut: 'Alt+Q' },
    ]);

    await chromeMock.runtime.onInstalled.dispatch({ reason: 'install' });

    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('does not reopen the page on an update', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    chromeMock.commands.getAll.mockResolvedValue([{ name: 'open-switcher', shortcut: '' }]);

    await chromeMock.runtime.onInstalled.dispatch({ reason: 'update' });

    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('puts the content script into existing tabs at install', async () => {
    await loadBackground([
      tab(1, 1, true),
      tab(2, 1),
      tab(3, 1, false, 'chrome://settings'),
    ]);

    await chromeMock.runtime.onInstalled.dispatch({ reason: 'install' });
    await flush();

    const injected = chromeMock.scripting.executeScript.mock.calls.map((c) => c[0].target.tabId);
    expect(injected).toContain(1);
    expect(injected).toContain(2);
    // No point trying a page Chrome forbids.
    expect(injected).not.toContain(3);
  });
});
