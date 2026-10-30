# Changelog

Notable changes to Window Geometry Restore. Each release's GitHub notes are published from its section here.

## [1.4.0] - 2026-10-30

Tiles, virtual desktops and monitors, and working with KWin instead of around it. Every change was checked against a real KWin.

**New**
- **Tiled windows come back in their tile.** That covers quick tiles (halves and quarters) and custom Meta+T tiles. A resized quick tile comes back at its size, and dragging a window out of its tile gives back the size it had before you tiled it. Quick tiles apply as soon as the window has focus; the script never focuses a window itself. You can turn this off with the new setting *Restore tiled windows into their tile*.
- **Each virtual desktop keeps its own layout.** An app open on one desktop no longer keeps it from being restored on another, and closing it on one desktop no longer overwrites another desktop's layout. Windows on all desktops share a layout of their own.
- **Each monitor keeps its own part of the layout.**
  - When an app's last window on a monitor closes, that monitor's layout is saved, even while the app stays open on another monitor.
  - On a fresh start every window goes back to its own monitor.
  - While the app runs, a new window on a monitor where it has no window yet gets that monitor's layout. A window opened next to an open one stays where KWin put it.

**Works with KWin**
- **Window rules win.** A window that a KWin rule places, sizes or maximizes (Apply initially, Force, Force temporarily, Remember) is left to KWin. The rules are read as System Settings writes them, with no reload needed when they change.
- **Maximized windows come back maximized,** and dragging them out (or the maximize button) gives back their size from before. That also holds for apps that reopen maximized, or at their maximized size (System Monitor), by themselves: KWin gets the normal size from the script, through its own `setMaximize`. Before, such windows came back as screen-sized floating windows that a drag only moved. A window tiled and then maximized no longer reopens tiled.
- **Unplugged monitors.** When a monitor goes away, KWin parks its windows on another one, and its later return no longer costs them their place. The same holds when a quick-tiled window is sent to another monitor.
- **Shared quick tiles:** a window joining a quick tile that already holds another window takes the tile's current size, instead of resizing the window already there.

**Fixes**
- A window that KWin moved, or that was moved to another desktop, no longer loses the closes waiting to be saved on the monitor it left.
- A window closed while still waiting for its quick tile keeps the tile.
- A restore running for one monitor no longer takes a window that opens on another.
- **System Settings is remembered** like any other app: it was on the default exclusion list (inherited from upstream) for no reason this script has.

**Hardening**
- **Errors are visible.** Errors in signal handlers are logged under the script's name, and failures that would lose a save are logged without verbose logging. `make logs` also shows QML errors from the script's files.
- **Saved data is never overwritten silently:**
  - an unreadable blob found when saving is kept aside;
  - so is data written by a newer version of the script;
  - the data file is named explicitly (the same file as before).
- **Saving is lighter:** it skips reading the data back when no other KWin instance wrote it in between.

**Under the hood**
- `tests/kwin`: 38 scenarios run against a real, headless KWin with virtual monitors: tiles, maximizing, window rules, desktops, two and three monitors, hotplug, logouts, many windows, rapid open and close, and 500 apps of saved data.
- Unit tests: 175 (engine and lifecycle). Each fix was checked with a mutation: with the fix removed, a test fails.
- `main.qml` is organised into sections; `CONTRIBUTING.md` describes the design, the KWin behaviour it relies on, and how to test.
- The saved data stays schema v2 (new fields only), so 1.3 keeps reading it.

**Upgrading from 1.3:** layouts are now kept per virtual desktop. Each app restores on a desktop once you've closed it there with 1.4. Older data stays in place, so going back to 1.3 keeps working.

**Requirements:** Plasma / KWin 6.4+ on Wayland (tested on 6.7.5).

Install via System Settings → Window Management → KWin Scripts → *Get New…* or *Install from File…*, or clone and run `./install.sh`. Log out and back in after an upgrade.

## Earlier versions

1.3.0 and older: see the [releases page](https://github.com/IamAndelib/window-geometry-restore/releases).
