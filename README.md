# Window Geometry Restore

<p align="center">
  <img src="assets/icon.svg" width="120" alt="Window Geometry Restore logo">
</p>

![Release](https://img.shields.io/github/v/release/IamAndelib/window-geometry-restore)
![License](https://img.shields.io/github/license/IamAndelib/window-geometry-restore)
![KDE Plasma](https://img.shields.io/badge/Plasma-6.4%2B-1d99f3)

A KWin script for KDE Plasma 6 on Wayland. It remembers how you left your application windows (position, size, screen and tile) on each virtual desktop and monitor, and puts them back when the app reopens. Built for apps that don't remember their own geometry, like Chrome web apps (WhatsApp Web) and Electron apps. It works with KWin, not against it: window rules, tiling, maximizing and monitor changes stay KWin's.

## Install

**From the KDE Store:** System Settings → Window Management → KWin Scripts → **Get New...** → search *Window Geometry Restore* → Install → enable → Apply.

**From a file:** grab `windowgeometryrestore.kwinscript` from the [releases page](https://github.com/IamAndelib/window-geometry-restore/releases) → KWin Scripts → **Install from File...** → enable → Apply.

**From source:**

```bash
git clone https://github.com/IamAndelib/window-geometry-restore
cd window-geometry-restore
./install.sh
```

When upgrading, log out and back in afterwards — KWin keeps running the old version until the session ends.

> After changing settings, reload the script (untick, Apply, tick, Apply) — a KWin limitation.

## How it works

- **What gets remembered.** When an app's last window on a monitor closes, the windows that closed together there are remembered. That happens per virtual desktop and per monitor, while the app may stay open elsewhere. Windows still open when you log out, shut down or reload the script are remembered too.
- **What comes back:**
  - **When the app starts again,** every window goes back to its own monitor, on the desktop it opens on.
  - **While the app is running,** a new window it opens on a monitor where it has no window yet gets that monitor's layout and stays there. A window opened next to one already open is left where KWin put it.
  - **Each desktop is independent.** Konsole closed on desktop 2 comes back the way you left it on desktop 2, whether or not Konsole is open on desktop 1. An app opening on a desktop where you never closed it opens where it opens. Windows set to show on all desktops share one layout of their own.
- **Matching.** Windows are matched to their remembered slots by caption and size. A clear match applies at once; otherwise the window gets one within a few seconds. If you move a window yourself first, your placement wins.
- **Tiles.**
  - **Back in its tile:** a window that was tiled when it closed (a quick tile or a custom Meta+T tile) reopens in the same tile. Dragging it out gives back the size it had before you tiled it.
  - **Resized quick tiles** come back at their size.
  - **When it applies:** custom tiles right away, quick tiles as soon as the window has focus. The script never focuses a window itself.
  - **Shared tiles:** if another window already sits in that tile, the reopened window takes the tile's current size, because in KWin one tile has one size.
  - **Changed layouts:** if the tile layout changed in the meantime, the window reopens at the tile's position and size instead.
- **Works with KWin:**
  - **Window rules win.** A window that a KWin window rule places or sizes (Apply initially, Force, Force temporarily, Remember) is left to KWin. Rules you add or remove apply to the next window, no reload needed.
  - **Maximized windows** are remembered at their normal size; maximizing again is up to the app.
  - **Monitors.** While a monitor is unplugged, KWin moves its windows to another one and back when it returns. The script keeps their place on their own monitor in the meantime. If the remembered monitor is missing when an app opens, its windows land on the screen under your cursor and move to their monitor if it shows up within a few seconds, for example a monitor that wakes late after login.
  - **Windows already placed** stay as they are: by the app itself, by Plasma's session restore, maximized, tiled or fullscreen. So do windows already open when the script starts. Restores are clamped so nothing lands off-screen.
  - **Geometry only.** Focus, stacking, desktops and window states stay KWin's.
- **Reliable storage.**
  - Layouts are written to disk the moment a window closes, so a crash or power loss still restores the last layout.
  - Each monitor's part of a desktop's layout is kept until the app's next close on that monitor replaces it.
  - Unreadable data, or data from a newer version of the script, is set aside, never destroyed.
  - Layouts unused for 30 days expire.

### Upgrading from 1.3

Layouts are now kept per virtual desktop. Layouts saved by 1.3 had no desktop, so each app restores on a desktop once you've closed it there with 1.4. The old data stays in place, so going back to 1.3 keeps working.

## Configuration

Three settings (⚙ next to the script in KWin Scripts):

| Setting | Default | Purpose |
|---|---|---|
| Excluded applications | a short safe list | Apps to never remember; one per line, `*` acts as a wildcard |
| Restore tiled windows into their tile | on | Off: tiled windows reopen floating at the tile's position and size |
| Verbose debug logging | off | Per-window detail for troubleshooting |

## Troubleshooting

```
journalctl --user -f | grep -i windowgeometryrestore
```

Every save and restore is logged with the app's name, the same name you'd put in the exclusion list. Turn on *Verbose debug logging* for per-window detail.

**Emergency off:**

```
kwriteconfig6 --file kwinrc --group Plugins --key windowgeometryrestoreEnabled false
qdbus6 org.kde.KWin /KWin reconfigure
```

**Where the data lives:** saved layouts are in `~/.config/kde.org/kwin.conf` under `windowgeometryrestore_windows`. Unreadable data is moved aside to `windowgeometryrestore_windows_corrupt`, and data from a newer version to `windowgeometryrestore_windows_v<N>`.

**Window rules the script can't read exactly.** The script reads KWin's rules file itself, because KWin doesn't tell scripts which rules apply. It understands rules made in System Settings. In hand-edited files, a `;` starts a comment for it. A regular expression using syntax JavaScript lacks (for example atomic groups) is matched by its plain text instead; the log says so once.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): how the script works, the KWin behaviour it relies on, the tests (unit tests, plus scenarios against a real headless KWin) and how to try a change without logging out.

## License & credits

GPLv3 — see [LICENSE](LICENSE). Based on [Remember Window Positions](https://github.com/rxappdev/RememberWindowPositions) by rxappdev, rebuilt as a lean, deterministic rewrite.
