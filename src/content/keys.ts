/**
 * Keyboard interpretation for an open switcher.
 *
 * The whole interaction is three things: the hotkey opens the strip, Tab and
 * Shift+Tab move the selection while the modifier is still held, and
 * releasing the modifier switches. Nothing else is bound.
 *
 * Tab is only ever claimed while the strip is open, so the page keeps normal
 * forward and reverse focus traversal at every other moment. That is what
 * makes this safe where a global Shift+Tab binding would not be.
 *
 * Both `key` and `code` are consulted. On macOS a modifier can rewrite `key`
 * into a composed character, and `code` is the layout-independent fallback.
 */

export type KeyAction = { kind: 'step'; delta: number } | null;

export interface KeyLike {
  key: string;
  code?: string;
  shiftKey?: boolean;
}

/** `code` -> the `key` value Chrome reports for that modifier. */
const MODIFIER_BY_CODE: Record<string, string> = {
  AltLeft: 'Alt',
  AltRight: 'Alt',
  ControlLeft: 'Control',
  ControlRight: 'Control',
  MetaLeft: 'Meta',
  MetaRight: 'Meta',
  OSLeft: 'Meta',
  OSRight: 'Meta',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
};

export function isTabKey(event: KeyLike): boolean {
  return event.key === 'Tab' || event.code === 'Tab';
}

export function keydownAction(event: KeyLike): KeyAction {
  if (!isTabKey(event)) return null;
  return { kind: 'step', delta: event.shiftKey ? -1 : 1 };
}

/** The modifier a key event refers to, by `key` or failing that by `code`. */
export function modifierOf(event: KeyLike): string | undefined {
  if (['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)) return event.key;
  return event.code ? MODIFIER_BY_CODE[event.code] : undefined;
}

export function keyupAction(
  event: KeyLike,
  commitModifiers: readonly string[],
): { kind: 'commit' } | null {
  const modifier = modifierOf(event);
  return modifier && commitModifiers.includes(modifier) ? { kind: 'commit' } : null;
}
