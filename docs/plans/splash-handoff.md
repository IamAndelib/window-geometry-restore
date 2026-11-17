# Splash screens and startup prompts (1.4.5)

## Problem
On Wayland, KWin can't tell an app's splash screen, or a prompt shown before its window (a
profile chooser), from the app's window: both are normal xdg toplevels (`splash` is X11 only).
The script then:
- restored them with the app window's save: LibreOffice's splash, which can't be resized, was
  only moved, off centre;
- saved their close as the app's layout: a splash closes a moment before the app's window
  opens, which was then restored to the splash's size (resizable, matched as the only save
  left). On a first launch too: nothing saved, so the splash's close was the first layout.

Flathub's LibreOffice made it worse: KWin gives every window of a sandboxed client whose app id
doesn't start with the sandbox's the sandbox's id (`XdgToplevelWindow::handleAppIdChanged`), so
the splash, Writer and Calc are one app to the script.

## Decisions
- **A fixed-size window needs evidence** (`matchFor`): only a title or size match restores it,
  never "the only save left". Its own saves always match it by size.
- **Undo, don't hold** (`handOff`): the close is saved at once, as every close; if the window
  hands over, the save is undone (`Engine.undoLayout`, only if nothing was saved since).
  Rejected: holding an untouched last close for a few seconds before saving. It delays every
  such save, breaks "written the moment a window closes", and takes a user's quick close and
  reopen for a hand-off.
- **What a hand-off is:** the closed window was the app's only window, untouched (no user move
  or resize; the maximize mode and tile it was placed in), and a window of the same app (app key
  or window class: rules name LibreOffice's components, not its splash) opens on that desktop
  within `HANDOFF_MS` (3 s; LibreOffice: ~0.8 s), and:
  - comes from the same process (`pid`): prompts, profile choosers; a user reopening an app
    starts a new process, so that close stands;
  - or the closed window couldn't be resized: LibreOffice's first-start splash comes from
    another process than its windows.
- **LibreOffice components** are told apart by KWin rules (README), not by the script: telling
  apps apart by title would split apps whose titles change.

## Limits
- A resizable prompt from another process than the app's window (a launcher) is still saved;
  `Engine.isDialog` catches it when the app has much larger saves.
- A prompt restored to the app's save (the only one left, resizable) still shows at the app's
  size; only its save is undone.
- A fixed-size app closed untouched and reopened within 3 s gets the layout from before its
  close, which it was placed from anyway.
