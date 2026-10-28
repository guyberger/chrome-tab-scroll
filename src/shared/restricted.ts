/**
 * Classifies a tab URL for routing between the in-page overlay and the
 * popup-window fallback.
 *
 * The important property is which way the uncertain case falls. Treating
 * anything not recognisably `http(s)` as "cannot host a content script" means
 * a stale or missing URL silently routes to the popup window, which is the
 * one outcome we never want on an ordinary page. Only URLs that are *known*
 * to be off limits are restricted; anything else is worth attempting, and the
 * injection itself decides.
 */

export type UrlClass = 'injectable' | 'restricted' | 'unknown';

const RESTRICTED_SCHEMES = [
  'chrome:',
  'chrome-untrusted:',
  'chrome-search:',
  'chrome-native:',
  'chrome-extension:',
  'moz-extension:',
  'devtools:',
  'edge:',
  'about:',
  'view-source:',
];

/** Chrome blocks extensions on the Web Store even though it is an https page. */
const RESTRICTED_PREFIXES = [
  'https://chromewebstore.google.com',
  'https://chrome.google.com/webstore',
];

export function classifyUrl(url: string | undefined): UrlClass {
  if (!url) return 'unknown';
  const lower = url.toLowerCase();

  if (RESTRICTED_SCHEMES.some((scheme) => lower.startsWith(scheme))) return 'restricted';
  if (RESTRICTED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return 'restricted';
  if (lower.startsWith('http://') || lower.startsWith('https://')) return 'injectable';

  return 'unknown';
}

/**
 * A URL reduced to scheme and host for the diagnostic log, so a user can
 * share it without handing over the pages they were reading.
 */
export function describeUrl(url: string | undefined): string {
  if (!url) return '(none)';
  try {
    const parsed = new URL(url);
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : parsed.protocol;
  } catch {
    return url.slice(0, 12);
  }
}
