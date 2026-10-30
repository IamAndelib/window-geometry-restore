"""Scenarios for window-geometry-restore, run against a real KWin.

Each scenario builds its own sandbox (tests/kwin/sandbox.py), opens and
closes real windows and checks what KWin actually did. Scenarios assert their
own preconditions (e.g. that KWin first placed a window somewhere else), so
they can't pass vacuously. Several check that the script leaves KWin's own
mechanisms alone: window rules, quick tiling, a monitor coming back.

Usage (inside the dev container):
    python3 -I tests/kwin/scenarios.py [-k substring] [--keep]
"""

import argparse
import json
import sys
import time
import traceback
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sandbox import Sandbox  # noqa: E402

KEEP = False


class Fail(AssertionError):
    pass


def check(cond, msg):
    if not cond:
        raise Fail(msg)


def rect(w):
    g = w["geo"]
    return (g["x"], g["y"], g["w"], g["h"])


def near(a, b, tol=2):
    return a is not None and b is not None and all(abs(p - q) <= tol for p, q in zip(a, b))


@contextmanager
def sandbox(**kw):
    """A sandbox for one scenario. The scenario also fails if the script logged a failure."""
    with Sandbox(keep=KEEP, **kw) as sb:
        yield sb
        errors = sb.script_errors()
        check(not errors, "the script logged errors: %s" % errors[:5])


def titlebar(w):
    x, y, width, _ = rect(w)
    return (x + width / 2, y + 12)


def logged(lines, text):
    return any(text in line for line in lines)


def move_to(sb, title, x, y):
    """Move a window, keeping the size KWin gave it (apps reopen at their own last size)."""
    w = sb.window(title)
    sb.set_geometry(title, x, y, w["geo"]["w"], w["geo"]["h"])


def tile_left_at(sb, title, width):
    """Quick-tile a window left, as the user would (Meta+Left), and drag the split to `width`."""
    sb.activate(title)
    sb.probe("workspace.slotWindowQuickTileLeft(); return 1")
    sb.settle(0.5)
    check(sb.window(title)["tile"]["quick"], "precondition: quick-tiled")
    sb.probe("win(%r).tile.relativeGeometry = {x: 0, y: 0, width: %s, height: 1}; return 1" % (title, width))
    sb.settle(0.5)


# ---- basics ----------------------------------------------------------------------

def s_returns_to_its_monitor():
    """Closed on monitor 2, reopened with the pointer on monitor 1: KWin opens
    it on monitor 1, the script puts it back where it was."""
    with sandbox(outputs=2) as sb:
        a = sb.open_app("org.example.alpha", "Alpha")
        sb.set_geometry("Alpha", 2300, 150, 900, 600)
        check(sb.window("Alpha")["output"] == "Virtual-1", "precondition: on monitor 2")
        a.close()
        sb.script_log()
        sb.pointer.move(400, 400)
        sb.open_app("org.example.alpha", "Alpha")
        w = sb.window("Alpha")
        log = sb.script_log()
        check(logged(log, "restored window to saved state (moved)"), "precondition: KWin placed it elsewhere: %s" % log)
        check(rect(w) == (2300, 150, 900, 600), "restored geometry %s" % (rect(w),))
        check(w["output"] == "Virtual-1", "back on monitor 2, got %s" % w["output"])
        check(not (sb.root / "config" / "kwinrulesrc").exists(), "no KWin rules file created")


def s_logout_login():
    """Windows open at logout are saved by the script on exit and restored
    after the next login."""
    with sandbox(outputs=2) as sb:
        sb.open_app("org.example.alpha", "Alpha")
        sb.set_geometry("Alpha", 2100, 300, 1000, 650)
        sb.restart_kwin()
        saved = sb.saved()
        check(saved and "org.example.alpha" in saved["apps"], "saved at exit: %s" % saved)
        sb.pointer.move(400, 400)
        sb.open_app("org.example.alpha", "Alpha")
        check(rect(sb.window("Alpha")) == (2100, 300, 1000, 650), "restored after login: %s" % (rect(sb.window("Alpha")),))


def s_fixed_size_window():
    """A non-resizable window gets its position back and keeps its size."""
    with sandbox(outputs=1) as sb:
        a = sb.open_app("org.example.fixed", "Fixed", size=(600, 400), fixed=True)
        size = rect(sb.window("Fixed"))[2:]
        sb.set_geometry("Fixed", 100, 120, size[0], size[1])
        a.close()
        sb.open_app("org.example.fixed", "Fixed", size=(600, 400), fixed=True)
        w = sb.window("Fixed")
        check(rect(w)[:2] == (100, 120), "position restored: %s" % (rect(w),))
        check(rect(w)[2:] == size, "size kept: %s" % (rect(w),))


