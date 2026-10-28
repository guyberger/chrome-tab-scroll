import { MruTracker } from './mru';
import { TabIndex } from './tab-index';
import { openSession, removeItem, resolveCommit, stepSelection } from './session';
import { parseShortcutModifiers } from './shortcut';
import * as thumbnails from './thumbnails';
import { canRunContentScript } from '../shared/restricted';
import { MAX_ITEMS } from '../shared/types';
import type { FromOverlayMessage, SessionState, SwitcherItem, ToOverlayMessage } from '../shared/types';

const MRU_KEY = 'mru:order';
const TABS_KEY = 'mru:tabs';
const FALLBACK_PAGE = 'src/fallback/index.html';

export const CMD_OPEN = 'open-switcher';

/** How long to keep retrying a tab that should accept the overlay.
 *  The bundler loads the content script through a dynamic import, so a tab
 *  can be injectable but not yet listening; the old code read one failed
 *  message as "this page forbids content scripts" and opened the fallback
 *  window on ordinary sites. */
const INJECT_RETRY_MS = 600;
const INJECT_RETRY_STEP_MS = 25;

let mru = new MruTracker();
let tabs = new TabIndex();
let ready: Promise<void> | null = null;

/** Cached so the hot path never awaits `chrome.commands.getAll()`. */
let commitModifiers = parseShortcutModifiers(undefined);

type Host = { kind: 'tab'; tabId: number } | { kind: 'popup'; windowId: number };

let session: SessionState | null = null;
let host: Host | null = null;
let sessionEpoch = 0;

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

async function ensureReady(): Promise<void> {
  ready ??= (async () => {
    const stored = await chrome.storage.session.get([MRU_KEY, TABS_KEY]);
    mru = MruTracker.fromJSON(stored[MRU_KEY]);
    tabs = TabIndex.fromJSON(stored[TABS_KEY]);

    const live = await chrome.tabs.query({});
    for (const tab of live) {
      if (isOwnPage(tab.url)) continue;
      tabs.record(tab);
      if (tab.id !== undefined && tab.windowId !== undefined) {
        mru.append(tab.id, tab.windowId);
      }
    }
    const liveIds = live.map((t) => t.id).filter((id): id is number => id !== undefined);
    mru.retain(liveIds);
    tabs.retain(liveIds);

    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.id !== undefined) mru.touch(active.id, active.windowId);

    await Promise.all([persist(), refreshModifiers()]);
  })();
  return ready;
}

async function persist(): Promise<void> {
  await chrome.storage.session.set({ [MRU_KEY]: mru.toJSON(), [TABS_KEY]: tabs.toJSON() });
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Debounced persistence for high-frequency events.
 *
 * `tabs.onUpdated` fires repeatedly through every navigation, and writing the
 * whole tab index each time is pure overhead. Memory is the source of truth;
 * storage only has to survive the service worker being evicted.
 */
function schedulePersist(): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void persist(), 500);
}

async function refreshModifiers(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    commitModifiers = parseShortcutModifiers(
      commands.find((c) => c.name === CMD_OPEN)?.shortcut,
    );
  } catch {
    commitModifiers = parseShortcutModifiers(undefined);
  }
}

/** Our own fallback popup must never become a switch target. */
function isOwnPage(url: string | undefined): boolean {
  return !!url && url.startsWith(chrome.runtime.getURL(''));
}

/* -------------------------------------------------------------------------- */
/* Tab and window events                                                      */
/* -------------------------------------------------------------------------- */

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await ensureReady();
  mru.touch(tabId, windowId);
  if (!tabs.get(tabId)) {
    try {
      tabs.record(await chrome.tabs.get(tabId));
    } catch {
      // Gone already.
    }
  }
  await persist();
  thumbnails.scheduleCapture(tabId, windowId);
});

