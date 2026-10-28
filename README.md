# Tab Scroll — MRU tab switcher for Chrome

Jump between recently used tabs with a thumbnail strip, in the spirit of Arc's
switcher and Firefox's "Ctrl+Tab cycles through tabs in recently used order".

Hold **Alt** (**Option** on macOS) and tap **Q**: a strip of your recent tabs
appears with a preview, title and favicon for each, with the tab you were just
on already highlighted. **Tab** moves the highlight along, **Shift+Tab** moves
it back, and **letting go of the modifier switches** to whatever is
highlighted. Press and release without touching Tab and you simply jump back
to the previous tab.

![The switcher strip over a page](docs/images/strip.png)

## Keys

| Key | Action |
| --- | --- |
| `Alt`+`Q` (hold `Alt`) | Open the strip |
| `Tab` / `Shift`+`Tab` | Move the highlight forward / backward |
| Release `Alt` | Switch to the highlighted tab |

That is the whole interaction. There is no cancel: once the strip is open,
releasing the modifier always switches. Tab and Shift+Tab are captured only
while the strip is open, so the page keeps normal forward and reverse focus
traversal at every other moment.

The binding is yours to change at `chrome://extensions/shortcuts`, and
release-to-commit follows whatever modifier you pick.

> **Tab stepping needs macOS.** `Alt`+`Tab` is the window switcher on Windows
> and on most Linux desktops, so the keystroke is taken by the OS and never
> reaches the page. On those platforms the strip still opens and releasing the
> modifier still switches to the previous tab, but the highlight cannot be
> moved. On macOS `Option`+`Tab` is unclaimed, which is what makes the full
> gesture work there. See [docs/RESEARCH.md](docs/RESEARCH.md).

## Why Alt+Q and not Ctrl+Tab

Chrome does not let extensions bind `Tab` at all — it is not in the list of
keys the `chrome.commands` API accepts, and every binding must include Ctrl or
Alt. `docs/RESEARCH.md` walks through the evidence; the short answer is that
the literal Firefox gesture needs a browser fork, which is what Arc is.

`MacCtrl+Q` was considered for macOS and rejected: `Control`+`Tab` is Chrome's
own next-tab shortcut there, so the Tab presses would be eaten by the browser.

## Build

Requires Node 22.12 or newer (Vitest's floor).

```bash
npm ci
npm run build
```

The loadable extension is written to `dist/`.

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with hot reload for the extension |
| `npm run build` | Production build into `dist/` |
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

## Load it in Chrome

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `dist/` folder in this repo.
5. Open a few tabs and visit each one, so there is a recent-tab order to show
   and so previews can be captured.
6. Hold **Alt** and tap **Q**.

To change the shortcut, go to `chrome://extensions/shortcuts` and edit
"Show recent tabs".

With `npm run dev` the extension reloads on save; you still load `dist/`
through **Load unpacked** the first time.

> Chrome 137 and later ignore the `--load-extension` command-line flag. If you
> are automating a browser rather than clicking through the UI, launch Chrome
> with `--enable-unsafe-extension-debugging --remote-debugging-port=<port>` and
> call the `Extensions.loadUnpacked` CDP command.

## How it works

```
src/
  background/      service worker — the only place that talks to chrome.tabs
    mru.ts           recency order, per window (pure, unit tested)
    tab-index.ts     cached tab metadata so a strip can be built with no awaits
    session.ts       selection, stepping and commit resolution (pure)
    shortcut.ts      reads the live binding to know which modifier commits
    thumbnails.ts    capture on activation, downscale to WebP, cache, evict
    index.ts         wires the above to Chrome's events
  content/
    overlay.ts       the strip, kept warm in a closed Shadow DOM
    keys.ts          what Tab and the modifier mean while the strip is open
    index.ts         content-script host
  fallback/        the same strip in a popup window, for restricted pages
  shared/
    restricted.ts    whether a URL can host a content script
    types.ts         message and item types shared across contexts
```

Things worth knowing if you are changing it:

- **The strip is built once and kept warm.** The content script attaches the
  shadow root and its stylesheet at `document_start`; a keypress only fills in
  cards and unhides them.
- **The first message carries no thumbnails.** Titles and favicons paint
  immediately and previews arrive in a follow-up message.
- **Commit carries a tab id, not an index**, so the tab that gets switched to
  is always exactly the highlighted tile.
- **Every session has an epoch.** Messages from a previous session are ignored,
  so a stale overlay cannot act on the current one.
- **Previews are captured when you leave a tab, not when the strip opens.**
  `chrome.tabs.captureVisibleTab` can only photograph the visible tab, so a
  thumbnail shows the tab as you last saw it, and a tab you have not visited
  since installing shows a placeholder.
- **Thumbnails are painted into a canvas**, not an `<img>`, because the strip
  lives in the page's document and strict sites restrict `img-src`.
- **MRU state is persisted**, because an MV3 service worker is evicted between
  events.

## Where it falls back

Chrome blocks content scripts on `chrome://*` pages, the Chrome Web Store and
the New Tab page. That is decided from the tab's URL, not from whether a
message failed, so an ordinary site whose content script is still loading gets
retried rather than pushed into the fallback.

![The fallback popup on a chrome:// page](docs/images/fallback.png)

Tabs that were already open before the extension was installed or reloaded get
the content script injected on demand, so they use the normal in-page overlay.

## Permissions

| Permission | Why |
| --- | --- |
| `tabs` | Read tab title, URL and favicon for the strip |
| `storage` | Cache MRU order and thumbnails in `chrome.storage.session` |
| `scripting` | Inject the overlay into tabs opened before the extension loaded |
| `<all_urls>` | Required by `captureVisibleTab` and to show the strip on any page |

Thumbnails and tab metadata stay in session storage on your machine and are
cleared when the browser closes. Nothing is sent anywhere.

## Known rough edges

- Tab stepping does not work on Windows or Linux, as described above.
- A tab never visited since install has no preview, only a placeholder.
- The fallback popup is a real window, so it is visibly slower than the
  in-page strip and steals focus.
- If focus leaves the page mid-gesture the modifier release never arrives; the
  strip resolves by switching to whatever was highlighted, since there is no
  cancel path.

## Licence

MIT — see [LICENSE](LICENSE).
