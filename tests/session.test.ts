import { describe, expect, it } from 'vitest';
import {
  openSession,
  removeItem,
  resolveCommit,
  selectedItem,
  stepSelection,
} from '../src/background/session';
import type { SwitcherItem } from '../src/shared/types';

const item = (tabId: number): SwitcherItem => ({
  tabId,
  windowId: 10,
  title: `Tab ${tabId}`,
});

const items = (count: number) => Array.from({ length: count }, (_, i) => item(i + 1));

describe('opening a session', () => {
  it('starts on the previous tab so a press-and-release jumps back', () => {
    const state = openSession(1, items(4));

    expect(state?.selectedIndex).toBe(1);
    expect(selectedItem(state!)?.tabId).toBe(2);
  });

  it('refuses to open with nothing to switch to', () => {
    expect(openSession(1, [])).toBeNull();
    expect(openSession(1, items(1))).toBeNull();
  });

  it('opens with exactly two tabs', () => {
    expect(openSession(1, items(2))?.selectedIndex).toBe(1);
  });

  it('carries the epoch it was opened with', () => {
    expect(openSession(7, items(3))?.epoch).toBe(7);
  });
});

describe('stepping with Tab', () => {
  it('moves forward one tab per step', () => {
    let state = openSession(1, items(4))!;

    state = stepSelection(state, 1);
    expect(state.selectedIndex).toBe(2);

    state = stepSelection(state, 1);
    expect(state.selectedIndex).toBe(3);
  });

  it('wraps past the end back to the current tab', () => {
    let state = openSession(1, items(3))!;
    state = stepSelection(state, 1); // -> 2
    state = stepSelection(state, 1); // -> 0, wrapped

    expect(state.selectedIndex).toBe(0);
  });

  it('wraps backwards off the front for Shift+Tab', () => {
    expect(stepSelection({ epoch: 1, items: items(3), selectedIndex: 0 }, -1).selectedIndex).toBe(2);
  });

  it('preserves the epoch while stepping', () => {
    expect(stepSelection(openSession(9, items(3))!, 1).epoch).toBe(9);
  });

  it('does not mutate the state it is given', () => {
    const state = openSession(1, items(3))!;
    const before = { ...state };

    stepSelection(state, 1);

    expect(state).toEqual(before);
  });

  it('is inert on an empty list', () => {
    const empty = { epoch: 1, items: [], selectedIndex: 0 };
    expect(stepSelection(empty, 1)).toBe(empty);
  });
});

describe('resolving a commit', () => {
  // The overlay reports the tab it highlighted, never an index, so a session
  // that changed underneath cannot redirect the commit to a neighbour.
  it('returns the tab that was asked for', () => {
    const state = openSession(1, items(4))!;

    expect(resolveCommit(state, 3)).toEqual(item(3));
  });

  it('commits the highlighted tile after stepping', () => {
    const state = stepSelection(stepSelection(openSession(1, items(4))!, 1), 1);
    const highlighted = selectedItem(state)!;

    expect(resolveCommit(state, highlighted.tabId)?.tabId).toBe(4);
  });

  it('still finds the right tab after an earlier tile is removed', () => {
    // Indices shift here; the tab id does not.
    const state = removeItem({ epoch: 1, items: items(4), selectedIndex: 2 }, 1)!;
    const highlighted = selectedItem(state)!;

    expect(highlighted.tabId).toBe(3);
    expect(resolveCommit(state, 3)?.tabId).toBe(3);
  });

  it('refuses a tab that is not part of the session', () => {
    expect(resolveCommit(openSession(1, items(3))!, 99)).toBeUndefined();
  });
});

describe('a tab closing mid-session', () => {
  it('removes it and keeps the selection on the same tab', () => {
    const state = { epoch: 1, items: items(4), selectedIndex: 2 }; // tab 3 selected

    const next = removeItem(state, 1)!;

    expect(next.items.map((i) => i.tabId)).toEqual([2, 3, 4]);
    expect(selectedItem(next)?.tabId).toBe(3);
  });

  it('clamps the selection when the last item goes away', () => {
    const next = removeItem({ epoch: 1, items: items(3), selectedIndex: 2 }, 3)!;

    expect(next.selectedIndex).toBe(1);
    expect(selectedItem(next)?.tabId).toBe(2);
  });

  it('ends the session when the list empties', () => {
    expect(removeItem({ epoch: 1, items: [item(1)], selectedIndex: 0 }, 1)).toBeNull();
  });

  it('is identity for an unrelated tab', () => {
    const state = { epoch: 1, items: items(3), selectedIndex: 1 };
    expect(removeItem(state, 99)).toBe(state);
  });
});
