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
- **Read once,** when the window is tracked. A later change of desktop file name doesn't move the
  window to another group.
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
