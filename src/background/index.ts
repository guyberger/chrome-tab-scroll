import { MruTracker } from './mru';
import {
  commitTarget,
  openSession,
  removeItem,
  selectIndex,
  stepSelection,
} from './session';
import { parseShortcutModifiers } from './shortcut';
import * as thumbnails from './thumbnails';
import { MAX_ITEMS } from '../shared/types';
import type { FromOverlayMessage, SessionState, SwitcherItem, ToOverlayMessage } from '../shared/types';

const MRU_STORAGE_KEY = 'mru:order';
const FALLBACK_PAGE = 'src/fallback/index.html';
const FALLBACK_SIZE = { width: 760, height: 260 };

export const CMD_FORWARD = 'cycle-forward';
export const CMD_BACKWARD = 'cycle-backward';

let mru = new MruTracker();
let ready: Promise<void> | null = null;

/** Where the currently open strip is being rendered. */
type Host =
  | { kind: 'tab'; tabId: number }
  | { kind: 'popup'; windowId: number };

let session: SessionState | null = null;
let host: Host | null = null;
/** The window the session switches within, i.e. where the user pressed the key. */
let sessionWindowId: number | null = null;

/* -------------------------------------------------------------------------- */
/* MRU state                                                                  */
/* -------------------------------------------------------------------------- */

async function ensureReady(): Promise<void> {
  ready ??= (async () => {
    const stored = await chrome.storage.session.get(MRU_STORAGE_KEY);
    mru = MruTracker.fromJSON(stored[MRU_STORAGE_KEY]);

    // Seed anything the tracker has not seen (first run, or after the service
    // worker was evicted and storage.session was cleared with the browser).
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id !== undefined && tab.windowId !== undefined) {
        mru.append(tab.id, tab.windowId);
      }
    }
    mru.retain(tabs.map((t) => t.id).filter((id): id is number => id !== undefined));

    // Put the focused tab in front so the very first press behaves sensibly.
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.id !== undefined) mru.touch(active.id, active.windowId);

    await persist();
  })();
  return ready;
}

async function persist(): Promise<void> {
  await chrome.storage.session.set({ [MRU_STORAGE_KEY]: mru.toJSON() });
}

/* -------------------------------------------------------------------------- */
/* Tab and window events                                                      */
/* -------------------------------------------------------------------------- */

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await ensureReady();
  mru.touch(tabId, windowId);
  await persist();
  thumbnails.scheduleCapture(tabId, windowId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ensureReady();
  mru.remove(tabId);
  await persist();
  await thumbnails.drop(tabId);

  if (session) {
    const next = removeItem(session, tabId);
    if (!next) {
      await endSession();
    } else if (next !== session) {
      session = next;
      await sendToHost({ type: 'UPDATE', selectedIndex: session.selectedIndex });
    }
  }
});

