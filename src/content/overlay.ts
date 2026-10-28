import type { SwitcherItem } from '../shared/types';

/**
 * The switcher strip.
 *
 * Renders into a ShadowRoot supplied by the caller so the page's stylesheets
 * cannot reach it, and so tests can hand it a detached root instead of a real
 * document. Every property that inherits through a shadow boundary (font,
 * colour, line-height, direction) is reset explicitly on the container.
 */

const STYLES = `
:host { all: initial; }

.backdrop {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
  /* Dark and blurred enough that page text behind the strip cannot be mistaken
     for part of it. */
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(7px);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  font-weight: 400;
  font-style: normal;
  letter-spacing: normal;
  text-align: left;
  direction: ltr;
  color: #f5f5f7;
  animation: fade 90ms ease-out;
}

@keyframes fade { from { opacity: 0 } to { opacity: 1 } }

.strip {
  display: flex;
  gap: 10px;
  padding: 14px;
  max-width: calc(100vw - 48px);
  overflow-x: auto;
  border-radius: 16px;
  background: rgba(32, 32, 36, 0.94);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
  scrollbar-width: none;
}
.strip::-webkit-scrollbar { display: none; }

.card {
  flex: 0 0 auto;
  width: 168px;
  padding: 8px;
  border-radius: 11px;
  border: 2px solid transparent;
  background: rgba(255, 255, 255, 0.06);
  cursor: pointer;
  transition: border-color 80ms linear, background-color 80ms linear;
}
.card:hover { background: rgba(255, 255, 255, 0.11); }
.card[data-selected="true"] {
  border-color: #6aa8ff;
  background: rgba(106, 168, 255, 0.18);
}

.preview {
  width: 100%;
  height: 100px;
  border-radius: 7px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.07);
  display: flex;
  align-items: center;
  justify-content: center;
}
.preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
.preview .placeholder { font-size: 22px; opacity: 0.4; }

.meta { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.favicon { width: 15px; height: 15px; flex: 0 0 auto; border-radius: 3px; }
.title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #f5f5f7;
}

.hint {
  margin-top: 10px;
  text-align: center;
  font-size: 11px;
  opacity: 0.55;
  color: #f5f5f7;
}

@media (prefers-reduced-motion: reduce) {
  .backdrop { animation: none; }
  .card { transition: none; }
}
`;

export interface OverlayCallbacks {
  onPick(index: number): void;
  onCancel(): void;
}

export class OverlayView {
  private readonly root: ShadowRoot;
  private readonly callbacks: OverlayCallbacks;
  private container: HTMLElement | null = null;
  private cards: HTMLElement[] = [];

  constructor(root: ShadowRoot, callbacks: OverlayCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
  }

  get isOpen(): boolean {
    return this.container !== null;
  }

  render(items: SwitcherItem[], selectedIndex: number): void {
    this.destroy();

    const doc = this.root.ownerDocument ?? document;

    const style = doc.createElement('style');
    style.textContent = STYLES;

    const backdrop = doc.createElement('div');
    backdrop.className = 'backdrop';
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) this.callbacks.onCancel();
    });

    const panel = doc.createElement('div');

    const strip = doc.createElement('div');
    strip.className = 'strip';
    strip.setAttribute('role', 'listbox');
    strip.setAttribute('aria-label', 'Recently used tabs');

    this.cards = items.map((item, index) => {
      const card = doc.createElement('div');
      card.className = 'card';
      card.setAttribute('role', 'option');
      card.dataset.index = String(index);

      const preview = doc.createElement('div');
      preview.className = 'preview';
      if (item.thumbnail) {
        const img = doc.createElement('img');
        img.src = item.thumbnail;
        img.alt = '';
        preview.appendChild(img);
      } else {
        const placeholder = doc.createElement('div');
        placeholder.className = 'placeholder';
        placeholder.textContent = '◻';
        preview.appendChild(placeholder);
      }

      const meta = doc.createElement('div');
      meta.className = 'meta';
      if (item.favIconUrl) {
        const favicon = doc.createElement('img');
        favicon.className = 'favicon';
        favicon.src = item.favIconUrl;
        favicon.alt = '';
        meta.appendChild(favicon);
      }
      const title = doc.createElement('div');
      title.className = 'title';
      title.textContent = item.title;
      meta.appendChild(title);

      card.append(preview, meta);
      card.addEventListener('mouseup', () => this.callbacks.onPick(index));
      strip.appendChild(card);
      return card;
    });

    const hint = doc.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Release the modifier or press Enter to switch · ← → to move · Esc to cancel';

    panel.append(strip, hint);
    backdrop.appendChild(panel);
    this.root.append(style, backdrop);
    this.container = backdrop;

    this.updateSelection(selectedIndex);
  }

  updateSelection(selectedIndex: number): void {
    this.cards.forEach((card, index) => {
      const selected = index === selectedIndex;
      card.dataset.selected = String(selected);
      card.setAttribute('aria-selected', String(selected));
      if (selected) {
        card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    });
  }

  destroy(): void {
    this.root.replaceChildren();
    this.container = null;
    this.cards = [];
  }
}
