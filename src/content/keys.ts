/**
 * Keyboard interpretation for an open switcher.
 *
 * The whole interaction is three things: the hotkey opens the strip, tapping
 * the hotkey's letter again moves the selection while the modifier is still
 * held, and releasing the modifier switches. Nothing else is bound.
 *
 * Everything matches on `event.code`, never `event.key`. On macOS
 * Option+Q reports `key` as "œ" — the Option key composes characters — while
 * `code` stays `KeyQ` regardless of layout or modifier.
 */

export type KeyAction = { kind: 'step'; delta: number } | null;

export interface KeyLike {
  key: string;
  code?: string;
  altKey?: boolean;
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

/**
 * Another tap of the hotkey letter, with the modifier still down, moves the
 * selection; adding Shift moves it backward.
 *
 * In practice Chrome usually swallows this itself and delivers it as a
 * command instead, so this is the path for when the page does see the key.
 * The background collapses an exact repeat arriving from both at once.
 */
export function keydownAction(event: KeyLike): KeyAction {
  if (event.code !== 'KeyQ' || !event.altKey) return null;
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
