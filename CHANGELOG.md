# Changelog

Notable changes to Window Geometry Restore. Each release's GitHub notes are published from its section here.

## [Unreleased]

**Fixes**
- **Splash and welcome screens without a title bar no longer take the main window's place** (QGIS, Kdenlive). They opened first and got the main window's saved size and place, or came back maximized; the main window, opening while they were still open, counted as a second window of a running app and opened in the middle of the screen. Saves now record whether KWin drew a title bar on the window, and a window is never given the layout of a window framed otherwise: a splash or welcome screen without a title bar stays as it opens and isn't saved, and the main window is restored. Saves made before this version don't record it: against those, a window without a title bar that would take the save only as the one left (neither title nor size alike) and is smaller than it both ways isn't given it, so the first launch is right too. An app drawing its own title bars may then miss one restore, after which its save records it.
- **Windows closed maximized fill the screen again when their app also maximizes them** (Kdenlive). An app that asks to be maximized as it shows came back maximized at its normal size, not filling the screen: KWin hadn't confirmed the app's request yet when the script restored the window, so the script's own maximize changed nothing and its normal size stayed. Restoring a window that isn't saved maximized now also overrides such a request, instead of leaving it maximized at its saved size.
- **More precise restores** (found by a precision review, each with a test):
  - A window's own title beats a save that only has its size. Apps open a new window at the size of the last one closed, so reopening one document took the place of another document's window.
  - A window stays on its own monitor when that monitor got smaller since (another resolution or scale, another monitor on the same connector), instead of landing on the next one; a maximized window moved to a smaller monitor reopens maximized there. A title bar no longer lands under a panel moved to the top since.
  - A window maximized only vertically or horizontally keeps your moves and resizes along the other direction.
  - Windows with a maximum size come back at their saved size (KWin's limits are the client's, without the title bar).

