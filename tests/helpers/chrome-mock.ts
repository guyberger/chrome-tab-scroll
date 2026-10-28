import { vi } from 'vitest';

/**
 * A hand-rolled `chrome` stand-in.
 *
 * Only the surface this extension touches is implemented, but the parts that
 * exist behave like the real thing: storage round-trips values, `tabs.query`
 * filters, and every event is dispatchable so a test can drive the background
 * service worker the way Chrome would.
 */

export interface FakeTab {
  id: number;
  windowId: number;
  active: boolean;
  title?: string;
  url?: string;
  favIconUrl?: string;
}

class Event<Args extends unknown[]> {
  readonly listeners: ((...args: Args) => unknown)[] = [];

  addListener = (fn: (...args: Args) => unknown): void => {
    this.listeners.push(fn);
  };

  removeListener = (fn: (...args: Args) => unknown): void => {
    const i = this.listeners.indexOf(fn);
    if (i >= 0) this.listeners.splice(i, 1);
  };

  /** Fires every listener and waits for any promises they return. */
  async dispatch(...args: Args): Promise<void> {
    await Promise.all(this.listeners.map((fn) => fn(...args)));
    await flush();
  }
}

/**
 * Drains pending microtasks so `async` listeners finish before assertions.
 *
 * Chrome's event listeners are fire-and-forget — the background registers a
 * synchronous listener that kicks off async work — so there is no promise to
 * await. The handlers chain well over a dozen `await`s, and each iteration
 * here releases roughly one, so the count needs headroom.
 */
export async function flush(): Promise<void> {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
}

export interface ChromeMock {
  tabs: {
    query: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    captureVisibleTab: ReturnType<typeof vi.fn>;
    onActivated: Event<[{ tabId: number; windowId: number }]>;
    onCreated: Event<[FakeTab]>;
    onRemoved: Event<[number, { windowId: number; isWindowClosing: boolean }]>;
    onAttached: Event<[number, { newWindowId: number; newPosition: number }]>;
    onReplaced: Event<[number, number]>;
    onUpdated: Event<[number, { status?: string }, FakeTab]>;
  };
  windows: {
    getLastFocused: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    onRemoved: Event<[number]>;
    onFocusChanged: Event<[number]>;
    WINDOW_ID_NONE: number;
  };
  commands: {
    getAll: ReturnType<typeof vi.fn>;
    onCommand: Event<[string]>;
  };
  action: { onClicked: Event<[FakeTab]> };
  runtime: {
    sendMessage: ReturnType<typeof vi.fn>;
    getManifest: ReturnType<typeof vi.fn>;
    getURL: ReturnType<typeof vi.fn>;
    onMessage: Event<[unknown, unknown, (response?: unknown) => void]>;
    onInstalled: Event<[{ reason: string }]>;
    onStartup: Event<[]>;
    lastError: undefined;
  };
  scripting: { executeScript: ReturnType<typeof vi.fn> };
  storage: {
    session: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
      clear: ReturnType<typeof vi.fn>;
      _data: Record<string, unknown>;
    };
  };
  /** Test-only handle on the tab table backing `tabs.query` / `tabs.get`. */
  _tabs: FakeTab[];
  /** Test-only: which window `lastFocusedWindow` queries resolve against. */
  _focusedWindowId: number;
}

export function createChromeMock(tabs: FakeTab[] = [], focusedWindowId = 1): ChromeMock {
  const store: Record<string, unknown> = {};
  const tabTable = [...tabs];

  const session = {
    _data: store,
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys === null || keys === undefined) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in store) out[k] = store[k];
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
    }),
    clear: vi.fn(async () => {
      for (const k of Object.keys(store)) delete store[k];
    }),
  };

  const mock: ChromeMock = {
    _tabs: tabTable,
    _focusedWindowId: focusedWindowId,
    tabs: {
      query: vi.fn(async (q: { active?: boolean; windowId?: number; lastFocusedWindow?: boolean }) =>
        tabTable.filter(
          (t) =>
            (q.active === undefined || t.active === q.active) &&
            (q.windowId === undefined || t.windowId === q.windowId) &&
            (q.lastFocusedWindow !== true || t.windowId === mock._focusedWindowId),
        ),
      ),
      get: vi.fn(async (tabId: number) => {
        const tab = tabTable.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return tab;
      }),
      update: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
      captureVisibleTab: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
      onActivated: new Event(),
      onCreated: new Event(),
      onRemoved: new Event(),
      onAttached: new Event(),
      onReplaced: new Event(),
      onUpdated: new Event(),
    },
    windows: {
      getLastFocused: vi.fn(async () => ({ id: mock._focusedWindowId })),
      create: vi.fn(async () => ({ id: 99 })),
      remove: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      onRemoved: new Event(),
      onFocusChanged: new Event(),
      WINDOW_ID_NONE: -1,
    },
    commands: {
      getAll: vi.fn(async () => [{ name: 'cycle-forward', shortcut: 'Alt+Q' }]),
      onCommand: new Event(),
    },
    action: { onClicked: new Event() },
    runtime: {
      sendMessage: vi.fn(async () => undefined),
      getManifest: vi.fn(() => ({ content_scripts: [{ js: ['content.js'] }] })),
      getURL: vi.fn((path: string) => `chrome-extension://fake/${path}`),
      onMessage: new Event(),
      onInstalled: new Event(),
      onStartup: new Event(),
      lastError: undefined,
    },
    scripting: { executeScript: vi.fn(async () => [{ result: null }]) },
    storage: { session },
  };

  return mock;
}

/** Installs a fresh mock on `globalThis.chrome` and returns it. */
export function installChromeMock(tabs: FakeTab[] = [], focusedWindowId = 1): ChromeMock {
  const mock = createChromeMock(tabs, focusedWindowId);
  (globalThis as unknown as { chrome: unknown }).chrome = mock;
  return mock;
}
