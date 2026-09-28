import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

// Integration harness: extracts the real functions from main.qml and drives them
// against a fake KWin Workspace, so the save -> persist -> relaunch -> restore
// lifecycle is verified without a running Plasma session.

const qml = readFileSync(new URL('../src/contents/ui/main.qml', import.meta.url), 'utf8')

const engineSource = readFileSync(new URL('../src/contents/ui/engine.js', import.meta.url), 'utf8')
    .replace(/^\s*\.pragma library.*$/m, '')
const Engine = new Function(`${engineSource}\nreturn { newState, parseList, isListed, captionScore, isBetterMatch, bestMatch, makeSave, decodeState, encodeState, pruneExpired, mergeDiskApps, BURST_MS, RESTORE_TIMEOUT_MS, RETRY_MAX_AGE_MS, MAX_GEOMETRY_TRIES, MAX_BUFFER, EXPIRY_MS, TICK_MS };`)()

function extractFunctions(source) {
    const functions = {}
    const re = /^    function (\w+)\(([^)]*)\) \{/gm
    let match
    while ((match = re.exec(source)) !== null) {
        const start = match.index + match[0].length - 1
        let depth = 0
        let end = -1
        for (let i = start; i < source.length; i++) {
            if (source[i] === '{') depth++
            else if (source[i] === '}') {
                depth--
                if (depth === 0) {
                    end = i
                    break
                }
            }
        }
        assert.ok(end > 0, `unbalanced function ${match[1]}`)
        functions[match[1]] = { params: match[2], body: source.slice(start, end + 1) }
    }
    return functions
}

const extracted = extractFunctions(qml)

const REQUIRED_FUNCTIONS = [
    'log', 'dbg', 'removeFromArray', 'connectSignal', 'disconnectSignal', 'isValidWindow',
    'loadConfig', 'loadPersisted', 'persist', 'trackWindow', 'untrack', 'snapshotWindow',
    'releaseWindow', 'finalizeApp', 'startSession', 'joinSession', 'watchCaption', 'unwatchCaption',
    'onUserMoveResize', 'matchFor', 'tryAssign', 'assignSave', 'endSession', 'workArea',
    'resolveOutput', 'outputUnderCursor', 'isOnScreen', 'isMaximizedLike', 'canPlace', 'fitLength',
    'targetFor', 'rectEquals', 'setGeometry', 'applySave', 'reapplyProvisional',
    'sweepRetries', 'sweepSessions', 'isIdle', 'ensureTick', 'onTick',
    'handleAdded', 'handleRemoved', 'startup', 'shutdown'
]
assert.deepEqual(Object.keys(extracted).sort(), [...REQUIRED_FUNCTIONS].sort(), 'harness drift: main.qml functions changed')
for (const name of REQUIRED_FUNCTIONS) {
    assert.ok(extracted[name], `harness drift: function '${name}' was not extracted from main.qml`)
}

function makeOutput(name, serial, gx, gy, width, height) {
    return {
        name, serialNumber: serial, x: gx, y: gy, width, height,
        geometry: { x: gx, y: gy, width, height },
        mapToGlobal: (p) => ({ x: p.x + gx, y: p.y + gy }),
        mapFromGlobal: (p) => ({ x: p.x - gx, y: p.y - gy })
    }
}

const outputs = [
    makeOutput('DP-1', 'SER-1', 0, 0, 1920, 1080),
    makeOutput('HDMI-A-1', 'SER-2', 2000, 0, 1280, 1024)
]
outputs.push(makeOutput('DP-3', 'SER-3', 2000, 0, 1280, 1024))

const fakeWorkspace = {
    screens: [outputs[0], outputs[1]],
    stackingOrder: [],
    desktops: [{ x11DesktopNumber: 1 }, { x11DesktopNumber: 2 }],
    activities: ['act-1', 'act-2'],
    virtualScreenGeometry: { x: 0, y: 0, width: 3280, height: 1080 },
    cursorPos: { x: 100, y: 100 },
    screenAt(p) {
        return this.screens.find((o) => p.x >= o.x && p.x < o.x + o.width && p.y >= o.y && p.y < o.y + o.height) || null
    },
    // Accepts a window (its screen) or an output; panels are not modelled.
    clientArea(_option, target) {
        const out = this.screens.find((o) => o === target || o === (target && target._output)) || this.screens[0]
        return { x: out.x, y: out.y, width: out.width, height: out.height }
    },
    // Set by buildRuntime: what Workspace.windowRemoved would call.
    removed: null
}

const fakeKWin = {
    MaximizeArea: 3,
    readConfig: (key, fallback) => (key === 'blacklist'
        ? 'org.kde.spectacle\nsteam*'
        : key === 'debug' ? true : fallback)
}

