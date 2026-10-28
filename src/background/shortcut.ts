/**
 * Turns a `chrome.commands` shortcut string into the `KeyboardEvent.key`
 * values whose release should commit the selection.
 *
 * Chrome reports bindings as `"Alt+Q"` on Windows/Linux/ChromeOS and as glyphs
 * such as `"⌥Q"` or `"⌘⇧Q"` on macOS, so both spellings are handled. The result
 * is what the overlay watches on `keyup` to implement release-to-commit, which
 * is why it has to follow whatever the user rebound the command to rather than
 * assuming the packaged default.
 */

const WORD_MODIFIERS: Record<string, string> = {
  alt: 'Alt',
  option: 'Alt',
  ctrl: 'Control',
  control: 'Control',
  macctrl: 'Control',
  command: 'Meta',
  cmd: 'Meta',
  search: 'Meta',
  shift: 'Shift',
};

const GLYPH_MODIFIERS: Record<string, string> = {
  '⌥': 'Alt',
  '⌃': 'Control',
  '⌘': 'Meta',
  '⇧': 'Shift',
};

/** Default used when a command is unbound or the binding cannot be parsed. */
export const DEFAULT_COMMIT_MODIFIERS = ['Alt'];

export function parseShortcutModifiers(shortcut: string | undefined): string[] {
  if (!shortcut) return [...DEFAULT_COMMIT_MODIFIERS];

  const found = new Set<string>();

  for (const [glyph, key] of Object.entries(GLYPH_MODIFIERS)) {
    if (shortcut.includes(glyph)) found.add(key);
  }

  for (const part of shortcut.split('+')) {
    const key = WORD_MODIFIERS[part.trim().toLowerCase()];
    if (key) found.add(key);
  }

  // Shift is never the only modifier on a real binding (Chrome requires Ctrl or
  // Alt), and committing on a stray Shift release would be hair-trigger.
  if (found.size > 1) found.delete('Shift');

  return found.size > 0 ? [...found] : [...DEFAULT_COMMIT_MODIFIERS];
}
