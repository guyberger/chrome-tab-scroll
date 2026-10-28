import { OverlayView } from './overlay';
import { keydownAction, keyupAction } from './keys';
import type { FromOverlayMessage, ToOverlayMessage } from '../shared/types';

/**
 * Content-script host for the switcher strip.
 *
 * The overlay is built as soon as this script runs and then kept warm, so a
 * keypress only has to fill in cards and unhide an element that is already
 * attached and styled.
 *
 * While the strip is open every key event is swallowed. That keeps Tab and
 * Shift+Tab for moving the selection, and stops anything else — in
 * particular a modifier-composed character such as macOS Option+Q's "oe" —
 * from reaching the page. Listeners are only attached while the strip is
 * open, so the page behaves completely normally the rest of the time.
 */

const HOST_ID = 'chrome-tab-scroll-overlay-host';

let overlay: OverlayView | null = null;
let hostElement: HTMLElement | null = null;
let commitModifiers: string[] = [];
let epoch = -1;

function send(message: FromOverlayMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => {
    // Background went away; nothing useful to do from here.
  });
}

function ensureOverlay(): OverlayView {
  if (overlay && hostElement?.isConnected) return overlay;

  hostElement = document.createElement('div');
  hostElement.id = HOST_ID;
  hostElement.style.cssText = 'all: initial;';
  const root = hostElement.attachShadow({ mode: 'closed' });
  overlay = new OverlayView(root);
  document.documentElement.appendChild(hostElement);
  return overlay;
}

function commit(): void {
  const tabId = overlay?.selectedTabId();
  if (tabId !== undefined) send({ type: 'COMMIT', epoch, tabId });
  close();
}

function close(): void {
  detachListeners();
  overlay?.hide();
}

function onKeydown(event: KeyboardEvent): void {
  // Modal: the page sees nothing while the strip is up.
  event.preventDefault();
  event.stopImmediatePropagation();

  const action = keydownAction(event);
  if (action) send({ type: 'STEP', epoch, delta: action.delta });
}

function onKeyup(event: KeyboardEvent): void {
  if (keyupAction(event, commitModifiers)?.kind === 'commit') {
    event.preventDefault();
    event.stopImmediatePropagation();
    commit();
  }
}

/**
 * If focus leaves the page the modifier release will never arrive. Releasing
 * is the only way this interaction ends, so resolve it the same way rather
 * than stranding the strip on screen.
 */
function onBlur(): void {
  if (overlay?.isOpen) commit();
}

function attachListeners(): void {
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('keyup', onKeyup, true);
  window.addEventListener('blur', onBlur, true);
}

function detachListeners(): void {
  window.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('keyup', onKeyup, true);
  window.removeEventListener('blur', onBlur, true);
}

chrome.runtime.onMessage.addListener((message: ToOverlayMessage, _sender, sendResponse) => {
  switch (message.type) {
    case 'SHOW': {
      epoch = message.epoch;
      commitModifiers = message.commitModifiers;
      const view = ensureOverlay();
      view.render(message.items, message.selectedIndex);
      detachListeners();
      attachListeners();
      break;
    }
    case 'THUMBS':
      if (message.epoch === epoch) {
        void overlay?.applyThumbnails(message.thumbs, message.mime);
      }
      break;
    case 'UPDATE':
      if (message.epoch === epoch) overlay?.updateSelection(message.selectedIndex);
      break;
    case 'HIDE':
      close();
      break;
  }
  sendResponse?.(true);
  return undefined;
});

// Build the overlay up front rather than on the hot path. At document_start
// the parser may not have produced <html> yet.
if (document.documentElement) {
  ensureOverlay();
} else {
  document.addEventListener(
    'readystatechange',
    () => {
      if (document.documentElement) ensureOverlay();
    },
    { once: true },
  );
}
