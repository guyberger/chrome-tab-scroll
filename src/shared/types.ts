/** A tab as shown in the switcher strip. */
export interface SwitcherItem {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  favIconUrl?: string;
  /** JPEG data URL of a downscaled capture, if one has been taken. */
  thumbnail?: string;
}

/** Immutable state of an open switcher session. */
export interface SessionState {
  items: SwitcherItem[];
  selectedIndex: number;
}

/** Messages the background sends to an overlay (content script or fallback popup). */
export type ToOverlayMessage =
  | {
      type: 'SHOW';
      items: SwitcherItem[];
      selectedIndex: number;
      /** KeyboardEvent.key values whose release commits the selection. */
      commitModifiers: string[];
    }
  | { type: 'UPDATE'; selectedIndex: number }
  | { type: 'HIDE' };

/** Messages an overlay sends back to the background. */
export type FromOverlayMessage =
  | { type: 'COMMIT'; index?: number }
  | { type: 'CANCEL' }
  | { type: 'STEP'; delta: number }
  | { type: 'GET_SESSION' };

export const MAX_ITEMS = 6;