let windowCounter = 0
function makeWindow(fields) {
    const w = {
        internalId: 'uuid-' + (++windowCounter),
        deleted: false,
        normalWindow: true,
        popupWindow: false,
        skipTaskbar: false,
        modal: false,
        transient: false,
        splash: false,
        resourceClass: fields.cls,
        caption: fields.caption || '',
        minimized: false,
        minimizable: true,
        keepAbove: false,
        keepBelow: false,
        fullScreen: false,
        tile: null,
        move: false,
        resize: false,
        moveable: true,
        resizeable: true,
        minSize: null,
        maxSize: null,
        onAllDesktops: false,
        desktops: fields.desktop ? [fakeWorkspace.desktops[fields.desktop - 1]] : [fakeWorkspace.desktops[0]],
        activities: fields.activities || [],
        _output: fields.outputIndex !== undefined ? outputs[fields.outputIndex] : outputs[0],
        _geometryWrites: 0,
        _ignoreGeometry: false,
        _captionHandlers: [],
        _moveResizeHandlers: [],
        get x() { return this._g.x },
        get y() { return this._g.y },
        get width() { return this._g.width },
        get height() { return this._g.height },
        get pos() { return { x: this._g.x, y: this._g.y } },
        set frameGeometry(rect) {
            this._geometryWrites++
            if (!this._ignoreGeometry) this._g = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        },
        get output() { return this._output },
        get captionChanged() {
            const handlers = this._captionHandlers
            return {
                connect: (fn) => handlers.push(fn),
                disconnect: (fn) => { const i = handlers.indexOf(fn); if (i !== -1) handlers.splice(i, 1) }
            }
        },
        get interactiveMoveResizeStarted() {
            const handlers = this._moveResizeHandlers
            return {
                connect: (fn) => handlers.push(fn),
                disconnect: (fn) => { const i = handlers.indexOf(fn); if (i !== -1) handlers.splice(i, 1) }
            }
        },
        emitClosed() { fakeWorkspace.removed(this) },
        emitCaptionChanged() { for (const fn of [...this._captionHandlers]) fn() },
        emitMoveResizeStarted() { for (const fn of [...this._moveResizeHandlers]) fn() }
    }
    w._g = { x: fields.x ?? 100, y: fields.y ?? 100, width: fields.width ?? 800, height: fields.height ?? 600 }
    return w
}

function buildRuntime(initialBlob = '{}') {
    const Qt = {
        rect: (x, y, w, h) => ({ x, y, width: w, height: h }),
        point: (x, y) => ({ x, y })
    }

    const Workspace = fakeWorkspace
    const KWin = fakeKWin

    const stored = { windowgeometryrestore_windows: initialBlob }
    const settings = {
        value: (key, fallback) => (stored[key] === undefined || stored[key] === '' ? fallback : stored[key]),
        setValue: (key, v) => { stored[key] = v },
        sync: () => {}
    }

    const tickTimer = {
        running: false,
        start() { this.running = true },
        stop() { this.running = false }
    }

    const scope = `
        var now = 1000000000;
        var logs = [];
        var Date = { now: function () { return now } };
        var console = { warn: function (m) { logs.push(String(m)) } };
        var debugMode = true;
        var storeKey = 'windowgeometryrestore_windows';
        var defaultBlacklist = '';
        var blacklist = Engine.parseList('');
        var store = Engine.newState();
        var live = {};
        var tracked = {};
        var retries = [];
        ${Object.keys(extracted).map((name) => {
            const fn = extracted[name]
            return `function ${name}(${fn.params}) ${fn.body}`
        }).join('\n')}
        return { ${Object.keys(extracted).join(', ')}, trackedRef: () => tracked, storeRef: () => store, liveRef: () => live, retriesRef: () => retries, blobRef: () => settings.value(storeKey, '{}'), stored, getLogs: () => logs, nowRef: () => now, setNow: (n) => { now = n }, tick: onTick, tickRef: () => tickTimer };
    `

    const runtime = new Function('Engine', 'Workspace', 'KWin', 'Qt', 'settings', 'tickTimer', 'stored', `
        ${scope}
    `)(Engine, Workspace, KWin, Qt, settings, tickTimer, stored)

    fakeWorkspace.removed = runtime.handleRemoved
    runtime.startup()
    return runtime
}

const sleepTick = (runtime, ms) => runtime.setNow(runtime.nowRef() + ms)

test('single-window app (chrome PWA): close, relaunch, geometry restored', () => {
    const rt = buildRuntime()

    const w = makeWindow({ cls: 'whatsapp', caption: 'WhatsApp', x: 2040, y: 100, width: 1000, height: 700, outputIndex: 1, desktop: 2 })
    rt.trackWindow(w)

    w.emitClosed()

    const blob = JSON.parse(rt.blobRef())
    assert.ok(blob.apps['whatsapp'], 'app saved to settings')
    assert.equal(blob.apps['whatsapp'].w.length, 1)
    const save = blob.apps['whatsapp'].w[0]
    assert.equal(save.c, 'WhatsApp')
    assert.equal(save.w, 1000)
    assert.equal(save.o.n, 'HDMI-A-1')

    const relaunched = makeWindow({ cls: 'whatsapp', caption: 'WhatsApp', x: 200, y: 200, width: 1280, height: 720, outputIndex: 0, desktop: 1 })
    rt.trackWindow(relaunched)

    assert.equal(relaunched.x, 2040)
    assert.equal(relaunched.y, 100)
    assert.equal(relaunched.width, 1000)
    assert.equal(relaunched.height, 700)
    assert.equal(relaunched.desktops[0].x11DesktopNumber, 1, 'desktop untouched: KWin opens windows on the current desktop')
})

