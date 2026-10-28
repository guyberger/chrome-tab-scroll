import type { SwitcherItem } from '../shared/types';

/**
 * Cache of the tab metadata the strip needs.
 *
 * The strip used to be assembled with one `chrome.tabs.get` per tile plus a
 * storage read, all awaited before the first paint. Keeping title, URL and
 * favicon here instead means a strip can be built synchronously when the
 * hotkey fires, which is the difference between a strip that appears
 * immediately and one that appears a second later.
 */

export interface TabMeta {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

export class TabIndex {
  private byId = new Map<number, TabMeta>();

  set(meta: TabMeta): void {
    this.byId.set(meta.tabId, meta);
  }

  /** Records what a `chrome.tabs.Tab` tells us, ignoring incomplete ones. */
  record(tab: {
    id?: number;
    windowId?: number;
    title?: string;
    url?: string;
    pendingUrl?: string;
    favIconUrl?: string;
  }): void {
    if (tab.id === undefined || tab.windowId === undefined) return;
    const url = tab.url || tab.pendingUrl || '';
    this.byId.set(tab.id, {
      tabId: tab.id,
      windowId: tab.windowId,
      title: tab.title || url || 'Untitled',
      url,
      favIconUrl: tab.favIconUrl,
    });
  }

  get(tabId: number): TabMeta | undefined {
    return this.byId.get(tabId);
  }

  remove(tabId: number): void {
    this.byId.delete(tabId);
  }

  setWindow(tabId: number, windowId: number): void {
    const meta = this.byId.get(tabId);
    if (meta) meta.windowId = windowId;
  }

  /** Follows a tab id swap from `tabs.onReplaced`. */
  replace(addedTabId: number, removedTabId: number): void {
    const meta = this.byId.get(removedTabId);
    if (!meta) return;
    this.byId.delete(removedTabId);
    this.byId.set(addedTabId, { ...meta, tabId: addedTabId });
  }

  retain(liveTabIds: Iterable<number>): void {
    const live = new Set(liveTabIds);
    for (const tabId of [...this.byId.keys()]) {
      if (!live.has(tabId)) this.byId.delete(tabId);
    }
  }

  /** The strip payload for a tab, or undefined if it is not known yet. */
  toItem(tabId: number): SwitcherItem | undefined {
    const meta = this.byId.get(tabId);
    if (!meta) return undefined;
    return {
      tabId: meta.tabId,
      windowId: meta.windowId,
      title: meta.title,
      favIconUrl: meta.favIconUrl,
    };
  }

  toJSON(): TabMeta[] {
    return [...this.byId.values()];
  }

  static fromJSON(value: unknown): TabIndex {
    const index = new TabIndex();
    if (!Array.isArray(value)) return index;
    for (const meta of value as Partial<TabMeta>[]) {
      if (Number.isInteger(meta?.tabId) && Number.isInteger(meta?.windowId)) {
        index.set({
          tabId: meta.tabId as number,
          windowId: meta.windowId as number,
          title: meta.title ?? 'Untitled',
          url: meta.url ?? '',
          favIconUrl: meta.favIconUrl,
        });
      }
    }
    return index;
  }
}
