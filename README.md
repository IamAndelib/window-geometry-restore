# Window Geometry Restore

Source: [github.com/IamAndelib/window-geometry-restore](https://github.com/IamAndelib/window-geometry-restore)

A KWin script for KDE Plasma 6 that remembers how you left your application windows - position, size and screen - and puts them back when the app reopens.

It is a **lightweight assistant to KWin's native window management**: it only fills the gap where geometry restore fails, and never fights the window manager.

It restores **geometry only**: windows always open on the current virtual desktop, in front of you, never minimized, never forced above or below other windows. Desktop, focus and stacking stay 100% native KWin.

Based on [Remember Window Positions](https://github.com/rxappdev/RememberWindowPositions) by rxappdev, rebuilt as a lean, deterministic rewrite. GPLv3 (see LICENSE).

## Why this exists

On Wayland, applications are **not allowed** to know or set their own screen position - the compositor decides. Apps like Chrome/Chromium web apps (e.g. WhatsApp Web), Electron apps and many others therefore can never remember their own window position. KWin's window rules can help, but one rule remembers one geometry for *all* windows of an app, which breaks multi-window apps.

This script does the remembering on the compositor side, per window:

1. When the last window of an application closes, all of its windows that closed together (within ~1.5s) are remembered.
2. The next time the app opens, each window is matched to its remembered slot deterministically (caption + size, then size, then caption) and restored - instantly when the match is unambiguous, otherwise within a bounded window of a few seconds.

## Design principles

- **Install and forget.** Two settings total; sane defaults for everything else.
- **Geometry only.** Position, size and screen - nothing else. Virtual desktop, minimized state, keep-above/below, activities and focus are all left to KWin's native behavior.
- **Monitor-aware automatically.** Single monitor: geometry is restored directly, even if the connector name changed. Multi-monitor: the saved screen is matched by serial number (then name) and the position is mapped screen-relatively. If the saved screen is missing (unplugged dock, laptop mode), the window lands on the screen under your cursor at the same relative position, with its size clamped to that screen.
- **Native-first.** If a window is already where it should be (app self-restore, KWin window rules, Plasma session restore), the script does nothing. If a restore doesn't stick (e.g. a forced window rule owns the window), the script gives up silently instead of retrying forever.
- **Never touches focus, stacking or z-order.** KWin owns those. This avoids the focus-stealing bugs that plague heavier scripts.
- **Respects window states.** Tiled, maximized, fullscreen, splash, modal and transient windows are left to KWin.
- **Never restores off-screen.** Geometry is clamped to the current screen area, so monitor changes can't strand windows.
- **Crash-proof storage.** Corrupt saved data is discarded safely instead of breaking the session.

## Installation

From System Settings: `Window Management` > `KWin Scripts` > `Get New...` (once published to the KDE Store).

From file:

```
make build
```

Then install `windowgeometryrestore.kwinscript` via `System Settings` > `KWin Scripts` > `Install from File...`, enable it and Apply. Settings changes require reloading the script (untick, Apply, tick, Apply) due to a KWin limitation.

## Configuration

Just two settings (click the configure button next to the script):

| Setting | Default | Purpose |
|---|---|---|
| Excluded applications | a short safe list | Apps to never remember. One per line; `*` is a wildcard (e.g. `steam*`) |
| Verbose debug logging | off | Detailed per-window logging for troubleshooting |

That's all. Matching thresholds, timeouts and clamping are internal constants tuned once to work for everyone.

## Troubleshooting

Every save/restore action is logged with an `WindowGeometryRestore:` prefix. To follow along:

```
journalctl --user -u plasma-kwin_wayland -f | grep WindowGeometryRestore
```

(on X11: `journalctl -f -t kwin_x11 | grep WindowGeometryRestore`). Enable *Verbose debug logging* for per-window detail. The application name you need for the exclusion list appears in these logs.

Saved data lives in `~/.config/kde.org/kwin.conf` under the key `windowgeometryrestore_windows`. Unused entries expire after 30 days.

Emergency disable:

```
kwriteconfig6 --file kwinrc --group Plugins --key windowgeometryrestoreEnabled false
qdbus org.kde.KWin /KWin reconfigure
```

## Compatibility

- Plasma 6.4+ (Wayland and X11).
- Coexists with KWin window rules and Plasma's session restore: windows that those mechanisms already place correctly are not touched.
- Not needed on X11 for apps that remember their own geometry - and harmless there, since correctly-placed windows are skipped.

## Development

```
make test    # unit tests for the matching engine (node)
make build   # package into .kwinscript
make install # install via kpackagetool6
make load    # live-load from source dir without packaging (test instance)
make reload  # reload the test instance
make logs    # follow the script's log output
```
