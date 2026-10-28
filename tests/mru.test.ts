import { describe, expect, it } from 'vitest';
import { MruTracker } from '../src/background/mru';

const ids = (tracker: MruTracker, windowId?: number) =>
  (windowId === undefined ? tracker.list() : tracker.listForWindow(windowId)).map((e) => e.tabId);

describe('MruTracker', () => {
  describe('activation', () => {
    it('puts the most recently activated tab first', () => {
      const mru = new MruTracker();
      mru.touch(1, 10);
      mru.touch(2, 10);
      mru.touch(3, 10);

      expect(ids(mru)).toEqual([3, 2, 1]);
    });

    it('promotes a tab that is activated again instead of duplicating it', () => {
      const mru = new MruTracker();
      mru.touch(1, 10);
      mru.touch(2, 10);
      mru.touch(3, 10);
      mru.touch(1, 10);

      expect(ids(mru)).toEqual([1, 3, 2]);
    });

    it('treats the second entry as the "switch back" target', () => {
      const mru = new MruTracker();
      mru.touch(1, 10);
      mru.touch(2, 10);

      // Index 0 is where you are; index 1 is where Alt+Q should take you.
      expect(ids(mru)[1]).toBe(1);
    });

    it('keeps seeded tabs behind genuinely used ones', () => {
      const mru = new MruTracker();
      mru.append(1, 10);
      mru.append(2, 10);
      mru.touch(3, 10);

      expect(ids(mru)).toEqual([3, 1, 2]);
    });

    it('ignores a repeated append for a known tab', () => {
      const mru = new MruTracker();
      mru.touch(1, 10);
      mru.append(1, 10);

      expect(ids(mru)).toEqual([1]);
    });
  });

  describe('closing tabs', () => {
    it('drops a closed tab from the order', () => {
      const mru = new MruTracker();
      mru.touch(1, 10);
      mru.touch(2, 10);
      mru.touch(3, 10);

      mru.remove(2);

      expect(ids(mru)).toEqual([3, 1]);
      expect(mru.has(2)).toBe(false);
    });

    it('is a no-op when closing an unknown tab', () => {
      const mru = new MruTracker();
      mru.touch(1, 10);

      mru.remove(42);

      expect(ids(mru)).toEqual([1]);
    });

    it('drops every tab belonging to a closed window', () => {
      const mru = new MruTracker();
      mru.touch(1, 10);
      mru.touch(2, 20);
      mru.touch(3, 10);

      mru.removeWindow(10);

      expect(ids(mru)).toEqual([2]);
    });

    it('retains only tabs that still exist', () => {
      const mru = new MruTracker();
      mru.touch(1, 10);
      mru.touch(2, 10);
      mru.touch(3, 10);

      mru.retain([1, 3]);

      expect(ids(mru)).toEqual([3, 1]);
    });
  });

  describe('multiple windows', () => {
    it('reports a per-window order without disturbing the global one', () => {
      const mru = new MruTracker();
      mru.touch(1, 10);
      mru.touch(2, 20);
      mru.touch(3, 10);
      mru.touch(4, 20);

      expect(ids(mru, 10)).toEqual([3, 1]);
      expect(ids(mru, 20)).toEqual([4, 2]);
      expect(ids(mru)).toEqual([4, 3, 2, 1]);
    });

    it('returns an empty list for a window with no tabs', () => {
      const mru = new MruTracker();
      mru.touch(1, 10);

      expect(ids(mru, 999)).toEqual([]);
    });

    it('follows a tab dragged into another window', () => {
      const mru = new MruTracker();
      mru.touch(1, 10);
      mru.touch(2, 20);

      mru.reassign(1, 20);

      expect(ids(mru, 10)).toEqual([]);
      expect(ids(mru, 20)).toEqual([2, 1]);
    });

    it('keeps a tab in place when Chrome swaps its id', () => {
      const mru = new MruTracker();
      mru.touch(1, 10);
      mru.touch(2, 10);

      mru.replace(7, 2);

      expect(ids(mru)).toEqual([7, 1]);
    });
  });

  describe('persistence', () => {
    it('round-trips through JSON', () => {
      const mru = new MruTracker();
      mru.touch(1, 10);
      mru.touch(2, 20);

      const restored = MruTracker.fromJSON(JSON.parse(JSON.stringify(mru.toJSON())));

      expect(restored.list()).toEqual(mru.list());
    });

    it('tolerates missing or malformed stored state', () => {
      expect(MruTracker.fromJSON(undefined).list()).toEqual([]);
      expect(
        MruTracker.fromJSON([
          { tabId: 1, windowId: 10 },
          { tabId: NaN, windowId: 10 } as never,
          null as never,
        ]).list(),
      ).toEqual([{ tabId: 1, windowId: 10 }]);
    });

    it('hands out copies so callers cannot mutate internal state', () => {
      const mru = new MruTracker();
      mru.touch(1, 10);

      mru.list().push({ tabId: 99, windowId: 10 });

      expect(ids(mru)).toEqual([1]);
    });
  });
});