def s_maximized_at_close():
    """A window closed maximized reopens at its normal size: the script saves
    the floating geometry, and leaves maximizing to the app and KWin."""
    with sandbox(outputs=1) as sb:
        a = sb.open_app("org.example.alpha", "Alpha")
        sb.set_geometry("Alpha", 300, 200, 1000, 650)
        sb.probe("win('Alpha').setMaximize(true, true); return 1")
        sb.settle(0.5)
        check(sb.window("Alpha")["maximized"] == 3, "precondition: maximized")
        a.close()
        sb.open_app("org.example.alpha", "Alpha")
        w = sb.window("Alpha")
        check(w["maximized"] == 0, "not maximized by the script")
        check(rect(w) == (300, 200, 1000, 650), "normal geometry, not a fake-maximized frame: %s" % (rect(w),))


# ---- KWin's own mechanisms ---------------------------------------------------------

def rule(app_id, **fields):
    r = {"Description": "test rule", "wmclass": app_id, "wmclassmatch": "1"}
    r.update({k: str(v) for k, v in fields.items()})
    return r


def s_window_rule_apply_initially_wins():
    """A window rule that places the window initially is the user's explicit
    choice: the script must not override it."""
    with sandbox(outputs=1, rules=[rule("org.example.unrelated", size="300,300", sizerule=2),
                                   rule("org.example.ruled", position="100,100", positionrule=3)]) as sb:
        a = sb.open_app("org.example.ruled", "Ruled")
        check(rect(sb.window("Ruled"))[:2] == (100, 100), "precondition: the rule placed it: %s" % (rect(sb.window("Ruled")),))
        sb.set_geometry("Ruled", 900, 400, 700, 500)
        a.close()
        sb.open_app("org.example.ruled", "Ruled")
        w = sb.window("Ruled")
        check(rect(w)[:2] == (100, 100), "the rule's position kept, got %s" % (rect(w),))


def s_window_rule_force_no_fight():
    """A forced position rule: KWin refuses other positions. The script must
    end up not fighting it (the window stays at the forced position)."""
    with sandbox(outputs=1, rules=[rule("org.example.forced", position="150,150", positionrule=2)]) as sb:
        a = sb.open_app("org.example.forced", "Forced")
        check(rect(sb.window("Forced"))[:2] == (150, 150), "precondition: forced at 150,150")
        a.close()
        sb.open_app("org.example.forced", "Forced")
        sb.settle(1.5)
        check(rect(sb.window("Forced"))[:2] == (150, 150), "still at the forced position: %s" % (rect(sb.window("Forced")),))


def s_window_rule_remember_agrees():
    """A 'Remember' position rule is KWin restoring the window itself: both
    agree, and the script does not move the window."""
    with sandbox(outputs=1, rules=[rule("org.example.remembered", position="0,0", positionrule=4,
                                        size="800,536", sizerule=4)]) as sb:
        a = sb.open_app("org.example.remembered", "Remembered")
        sb.set_geometry("Remembered", 640, 300, 800, 536)
        a.close()
        sb.script_log()
        sb.open_app("org.example.remembered", "Remembered")
        w = sb.window("Remembered")
        log = sb.script_log()
        check(rect(w) == (640, 300, 800, 536), "KWin's remembered geometry: %s" % (rect(w),))
        check(not logged(log, "(moved)"), "the script did not move it: %s" % log)


def s_window_rule_title_condition():
    """A rule for one title (with a comma in it): that window is left to KWin, the app's other
    window restores."""
    with sandbox(outputs=1, rules=[rule("org.example.other", position="0,0", positionrule=2),
                                   rule("org.example.alpha", title="Pinned, notes", titlematch=1,
                                        position="100,100", positionrule=3)]) as sb:
        sb.open_app("org.example.alpha", "Pinned, notes")
        check(rect(sb.window("Pinned, notes"))[:2] == (100, 100), "precondition: the rule placed it")
        sb.open_app("org.example.alpha", "Work")
        move_to(sb, "Work", 900, 400)
        move_to(sb, "Pinned, notes", 500, 500)
        sb.restart_kwin()
        sb.open_app("org.example.alpha", "Pinned, notes")
        sb.open_app("org.example.alpha", "Work")
        check(rect(sb.window("Pinned, notes"))[:2] == (100, 100), "the rule's window: %s" % (rect(sb.window("Pinned, notes")),))
        check(rect(sb.window("Work"))[:2] == (900, 400), "the other window restored: %s" % (rect(sb.window("Work")),))


def s_window_rule_size_only():
    """A forced size rule: the window is left to KWin entirely."""
    with sandbox(outputs=1, rules=[rule("org.example.sized", size="700,450", sizerule=2)]) as sb:
        a = sb.open_app("org.example.sized", "Sized")
        move_to(sb, "Sized", 900, 400)
        a.close()
        sb.script_log()
        sb.open_app("org.example.sized", "Sized")
        log = sb.script_log()
        check(logged(log, "a KWin window rule places this window"), "left to KWin: %s" % log)
        check(not logged(log, "restored window"), "not restored: %s" % log)


def s_window_rule_regex_class():
    """A regular-expression rule as System Settings stores it (KConfig escaping)."""
    with sandbox(outputs=1, rules=[rule("^org\\.example\\.re", wmclassmatch=3, position="50,60", positionrule=2)]) as sb:
        a = sb.open_app("org.example.regex", "Regex")
        check(rect(sb.window("Regex"))[:2] == (50, 60), "precondition: KWin applied the rule")
        a.close()
        sb.open_app("org.example.regex", "Regex")
        check(logged(sb.script_log(), "leaving it to KWin"), "the script matched it too")


