/**
 * A small ring buffer of recent decisions, readable from the toolbar popup.
 *
 * This exists for one reason: the switcher sometimes opens its fallback
 * window on an ordinary page on a machine the author cannot reproduce on.
 * The log has to name the exact branch that chose the popup — which URL
 * classification, which error, how long the retry waited — so it can be
 * copied out of the popup and read by someone else.
 *
 * URLs are reduced to scheme and host before they get here, so sharing the
 * log does not share browsing history.
 */

const STORAGE_KEY = 'debug:log';
const MAX_ENTRIES = 150;
const FLUSH_DEBOUNCE_MS = 100;

export interface LogEntry {
  t: number;
  event: string;
  data?: Record<string, unknown>;
}

let buffer: LogEntry[] = [];
let loaded = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    if (Array.isArray(stored)) buffer = (stored as LogEntry[]).slice(-MAX_ENTRIES);
  } catch {
    // A log that cannot load is not worth failing the extension over.
  }
}

async function flush(): Promise<void> {
  flushTimer = undefined;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: buffer.slice(-MAX_ENTRIES) });
  } catch {
    // Ditto.
  }
}

/**
 * Records an event. Deliberately not awaited by callers: this runs on the
 * path between the keypress and the first paint.
 */
export function log(event: string, data?: Record<string, unknown>): void {
  buffer.push({ t: Date.now(), event, data });
  if (buffer.length > MAX_ENTRIES) buffer = buffer.slice(-MAX_ENTRIES);

  // Also visible live in the service worker console.
  console.debug('[tab-scroll]', event, data ?? '');

  if (!loaded) void load().then(() => undefined);
  if (flushTimer === undefined) flushTimer = setTimeout(() => void flush(), FLUSH_DEBOUNCE_MS);
}

export async function readLog(): Promise<LogEntry[]> {
  await load();
  try {
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    const persisted = Array.isArray(stored) ? (stored as LogEntry[]) : [];
    // In-memory entries may not have been flushed yet.
    return persisted.length > buffer.length ? persisted : buffer;
  } catch {
    return buffer;
  }
}

export async function clearLog(): Promise<void> {
  buffer = [];
  await chrome.storage.local.remove(STORAGE_KEY);
}

/** Renders the log as plain text for the popup's copy button. */
export function formatLog(entries: readonly LogEntry[]): string {
  if (entries.length === 0) return '(no activity recorded yet)';
  const start = entries[0]!.t;
  return entries
    .map((e) => {
      const offset = `+${String(e.t - start).padStart(6, ' ')}ms`;
      const detail = e.data ? ` ${JSON.stringify(e.data)}` : '';
      return `${offset}  ${e.event}${detail}`;
    })
    .join('\n');
}
