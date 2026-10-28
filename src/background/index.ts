import { MruTracker } from './mru';
import { TabIndex } from './tab-index';
import { openSession, removeItem, resolveCommit, stepSelection } from './session';
import { parseShortcutModifiers } from './shortcut';
import { centerIn } from './geometry';
import { log } from './debug-log';
import * as thumbnails from './thumbnails';
import { classifyUrl, describeUrl } from '../shared/restricted';
import { MAX_ITEMS } from '../shared/types';
import type { FromOverlayMessage, SessionState, SwitcherItem, ToOverlayMessage } from '../shared/types';

const MRU_KEY = 'mru:order';
const TABS_KEY = 'mru:tabs';
const FALLBACK_PAGE = 'src/fallback/index.html';
const FALLBACK_SIZE = { width: 820, height: 240 };

export const CMD_OPEN = 'open-switcher';
export const CMD_BACKWARD = 'cycle-backward';

/**
 * How long to keep trying a page that should accept the overlay.
 *
 * The bundler loads the content script through a dynamic import, so a tab can
 * be injectable and not yet listening. On a busy page that gap is not small,
 * and giving up early is how the fallback window ended up on ordinary sites.
 */
const INJECT_RETRY_MS = 3000;
const INJECT_RETRY_STEP_MS = 20;

/** Two sources can drive a step (the command, and the overlay's own keydown).
 *  Chrome should only ever deliver one of them, but collapsing an exact
 *  repeat costs nothing and stops a double hop if it ever delivers both. */
const STEP_DEDUPE_MS = 40;

let mru = new MruTracker();
let tabs = new TabIndex();
let ready: Promise<void> | null = null;

/** Cached so the hot path never awaits `chrome.commands.getAll()`. */
let commitModifiers = parseShortcutModifiers(undefined);

type Host = { kind: 'tab'; tabId: number } | { kind: 'popup'; windowId: number };

let session: SessionState | null = null;
let host: Host | null = null;
let sessionEpoch = 0;
let lastStep = { at: 0, delta: 0 };

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

async function ensureReady(): Promise<void> {
  ready ??= (async () => {
    const stored = await chrome.storage.session.get([MRU_KEY, TABS_KEY]);
    mru = MruTracker.fromJSON(stored[MRU_KEY]);
    tabs = TabIndex.fromJSON(stored[TABS_KEY]);

    const live = await chrome.tabs.query({});

    // Seed in true recency order. Chrome reports when each tab was last
    // looked at, and using tab-strip order instead meant that straight after
    // an install or reload "the previous tab" was simply the leftmost tab.
    const seedable = live
      .filter((tab) => !isOwnPage(tab.url))
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));

    for (const tab of seedable) {
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
    log('ready', { tabs: live.length, seeded: seedable.length });
  })();
  return ready;
}

async function persist(): Promise<void> {
  await chrome.storage.session.set({ [MRU_KEY]: mru.toJSON(), [TABS_KEY]: tabs.toJSON() });
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;

/** Debounced persistence for high-frequency events such as `tabs.onUpdated`. */
function schedulePersist(): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void persist(), 500);
}

async function refreshModifiers(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    const shortcut = commands.find((c) => c.name === CMD_OPEN)?.shortcut;
    commitModifiers = parseShortcutModifiers(shortcut);
    if (!shortcut) log('shortcut:unbound');
  } catch {
    commitModifiers = parseShortcutModifiers(undefined);
  }
}

/** Our own pages must never become switch targets. */
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

/* -------------------------------------------------------------------------- */
/* Session lifecycle                                                          */
/* -------------------------------------------------------------------------- */

interface PostResult {
  ok: boolean;
  error?: string;
}