def s_window_rule_other_app_and_apply_now():
    """A rule for another app, and a one-time 'Apply now' rule, leave restores alone."""
    with sandbox(outputs=1, rules=[rule("org.example.other", position="0,0", positionrule=2),
                                   rule("org.example.alpha", position="0,0", positionrule=5)]) as sb:
        a = sb.open_app("org.example.alpha", "Alpha")
        move_to(sb, "Alpha", 900, 400)
        a.close()
        sb.open_app("org.example.alpha", "Alpha")
        check(rect(sb.window("Alpha"))[:2] == (900, 400), "restored: %s" % (rect(sb.window("Alpha")),))


def s_window_rule_changed_at_runtime():
    """Rules created or deleted while KWin runs apply to the next window, without a reload."""
    with sandbox(outputs=1) as sb:
        a = sb.open_app("org.example.alpha", "Alpha")
        move_to(sb, "Alpha", 900, 400)
        a.close()
        sb.change_rules([rule("org.example.alpha", position="100,100", positionrule=3)])
        a = sb.open_app("org.example.alpha", "Alpha")
        check(rect(sb.window("Alpha"))[:2] == (100, 100), "the new rule respected: %s" % (rect(sb.window("Alpha")),))
        move_to(sb, "Alpha", 700, 300)
        a.close()
        sb.change_rules([])
        sb.open_app("org.example.alpha", "Alpha")
        check(rect(sb.window("Alpha"))[:2] == (700, 300), "restores again once the rule is gone: %s" % (rect(sb.window("Alpha")),))


# ---- tiles -------------------------------------------------------------------------
# The quick tile that waits for a background window to get focus is covered by the unit
# tests only: KWin 6.7.5 activated the Qt test window even at FocusStealingPreventionLevel 4
# (it presents an activation token), so a background window can't be produced here.

def s_quick_tile_roundtrip():
    """Quick-tiled left and resized to 65%, closed (KWin resets the split),
    reopened: back in the left tile at 65%, and a drag out gives back the
    pre-tile size through KWin's own restore geometry."""
    with sandbox(outputs=1) as sb:
        a = sb.open_app("org.example.alpha", "Alpha")
        sb.set_geometry("Alpha", 300, 200, 1000, 650)
        sb.activate("Alpha")
        sb.probe("workspace.slotWindowQuickTileLeft(); return 1")
        sb.settle(0.5)
        check(sb.window("Alpha")["tile"]["quick"], "precondition: quick-tiled")
        sb.probe("win('Alpha').tile.relativeGeometry = {x: 0, y: 0, width: 0.65, height: 1}; return 1")
        sb.settle(0.5)
        check(near(rect(sb.window("Alpha"))[2:3], (1248,)), "precondition: resized tile %s" % (rect(sb.window("Alpha")),))
        a.close()
        sb.open_app("org.example.alpha", "Alpha")
        w = sb.window("Alpha")
        check(w["tile"] and w["tile"]["quick"], "back in a quick tile: %s" % w["tile"])
        check(abs(w["tile"]["rel"]["w"] - 0.65) < 0.01 and w["tile"]["rel"]["x"] == 0, "the left tile at 65%%: %s" % w["tile"])
        sb.drag(titlebar(w), (900, 500))
        w = sb.window("Alpha")
        check(w["tile"] is None, "dragged out of the tile")
        check(rect(w)[2:] == (1000, 650), "pre-tile size back: %s" % (rect(w),))


def s_custom_tile_roundtrip():
    """In the middle column of KWin's default Meta+T layout, closed and
    reopened: back in that tile; a drag out gives back the pre-tile size."""
    with sandbox(outputs=1) as sb:
        a = sb.open_app("org.example.alpha", "Alpha")
        sb.set_geometry("Alpha", 300, 200, 1000, 650)
        sb.probe("var w = win('Alpha'); workspace.rootTile(w.output, workspace.currentDesktop).tiles[1].manage(w); return 1")
        sb.settle(0.5)
        t = sb.window("Alpha")["tile"]
        check(t and not t["quick"] and t["rel"]["x"] == 0.25, "precondition: in the middle column: %s" % t)
        a.close()
        sb.open_app("org.example.alpha", "Alpha")
        w = sb.window("Alpha")
        check(w["tile"] and not w["tile"]["quick"] and w["tile"]["rel"]["x"] == 0.25, "back in the middle column: %s" % w["tile"])
        sb.drag(titlebar(w), (900, 500))
        # Custom tiles work in fractions: KWin's geometry can be off by a rounding error.
        check(near(rect(sb.window("Alpha"))[2:], (1000, 650), tol=1), "pre-tile size back: %s" % (rect(sb.window("Alpha")),))


