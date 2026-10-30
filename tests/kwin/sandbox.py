"""A real, headless KWin to test window-geometry-restore against.

Adapted from kde-snap-overlay's test bed. Each Sandbox starts its own
`kwin_wayland --virtual` with N virtual outputs, its own D-Bus session bus and
its own HOME/XDG dirs under the container's /var/tmp, so nothing reaches the
user's real session or config. Inside it:

- the working tree's script (src/) is installed and enabled, verbose logging on;
- apps are tests/kwin/testwindow.cpp processes, each with its own app id
  (KWin's resourceClass), decorated by Breeze;
- the pointer is driven through KWin's org_kde_kwin_fake_input protocol, and
  monitors are moved or unplugged through kde_output_management_v2
  (tests/kwin/outputctl.c);
- KWin's state is read by loading tiny JS "probe" scripts over D-Bus that
  print JSON into KWin's log;
- KWin can be restarted in the same HOME (a logout and login), and the
  script's saved data is read from that HOME.

Run inside the dev container only: python3 -I tests/kwin/scenarios.py
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
# WGR_ROOT=/path/to/checkout tests another copy of the script (mutation checks).
REPO = Path(os.environ.get("WGR_ROOT") or HERE.parents[1])
PKG_ID = "windowgeometryrestore"
STORE_KEY = "windowgeometryrestore_windows"
QDBUS = shutil.which("qdbus-qt6") or shutil.which("qdbus6") or "/usr/lib64/qt6/bin/qdbus"
BTN_LEFT = 0x110
LOG_PREFIX = "WindowGeometryRestore: "


class SandboxError(RuntimeError):
    pass


def _build(out_dir):
    """Compile outputctl.c and testwindow.cpp once per sandbox."""
    out_dir.mkdir(parents=True, exist_ok=True)
    proto = "/usr/share/plasma-wayland-protocols/"
    sources = [str(HERE / "outputctl.c")]
    for xml in ("kde-output-device-v2", "kde-output-management-v2"):
        subprocess.run(["wayland-scanner", "client-header", proto + xml + ".xml",
                        str(out_dir / (xml + "-client-protocol.h"))], check=True)
        subprocess.run(["wayland-scanner", "private-code", proto + xml + ".xml",
                        str(out_dir / (xml + "-protocol.c"))], check=True)
        sources.append(str(out_dir / (xml + "-protocol.c")))
    outputctl = out_dir / "outputctl"
    subprocess.run(["gcc", "-O1", "-Wall", "-Wextra", "-Werror", "-I", str(out_dir), "-o", str(outputctl),
                    *sources, "-lwayland-client", "-lm"], check=True)
    qt = subprocess.run(["pkg-config", "--cflags", "--libs", "Qt6Gui"], check=True,
                        capture_output=True, text=True).stdout.split()
    testwindow = out_dir / "testwindow"
    subprocess.run(["g++", "-std=c++17", "-fPIC", "-O1", "-Wall", "-Wextra", "-Werror",
                    "-o", str(testwindow), str(HERE / "testwindow.cpp"), *qt], check=True)
    return outputctl, testwindow


class Pointer:
    """The driver's own Wayland client for pointer input, through
    org_kde_kwin_fake_input (pywayland; bindings generated on the fly)."""

    def __init__(self, socket_path, proto_dir):
        # The generated modules import each other relatively, so they need a
        # parent package.
        pkg = proto_dir / "wgr_proto"
        pkg.mkdir(parents=True, exist_ok=True)
        (pkg / "__init__.py").touch()
        subprocess.run([sys.executable, "-m", "pywayland.scanner", "-i",
                        "/usr/share/wayland/wayland.xml",
                        "/usr/share/plasma-wayland-protocols/fake-input.xml",
                        "-o", str(pkg)], check=True, capture_output=True)
        sys.path.insert(0, str(proto_dir))
        from pywayland.client import Display  # noqa: E402
        from wgr_proto.fake_input import OrgKdeKwinFakeInput  # noqa: E402

        self.display = Display(str(socket_path))
        self.display.connect()
        self.fake = None
        registry = self.display.get_registry()

        def on_global(reg, name, interface, version):
            if interface == "org_kde_kwin_fake_input":
                self.fake = reg.bind(name, OrgKdeKwinFakeInput, min(version, 4))

        registry.dispatcher["global"] = on_global
        self.display.roundtrip()
        if self.fake is None:
            raise SandboxError("KWin offers no org_kde_kwin_fake_input")
        self.fake.authenticate("wgr-tests", "window-geometry-restore integration tests")
        self.display.roundtrip()

    def move(self, x, y):
        self.fake.pointer_motion_absolute(float(x), float(y))
        self.display.flush()

    def button(self, pressed, button=BTN_LEFT):
        self.fake.button(button, 1 if pressed else 0)
        self.display.flush()

    def close(self):
        try:
            self.display.disconnect()
        except Exception:
            pass


class App:
    """One test window, in its own process."""

    def __init__(self, sandbox, title, proc):
        self.sandbox = sandbox
        self.title = title
        self.proc = proc

    def close(self):
        """The app quits: KWin removes its window."""
        if self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(3)
        self.sandbox.wait(lambda: self.sandbox.window(self.title) is None, 5, "close of " + self.title)
        self.sandbox.settle(0.2)


class Sandbox:
    def __init__(self, outputs=2, width=1920, height=1080, script_config=None,
                 windows_config=None, desktops=1, desktop_ids=None, rules=None, keep=False):
        self.outputs = outputs
        self.width = width
        self.height = height
        self.script_config = {"debug": "true", **(script_config or {})}
        self.windows_config = windows_config or {}
        self.desktops = desktops
        # Fixed desktop ids (kwinrc Id_N), so that a window rule can name a desktop.
        self.desktop_ids = desktop_ids or []
        self.rules = rules or []
        self.keep = keep
        self.kwin = None
        self.bus = None
        self.clients = []
        self.pointer = None
        # /var/tmp is the container's own (distrobox shares /tmp and $HOME
        # with the host); WGR_SANDBOX_DIR overrides.
        self.root = Path(tempfile.mkdtemp(prefix="wgr-kwin-",
                                          dir=os.environ.get("WGR_SANDBOX_DIR", "/var/tmp")))
        self.log_path = self.root / "kwin.log"
        self._log_offset = 0

    # ---- lifecycle -------------------------------------------------------

    def __enter__(self):
        try:
            self.start()
        except BaseException:
            # __exit__ never runs for a failed start: don't leak KWin.
            self.stop()
            raise
        return self

    def __exit__(self, *exc):
        self.stop()

    def _env(self):
        env = {k: v for k, v in os.environ.items()
               if k not in ("WAYLAND_DISPLAY", "DISPLAY", "DBUS_SESSION_BUS_ADDRESS",
                            "XDG_SESSION_TYPE", "KDE_FULL_SESSION")}
        env.update({
            "HOME": str(self.root / "home"),
            "XDG_CONFIG_HOME": str(self.root / "config"),
            "XDG_DATA_HOME": str(self.root / "data"),
            "XDG_CACHE_HOME": str(self.root / "cache"),
            "XDG_STATE_HOME": str(self.root / "state"),
            "XDG_RUNTIME_DIR": str(self.root / "run"),
            "DBUS_SESSION_BUS_ADDRESS": "unix:path=" + str(self.root / "bus"),
            "WAYLAND_DISPLAY": str(self.root / "run" / "wayland-wgr"),
            "QT_QPA_PLATFORM": "wayland",
            "KWIN_WAYLAND_NO_PERMISSION_CHECKS": "1",
            "QT_LOGGING_RULES": "js=true;qml=true;kwin_scripting=true",
            # Qt logs to the journal when stderr is no terminal; keep it in our log.
            "QT_FORCE_STDERR_LOGGING": "1",
        })
        return env

    def _write_config(self):
        cfg = self.root / "config"
        lines = ["[Plugins]", PKG_ID + "Enabled=true", "", "[Script-" + PKG_ID + "]"]
        lines += ["%s=%s" % kv for kv in self.script_config.items()]
        lines += ["", "[Windows]"] + ["%s=%s" % kv for kv in self.windows_config.items()]
        lines += ["", "[Desktops]", "Number=%d" % self.desktops, "Rows=1"]
        lines += ["Id_%d=%s" % (i + 1, d) for i, d in enumerate(self.desktop_ids)]
        lines += ["", "[Compositing]", "AnimationSpeed=0"]
        (cfg / "kwinrc").write_text("\n".join(lines) + "\n")
        # No animations: positions settle at once, so probes are deterministic.
        (cfg / "kdeglobals").write_text("[KDE]\nAnimationDurationFactor=0\n")
        if self.rules:
            self.write_rules(self.rules)

    def write_rules(self, rules):
        """Write kwinrulesrc as System Settings' rules page does: rules in groups named by UUID,
        listed in [General], values in KConfig's escaping (a backslash stored as \\\\)."""
        self.rules = rules
        ids = [str(uuid.uuid4()) for _ in rules]
        text = ["[General]", "count=%d" % len(ids), "rules=" + ",".join(ids), ""]
        for rid, rule in zip(ids, rules):
            text += ["[%s]" % rid] + ["%s=%s" % (k, v.replace("\\", "\\\\")) for k, v in rule.items()] + [""]
        (self.root / "config" / "kwinrulesrc").write_text("\n".join(text))

    def change_rules(self, rules):
        """Change the rules while KWin runs, and tell KWin, as System Settings does."""
        self.write_rules(rules)
        self.qdbus("org.kde.KWin", "/KWin", "org.kde.KWin.reconfigure")
        self.settle(0.5)

    def start(self):
        for d in ("home", "config", "data", "cache", "state", "run"):
            (self.root / d).mkdir(parents=True, exist_ok=True)
        os.chmod(self.root / "run", 0o700)
        self._write_config()
        env = self._env()
        self.outputctl, self.testwindow = _build(self.root / "build")

        stage = self.root / "stage"
        shutil.copytree(REPO / "src", stage)
        subprocess.run(["kpackagetool6", "--type", "KWin/Script", "--install", str(stage)],
                       env=env, check=True, capture_output=True)

        self.bus = subprocess.Popen(["dbus-daemon", "--session", "--nofork", "--nopidfile",
                                     "--address=unix:path=" + str(self.root / "bus")],
                                    env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.wait(lambda: (self.root / "bus").exists(), 5, "dbus-daemon")
        self._start_kwin()

    def _start_kwin(self):
        log = open(self.log_path, "ab")
        self.kwin = subprocess.Popen(
            ["kwin_wayland", "--virtual", "--no-lockscreen",
             "--output-count", str(self.outputs),
             "--width", str(self.width), "--height", str(self.height),
             "--socket", "wayland-wgr"],
            env=self._env(), stdout=log, stderr=subprocess.STDOUT)
        self.wait(lambda: self._dbus_ok(), 20, "kwin_wayland on D-Bus")
        self.wait(lambda: self.probe("return workspace.screens.length")["result"] == self.outputs,
                  10, "outputs")
        self.wait(lambda: any(LOG_PREFIX + "loaded" in line for line in self.log_text().splitlines()[-200:]),
                  10, "the script to load")
        self.pointer = Pointer(self.root / "run" / "wayland-wgr", self.root / "proto")
        self.settle(0.3)

    def restart_kwin(self, store=None):
        """Log out and back in: KWin quits (the script saves the windows still
        open, and the apps go with it), then starts again in the same HOME.
        `store` replaces the script's saved data in between."""
        self.pointer.close()
        self.pointer = None
        self.kwin.terminate()
        self.kwin.wait(10)
        for p in self.clients:
            if p.poll() is None:
                p.kill()
        self.clients = []
        if store is not None:
            path = self.root / "config" / "kde.org" / "kwin.conf"
            escaped = store.replace("\\", "\\\\").replace('"', '\\"')
            path.write_text("[General]\n" + STORE_KEY + '="' + escaped + '"\n')
        self.settle(0.3)
        self._start_kwin()

    def stop(self):
        if self.pointer:
            self.pointer.close()
        for p in self.clients + [self.kwin, self.bus]:
            if p and p.poll() is None:
                p.terminate()
                try:
                    p.wait(3)
                except subprocess.TimeoutExpired:
                    p.kill()
        if not self.keep:
            shutil.rmtree(self.root, ignore_errors=True)

    def wait(self, cond, timeout, what):
        end = time.time() + timeout
        while time.time() < end:
            try:
                if cond():
                    return
            except SandboxError:
                pass
            for p in (self.bus, self.kwin):
                if p is not None and p.poll() is not None:
                    raise SandboxError(what + ": a sandbox process died; see " + str(self.log_path))
            time.sleep(0.1)
        raise SandboxError("timed out waiting for " + what + "; see " + str(self.log_path))

    def settle(self, seconds=0.15):
        time.sleep(seconds)

    # ---- D-Bus / probes ---------------------------------------------------

    def qdbus(self, *args, check=True):
        r = subprocess.run([QDBUS, *args], env=self._env(), capture_output=True, text=True, timeout=10)
        if check and r.returncode != 0:
            raise SandboxError("qdbus %s: %s" % (" ".join(args), r.stderr.strip()))
        return r.stdout.strip()

    def _dbus_ok(self):
        return "/Scripting" in self.qdbus("org.kde.KWin", check=False)

    def log_text(self):
        return self.log_path.read_text(errors="replace")

    def script_errors(self):
        """Failures the script logged, and QML errors KWin reported from its files."""
        return [line for line in self.log_text().splitlines()
                if (LOG_PREFIX in line and ("failed" in line or "unreadable" in line))
                or re.search(r"windowgeometryrestore[^ ]*/(main\.qml|engine\.js):\d+", line)]

    def script_log(self):
        """The script's log lines written since the previous call."""
        text = self.log_text()
        new = text[self._log_offset:]
        self._log_offset = len(text)
        return [line.split(LOG_PREFIX, 1)[1] for line in new.splitlines() if LOG_PREFIX in line]

    def probe(self, body, timeout=5):
        """Run JS `body` inside KWin (a function body; `return` a JSON-able
        value) and return {"result": value}. Helpers g(rect) and win(caption)
        are in scope."""
        token = uuid.uuid4().hex
        name = "wgr-probe-" + token[:8]
        path = self.root / (name + ".js")
        path.write_text(
            "function g(r){return r?{x:r.x,y:r.y,w:r.width,h:r.height}:null}\n"
            "function win(c){var o=workspace.stackingOrder;for(var i=0;i<o.length;i++)"
            "{if(o[i].caption===c)return o[i]}return null}\n"
            "var __r;try{__r={result:(function(){" + body + "})()}}"
            "catch(e){__r={error:String(e)}}\n"
            "print('WGRPROBE " + token + " '+JSON.stringify(__r));\n")
        sid = self.qdbus("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.loadScript",
                         str(path), name)
        try:
            self.qdbus("org.kde.KWin", "/Scripting/Script" + sid, "org.kde.kwin.Script.run")
            marker = "WGRPROBE " + token + " "
            end = time.time() + timeout
            while time.time() < end:
                for line in self.log_text().splitlines():
                    i = line.find(marker)
                    if i >= 0:
                        out = json.loads(line[i + len(marker):])
                        if "error" in out:
                            raise SandboxError("probe error: " + out["error"])
                        return out
                time.sleep(0.03)
            raise SandboxError("probe produced no output")
        finally:
            self.qdbus("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript",
                       name, check=False)

    def screens(self):
        return self.probe("return workspace.screens.map(function (o) { return {name: o.name, geo: g(o.geometry)} })")["result"]

    def window(self, title):
        """KWin's view of one window, or None."""
        return self.probe("""
            var x = win(%s);
            if (!x) return null;
            var t = x.tile;
            return {title: x.caption, cls: x.resourceClass, geo: g(x.frameGeometry),
                    output: x.output ? x.output.name : null, active: workspace.activeWindow === x,
                    maximized: x.maximizeMode !== undefined ? x.maximizeMode : null,
                    tile: t ? {abs: g(t.absoluteGeometry), rel: g(t.relativeGeometry),
                               quick: t.layoutDirection === undefined} : null,
                    desktops: x.onAllDesktops ? ['*'] : x.desktops.map(function (d) { return d.x11DesktopNumber; })};
        """ % json.dumps(title))["result"]

    def layout(self, **changes):
        """Reconfigure monitors, e.g. layout(**{"Virtual-1": {"enabled": False}})
        or {"pos": (0, 1080)}; verified against KWin's view."""
        args = []
        for name, ch in changes.items():
            spec = name
            if "enabled" in ch:
                spec += ":enabled=%d" % (1 if ch["enabled"] else 0)
            if "pos" in ch:
                spec += ":x=%d:y=%d" % tuple(ch["pos"])
            args.append(spec)
        r = subprocess.run([str(self.outputctl), *args], env=self._env(),
                           capture_output=True, text=True, timeout=10)
        if r.returncode != 0:
            raise SandboxError("outputctl %s: %s" % (" ".join(args), r.stderr.strip()))

        def applied():
            screens = {s["name"]: s for s in self.screens()}
            for name, ch in changes.items():
                if ch.get("enabled") is False:
                    if name in screens:
                        return False
                    continue
                s = screens.get(name)
                if s is None:
                    return False
                if "pos" in ch and (s["geo"]["x"], s["geo"]["y"]) != tuple(ch["pos"]):
                    return False
            return True
        self.wait(applied, 5, "layout %s" % changes)
        self.settle(0.5)

    # ---- apps -------------------------------------------------------------

    def open_app(self, app_id, title, size=(800, 500), fixed=False, maximized=False, settle=0.8):
        """Start an app; KWin places its window, and the script may restore it."""
        args = [str(self.testwindow), app_id, title, "%dx%d" % size] + (["fixed"] if fixed else []) + (["maximized"] if maximized else [])
        p = subprocess.Popen(args, env=self._env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.clients.append(p)
        self.wait(lambda: self.window(title) is not None, 10, "window " + title)
        self.settle(settle)
        return App(self, title, p)

    def set_geometry(self, title, x, y, w, h):
        """Put a window somewhere, as the user would by moving and resizing it."""
        self.probe("win(%s).frameGeometry = {x:%d,y:%d,width:%d,height:%d}; return 1"
                   % (json.dumps(title), x, y, w, h))
        self.settle(0.3)

    def activate(self, title):
        self.probe("workspace.activeWindow = win(%s); return 1" % json.dumps(title))
        self.settle(0.2)

    def drag(self, start, end, steps=15, step_ms=16):
        """Press at `start`, glide to `end`, release."""
        p = self.pointer
        p.move(*start)
        time.sleep(0.05)
        p.button(True)
        time.sleep(0.05)
        for i in range(1, steps + 1):
            p.move(start[0] + (end[0] - start[0]) * i / steps, start[1] + (end[1] - start[1]) * i / steps)
            time.sleep(step_ms / 1000)
        time.sleep(0.2)
        p.button(False)
        time.sleep(0.5)

    # ---- the script's saved data ------------------------------------------

    def saved(self):
        """The script's saved data, decoded (None before the first save)."""
        path = self.root / "config" / "kde.org" / "kwin.conf"
        if not path.exists():
            return None
        for line in path.read_text().splitlines():
            if line.startswith(STORE_KEY + "="):
                value = line.split("=", 1)[1]
                if value.startswith('"') and value.endswith('"'):
                    value = value[1:-1]
                value = value.replace('\\"', '"').replace("\\\\", "\\")
                return json.loads(value)
        return None
