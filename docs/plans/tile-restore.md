# Feasibility: restoring tiled state and pre-tile size

## Context
**What the user sees today:**
- A window tiled and then closed comes back at the tiled **position and size**, but **not tiled**.
- Dragging it away afterwards keeps the tiled size.

**Why:** `snapshotWindow` (`src/contents/ui/main.qml:150`) saves the window's frame at close. For a tiled window that frame is the tile rect, and the script never records that the window was tiled. On restore, `canPlace` (`main.qml:361`) only knows geometry.

**The user asked whether two things are possible, and how:**
1. Restore the tiled state itself.
2. Remember the pre-tile size, so that dragging the window out of the reopened tile gives back the earlier floating size.

**Research done:**
- **KWin's C++ source:** branches `Plasma/6.4`, `6.5`, `6.6` and `master`, plus `v6.0`–`6.3` for history.
- **Prior art:** rxappdev/RememberWindowPositions v7 (this repo's upstream), KZones, Polonium, Krohnkite/Bismuth, yclee126/kwin-pretile-restore, plasma-fusion, goblincakes, Pyntara, novelsavage/kde-window-snap, PlasmaZones.
- **Not verified:** nothing was run in a live KWin. bugs.kde.org and invent.kde.org were unreachable from the session.

## Verdict: both are feasible, and one mechanism delivers both

### What KWin's code shows
**Tiles are reachable from scripts (Plasma 6.4+, which is this script's minimum):**
- `window.tile` is non-null for **both** quick tiles (halves/quarters) and custom Meta+T tiles.
- `Tile.manage(window)` assigns a window to a tile. Writing `window.tile = t` still works but is deprecated since 6.4.
- `Workspace.rootTile(output, desktop)` returns the custom-tiling root for a screen and desktop. The tree is walkable through `tile.tiles` and checkable through `relativeGeometry`/`absoluteGeometry`.

**KWin stores the pre-tile size by itself, at the moment a tile is assigned.** `Window::requestTile` (window.cpp ~L3893) does:
```cpp
if (tile && !m_requestedTile && !m_tile) setGeometryRestore(quickTileGeometryRestore()); // = current free geometry
```
The quick-tile shortcut path does the same: "Store geometry first, so we can go out of this tile later".

When the user drags a tiled window, KWin untiles it and resizes it to that stored geometry, under the cursor (`handleInteractiveMoveResize`). So whatever free rect the window has right before it is tiled becomes the size it returns to.

### Consequence
If, on reopen, the script **first sets the window to its remembered pre-tile rect and then tiles it**, KWin records that rect as the restore geometry. The window shows up tiled (feature 1), and dragging it out restores the pre-tile size (feature 2) through KWin's own native behavior, with no custom drag handling.

Upstream RememberWindowPositions already re-tiles windows. It applies the steps in the opposite order (tiled rect first, then tile), which is why it has exactly the drag-out problem described here.

### What KWin does not provide, and how to work around it
| Gap | Workaround |
|---|---|
| `geometryRestore` (pre-tile size) is not readable from scripts | Track it ourselves: a per-window "last floating rect", updated on `frameGeometryChanged` only while the window is free. This is the approach PlasmaZones and kwin-pretile-restore use. It is safe because `window.tile` reads the *requested* tile, which KWin sets before it moves the window into the tile, so tile-sized frames are never recorded. |
| Tiles have no stable id across restarts | Store an identity and re-resolve it on reopen:<br>• **quick tile:** its index among the 8 quick tiles (KWin creates them in a fixed order: L, R, T, B, TL, TR, BL, BR)<br>• **custom tile:** its child-index path from the root, plus `relativeGeometry` to check it, with `bestTileForPosition` as a fallback |
| No script handle to the quick-tile root for a new window | Primary: `Workspace.slotWindowQuickTile<Side>()`. It applies to the **active** window and is exactly what the user's shortcut does, including saving the restore geometry. If the window isn't active yet, wait for it to become active during the 10 s restore window. Do not steal focus (upstream does), to keep the script's "focus stays native" guarantee. Secondary: reuse a cached quick-tile root from any window already quick-tiled on that screen and desktop (`w.tile.parent`), and call `.tiles[i].manage(w)`. |
| KWin itself never persists tile state (session management, Wayland session data and window rules all lack it; no native support was found or planned) | It has to be done in the script, as above |

## Implementation plan (if approved)

**Saving, in `main.qml`:**
- Add a `free` record to each tracked entry: the window's last floating rect, output-relative like saves are today.
  - It is updated from a `frameGeometryChanged` handler, only when the window is not tiled, maximized or fullscreen. The handler is a few comparisons.
  - It is seeded when the window is tracked, and when the script restores a pre-tile rect.
- In `snapshotWindow`, when `w.tile` is set, also save:
  - `t`: a tile descriptor, either `{ k: 'q', i: 0–7 }` for a quick tile or `{ k: 'c', p: [path], g: relativeGeometry }` for a custom tile. A quick tile is the one whose parent has no parent and that has no `layoutDirection`.
  - `f`: the pre-tile rect, falling back to the tiled rect when it's unknown, for example for windows adopted at startup.

**Saved-data format, in `engine.js`:** add the optional fields `t` and `f` to `encodeSave`/`decodeSave`, with validation, rejecting malformed descriptors.
- This is an additive change; the version stays at 2.
- Older versions of the script ignore the new keys, so saved data stays compatible both ways.

**Restoring, in `applySave` / a new `applyTile`:**
1. If the save has a tile and the window is resizable, place the window at the **pre-tile rect** `f`, using the existing `targetFor` so it lands on the right screen.
2. Then tile it:
   - **custom:** `Workspace.rootTile(output, Workspace.currentDesktop)`, walk the path, check `relativeGeometry` within a tolerance (or use `bestTileForPosition` on the saved tile centre), then `tile.manage(w)`;
   - **quick:** if `w.active`, call the matching `Workspace.slotWindowQuickTile*()`. Otherwise connect once to `activeChanged`, and do the same if the window becomes active before the session deadline. Use the cached quick root when one is available.
3. If the tile can't be resolved (layout edited, screen gone), fall back to today's behavior: plain geometry at the tiled rect. The window never ends up worse off than it does now.
4. The existing rules stay as they are:
   - A user drag before restore wins; that is the `userPlaced` path.
   - Retries stop once the window is tiled, because `canPlace` sees `w.tile`.
   - Windows that already exist when the script starts are never touched.

**Configuration:** add a "Restore tiled windows into their tile" checkbox, on by default, to `config/main.xml`, `config.ui`, `loadConfig` and the README table. Users who prefer floating reopens can turn it off.

**Tests, in `tests/lifecycle.mjs`:** the fake KWin gains:
- tile trees (a quick root with 8 children; a custom root with nested `tiles` and `relativeGeometry`);
- `Workspace.rootTile`;
- `Tile.manage`, modelling KWin's rule that the free geometry at manage time becomes the restore geometry;
- quick-tile slots acting on the active window;
- `activeChanged` / `frameGeometryChanged` signals.

New tests cover:
- custom and quick tiles are re-applied on reopen;
- the restore geometry equals the pre-tile rect, so drag-out gives back the pre-tile size;
- quick-tiling waits for activation and never steals focus;
- a fallback when a tile path no longer exists;
- the pre-tile rect is not overwritten by tile-sized frames;
- older saves without `t`/`f` still restore as before.

**Files:** `src/contents/ui/main.qml`, `src/contents/ui/engine.js`, `src/contents/config/main.xml`, `src/contents/ui/config.ui`, `tests/*.mjs`, `README.md`.

## Risks and limits to state plainly
- **A visible jump on Wayland:** KWin reports a new window to scripts only after its first frame, so a tiled window appears briefly before it snaps into its tile. Plain geometry restores already do this.
- **Quick tiles need the window to become active within ~10 s.** A window that opens in the background, without focus, stays at its plain tiled rect.
- **A custom layout edited between sessions** may not resolve. The geometry check rejects a wrong tile, and the window falls back to a plain restore.
- **Unverified Wayland timing:** the timing in KWin's code (the tile is committed only when the app acknowledges) has only been checked by reading the code. It needs a live test on the user's Plasma 6 Wayland session before release.
- **Optional, only if live testing shows apps fighting the tile:** if an app (e.g. Electron) resizes itself out of the tile in the first seconds, re-apply the tile once. This is goblincakes' "re-assert" guard; add it only if needed.

## Verification
- `make test`: the existing 49 tests plus the new tile tests.
- Live test on Plasma 6 Wayland, using `make load` or installing and then logging out and back in:
  1. Tile a window left (quick) and close it. On reopen it should be tiled left; dragging it out should give back the size it had before tiling.
  2. The same with a custom Meta+T tile.
  3. Open the app in the background: it stays plain-placed until focused, then tiles. Focus is never stolen.
  4. Edit the custom layout and reopen: no wrong tile is applied; the window gets a plain restore.
  5. Untick the new setting: windows reopen floating, as before.