def s_shared_quick_tile_keeps_its_size():
    """A window restored into a quick tile that already holds another window
    takes the tile's size; the window already there is not resized."""
    with sandbox(outputs=1) as sb:
        a = sb.open_app("org.example.wide", "Wide")
        sb.activate("Wide")
        sb.probe("workspace.slotWindowQuickTileLeft(); return 1")
        sb.settle(0.4)
        sb.probe("win('Wide').tile.relativeGeometry = {x: 0, y: 0, width: 0.6, height: 1}; return 1")
        sb.settle(0.4)
        a.close()
        sb.open_app("org.example.narrow", "Narrow")
        sb.activate("Narrow")
        sb.probe("workspace.slotWindowQuickTileLeft(); return 1")
        sb.settle(0.4)
        sb.probe("win('Narrow').tile.relativeGeometry = {x: 0, y: 0, width: 0.4, height: 1}; return 1")
        sb.settle(0.4)
        narrow = rect(sb.window("Narrow"))
        sb.open_app("org.example.wide", "Wide")
        w = sb.window("Wide")
        check(w["tile"] and w["tile"]["quick"], "joined the left tile: %s" % w["tile"])
        check(rect(sb.window("Narrow")) == narrow, "the window already there kept its size: %s" % (rect(sb.window("Narrow")),))
        check(abs(w["tile"]["rel"]["w"] - 0.4) < 0.01, "the tile kept its 40%%: %s" % w["tile"])


def s_quick_tile_on_monitor_2():
    """Quick-tiled left at 65% on monitor 2, reopened with the pointer on monitor 1: back in
    monitor 2's left tile at 65%."""
    with sandbox(outputs=2) as sb:
        a = sb.open_app("org.example.alpha", "Alpha")
        sb.set_geometry("Alpha", 2300, 200, 1000, 650)
        tile_left_at(sb, "Alpha", 0.65)
        check(sb.window("Alpha")["output"] == "Virtual-1", "precondition: on monitor 2")
        a.close()
        sb.pointer.move(400, 400)
        sb.open_app("org.example.alpha", "Alpha")
        sb.settle(1.0)
        w = sb.window("Alpha")
        check(w["output"] == "Virtual-1", "back on monitor 2: %s" % w)
        check(w["tile"] and w["tile"]["quick"] and abs(w["tile"]["rel"]["w"] - 0.65) < 0.01, "left tile at 65%%: %s" % w["tile"])


def s_tiled_sent_to_other_monitor():
    """Quick-tiled left on monitor 1, sent to monitor 2 with KWin's "Window to next screen":
    reopened, it is tiled left on monitor 2, and a drag out gives back its pre-tile size."""
    with sandbox(outputs=2) as sb:
        a = sb.open_app("org.example.alpha", "Alpha")
        sb.set_geometry("Alpha", 300, 200, 1000, 650)
        sb.activate("Alpha")
        sb.probe("workspace.slotWindowQuickTileLeft(); return 1")
        sb.settle(0.4)
        sb.probe("workspace.slotWindowToNextScreen(); return 1")
        sb.settle(0.6)
        w = sb.window("Alpha")
        check(w["output"] == "Virtual-1" and w["tile"] and w["tile"]["rel"]["x"] == 0, "precondition: KWin re-tiled it on monitor 2: %s" % w)
        a.close()
        sb.pointer.move(400, 400)
        sb.open_app("org.example.alpha", "Alpha")
        sb.settle(0.5)
        w = sb.window("Alpha")
        check(w["output"] == "Virtual-1" and w["tile"] and w["tile"]["rel"]["x"] == 0, "tiled left on monitor 2: %s on %s" % (w["tile"], w["output"]))
        sb.drag(titlebar(w), (2600, 500))
        check(near(rect(sb.window("Alpha"))[2:], (1000, 650), tol=1), "pre-tile size back: %s" % (rect(sb.window("Alpha")),))


def s_quick_tiled_window_on_unplugged_monitor():
    """Quick-tiled left at 65% on monitor 2; monitor 2 unplugged (KWin moves it into monitor
    1's left tile); closed there; monitor 2 back; reopened: in monitor 2's left tile at 65%."""
    with sandbox(outputs=2) as sb:
        sb.open_app("org.example.kept", "Kept")
        sb.set_geometry("Kept", 2500, 600, 600, 400)
        a = sb.open_app("org.example.alpha", "Alpha")
        sb.set_geometry("Alpha", 2300, 200, 1000, 650)
        tile_left_at(sb, "Alpha", 0.65)
        sb.layout(**{"Virtual-1": {"enabled": False}})
        check(sb.window("Alpha")["output"] == "Virtual-0", "precondition: KWin moved it to monitor 1")
        a.close()
        sb.layout(**{"Virtual-1": {"enabled": True}})
        sb.pointer.move(400, 400)
        sb.open_app("org.example.alpha", "Alpha")
        sb.settle(1.0)
        w = sb.window("Alpha")
        check(w["output"] == "Virtual-1", "back on monitor 2: %s" % w)
        check(w["tile"] and w["tile"]["quick"] and abs(w["tile"]["rel"]["w"] - 0.65) < 0.01, "left tile at 65%%: %s" % w["tile"])


