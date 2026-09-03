# Window Geometry Restore

<p align="center">
  <img src="assets/icon.svg" width="120" alt="Window Geometry Restore logo">
</p>

![Release](https://img.shields.io/github/v/release/IamAndelib/window-geometry-restore)
![License](https://img.shields.io/github/license/IamAndelib/window-geometry-restore)
![KDE Plasma](https://img.shields.io/badge/Plasma-6.4%2B-1d99f3)

A KWin script for KDE Plasma 6 (Wayland and X11) that remembers how you left your application windows — position, size and screen — and puts them back when the app reopens. Built for apps that don't remember their own geometry, like Chrome web apps (WhatsApp Web) and Electron apps.

## Install

**From the KDE Store:** System Settings → Window Management → KWin Scripts → **Get New...** → search *Window Geometry Restore* → Install → enable → Apply.

**From a file:** grab `windowgeometryrestore.kwinscript` from the [releases page](https://github.com/IamAndelib/window-geometry-restore/releases) → KWin Scripts → **Install from File...** → enable → Apply.

**From source:**

```bash
git clone https://github.com/IamAndelib/window-geometry-restore
cd window-geometry-restore
./install.sh
```

> After changing settings, reload the script (untick, Apply, tick, Apply) — a KWin limitation.

## How it works

- When an app's **last window closes**, all its windows that closed together are remembered.
- On the next launch, each window is matched to its remembered slot (caption + size, then size, then caption) and restored — instantly when the match is unambiguous, otherwise within a few seconds.
- **Geometry only.** Windows open on the current desktop, in front of you, never minimized or forced above/below. Focus, stacking and desktops stay 100% native KWin.
- **Native-first.** If a window is already where it should be (app self-restore, a KWin window rule, Plasma session restore), the script does nothing. Restores are clamped so nothing lands off-screen; if the remembered screen is missing, windows land on the screen under your cursor.
- **Reliable storage.** Saves are written the moment the last window closes and flushed to disk immediately. Corrupt data is discarded safely, apps already on disk are never erased by a stale reload, and unused entries expire after 30 days.

## Configuration

Two settings (⚙ next to the script in KWin Scripts):

| Setting | Default | Purpose |
|---|---|---|
| Excluded applications | a short safe list | Apps to never remember; one per line, `*` acts as a wildcard |
| Verbose debug logging | off | Per-window detail for troubleshooting |

## Troubleshooting

```
journalctl --user -f | grep WindowGeometryRestore
```

Every save/restore is logged with the app's name — the same name you'd put in the exclusion list. Emergency off:

```
kwriteconfig6 --file kwinrc --group Plugins --key windowgeometryrestoreEnabled false
qdbus org.kde.KWin /KWin reconfigure
```

Saved data lives in `~/.config/kde.org/kwin.conf` under `windowgeometryrestore_windows`.

## Development

```bash
make test      # engine + lifecycle tests (node)
make build     # package into .kwinscript
make refresh   # build + install + reload in the live session
make logs      # follow the script's log output
```

## License & credits

GPLv3 — see [LICENSE](LICENSE). Based on [Remember Window Positions](https://github.com/rxappdev/RememberWindowPositions) by rxappdev, rebuilt as a lean, deterministic rewrite.
