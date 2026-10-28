import { OverlayView } from '../content/overlay';
import { keydownAction, keyupAction } from '../content/keys';
import type { FromOverlayMessage, ToOverlayMessage } from '../shared/types';

/**
 * Fallback switcher for pages a content script cannot touch — `chrome://*`,
 * the Chrome Web Store, and the New Tab page. Chrome blocks injection there
 * outright, so the strip is rendered in a small focused popup window instead.
 *
 * It reuses `OverlayView` and the same key rules as the in-page overlay, so
 * the two stay in step.
 */

const root = document.getElementById('root');
let commitModifiers: string[] = [];

function send(message: FromOverlayMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => {});
}

if (!root) throw new Error('fallback root missing');

const shadow = root.attachShadow({ mode: 'open' });
const overlay = new OverlayView(shadow, {
  onPick: (index) => send({ type: 'COMMIT', index }),
  onCancel: () => send({ type: 'CANCEL' }),
});

window.addEventListener(
  'keydown',
  (event) => {
    const action = keydownAction(event);
    if (!action) return;
    event.preventDefault();
    if (action.kind === 'cancel') send({ type: 'CANCEL' });
    else if (action.kind === 'commit') send({ type: 'COMMIT' });
    else send({ type: 'STEP', delta: action.delta });
  },
  true,
);

window.addEventListener(
  'keyup',
  (event) => {
    if (keyupAction(event, commitModifiers)?.kind === 'commit') {
      event.preventDefault();
      send({ type: 'COMMIT' });
    }
  },
  true,
);

chrome.runtime.onMessage.addListener((message: ToOverlayMessage) => {
  if (message.type === 'SHOW') {
    commitModifiers = message.commitModifiers;
    overlay.render(message.items, message.selectedIndex);
  } else if (message.type === 'UPDATE') {
    overlay.updateSelection(message.selectedIndex);
  } else if (message.type === 'HIDE') {
    overlay.destroy();
  }
});

void (async () => {
  const state = (await chrome.runtime.sendMessage({ type: 'GET_SESSION' })) as ToOverlayMessage | null;
  if (state?.type === 'SHOW') {
    commitModifiers = state.commitModifiers;
    overlay.render(state.items, state.selectedIndex);
  }
})();