def s_tiled_then_maximized():
    """Tiled, then maximized (KWin untiles it), then closed: it reopens untiled at its normal
    size; maximizing again is up to the app."""
    with sandbox(outputs=1) as sb:
        a = sb.open_app("org.example.alpha", "Alpha")
        sb.set_geometry("Alpha", 300, 200, 1000, 650)
        sb.activate("Alpha")
        sb.probe("workspace.slotWindowQuickTileLeft(); return 1")
        sb.settle(0.4)
        sb.probe("win('Alpha').setMaximize(true, true); return 1")
        sb.settle(0.5)
        w = sb.window("Alpha")
        check(w["maximized"] == 3 and w["tile"] is None, "precondition: KWin untiled it to maximize it: %s" % w)
        a.close()
        sb.open_app("org.example.alpha", "Alpha")
        sb.settle(0.5)
        w = sb.window("Alpha")
        check(w["tile"] is None and w["maximized"] == 0, "untiled, not maximized: %s" % w)
        check(rect(w) == (300, 200, 1000, 650), "normal geometry: %s" % (rect(w),))


def s_logout_with_tiles():
    """Logout with one window quick-tiled at 65% and one in a custom tile: both come back tiled."""
    with sandbox(outputs=1) as sb:
        sb.open_app("org.example.alpha", "Alpha")
        sb.set_geometry("Alpha", 300, 200, 1000, 650)
        tile_left_at(sb, "Alpha", 0.65)
        sb.open_app("org.example.beta", "Beta")
        sb.set_geometry("Beta", 400, 300, 900, 600)
        sb.probe("var w = win('Beta'); workspace.rootTile(w.output, workspace.currentDesktop).tiles[2].manage(w); return 1")
        sb.settle(0.5)
        check(sb.window("Beta")["tile"] and not sb.window("Beta")["tile"]["quick"], "precondition: Beta custom-tiled")
        sb.restart_kwin()
        saved = sb.saved()["apps"]
        a, b = saved["org.example.alpha"]["w"][0], saved["org.example.beta"]["w"][0]
        check(a.get("t", {}).get("k") == "q" and abs(a["t"]["g"]["w"] - 0.65) < 0.01, "Alpha's tile saved at exit: %s" % a)
        check(b.get("t", {}).get("k") == "c", "Beta's custom tile saved at exit: %s" % b)
        sb.open_app("org.example.alpha", "Alpha")
        sb.open_app("org.example.beta", "Beta")
        sb.settle(1.0)
        wa, wb = sb.window("Alpha"), sb.window("Beta")
        check(wa["tile"] and wa["tile"]["quick"] and abs(wa["tile"]["rel"]["w"] - 0.65) < 0.01, "Alpha tiled: %s" % wa["tile"])
        check(wb["tile"] and not wb["tile"]["quick"], "Beta tiled: %s" % wb["tile"])


DESK1 = "11111111-1111-1111-1111-111111111111"
DESK2 = "22222222-2222-2222-2222-222222222222"


def s_tile_on_desktop_not_shown():
    """A desktop rule opens the app on desktop 2 while desktop 1 is shown: the window goes back
    into its custom tile there."""
    rules = [rule("org.example.alpha", desktops=DESK2, desktopsrule=3)]
    with sandbox(outputs=1, desktops=2, desktop_ids=[DESK1, DESK2], rules=rules) as sb:
        sb.probe("workspace.currentDesktop = workspace.desktops[1]; return 1")
        a = sb.open_app("org.example.alpha", "Alpha")
        sb.set_geometry("Alpha", 300, 200, 1000, 650)
        sb.probe("var w = win('Alpha'); workspace.rootTile(w.output, workspace.desktops[1]).tiles[1].manage(w); return 1")
        sb.settle(0.5)
        check(sb.window("Alpha")["tile"], "precondition: tiled")
        a.close()
        sb.probe("workspace.currentDesktop = workspace.desktops[0]; return 1")
        sb.open_app("org.example.alpha", "Alpha")
        check(sb.window("Alpha")["desktops"] == [2], "precondition: the rule put it on desktop 2")
        sb.probe("workspace.currentDesktop = workspace.desktops[1]; return 1")
        sb.settle(0.5)
        w = sb.window("Alpha")
        check(w["tile"] and not w["tile"]["quick"] and w["tile"]["rel"]["x"] == 0.25, "in its tile once desktop 2 is shown: %s" % w["tile"])


# ---- desktops ----------------------------------------------------------------------

def s_desktops_are_independent():
    """An app open on desktop 1 does not stop its restore on desktop 2."""
    with sandbox(outputs=1, desktops=2) as sb:
        sb.probe("workspace.currentDesktop = workspace.desktops[1]; return 1")
        a = sb.open_app("org.example.alpha", "Alpha")
        sb.set_geometry("Alpha", 1000, 300, 800, 550)
        a.close()
        sb.probe("workspace.currentDesktop = workspace.desktops[0]; return 1")
        sb.open_app("org.example.alpha", "Alpha elsewhere")
        sb.probe("workspace.currentDesktop = workspace.desktops[1]; return 1")
        sb.open_app("org.example.alpha", "Alpha")
        w = sb.window("Alpha")
        check(w["desktops"] == [2], "precondition: on desktop 2")
        check(rect(w) == (1000, 300, 800, 550), "desktop 2's layout: %s" % (rect(w),))