**Under the hood**
- Faster restores of many alike windows: the close ranks are computed once per restore, not for every match (a deadline with 32 alike windows: 125 ms of compositor time down to 16 ms, measured in Qt's JS engine).
- README: windows Plasma's session restore placed were said to be left alone; the script can't tell them apart, and the line is corrected.
- Saved data: a save may carry `fr`, whether KWin drew a title bar on the window (optional; older versions ignore it).
- Found and verified with real Kdenlive 26.08.3 in the headless KWin test bed, and with a read-only probe of QGIS 3.28.9 (Flatpak) on Plasma 6.8.2. New real-KWin scenarios (each fails with 1.4.5): a welcome screen beside the main window, a splash before it (with new and with older saves), an app maximizing itself as it shows. The test window can open without a title bar (`frameless`) and ask to be maximized just after showing (`maximize-late`).

## [1.4.5] - 2026-11-18

**Fixes**
- **A single window no longer alternates between monitors** ([#14](https://github.com/IamAndelib/window-geometry-restore/pull/14), fix by @stasadev). With an app's windows closed on two monitors, alike (same title and size), opening one window again took the save closed first, and closing it there made that one the newest: every launch it switched monitors. Saves now remember when they closed: among equal matches, the ones closed last win (closes within 1.5 s of each other count as one go), so the window reopens where it was closed last. Windows closed together, at a logout or when the app quits, still come back in the order they closed, so alike windows don't swap places either. Close times count real time even after the clock ran ahead or was set back. A better title or size match still wins, and the other monitor keeps its save for a second window.
- **Splash screens and startup prompts no longer become the app's layout** (LibreOffice). On Wayland, KWin can't tell a splash screen, or a prompt shown before the app's window, from the app's window. LibreOffice's splash took the saved window's place (off centre: it can't be resized, so it was only moved), and its close a moment later was saved as LibreOffice's layout: Writer then opened at the splash's size, unless it was maximized, and on a first launch too. Now:
  - A window that can't be resized is restored only from a save that matches its title or size, or one of about its size, so a splash screen stays where it opens.
  - When an app's only window closes untouched (where it opened or was restored, not maximized or tiled since) and the app's window opens on that desktop within 3 seconds, with no other window of the app open, from the same process or after a window that couldn't be resized, the closed window handed over to it: its save is undone. As that window was untouched, undoing its save loses nothing you did.
  - This covers other apps' splash screens and startup prompts (profile choosers) the same way.
- **LibreOffice from Flathub: one layout per component.** The Flatpak gives Writer, Calc and the rest one app id, so they shared one layout. The README now has KWin rules that give each component its own name, so each keeps its own layout.

**Under the hood**
- Type checking: `make test` and CI now type-check the shipped JavaScript first (TypeScript, strict), against types for KWin's API and the script's data. Nothing is compiled or shipped differently.
- Saved data: a save may carry `ct`, when its window closed (optional; older versions ignore it, and saves without it are matched as before).
- Real-KWin scenarios: one for the single-window fix (fails with 1.4.4), and one for alike windows across logouts (fails with #14 alone, which made them swap places at every login; found reviewing it). `s_desktops_times_monitors` reopens windows one at a time with titles alike once digits are ignored, which the new rule sends where an alike one closed last: it now uses distinct titles. `s_rapid_open_close` moved windows by script right after their restore, which the restore's retries undid when the app acknowledged late: it drags like a user.
- Splash screens: found and verified with real LibreOffice 26.8 in the headless KWin test bed, with its windows given the Flatpak's shared app id, and with the README's per-component rules. New real-KWin scenarios: a fixed-size splash handing over (fails without the fix), and one handing over to a component a rule renames.
- Pre-release QA: two code reviews, an adversarial debugging pass and a maintainability audit; their findings are fixed and covered by tests, and every new rule was checked by breaking it in a copy (35 such mutations, all caught).

## [1.4.4] - 2026-11-12

**Fixes**
- **A password prompt no longer opens fullscreen or half-screen** ([#3](https://github.com/IamAndelib/window-geometry-restore/issues/3)). Thunderbird and Betterbird ask for the primary password at startup in a window without a parent, before their main window, and on Wayland KWin can't tell such a dialog from the main window. It got the main window's saved state, maximized or tiled, and its close then replaced the main window's layout. A window at its minimum width (sized to its content, as dialogs are) and under half the size of the app's saved windows in both directions is now taken for a dialog: left as it is, not saved, and the main window still comes back as saved, beside it or after it. The same holds for Thunderbird's profile chooser and other dialogs shown without a parent before the main window. A window taken for a dialog that grows (the app or you make it bigger) is the app's window again.

**Under the hood**
- Found and verified with real Thunderbird 158 in the headless KWin test bed, then on Thunderbird 160 and Betterbird 153 on Plasma 6.8.2. New real-KWin scenarios: a prompt before a maximized and before a tiled main window (both fail with 1.4.3).

## [1.4.3] - 2026-11-12

**Fixes**
- **A window moved to another monitor reopens where it was closed** ([#8](https://github.com/IamAndelib/window-geometry-restore/issues/8), fix by @stasadev). Its save on the monitor it left was kept next to the new one, and when both had the same size, the old one won. A closing window now replaces the save it was placed from, on whatever monitor that save is. Monitors the app didn't open a window on this time still keep their part of the layout.
  - Only a save the window was actually put at counts: a window that opened on the laptop screen because the external monitor was unplugged (or docked too late) never left that monitor, and using it while undocked keeps the docked layout.
  - A monitor the app still has windows on keeps the old save until their own close rewrites it, so a crash in between loses nothing.
  - One window per monitor, set up by moving one window around, no longer builds a layout for both monitors: moving the window takes its save along. Open a window on each monitor to keep one there.
- **Maximized and tiled windows keep their state while their monitor is unplugged.** A window closed while its monitor was missing (undocked, then shut down) was saved as a plain screen-sized window, so it came back unmaximized, or untiled, with no size to return to. It is now saved maximized, with its normal size, or in its tile, with its pre-tile size. Also for a window restored onto another screen while its monitor is missing.

**Under the hood**
- New real-KWin scenarios: a window moved to the other monitor (fails with 1.4.2), used while undocked, maximized on a monitor that is unplugged. Pre-release review by a code review and a whole-codebase review; their findings are fixed and covered by tests.

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
