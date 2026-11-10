# Changelog

Notable changes to Window Geometry Restore. Each release's GitHub notes are published from its section here.

## [1.4.2] - 2026-11-10

**Fixes**
- **Web apps named by a window rule on their title open straight at their place, like any app.** A browser shows a web app's window under a placeholder title (WhatsApp: `web.whatsapp.com_/`), and only once it sets the real title does a KWin rule give the window its desktop file name. 1.4.1 took such a window for a browser window: it could reopen with the browser's state (maximized), or at KWin's default place and then jump. Now the script learns how each web app opens: when a window is renamed within 3 s of opening, it remembers the app and title it opened with. A later window opening that way is taken for the web app from the start and restored at once, like Konsole or Dolphin; KWin's name then confirms it and moves nothing. The browser's own windows are restored at once as before. The first launch of a web app is learned this way and corrected after the rename. A guess KWin doesn't confirm within 10 s is forgotten, and the window becomes the browser's again where it is. Titles the browser's own windows have, and windows you have already moved, are never learned from; an opening two web apps share is not guessed.

- **Quick-tiled windows no longer show at their floating size first.** A window restored into a quick tile waits for focus before KWin tiles it; it used to wait at its floating geometry and jump into the tile a moment later. It now waits in the tile's place, and its floating size is handed to KWin only as it tiles, so a drag out of the tile still gives it back.

**Security and performance** (from an expert review of the whole script)
- An app naming itself `__proto__` or `constructor` could alter the JavaScript engine that KWin shares between all scripts and its task switcher. App and desktop names are now kept in maps without a prototype.
- An app with a huge window title could make the script work for seconds inside KWin, freezing the desktop. Titles are stored, matched and tested against window rules only up to their first 256 characters (also limiting what is kept on disk), saves per layout are capped at 32, and matching windows at a restore's deadline scores each title pair once.
- A window renaming itself over and over could force a save on every rename and push out your saved layouts. A window teaches at most two openings, and apps holding nothing but a forgotten opening are dropped first.
- Exclusion-list wildcards are matched without regular expressions, so a long app id can't stall matching.
- Window rules with `\S`, `\D`, `\W` or `\B` in a regular expression are read correctly (they were lowercased into their opposites), and titles are matched as KWin matches them, without the " <2>" or "(Not Responding)" it adds.
- Control characters in app names can't fake lines in the log. A failure loading saved data no longer stops windows that are already open from being adopted.
- The window rules file is read only for apps with a layout to restore.
- The README says what is stored, titles included.
- CI: read-only token by default, write only for publishing a release, no token kept in the checkout, actions pinned to commits. Ctrl-C stops `install.sh` and `bin/load.sh`.

**Under the hood**
- Saved data: an app may carry `o`, how its windows open before KWin names them (optional; older versions ignore it).
- New real-KWin scenarios: a window shown as "New Tab" and renamed to match a title rule, and the browser saved maximized with its web app quick-tiled, reopened with the browser closed and open. Both fail with 1.4.1. 46 scenarios, 230 unit tests.

## [1.4.1] - 2026-11-10

**New**
- **Web apps are apps of their own** ([#5](https://github.com/IamAndelib/window-geometry-restore/issues/5)). Windows are told apart by their desktop file name, as the taskbar does, instead of their window class. A browser's web apps (Web App Hub, a Flatpak Chrome's WhatsApp) each keep their own layout, are restored while the browser is open, and no longer mix their layouts with the browser's. Apps whose desktop file name is their class keep their layouts as before.
- **Upgrading:** an app whose key changes restores once from what 1.4.0 remembered under its class. A web app takes only a save with its caption, and only until its browser next closes there.
- The exclusion list matches the desktop file name as well as the window class.

**Fixes**
- **Window rules are recognised again on Plasma 6.8.** KWin 6.8 lists rules under a new key in `kwinrulesrc` (and rewrites older files to it), so the script no longer saw any rule and placed windows that a rule places or sizes. Rules switched off in System Settings are now ignored, as KWin does.

**Under the hood**
- `tests/kwin` now runs against KWin 6.8.2: 41 scenarios, three new ones for web apps. Unit tests: 189. Each change was checked with a mutation.

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