test('multi-window app: windows restored to their own slots regardless of launch order', () => {
    const rt = buildRuntime()

    const a = makeWindow({ cls: 'firefox', caption: 'Inbox - Mail', x: 10, y: 10, width: 800, height: 600, outputIndex: 0 })
    const b = makeWindow({ cls: 'firefox', caption: 'News - Mail', x: 2010, y: 50, width: 1200, height: 800, outputIndex: 1 })
    rt.trackWindow(a)
    rt.trackWindow(b)
    b.emitClosed()
    a.emitClosed()

    const saved = JSON.parse(rt.blobRef()).apps['firefox']
    assert.equal(saved.w.length, 2)

    // Windows reopen at default placement with swapped-ish sizes: the window whose
    // caption matches a save exactly is restored instantly; the other must not steal
    // that slot by size alone, and takes the one save left once it is unambiguous.
    const b2 = makeWindow({ cls: 'firefox', caption: 'News - Mail', x: 0, y: 0, width: 800, height: 600, outputIndex: 0 })
    const a2 = makeWindow({ cls: 'firefox', caption: 'Inbox - Mail', x: 0, y: 0, width: 800, height: 600, outputIndex: 0 })
    rt.trackWindow(b2)
    rt.trackWindow(a2)

    assert.equal(a2.x, 10, 'tier-1 match restored instantly')
    assert.equal(a2.width, 800)
    assert.equal(b2.x, 2010, 'deferred window got the last slot as soon as it was the only one left')
    assert.equal(b2.width, 1200)
})

test('ambiguous caption in a multi-save set is deferred, then best-effort assigned at deadline', () => {
    const rt = buildRuntime()

    const one = makeWindow({ cls: 'konsole', caption: 'Window One', x: 0, y: 0, width: 800, height: 600 })
    const two = makeWindow({ cls: 'konsole', caption: 'Window Two', x: 100, y: 100, width: 900, height: 700 })
    rt.trackWindow(one)
    rt.trackWindow(two)
    one.emitClosed()
    two.emitClosed()

    const reopened = makeWindow({ cls: 'konsole', caption: 'Window On', x: 500, y: 500, width: 640, height: 480 })
    rt.trackWindow(reopened)
    assert.equal(reopened._geometryWrites, 0, 'tier-3 match in a multi-save set must not apply instantly')

    sleepTick(rt, Engine.RESTORE_TIMEOUT_MS + 1000)
    rt.tick()
    assert.equal(reopened._geometryWrites > 0, true, 'deadline sweep applied the save')
    assert.equal(reopened.width, 800)
})

test('window already at saved geometry is not touched (native-first no-op)', () => {
    const rt = buildRuntime()

    const w = makeWindow({ cls: 'app', caption: 'App', x: 100, y: 100, width: 800, height: 600 })
    rt.trackWindow(w)
    w.emitClosed()

    const reopened = makeWindow({ cls: 'app', caption: 'App', x: 100, y: 100, width: 800, height: 600 })
    rt.trackWindow(reopened)
    assert.equal(reopened._geometryWrites, 0, 'already-correct windows must be left alone')
})

test('blacklisted apps and splash windows are never tracked', () => {
    const rt = buildRuntime()

    const blacklisted = makeWindow({ cls: 'org.kde.spectacle', caption: 'Spectacle' })
    const wildcard = makeWindow({ cls: 'steam_app_440', caption: 'Game' })
    const splash = makeWindow({ cls: 'gimp', caption: 'GIMP Startup' })
    splash.splash = true
    rt.trackWindow(blacklisted)
    rt.trackWindow(wildcard)
    rt.trackWindow(splash)
    assert.deepEqual(Object.keys(rt.trackedRef()), [])
})

test('corrupt persisted data is discarded safely, saving still works afterwards', () => {
    const rt = buildRuntime('{"apps": broken json{{{')

    assert.ok(rt.getLogs().some((l) => l.includes('unreadable')), 'corruption logged')
    assert.deepEqual(rt.storeRef().apps, {})
    assert.equal(rt.stored.windowgeometryrestore_windows_corrupt, '{"apps": broken json{{{', 'unreadable data kept aside')

    const w = makeWindow({ cls: 'app', caption: 'App', x: 10, y: 10, width: 500, height: 400 })
    rt.trackWindow(w)
    w.emitClosed()

    const blob = JSON.parse(rt.blobRef())
    assert.ok(blob.apps['app'], 'next save round-trips through valid JSON')
})

