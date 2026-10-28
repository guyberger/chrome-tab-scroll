import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush, installChromeMock, type ChromeMock, type FakeTab } from './helpers/chrome-mock';
import type { ToOverlayMessage } from '../src/shared/types';

/**
 * Drives the background service worker through the mocked `chrome` event
 * surface, the way the browser would: activate tabs, press the command, then
 * commit or cancel.
 */

const tab = (id: number, windowId: number, active = false): FakeTab => ({
  id,
  windowId,
  active,
  title: `Tab ${id}`,
  url: `https://example.test/${id}`,
});

let chromeMock: ChromeMock;

/** Re-imports the background with a fresh module registry and a fresh mock. */
async function loadBackground(tabs: FakeTab[], focusedWindowId = 1): Promise<void> {
  vi.resetModules();
  chromeMock = installChromeMock(tabs, focusedWindowId);
  await import('../src/background/index');
  await flush();
}

/** Marks tabs as activated in order, oldest first. */
async function activate(...entries: [tabId: number, windowId: number][]): Promise<void> {
  for (const [tabId, windowId] of entries) {
    await chromeMock.tabs.onActivated.dispatch({ tabId, windowId });
  }
}

const sentToTab = (): ToOverlayMessage[] =>
  chromeMock.tabs.sendMessage.mock.calls.map((call) => call[1] as ToOverlayMessage);

const lastShow = (): Extract<ToOverlayMessage, { type: 'SHOW' }> | undefined =>
  sentToTab().filter((m): m is Extract<ToOverlayMessage, { type: 'SHOW' }> => m.type === 'SHOW').at(-1);

/** Delivers a message from an overlay, as `runtime.onMessage` would. */
async function fromOverlay(message: unknown): Promise<void> {
  await chromeMock.runtime.onMessage.dispatch(message, {}, () => {});
  await flush();
}

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
});

describe('opening the strip', () => {
  it('shows recent tabs with the previous one preselected', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1), tab(3, 1)]);
    await activate([2, 1], [3, 1]);

    await chromeMock.commands.onCommand.dispatch('cycle-forward');

    const show = lastShow();
    expect(show?.items.map((i) => i.tabId)).toEqual([3, 2, 1]);
    expect(show?.selectedIndex).toBe(1);
  });

  it('tells the overlay which modifier release should commit', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);

    await chromeMock.commands.onCommand.dispatch('cycle-forward');

    expect(lastShow()?.commitModifiers).toEqual(['Alt']);
  });

  it('follows a rebound shortcut', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    chromeMock.commands.getAll.mockResolvedValue([
      { name: 'cycle-forward', shortcut: 'Ctrl+Period' },
    ]);

    await chromeMock.commands.onCommand.dispatch('cycle-forward');

    expect(lastShow()?.commitModifiers).toEqual(['Control']);
  });

  it('caps the strip at six tabs', async () => {
    const tabs = Array.from({ length: 10 }, (_, i) => tab(i + 1, 1, i === 0));
    await loadBackground(tabs);

    await chromeMock.commands.onCommand.dispatch('cycle-forward');

    expect(lastShow()?.items).toHaveLength(6);
  });

  it('stays shut when there is nothing to switch to', async () => {
    await loadBackground([tab(1, 1, true)]);

    await chromeMock.commands.onCommand.dispatch('cycle-forward');

    expect(lastShow()).toBeUndefined();
  });

  it('only offers tabs from the focused window', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1), tab(3, 2, true), tab(4, 2)], 2);
    await activate([1, 1], [2, 1], [4, 2], [3, 2]);

    await chromeMock.commands.onCommand.dispatch('cycle-forward');

    expect(lastShow()?.items.map((i) => i.tabId)).toEqual([3, 4]);
  });

  it('opens backwards onto the least recent tab', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1), tab(3, 1)]);
    await activate([2, 1], [3, 1]);

    await chromeMock.commands.onCommand.dispatch('cycle-backward');

    // Order is [3, 2, 1]; stepping back from the current tab wraps to the end.
    expect(lastShow()?.selectedIndex).toBe(2);
  });
});

