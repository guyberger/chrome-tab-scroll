/**
 * Keyboard interpretation for an open switcher, kept separate from the DOM so
 * the rules can be tested directly.
 *
 * Note that the shortcut that opens the strip never reaches here: Chrome
 * handles `chrome.commands` bindings itself and does not dispatch them to the
 * page. What the page does still see is the modifier being released, which is
 * what makes release-to-commit possible at all.
 */

export type KeyAction =
  | { kind: 'commit' }
  | { kind: 'cancel' }
  | { kind: 'step'; delta: number }
  | null;

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
}

export function keydownAction(event: KeyLike): KeyAction {
  switch (event.key) {
    case 'Escape':
      return { kind: 'cancel' };
    case 'Enter':
    case ' ':
      return { kind: 'commit' };
    case 'ArrowRight':
    case 'ArrowDown':
      return { kind: 'step', delta: 1 };
    case 'ArrowLeft':
    case 'ArrowUp':
      return { kind: 'step', delta: -1 };
    case 'Tab':
      // Safe to claim only because the strip is already open and modal; the
      // extension never binds Tab globally, so ordinary focus traversal and
      // reverse traversal on the page are untouched.
      return { kind: 'step', delta: event.shiftKey ? -1 : 1 };
    default:
      return null;
  }
}

export function keyupAction(event: KeyLike, commitModifiers: readonly string[]): KeyAction {
  return commitModifiers.includes(event.key) ? { kind: 'commit' } : null;
}