test('restore is clamped to the virtual screen (never off-screen)', () => {
    const rt = buildRuntime()

    const w = makeWindow({ cls: 'app', caption: 'App', x: 5000, y: 5000, width: 1000, height: 800 })
    rt.trackWindow(w)
    w.emitClosed()

    const reopened = makeWindow({ cls: 'app', caption: 'App', x: 0, y: 0, width: 1000, height: 800 })
    rt.trackWindow(reopened)
    assert.ok(reopened.x >= 0 && reopened.x + reopened.width <= 3280, 'x clamped: ' + reopened.x)
    assert.ok(reopened.y >= 0 && reopened.y + reopened.height <= 1080, 'y clamped: ' + reopened.y)
})

test('user moving the window during retries cancels further restore attempts', () => {
    const rt = buildRuntime()

    const w = makeWindow({ cls: 'app', caption: 'App', x: 50, y: 50, width: 700, height: 500 })
    rt.trackWindow(w)
    w.emitClosed()

    const reopened = makeWindow({ cls: 'app', caption: 'App', x: 0, y: 0, width: 600, height: 400 })
    reopened._ignoreGeometry = true
    rt.trackWindow(reopened)
    assert.equal(rt.retriesRef().length, 1, 'geometry retry queued')
    reopened.move = true
    rt.tick()
    reopened.move = false
    rt.tick()
    assert.equal(rt.retriesRef().length, 0, 'retry dropped after user interaction')
})

test('minimized and keepAbove/keepBelow are never restored - window opens in front of the user', () => {
    const rt = buildRuntime()

    const w = makeWindow({ cls: 'app', caption: 'App', x: 20, y: 20, width: 700, height: 500 })
    w.minimized = true
    w.keepAbove = true
    w.keepBelow = true
    rt.trackWindow(w)
    w.emitClosed()

    const blob = JSON.parse(rt.blobRef())
    assert.equal(blob.apps['app'].w[0].m, undefined, 'window states are not persisted anymore')

    const reopened = makeWindow({ cls: 'app', caption: 'App', x: 0, y: 0, width: 600, height: 400 })
    rt.trackWindow(reopened)
    assert.equal(reopened.minimized, false, 'opens in front of the user')
    assert.equal(reopened.keepAbove, false)
    assert.equal(reopened.keepBelow, false)
    assert.equal(reopened.x, 20)
    assert.equal(reopened.y, 20)
})

test('single monitor: restore works even when the connector name changed', () => {
    const rt = buildRuntime()

    const w = makeWindow({ cls: 'app', caption: 'App', x: 100, y: 100, width: 800, height: 600, outputIndex: 0 })
    rt.trackWindow(w)
    w.emitClosed()

    const renamed = makeOutput('HDMI-A-0', 'SER-CHANGED', 0, 0, 1920, 1080)
    fakeWorkspace.screens = [renamed]
    fakeWorkspace.virtualScreenGeometry = { x: 0, y: 0, width: 1920, height: 1080 }
    try {
        const reopened = makeWindow({ cls: 'app', caption: 'App', x: 400, y: 400, width: 900, height: 700, outputIndex: 0 })
        reopened._output = renamed
        rt.trackWindow(reopened)
        assert.equal(reopened.x, 100)
        assert.equal(reopened.y, 100)
        assert.equal(reopened.width, 800)
        assert.equal(reopened.height, 600)
    } finally {
        fakeWorkspace.screens = [outputs[0], outputs[1]]
        fakeWorkspace.virtualScreenGeometry = { x: 0, y: 0, width: 3280, height: 1080 }
    }
})

test('multi-monitor: saved screen missing -> lands on the cursor screen with size clamped to it', () => {
    const rt = buildRuntime()

    fakeWorkspace.screens = [outputs[0], outputs[1], outputs[2]]
    const w = makeWindow({ cls: 'app', caption: 'App', x: 2400, y: 100, width: 2400, height: 1600, outputIndex: 2 })
    rt.trackWindow(w)
    w.emitClosed()

    fakeWorkspace.screens = [outputs[0], outputs[1]]
    try {
        const reopened = makeWindow({ cls: 'app', caption: 'App', x: 0, y: 0, width: 800, height: 600, outputIndex: 0 })
        rt.trackWindow(reopened)
        assert.equal(reopened.x, 400, 'same relative position on the fallback screen (2400 - 2000)')
        assert.equal(reopened.y, 0, 'clamped to the fallback screen height')
        assert.equal(reopened.width, 1920, 'size clamped to the fallback screen work area')
        assert.equal(reopened.height, 1080)
    } finally {
        fakeWorkspace.screens = [outputs[0], outputs[1]]
    }
})

test('close buffer is capped while an app keeps a window open (no unbounded memory)', () => {
    const rt = buildRuntime()

    const main = makeWindow({ cls: 'chatty', caption: 'Main' })
    rt.trackWindow(main)

    for (let i = 0; i < 70; i++) {
        const aux = makeWindow({ cls: 'chatty', caption: 'Aux ' + i, x: i, y: i })
        rt.trackWindow(aux)
        aux.emitClosed()
    }

    const app = rt.liveRef()['chatty']
    assert.equal(app.open.length, 1, 'main window still open')
    assert.equal(app.buffer.length, Engine.MAX_BUFFER, 'buffer capped at MAX_BUFFER')
})

