import type { SessionState, SwitcherItem } from '../shared/types';

/**
 * Switcher selection logic. Pure functions over an immutable state object so
 * stepping and commit resolution can be tested without a browser.
 */

/**
 * Opens a session over `items` (index 0 is the current tab).
 *
 * Selection starts at index 1 — the previously used tab — so releasing the
 * modifier straight away jumps back, the way Alt+Tab and Firefox behave.
 * Returns `null` when there is nothing to switch to.
 */
export function openSession(epoch: number, items: SwitcherItem[]): SessionState | null {
  if (items.length < 2) return null;
  return { epoch, items, selectedIndex: 1 };
}

/** Moves the selection by `delta`, wrapping at both ends. */
export function stepSelection(state: SessionState, delta: number): SessionState {
  const count = state.items.length;
  if (count === 0) return state;
  const next = (((state.selectedIndex + delta) % count) + count) % count;
  return { ...state, selectedIndex: next };
}

/** The currently highlighted item. */
export function selectedItem(state: SessionState): SwitcherItem | undefined {
  return state.items[state.selectedIndex];
}

/**
 * Resolves a commit request to a tab.
 *
 * The overlay reports the tab it had highlighted rather than an index, and
 * this only honours it if that tab is still part of the session. Index-based
 * commits were what allowed a stale or re-ordered session to switch to the
 * wrong tab.
 */
export function resolveCommit(
  state: SessionState,
  tabId: number,
): SwitcherItem | undefined {
  return state.items.find((item) => item.tabId === tabId);
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
  return { ...state, items, selectedIndex };
}
