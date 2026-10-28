import { describe, expect, it } from 'vitest';
import { keydownAction, keyupAction } from '../src/content/keys';
import {
  DEFAULT_COMMIT_MODIFIERS,
  parseShortcutModifiers,
} from '../src/background/shortcut';

describe('keydown handling while the strip is open', () => {
  it('cancels on Escape', () => {
    expect(keydownAction({ key: 'Escape' })).toEqual({ kind: 'cancel' });
  });

  it('commits on Enter and Space', () => {
    expect(keydownAction({ key: 'Enter' })).toEqual({ kind: 'commit' });
    expect(keydownAction({ key: ' ' })).toEqual({ kind: 'commit' });
  });

  it('steps with the arrow keys', () => {
    expect(keydownAction({ key: 'ArrowRight' })).toEqual({ kind: 'step', delta: 1 });
    expect(keydownAction({ key: 'ArrowLeft' })).toEqual({ kind: 'step', delta: -1 });
  });

  it('steps with Tab and reverses with Shift+Tab', () => {
    expect(keydownAction({ key: 'Tab' })).toEqual({ kind: 'step', delta: 1 });
    expect(keydownAction({ key: 'Tab', shiftKey: true })).toEqual({ kind: 'step', delta: -1 });
  });

  it('leaves every other key to the page', () => {
    for (const key of ['a', 'F5', 'Backspace', 'Home', 'PageDown']) {
      expect(keydownAction({ key })).toBeNull();
    }
  });
});

describe('release-to-commit', () => {
  it('commits when a watched modifier is released', () => {
    expect(keyupAction({ key: 'Alt' }, ['Alt'])).toEqual({ kind: 'commit' });
  });

  it('ignores the release of any other key', () => {
    expect(keyupAction({ key: 'Q' }, ['Alt'])).toBeNull();
    expect(keyupAction({ key: 'Control' }, ['Alt'])).toBeNull();
  });

  it('honours a rebound shortcut with a different modifier', () => {
    expect(keyupAction({ key: 'Control' }, ['Control'])).toEqual({ kind: 'commit' });
  });
});

describe('parsing the active shortcut into commit modifiers', () => {
  it('reads the packaged default', () => {
    expect(parseShortcutModifiers('Alt+Q')).toEqual(['Alt']);
  });

  it('reads a user rebinding', () => {
    expect(parseShortcutModifiers('Ctrl+Period')).toEqual(['Control']);
  });

  it('reads macOS glyph spellings', () => {
    expect(parseShortcutModifiers('⌥Q')).toEqual(['Alt']);
    expect(parseShortcutModifiers('⌘E')).toEqual(['Meta']);
  });

  it('drops Shift when it only decorates a real modifier', () => {
    // Releasing Shift first is common and should not fire a switch.
    expect(parseShortcutModifiers('Alt+Shift+Q')).toEqual(['Alt']);
    expect(parseShortcutModifiers('⌥⇧Q')).toEqual(['Alt']);
  });

  it('keeps both modifiers of a two-modifier binding', () => {
    expect(parseShortcutModifiers('Ctrl+Alt+Q').sort()).toEqual(['Alt', 'Control']);
  });

  it('falls back to Alt for an unbound or unparseable command', () => {
    expect(parseShortcutModifiers(undefined)).toEqual(DEFAULT_COMMIT_MODIFIERS);
    expect(parseShortcutModifiers('')).toEqual(DEFAULT_COMMIT_MODIFIERS);
    expect(parseShortcutModifiers('Q')).toEqual(DEFAULT_COMMIT_MODIFIERS);
  });
});