test('saves hit disk synchronously when the last window closes (no timers involved)', () => {
    const rt = buildRuntime()

    const a = makeWindow({ cls: 'app', caption: 'One', x: 5, y: 5, width: 600, height: 400 })
    const b = makeWindow({ cls: 'app', caption: 'Two', x: 50, y: 60, width: 700, height: 500 })
    rt.trackWindow(a)
    rt.trackWindow(b)
    b.emitClosed()
    a.emitClosed()

    const blob = JSON.parse(rt.blobRef())
    assert.equal(blob.apps['app'].w.length, 2, 'save written inside the close event itself')
    assert.equal(blob.apps['app'].w[0].c, 'Two')
    assert.equal(blob.apps['app'].w[1].c, 'One')
})

test('persist re-adopts apps present on disk but missing from memory (self-healing merge)', () => {
    const rt = buildRuntime()
    rt.stored.windowgeometryrestore_windows = JSON.stringify({
        version: 2,
        apps: { 'lost-app': { t: rt.nowRef(), w: [{ c: 'Lost window', x: 1, y: 2, w: 300, h: 200, o: null }] } }
    })

    const w = makeWindow({ cls: 'app', caption: 'App', x: 10, y: 10, width: 500, height: 400 })
    rt.trackWindow(w)
    w.emitClosed()

    const blob = JSON.parse(rt.blobRef())
    assert.ok(blob.apps['app'], 'own save written')
    assert.ok(blob.apps['lost-app'], 'disk-only app rescued instead of erased')
    assert.equal(blob.apps['lost-app'].w[0].c, 'Lost window')
})

// --- Regression tests: persistence across restarts ---

const DAY_MS = 24 * 60 * 60 * 1000

function closeAll(...windows) {
    for (const w of windows) w.emitClosed()
}

test('an app that is open is never pruned: its close is saved even if its entry had aged out', () => {
    const now = 1000000000
    const rt = buildRuntime(JSON.stringify({
        version: 2,
        apps: { foo: { t: now - Engine.EXPIRY_MS + 3600000, w: [{ c: 'Foo', x: 10, y: 10, w: 500, h: 400, o: null }] } }
    }))
    const w = makeWindow({ cls: 'foo', caption: 'Foo', x: 10, y: 10, width: 500, height: 400 })
    rt.trackWindow(w)
    rt.setNow(now + 2 * 3600000)
    const other = makeWindow({ cls: 'bar', caption: 'Bar' })
    rt.trackWindow(other)
    other.emitClosed() // persists and prunes

    w._g = { x: 300, y: 300, width: 500, height: 400 }
    w.emitClosed()
    const saved = JSON.parse(rt.blobRef()).apps.foo
    assert.ok(saved, 'close of the still-open app was saved')
    assert.equal(saved.w[0].x, 300)
})

test('expired apps are removed from disk and not resurrected by the merge', () => {
    const now = 1000000000
    const rt = buildRuntime(JSON.stringify({
        version: 2,
        apps: {
            stale: { t: now - Engine.EXPIRY_MS - 1, w: [{ c: 'Old', x: 1, y: 1, w: 300, h: 200, o: null }] },
            fresh: { t: now, w: [{ c: 'New', x: 1, y: 1, w: 300, h: 200, o: null }] }
        }
    }))
    assert.equal(JSON.parse(rt.blobRef()).apps.stale, undefined, 'pruned at load and written back without it')

    const w = makeWindow({ cls: 'app', caption: 'App' })
    rt.trackWindow(w)
    w.emitClosed()
    const apps = JSON.parse(rt.blobRef()).apps
    assert.equal(apps.stale, undefined, 'still gone after a later save')
    assert.ok(apps.fresh)
    assert.ok(apps.app)
})

test('saves survive a restore: a crash after relaunch still restores the last layout', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'app', caption: 'App', x: 40, y: 50, width: 700, height: 500 })
    rt.trackWindow(w)
    w.emitClosed()

    const reopened = makeWindow({ cls: 'app', caption: 'App', x: 0, y: 0, width: 700, height: 500 })
    rt.trackWindow(reopened)
    assert.equal(reopened.x, 40)
    sleepTick(rt, Engine.RESTORE_TIMEOUT_MS + 1)
    rt.tick()

    const blob = JSON.parse(rt.blobRef())
    assert.equal(blob.apps.app.w[0].x, 40, 'layout still on disk while the app runs')

    const fresh = buildRuntime(rt.blobRef()) // KWin restarted without the app closing
    const again = makeWindow({ cls: 'app', caption: 'App', x: 0, y: 0, width: 700, height: 500 })
    fresh.trackWindow(again)
    assert.equal(again.x, 40)
    assert.equal(again.y, 50)
})

