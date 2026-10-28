import { describe, expect, it } from 'vitest';
import { isTabKey, keydownAction, keyupAction, modifierOf } from '../src/content/keys';
import {
  DEFAULT_COMMIT_MODIFIERS,
  parseShortcutModifiers,
} from '../src/background/shortcut';

describe('moving the selection', () => {
  it('steps forward on Tab and backward on Shift+Tab', () => {
    expect(keydownAction({ key: 'Tab' })).toEqual({ kind: 'step', delta: 1 });
    expect(keydownAction({ key: 'Tab', shiftKey: true })).toEqual({ kind: 'step', delta: -1 });
  });

  it('recognises Tab by code when the layout rewrites key', () => {
    expect(keydownAction({ key: 'Unidentified', code: 'Tab' })).toEqual({ kind: 'step', delta: 1 });
    expect(isTabKey({ key: 'x', code: 'Tab' })).toBe(true);
    expect(isTabKey({ key: 'x', code: 'KeyX' })).toBe(false);
  });

  it('does nothing for every other key', () => {
    // Everything is swallowed while the strip is open, but only Tab acts.
    for (const key of ['Escape', 'Enter', ' ', 'ArrowRight', 'ArrowLeft', 'a', 'F5']) {
      expect(keydownAction({ key })).toBeNull();
    }
  });

  it('ignores a macOS Option-composed character', () => {
    // Option+Q on a US Mac layout reports key "œ".
    expect(keydownAction({ key: 'œ', code: 'KeyQ' })).toBeNull();
  });
});

describe('release-to-commit', () => {
  it('commits when the watched modifier is released', () => {
    expect(keyupAction({ key: 'Alt' }, ['Alt'])).toEqual({ kind: 'commit' });
  });

  it('ignores the release of any other key', () => {
    expect(keyupAction({ key: 'q' }, ['Alt'])).toBeNull();
    expect(keyupAction({ key: 'Control' }, ['Alt'])).toBeNull();
    expect(keyupAction({ key: 'Tab' }, ['Alt'])).toBeNull();
  });

  it('commits on either physical Option key on macOS', () => {
    // Chrome reports key "Alt" for Option, and code distinguishes the sides.
    expect(keyupAction({ key: 'Alt', code: 'AltLeft' }, ['Alt'])).toEqual({ kind: 'commit' });
    expect(keyupAction({ key: 'Alt', code: 'AltRight' }, ['Alt'])).toEqual({ kind: 'commit' });
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

  it('prefers key over code when key is already a modifier', () => {
    expect(modifierOf({ key: 'Meta', code: 'AltLeft' })).toBe('Meta');
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
    // Releasing Shift first is common and must not fire a switch.
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