chrome.tabs.onCreated.addListener(async (tab) => {
  await ensureReady();
  if (isOwnPage(tab.url)) return;
  tabs.record(tab);
  if (tab.id !== undefined && tab.windowId !== undefined) mru.append(tab.id, tab.windowId);
  await persist();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ensureReady();
  if (isOwnPage(tab.url)) return;
  tabs.record(tab);
  schedulePersist();
  if (changeInfo.status === 'complete' && tab.active) {
    thumbnails.scheduleCapture(tabId, tab.windowId);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ensureReady();
  mru.remove(tabId);
  tabs.remove(tabId);
  await persist();
  await thumbnails.drop(tabId);

  if (session) {
    const next = removeItem(session, tabId);
    if (!next) {
      await endSession();
    } else if (next !== session) {
      session = next;
      await sendToHost({ type: 'UPDATE', epoch: session.epoch, selectedIndex: session.selectedIndex });
    }
  }
});

chrome.tabs.onAttached.addListener(async (tabId, { newWindowId }) => {
  await ensureReady();
  mru.reassign(tabId, newWindowId);
  tabs.setWindow(tabId, newWindowId);
  await persist();
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  await ensureReady();
  mru.replace(addedTabId, removedTabId);
  tabs.replace(addedTabId, removedTabId);
  await persist();
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  await ensureReady();
  mru.removeWindow(windowId);
  await persist();
  if (host?.kind === 'popup' && host.windowId === windowId) {
    session = null;
    host = null;
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  await ensureReady();
  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (active?.id === undefined || isOwnPage(active.url)) return;
  mru.touch(active.id, windowId);
  await persist();
  thumbnails.scheduleCapture(active.id, windowId);
});

/* -------------------------------------------------------------------------- */
/* Building the strip                                                         */
/* -------------------------------------------------------------------------- */

/** Synchronous by design: this runs between the keypress and the first paint. */
function buildItems(windowId: number): SwitcherItem[] {
  const items: SwitcherItem[] = [];
  for (const entry of mru.listForWindow(windowId)) {
    if (isOwnPage(tabs.get(entry.tabId)?.url)) continue;
    const item = tabs.toItem(entry.tabId);
    if (item) items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/** The active tab of a window is by definition its most recent one, so this
 *  needs no `tabs.query` round trip on the hot path. */
function activeTabOf(windowId: number) {
  const first = mru.listForWindow(windowId)[0];
  return first ? tabs.get(first.tabId) : undefined;
}

/* -------------------------------------------------------------------------- */
/* Session lifecycle                                                          */
/* -------------------------------------------------------------------------- */

async function post(target: Host, message: ToOverlayMessage): Promise<boolean> {
  try {
    if (target.kind === 'tab') await chrome.tabs.sendMessage(target.tabId, message);
    else await chrome.runtime.sendMessage(message);
    return true;
  } catch {
    return false;
  }
}

async function sendToHost(message: ToOverlayMessage): Promise<boolean> {
  return host ? post(host, message) : false;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shows the strip in a tab, injecting and retrying while the content script
 * finishes loading. Only gives up once the budget is spent.
 */
async function showInTab(tabId: number, payload: ToOverlayMessage): Promise<boolean> {
  if (await post({ kind: 'tab', tabId }, payload)) return true;

  try {
    const files = chrome.runtime.getManifest().content_scripts?.[0]?.js;
    if (files?.length) await chrome.scripting.executeScript({ target: { tabId }, files });
  } catch {
    return false;
  }

  const deadline = Date.now() + INJECT_RETRY_MS;
  while (Date.now() < deadline) {
    if (await post({ kind: 'tab', tabId }, payload)) return true;
    await wait(INJECT_RETRY_STEP_MS);
  }
  return false;
}

async function openFallbackWindow(): Promise<void> {
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL(FALLBACK_PAGE),
    type: 'popup',
    focused: true,
    width: 820,
    height: 240,
  });
  if (created?.id !== undefined) host = { kind: 'popup', windowId: created.id };
  // The page pulls state itself via GET_SESSION once it has loaded.
}

/** Fetches previews and sends them once the strip is already on screen. */
async function sendThumbnails(state: SessionState): Promise<void> {
  const thumbs = await thumbnails.getMany(state.items.map((i) => i.tabId));
  if (session?.epoch !== state.epoch || Object.keys(thumbs).length === 0) return;
  await sendToHost({
    type: 'THUMBS',
    epoch: state.epoch,
    thumbs,
    mime: thumbnails.THUMB_MIME,
  });
}

async function openSwitcher(): Promise<void> {
  const window = await chrome.windows.getLastFocused();
  if (window.id === undefined) return;

  const items = buildItems(window.id);
  sessionEpoch += 1;
  const opened = openSession(sessionEpoch, items);
  if (!opened) return;
  session = opened;

  const payload: ToOverlayMessage = {
    type: 'SHOW',
    epoch: opened.epoch,
    items: opened.items,
    selectedIndex: opened.selectedIndex,
    commitModifiers,
  };

  const active = activeTabOf(window.id);

  if (active && canRunContentScript(active.url)) {
    host = { kind: 'tab', tabId: active.tabId };
    if (await showInTab(active.tabId, payload)) {
      void sendThumbnails(opened);
      void refreshModifiers();
      return;
    }
  }

  // chrome://, the Web Store, the New Tab page: Chrome forbids content
  // scripts outright, so the strip gets its own window.
  await openFallbackWindow();
  void sendThumbnails(opened);
  void refreshModifiers();
}

async function step(delta: number): Promise<void> {
  if (!session) return;
  session = stepSelection(session, delta);
  await sendToHost({ type: 'UPDATE', epoch: session.epoch, selectedIndex: session.selectedIndex });
}

async function endSession(): Promise<void> {
  const current = host;
  const epoch = session?.epoch ?? sessionEpoch;
  session = null;
  host = null;
  if (!current) return;
  if (current.kind === 'popup') {
    try {
      await chrome.windows.remove(current.windowId);
    } catch {
      // Already closed.
    }
  } else {
    await post(current, { type: 'HIDE', epoch });
  }
}

async function commit(tabId: number): Promise<void> {
  if (!session) return;
  const target = resolveCommit(session, tabId);
  await endSession();
  if (!target) return;
  try {
    await chrome.tabs.update(target.tabId, { active: true });
    await chrome.windows.update(target.windowId, { focused: true });
  } catch {
    // The tab disappeared between render and commit.
  }
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                               */
/* -------------------------------------------------------------------------- */

chrome.commands.onCommand.addListener((command) => {
  if (command !== CMD_OPEN) return;
  void (async () => {
    await ensureReady();
    // The hotkey only opens; Tab moves the selection from there.
    if (!session) await openSwitcher();
  })();
});

chrome.action.onClicked.addListener(() => {
  void (async () => {
    await ensureReady();
    if (!session) await openSwitcher();
  })();
});

chrome.runtime.onMessage.addListener((message: FromOverlayMessage, _sender, sendResponse) => {
  switch (message.type) {
    case 'STEP':
      if (session && message.epoch === session.epoch) void step(message.delta);
      break;
    case 'COMMIT':
      if (session && message.epoch === session.epoch) void commit(message.tabId);
      break;
    case 'GET_SESSION': {
      // The fallback page asks for this once it has loaded, which is the
      // earliest moment it can receive anything — thumbnails pushed before
      // then are simply dropped.
      const current = session;
      sendResponse(
        current
          ? {
              type: 'SHOW',
              epoch: current.epoch,
              items: current.items,
              selectedIndex: current.selectedIndex,
              commitModifiers,
            }
          : null,
      );
      if (current) void sendThumbnails(current);
      return true;
    }
  }
  return undefined;
});

chrome.runtime.onInstalled.addListener(() => void ensureReady());
chrome.runtime.onStartup.addListener(() => void ensureReady());
