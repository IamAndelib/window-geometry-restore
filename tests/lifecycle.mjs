import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

// Integration harness: extracts the real functions from main.qml and drives them
// against a fake KWin Workspace, so the save -> persist -> relaunch -> restore
// lifecycle is verified without a running Plasma session.

const qml = readFileSync(new URL('../src/contents/ui/main.qml', import.meta.url), 'utf8')

const engineSource = readFileSync(new URL('../src/contents/ui/engine.js', import.meta.url), 'utf8')
    .replace(/^\s*\.pragma library.*$/m, '')
const Engine = new Function(`${engineSource}\nreturn { newState, parseList, isListed, captionScore, bestMatch, makeSave, decodeState, encodeState, pruneExpired, BURST_MS, RESTORE_TIMEOUT_MS, RETRY_MAX_AGE_MS, MAX_GEOMETRY_TRIES };`)()

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

const fakeWorkspace = {
    screens: outputs,
    desktops: [{ x11DesktopNumber: 1 }, { x11DesktopNumber: 2 }],
    activities: ['act-1', 'act-2'],
    virtualScreenGeometry: { x: 0, y: 0, width: 3280, height: 1080 },
    clientArea: (_option, w) => {
        const out = outputs.find((o) => o === w._output) || outputs[0]
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
    const settings = {}
    Object.defineProperty(settings, 'windowgeometryrestore_windows', {
        get: () => storedBlob,
        set: (v) => { storedBlob = v }
    })

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
        return { ${Object.keys(extracted).join(', ')}, trackedRef: () => tracked, stateRef: () => state, retriesRef: () => retries, blobRef: () => settings.windowgeometryrestore_windows, getLogs: () => logs, nowRef: () => now, setNow: (n) => { now = n }, tick: onTick, tickRef: () => tickTimer };
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
    sleepTick(rt, Engine.BURST_MS + 500)
    rt.tick()

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
    assert.equal(relaunched.desktops[0].x11DesktopNumber, 2)
})

test('multi-window app: windows restored to their own slots regardless of launch order', () => {
    const rt = buildRuntime()

    const a = makeWindow({ cls: 'firefox', caption: 'Inbox - Mail', x: 10, y: 10, width: 800, height: 600, outputIndex: 0 })
    const b = makeWindow({ cls: 'firefox', caption: 'News - Mail', x: 2010, y: 50, width: 1200, height: 800, outputIndex: 1 })
    rt.trackWindow(a)
    rt.trackWindow(b)
    b.emitClosed()
    a.emitClosed()
    sleepTick(rt, Engine.BURST_MS + 500)
    rt.tick()

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
    sleepTick(rt, Engine.BURST_MS + 500)
    rt.tick()

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
    sleepTick(rt, Engine.BURST_MS + 500)
    rt.tick()

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
    sleepTick(rt, Engine.BURST_MS + 500)
    rt.tick()

    const blob = JSON.parse(rt.blobRef())
    assert.ok(blob.apps['app'], 'next save round-trips through valid JSON')
})

test('restore is clamped to the virtual screen (never off-screen)', () => {
    const rt = buildRuntime()

    const w = makeWindow({ cls: 'app', caption: 'App', x: 5000, y: 5000, width: 1000, height: 800 })
    rt.trackWindow(w)
    w.emitClosed()
    sleepTick(rt, Engine.BURST_MS + 500)
    rt.tick()

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
    sleepTick(rt, Engine.BURST_MS + 500)
    rt.tick()

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