test('a running app does not restore windows it opens later', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'app', caption: 'App', x: 40, y: 50, width: 700, height: 500 })
    rt.trackWindow(w)
    w.emitClosed()

    const first = makeWindow({ cls: 'app', caption: 'App', x: 0, y: 0 })
    rt.trackWindow(first)
    const second = makeWindow({ cls: 'app', caption: 'App', x: 5, y: 5 })
    rt.trackWindow(second)
    assert.equal(second._geometryWrites, 0, 'restore session already settled')
})

test('shutdown saves windows that are still open, and disconnects from them', () => {
    const rt = buildRuntime()
    const a = makeWindow({ cls: 'app', caption: 'One', x: 10, y: 20, width: 600, height: 400 })
    const b = makeWindow({ cls: 'app', caption: 'Two', x: 900, y: 20, width: 500, height: 400 })
    rt.trackWindow(a)
    rt.trackWindow(b)

    rt.shutdown()

    const saved = JSON.parse(rt.blobRef()).apps.app
    assert.equal(saved.w.length, 2, 'both open windows saved as one layout')
    assert.deepEqual(saved.w.map((s) => s.c).sort(), ['One', 'Two'])
    assert.deepEqual(Object.keys(rt.trackedRef()), [])
    assert.equal(a._moveResizeHandlers.length, 0)
    assert.equal(b._moveResizeHandlers.length, 0)
})

test('windows open before the script started are adopted, never moved, and saved on close', () => {
    const blob = JSON.stringify({ version: 2, apps: { app: { t: 1000000000, w: [{ c: 'App', x: 1, y: 1, w: 300, h: 200, o: null }] } } })
    const existing = makeWindow({ cls: 'app', caption: 'App', x: 500, y: 400, width: 800, height: 600 })
    fakeWorkspace.stackingOrder = [existing]
    let rt
    try {
        rt = buildRuntime(blob)
    } finally {
        fakeWorkspace.stackingOrder = []
    }
    assert.equal(existing._geometryWrites, 0, 'script reload must not move open windows')

    const extra = makeWindow({ cls: 'app', caption: 'App', x: 0, y: 0 })
    rt.trackWindow(extra)
    assert.equal(extra._geometryWrites, 0, 'app is already running: no restore session')

    extra.emitClosed()
    existing.emitClosed()
    const saved = JSON.parse(rt.blobRef()).apps.app
    assert.equal(saved.w[saved.w.length - 1].x, 500)
})

test('reopening while the previous restore session still runs uses the newest layout', () => {
    const rt = buildRuntime()
    const a = makeWindow({ cls: 'app', caption: 'One', x: 10, y: 10, width: 500, height: 400 })
    const b = makeWindow({ cls: 'app', caption: 'Two', x: 900, y: 10, width: 600, height: 400 })
    rt.trackWindow(a)
    rt.trackWindow(b)
    closeAll(a, b)

    const r1 = makeWindow({ cls: 'app', caption: 'One', x: 0, y: 0, width: 500, height: 400 })
    rt.trackWindow(r1) // tier 1, session keeps waiting for 'Two'
    r1._g = { x: 1200, y: 500, width: 500, height: 400 }
    r1.emitClosed()

    const r2 = makeWindow({ cls: 'app', caption: 'One', x: 0, y: 0, width: 500, height: 400 })
    rt.trackWindow(r2)
    assert.deepEqual([r2.x, r2.y], [1200, 500])
})

test('a window closed before its deferred restore does not overwrite the saved layout', () => {
    const rt = buildRuntime()
    const a = makeWindow({ cls: 'app', caption: 'One', x: 10, y: 10, width: 500, height: 400 })
    const b = makeWindow({ cls: 'app', caption: 'Two', x: 900, y: 10, width: 600, height: 400 })
    rt.trackWindow(a)
    rt.trackWindow(b)
    closeAll(a, b)

    const early = makeWindow({ cls: 'app', caption: 'Loading', x: 0, y: 0, width: 640, height: 480 })
    rt.trackWindow(early) // no unambiguous match: waits for the deadline
    assert.equal(early._geometryWrites, 0)
    early.emitClosed()

    const saved = JSON.parse(rt.blobRef()).apps.app
    assert.equal(saved.w.length, 2, 'previous two-window layout kept')
    assert.deepEqual(saved.w.map((s) => s.x), [10, 900])
})

// --- Regression tests: placement and retries ---

test('retries never fight a window that got maximized after the restore', () => {
    const rt = buildRuntime()
    const a = makeWindow({ cls: 'max', caption: 'M', x: 10, y: 10, width: 500, height: 400 })
    rt.trackWindow(a)
    a.emitClosed()

    const r = makeWindow({ cls: 'max', caption: 'M', x: 0, y: 0, width: 800, height: 600 })
    r._ignoreGeometry = true
    rt.trackWindow(r) // first write does not stick
    r._ignoreGeometry = false
    r._g = { x: 0, y: 0, width: 1920, height: 1080 } // the app maximizes itself
    sleepTick(rt, Engine.TICK_MS)
    rt.tick()
    assert.equal(r.width, 1920)
    assert.equal(rt.retriesRef().length, 0)
})

