import { describe, expect, it } from 'vitest';
import { keydownAction, keyupAction, modifierOf } from '../src/content/keys';
import {
  DEFAULT_COMMIT_MODIFIERS,
  parseShortcutModifiers,
} from '../src/background/shortcut';

describe('moving the selection with the hotkey letter', () => {
  it('steps forward on Alt+Q', () => {
    expect(keydownAction({ key: 'q', code: 'KeyQ', altKey: true })).toEqual({
      kind: 'step',
      delta: 1,
    });
  });

  it('steps backward on Alt+Shift+Q', () => {
    expect(keydownAction({ key: 'Q', code: 'KeyQ', altKey: true, shiftKey: true })).toEqual({
      kind: 'step',
      delta: -1,
    });
  });

  // The whole reason this matches on code: Option+Q on a US Mac layout
  // reports key as "œ", and Option+Shift+Q reports "Œ".
  it('works when macOS rewrites key into a composed character', () => {
    expect(keydownAction({ key: 'œ', code: 'KeyQ', altKey: true })).toEqual({
      kind: 'step',
      delta: 1,
    });
    expect(keydownAction({ key: 'Œ', code: 'KeyQ', altKey: true, shiftKey: true })).toEqual({
      kind: 'step',
      delta: -1,
    });
  });

  it('ignores Q without the modifier, so typing is unaffected', () => {
    expect(keydownAction({ key: 'q', code: 'KeyQ' })).toBeNull();
    expect(keydownAction({ key: 'q', code: 'KeyQ', altKey: false, shiftKey: true })).toBeNull();
  });

  it('ignores a different key held with the modifier', () => {
    expect(keydownAction({ key: 'w', code: 'KeyW', altKey: true })).toBeNull();
    expect(keydownAction({ key: 'Tab', code: 'Tab', altKey: true })).toBeNull();
  });

  it('no longer treats Tab as navigation', () => {
    expect(keydownAction({ key: 'Tab', code: 'Tab' })).toBeNull();
    expect(keydownAction({ key: 'Tab', code: 'Tab', shiftKey: true })).toBeNull();
  });

  it('does nothing for every other key', () => {
    for (const key of ['Escape', 'Enter', ' ', 'ArrowRight', 'ArrowLeft', 'a', 'F5']) {
      expect(keydownAction({ key })).toBeNull();
    }
  });
});

describe('release-to-commit', () => {
  it('commits when the watched modifier is released', () => {
    expect(keyupAction({ key: 'Alt' }, ['Alt'])).toEqual({ kind: 'commit' });
  });

  it('ignores the release of any other key', () => {
    expect(keyupAction({ key: 'q' }, ['Alt'])).toBeNull();
    expect(keyupAction({ key: 'Control' }, ['Alt'])).toBeNull();
  });

  it('commits on either physical Option key on macOS', () => {
    expect(keyupAction({ key: 'Alt', code: 'AltLeft' }, ['Alt'])).toEqual({ kind: 'commit' });
    expect(keyupAction({ key: 'Alt', code: 'AltRight' }, ['Alt'])).toEqual({ kind: 'commit' });
  });

  it('does not commit when Shift is released mid-gesture', () => {
    // Option+Shift+Q then letting go of Shift first must not switch.
    expect(keyupAction({ key: 'Shift', code: 'ShiftLeft' }, ['Alt'])).toBeNull();
  });

  it('falls back to code when key is not a usable modifier name', () => {
    expect(keyupAction({ key: 'Unidentified', code: 'AltLeft' }, ['Alt'])).toEqual({
      kind: 'commit',
    });
    expect(keyupAction({ key: 'Unidentified', code: 'MetaLeft' }, ['Meta'])).toEqual({
      kind: 'commit',
    });
  });

  it('maps every modifier code to its key name', () => {
    expect(modifierOf({ key: 'x', code: 'AltLeft' })).toBe('Alt');
    expect(modifierOf({ key: 'x', code: 'ControlRight' })).toBe('Control');
    expect(modifierOf({ key: 'x', code: 'MetaLeft' })).toBe('Meta');
    expect(modifierOf({ key: 'x', code: 'OSLeft' })).toBe('Meta');
    expect(modifierOf({ key: 'x', code: 'ShiftLeft' })).toBe('Shift');
    expect(modifierOf({ key: 'x', code: 'KeyX' })).toBeUndefined();
  });
});

describe('parsing the active shortcut into commit modifiers', () => {
  it('reads the packaged default', () => {
    expect(parseShortcutModifiers('Alt+Q')).toEqual(['Alt']);
  });

  it('reads the macOS glyph Chrome reports for Option', () => {
    expect(parseShortcutModifiers('⌥Q')).toEqual(['Alt']);
  });

  it('reads other macOS glyphs', () => {
    expect(parseShortcutModifiers('⌘E')).toEqual(['Meta']);
    expect(parseShortcutModifiers('⌃E')).toEqual(['Control']);
  });

  it('reads a user rebinding', () => {
    expect(parseShortcutModifiers('Ctrl+Period')).toEqual(['Control']);
    expect(parseShortcutModifiers('MacCtrl+Q')).toEqual(['Control']);
  });

  it('drops Shift when it only decorates a real modifier', () => {
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
