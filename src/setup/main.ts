import { clearLog, formatLog, readLog } from '../background/debug-log';

/**
 * The toolbar popup.
 *
 * It does the two things a user needs and cannot do from inside the
 * extension: tell them whether the shortcut is actually assigned (Chrome
 * frequently declines to honour a suggested one) and get them to the only
 * page that can assign it. Extensions cannot set a shortcut themselves, so
 * one button to `chrome://extensions/shortcuts` is as close to one click as
 * the API allows.
 *
 * It also surfaces the diagnostic log, because the one bug that cannot be
 * reproduced by the author needs the user to be able to copy it out.
 */

const SHORTCUTS_URL = 'chrome://extensions/shortcuts';
const COMMAND = 'open-switcher';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function renderShortcut(): Promise<void> {
  const value = el('shortcut');
  const hint = el('shortcut-hint');
  try {
    const commands = await chrome.commands.getAll();
    const shortcut = commands.find((c) => c.name === COMMAND)?.shortcut;
    if (shortcut) {
      value.innerHTML = '';
      const kbd = document.createElement('kbd');
      kbd.textContent = shortcut;
      value.appendChild(kbd);
      value.className = 'value ok';
      hint.hidden = true;
    } else {
      value.textContent = 'Not set';
      value.className = 'value warn';
      hint.hidden = false;
    }
  } catch {
    value.textContent = 'Unknown';
  }
}

async function renderAccess(): Promise<void> {
  const value = el('access');
  const hint = el('access-hint');
  try {
    // Site access limited to "on click" withholds this, which stops the
    // content script running and forces the fallback window on every page.
    const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    value.textContent = granted ? 'All sites' : 'Limited';
    value.className = granted ? 'value ok' : 'value warn';
    hint.hidden = granted;
  } catch {
    value.textContent = 'Unknown';
  }
}

async function renderLog(): Promise<string> {
  const text = formatLog(await readLog());
  el('log').textContent = text;
  return text;
}

el('open-shortcuts').addEventListener('click', () => {
  void chrome.tabs.create({ url: SHORTCUTS_URL });
  window.close();
});

el('copy').addEventListener('click', async () => {
  const button = el<HTMLButtonElement>('copy');
  const report = [
    `Tab Scroll diagnostics`,
    `shortcut: ${el('shortcut').textContent}`,
    `site access: ${el('access').textContent}`,
    `userAgent: ${navigator.userAgent}`,
    '',
    await renderLog(),
  ].join('\n');

  try {
    await navigator.clipboard.writeText(report);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => (button.textContent = 'Copy diagnostics'), 1600);
});

el('clear').addEventListener('click', async () => {
  await clearLog();
  await renderLog();
});

void renderShortcut();
void renderAccess();
void renderLog();
