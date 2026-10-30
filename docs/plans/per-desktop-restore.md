# Per-desktop restore

## Problem
An app counts as running from its first window to its last, across all virtual desktops. With
Bazaar open on desktop 1, a Bazaar window opened on desktop 2 is "another window of a running
app": it is not restored, and closing it saves nothing.

## Decisions (user, 2026-10-30)
- Each virtual desktop is independent: an app's windows on one desktop are saved and restored
  without regard to its windows on other desktops.
- **No fallback.** An app opening on a desktop where it has no save restores nothing. This
  includes the first launch on each desktop after this update.
- Windows on all desktops (or on several) form one shared group of their own.
- A window moved to another desktop while open joins that desktop's group. Moving it away is
  not a close on the old desktop.
- A restored quick-tiled window joins a tile that already holds another window at the tile's
  current size. One tile has one size in KWin, and the window already there is not resized
  (option A). Option C (each window's size coming back when it is brought forward) was rejected
  as too flaky: it moves the shared split on focus changes.

## KWin facts (6.7.5 source)
- `VirtualDesktop.id` is a UUID kept in `kwinrc [Desktops] Id_N`. It is stable across logins
  and across adding, removing or reordering other desktops.
- A new window's desktops come from window rules and session data, set in
  `XdgToplevelWindow::initialize`, before the script's `windowAdded` handler runs.
  `desktopsChanged` fires on later moves. A window on all desktops has `onAllDesktops` and no
  `desktops`.
- Quick and custom tile layouts are per desktop. `Tile.manage()` returns false for a window that
  is not on the tile's desktop.

## Design
**Groups.** A window's group is its app plus a desktop key: the desktop's `id` when the window
is on exactly one desktop, `*` otherwise. `live` is keyed by group. Each group has its own open
windows, close buffer, restore session and `settled` flag. Tracked entries carry their group. A
`desktopsChanged` handler moves a window from one group to another, and a window that moves
while waiting for its restore is not restored.

**Saved data, compatible both ways:**
```
app: { t, w: [latest layout, any desktop],          read by older versions, never restored from
       d: { "<desktop id>" | "*": { t, w: [...] } } }  per-desktop layouts
```
- When a group's last window closes, its layout is written to `d[key]`, and also to `w` so that
  older versions keep working.
- A restore reads only `d[key]`, so data from older versions (`w` only) restores nothing.
- Pruning works per desktop: a deleted desktop's layouts expire after 30 days. The merge with
  data on disk adopts desktop layouts that memory does not have.

**Tiling fixes found during the review:**
- Tile lookups use the window's desktop, not `Workspace.currentDesktop`. That was wrong for
  windows opening on another desktop, and for KWin 6.7's per-monitor desktops.
- The return value of `Tile.manage()` is checked.
- `restoreQuickSplit` skips a tile that already holds another window (option A).

**Logs** name the desktop: `konsole (desktop 2) closed, saved 1 window(s)`.

## Tests
- `engine.mjs`: the format round-trips; older data and malformed `d` are handled; pruning and
  merging work per desktop.
- `lifecycle.mjs`: desktops in the fake KWin get ids, and windows can move between desktops.
  Cases:
  - restores on two desktops are independent;
  - an app running on desktop 1 does not block a restore on desktop 2;
  - no save on a desktop means no restore;
  - all-desktops windows form one shared group;
  - a window moved between desktops is saved on its new desktop;
  - a window moved while waiting for its restore is not restored;
  - tiles are looked up on the window's desktop;
  - a refused `manage()` is handled;
  - option A.

## Status (2026-10-30): implemented, tested live on Plasma 6.7.5 Wayland
Built as designed. A test of moving a window away during a restore, while the session goes on
for other windows, was added after a mutation check showed the single-window version could not
catch a broken check.
