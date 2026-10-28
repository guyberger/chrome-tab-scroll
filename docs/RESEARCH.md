# MRU tab switching: how Arc and Firefox do it, and what Chrome MV3 allows

This document works out what a most-recently-used tab switcher can actually be
on Chrome, and why the shortcut ended up as **Alt+Q** rather than the Shift+Tab
that was originally suggested.

The short version: the overlay, the thumbnails and the MRU ordering can all be
built faithfully. The *gesture* cannot. Chrome refuses to bind Tab to an
extension command at all, and taking Shift+Tab inside the page would break
keyboard navigation on every site. Everything below is the evidence for that
and the reasoning about what to do instead.

---

## 1. The model we are copying

### Firefox

Firefox has shipped this behind a preference for years. With
`browser.ctrlTab.recentlyUsedOrder` (historically `browser.ctrlTab.previews` /
`browser.ctrlTab.mostRecentlyUsed`) enabled:

- Hold **Ctrl** and tap **Tab**. A panel appears showing thumbnail previews of
  recent tabs — seven of them in current builds.
- Each further tap of Tab, with Ctrl still held, advances the highlight.
  **Shift+Tab** walks back.
- **Releasing Ctrl commits** the highlighted tab. Escape cancels.
- Ordering is by last use, not tab-strip position, so the first commit is
  always "the tab I was just on".

The preference defaults to **off**, and Mozilla's own community threads are
full of people asking for it to be on by default. Worth knowing: even the
browser vendor treats recency-ordered Ctrl+Tab as opt-in, because it surprises
people who expect Ctrl+Tab to walk left-to-right along the tab strip.