async function post(target: Host, message: ToOverlayMessage): Promise<PostResult> {
  try {
    if (target.kind === 'tab') await chrome.tabs.sendMessage(target.tabId, message);
    else await chrome.runtime.sendMessage(message);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function sendToHost(message: ToOverlayMessage): Promise<boolean> {
  return host ? (await post(host, message)).ok : false;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shows the strip in a tab, injecting the content script if it is not there
 * and retrying while it loads.
 *
 * Every outcome is logged, because when this returns false on a machine the
 * author cannot reproduce on, the log is the only way to tell which branch
 * was responsible.
 */
async function showInTab(tabId: number, payload: ToOverlayMessage): Promise<boolean> {
  const started = Date.now();

  const direct = await post({ kind: 'tab', tabId }, payload);
  if (direct.ok) {
    log('show:direct', { tabId, ms: Date.now() - started });
    return true;
  }
  log('show:no-listener', { tabId, error: direct.error });

  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js;
  if (!files?.length) {
    log('inject:no-files');
    return false;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
    log('inject:ok', { tabId, ms: Date.now() - started });
  } catch (error) {
    // The common cause is site access being limited to "on click", which
    // withholds the host permission this needs.
    log('inject:failed', {
      tabId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  let attempts = 0;
  let lastError: string | undefined;
  while (Date.now() - started < INJECT_RETRY_MS) {
    attempts += 1;
    const retry = await post({ kind: 'tab', tabId }, payload);
    if (retry.ok) {
      log('show:ready', { tabId, attempts, ms: Date.now() - started });
      return true;
    }
    lastError = retry.error;
    await wait(INJECT_RETRY_STEP_MS);
  }

  log('show:timeout', { tabId, attempts, ms: Date.now() - started, lastError });
  return false;
}

async function openFallbackWindow(reason: string): Promise<void> {
  let placement = {};
  try {
    placement = centerIn(await chrome.windows.getLastFocused(), FALLBACK_SIZE);
  } catch {
    // Fall back to Chrome's own placement.
  }

  log('route:popup', { reason, ...placement });
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL(FALLBACK_PAGE),
    type: 'popup',
    focused: true,
    ...FALLBACK_SIZE,
    ...placement,
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

async function openSwitcher(delta: number): Promise<void> {
  // Ask Chrome which tab is active rather than inferring it from cached MRU
  // order. The cache can disagree with reality right after an install or a
  // reload, and a wrong answer here used to route a perfectly ordinary page
  // to the popup window.
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab || activeTab.id === undefined || activeTab.windowId === undefined) {
    log('open:no-active-tab');
    return;
  }
  if (!isOwnPage(activeTab.url)) tabs.record(activeTab);

  const windowId = activeTab.windowId;
  const classification = classifyUrl(activeTab.url);
  const items = buildItems(windowId);

  log('open', {
    tabId: activeTab.id,
    windowId,
    url: describeUrl(activeTab.url),
    classification,
    items: items.length,
    direction: delta < 0 ? 'backward' : 'forward',
  });

  sessionEpoch += 1;
  const opened = openSession(sessionEpoch, items);
  if (!opened) {
    log('open:too-few-tabs', { items: items.length });
    return;
  }
  session = delta < 0 ? stepSelection({ ...opened, selectedIndex: 0 }, -1) : opened;

  const payload: ToOverlayMessage = {
    type: 'SHOW',
    epoch: session.epoch,
    items: session.items,
    selectedIndex: session.selectedIndex,
    commitModifiers,
  };

  if (classification !== 'restricted') {
    host = { kind: 'tab', tabId: activeTab.id };
    if (await showInTab(activeTab.id, payload)) {
      log('route:overlay', { tabId: activeTab.id });
      void sendThumbnails(session);
      void refreshModifiers();
      return;
    }

    if (classification === 'injectable') {
      // An http(s) page can always host the overlay, so a failure here is a
      // bug to be read out of the log, not a reason to throw a window at the
      // user. Opening the popup over a normal page is worse than nothing.
      log('route:none', { tabId: activeTab.id, reason: 'overlay failed on injectable page' });
      session = null;
      host = null;
      return;
    }
  }

  await openFallbackWindow(classification);
  void sendThumbnails(session);
  void refreshModifiers();
}

async function step(delta: number, source: string): Promise<void> {
  if (!session) return;

  const now = Date.now();
  if (now - lastStep.at < STEP_DEDUPE_MS && lastStep.delta === delta) {
    log('step:deduped', { source, delta });
    return;
  }
  lastStep = { at: now, delta };

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
  if (!target) {
    log('commit:not-in-session', { tabId });
    return;
  }
  log('commit', { tabId: target.tabId });
  try {
    await chrome.tabs.update(target.tabId, { active: true });
    await chrome.windows.update(target.windowId, { focused: true });
  } catch (error) {
    log('commit:failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                               */
/* -------------------------------------------------------------------------- */

chrome.commands.onCommand.addListener((command) => {
  if (command !== CMD_OPEN && command !== CMD_BACKWARD) return;
  const delta = command === CMD_BACKWARD ? -1 : 1;
  void (async () => {
    await ensureReady();
    if (session) await step(delta, 'command');
    else await openSwitcher(delta);
  })();
});

chrome.runtime.onMessage.addListener((message: FromOverlayMessage, _sender, sendResponse) => {
  switch (message.type) {
    case 'STEP':
      if (session && message.epoch === session.epoch) void step(message.delta, 'overlay');
      break;
    case 'COMMIT':
      if (session && message.epoch === session.epoch) void commit(message.tabId);
      break;
    case 'GET_SESSION': {
      // The fallback page asks for this once it has loaded, which is the
      // earliest moment it can receive anything.
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

/**
 * Puts the content script into tabs that already existed.
 *
 * Done at install and at browser startup rather than on the hot path, so the
 * first press on a tab that predates the extension does not have to wait for
 * an injection.
 */
async function warmExistingTabs(): Promise<void> {
  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js;
  if (!files?.length) return;

  const all = await chrome.tabs.query({});
  const targets = all.filter((t) => t.id !== undefined && classifyUrl(t.url) === 'injectable');

  const results = await Promise.all(
    targets.map(async (tab) => {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files });
        return true;
      } catch {
        return false;
      }
    }),
  );
  const failed = results.filter((ok) => !ok).length;
  log('warm', { attempted: targets.length, failed });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureReady();
  void warmExistingTabs();

  // Chrome does not always honour a suggested shortcut, so point the user at
  // the one page that can assign it. Extensions cannot set it themselves.
  if (details.reason === 'install') {
    const commands = await chrome.commands.getAll();
    if (!commands.find((c) => c.name === CMD_OPEN)?.shortcut) {
      log('install:shortcut-unbound');
      await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureReady();
  void warmExistingTabs();
});
