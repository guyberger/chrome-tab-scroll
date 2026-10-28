import { describe, expect, it } from 'vitest';
import {
  commitTarget,
  openSession,
  removeItem,
  selectIndex,
  stepSelection,
} from '../src/background/session';
import type { SwitcherItem } from '../src/shared/types';

const item = (tabId: number): SwitcherItem => ({
  tabId,
  windowId: 10,
  title: `Tab ${tabId}`,
  url: `https://example.test/${tabId}`,
});

const items = (count: number) => Array.from({ length: count }, (_, i) => item(i + 1));

describe('switcher session', () => {
  describe('opening', () => {
    it('starts on the previously used tab so one press jumps back', () => {
      const state = openSession(items(4));

      expect(state?.selectedIndex).toBe(1);
      expect(commitTarget(state!)?.tabId).toBe(2);
    });

    it('refuses to open with nothing to switch to', () => {
      expect(openSession([])).toBeNull();
      expect(openSession(items(1))).toBeNull();
    });

    it('opens with exactly two tabs', () => {
      expect(openSession(items(2))?.selectedIndex).toBe(1);
    });
  });

  describe('cycling', () => {
    it('moves forward one tab per step', () => {
      let state = openSession(items(4))!;

      state = stepSelection(state, 1);
      expect(state.selectedIndex).toBe(2);

      state = stepSelection(state, 1);
      expect(state.selectedIndex).toBe(3);
    });

    it('wraps past the end back to the current tab', () => {
      let state = openSession(items(3))!;

      state = stepSelection(state, 1); // -> 2
      state = stepSelection(state, 1); // -> 0, wrapped

      expect(state.selectedIndex).toBe(0);
    });

    it('wraps backwards off the front', () => {
      const state = stepSelection({ items: items(3), selectedIndex: 0 }, -1);

      expect(state.selectedIndex).toBe(2);
    });

    it('handles a step larger than the list', () => {
      const state = stepSelection({ items: items(3), selectedIndex: 0 }, 7);

      expect(state.selectedIndex).toBe(1);
    });

    it('does not mutate the state it is given', () => {
      const state = openSession(items(3))!;
      const before = { ...state };

      stepSelection(state, 1);

      expect(state).toEqual(before);
    });

    it('is inert on an empty list', () => {
      const empty = { items: [], selectedIndex: 0 };

      expect(stepSelection(empty, 1)).toBe(empty);
    });
  });

  describe('direct selection', () => {
    it('jumps to a clicked index', () => {
      const state = selectIndex(openSession(items(5))!, 3);

      expect(commitTarget(state)?.tabId).toBe(4);
    });

    it('ignores out-of-range and non-integer indices', () => {
      const state = openSession(items(3))!;

      expect(selectIndex(state, -1)).toBe(state);
      expect(selectIndex(state, 3)).toBe(state);
      expect(selectIndex(state, 1.5)).toBe(state);
    });
  });

  describe('commit', () => {
    it('resolves the selected tab', () => {
      const state = stepSelection(openSession(items(4))!, 1);

      expect(commitTarget(state)).toEqual(item(3));
    });

    it('returns nothing when there is no such item', () => {
      expect(commitTarget({ items: [], selectedIndex: 0 })).toBeUndefined();
    });
  });

  describe('a tab closing mid-session', () => {
    it('removes it and keeps the selection on the same tab', () => {
      const state = { items: items(4), selectedIndex: 2 }; // tab 3 selected

      const next = removeItem(state, 1)!; // close a tab before the selection

      expect(next.items.map((i) => i.tabId)).toEqual([2, 3, 4]);
      expect(commitTarget(next)?.tabId).toBe(3);
    });

    it('clamps the selection when the last item goes away', () => {
      const state = { items: items(3), selectedIndex: 2 };

      const next = removeItem(state, 3)!;

      expect(next.selectedIndex).toBe(1);
      expect(commitTarget(next)?.tabId).toBe(2);
    });

    it('ends the session when the list empties', () => {
      expect(removeItem({ items: [item(1)], selectedIndex: 0 }, 1)).toBeNull();
    });

    it('is identity for an unrelated tab', () => {
      const state = { items: items(3), selectedIndex: 1 };

      expect(removeItem(state, 99)).toBe(state);
    });
  });
});