test('a user move before a deferred restore wins: the window is left where the user put it', () => {
    const rt = buildRuntime()
    const a = makeWindow({ cls: 'app', caption: 'One', x: 10, y: 10, width: 500, height: 400 })
    const b = makeWindow({ cls: 'app', caption: 'Two', x: 900, y: 10, width: 600, height: 400 })
    rt.trackWindow(a)
    rt.trackWindow(b)
    closeAll(a, b)

    const w = makeWindow({ cls: 'app', caption: 'Other', x: 0, y: 0, width: 640, height: 480 })
    rt.trackWindow(w)
    w.emitMoveResizeStarted()
    w._g = { x: 333, y: 222, width: 640, height: 480 }

    sleepTick(rt, Engine.RESTORE_TIMEOUT_MS + 1)
    rt.tick()
    assert.equal(w._geometryWrites, 0)
    assert.equal(w.x, 333)

    w.emitClosed()
    assert.equal(JSON.parse(rt.blobRef()).apps.app.w[0].x, 333, 'user placement is saved')
})

test('a user move signal cancels pending geometry retries immediately', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'app', caption: 'App', x: 50, y: 50, width: 700, height: 500 })
    rt.trackWindow(w)
    w.emitClosed()

    const reopened = makeWindow({ cls: 'app', caption: 'App', x: 0, y: 0, width: 600, height: 400 })
    reopened._ignoreGeometry = true
    rt.trackWindow(reopened)
    assert.equal(rt.retriesRef().length, 1)
    reopened.emitMoveResizeStarted()
    const writes = reopened._geometryWrites
    rt.tick()
    assert.equal(reopened._geometryWrites, writes)
    assert.equal(rt.retriesRef().length, 0)
})

test('deadline sweep assigns the best pair overall, whatever order windows arrived in', () => {
    for (const sizedFirst of [true, false]) {
        const rt = buildRuntime()
        const s1 = makeWindow({ cls: 'app', caption: 'Alpha docs', x: 10, y: 10, width: 500, height: 400 })
        const s2 = makeWindow({ cls: 'app', caption: 'Beta', x: 900, y: 10, width: 700, height: 400 })
        const s3 = makeWindow({ cls: 'app', caption: 'Gamma', x: 10, y: 600, width: 300, height: 300 })
        rt.trackWindow(s1)
        rt.trackWindow(s2)
        rt.trackWindow(s3)
        closeAll(s1, s2, s3)

        // Both windows want save 1: one only by caption (tier 3), the other by size (tier 2).
        const sized = makeWindow({ cls: 'app', caption: 'Untitled', x: 0, y: 0, width: 500, height: 400 })
        const loose = makeWindow({ cls: 'app', caption: 'Alpha doc', x: 0, y: 0, width: 640, height: 480 })
        for (const w of sizedFirst ? [sized, loose] : [loose, sized]) rt.trackWindow(w)
        sleepTick(rt, Engine.RESTORE_TIMEOUT_MS + 1)
        rt.tick()
        assert.deepEqual([sized.x, sized.y], [10, 10], 'size match (tier 2) gets slot 1')
        assert.notDeepEqual([loose.x, loose.y], [10, 10])
    }
})

test('identical monitors sharing a serial: the connector name decides', () => {
    const left = makeOutput('DP-1', 'SAME', 0, 0, 1920, 1080)
    const right = makeOutput('DP-2', 'SAME', 1920, 0, 1920, 1080)
    fakeWorkspace.screens = [left, right]
    fakeWorkspace.virtualScreenGeometry = { x: 0, y: 0, width: 3840, height: 1080 }
    try {
        const rt = buildRuntime()
        const w = makeWindow({ cls: 'app', caption: 'App', x: 2020, y: 100, width: 800, height: 600 })
        w._output = right
        rt.trackWindow(w)
        w.emitClosed()

        const reopened = makeWindow({ cls: 'app', caption: 'App', x: 0, y: 0, width: 800, height: 600 })
        reopened._output = left
        rt.trackWindow(reopened)
        assert.equal(reopened.x, 2020)
    } finally {
        fakeWorkspace.screens = [outputs[0], outputs[1]]
        fakeWorkspace.virtualScreenGeometry = { x: 0, y: 0, width: 3280, height: 1080 }
    }
})

test('a monitor that appears late (login) gets its window moved to it', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'app', caption: 'App', x: 2040, y: 100, width: 800, height: 600, outputIndex: 1 })
    rt.trackWindow(w)
    w.emitClosed()

    fakeWorkspace.screens = [outputs[0]]
    fakeWorkspace.virtualScreenGeometry = { x: 0, y: 0, width: 1920, height: 1080 }
    try {
        const reopened = makeWindow({ cls: 'app', caption: 'App', x: 0, y: 0, width: 800, height: 600 })
        rt.trackWindow(reopened)
        assert.deepEqual([reopened.x, reopened.y], [40, 100], 'provisionally on the only screen')

        fakeWorkspace.screens = [outputs[0], outputs[1]]
        fakeWorkspace.virtualScreenGeometry = { x: 0, y: 0, width: 3280, height: 1080 }
        rt.reapplyProvisional()
        assert.deepEqual([reopened.x, reopened.y], [2040, 100], 'moved once its own screen is back')
    } finally {
        fakeWorkspace.screens = [outputs[0], outputs[1]]
        fakeWorkspace.virtualScreenGeometry = { x: 0, y: 0, width: 3280, height: 1080 }
    }
})

