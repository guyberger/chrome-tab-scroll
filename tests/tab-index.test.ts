import { describe, expect, it } from 'vitest';
import { TabIndex } from '../src/background/tab-index';

const tab = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  windowId: 10,
  title: `Tab ${id}`,
  url: `https://example.test/${id}`,
  ...extra,
});

describe('TabIndex', () => {
  it('records what the strip needs and drops the rest', () => {
    const index = new TabIndex();
    index.record(tab(1, { favIconUrl: 'https://example.test/f.ico' }));

    expect(index.toItem(1)).toEqual({
      tabId: 1,
      windowId: 10,
      title: 'Tab 1',
      favIconUrl: 'https://example.test/f.ico',
    });
  });

  it('ignores a tab with no id or window', () => {
    const index = new TabIndex();
    index.record({ title: 'orphan' });
    index.record({ id: 5, title: 'no window' });

    expect(index.toItem(5)).toBeUndefined();
  });

  it('falls back to the URL, then a placeholder, for a missing title', () => {
    const index = new TabIndex();
    index.record({ id: 1, windowId: 10, url: 'https://example.test/x' });
    index.record({ id: 2, windowId: 10 });

    expect(index.toItem(1)?.title).toBe('https://example.test/x');
    expect(index.toItem(2)?.title).toBe('Untitled');
  });

  it('uses pendingUrl while a tab is still navigating', () => {
    const index = new TabIndex();
    index.record({ id: 1, windowId: 10, pendingUrl: 'https://example.test/soon' });

    expect(index.get(1)?.url).toBe('https://example.test/soon');
  });

  it('overwrites on a later update', () => {
    const index = new TabIndex();
    index.record(tab(1));
    index.record(tab(1, { title: 'Renamed' }));

    expect(index.toItem(1)?.title).toBe('Renamed');
  });

  it('follows a tab into another window', () => {
    const index = new TabIndex();
    index.record(tab(1));
    index.setWindow(1, 20);

    expect(index.toItem(1)?.windowId).toBe(20);
  });

  it('follows an id swap from onReplaced', () => {
    const index = new TabIndex();
    index.record(tab(1));
    index.replace(7, 1);

    expect(index.get(1)).toBeUndefined();
    expect(index.toItem(7)?.tabId).toBe(7);
    expect(index.toItem(7)?.title).toBe('Tab 1');
  });

  it('forgets tabs that no longer exist', () => {
    const index = new TabIndex();
    index.record(tab(1));
    index.record(tab(2));
    index.retain([2]);

    expect(index.get(1)).toBeUndefined();
    expect(index.get(2)).toBeDefined();
  });

  it('round-trips through JSON and tolerates junk', () => {
    const index = new TabIndex();
    index.record(tab(1));
    const restored = TabIndex.fromJSON(JSON.parse(JSON.stringify(index.toJSON())));

    expect(restored.toItem(1)).toEqual(index.toItem(1));
    expect(TabIndex.fromJSON(undefined).toItem(1)).toBeUndefined();
    expect(TabIndex.fromJSON([null, { tabId: 'x' }]).toItem(1)).toBeUndefined();
  });
});
