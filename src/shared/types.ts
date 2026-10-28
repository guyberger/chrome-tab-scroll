/** A tab as shown in the switcher strip. Deliberately small: this payload is
 *  on the critical path between the keypress and the first paint, so
 *  thumbnails are sent separately once the strip is already on screen. */
export interface SwitcherItem {
  tabId: number;
  windowId: number;
  title: string;
  favIconUrl?: string;
}

/** Immutable state of an open switcher session. */
export interface SessionState {
  /** Incremented per session; stale overlays are ignored by comparing it. */
  epoch: number;
  items: SwitcherItem[];
  selectedIndex: number;
}

export type ToOverlayMessage =
  | {
      type: 'SHOW';
      epoch: number;
      items: SwitcherItem[];
      selectedIndex: number;
      /** KeyboardEvent.key values whose release commits the selection. */
      commitModifiers: string[];
    }
  | {
      type: 'THUMBS';
      epoch: number;
      /** tabId -> bare base64, no data: prefix. */
      thumbs: Record<number, string>;
      mime: string;
    }
  | { type: 'UPDATE'; epoch: number; selectedIndex: number }
  | { type: 'HIDE'; epoch: number };

export type FromOverlayMessage =
  | { type: 'STEP'; epoch: number; delta: number }
  /** Carries the tab itself, never an index, so the committed tab is always
   *  exactly the highlighted tile even if the session changed underneath. */
  | { type: 'COMMIT'; epoch: number; tabId: number }
  | { type: 'GET_SESSION' };

export const MAX_ITEMS = 6;