# ---- monitors ----------------------------------------------------------------------

def s_late_monitor():
    """Closed on monitor 2; reopened while monitor 2 is off (it lands on
    monitor 1); monitor 2 comes back within the restore window: the window
    moves to it, once, and stays."""
    with sandbox(outputs=2) as sb:
        a = sb.open_app("org.example.alpha", "Alpha")
        sb.set_geometry("Alpha", 2300, 150, 900, 600)
        a.close()
        sb.layout(**{"Virtual-1": {"enabled": False}})
        sb.pointer.move(400, 400)
        sb.open_app("org.example.alpha", "Alpha")
        check(sb.window("Alpha")["output"] == "Virtual-0", "precondition: on monitor 1 while 2 is off")
        sb.layout(**{"Virtual-1": {"enabled": True}})
        sb.settle(1.0)
        first = rect(sb.window("Alpha"))
        sb.settle(1.5)
        check(first == rect(sb.window("Alpha")), "settled, no back and forth")
        check(first == (2300, 150, 900, 600), "moved to monitor 2: %s" % (first,))


def s_unplugged_monitor_then_close():
    """A window on monitor 2 when monitor 2 is unplugged: KWin moves it to
    monitor 1 for the time being. Closed there and reopened after monitor 2
    is back, it should return to monitor 2, as KWin itself does for windows
    that stay open (it moves them back on replug)."""
    with sandbox(outputs=2) as sb:
        sb.open_app("org.example.kept", "Kept")
        sb.set_geometry("Kept", 2500, 200, 700, 500)
        a = sb.open_app("org.example.alpha", "Alpha")
        sb.set_geometry("Alpha", 2300, 150, 900, 600)
        sb.layout(**{"Virtual-1": {"enabled": False}})
        check(sb.window("Alpha")["output"] == "Virtual-0", "precondition: KWin moved it to monitor 1")
        a.close()
        sb.layout(**{"Virtual-1": {"enabled": True}})
        check(sb.window("Kept")["output"] == "Virtual-1", "precondition: KWin moved the open window back")
        sb.pointer.move(400, 400)
        sb.open_app("org.example.alpha", "Alpha")
        w = sb.window("Alpha")
        check(w["output"] == "Virtual-1" and rect(w) == (2300, 150, 900, 600),
              "back on monitor 2 like the window that stayed open: %s on %s" % (rect(w), w["output"]))






def s_monitors_independent_while_running():
    """The app is open on monitor 1. Its window closed on monitor 2 comes back on monitor 2
    when reopened there, although the app is running."""
    with sandbox(outputs=2) as sb:
        sb.open_app("org.example.alpha", "Left")
        move_to(sb, "Left", 200, 150)
        right = sb.open_app("org.example.alpha", "Right")
        move_to(sb, "Right", 2400, 300)
        right.close()
        log = sb.script_log()
        check(logged(log, "closed on Virtual-1, saved 1 window(s)"), "monitor 2's layout saved while open on monitor 1: %s" % log)
        sb.pointer.move(2900, 600)
        sb.open_app("org.example.alpha", "Right")
        w = sb.window("Right")
        log = sb.script_log()
        check(logged(log, "for Virtual-1, where it has no window yet"), "restored from monitor 2's layout: %s" % log)
        check(w["output"] == "Virtual-1" and rect(w)[:2] == (2400, 300), "back at its spot on monitor 2: %s" % (rect(w),))
        check(rect(sb.window("Left"))[:2] == (200, 150), "the window on monitor 1 untouched")


def s_new_window_beside_open_one_left_alone():
    """A second window opened next to the app's open window on the same monitor stays where
    KWin put it."""
    with sandbox(outputs=2) as sb:
        sb.open_app("org.example.alpha", "One")
        two = sb.open_app("org.example.alpha", "Two")
        move_to(sb, "Two", 1000, 400)
        two.close()
        sb.pointer.move(400, 400)
        sb.open_app("org.example.alpha", "Two")
        w = sb.window("Two")
        check(w["output"] == "Virtual-0", "precondition: opened on monitor 1")
        check(rect(w)[:2] != (1000, 400), "left where KWin put it: %s" % (rect(w),))


def s_fresh_start_both_monitors():
    """Windows closed on two monitors at different times all come back, each on its own
    monitor, when the app starts again."""
    with sandbox(outputs=2) as sb:
        left = sb.open_app("org.example.alpha", "Left", size=(700, 450))
        move_to(sb, "Left", 200, 150)
        right = sb.open_app("org.example.alpha", "Right", size=(900, 600))
        move_to(sb, "Right", 2400, 300)
        right.close()
        sb.settle(2.0)
        left.close()
        sb.pointer.move(400, 400)
        sb.open_app("org.example.alpha", "Left", size=(700, 450))
        sb.open_app("org.example.alpha", "Right", size=(900, 600))
        l, r = sb.window("Left"), sb.window("Right")
        check(l["output"] == "Virtual-0" and rect(l)[:2] == (200, 150), "Left back on monitor 1: %s %s" % (rect(l), l["output"]))
        check(r["output"] == "Virtual-1" and rect(r)[:2] == (2400, 300), "Right back on monitor 2: %s %s" % (rect(r), r["output"]))