describe('cycling, commit and cancel', () => {
  async function openStrip() {
    await loadBackground([tab(1, 1, true), tab(2, 1), tab(3, 1), tab(4, 1)]);
    await activate([2, 1], [3, 1], [4, 1]); // MRU: 4, 3, 2, 1
    await chromeMock.commands.onCommand.dispatch('cycle-forward');
  }

  it('advances the selection on each further press', async () => {
    await openStrip();

    await chromeMock.commands.onCommand.dispatch('cycle-forward');
    await chromeMock.commands.onCommand.dispatch('cycle-forward');

    const updates = sentToTab().filter((m) => m.type === 'UPDATE');
    expect(updates.map((m) => (m as { selectedIndex: number }).selectedIndex)).toEqual([2, 3]);
  });

  it('does not reopen a session that is already showing', async () => {
    await openStrip();

    await chromeMock.commands.onCommand.dispatch('cycle-forward');

    expect(sentToTab().filter((m) => m.type === 'SHOW')).toHaveLength(1);
  });

  it('switches to the selected tab on commit', async () => {
    await openStrip();

    await fromOverlay({ type: 'COMMIT' });

    expect(chromeMock.tabs.update).toHaveBeenCalledWith(3, { active: true });
    expect(chromeMock.windows.update).toHaveBeenCalledWith(1, { focused: true });
  });

  it('switches to a clicked tab regardless of the current selection', async () => {
    await openStrip();

    await fromOverlay({ type: 'COMMIT', index: 3 });

    expect(chromeMock.tabs.update).toHaveBeenCalledWith(1, { active: true });
  });

  it('commits wherever cycling left the selection', async () => {
    await openStrip();
    await chromeMock.commands.onCommand.dispatch('cycle-forward'); // -> index 2

    await fromOverlay({ type: 'COMMIT' });

    expect(chromeMock.tabs.update).toHaveBeenCalledWith(2, { active: true });
  });

  it('hides the strip after committing', async () => {
    await openStrip();

    await fromOverlay({ type: 'COMMIT' });

    expect(sentToTab().at(-1)).toEqual({ type: 'HIDE' });
  });

  it('switches nothing on cancel', async () => {
    await openStrip();

    await fromOverlay({ type: 'CANCEL' });

    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(sentToTab().at(-1)).toEqual({ type: 'HIDE' });
  });

  it('starts a fresh session after a cancel', async () => {
    await openStrip();
    await fromOverlay({ type: 'CANCEL' });

    await chromeMock.commands.onCommand.dispatch('cycle-forward');

    expect(sentToTab().filter((m) => m.type === 'SHOW')).toHaveLength(2);
    expect(lastShow()?.selectedIndex).toBe(1);
  });

  it('ignores a commit when no strip is open', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);

    await fromOverlay({ type: 'COMMIT' });

    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
  });

  it('drops a tab that closes while the strip is open', async () => {
    await openStrip(); // items [4, 3, 2, 1], selection on 3

    await chromeMock.tabs.onRemoved.dispatch(2, { windowId: 1, isWindowClosing: false });
    await fromOverlay({ type: 'COMMIT' });

    expect(chromeMock.tabs.update).toHaveBeenCalledWith(3, { active: true });
  });

  it('closes the strip when every other tab goes away', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    await activate([2, 1], [1, 1]);
    await chromeMock.commands.onCommand.dispatch('cycle-forward');

    await chromeMock.tabs.onRemoved.dispatch(1, { windowId: 1, isWindowClosing: false });
    await chromeMock.tabs.onRemoved.dispatch(2, { windowId: 1, isWindowClosing: false });

    expect(sentToTab().at(-1)).toEqual({ type: 'HIDE' });
  });
});

describe('pages where a content script cannot run', () => {
  it('falls back to a popup window when the tab refuses the message', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('no receiving end'));
    chromeMock.scripting.executeScript.mockRejectedValue(new Error('cannot access chrome://'));

    await chromeMock.commands.onCommand.dispatch('cycle-forward');

    expect(chromeMock.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'popup', focused: true }),
    );
  });

  it('injects the content script before giving up on the page', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    chromeMock.tabs.sendMessage
      .mockRejectedValueOnce(new Error('no receiving end'))
      .mockResolvedValue(undefined);

    await chromeMock.commands.onCommand.dispatch('cycle-forward');

    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 1 },
      files: ['content.js'],
    });
    expect(chromeMock.windows.create).not.toHaveBeenCalled();
  });

  it('serves session state to the fallback page on request', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    await chromeMock.commands.onCommand.dispatch('cycle-forward');

    const sendResponse = vi.fn();
    await chromeMock.runtime.onMessage.dispatch({ type: 'GET_SESSION' }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SHOW', selectedIndex: 1 }),
    );
  });

  it('closes the popup when the session ends', async () => {
    await loadBackground([tab(1, 1, true), tab(2, 1)]);
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('no receiving end'));
    chromeMock.scripting.executeScript.mockRejectedValue(new Error('cannot access'));
    await chromeMock.commands.onCommand.dispatch('cycle-forward');

    await fromOverlay({ type: 'CANCEL' });

    expect(chromeMock.windows.remove).toHaveBeenCalledWith(99);
  });
});
