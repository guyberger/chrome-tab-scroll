import { OverlayView } from '../content/overlay';
import { keydownAction, keyupAction } from '../content/keys';
import type { FromOverlayMessage, ToOverlayMessage } from '../shared/types';

/**
 * Fallback switcher for pages a content script cannot touch — `chrome://*`,
 * the Chrome Web Store, and the New Tab page. Chrome blocks injection there
 * outright, so the strip is rendered in a small focused popup window.
 *
 * It reuses `OverlayView` and the same key rules as the in-page overlay so
 * the two cannot drift apart.
 */

const root = document.getElementById('root');
if (!root) throw new Error('fallback root missing');

let commitModifiers: string[] = [];
let epoch = -1;

function send(message: FromOverlayMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => {});
}

const shadow = root.attachShadow({ mode: 'open' });
const overlay = new OverlayView(shadow);

function show(state: Extract<ToOverlayMessage, { type: 'SHOW' }>): void {
  epoch = state.epoch;
  commitModifiers = state.commitModifiers;
  overlay.render(state.items, state.selectedIndex);
}

window.addEventListener(
  'keydown',
  (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const action = keydownAction(event);
    if (action) send({ type: 'STEP', epoch, delta: action.delta });
  },
  true,
);

window.addEventListener(
  'keyup',
  (event) => {
    if (keyupAction(event, commitModifiers)?.kind !== 'commit') return;
    event.preventDefault();
    const tabId = overlay.selectedTabId();
    if (tabId !== undefined) send({ type: 'COMMIT', epoch, tabId });
  },
  true,
);

chrome.runtime.onMessage.addListener((message: ToOverlayMessage) => {
  if (message.type === 'SHOW') show(message);
  else if (message.type === 'THUMBS' && message.epoch === epoch) {
    void overlay.applyThumbnails(message.thumbs, message.mime);
  } else if (message.type === 'UPDATE' && message.epoch === epoch) {
    overlay.updateSelection(message.selectedIndex);
  } else if (message.type === 'HIDE') {
    overlay.hide();
  }
});

void (async () => {
  const state = (await chrome.runtime.sendMessage({ type: 'GET_SESSION' })) as ToOverlayMessage | null;
  if (state?.type === 'SHOW') show(state);
})();