def s_undock_two_of_three_monitors():
    """Three monitors, the app open on each; monitors 2 and 3 go at once (undocking), the
    parked windows close at different times; docked again, each window returns to its monitor."""
    with sandbox(outputs=3) as sb:
        apps = []
        for title, x in (("A", 200), ("B", 2200), ("C", 4100)):
            apps.append(sb.open_app("org.example.alpha", title, size=(800, 500)))
            move_to(sb, title, x, 200)
        sb.layout(**{"Virtual-1": {"enabled": False}, "Virtual-2": {"enabled": False}})
        check(sb.window("B")["output"] == "Virtual-0" and sb.window("C")["output"] == "Virtual-0", "precondition: parked")
        apps[2].close()
        sb.settle(2.0)
        apps[1].close()
        apps[0].close()
        sb.layout(**{"Virtual-1": {"enabled": True}, "Virtual-2": {"enabled": True}})
        sb.pointer.move(400, 400)
        for title in ("A", "B", "C"):
            sb.open_app("org.example.alpha", title, size=(800, 500))
        got = {t: (sb.window(t)["output"], rect(sb.window(t))[:2]) for t in ("A", "B", "C")}
        check(got == {"A": ("Virtual-0", (200, 200)), "B": ("Virtual-1", (2200, 200)), "C": ("Virtual-2", (4100, 200))}, "got %s" % got)


# ---- pressure ----------------------------------------------------------------------

def s_many_windows_logout():
    """Eight windows of one app over two monitors survive a logout, each back in its slot."""
    with sandbox(outputs=2) as sb:
        spots = {}
        for i in range(8):
            title = "Win %d" % i
            sb.open_app("org.example.many", title, size=(500 + 20 * i, 350 + 10 * i), settle=0.3)
            spots[title] = (100 + 220 * (i % 4) + (1920 if i >= 4 else 0), 60 + 70 * i)
            move_to(sb, title, *spots[title])
        sb.restart_kwin()
        sb.pointer.move(400, 400)
        for i in range(8):
            sb.open_app("org.example.many", "Win %d" % i, size=(500 + 20 * i, 350 + 10 * i), settle=0.3)
        sb.settle(1.0)
        for title, spot in spots.items():
            check(rect(sb.window(title))[:2] == spot, "%s at %s, got %s" % (title, spot, rect(sb.window(title))))


def s_logout_two_monitors_two_desktops():
    """Logout with an app open on both monitors of desktop 1 and on monitor 2 of desktop 2:
    after login every window returns to its own desktop's layout and monitor."""
    with sandbox(outputs=2, desktops=2) as sb:
        sb.open_app("org.example.alpha", "Left", size=(700, 450))
        move_to(sb, "Left", 200, 150)
        sb.open_app("org.example.alpha", "Right", size=(900, 600))
        move_to(sb, "Right", 2400, 300)
        sb.probe("workspace.currentDesktop = workspace.desktops[1]; return 1")
        sb.open_app("org.example.alpha", "Two", size=(800, 500))
        move_to(sb, "Two", 2600, 500)
        sb.restart_kwin()
        d = sb.saved()["apps"]["org.example.alpha"]["d"]
        check(len(d) == 2 and sorted(len(v["w"]) for v in d.values()) == [1, 2], "two desktops saved: %s" % d)
        sb.probe("workspace.currentDesktop = workspace.desktops[0]; return 1")
        sb.pointer.move(400, 400)
        sb.open_app("org.example.alpha", "Left", size=(700, 450))
        sb.open_app("org.example.alpha", "Right", size=(900, 600))
        l, r = sb.window("Left"), sb.window("Right")
        check(rect(l)[:2] == (200, 150) and l["output"] == "Virtual-0", "Left: %s" % l)
        check(rect(r)[:2] == (2400, 300) and r["output"] == "Virtual-1", "Right: %s" % r)
        sb.probe("workspace.currentDesktop = workspace.desktops[1]; return 1")
        sb.open_app("org.example.alpha", "Two", size=(800, 500))
        t = sb.window("Two")
        check(rect(t)[:2] == (2600, 500) and t["desktops"] == [2], "Two: %s" % t)


def s_rapid_open_close():
    """Twenty quick open/move/close cycles: the last place wins, nothing breaks."""
    with sandbox(outputs=2) as sb:
        for i in range(20):
            a = sb.open_app("org.example.rapid", "Rapid", settle=0.15)
            move_to(sb, "Rapid", 100 + 37 * i, 80 + 23 * i)
            a.close()
        sb.open_app("org.example.rapid", "Rapid")
        check(rect(sb.window("Rapid"))[:2] == (100 + 37 * 19, 80 + 23 * 19), "the last place: %s" % (rect(sb.window("Rapid")),))


