/**
 * Thumbnail capture and cache.
 *
 * `chrome.tabs.captureVisibleTab` can only photograph the tab that is visible
 * right now, so previews cannot be produced when the strip opens. Each tab is
 * captured as it becomes active and the downscaled result cached, meaning a
 * preview shows the tab as you last left it.
 *
 * Captures are stored as bare base64 WebP rather than full-size PNG data
 * URLs. They travel to the overlay in a follow-up message once the strip is
 * already on screen, so size matters for memory and quota rather than for
 * first paint, but WebP at this size is a few kilobytes against a few hundred.
 */

const MAX_WIDTH = 256;
const MAX_HEIGHT = 160;
const QUALITY = 0.5;

export const THUMB_MIME = 'image/webp';

/** Keeps `storage.session` well under quota; the strip only shows six. */
const MAX_CACHED = 14;

/** Chrome rate limits captures; settling also avoids catching a mid-paint. */
const CAPTURE_DEBOUNCE_MS = 350;

const KEY_PREFIX = 'thumb:';
/** Insertion-ordered list of cached tab ids, so eviction never has to read
 *  every cached image back out of storage just to count them. */
const INDEX_KEY = 'thumb:index';
const key = (tabId: number) => `${KEY_PREFIX}${tabId}`;

const pending = new Map<number, ReturnType<typeof setTimeout>>();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: /:(.*?);/.exec(header)?.[1] ?? 'image/png' });
}

/** Scales a capture down to strip size and returns bare base64 WebP. */
export async function downscale(dataUrl: string): Promise<string> {
  const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
  const scale = Math.min(MAX_WIDTH / bitmap.width, MAX_HEIGHT / bitmap.height, 1);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await canvas.convertToBlob({ type: THUMB_MIME, quality: QUALITY });
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** Captures the active tab of `windowId` and caches it against `tabId`. */
export async function capture(tabId: number, windowId: number): Promise<void> {
  try {
    const shot = await chrome.tabs.captureVisibleTab(windowId, {
      format: 'jpeg',
      quality: 70,
    });
    if (!shot) return;
    await chrome.storage.session.set({ [key(tabId)]: await downscale(shot) });
    await remember(tabId);
  } catch {
    // Expected on restricted pages, when the window is not focused, and when
    // Chrome's capture quota is exceeded. A missing preview is not an error.
  }
}

/** Debounced capture, so a fast burst of switches does not blow the quota. */
export function scheduleCapture(tabId: number, windowId: number): void {
  const existing = pending.get(tabId);
  if (existing) clearTimeout(existing);
  pending.set(
    tabId,
    setTimeout(() => {
      pending.delete(tabId);
      void capture(tabId, windowId);
    }, CAPTURE_DEBOUNCE_MS),
  );
}

export function cancelCapture(tabId: number): void {
  const existing = pending.get(tabId);
  if (existing) {
    clearTimeout(existing);
    pending.delete(tabId);
  }
}

export async function getMany(tabIds: number[]): Promise<Record<number, string>> {
  if (tabIds.length === 0) return {};
  const stored = await chrome.storage.session.get(tabIds.map(key));
  const result: Record<number, string> = {};
  for (const tabId of tabIds) {
    const value = stored[key(tabId)];
    if (typeof value === 'string') result[tabId] = value;
  }
  return result;
}

export async function drop(tabId: number): Promise<void> {
  cancelCapture(tabId);
  const index = await readIndex();
  await chrome.storage.session.remove(key(tabId));
  await chrome.storage.session.set({ [INDEX_KEY]: index.filter((id) => id !== tabId) });
}

async function readIndex(): Promise<number[]> {
  const stored = (await chrome.storage.session.get(INDEX_KEY))[INDEX_KEY];
  return Array.isArray(stored) ? (stored as number[]) : [];
}

/**
 * Records a newly cached tab and trims the cache to `MAX_CACHED`.
 *
 * This runs after every tab activation, so it only ever touches the small
 * index. Reading the whole of session storage here meant deserialising every
 * cached image on each tab switch.
 */
async function remember(tabId: number): Promise<void> {
  const index = (await readIndex()).filter((id) => id !== tabId);
  index.push(tabId);

  const excess = index.splice(0, Math.max(0, index.length - MAX_CACHED));
  if (excess.length) await chrome.storage.session.remove(excess.map(key));
  await chrome.storage.session.set({ [INDEX_KEY]: index });
}
