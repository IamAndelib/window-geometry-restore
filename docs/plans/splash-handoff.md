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
- **A fixed-size window needs evidence** (`matchFor`): a title or size match, or a save near its
  size (`Engine.nearSize`: its frame grew with a theme), never just "the only save left". Its
  own saves match it by size.
- **Undo, don't hold** (`handOff`): the close is saved at once, as every close; if the window
  hands over, the save is undone (`Engine.undoLayout`, only if nothing was saved since).
  Rejected: holding an untouched last close for a few seconds before saving. It delays every
  such save, breaks "written the moment a window closes", and takes a user's quick close and
  reopen for a hand-off.
- **What a hand-off is:** a window of the same app (app key, or window class: rules name
  LibreOffice's components, not its splash) opens on that desktop after the close, within
  `HANDOFF_MS` (3 s; LibreOffice: ~0.8 s), while no other window of the app is open (it is
  starting); the closed window was the only close on its monitor, and untouched: where, and in
  the maximize mode and tile, it was placed, or where it opened (`Engine.keepsPlacement`; a move
  by a shortcut or another script counts, not only a drag); and:
  - the new window comes from the same process (`pid`): prompts, profile choosers;
  - or the closed window couldn't be resized: LibreOffice's first-start splash comes from
    another process than its windows.

  An untouched window is where its save (or KWin) put it, so a mistaken hand-off loses nothing:
  the layout from before puts the next window there again.
- **LibreOffice components** are told apart by KWin rules (README), not by the script: telling
  apps apart by title would split apps whose titles change.

## Limits
- A resizable prompt from another process than the app's window (a launcher) is still saved;
  `Engine.isDialog` catches it when the app has much larger saves.
- A prompt restored to the app's save (the only one left, resizable) still shows at the app's
  size; only its save is undone.
- A window under a Force size rule is fixed-size to KWin, so it hands over across processes
  too; untouched, and placed by its rule anyway, it loses nothing.
- An undone save can come back if another KWin instance rewrote the file meanwhile
  (`persist` adopts layouts on disk that the store lacks).
- A fixed-size app closed untouched and reopened within 3 s gets the layout from before its
  close, which it was placed from anyway; one never saved before opens where KWin puts it, as
  it did.