chrome.tabs.onAttached.addListener(async (tabId, { newWindowId }) => {
  await ensureReady();
  mru.reassign(tabId, newWindowId);
  await persist();
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  await ensureReady();
  mru.replace(addedTabId, removedTabId);
  await persist();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // A navigation makes the cached preview stale; re-shoot if it is on screen.
  if (changeInfo.status === 'complete' && tab.active) {
    thumbnails.scheduleCapture(tabId, tab.windowId);
  }
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  await ensureReady();
  mru.removeWindow(windowId);
  await persist();
  if (host?.kind === 'popup' && host.windowId === windowId) {
    session = null;
    host = null;
    sessionWindowId = null;
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  await ensureReady();
  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (active?.id !== undefined) {
    mru.touch(active.id, windowId);
    await persist();
    thumbnails.scheduleCapture(active.id, windowId);
  }
});

/* -------------------------------------------------------------------------- */
/* Building the strip                                                         */
/* -------------------------------------------------------------------------- */

async function buildItems(windowId: number): Promise<SwitcherItem[]> {
  const entries = mru.listForWindow(windowId).slice(0, MAX_ITEMS);

  const tabs = await Promise.all(
    entries.map(async (entry) => {
      try {
        return await chrome.tabs.get(entry.tabId);
      } catch {
        return undefined;
      }
    }),
  );

  const live = tabs.filter((tab): tab is chrome.tabs.Tab => tab !== undefined && tab.id !== undefined);
  const shots = await thumbnails.getMany(live.map((tab) => tab.id as number));

  return live.map((tab) => ({
    tabId: tab.id as number,
    windowId: tab.windowId,
    title: tab.title || tab.url || 'Untitled',
    url: tab.url ?? '',
    favIconUrl: tab.favIconUrl,
    thumbnail: shots.get(tab.id as number),
  }));
}

async function commitModifiers(): Promise<string[]> {
  try {
    const commands = await chrome.commands.getAll();
    const forward = commands.find((c) => c.name === CMD_FORWARD);
    return parseShortcutModifiers(forward?.shortcut);
  } catch {
    return parseShortcutModifiers(undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* Session lifecycle                                                          */
/* -------------------------------------------------------------------------- */

async function sendToHost(message: ToOverlayMessage): Promise<boolean> {
  if (!host) return false;
  try {
    if (host.kind === 'tab') {
      await chrome.tabs.sendMessage(host.tabId, message);
    } else {
      await chrome.runtime.sendMessage(message);
    }
    return true;
  } catch {
    return false;
  }
}

async function openFallbackWindow(): Promise<void> {
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL(FALLBACK_PAGE),
    type: 'popup',
    focused: true,
    ...FALLBACK_SIZE,
  });
  if (created?.id !== undefined) host = { kind: 'popup', windowId: created.id };
  // The page pulls state itself via GET_SESSION once it has loaded.
}

async function startSession(delta: number): Promise<void> {
  const window = await chrome.windows.getLastFocused();
  if (window.id === undefined) return;

  const items = await buildItems(window.id);
  const opened = openSession(items);
  if (!opened) return;

  session = delta >= 0 ? opened : stepSelection({ items, selectedIndex: 0 }, delta);
  sessionWindowId = window.id;

  const [active] = await chrome.tabs.query({ active: true, windowId: window.id });
  const payload: ToOverlayMessage = {
    type: 'SHOW',
    items: session.items,
    selectedIndex: session.selectedIndex,
    commitModifiers: await commitModifiers(),
  };

  if (active?.id !== undefined) {
    host = { kind: 'tab', tabId: active.id };
    if (await sendToHost(payload)) return;
  }

  // Content scripts cannot run here (chrome://, the Web Store, the New Tab
  // page, or a tab loaded before the extension was installed). Try a one-shot
  // injection first, then fall back to a popup window.
  if (active?.id !== undefined && (await injectInto(active.id))) {
    host = { kind: 'tab', tabId: active.id };
    if (await sendToHost(payload)) return;
  }

  await openFallbackWindow();
}

/**
 * Injects the content script into a tab that does not already have it, which
 * happens for every tab that was open before the extension was installed or
 * reloaded. The filename comes from the manifest because the bundler rewrites
 * it at build time.
 */
async function injectInto(tabId: number): Promise<boolean> {
  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js;
  if (!files?.length) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
    return true;
  } catch {
    return false;
  }
}

async function step(delta: number): Promise<void> {
  await ensureReady();
  if (!session) {
    await startSession(delta);
    return;
  }
  session = stepSelection(session, delta);
  await sendToHost({ type: 'UPDATE', selectedIndex: session.selectedIndex });
}

async function endSession(): Promise<void> {
  await sendToHost({ type: 'HIDE' });
  if (host?.kind === 'popup') {
    try {
      await chrome.windows.remove(host.windowId);
    } catch {
      // Already closed.
    }
  }
  session = null;
  host = null;
  sessionWindowId = null;
}

async function commit(index?: number): Promise<void> {
  if (!session) return;
  const state = index === undefined ? session : selectIndex(session, index);
  const target = commitTarget(state);
  const hostWindowId = sessionWindowId;
  await endSession();

  if (!target) return;
  try {
    await chrome.tabs.update(target.tabId, { active: true });
    await chrome.windows.update(target.windowId ?? hostWindowId ?? 0, { focused: true });
  } catch {
    // The tab disappeared between render and commit.
  }
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                               */
/* -------------------------------------------------------------------------- */

chrome.commands.onCommand.addListener((command) => {
  if (command === CMD_FORWARD) void step(1);
  if (command === CMD_BACKWARD) void step(-1);
});

chrome.action.onClicked.addListener(() => {
  void step(1);
});

chrome.runtime.onMessage.addListener((message: FromOverlayMessage, _sender, sendResponse) => {
  switch (message.type) {
    case 'COMMIT':
      void commit(message.index);
      break;
    case 'CANCEL':
      void endSession();
      break;
    case 'STEP':
      void step(message.delta);
      break;
    case 'GET_SESSION':
      void (async () => {
        sendResponse(
          session
            ? {
                type: 'SHOW',
                items: session.items,
                selectedIndex: session.selectedIndex,
                commitModifiers: await commitModifiers(),
              }
            : null,
        );
      })();
      return true;
  }
  return undefined;
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureReady();
});
chrome.runtime.onStartup.addListener(() => {
  void ensureReady();
});
