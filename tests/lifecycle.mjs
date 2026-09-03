import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

// Integration harness: extracts the real functions from main.qml and drives them
// against a fake KWin Workspace, so the save -> persist -> relaunch -> restore
// lifecycle is verified without a running Plasma session.

const qml = readFileSync(new URL('../src/contents/ui/main.qml', import.meta.url), 'utf8')

const engineSource = readFileSync(new URL('../src/contents/ui/engine.js', import.meta.url), 'utf8')
    .replace(/^\s*\.pragma library.*$/m, '')
const Engine = new Function(`${engineSource}\nreturn { newState, parseList, isListed, captionScore, bestMatch, makeSave, decodeState, encodeState, pruneExpired, mergeDiskApps, BURST_MS, RESTORE_TIMEOUT_MS, RETRY_MAX_AGE_MS, MAX_GEOMETRY_TRIES, MAX_BUFFER };`)()

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
    'log', 'dbg', 'removeFromArray', 'isValidWindow', 'loadConfig', 'loadPersisted', 'persist',
    'ensureApp', 'trackWindow', 'snapshotWindow', 'onWindowClosed', 'finalizeApp',
    'maybeStartSession', 'watchCaption', 'unwatchCaption', 'bestMatchForWindow',
    'tryAssign', 'assignSave', 'endSession', 'resolveOutput', 'outputUnderCursor',
    'isMaximizedLike', 'targetFor', 'rectEquals', 'applySnapshot',
    'sweepRetries', 'sweepSessions', 'stopTickIfIdle', 'ensureTick', 'onTick'
]
for (const name of REQUIRED_FUNCTIONS) {
    assert.ok(extracted[name], `harness drift: function '${name}' was not extracted from main.qml`)
}

function makeOutput(name, serial, gx, gy, width, height) {
    return {
        name, serialNumber: serial, x: gx, y: gy, width, height,
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
    desktops: [{ x11DesktopNumber: 1 }, { x11DesktopNumber: 2 }],
    activities: ['act-1', 'act-2'],
    virtualScreenGeometry: { x: 0, y: 0, width: 3280, height: 1080 },
    cursorPos: { x: 100, y: 100 },
    screenAt(p) {
        return this.screens.find((o) => p.x >= o.x && p.x < o.x + o.width && p.y >= o.y && p.y < o.y + o.height) || null
    },
    clientArea(_option, w) {
        const out = this.screens.find((o) => o === (w && w._output)) || this.screens[0]
        return { x: out.x, y: out.y, width: out.width, height: out.height }
    }
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
        _closedHandlers: [],
        _captionHandlers: [],
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
        get closed() {
            const handlers = this._closedHandlers
            return {
                connect: (fn) => handlers.push(fn),
                disconnect: (fn) => { const i = handlers.indexOf(fn); if (i !== -1) handlers.splice(i, 1) }
            }
        },
        emitClosed() { for (const fn of [...this._closedHandlers]) fn() },
        emitCaptionChanged() { for (const fn of [...this._captionHandlers]) fn() }
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

    let storedBlob = initialBlob
    const settings = {
        value: (_key, fallback) => (storedBlob === '' ? fallback : storedBlob),
        setValue: (_key, v) => { storedBlob = v },
        sync: () => {},
        rawSet: (v) => { storedBlob = v }
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
        var config = {};
        var state = Engine.newState();
        var tracked = {};
        var retries = [];
        var defaultBlacklist = '';
        ${Object.keys(extracted).map((name) => {
            const fn = extracted[name]
            return `function ${name}(${fn.params}) ${fn.body}`
        }).join('\n')}
        return { ${Object.keys(extracted).join(', ')}, trackedRef: () => tracked, stateRef: () => state, retriesRef: () => retries, blobRef: () => settings.value('windowgeometryrestore_windows', '{}'), rawSetRef: settings.rawSet, getLogs: () => logs, nowRef: () => now, setNow: (n) => { now = n }, tick: onTick, tickRef: () => tickTimer };
    `

    const runtime = new Function('Engine', 'Workspace', 'KWin', 'Qt', 'settings', 'tickTimer', `
        ${scope}
    `)(Engine, Workspace, KWin, Qt, settings, tickTimer)

    runtime.loadConfig()
    runtime.loadPersisted()
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
    // caption matches a save exactly is restored instantly; the other waits for the
    // deadline sweep so it cannot steal the wrong slot by size alone.
    const b2 = makeWindow({ cls: 'firefox', caption: 'News - Mail', x: 0, y: 0, width: 800, height: 600, outputIndex: 0 })
    const a2 = makeWindow({ cls: 'firefox', caption: 'Inbox - Mail', x: 0, y: 0, width: 800, height: 600, outputIndex: 0 })
    rt.trackWindow(b2)
    rt.trackWindow(a2)

    assert.equal(a2.x, 10, 'tier-1 match restored instantly')
    assert.equal(a2.width, 800)

    sleepTick(rt, Engine.RESTORE_TIMEOUT_MS + 500)
    rt.tick()
    assert.equal(b2.x, 2010, 'deferred window got its caption-matched slot at deadline')
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
    assert.deepEqual(rt.stateRef().apps, {})

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

    const app = rt.stateRef().apps['chatty']
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
    rt.rawSetRef(JSON.stringify({
        version: 2,
        apps: { 'lost-app': { t: 1, w: [{ c: 'Lost window', x: 1, y: 2, w: 300, h: 200, o: null }] } }
    }))

    const w = makeWindow({ cls: 'app', caption: 'App', x: 10, y: 10, width: 500, height: 400 })
    rt.trackWindow(w)
    w.emitClosed()

    const blob = JSON.parse(rt.blobRef())
    assert.ok(blob.apps['app'], 'own save written')
    assert.ok(blob.apps['lost-app'], 'disk-only app rescued instead of erased')
    assert.equal(blob.apps['lost-app'].w[0].c, 'Lost window')
})
