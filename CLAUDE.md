# Window Geometry Restore

KWin script (KDE Plasma 6.4+, Wayland). It saves an app's window geometry and tiles per virtual
desktop and monitor, and restores them when the app opens there again. It works with KWin, not
against it.

**Read CONTRIBUTING.md first.** It covers the principles, the layout, how the runtime works,
the KWin facts it relies on, testing and releasing. The notes below are only what an agent
needs on top.

## Working rules
- **Develop in the `dev` distrobox.**
  - Run tests and builds there: `distrobox enter dev -- bash -c 'cd <repo> && make test'`.
  - The container shares the host's `$HOME` and session bus. `make load`/`reload`/`install`,
    `kpackagetool6` and `kwriteconfig6` therefore change the user's live desktop: run them only
    to hand over a preview, and say so first. Reading logs is fine.
- **Before committing:**
  - run `make test`;
  - also run `make test-kwin` for anything touching screens, tiles, placement, rules or saving;
  - check the change with a mutation: break it in a copy and confirm a test fails.
- **When you add or remove a function in `main.qml`,** update `REQUIRED_FUNCTIONS` in
  `tests/lifecycle.mjs`. It lists them in file order.
- **KWin behaviour:** check it in KWin's source for the version in the container (`dnf download
  --source kwin` there), not from memory. Record new facts in CONTRIBUTING.md.

## State model (main.qml)
- `store`: persisted layouts per app and desktop (`d`), plus the latest one (`w`) for older
  versions. Each monitor's part of a desktop's layout is replaced by the app's next close on
  that monitor.
- `live`: runtime groups (an app on one desktop key) with `open`, `buffer`, `session` and
  `settled`.
- `tracked`: runtime entries per window id, with `home`, `tile`, `free` and `pendingTile`.
- `retries`: geometry writes that haven't stuck yet.
- A window's close is detected only through `Workspace.windowRemoved`.

## Design notes
- `docs/plans/tile-restore.md`: tiled state and the pre-tile size.
- `docs/plans/per-desktop-restore.md`: independent restore per virtual desktop.
- `docs/plans/per-monitor-restore.md`: monitors independent while an app runs; everything back
  on a fresh start.
