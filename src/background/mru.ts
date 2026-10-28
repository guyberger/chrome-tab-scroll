/**
 * Most-recently-used tab ordering.
 *
 * Pure data structure with no `chrome.*` calls so it can be unit tested
 * directly. The background service worker drives it from tab/window events
 * and persists `toJSON()` after every mutation, because an MV3 service worker
 * can be torn down between events.
 */

export interface MruEntry {
  tabId: number;
  windowId: number;
}

export class MruTracker {
  /** Most recent first. */
  private order: MruEntry[] = [];

  /** Marks a tab as the most recently used, inserting it if unknown. */
  touch(tabId: number, windowId: number): void {
    this.order = this.order.filter((e) => e.tabId !== tabId);
    this.order.unshift({ tabId, windowId });
  }

  /**
   * Records a tab without promoting it to the front. Used when seeding from
   * `tabs.query()` at startup, where real usage order is unknown.
   */
  append(tabId: number, windowId: number): void {
    if (this.order.some((e) => e.tabId === tabId)) return;
    this.order.push({ tabId, windowId });
  }

  remove(tabId: number): void {
    this.order = this.order.filter((e) => e.tabId !== tabId);
  }

  removeWindow(windowId: number): void {
    this.order = this.order.filter((e) => e.windowId !== windowId);
  }

  /** Handles a tab being dragged into another window (`tabs.onAttached`). */
  reassign(tabId: number, windowId: number): void {
    const entry = this.order.find((e) => e.tabId === tabId);
    if (entry) entry.windowId = windowId;
  }

  /** Handles prerender/back-forward-cache tab swaps (`tabs.onReplaced`). */
  replace(addedTabId: number, removedTabId: number): void {
    const entry = this.order.find((e) => e.tabId === removedTabId);
    if (entry) entry.tabId = addedTabId;
  }

  has(tabId: number): boolean {
    return this.order.some((e) => e.tabId === tabId);
  }

  /** Full MRU order across every window, most recent first. */
  list(): MruEntry[] {
    return [...this.order];
  }

  /** MRU order restricted to one window, most recent first. */
  listForWindow(windowId: number): MruEntry[] {
    return this.order.filter((e) => e.windowId === windowId);
  }

  /** Drops entries for tabs that no longer exist. */
  retain(liveTabIds: Iterable<number>): void {
    const live = new Set(liveTabIds);
    this.order = this.order.filter((e) => live.has(e.tabId));
  }

  toJSON(): MruEntry[] {
    return this.list();
  }

  /** Rebuilds from whatever `storage.session` held, discarding junk. */
  static fromJSON(value: unknown): MruTracker {
    const tracker = new MruTracker();
    if (!Array.isArray(value)) return tracker;
    for (const entry of value as Partial<MruEntry>[]) {
      if (Number.isInteger(entry?.tabId) && Number.isInteger(entry?.windowId)) {
        tracker.order.push({ tabId: entry.tabId as number, windowId: entry.windowId as number });
      }
    }
    return tracker;
  }
}
