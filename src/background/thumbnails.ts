/**
 * Thumbnail capture and cache.
 *
 * `chrome.tabs.captureVisibleTab` can only photograph the tab that is visible
 * right now, so there is no way to render a strip of previews on demand. The
 * extension instead captures each tab as it becomes active and caches the
 * downscaled result, meaning a preview is a picture of the tab as you last
 * left it. Capture is also rate limited by Chrome, hence the debounce and the
 * swallowed errors.
 */

const MAX_WIDTH = 320;
const MAX_HEIGHT = 200;
const JPEG_QUALITY = 0.6;

/** Keeps `storage.session` well under quota; the strip only shows ~6. */
const MAX_CACHED = 14;

/** Chrome rate limits captures; settling also avoids photographing mid-paint. */
const CAPTURE_DEBOUNCE_MS = 350;

const KEY_PREFIX = 'thumb:';
const key = (tabId: number) => `${KEY_PREFIX}${tabId}`;

const pending = new Map<number, ReturnType<typeof setTimeout>>();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const mime = /:(.*?);/.exec(header)?.[1] ?? 'image/png';
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Scales a full-size capture down to strip size to keep the cache small. */
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

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
}

/** Captures the active tab of `windowId` and caches it against `tabId`. */
export async function capture(tabId: number, windowId: number): Promise<void> {
  try {
    const shot = await chrome.tabs.captureVisibleTab(windowId, {
      format: 'jpeg',
      quality: 70,
    });
    if (!shot) return;
    const thumbnail = await downscale(shot);
    await chrome.storage.session.set({ [key(tabId)]: thumbnail });
    await evictOldest();
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

export async function getMany(tabIds: number[]): Promise<Map<number, string>> {
  if (tabIds.length === 0) return new Map();
  const stored = await chrome.storage.session.get(tabIds.map(key));
  const result = new Map<number, string>();
  for (const tabId of tabIds) {
    const value = stored[key(tabId)];
    if (typeof value === 'string') result.set(tabId, value);
  }
  return result;
}

export async function drop(tabId: number): Promise<void> {
  cancelCapture(tabId);
  await chrome.storage.session.remove(key(tabId));
}

/** Trims the cache to `MAX_CACHED` entries, oldest insertion first. */
async function evictOldest(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(KEY_PREFIX));
  if (keys.length <= MAX_CACHED) return;
  await chrome.storage.session.remove(keys.slice(0, keys.length - MAX_CACHED));
}
