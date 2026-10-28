import type { SwitcherItem } from '../shared/types';

/**
 * The switcher strip.
 *
 * Two things matter here beyond drawing boxes.
 *
 * It is built once and kept warm. Creating the shadow root and parsing the
 * stylesheet on every keypress was a large part of why the strip used to
 * appear late; `render` now only swaps the cards of an element that is
 * already attached and styled.
 *
 * Thumbnails are painted into a canvas rather than loaded into an `<img>`.
 * The strip lives in the page's document, so an `<img src="data:…">` is
 * subject to the page's `img-src`, which strict sites do restrict. Decoding
 * the bytes here and drawing them means no document-level resource load
 * happens and no CSP applies.
 */

const CSS = `
:host { all: initial; }

.backdrop {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
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
}
.backdrop[hidden] { display: none; }

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
}
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
.preview canvas { width: 100%; height: 100%; object-fit: cover; display: block; }
.preview .placeholder { font-size: 22px; opacity: 0.4; }
/* A tab not visited since the extension loaded has no capture, which is most
   of them on day one. Its favicon reads better than an empty box. */
.preview .placeholder-icon { width: 34px; height: 34px; opacity: 0.85; }

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
`;

function makePlaceholder(doc: Document): HTMLElement {
  const placeholder = doc.createElement('div');
  placeholder.className = 'placeholder';
  placeholder.textContent = '\u25FB';
  return placeholder;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class OverlayView {
  private readonly root: ShadowRoot;
  private readonly backdrop: HTMLElement;
  private readonly strip: HTMLElement;
  private cards: HTMLElement[] = [];
  private previews = new Map<number, HTMLElement>();
  private open = false;

  constructor(root: ShadowRoot) {
    this.root = root;
    const doc = root.ownerDocument ?? document;

    // Constructed stylesheets are parsed once and attached without putting a
    // <style> element into the page.
    if ('adoptedStyleSheets' in root && typeof CSSStyleSheet !== 'undefined') {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        root.adoptedStyleSheets = [sheet];
      } catch {
        this.appendStyleElement(doc);
      }
    } else {
      this.appendStyleElement(doc);
    }

    this.backdrop = doc.createElement('div');
    this.backdrop.className = 'backdrop';
    this.backdrop.hidden = true;

    this.strip = doc.createElement('div');
    this.strip.className = 'strip';
    this.strip.setAttribute('role', 'listbox');
    this.strip.setAttribute('aria-label', 'Recently used tabs');

    this.backdrop.appendChild(this.strip);
    root.appendChild(this.backdrop);
  }

  private appendStyleElement(doc: Document): void {
    const style = doc.createElement('style');
    style.textContent = CSS;
    this.root.appendChild(style);
  }

  get isOpen(): boolean {
    return this.open;
  }

  render(items: SwitcherItem[], selectedIndex: number): void {
    const doc = this.root.ownerDocument ?? document;
    this.previews.clear();

    this.cards = items.map((item, index) => {
      const card = doc.createElement('div');
      card.className = 'card';
      card.setAttribute('role', 'option');
      card.dataset.index = String(index);
      card.dataset.tabId = String(item.tabId);

      const preview = doc.createElement('div');
      preview.className = 'preview';
      if (item.favIconUrl) {
        const icon = doc.createElement('img');
        icon.className = 'placeholder-icon';
        icon.src = item.favIconUrl;
        icon.alt = '';
        icon.addEventListener('error', () => icon.replaceWith(makePlaceholder(doc)));
        preview.appendChild(icon);
      } else {
        preview.appendChild(makePlaceholder(doc));
      }
      this.previews.set(item.tabId, preview);

      const meta = doc.createElement('div');
      meta.className = 'meta';
      if (item.favIconUrl) {
        const favicon = doc.createElement('img');
        favicon.className = 'favicon';
        favicon.src = item.favIconUrl;
        favicon.alt = '';
        // A strict img-src can block this; the title alone is still readable.
        favicon.addEventListener('error', () => favicon.remove());
        meta.appendChild(favicon);
      }
      const title = doc.createElement('div');
      title.className = 'title';
      title.textContent = item.title;
      meta.appendChild(title);

      card.append(preview, meta);
      return card;
    });

    this.strip.replaceChildren(...this.cards);
    this.updateSelection(selectedIndex);
    this.backdrop.hidden = false;
    this.open = true;
  }

  updateSelection(selectedIndex: number): void {
    this.cards.forEach((card, index) => {
      const selected = index === selectedIndex;
      card.dataset.selected = String(selected);
      card.setAttribute('aria-selected', String(selected));
      if (selected) card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  /** The tab the highlighted tile belongs to, which is what gets committed. */
  selectedTabId(): number | undefined {
    const card = this.cards.find((c) => c.dataset.selected === 'true');
    const raw = card?.dataset.tabId;
    return raw === undefined ? undefined : Number(raw);
  }

  /** Fills in previews after the strip is already on screen. */
  async applyThumbnails(thumbs: Record<number, string>, mime: string): Promise<void> {
    await Promise.all(
      Object.entries(thumbs).map(async ([rawTabId, base64]) => {
        const preview = this.previews.get(Number(rawTabId));
        if (!preview || !base64) return;
        try {
          const blob = new Blob([decodeBase64(base64).buffer as ArrayBuffer], { type: mime });
          const bitmap = await createImageBitmap(blob);
          const doc = this.root.ownerDocument ?? document;
          const canvas = doc.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
          bitmap.close();
          preview.replaceChildren(canvas);
        } catch {
          // Leave the placeholder; a missing preview is not worth failing over.
        }
      }),
    );
  }

  hide(): void {
    this.backdrop.hidden = true;
    this.strip.replaceChildren();
    this.cards = [];
    this.previews.clear();
    this.open = false;
  }
}
