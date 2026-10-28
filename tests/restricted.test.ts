import { describe, expect, it } from 'vitest';
import { canRunContentScript } from '../src/shared/restricted';

describe('deciding between the in-page overlay and the fallback window', () => {
  it('allows ordinary web pages, including the sites this was failing on', () => {
    for (const url of [
      'https://mail.google.com/mail/u/0/#inbox',
      'https://calendar.google.com/calendar/u/0/r',
      'https://docs.google.com/document/d/abc/edit',
      'https://github.com/guyberger/chrome-tab-scroll',
      'http://127.0.0.1:8788/plain',
    ]) {
      expect(canRunContentScript(url), url).toBe(true);
    }
  });

  it('rejects the surfaces Chrome genuinely forbids', () => {
    for (const url of [
      'chrome://settings/appearance',
      'chrome://new-tab-page/',
      'chrome-untrusted://foo',
      'devtools://devtools/bundled/inspector.html',
      'view-source:https://example.com',
      'about:blank',
      'chrome-extension://abcdef/popup.html',
      'edge://settings',
      'https://chromewebstore.google.com/detail/foo',
      'https://chrome.google.com/webstore/detail/foo',
    ]) {
      expect(canRunContentScript(url), url).toBe(false);
    }
  });

  it('allows the rest of chrome.google.com, which is an ordinary site', () => {
    expect(canRunContentScript('https://chrome.google.com/')).toBe(true);
  });

  it('rejects a missing or non-http URL', () => {
    expect(canRunContentScript(undefined)).toBe(false);
    expect(canRunContentScript('')).toBe(false);
    expect(canRunContentScript('ftp://example.com')).toBe(false);
    expect(canRunContentScript('data:text/html,hi')).toBe(false);
  });

  it('is case insensitive about the scheme', () => {
    expect(canRunContentScript('CHROME://settings')).toBe(false);
    expect(canRunContentScript('HTTPS://example.com')).toBe(true);
  });
});
