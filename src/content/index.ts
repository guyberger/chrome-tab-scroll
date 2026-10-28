import { OverlayView } from './overlay';
import { keydownAction, keyupAction } from './keys';
import type { FromOverlayMessage, ToOverlayMessage } from '../shared/types';

/**
 * Content-script host for the switcher strip.
 *
 * The strip lives in a closed ShadowRoot on a dedicated element so neither the
 * page's CSS nor its scripts can disturb it. Listeners are attached in the
 * capture phase and only while the strip is open, so the page keeps every key
 * it normally handles the rest of the time.
 */

const HOST_ID = 'chrome-tab-scroll-overlay-host';

/** Dismisses a strip that was somehow left open, e.g. a missed modifier keyup. */
const INACTIVITY_CANCEL_MS = 6000;

let overlay: OverlayView | null = null;
let hostElement: HTMLElement | null = null;
let commitModifiers: string[] = [];
let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

function send(message: FromOverlayMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => {
    // Background went away; nothing useful to do from here.
  });
}

function ensureOverlay(): OverlayView {
  if (overlay && hostElement?.isConnected) return overlay;

  hostElement = document.createElement('div');
  hostElement.id = HOST_ID;
  // The page's own stylesheet cannot reach inside the shadow root, but it can
  // still style this host element, so pin the few things that would matter.
  hostElement.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
  hostElement.style.setProperty('display', 'block', 'important');

  const root = hostElement.attachShadow({ mode: 'closed' });
  document.documentElement.appendChild(hostElement);

  overlay = new OverlayView(root, {
    onPick: (index) => send({ type: 'COMMIT', index }),
    onCancel: () => send({ type: 'CANCEL' }),
  });
  return overlay;
}

function teardown(): void {
  clearTimeout(inactivityTimer);
  detachListeners();
  overlay?.destroy();
  overlay = null;
  hostElement?.remove();
  hostElement = null;
}

function bumpInactivity(): void {
  clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => send({ type: 'CANCEL' }), INACTIVITY_CANCEL_MS);
}

function onKeydown(event: KeyboardEvent): void {
  const action = keydownAction(event);
  if (!action) return;
  event.preventDefault();
  event.stopPropagation();
  bumpInactivity();

  if (action.kind === 'cancel') send({ type: 'CANCEL' });
  else if (action.kind === 'commit') send({ type: 'COMMIT' });
  else send({ type: 'STEP', delta: action.delta });
}

function onKeyup(event: KeyboardEvent): void {
  if (keyupAction(event, commitModifiers)?.kind === 'commit') {
    event.preventDefault();
    event.stopPropagation();
    send({ type: 'COMMIT' });
  }
}

/** If the page loses focus entirely the modifier keyup will never arrive. */
function onBlur(): void {
  send({ type: 'CANCEL' });
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

chrome.runtime.onMessage.addListener((message: ToOverlayMessage) => {
  switch (message.type) {
    case 'SHOW': {
      commitModifiers = message.commitModifiers;
      const view = ensureOverlay();
      view.render(message.items, message.selectedIndex);
      detachListeners();
      attachListeners();
      bumpInactivity();
      break;
    }
    case 'UPDATE':
      overlay?.updateSelection(message.selectedIndex);
      bumpInactivity();
      break;
    case 'HIDE':
      teardown();
      break;
  }
});
