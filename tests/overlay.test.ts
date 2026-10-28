import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OverlayView } from '../src/content/overlay';
import type { SwitcherItem } from '../src/shared/types';

const item = (tabId: number, extra: Partial<SwitcherItem> = {}): SwitcherItem => ({
  tabId,
  windowId: 10,
  title: `Tab ${tabId}`,
  url: `https://example.test/${tabId}`,
  ...extra,
});

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const callbacks = { onPick: vi.fn(), onCancel: vi.fn() };
  return { root, view: new OverlayView(root, callbacks), callbacks };
}

const cards = (root: ShadowRoot) => Array.from(root.querySelectorAll('.card'));

describe('OverlayView', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('renders one card per tab, in order', () => {
    const { root, view } = mount();

    view.render([item(1), item(2), item(3)], 1);

    expect(cards(root)).toHaveLength(3);
    expect(cards(root).map((c) => c.querySelector('.title')?.textContent)).toEqual([
      'Tab 1',
      'Tab 2',
      'Tab 3',
    ]);
  });

  it('marks exactly the selected card', () => {
    const { root, view } = mount();

    view.render([item(1), item(2), item(3)], 2);

    expect(cards(root).map((c) => c.getAttribute('data-selected'))).toEqual([
      'false',
      'false',
      'true',
    ]);
  });

  it('moves the marker without re-rendering', () => {
    const { root, view } = mount();
    view.render([item(1), item(2), item(3)], 0);
    const before = cards(root)[0];

    view.updateSelection(2);

    expect(cards(root)[0]).toBe(before);
    expect(cards(root)[2]?.getAttribute('data-selected')).toBe('true');
    expect(cards(root)[0]?.getAttribute('data-selected')).toBe('false');
  });

  it('shows a thumbnail when one was captured and a placeholder otherwise', () => {
    const { root, view } = mount();

    view.render([item(1, { thumbnail: 'data:image/jpeg;base64,AAAA' }), item(2)], 0);

    const previews = Array.from(root.querySelectorAll('.preview'));
    expect(previews[0]?.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/jpeg;base64,AAAA',
    );
    expect(previews[1]?.querySelector('img')).toBeNull();
    expect(previews[1]?.querySelector('.placeholder')).not.toBeNull();
  });

  it('renders a favicon only when the tab has one', () => {
    const { root, view } = mount();

    view.render([item(1, { favIconUrl: 'https://example.test/f.ico' }), item(2)], 0);

    expect(cards(root)[0]?.querySelector('.favicon')).not.toBeNull();
    expect(cards(root)[1]?.querySelector('.favicon')).toBeNull();
  });

  it('reports the index of a clicked card', () => {
    const { root, view, callbacks } = mount();
    view.render([item(1), item(2), item(3)], 0);

    cards(root)[2]?.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));

    expect(callbacks.onPick).toHaveBeenCalledWith(2);
  });

  it('cancels on a click outside the strip but not inside it', () => {
    const { root, view, callbacks } = mount();
    view.render([item(1), item(2)], 0);

    const backdrop = root.querySelector('.backdrop')!;
    backdrop.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);

    root.querySelector('.strip')!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
  });

  it('escapes hostile tab titles instead of interpreting them as markup', () => {
    const { root, view } = mount();

    view.render([item(1, { title: '<img src=x onerror="alert(1)">' })], 0);

    const title = root.querySelector('.title')!;
    expect(title.querySelector('img')).toBeNull();
    expect(title.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it('leaves nothing behind when destroyed', () => {
    const { root, view } = mount();
    view.render([item(1), item(2)], 0);
    expect(view.isOpen).toBe(true);

    view.destroy();

    expect(root.childNodes).toHaveLength(0);
    expect(view.isOpen).toBe(false);
  });

  it('replaces the previous strip when rendered twice', () => {
    const { root, view } = mount();

    view.render([item(1), item(2)], 0);
    view.render([item(3), item(4), item(5)], 0);

    expect(root.querySelectorAll('.backdrop')).toHaveLength(1);
    expect(cards(root)).toHaveLength(3);
  });
});