Sources: [Mozilla Connect idea thread](https://connect.mozilla.org/t5/ideas/enable-quot-ctrl-tab-cycles-through-tabs-in-recently-used-order/idi-p/4486),
[MozillaZine on `browser.ctrlTab.mostRecentlyUsed`](https://kb.mozillazine.org/Browser.ctrlTab.mostRecentlyUsed).

### Arc

Arc's switcher is the same interaction with a different visual: a horizontal
strip of large previews, hold-modifier-and-tap to move, release to commit.
Arc is a Chromium *fork*, so it can bind whatever keys it likes and can read
tab contents directly. That distinction matters: Arc is doing this as the
browser, not as an extension, which is exactly the latitude we do not have.

### The shared skeleton

Four things make the gesture feel right, and they are worth naming separately
because Chrome lets us keep three of them:

1. **Recency ordering** — index 0 is where you are, index 1 is where you were.
2. **Press-and-release as the common case** — one tap, no thinking, you are
   back on the last tab.
3. **Hold to browse** — keeping the modifier down turns it into a picker.
4. **Release to commit** — no second confirming keystroke.

---

## 2. What Chrome MV3 actually allows

Each of the four constraints below was checked against primary sources rather
than assumed.

### 2.1 `chrome.commands` cannot bind Tab — confirmed, and it is worse than expected

The [commands API reference](https://developer.chrome.com/docs/extensions/reference/api/commands)
lists the complete set of bindable keys:

> **Alpha keys**: `A` … `Z`
> **Numeric keys**: `0` … `9`
> **Standard key strings**: General – `Comma`, `Period`, `Home`, `End`,
> `PageUp`, `PageDown`, `Space`, `Insert`, `Delete`; Arrow keys – `Up`, `Down`,
> `Left`, `Right`; Media Keys – `MediaNextTrack`, `MediaPlayPause`,
> `MediaPrevTrack`, `MediaStop`
> **Modifier key strings**: `Ctrl`, `Alt`, `Shift`, `MacCtrl`, `Option`,
> `Command`, `Search`

`Tab` is not on that list. It is not a reserved-but-possible key; it is simply
not a value the manifest parser accepts, and the docs note that a bad key
"will result in a manifest parse error at installation time".

The same page adds a second rule that independently kills the idea:

> Extension command shortcuts must include either `Ctrl` or `Alt`.

So **Shift+Tab fails twice over** — Tab is not bindable, and Shift alone is not
an acceptable modifier. Ctrl+Tab fails for the same key reason, and is
separately reserved by the browser; extensions in the Web Store say so plainly
in their own listings ("Chrome does not allow any extensions to use Ctrl+Tab or
Ctrl+` as keyboard shortcuts").

Two further limits from the same page that shaped the design:

- An extension may suggest **at most four** default shortcuts, but users can
  add or change bindings freely at `chrome://extensions/shortcuts`.
- OS and Chrome shortcuts always win and cannot be overridden.

### 2.2 Hijacking Shift+Tab in a content script would break the web

Suppose we ignored the commands API and listened for Shift+Tab in a content
script instead. Tab and Shift+Tab are *the* keyboard navigation primitives:
Tab moves focus forward through links, buttons and form fields, Shift+Tab
moves it backward. Chrome's own [keyboard shortcut documentation](https://support.google.com/chrome/answer/157179)
describes exactly that.

Swallowing them globally would mean:

- Nobody can reverse out of a form field on any page.
- Screen-reader and keyboard-only users lose backward navigation entirely —
  this is an accessibility regression, not a preference.
- It only works where content scripts run, so the behaviour would be
  inconsistent anyway (see 2.3).

There is also a plain correctness problem: a content script cannot reliably
tell "the user wants to switch tabs" from "the user is tabbing backwards
through a form", because they are the same keystroke.

This rules the approach out on its own, independent of the API limits.

### 2.3 Content scripts do not run everywhere — confirmed

Chrome blocks extension content scripts on its own surfaces: `chrome://*`
pages, the Chrome Web Store, and the New Tab page. There is also a fourth,
less-discussed case that matters just as much in practice: **tabs that were
already open when the extension was installed or reloaded have no content
script** until they navigate or are injected into.

Consequences for this design:

- Any in-page overlay needs a fallback for those tabs.
- Any key handling that lives in the page is unavailable there too — which
  means release-to-commit cannot be universal.

### 2.4 `captureVisibleTab` only photographs the visible tab — confirmed

`chrome.tabs.captureVisibleTab` captures the **currently visible area of the
active tab** of a given window. There is no API to screenshot a background
tab. The [tabs API reference](https://developer.chrome.com/docs/extensions/reference/api/tabs)
places it under host permissions, and Chromium's tracker confirms the
narrowness: capture of `chrome://` pages requires `activeTab`
([issue 40068363](https://issues.chromium.org/issues/40068363)), and there is a
per-second quota, `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`
([issue 40764505](https://issues.chromium.org/issues/40764505)), that a naive
implementation will trip.

So previews cannot be generated when the strip opens. They have to be
**captured on activation and cached**, which means a thumbnail is a picture of
the tab *as you last left it*, not as it is now. Three practical consequences,
all of which the implementation handles:

- Capture must be debounced, or rapid tab switching exhausts the quota.
- Captures must be downscaled and capped, or `storage.session` fills up.
- A tab that has never been visited since install has **no** thumbnail, so the
  UI needs a placeholder state. This is visible in the demo: the tab that was
  open before the extension loaded shows a placeholder card.

---

## 3. The shortcut decision

### What is lost

Of the four ingredients in section 1, we keep recency ordering, press-and-
release, and hold-to-browse. What we cannot have is **the Tab key itself**.
That is the whole of the compromise, and it is forced by the platform — no
extension on the Chrome Web Store has Ctrl+Tab, because Chrome does not permit
it. The only way to get the literal Firefox gesture is to fork the browser,
which is what Arc did.

### What was chosen

**`Alt+Q` to open and step forward, `Alt+Shift+Q` to step backward**, both
rebindable at `chrome://extensions/shortcuts`.

Reasoning:

- **Alt+Q is unassigned in Chrome** on Windows, Linux and ChromeOS, so nothing
  is taken away from the user. (`Ctrl+Q` is quit on some platforms; `Alt+Q` is
  not.)
- **Q sits next to Tab** on QWERTY, under the same left hand, so the physical
  motion is close to the Firefox gesture even though the key differs.
- **Alt is a real modifier**, so release-to-commit works: the user holds Alt,
  taps Q as many times as they like, and lets go.
- Only two of the four permitted suggestions are used, leaving headroom.

### How release-to-commit survives

This is the interesting part. Chrome handles `chrome.commands` bindings itself
and **does not dispatch them to the page**, so the content script never sees
the Alt+Q keydown. But it *does* see the **Alt keyup**, because that is an
ordinary key event the page is entitled to. That single fact is what makes the
Arc/Firefox gesture reproducible at all:

- Opening and stepping go through `chrome.commands` → background → overlay.
- Committing is detected **in the page**, on `keyup` of the modifier.

Because the user can rebind the command, the background reads the live binding
with `chrome.commands.getAll()` and tells the overlay which modifier to watch.
Rebinding to `Ctrl+Period` makes the overlay commit on Ctrl release instead.
Shift is deliberately ignored when it merely decorates another modifier, since
releasing Shift first is common and should not fire a switch.

### Where it degrades, and to what

| Situation | Behaviour |
| --- | --- |
| Ordinary web page | Full gesture: hold Alt, tap Q, release to commit |
| Tab open before the extension loaded | Content script is injected on demand, then full gesture |
| `chrome://*`, Web Store, New Tab page | Strip opens in a small focused popup window instead |

In the popup-window fallback the strip is identical and the keys behave the
same, but it is a separate OS window, so it is slower and steals focus. That
is the honest cost of Chrome not letting extensions draw on its own pages.

### Alternatives considered and rejected

- **Shift+Tab in a content script.** Rejected: breaks reverse focus traversal
  and accessibility on every site, and is unavailable on restricted pages
  anyway (2.2, 2.3).
- **`Ctrl+Tab` / `Ctrl+Shift+Tab`.** Not bindable, and reserved (2.1).
- **A browser-action popup as the only UI.** Chrome popups cannot be driven by
  hold-and-release and close on blur, which removes the entire gesture.
- **`Alt+Tab`.** Belongs to the operating system; Chrome never sees it.
- **Making the popup window the only implementation.** Simpler and uniform,
  but a new OS window on every switch is far too slow for a feature whose
  entire point is speed.

### What needs Guy's sign-off

The substantive question is only this: **Alt+Q instead of Shift+Tab.** The
platform leaves no way to have the original key. If Alt+Q clashes with
something in your setup, any `Ctrl`/`Alt` combination from the list in 2.1
works just as well, and rebinding at `chrome://extensions/shortcuts` is
supported — release-to-commit follows the new binding automatically.

---

## 3a. Revision: Tab stepping inside the overlay

The interaction was later cut to three things — the hotkey opens the strip,
Tab and Shift+Tab move the highlight while the modifier is still held, and
releasing the modifier switches. Everything else (a second backward command,
arrow keys, Enter, Escape, clicking a card) was removed.

This is **not** the Shift+Tab hijack rejected in 2.2. The difference is scope:
nothing is bound globally, and the keys are captured only while the strip is
open with the modifier held. Outside that moment the page's forward and
reverse focus traversal is untouched, which was the whole objection.

Taking Tab as the stepping key does change the modifier analysis, and it
reverses what would otherwise have been the macOS choice.

### MacCtrl is now ruled out

`MacCtrl+Q` looks attractive on macOS — Control is not a text-composition
modifier there, so a missed keystroke can never insert a character, whereas
Option+Q composes "œ". But **`Control`+`Tab` is Chrome's own next-tab
shortcut on macOS**. The browser would swallow every Tab press before the page
saw it, so the stepping half of the interaction would simply not work. Option
is therefore the right modifier on macOS, and the composed-character risk is
handled in the overlay instead: while the strip is open the content script
swallows every key event, so nothing reaches the page.

### Alt+Tab belongs to the OS on Windows and Linux

On macOS, `Option`+`Tab` is claimed by neither the system nor Chrome, so it
reaches the page. On Windows and on most Linux desktops `Alt`+`Tab` is the
window switcher and is intercepted before the browser ever sees it.

This was measured rather than assumed. With a page-level listener counting Tab
keydowns while Alt was held on an xfwm4 desktop, the page received **0** of 3
presses. After disabling the window manager's `<Alt>Tab` binding the same test
received **3** of 3, confirming the interception is the desktop's and that the
extension's own handling is correct.

There is no way around it within the stated design: `Alt`+`Tab` is taken by
the OS and `Ctrl`+`Tab` is taken by Chrome, so no modifier+Tab pair is free on
those platforms. The consequence is that on Windows and Linux the strip opens
and release-to-commit still works — giving Alt+Tab-style "switch to the
previous tab" — but the highlight cannot be moved. The full gesture is a macOS
feature.

### There is no cancel

With Escape and click-outside removed, releasing the modifier is the only way
the interaction ends, and it always switches. The one place this needed care
is losing focus mid-gesture, where the modifier release will never be
delivered: the overlay resolves that the same way rather than stranding itself
on screen.

## 4. What this implies for the implementation

Decisions that follow directly from the findings above:

- **MRU state lives in the background and is persisted.** MV3 service workers
  are evicted between events, so the order is written to `chrome.storage.session`
  on every change and rebuilt on wake.
- **Order is tracked per window.** `tabs.onActivated` alone is not enough;
  `windows.onFocusChanged` has to promote the newly focused window's active tab,
  or the order goes stale the moment someone uses two windows.
- **Thumbnails are captured on activation**, debounced, downscaled to 256×160
  WebP, and capped, for the quota and storage reasons in 2.4. They are sent
  to the overlay only after the strip is already on screen, so nothing about
  them is on the path to the first paint.
- **Thumbnails are drawn into a canvas, not an `<img>`.** The strip lives in
  the page's document, so an `<img src="data:…">` is subject to the page's
  `img-src`. A page serving `img-src 'self'` was observed blocking exactly
  that. Decoding the bytes in the content script and drawing them means no
  document-level resource load happens at all.
- **Whether to use the fallback window is decided from the tab's URL**, never
  from a failed message. The bundler loads the content script through a
  dynamic import, so a perfectly ordinary tab can be injectable and not yet
  listening; treating that as "this page forbids content scripts" is what put
  the fallback window on top of normal sites.
- **The overlay lives in a closed Shadow DOM.** It is injected into arbitrary
  pages, so site CSS must not be able to reach it, and inheritable properties
  are reset explicitly on the container.
- **Selection starts at index 1.** Index 0 is the current tab, so a single
  press-and-release lands on the previous tab, matching Alt+Tab and Firefox.
- **Commit carries a tab id, not an index.** The overlay reports the tab it
  highlighted, and the background honours it only if that tab is still part of
  the session. An index is meaningless across two processes whose copies of
  the list can diverge.
- **Every session carries an epoch** and messages quoting an older one are
  dropped, so an overlay left over from a previous invocation cannot step or
  commit the current one.
