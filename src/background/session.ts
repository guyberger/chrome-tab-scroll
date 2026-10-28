import type { SessionState, SwitcherItem } from '../shared/types';

/**
 * Switcher selection logic. Pure functions over an immutable state object so
 * cycling, commit and cancel can be tested without a browser.
 */

/**
 * Opens a session over `items` (index 0 is the current tab).
 *
 * Selection starts at index 1 — the previously used tab — so a single
 * press-and-release jumps straight back, the way Alt+Tab and Firefox's
 * Ctrl+Tab behave. Returns `null` when there is nothing to switch to.
 */
export function openSession(items: SwitcherItem[]): SessionState | null {
  if (items.length < 2) return null;
  return { items, selectedIndex: 1 };
}

/** Moves the selection by `delta`, wrapping at both ends. */
export function stepSelection(state: SessionState, delta: number): SessionState {
  const count = state.items.length;
  if (count === 0) return state;
  const next = (((state.selectedIndex + delta) % count) + count) % count;
  return { ...state, selectedIndex: next };
}

/** Jumps the selection straight to `index`, ignoring out-of-range values. */
export function selectIndex(state: SessionState, index: number): SessionState {
  if (!Number.isInteger(index) || index < 0 || index >= state.items.length) {
    return state;
  }
  return { ...state, selectedIndex: index };
}

/** The item a commit would switch to, or `undefined` if the state is empty. */
export function commitTarget(state: SessionState): SwitcherItem | undefined {
  return state.items[state.selectedIndex];
}

/** Drops a closed tab mid-session, keeping the selection on a sensible item. */
export function removeItem(state: SessionState, tabId: number): SessionState | null {
  const index = state.items.findIndex((item) => item.tabId === tabId);
  if (index === -1) return state;

  const items = state.items.filter((item) => item.tabId !== tabId);
  if (items.length === 0) return null;

  let selectedIndex = state.selectedIndex;
  if (index < selectedIndex) selectedIndex -= 1;
  if (selectedIndex >= items.length) selectedIndex = items.length - 1;
  return { items, selectedIndex };
}