test('a late monitor does not move a window the user already placed', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'app', caption: 'App', x: 2040, y: 100, width: 800, height: 600, outputIndex: 1 })
    rt.trackWindow(w)
    w.emitClosed()

    fakeWorkspace.screens = [outputs[0]]
    try {
        const reopened = makeWindow({ cls: 'app', caption: 'App', x: 0, y: 0, width: 800, height: 600 })
        rt.trackWindow(reopened)
        reopened.emitMoveResizeStarted()
        fakeWorkspace.screens = [outputs[0], outputs[1]]
        const writes = reopened._geometryWrites
        rt.reapplyProvisional()
        assert.equal(reopened._geometryWrites, writes)
    } finally {
        fakeWorkspace.screens = [outputs[0], outputs[1]]
    }
})

test('a window never lands in the gap between unequal screens', () => {
    const rt = buildRuntime(JSON.stringify({
        version: 2,
        apps: { app: { t: 1000000000, w: [{ c: 'App', x: 1900, y: 100, w: 100, h: 100, o: null }] } }
    }))
    const w = makeWindow({ cls: 'app', caption: 'App', x: 0, y: 0, width: 100, height: 100 })
    rt.trackWindow(w)
    assert.ok(rt.isOnScreen(w.x + w.width / 2, w.y), `title bar reachable at ${w.x},${w.y}`)
})

test('fixed-size windows get their position restored and keep their size', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'dialogish', caption: 'Calc', x: 300, y: 200, width: 400, height: 500 })
    rt.trackWindow(w)
    w.emitClosed()

    const reopened = makeWindow({ cls: 'dialogish', caption: 'Calc', x: 0, y: 0, width: 420, height: 520 })
    reopened.resizeable = false
    rt.trackWindow(reopened)
    assert.deepEqual([reopened.x, reopened.y, reopened.width, reopened.height], [300, 200, 420, 520])
})

test('fullscreen windows are not saved over a good layout', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'player', caption: 'Video', x: 100, y: 100, width: 800, height: 450 })
    rt.trackWindow(w)
    w.emitClosed()

    const reopened = makeWindow({ cls: 'player', caption: 'Video', x: 100, y: 100, width: 800, height: 450 })
    rt.trackWindow(reopened)
    reopened.fullScreen = true
    reopened._g = { x: 0, y: 0, width: 1920, height: 1080 }
    reopened.emitClosed()
    assert.equal(JSON.parse(rt.blobRef()).apps.player.w[0].w, 800, 'windowed layout kept')
})

// --- Regression tests: error containment ---

test('one broken window at startup does not stop the others from being tracked', () => {
    const broken = makeWindow({ cls: 'bad', caption: 'Bad' })
    Object.defineProperty(broken, 'normalWindow', { get() { throw new Error('boom') } })
    const good = makeWindow({ cls: 'good', caption: 'Good' })
    fakeWorkspace.stackingOrder = [broken, good]
    let rt
    try {
        rt = buildRuntime()
    } finally {
        fakeWorkspace.stackingOrder = []
    }
    assert.equal(Object.keys(rt.trackedRef()).length, 1)
    assert.ok(rt.getLogs().some((l) => l.includes('tracking an existing window failed')))
})

test('a failing geometry retry does not stop other sessions from ending', () => {
    const rt = buildRuntime()
    for (const cls of ['p', 'q']) {
        const one = makeWindow({ cls, caption: 'One', x: 10, y: 10, width: 500, height: 400 })
        const two = makeWindow({ cls, caption: 'Two', x: 900, y: 10, width: 600, height: 400 })
        rt.trackWindow(one)
        rt.trackWindow(two)
        closeAll(one, two)
    }
    const bad = makeWindow({ cls: 'p', caption: 'One', x: 0, y: 0, width: 500, height: 400 })
    bad._ignoreGeometry = true
    rt.trackWindow(bad)
    Object.defineProperty(bad, 'frameGeometry', { set() { throw new Error('boom') } })
    const waiting = makeWindow({ cls: 'q', caption: 'Other', x: 0, y: 0, width: 640, height: 480 })
    rt.trackWindow(waiting)

    sleepTick(rt, Engine.TICK_MS)
    rt.tick()
    assert.equal(rt.retriesRef().length, 0, 'failing retry dropped')
    sleepTick(rt, Engine.RESTORE_TIMEOUT_MS)
    rt.tick()
    assert.equal(rt.liveRef().q.session, null, 'q session ended at its deadline')
    assert.equal(rt.tickRef().running, false, 'timer stops once idle')
})
