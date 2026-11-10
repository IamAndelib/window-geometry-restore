# App key: the desktop file name (issue #5)

## Problem
Windows were grouped and saved by `resourceClass`. On Wayland, a Flatpak's windows all report the
Flatpak's app id as their class, so a Flatpak browser's web apps (WhatsApp through Web App Hub,
Flatpak Chrome) were windows of the browser:
- with the browser open, the web app was "another window of a running app" and not restored;
- the browser and its web apps shared one saved layout, and caption matching picked the slot.

A KWin rule (or `StartupWMClass`) gives such a window its own `desktopFileName`, which the taskbar
already uses to show it apart.

## Decisions (user, 2026-11-10)
- **App key** = `desktopFileName` when it names another app than `resourceClass`, else the class
  (`Engine.appKeyFor`). A difference in case alone keeps the class: XWayland classes come
  lowercased, and their saves stay where they are.
- **Learned openings** (1.4.2, `Engine.learnOpening`/`predictedKey`, saved as the app's `o`).
  Tried first: holding a new window until a title rule had settled its app. The user's debug log
  showed why that can't work for Chrome. The WhatsApp window opens as `web.whatsapp.com_/`, then
  `WhatsApp Web` (which the rule doesn't match), and is renamed ~0.8 s after opening, while normal
  Chrome windows open with their final title and never change. Titles don't say "still loading".
  But the opening title of a web app is constant. So:
  - a window renamed within `LEARN_MS` (3 s; observed ~0.8 s) of opening, untouched by the user,
    teaches its new app the (app, title) it opened with, unless windows of the old app, saved
    or open, have that title (a generic title like "New Tab - Google Chrome" would make every
    browser window look like the web app). A user navigating a tab takes longer, and moves it.
  - a new window matching a learned opening is taken for that app at once (`entry.prediction`),
    grouped and restored as it, like any app; KWin's rename then confirms it and changes nothing.
    It waits up to `PREDICTION_MS` (= `RESTORE_TIMEOUT_MS`, 10 s) for a slow start.
  - No name within that time: the opening is forgotten and the window becomes its old app's
    again, where it is (no longer fresh, so nothing is undone or re-placed).
  - KWin naming it as another app: that app learns the opening too, and `predictedKey` doesn't
    guess an opening two apps share (otherwise each launch would guess the previous app).
  - A window renamed twice in a row teaches only its last name. An unconfirmed guess that closes
    is not saved.
  - The first launch of a web app after this is learned the hard way (the undo path).
  - Pressure-tested (2026-11-10) by a code review, a state-machine adversary and a KWin source
    audit; their findings are covered by tests in `lifecycle.mjs` and `tests/kwin`.
- **Follows the window's desktop file name** (`onAppKeyChanged`, from 1.4.2), for renames no
  rule predicts. If the old app's restore had placed a fresh window, `undoRestore` puts it back
  as KWin opened it (untiled, unmaximized, at its first place) before the new app's restore;
  `canPlace` ignores the maximized frame KWin still shows until the app follows. 1.4.1 read it once,
  when the window was tracked, assuming late changes were rare. They are the normal case for a
  web app named by a rule on its title: the browser shows the window under a placeholder title
  ("New Tab") and sets the real one a moment later; KWin applies the rule only then.
  - A window whose key changes leaves its group (as a window moved to another desktop does) and
    joins the new app's.
  - **Fresh** (opened less than `RESTORE_TIMEOUT_MS` ago, not moved or resized by the user): it is
    placed as a window new to that app (`placeNewWindow`: its restore, a window rule, or a restore
    for another monitor). A save the old app's restore gave it goes back to that restore if it is
    still running, so the browser's own window can take it.
  - **Not fresh** (a browser tab navigated to the web app later, or placed by the user): it only
    changes app; its next close saves under the new key.
  - A new key on the exclusion list stops tracking the window.
- **One-time fallback.** A key with nothing saved restores from its class's layout (data from 1.4.0),
  read only. The first close saves under the new key; from then on the class's layout is never
  read for it. The class's entry expires as usual.
  - When the key is inside the class (`Engine.isSubApp`: `com.google.Chrome.<web app>`; Flatpak
    only exports desktop files named after its id), the layout was shared with the browser: only
    windows whose caption matches (`CAPTION_FALLBACK`) take a save, so a web app never takes the
    browser's slot by size. Otherwise (an app that only changed name, e.g. XWayland `spotify` →
    `com.spotify.Client`) matching is as usual.
  - The browser's next close on a monitor replaces that part of its layout, so a web app opened
    after that finds nothing there. Accepted: the fallback is a one-time convenience.
  - Until then, the browser's own restore still sees the web app's save in its layout (as in
    1.4.0), and its session runs to the deadline. Also one-time.
- **Exclusion list** matches the key or the class, so lists written for classes keep working.
- **Window rules** match the class (and resource name), as KWin does.

## KWin facts
See CONTRIBUTING.md, "KWin facts the script relies on".

## Tests
- `engine.mjs`: `appKeyFor`.
- `lifecycle.mjs`: web app restored with the browser open; browser and two web apps kept apart;
  apps whose key doesn't change keep their saves; exclusion by class; the fallback (by caption
  only, read only, once, and not across desktops).
- `tests/kwin`: `s_web_app_restored_with_browser_open`, `s_browser_and_web_app_separate`,
  `s_web_app_from_older_saves`, with a rule forcing the desktop file name.
