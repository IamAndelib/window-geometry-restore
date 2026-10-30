# Per-monitor restore

## Decisions (user, 2026-10-30)
Option 2: independent while the app runs, back to their own monitors on a fresh start.
- **Saving:** when an app's last window on a monitor closes, that monitor's part of the app's
  layout (per desktop) is replaced. The other monitors' parts stay.
- **Fresh start** (the app is not running on this desktop): the whole layout is restored, every
  window back on its own monitor. That includes monitors whose windows closed at different times.
- **App already running:** a new window opened on a monitor where the app has no window gets that
  monitor's part of the layout only, and stays on that monitor. A window opened next to one already
  there is left where KWin put it.
- The script works with KWin, not against it: it keeps returning windows to their monitor, as KWin
  does for open windows when a monitor comes back.

## Design
- **Which monitor a window is on** is worked out when needed (`monitorOf`): `w.output`, or the
  window's own monitor while KWin keeps it elsewhere (`isAway`). Moving a window to another monitor
  needs no extra tracking.
- **Monitor identity** (`sameMonitor`): two saved screens are the same monitor if `resolveOutput`
  maps them to the same connected screen (serial and name, a serial no other screen shares, then
  the name). When neither is connected, they must have the same name and serial.
- **Close buffers** remember each close's monitor. `finalizeMonitor` takes that monitor's burst
  of closes and merges it into the desktop layout.
- **A group counts as running from its first window** unless a restore session is under way. A
  mutation check found the gap: an app whose first window had nothing to restore never counted as
  running. Once a monitor's layout could be saved while the app is open, a later window would get a
  fresh-start restore, possibly onto another monitor.

## Tests
- `lifecycle.mjs`:
  - saving one monitor while the app stays open on the other;
  - a running app restoring from the new window's monitor only;
  - a window next to an existing one left alone;
  - both monitors back on a fresh start;
  - a window moved to another monitor;
  - unplugged windows belonging to their own monitor;
  - a monitor back under another connector name;
  - the running-app gap above.
- `tests/kwin/scenarios.py`: the same against a real KWin. `s_monitors_independent_while_running`
  fails with the old "a running app never restores" rule, so it guards the change.

## Status (2026-10-30): implemented; unit tests and all 16 real-KWin scenarios pass
