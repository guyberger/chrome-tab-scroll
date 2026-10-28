import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OverlayView } from '../src/content/overlay';
import type { SwitcherItem } from '../src/shared/types';

const item = (tabId: number, extra: Partial<SwitcherItem> = {}): SwitcherItem => ({
  tabId,
  windowId: 10,
  title: `Tab ${tabId}`,
  ...extra,
});

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  return { root, view: new OverlayView(root) };
}

const cards = (root: ShadowRoot) => Array.from(root.querySelectorAll('.card'));
const backdrop = (root: ShadowRoot) => root.querySelector('.backdrop') as HTMLElement;

describe('OverlayView', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('builds itself hidden so the keypress only has to fill it in', () => {
    const { root, view } = mount();

    expect(backdrop(root)).not.toBeNull();
    expect(backdrop(root).hidden).toBe(true);
    expect(view.isOpen).toBe(false);
  });

  it('renders one card per tab, in order, and shows itself', () => {
    const { root, view } = mount();

    view.render([item(1), item(2), item(3)], 1);

    expect(cards(root)).toHaveLength(3);
    expect(cards(root).map((c) => c.querySelector('.title')?.textContent)).toEqual([
      'Tab 1',
      'Tab 2',
      'Tab 3',
    ]);
    expect(backdrop(root).hidden).toBe(false);
    expect(view.isOpen).toBe(true);
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

  it('moves the marker without rebuilding the cards', () => {
    const { root, view } = mount();
    view.render([item(1), item(2), item(3)], 0);
    const before = cards(root)[0];

    view.updateSelection(2);

    expect(cards(root)[0]).toBe(before);
    expect(cards(root)[2]?.getAttribute('data-selected')).toBe('true');
    expect(cards(root)[0]?.getAttribute('data-selected')).toBe('false');
  });

  // This is the regression guard for the wrong-tab commit: whatever the
  // overlay reports has to be the tile that is actually highlighted.
  it('reports the tab id of the highlighted tile', () => {
    const { view } = mount();
    view.render([item(11), item(22), item(33)], 1);

    expect(view.selectedTabId()).toBe(22);

    view.updateSelection(2);
    expect(view.selectedTabId()).toBe(33);

    view.updateSelection(0);
    expect(view.selectedTabId()).toBe(11);
  });

  it('reports nothing when it is not showing', () => {
    const { view } = mount();
    expect(view.selectedTabId()).toBeUndefined();

    view.render([item(1), item(2)], 1);
    view.hide();
    expect(view.selectedTabId()).toBeUndefined();
  });

  it('starts every tile on a placeholder until thumbnails arrive', () => {
    const { root, view } = mount();

    view.render([item(1), item(2)], 0);

    expect(root.querySelectorAll('.preview .placeholder')).toHaveLength(2);
    expect(root.querySelectorAll('.preview canvas')).toHaveLength(0);
  });

  it('paints arriving thumbnails into a canvas rather than an img', async () => {
    const { root, view } = mount();
    view.render([item(1), item(2)], 0);

    const bitmap = { width: 8, height: 5, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);

    await view.applyThumbnails({ 1: btoa('fake-bytes') }, 'image/webp');

    // An <img src="data:…"> would be subject to the page's img-src; a canvas
    // is not, which is the point.
    expect(root.querySelectorAll('.preview canvas')).toHaveLength(1);
    expect(root.querySelectorAll('.preview img')).toHaveLength(0);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    vi.unstubAllGlobals();
  });

  it('keeps the placeholder when a thumbnail cannot be decoded', async () => {
    const { root, view } = mount();
    view.render([item(1)], 0);

    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('bad data')));
    await view.applyThumbnails({ 1: btoa('junk') }, 'image/webp');

    expect(root.querySelectorAll('.preview .placeholder')).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('ignores thumbnails for tabs that are not on screen', async () => {
    const { view } = mount();
    view.render([item(1)], 0);

    vi.stubGlobal('createImageBitmap', vi.fn());
    await view.applyThumbnails({ 999: btoa('x') }, 'image/webp');

    expect(createImageBitmap).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('renders a favicon only when the tab has one', () => {
    const { root, view } = mount();

    view.render([item(1, { favIconUrl: 'https://example.test/f.ico' }), item(2)], 0);

    expect(cards(root)[0]?.querySelector('.favicon')).not.toBeNull();
    expect(cards(root)[1]?.querySelector('.favicon')).toBeNull();
  });

  it('drops a favicon the page CSP refuses to load', () => {
    const { root, view } = mount();
    view.render([item(1, { favIconUrl: 'https://blocked.test/f.ico' })], 0);

    root.querySelector('.favicon')!.dispatchEvent(new window.Event('error'));

    expect(root.querySelector('.favicon')).toBeNull();
    expect(root.querySelector('.title')?.textContent).toBe('Tab 1');
  });

  it('escapes hostile tab titles instead of interpreting them as markup', () => {
    const { root, view } = mount();

    view.render([item(1, { title: '<img src=x onerror="alert(1)">' })], 0);

    const title = root.querySelector('.title')!;
    expect(title.querySelector('img')).toBeNull();
    expect(title.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it('hides without tearing down the warm scaffolding', () => {
    const { root, view } = mount();
    view.render([item(1), item(2)], 0);

    view.hide();

    expect(view.isOpen).toBe(false);
    expect(backdrop(root).hidden).toBe(true);
    expect(cards(root)).toHaveLength(0);
    // Still attached and styled, ready for the next keypress.
    expect(root.querySelector('.strip')).not.toBeNull();
  });

  it('replaces the previous strip when rendered twice', () => {
    const { root, view } = mount();

    view.render([item(1), item(2)], 0);
    view.render([item(3), item(4), item(5)], 0);

    expect(root.querySelectorAll('.backdrop')).toHaveLength(1);
    expect(cards(root)).toHaveLength(3);
  });

  it('has no footer hint and no clickable cards', () => {
    const { root, view } = mount();
    view.render([item(1), item(2)], 0);

    expect(root.querySelector('.hint')).toBeNull();
    expect(cards(root)[0]?.getAttribute('onclick')).toBeNull();
  });
});
