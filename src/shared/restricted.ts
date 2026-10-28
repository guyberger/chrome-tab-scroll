/**
 * Whether a content script can run on a URL.
 *
 * The switcher decides between the in-page overlay and the popup-window
 * fallback from this, rather than from whether a message happened to fail.
 * A failed `tabs.sendMessage` usually means the content script has not
 * finished loading yet, not that the page forbids it, and treating the two the
 * same is what made the fallback window appear on ordinary sites.
 */

const BLOCKED_SCHEMES = [
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
  'data:',
  'blob:',
  'filesystem:',
];

export function canRunContentScript(url: string | undefined): boolean {
  if (!url) return false;

  const lower = url.toLowerCase();
  if (BLOCKED_SCHEMES.some((scheme) => lower.startsWith(scheme))) return false;

  // The Web Store is blocked by Chrome even though it is an https page.
  if (lower.startsWith('https://chromewebstore.google.com')) return false;
  if (lower.startsWith('https://chrome.google.com/webstore')) return false;

  return lower.startsWith('http://') || lower.startsWith('https://');
}