def s_two_apps_interleaved():
    with sandbox(outputs=2) as sb:
        for app, spot in (("org.example.one", (300, 200)), ("org.example.two", (2300, 300))):
            a = sb.open_app(app, app)
            move_to(sb, app, *spot)
            a.close()
        sb.pointer.move(400, 400)
        sb.open_app("org.example.two", "org.example.two", settle=0.1)
        sb.open_app("org.example.one", "org.example.one", settle=0.1)
        sb.settle(1.0)
        check(rect(sb.window("org.example.one"))[:2] == (300, 200), "app one")
        check(rect(sb.window("org.example.two"))[:2] == (2300, 300), "app two")


def s_desktops_times_monitors():
    """One app with its own layout on each desktop and monitor: each combination comes back."""
    with sandbox(outputs=2, desktops=2) as sb:
        spots = {(0, 0): (200, 150), (0, 1): (2300, 250), (1, 0): (600, 350), (1, 1): (2700, 450)}
        for (desk, mon), spot in spots.items():
            sb.probe("workspace.currentDesktop = workspace.desktops[%d]; return 1" % desk)
            title = "D%d M%d" % (desk, mon)
            a = sb.open_app("org.example.grid", title)
            move_to(sb, title, *spot)
            a.close()
        for (desk, mon), spot in spots.items():
            sb.probe("workspace.currentDesktop = workspace.desktops[%d]; return 1" % desk)
            sb.pointer.move(400 + 1920 * mon, 400)
            title = "D%d M%d" % (desk, mon)
            a = sb.open_app("org.example.grid", title)
            w = sb.window(title)
            check(rect(w)[:2] == spot and w["desktops"] == [desk + 1], "%s: %s on %s" % (title, rect(w), w["desktops"]))
            a.close()


def s_big_saved_data():
    """500 apps on 3 desktops in the saved data: loading works, a save stays fast and keeps
    the store at its 500-app cap."""
    with sandbox(outputs=1, desktops=3) as sb:
        ids = sb.probe("return workspace.desktops.map(function (d) { return d.id })")["result"]
        now = int(time.time() * 1000)
        save = {"c": "Some window title - Application", "x": 100, "y": 100, "w": 800, "h": 600,
                "o": {"x": 100, "y": 100, "s": "", "n": "Virtual-0"}}
        apps = {"org.example.app%03d" % i: {"t": now - i, "w": [save, save], "d": {d: {"t": now - i, "w": [save, save]} for d in ids}}
                for i in range(500)}
        sb.restart_kwin(store=json.dumps({"version": 2, "apps": apps}))
        check(logged(sb.script_log(), "for 500 app(s)"), "loaded the big store")
        start = time.time()
        a = sb.open_app("org.example.alpha", "Alpha")
        move_to(sb, "Alpha", 400, 300)
        a.close()
        took = time.time() - start
        saved = sb.saved()
        check(len(saved["apps"]) == 500 and "org.example.alpha" in saved["apps"], "the newest app kept, the cap held")
        check(took < 5, "open, move and close took %.1fs" % took)


SCENARIOS = [
    s_returns_to_its_monitor,
    s_logout_login,
    s_fixed_size_window,
    s_maximized_at_close,
    s_window_rule_apply_initially_wins,
    s_window_rule_force_no_fight,
    s_window_rule_remember_agrees,
    s_window_rule_title_condition,
    s_window_rule_size_only,
    s_window_rule_regex_class,
    s_window_rule_other_app_and_apply_now,
    s_window_rule_changed_at_runtime,
    s_quick_tile_roundtrip,
    s_custom_tile_roundtrip,
    s_shared_quick_tile_keeps_its_size,
    s_quick_tile_on_monitor_2,
    s_tiled_sent_to_other_monitor,
    s_quick_tiled_window_on_unplugged_monitor,
    s_tiled_then_maximized,
    s_logout_with_tiles,
    s_tile_on_desktop_not_shown,
    s_desktops_are_independent,
    s_late_monitor,
    s_unplugged_monitor_then_close,
    s_monitors_independent_while_running,
    s_new_window_beside_open_one_left_alone,
    s_fresh_start_both_monitors,
    s_undock_two_of_three_monitors,
    s_many_windows_logout,
    s_logout_two_monitors_two_desktops,
    s_rapid_open_close,
    s_two_apps_interleaved,
    s_desktops_times_monitors,
    s_big_saved_data,
]


def main():
    global KEEP
    parser = argparse.ArgumentParser()
    parser.add_argument("-k", help="run only scenarios whose name contains this")
    parser.add_argument("--keep", action="store_true", help="keep sandbox folders (KWin logs)")
    args = parser.parse_args()
    KEEP = args.keep
    failed = []
    for s in SCENARIOS:
        if args.k and args.k not in s.__name__:
            continue
        try:
            s()
            print("PASS", s.__name__, flush=True)
        except Fail as e:
            failed.append(s.__name__)
            print("FAIL", s.__name__, "-", e, flush=True)
        except Exception:
            failed.append(s.__name__)
            print("ERROR", s.__name__, flush=True)
            traceback.print_exc()
    print("%d failed" % len(failed) if failed else "all passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
