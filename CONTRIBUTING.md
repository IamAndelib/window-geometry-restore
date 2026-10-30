# Contributing

Thanks for helping. This guide covers how the script is built, the facts about KWin it relies
on, and how to test a change before it reaches anyone's desktop.

## Principles
- **Work with KWin, not against it.** KWin already places, tiles and moves windows, and has
  window rules. The script fills one gap, remembering an app's layout across launches, and
  defers to KWin everywhere else:
  - a window a KWin rule places, sizes or maximizes is left to KWin;
  - focus, stacking and desktops are never changed;
  - tiles and the maximized state are restored through KWin's own calls (`Tile.manage`, the
    quick-tile actions, `setMaximize` with a restore geometry), so KWin keeps the geometry to
    return to;
  - KWin's own moves are not taken for the user's layout (a monitor unplugged, a maximized
    window being dragged out).
- **Rely only on what KWin exposes to scripts.** When a behaviour depends on KWin's internals
  (event order on close, the order of the quick tiles), it is checked in KWin's source, noted
  below, and covered by a real-KWin scenario, so a KWin update that changes it fails a test.
- **Never lose a layout.**
  - Saves are written at once.
  - Unreadable data, or data from a newer version, is kept aside, not overwritten.
  - Data stays readable by older versions (schema v2, additive fields only).
- **Plasma 6.4+ on Wayland.** X11 sessions are not tested (Plasma 6.8 drops them).

## Layout
| Path | What |
|---|---|
| `src/contents/ui/main.qml` | Runtime: KWin signals, tracking, restore sessions, placement, tiles, persistence |
| `src/contents/ui/engine.js` | Pure logic, no KWin: the saved-data format, matching, exclusion list, window rules |
| `src/contents/config/main.xml`, `src/contents/ui/config.ui` | Settings. The default exclusion list is also in `main.qml`; a test checks the two copies match |
| `tests/engine.mjs` | Unit tests for `engine.js` |
| `tests/lifecycle.mjs` | The real functions of `main.qml` against a fake KWin |
| `tests/kwin/` | Scenarios against a real, headless KWin |
| `docs/plans/` | Design notes and decisions, one per feature |
| `bin/` | `load.sh` and `unload.sh`, for running the working tree in a live session |

## How the runtime works
- **Groups.** Windows are tracked per *group*: an app on one virtual desktop key (the desktop's
  UUID, or `*` for windows on all or several desktops).
  - Each group has its open windows, a buffer of recent closes, at most one restore session,
    and a `settled` flag. `settled` means the app is running there, and its later windows are
    restored only on a monitor it has no window on yet.
- **Closing.**
  - A closing window is snapshotted into its group's buffer.
  - When the app has no window left on that monitor, the closes there that came together
    (each within 1.5 s of the next) become that monitor's part of the app's layout on that
    desktop.
  - The layout is written to disk at once.
- **Opening.**
  - A window that starts a group (a fresh start) begins a restore session with the desktop's
    whole layout. In a running app, a window on a monitor the app has no window on gets that
    monitor's part only.
  - Windows are matched to saves by caption and size. Unambiguous matches apply at once; the
    rest wait up to 10 s for the set to arrive.
  - A tiled save first goes to its pre-tile geometry and is then tiled, so KWin keeps that
    geometry for a drag out of the tile.
- **While a window is open:**
  - its last tile and last floating geometry are recorded from KWin's signals;
  - its geometry on its own monitor (`home`) is kept while that monitor is unplugged.

### KWin facts the script relies on (checked in KWin 6.7.5's source)
- **Close order.** Tiles connect to `Workspace::windowRemoved` before any script does. On
  close, KWin unmanages the window and may reset the quick-tile split (`QuickRootTile::tryReset`)
  before the script hears of the close, so tiles are recorded while windows are open.
  `requestTile()` ignores deleted windows, so `w.tile` still reads the tile at close.
- **Quick tiles.**
  - They are plain `Tile`s, without `layoutDirection`, under a quick root, created in the
    order L, R, T, B, TL, TR, BL, BR. They share one horizontal and one vertical split.
  - `relativeGeometry` is writable from scripts, and resizes every window in the tile.
  - Quick-tile actions (`slotWindowQuickTile*`) work on the active window.
