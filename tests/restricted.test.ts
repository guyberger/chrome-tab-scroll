import { describe, expect, it } from 'vitest';
import { classifyUrl, describeUrl } from '../src/shared/restricted';

describe('classifying a tab URL', () => {
  it('treats ordinary web pages as injectable', () => {
    for (const url of [
      'https://mail.google.com/mail/u/0/#inbox',
      'https://calendar.google.com/calendar/u/0/r',
      'https://docs.google.com/document/d/abc/edit',
      'https://github.com/guyberger/chrome-tab-scroll',
      'http://127.0.0.1:8788/plain',
    ]) {
      expect(classifyUrl(url), url).toBe('injectable');
    }
  });

  it('restricts only the surfaces Chrome genuinely forbids', () => {
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
      expect(classifyUrl(url), url).toBe('restricted');
    }
  });

  // This is the direction that matters. A missing or unrecognised URL used to
  // be treated as restricted, which quietly routed ordinary pages to the
  // popup window whenever the cached URL was stale.
  it('calls anything else unknown rather than restricted', () => {
    for (const url of [undefined, '', 'file:///Users/guy/notes.html', 'ftp://example.com']) {
      expect(classifyUrl(url), String(url)).toBe('unknown');
    }
  });

  it('allows the rest of chrome.google.com, which is an ordinary site', () => {
    expect(classifyUrl('https://chrome.google.com/')).toBe('injectable');
  });

  it('is case insensitive about the scheme', () => {
    expect(classifyUrl('CHROME://settings')).toBe('restricted');
    expect(classifyUrl('HTTPS://example.com')).toBe('injectable');
  });
});

describe('describing a URL for the log', () => {
  it('keeps only scheme and host, so the log is shareable', () => {
    expect(describeUrl('https://mail.google.com/mail/u/0/#inbox')).toBe('https://mail.google.com');
    expect(describeUrl('http://127.0.0.1:8788/secret/path?q=1')).toBe('http://127.0.0.1:8788');
  });

  it('handles host-less and missing URLs', () => {
    expect(describeUrl('chrome://settings/appearance')).toBe('chrome://settings');
    expect(describeUrl('about:blank')).toBe('about:');
    expect(describeUrl(undefined)).toBe('(none)');
    expect(describeUrl('')).toBe('(none)');
  });

  it('never returns a full path for an unparseable URL', () => {
    expect(describeUrl('not a url at all/secret').length).toBeLessThanOrEqual(12);
  });
});
