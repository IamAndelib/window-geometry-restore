# Window Geometry Restore

KWin script (KDE Plasma 6.4+, Wayland and X11) that saves an app's window geometry when its
last window closes and restores it on the next launch. Geometry only: focus, stacking,
desktops and window states stay native KWin.

## Layout
- `src/contents/ui/main.qml` — runtime: KWin signal wiring, tracking, restore sessions,
  placement, retries, persistence (QtCore `Settings`, key `windowgeometryrestore_windows`).
- `src/contents/ui/engine.js` — pure logic (`.pragma library`, no KWin): matching, the
  saved-data format (compact keys, schema v2), pruning, exclusion list.
- `src/contents/config/main.xml` + `src/contents/ui/config.ui` — settings. The default
  exclusion list is duplicated in `main.qml`; a test checks the two copies match.
- `tests/engine.mjs` — unit tests for `engine.js`.
- `tests/lifecycle.mjs` — extracts the real functions from `main.qml` and runs them against a
  fake KWin. It requires every 4-space-indented `function` in `main.qml` to be listed in
  `REQUIRED_FUNCTIONS`, so update that list when adding or removing functions.
- `tests/kwin/` — scenarios against a real headless KWin (`kwin_wayland --virtual`, 1-2
  virtual monitors), adapted from kde-snap-overlay's test bed. Each scenario gets its own
  D-Bus, HOME and config under the container's `/var/tmp`. Apps are `testwindow.cpp`
  processes, each with its own app id. Monitors are switched off and on with `outputctl.c`,
  and KWin's state is read through probe scripts. Scenarios check that the script works with
  KWin's own mechanisms (window rules, quick tiles, monitor hotplug), not against them.

## State model (main.qml)
- `store` — persisted layouts per app and virtual desktop (`d`), plus the latest one (`w`) for
  older versions; a desktop's layout is kept until the app's next close on that desktop.
- `live` — runtime per group, i.e. an app on one desktop key (`open`, `buffer`, `session`, `settled`).
- `tracked` — runtime per window id; `retries` — geometry writes that have not stuck yet.
- Window close is detected only through `Workspace.windowRemoved`.

## Commands
- `make test` — run all tests (Node 22). Run before every commit; CI runs it on push and PRs.
- `make test-kwin` (`K=name` for some) — the real-KWin scenarios, about 3 minutes; dev container
  only, not in CI. Run them for anything touching screens, tiles, placement or saving.
  `WGR_ROOT=/path/to/copy` runs them against another checkout, for mutation checks.
- `make build` — package `windowgeometryrestore.kwinscript`.
- `make logs` — follow the script's log (`journalctl --user -f | grep WindowGeometryRestore`).

## Trying changes in the live session
KWin caches a loaded script's code for the whole session, so reinstalling does not run new
code until the user logs out and back in. For quick iterations use the test loader instead:

```bash
# once: disable the installed copy so the two don't both act on windows
kwriteconfig6 --file kwinrc --group Plugins --key windowgeometryrestoreEnabled false
qdbus org.kde.KWin /KWin reconfigure          # qdbus6 on some distros

make reload    # (re)load the working tree as script "windowgeometryrestore-test"
make logs      # watch it
make unload    # stop the test copy
```

Each `make load` copies the source to a fresh folder, which sidesteps KWin's cache. The test copy
uses default settings (verbose logging off) and shares the saved data with the installed script.
When done, re-enable the installed script, or run `./install.sh` and log out and back in to run
the new version as the real install.

## Releasing
Bump `Version` in `src/metadata.json`, merge to `main`, then push a matching `v<version>` tag.
The Release workflow refuses a tag that does not match `metadata.json`.

## Current work
- `docs/plans/tile-restore.md` — tiled state and pre-tile size: implemented (see its Status section).
- `docs/plans/per-desktop-restore.md` — independent save/restore per virtual desktop: implemented.
- `docs/plans/per-monitor-restore.md` — independent while running, all back on a fresh start: implemented.