- **`Tile.manage()`** adds the window and requests the tile, and returns false when it can't.
  Requesting a tile saves the current geometry as the restore geometry.
- **Monitor unplugged.** KWin first moves the window (its frame changes, on a screen list that
  no longer has the old monitor), then emits `outputChanged`, then `screensChanged`. On replug
  it moves windows back itself.
- **Maximizing** untiles a window.
- **Restore geometry.** `setMaximize(v, h, restore)` keeps `restore` as the geometry to return to,
  but only when the maximize state changes (an unchanged mode returns early). A window mapped
  maximized by its app has no restore geometry. Dragging a maximized window out unmaximizes it
  and moves it under the pointer at once; on Wayland its size only shrinks once the app has
  followed.
- **Rules.** Window rules are not exposed to scripts. The script reads `kwinrulesrc` through
  QSettings, which hands lists over as QML sequences, not Arrays, and drops escape sequences
  it doesn't know.

## Testing
All tests run in a development container. On the host, only the step of trying a build changes
anything.

| Layer | Command | What it covers |
|---|---|---|
| Unit | `make test` (Node 22) | `engine.js`, plus `main.qml`'s functions against a fake KWin. Runs in CI. |
| Real KWin | `make test-kwin` (`K=name` to filter) | Real windows, monitors, tiles, rules and logouts in a headless KWin, about 5 minutes |

- **`make test`** runs before every commit.
- **`make test-kwin`** runs for anything touching screens, tiles, placement, rules or saving.
  - Every scenario also fails if the script logged an error.
  - Scenarios assert their own preconditions, so they can't pass vacuously.
- **The lifecycle harness** extracts every function at 4-space indent from `main.qml`, and
  `REQUIRED_FUNCTIONS` lists them in file order. Update the list when you add or remove one.
- **Mutation checks.** Break the code you changed in a copy, and make sure a test fails:
  - unit tests: run them inside a copy of `src/` and `tests/`;
  - real-KWin scenarios: `WGR_ROOT=/path/to/copy make test-kwin K=…`.

### The development container
The real-KWin scenarios start their own `kwin_wayland --virtual`, with their own D-Bus and HOME
under `/var/tmp`. They need, from Fedora's packages:

```
kwin plasma-breeze qt6-qtdeclarative qt6-qtwayland qt6-qtbase-devel python3-pywayland
dbus-daemon gcc gcc-c++ wayland-devel plasma-wayland-protocols-devel nodejs
```

Use a distrobox or toolbox. It shares `$HOME` and the session bus with the host, so never run
`make load`/`install`, `kpackagetool6` or `kwriteconfig6` from it unless you mean to change your
own desktop.

### Trying a change in your session
KWin caches a loaded script's code for the whole session. To run the working tree without
logging out:

```bash
# once: disable the installed copy, so the two don't both act on windows
kwriteconfig6 --file kwinrc --group Plugins --key windowgeometryrestoreEnabled false
qdbus6 org.kde.KWin /KWin reconfigure

make reload    # (re)load the working tree as the script "windowgeometryrestore-test"
make logs      # follow its log (and QML errors from its files)
make unload    # stop it, then enable the installed copy again
```

The test copy uses default settings and shares the saved data with the installed script.

## Style
- **Code style:** 4-space indentation, no semicolons in QML/JS. `main.qml` is split into
  sections in reading order, so keep new functions in their section.
- **Comments say why,** or what KWin does that makes the code necessary.
- **Logging:**
  - `log()` is for outcomes a user may want to know (saved, restored, left to KWin,
    failures);
  - `dbg()` is for detail;
  - `logOnce()` is for problems that would repeat on every window or frame.
- **Saved data:** extend it only with optional fields, so older versions keep reading it.

## Releasing
1. Bump `Version` in `src/metadata.json`.
2. Add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md`; it becomes the release notes.
3. Merge to `main`, then push a matching `v<version>` tag.

The Release workflow refuses a tag that doesn't match `metadata.json` or has no changelog
section.
