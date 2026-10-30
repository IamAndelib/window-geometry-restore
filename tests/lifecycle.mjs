import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

// Integration harness: extracts the real functions from main.qml and drives them
// against a fake KWin Workspace, so the save -> persist -> relaunch -> restore
// lifecycle is verified without a running Plasma session.

const qml = readFileSync(new URL('../src/contents/ui/main.qml', import.meta.url), 'utf8')

const engineSource = readFileSync(new URL('../src/contents/ui/engine.js', import.meta.url), 'utf8')
    .replace(/^\s*\.pragma library.*$/m, '')
const Engine = new Function(`${engineSource}\nreturn { newState, parseList, isListed, captionScore, isBetterMatch, bestMatch, makeSave, decodeState, encodeState, pruneExpired, mergeDiskApps, BURST_MS, RESTORE_TIMEOUT_MS, RETRY_MAX_AGE_MS, MAX_GEOMETRY_TRIES, MAX_BUFFER, EXPIRY_MS, TICK_MS, QUICK_TILES, QUICK_TILE_ACTIONS, MAX_TILE_DEPTH, TILE_TOLERANCE, layoutFor, recordLayout };`)()

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
    'loadConfig', 'loadPersisted', 'persist', 'desktopKeyOf', 'joinGroup', 'trackWindow', 'onDesktopsChanged', 'untrack', 'geometryOf', 'isAway', 'isMaximized', 'copyGeometry', 'describeTile',
    'noteTile', 'noteGeometry', 'snapshotWindow',
    'releaseWindow', 'finalizeApp', 'startSession', 'joinSession', 'watchCaption', 'unwatchCaption',
    'onUserMoveResize', 'matchFor', 'tryAssign', 'assignSave', 'endSession', 'workArea',
    'resolveOutput', 'outputUnderCursor', 'isOnScreen', 'isMaximizedLike', 'canPlace', 'fitLength',
    'targetFor', 'rectEquals', 'setGeometry', 'applySave', 'rootTileFor', 'isTileAt', 'findCustomTile',
    'quickRootFor', 'planTile', 'startTile', 'quickTileWhenActive', 'restoreQuickSplit', 'cancelPendingTile', 'reapplyProvisional',
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

// KWin's tile trees (src/tiles in KWin 6.7). Quick tiles are plain Tiles (no layoutDirection)
// under a QuickRootTile, created in a fixed order; custom (Meta+T) tiles are CustomTiles,
// which have a layoutDirection.
function makeTile(output, parent, rel, custom) {
    const tile = {
        parent,
        tiles: [],
        windows: [],
        _rel: { ...rel },
        get relativeGeometry() { return { ...this._rel } },
        // Tile::setRelativeGeometry: managed windows follow, and a quick root moves its splits.
        set relativeGeometry(r) {
            this._set(r)
            if (parent && parent._relayout) parent._relayout(this)
        },
        _set(r) {
            this._rel = { x: r.x, y: r.y, width: r.width, height: r.height }
            for (const w of [...this.windows]) w._setFrame(this.absoluteGeometry)
        },
        get absoluteGeometry() {
            const g = output.geometry
            const r = this._rel
            return {
                x: Math.round(g.x + r.x * g.width), y: Math.round(g.y + r.y * g.height),
                width: Math.round(r.width * g.width), height: Math.round(r.height * g.height)
            }
        }
    }
    tile.manage = (w) => w._tileTo(tile)
    if (custom) tile.layoutDirection = 1
    if (parent) parent.tiles.push(tile)
    return tile
}

const QUICK_RECTS = [
    { x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 1 },
    { x: 0, y: 0, width: 1, height: 0.5 }, { x: 0, y: 0.5, width: 1, height: 0.5 },
    { x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0, width: 0.5, height: 0.5 },
    { x: 0, y: 0.5, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
]

// QuickRootTile: the eight tiles share one horizontal and one vertical split. Resizing one
// moves the split for all (relayoutToFit); once no quick tile holds a window, both splits
// go back to 0.5 (tryReset).
function makeQuickRoot(output) {
    const root = makeTile(output, null, { x: 0, y: 0, width: 1, height: 1 }, false)
    for (const rect of QUICK_RECTS) makeTile(output, root, rect, false)
    const [L, R, T, B, TL, TR, BL, BR] = root.tiles
    const setH = (s) => {
        for (const t of [L, TL, BL]) t._set({ ...t._rel, width: s - t._rel.x })
        for (const t of [R, TR, BR]) t._set({ ...t._rel, x: s, width: 1 - s })
    }
    const setV = (s) => {
        for (const t of [T, TL, TR]) t._set({ ...t._rel, height: s - t._rel.y })
        for (const t of [B, BL, BR]) t._set({ ...t._rel, y: s, height: 1 - s })
    }
    root._relayout = (t) => {
        const g = t._rel
        const right = g.x + g.width
        const bottom = g.y + g.height
        if (t === T) setV(bottom)
        else if (t === B) setV(g.y)
        else if (t === L) setH(right)
        else if (t === R) setH(g.x)
        else if (t === TL) { setH(right); setV(bottom) }
        else if (t === TR) { setH(g.x); setV(bottom) }
        else if (t === BR) { setH(g.x); setV(g.y) }
        else if (t === BL) { setH(right); setV(g.y) }
    }
    root._tryReset = () => {
        if ([TL, TR, BL, BR].some((t) => t.windows.length)) return
        if (!L.windows.length && !R.windows.length) setH(0.5)
        if (!T.windows.length && !B.windows.length) setV(0.5)
    }
    return root
}

// A left column (0.4) and a right column split into top and bottom halves.
function makeCustomRoot(output) {
    const root = makeTile(output, null, { x: 0, y: 0, width: 1, height: 1 }, true)
    makeTile(output, root, { x: 0, y: 0, width: 0.4, height: 1 }, true)
    const right = makeTile(output, root, { x: 0.4, y: 0, width: 0.6, height: 1 }, true)
    makeTile(output, right, { x: 0.4, y: 0, width: 0.6, height: 0.5 }, true)
    makeTile(output, right, { x: 0.4, y: 0.5, width: 0.6, height: 0.5 }, true)
    return root
}

const fakeWorkspace = {
    screens: [outputs[0], outputs[1]],
    stackingOrder: [],
    desktops: [{ x11DesktopNumber: 1, id: 'desk-uuid-1' }, { x11DesktopNumber: 2, id: 'desk-uuid-2' }, { x11DesktopNumber: 3, id: 'desk-uuid-3' }],
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
    activeWindow: null,
    // Per screen: the custom (Meta+T) layout, and the quick-tile root KWin keeps internally.
    _customRoots: new Map(),
    _quickRoots: new Map(),
    // A layout set for one desktop (key 'output/desktop id') wins over one set for the screen.
    rootTile(output, desktop) {
        return this._customRoots.get(output.name + '/' + (desktop && desktop.id)) || this._customRoots.get(output) || null
    },
    // Set by buildRuntime: what Workspace.windowRemoved would call.
    removed: null
}
fakeWorkspace.currentDesktop = fakeWorkspace.desktops[0]
const quickRootOf = (output) => {
    if (!fakeWorkspace._quickRoots.has(output)) fakeWorkspace._quickRoots.set(output, makeQuickRoot(output))
    return fakeWorkspace._quickRoots.get(output)
}
Engine.QUICK_TILE_ACTIONS.forEach((name, i) => {
    fakeWorkspace[name] = function () {
        if (this.activeWindow) this.activeWindow._tileTo(quickRootOf(this.activeWindow._output).tiles[i])
    }
})

const fakeKWin = {
    MaximizeArea: 3,
    config: {},
    readConfig: (key, fallback) => (key in fakeKWin.config ? fakeKWin.config[key]
        : key === 'blacklist' ? 'org.kde.spectacle\nsteam*'
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
        maximizeMode: 0,
        tile: null,
        move: false,
        resize: false,
        moveable: true,
        resizeable: true,
        minSize: null,
        maxSize: null,
        onAllDesktops: fields.desktop === 'all',
        desktops: fields.desktop === 'all' ? [] : fields.desktop ? [fakeWorkspace.desktops[fields.desktop - 1]] : [fakeWorkspace.desktops[0]],
        activities: fields.activities || [],
        _output: fields.outputIndex !== undefined ? outputs[fields.outputIndex] : outputs[0],
        _geometryWrites: 0,
        _ignoreGeometry: false,
        _captionHandlers: [],
        _moveResizeHandlers: [],
        _handlers: {},
        _restoreGeometry: null,
        _async: false,
        _requested: null,
        active: false,
        get x() { return this._g.x },
        get y() { return this._g.y },
        get width() { return this._g.width },
        get height() { return this._g.height },
        get pos() { return { x: this._g.x, y: this._g.y } },
        set frameGeometry(rect) {
            this._geometryWrites++
            if (this._ignoreGeometry) return
            // Wayland: the frame only changes once the app acknowledges the new size.
            if (this._async) this._requested = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            else this._setFrame(rect)
        },
        get frameGeometryChanged() { return this._signal('frameGeometryChanged') },
        get tileChanged() { return this._signal('tileChanged') },
        get activeChanged() { return this._signal('activeChanged') },
        get desktopsChanged() { return this._signal('desktopsChanged') },
        // The user sends the window to another desktop (a number), or to all desktops ('all').
        _moveToDesktop(desktop) {
            this.onAllDesktops = desktop === 'all'
            this.desktops = desktop === 'all' ? [] : [fakeWorkspace.desktops[desktop - 1]]
            this._emit('desktopsChanged')
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
        _signal(name) {
            const handlers = this._handlers[name] || (this._handlers[name] = [])
            return {
                connect: (fn) => handlers.push(fn),
                disconnect: (fn) => { const i = handlers.indexOf(fn); if (i !== -1) handlers.splice(i, 1) }
            }
        },
        _emit(name) { for (const fn of [...(this._handlers[name] || [])]) fn() },
        _connected(name) { return (this._handlers[name] || []).length },
        // A geometry change made by KWin, the app or the user (not a script write).
        _setFrame(rect) {
            const g = this._g
            this._g = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            if (g.x !== rect.x || g.y !== rect.y || g.width !== rect.width || g.height !== rect.height) this._emit('frameGeometryChanged')
        },
        // KWin's Window::requestTile: the free geometry at tiling time becomes the restore
        // geometry, and the tile is set before the window is moved into it.
        _tileTo(tile) {
            if (!this.tile) this._restoreGeometry = { ...(this._requested || this._g) }
            this._requested = null
            this._leaveTile()
            tile.windows.push(this)
            this.tile = tile
            this._emit('tileChanged')
            this._setFrame(tile.absoluteGeometry)
        },
        // Dragging out of a tile: a user move that untiles first, then resizes to the restore
        // geometry under the cursor.
        _dragOut(x, y) {
            this.emitMoveResizeStarted()
            this._leaveTile()
            this.tile = null
            this._emit('tileChanged')
            this._setFrame({ x, y, width: this._restoreGeometry.width, height: this._restoreGeometry.height })
        },
        // The app acknowledges the size the script asked for (Wayland).
        _commit(output) {
            if (output) this._output = output
            const rect = this._requested
            this._requested = null
            if (rect) this._setFrame(rect)
        },
        // The user (or KWin's focus policy) activates the window; the script never does.
        _activate() {
            if (fakeWorkspace.activeWindow) fakeWorkspace.activeWindow.active = false
            fakeWorkspace.activeWindow = this
            this.active = true
            this._emit('activeChanged')
        },
        _leaveTile() {
            const tile = this.tile
            if (!tile || !tile.windows.includes(this)) return
            tile.windows.splice(tile.windows.indexOf(this), 1)
            if (tile.parent && tile.parent._tryReset) tile.parent._tryReset()
        },
        // KWin's tiles connect to Workspace::windowRemoved at startup, before any script, so
        // the tile lets go first (and a quick root may reset its splits). `tile` keeps its
        // value: requestTile() ignores deleted windows.
        emitClosed() {
            this._leaveTile()
            fakeWorkspace.removed(this)
        },
        emitCaptionChanged() { for (const fn of [...this._captionHandlers]) fn() },
        emitMoveResizeStarted() { for (const fn of [...this._moveResizeHandlers]) fn() }
    }
    w._g = { x: fields.x ?? 100, y: fields.y ?? 100, width: fields.width ?? 800, height: fields.height ?? 600 }
    return w
}

function buildRuntime(initialBlob = '{}', config = {}) {
    fakeKWin.config = config
    fakeWorkspace.activeWindow = null
    fakeWorkspace._customRoots = new Map()
    fakeWorkspace._quickRoots = new Map()
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
        var restoreTiles = true;
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
// The runtime group of an app on one desktop (desktop numbers as in makeWindow, or 'all').
const groupOf = (rt, cls, desktop = 1) => rt.liveRef()[cls + '\n' + (desktop === 'all' ? '*' : 'desk-uuid-' + desktop)]

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

    const relaunched = makeWindow({ cls: 'whatsapp', caption: 'WhatsApp', x: 200, y: 200, width: 1280, height: 720, outputIndex: 0, desktop: 2 })
    rt.trackWindow(relaunched)

    assert.equal(relaunched.x, 2040)
    assert.equal(relaunched.y, 100)
    assert.equal(relaunched.width, 1000)
    assert.equal(relaunched.height, 700)
    assert.equal(relaunched.desktops[0].x11DesktopNumber, 2, 'desktop untouched')
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

    const app = groupOf(rt, 'chatty')
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
    assert.equal(groupOf(rt, 'q').session, null, 'q session ended at its deadline')
    assert.equal(rt.tickRef().running, false, 'timer stops once idle')
})

const savedApp = (rt, cls) => JSON.parse(rt.blobRef()).apps[cls]

test('a quick-tiled window saves its tile and the size it had before tiling', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'editor', caption: 'Editor', x: 300, y: 200, width: 1000, height: 700 })
    rt.trackWindow(w)
    w._tileTo(makeQuickRoot(outputs[0]).tiles[0])
    assert.equal(w.width, 960, 'window sits in the left half')

    w.emitClosed()
    const [s] = savedApp(rt, 'editor').w
    assert.deepEqual(s.t, { k: 'q', i: 0, g: { x: 0, y: 0, w: 0.5, h: 1 } })
    assert.deepEqual(s.f, { x: 300, y: 200, w: 1000, h: 700, o: { x: 300, y: 200, s: 'SER-1', n: 'DP-1' } })
    assert.deepEqual([s.x, s.y, s.w, s.h], [0, 0, 960, 1080], 'plain geometry is the tile rect, as before')
})

test('a custom-tiled window saves the tile path and its relative geometry', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'term', caption: 'Term', x: 50, y: 60, width: 640, height: 480 })
    rt.trackWindow(w)
    w._tileTo(makeCustomRoot(outputs[0]).tiles[1].tiles[1])

    w.emitClosed()
    const [s] = savedApp(rt, 'term').w
    assert.deepEqual(s.t, { k: 'c', p: [1, 1], g: { x: 0.4, y: 0.5, w: 0.6, h: 0.5 } })
    assert.equal(s.f.w, 640)
    assert.equal(s.f.h, 480)
})

test('a tile KWin drops while closing the window is still saved', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'editor', caption: 'Editor', x: 300, y: 200, width: 1000, height: 700 })
    rt.trackWindow(w)
    w._tileTo(makeQuickRoot(outputs[0]).tiles[1])
    w.tile = null
    w._emit('tileChanged')

    w.emitClosed()
    const [s] = savedApp(rt, 'editor').w
    assert.deepEqual(s.t, { k: 'q', i: 1, g: { x: 0.5, y: 0, w: 0.5, h: 1 } })
    assert.equal(s.f.w, 1000)
})

test('frames seen while tiled never replace the pre-tile size', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'editor', caption: 'Editor', x: 300, y: 200, width: 1000, height: 700 })
    rt.trackWindow(w)
    const quick = makeQuickRoot(outputs[0])
    w._tileTo(quick.tiles[0])
    w._tileTo(quick.tiles[4])
    quick.tiles[4].relativeGeometry = { x: 0, y: 0, width: 0.6, height: 0.5 } // the user resizes the tile

    w.emitClosed()
    const [s] = savedApp(rt, 'editor').w
    assert.deepEqual(s.t, { k: 'q', i: 4, g: { x: 0, y: 0, w: 0.6, h: 0.5 } })
    assert.deepEqual([s.f.w, s.f.h], [1000, 700])
})

test('a window dragged out of its tile saves as a plain floating window', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'editor', caption: 'Editor', x: 300, y: 200, width: 1000, height: 700 })
    rt.trackWindow(w)
    w._tileTo(makeQuickRoot(outputs[0]).tiles[0])
    w._dragOut(500, 300)
    assert.deepEqual([w.width, w.height], [1000, 700], 'KWin gave back the pre-tile size')

    w.emitClosed()
    const [s] = savedApp(rt, 'editor').w
    assert.equal(s.t, undefined)
    assert.equal(s.f, undefined)
    assert.deepEqual([s.x, s.y, s.w, s.h], [500, 300, 1000, 700])
})

test('maximized and fullscreen frames are not taken as the pre-tile size', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'editor', caption: 'Editor', x: 300, y: 200, width: 1000, height: 700 })
    rt.trackWindow(w)
    w._setFrame({ x: 0, y: 0, width: 1920, height: 1080 }) // maximized
    w.fullScreen = true
    w._setFrame({ x: 0, y: 0, width: 1920, height: 1081 })
    w.fullScreen = false
    w._setFrame({ x: 300, y: 200, width: 1000, height: 700 })
    w._setFrame({ x: 0, y: 0, width: 1920, height: 1080 })
    w._tileTo(makeQuickRoot(outputs[0]).tiles[1])

    w.emitClosed()
    assert.deepEqual([savedApp(rt, 'editor').w[0].f.w, savedApp(rt, 'editor').w[0].f.h], [1000, 700])
})

test('a window already tiled when the script starts saves its tile without a pre-tile size', () => {
    const existing = makeWindow({ cls: 'editor', caption: 'Editor', x: 0, y: 0, width: 960, height: 1080 })
    existing.tile = makeQuickRoot(outputs[0]).tiles[0]
    fakeWorkspace.stackingOrder = [existing]
    let rt
    try {
        rt = buildRuntime()
    } finally {
        fakeWorkspace.stackingOrder = []
    }

    existing.emitClosed()
    const [s] = savedApp(rt, 'editor').w
    assert.deepEqual(s.t, { k: 'q', i: 0, g: { x: 0, y: 0, w: 0.5, h: 1 } })
    assert.equal(s.f, undefined, 'unknown: the restore falls back to the tile rect')
})

test('a tile that cannot be identified saves the window as plain geometry', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'editor', caption: 'Editor', x: 300, y: 200, width: 1000, height: 700 })
    rt.trackWindow(w)
    const quick = makeQuickRoot(outputs[0])
    const stray = quick.tiles.pop() // detached from its parent: no index to save
    w._tileTo(stray)

    w.emitClosed()
    const [s] = savedApp(rt, 'editor').w
    assert.equal(s.t, undefined)
    assert.equal(s.w, 960)
})

test('shutdown saves tiles too and disconnects the geometry and tile handlers', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'editor', caption: 'Editor', x: 300, y: 200, width: 1000, height: 700 })
    rt.trackWindow(w)
    w._tileTo(makeCustomRoot(outputs[0]).tiles[0])
    assert.equal(w._connected('frameGeometryChanged'), 1)
    assert.equal(w._connected('tileChanged'), 1)

    rt.shutdown()
    assert.deepEqual(savedApp(rt, 'editor').w[0].t, { k: 'c', p: [0], g: { x: 0, y: 0, w: 0.4, h: 1 } })
    assert.equal(w._connected('frameGeometryChanged'), 0)
    assert.equal(w._connected('tileChanged'), 0)
})

// Saves a window tiled into `tile` from a floating 1000x700 at (300, 200) on DP-1.
function saveTiled(rt, cls, tile) {
    const w = makeWindow({ cls, caption: 'Doc', x: 300, y: 200, width: 1000, height: 700 })
    rt.trackWindow(w)
    w._tileTo(tile)
    w.emitClosed()
}

const reopen = (rt, cls, fields = {}) => {
    const w = makeWindow({ cls, caption: 'Doc', x: 40, y: 40, width: 960, height: 1080, ...fields })
    if (fields.active) {
        w.active = true
        fakeWorkspace.activeWindow = w
    }
    rt.trackWindow(w)
    return w
}

test('a custom-tiled window reopens in its tile, and a drag out gives back the pre-tile size', () => {
    const rt = buildRuntime()
    const layout = makeCustomRoot(outputs[0])
    fakeWorkspace._customRoots.set(outputs[0], layout)
    saveTiled(rt, 'doc', layout.tiles[1].tiles[0])

    const w = reopen(rt, 'doc')
    assert.equal(w.tile, layout.tiles[1].tiles[0], 'back in the same tile')
    assert.deepEqual(w._restoreGeometry, { x: 300, y: 200, width: 1000, height: 700 }, 'KWin holds the pre-tile geometry')
    assert.equal(rt.retriesRef().length, 1)
    rt.tick()
    assert.equal(rt.retriesRef().length, 0, 'the pre-tile geometry retry stops once the window is tiled')
    w._dragOut(600, 400)
    assert.deepEqual([w.x, w.y, w.width, w.height], [600, 400, 1000, 700])
})

test('a quick-tiled window reopens in its quick tile once it is active', () => {
    const rt = buildRuntime()
    saveTiled(rt, 'doc', makeQuickRoot(outputs[0]).tiles[5])

    const w = reopen(rt, 'doc', { active: true })
    assert.equal(w.tile, quickRootOf(outputs[0]).tiles[5], 'top-right quarter')
    assert.deepEqual(w._restoreGeometry, { x: 300, y: 200, width: 1000, height: 700 })
})

test('quick-tiling waits for the window to become active and never activates it', () => {
    const rt = buildRuntime()
    saveTiled(rt, 'doc', makeQuickRoot(outputs[0]).tiles[0])
    const other = makeWindow({ cls: 'other', caption: 'Other' })
    other._activate()

    const w = reopen(rt, 'doc')
    assert.equal(w.tile, null, 'not tiled while in the background')
    assert.deepEqual([w.x, w.y, w.width, w.height], [300, 200, 1000, 700], 'waits at its pre-tile geometry')
    assert.equal(fakeWorkspace.activeWindow, other, 'focus untouched')

    sleepTick(rt, 2000)
    w._activate()
    assert.equal(w.tile, quickRootOf(outputs[0]).tiles[0])
    assert.deepEqual(w._restoreGeometry, { x: 300, y: 200, width: 1000, height: 700 })
    assert.equal(w._connected('activeChanged'), 0, 'stops listening once tiled')
})

test('a window that becomes active after the restore window is not quick-tiled', () => {
    const rt = buildRuntime()
    saveTiled(rt, 'doc', makeQuickRoot(outputs[0]).tiles[0])

    const w = reopen(rt, 'doc')
    sleepTick(rt, Engine.RESTORE_TIMEOUT_MS + 1)
    w._activate()
    assert.equal(w.tile, null)
    assert.deepEqual([w.width, w.height], [1000, 700], 'keeps its floating size')
    assert.equal(w._connected('activeChanged'), 0)
})

test('a window the user moves before it is active is not quick-tiled', () => {
    const rt = buildRuntime()
    saveTiled(rt, 'doc', makeQuickRoot(outputs[0]).tiles[0])

    const w = reopen(rt, 'doc')
    w.emitMoveResizeStarted()
    w._activate()
    assert.equal(w.tile, null)
    assert.equal(w._connected('activeChanged'), 0)
})

test('a window already quick-tiled on the same screen lets a background window tile at once', () => {
    const rt = buildRuntime()
    saveTiled(rt, 'doc', makeQuickRoot(outputs[0]).tiles[1])
    const neighbour = makeWindow({ cls: 'other', caption: 'Other' })
    neighbour._tileTo(quickRootOf(outputs[0]).tiles[0])
    fakeWorkspace.stackingOrder = [neighbour]
    let w
    try {
        w = reopen(rt, 'doc')
    } finally {
        fakeWorkspace.stackingOrder = []
    }
    assert.equal(w.tile, quickRootOf(outputs[0]).tiles[1], 'tiled without being active')
    assert.equal(w._restoreGeometry.width, 1000)
})

test('a quick-tiled neighbour on another desktop or screen is not used', () => {
    const rt = buildRuntime()
    saveTiled(rt, 'doc', makeQuickRoot(outputs[0]).tiles[1])
    const elsewhere = makeWindow({ cls: 'a', caption: 'A', desktop: 2 })
    elsewhere._tileTo(makeQuickRoot(outputs[0]).tiles[0])
    const otherScreen = makeWindow({ cls: 'b', caption: 'B', outputIndex: 1 })
    otherScreen._tileTo(makeQuickRoot(outputs[1]).tiles[0])
    fakeWorkspace.stackingOrder = [elsewhere, otherScreen]
    let w
    try {
        w = reopen(rt, 'doc')
    } finally {
        fakeWorkspace.stackingOrder = []
    }
    assert.equal(w.tile, null, 'waits for activation instead')
})

test('after a layout edit the custom tile is found again by its geometry', () => {
    const rt = buildRuntime()
    saveTiled(rt, 'doc', makeCustomRoot(outputs[0]).tiles[1].tiles[1])
    // Same right-bottom tile, but the left column is now split, so the path moved.
    const edited = makeTile(outputs[0], null, { x: 0, y: 0, width: 1, height: 1 }, true)
    const right = makeTile(outputs[0], edited, { x: 0.4, y: 0, width: 0.6, height: 1 }, true)
    const left = makeTile(outputs[0], edited, { x: 0, y: 0, width: 0.4, height: 1 }, true)
    makeTile(outputs[0], left, { x: 0, y: 0, width: 0.4, height: 0.5 }, true)
    makeTile(outputs[0], left, { x: 0, y: 0.5, width: 0.4, height: 0.5 }, true)
    makeTile(outputs[0], right, { x: 0.4, y: 0, width: 0.6, height: 0.5 }, true)
    const target = makeTile(outputs[0], right, { x: 0.4, y: 0.5, width: 0.6, height: 0.5 }, true)
    fakeWorkspace._customRoots.set(outputs[0], edited)

    const w = reopen(rt, 'doc')
    assert.equal(w.tile, target)
})

test('a custom tile that no longer exists restores plain geometry at the tile rect', () => {
    const rt = buildRuntime()
    saveTiled(rt, 'doc', makeCustomRoot(outputs[0]).tiles[0])
    const other = makeTile(outputs[0], null, { x: 0, y: 0, width: 1, height: 1 }, true)
    makeTile(outputs[0], other, { x: 0, y: 0, width: 0.5, height: 1 }, true)
    makeTile(outputs[0], other, { x: 0.5, y: 0, width: 0.5, height: 1 }, true)
    fakeWorkspace._customRoots.set(outputs[0], other)

    const w = reopen(rt, 'doc', { x: 500, y: 500, width: 640, height: 480 })
    assert.equal(w.tile, null)
    assert.deepEqual([w.x, w.y, w.width, w.height], [0, 0, 768, 1080], 'today\'s behaviour: the tile rect')
    assert.ok(rt.getLogs().some((l) => l.includes('saved tile is not in the current layout')))
})

test('with tile restore turned off, tiled saves reopen floating at the tile rect', () => {
    const rt = buildRuntime('{}', { restoreTiles: false })
    saveTiled(rt, 'doc', makeQuickRoot(outputs[0]).tiles[1])
    assert.ok(savedApp(rt, 'doc').w[0].t, 'tiles are still saved, so turning it back on works at once')

    const w = reopen(rt, 'doc', { active: true, x: 10, y: 10, width: 640, height: 480 })
    assert.equal(w.tile, null)
    assert.deepEqual([w.x, w.y, w.width, w.height], [960, 0, 960, 1080])
})

test('a tiled save whose screen is missing restores plain geometry, then tiles once the screen is back', () => {
    const rt = buildRuntime()
    const w0 = makeWindow({ cls: 'doc', caption: 'Doc', x: 2100, y: 100, width: 900, height: 600, outputIndex: 1 })
    rt.trackWindow(w0)
    const layout = makeCustomRoot(outputs[1])
    w0._tileTo(layout.tiles[0])
    w0.emitClosed()
    fakeWorkspace._customRoots.set(outputs[1], layout)

    fakeWorkspace.screens = [outputs[0]]
    let w
    try {
        w = reopen(rt, 'doc', { width: 640, height: 480 })
        assert.equal(w.tile, null, 'not tiled on the fallback screen')
        fakeWorkspace.screens = [outputs[0], outputs[1]]
        w._output = outputs[1]
        rt.reapplyProvisional()
    } finally {
        fakeWorkspace.screens = [outputs[0], outputs[1]]
    }
    assert.equal(w.tile, layout.tiles[0], 'tiled once its own screen showed up')
    assert.equal(w._restoreGeometry.width, 900)
})

test('a tiled save without a pre-tile size goes to the tile rect, then into the tile', () => {
    const existing = makeWindow({ cls: 'doc', caption: 'Doc', x: 0, y: 0, width: 960, height: 1080 })
    existing.tile = makeQuickRoot(outputs[0]).tiles[0]
    fakeWorkspace.stackingOrder = [existing]
    let rt
    try {
        rt = buildRuntime()
    } finally {
        fakeWorkspace.stackingOrder = []
    }
    existing.emitClosed()

    const w = reopen(rt, 'doc', { active: true, x: 300, y: 300, width: 640, height: 480 })
    assert.equal(w.tile, quickRootOf(outputs[0]).tiles[0])
    assert.deepEqual(w._restoreGeometry, { x: 0, y: 0, width: 960, height: 1080 })
})

test('fixed-size windows are not tiled', () => {
    const rt = buildRuntime()
    saveTiled(rt, 'doc', makeQuickRoot(outputs[0]).tiles[0])
    const w = makeWindow({ cls: 'doc', caption: 'Doc', x: 40, y: 40, width: 1000, height: 700 })
    w.resizeable = false
    w.active = true
    fakeWorkspace.activeWindow = w
    rt.trackWindow(w)
    assert.equal(w.tile, null)
    assert.deepEqual([w.x, w.y], [0, 0], 'position restored as before')
})

test('closing a window that waits for its quick tile stops listening for activation', () => {
    const rt = buildRuntime()
    saveTiled(rt, 'doc', makeQuickRoot(outputs[0]).tiles[0])
    const w = reopen(rt, 'doc')
    assert.equal(w._connected('activeChanged'), 1)
    w.emitClosed()
    assert.equal(w._connected('activeChanged'), 0)
})

test('a pre-tile geometry on a missing screen still tiles, starting from the tile rect', () => {
    const rt = buildRuntime()
    const w0 = makeWindow({ cls: 'doc', caption: 'Doc', x: 2100, y: 100, width: 900, height: 600, outputIndex: 1 })
    rt.trackWindow(w0)
    w0._output = outputs[0] // dragged over to DP-1 and into its left quick tile
    w0._tileTo(makeQuickRoot(outputs[0]).tiles[0])
    w0.emitClosed()
    assert.equal(savedApp(rt, 'doc').w[0].f.o.n, 'HDMI-A-1')

    fakeWorkspace.screens = [outputs[0]]
    let w
    try {
        w = reopen(rt, 'doc', { active: true, width: 640, height: 480 })
    } finally {
        fakeWorkspace.screens = [outputs[0], outputs[1]]
    }
    assert.equal(w.tile, quickRootOf(outputs[0]).tiles[0])
    assert.deepEqual(w._restoreGeometry, { x: 0, y: 0, width: 960, height: 1080 })
})

test('a window that changed screens while waiting is not quick-tiled on the wrong one', () => {
    const rt = buildRuntime()
    saveTiled(rt, 'doc', makeQuickRoot(outputs[0]).tiles[0])
    const w = reopen(rt, 'doc')
    w._output = outputs[1] // a window rule or the app moved it
    w._activate()
    assert.equal(w.tile, null)
    w._output = outputs[0]
    w._setFrame({ x: 310, y: 200, width: 1000, height: 700 })
    assert.equal(w.tile, quickRootOf(outputs[0]).tiles[0], 'tiles once it is back on its screen')
})

test('on Wayland a window opening on another screen is quick-tiled once it reaches its own', () => {
    const rt = buildRuntime()
    saveTiled(rt, 'doc', makeQuickRoot(outputs[0]).tiles[1])
    const w = makeWindow({ cls: 'doc', caption: 'Doc', x: 2100, y: 100, width: 640, height: 480, outputIndex: 1 })
    w._async = true
    w._activate()
    rt.trackWindow(w)
    assert.equal(w.tile, null, 'still on HDMI-A-1 until the frame arrives')

    w._commit(outputs[0])
    assert.equal(w.tile, quickRootOf(outputs[0]).tiles[1])
    assert.deepEqual(w._restoreGeometry, { x: 300, y: 200, width: 1000, height: 700 })
    assert.equal(w._connected('activeChanged'), 0)
})

test('a saved custom tile that was split since is not used as a tile', () => {
    const rt = buildRuntime()
    saveTiled(rt, 'doc', makeCustomRoot(outputs[0]).tiles[0])
    const edited = makeCustomRoot(outputs[0])
    makeTile(outputs[0], edited.tiles[0], { x: 0, y: 0, width: 0.4, height: 0.5 }, true)
    makeTile(outputs[0], edited.tiles[0], { x: 0, y: 0.5, width: 0.4, height: 0.5 }, true)
    fakeWorkspace._customRoots.set(outputs[0], edited)

    const w = reopen(rt, 'doc', { x: 500, y: 500, width: 640, height: 480 })
    assert.equal(w.tile, null)
    assert.equal(w.width, 768, 'plain restore at the tile rect')
})

test('on Wayland the pre-tile geometry is kept although its frame arrives after tiling', () => {
    const rt = buildRuntime()
    const layout = makeCustomRoot(outputs[0])
    fakeWorkspace._customRoots.set(outputs[0], layout)
    saveTiled(rt, 'doc', layout.tiles[0])

    const w = makeWindow({ cls: 'doc', caption: 'Doc', x: 40, y: 40, width: 640, height: 480 })
    w._async = true
    rt.trackWindow(w)
    assert.equal(w.tile, layout.tiles[0])
    assert.deepEqual(w._restoreGeometry, { x: 300, y: 200, width: 1000, height: 700 })

    w.emitClosed()
    const [s] = savedApp(rt, 'doc').w
    assert.deepEqual(s.f, { x: 300, y: 200, w: 1000, h: 700, o: { x: 300, y: 200, s: 'SER-1', n: 'DP-1' } }, 'not the app\'s default placement')
})

test('a resized quick tile is saved at its size although KWin resets the split at close', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'mon', caption: 'Mon', x: 300, y: 200, width: 1000, height: 700 })
    rt.trackWindow(w)
    const root = quickRootOf(outputs[0])
    w._tileTo(root.tiles[0])
    root.tiles[0].relativeGeometry = { x: 0, y: 0, width: 0.68, height: 1 } // the user drags the tile edge
    assert.equal(w.width, 1306)

    w.emitClosed()
    assert.equal(root.tiles[0].relativeGeometry.width, 0.5, 'KWin reset the split before the script saw the close')
    assert.deepEqual(savedApp(rt, 'mon').w[0].t, { k: 'q', i: 0, g: { x: 0, y: 0, w: 0.68, h: 1 } })
})

test('a resized quick tile reopens at its size, with the pre-tile size kept for a drag out', () => {
    const rt = buildRuntime()
    const w0 = makeWindow({ cls: 'mon', caption: 'Mon', x: 300, y: 200, width: 1000, height: 700 })
    rt.trackWindow(w0)
    const root = quickRootOf(outputs[0])
    w0._tileTo(root.tiles[0])
    root.tiles[0].relativeGeometry = { x: 0, y: 0, width: 0.68, height: 1 }
    w0.emitClosed()

    const w = reopen(rt, 'mon', { caption: 'Mon', active: true })
    assert.equal(w.tile, root.tiles[0])
    assert.deepEqual([w.x, w.y, w.width, w.height], [0, 0, 1306, 1080], 'the resized tile, not a half')
    assert.deepEqual(w._restoreGeometry, { x: 300, y: 200, width: 1000, height: 700 })
    w._dragOut(500, 300)
    assert.deepEqual([w.width, w.height], [1000, 700])
})

test('the saved split comes back even when a neighbour shares the quick layout', () => {
    const rt = buildRuntime()
    const root = quickRootOf(outputs[0])
    const neighbour = makeWindow({ cls: 'term', caption: 'Term' })
    neighbour._tileTo(root.tiles[1])
    const w0 = makeWindow({ cls: 'mon', caption: 'Mon', x: 300, y: 200, width: 1000, height: 700 })
    rt.trackWindow(w0)
    w0._tileTo(root.tiles[0])
    root.tiles[0].relativeGeometry = { x: 0, y: 0, width: 0.68, height: 1 }
    w0.emitClosed()
    root.tiles[1].relativeGeometry = { x: 0.4932, y: 0, width: 0.5068, height: 1 } // later, the neighbour is resized
    fakeWorkspace.stackingOrder = [neighbour]
    let w
    try {
        w = reopen(rt, 'mon', { caption: 'Mon' })
    } finally {
        fakeWorkspace.stackingOrder = []
    }
    assert.equal(w.tile, root.tiles[0], 'tiled through the neighbour, without focus')
    assert.equal(w.width, 1306)
    assert.equal(neighbour.x, 1306, 'the neighbour follows the shared split, as with a manual resize')
    assert.equal(neighbour.width, 614)
})

test('saves from before quick tile sizes were recorded still restore into the tile', () => {
    const blob = JSON.stringify({ version: 2, apps: { mon: { t: 1000000000, d: { 'desk-uuid-1': { t: 1000000000, w: [
        { c: 'Mon', x: 0, y: 0, w: 960, h: 1080, o: { x: 0, y: 0, s: 'SER-1', n: 'DP-1' }, t: { k: 'q', i: 1 }, f: { x: 300, y: 200, w: 1000, h: 700, o: null } }
    ] } } } } })
    const rt = buildRuntime(blob)
    const w = reopen(rt, 'mon', { caption: 'Mon', active: true })
    assert.equal(w.tile, quickRootOf(outputs[0]).tiles[1])
    assert.equal(w.width, 960)
})

// Saves one window of `cls` closed on `desktop` at the given geometry.
function saveOn(rt, cls, desktop, geometry) {
    const w = makeWindow({ cls, caption: 'Doc', desktop, ...geometry })
    rt.trackWindow(w)
    w.emitClosed()
}

test('an app open on one desktop does not stop a restore on another', () => {
    const rt = buildRuntime()
    saveOn(rt, 'bazaar', 2, { x: 500, y: 300, width: 900, height: 700 })
    const elsewhere = makeWindow({ cls: 'bazaar', caption: 'Doc', desktop: 1 })
    rt.trackWindow(elsewhere)

    const w = makeWindow({ cls: 'bazaar', caption: 'Doc', desktop: 2, x: 0, y: 0, width: 640, height: 480 })
    rt.trackWindow(w)
    assert.deepEqual([w.x, w.y, w.width, w.height], [500, 300, 900, 700])
    assert.ok(rt.getLogs().some((l) => l.includes('bazaar (desktop 2): restored window')))
})

test('each desktop restores its own layout', () => {
    const rt = buildRuntime()
    saveOn(rt, 'konsole', 1, { x: 10, y: 10, width: 800, height: 600 })
    saveOn(rt, 'konsole', 2, { x: 900, y: 300, width: 700, height: 500 })

    const one = makeWindow({ cls: 'konsole', caption: 'Doc', desktop: 1, x: 0, y: 0, width: 640, height: 480 })
    rt.trackWindow(one)
    const two = makeWindow({ cls: 'konsole', caption: 'Doc', desktop: 2, x: 0, y: 0, width: 640, height: 480 })
    rt.trackWindow(two)
    assert.deepEqual([one.x, one.width], [10, 800])
    assert.deepEqual([two.x, two.width], [900, 700])
})

test('a desktop without a save of its own restores nothing', () => {
    const rt = buildRuntime()
    saveOn(rt, 'konsole', 1, { x: 10, y: 10, width: 800, height: 600 })
    const w = makeWindow({ cls: 'konsole', caption: 'Doc', desktop: 3, x: 0, y: 0, width: 640, height: 480 })
    rt.trackWindow(w)
    assert.equal(w._geometryWrites, 0)
})

test('data from before per-desktop layouts restores nothing, and is kept for older versions', () => {
    const blob = JSON.stringify({ version: 2, apps: { konsole: { t: 1000000000, w: [{ c: 'Doc', x: 10, y: 10, w: 800, h: 600, o: null }] } } })
    const rt = buildRuntime(blob)
    const w = makeWindow({ cls: 'konsole', caption: 'Doc', x: 0, y: 0, width: 640, height: 480 })
    rt.trackWindow(w)
    assert.equal(w._geometryWrites, 0)
    rt.persist()
    assert.equal(JSON.parse(rt.blobRef()).apps.konsole.w[0].x, 10)
})

test('closing an app on one desktop saves that desktop only, while it stays open elsewhere', () => {
    const rt = buildRuntime()
    saveOn(rt, 'konsole', 1, { x: 10, y: 10, width: 800, height: 600 })
    const stays = makeWindow({ cls: 'konsole', caption: 'Doc', desktop: 1, x: 10, y: 10, width: 800, height: 600 })
    rt.trackWindow(stays)
    const closes = makeWindow({ cls: 'konsole', caption: 'Doc', desktop: 2, x: 700, y: 50, width: 900, height: 500 })
    rt.trackWindow(closes)

    closes.emitClosed()
    const app = savedApp(rt, 'konsole')
    assert.equal(app.d['desk-uuid-2'].w[0].x, 700)
    assert.equal(app.d['desk-uuid-1'].w[0].x, 10, 'desktop 1 keeps its layout')
    assert.ok(rt.getLogs().some((l) => l.includes('konsole (desktop 2) closed, saved 1 window(s)')))
})

test('windows on all desktops share one layout of their own', () => {
    const rt = buildRuntime()
    saveOn(rt, 'player', 'all', { x: 1500, y: 800, width: 400, height: 250 })
    assert.deepEqual(Object.keys(savedApp(rt, 'player').d), ['*'])

    const onOne = makeWindow({ cls: 'player', caption: 'Doc', desktop: 1, x: 0, y: 0, width: 640, height: 480 })
    rt.trackWindow(onOne)
    assert.equal(onOne._geometryWrites, 0, 'not the layout of desktop 1')
    onOne.emitClosed()
    const everywhere = makeWindow({ cls: 'player', caption: 'Doc', desktop: 'all', x: 0, y: 0, width: 640, height: 480 })
    rt.trackWindow(everywhere)
    assert.deepEqual([everywhere.x, everywhere.width], [1500, 400])
    assert.ok(rt.getLogs().some((l) => l.includes('player (all desktops)')))
})

test('a window moved to another desktop is saved there; leaving is not a close', () => {
    const rt = buildRuntime()
    saveOn(rt, 'konsole', 1, { x: 10, y: 10, width: 800, height: 600 })
    const w = makeWindow({ cls: 'konsole', caption: 'Doc', desktop: 1, x: 10, y: 10, width: 800, height: 600 })
    rt.trackWindow(w)
    w._moveToDesktop(3)
    assert.equal(groupOf(rt, 'konsole', 1), undefined, 'desktop 1 has no open windows now')
    assert.equal(savedApp(rt, 'konsole').d['desk-uuid-3'], undefined, 'nothing saved yet')
    assert.ok(groupOf(rt, 'konsole', 3).settled, 'the app now runs on desktop 3')

    w._setFrame({ x: 400, y: 300, width: 700, height: 500 })
    w.emitClosed()
    const app = savedApp(rt, 'konsole')
    assert.equal(app.d['desk-uuid-3'].w[0].x, 400)
    assert.equal(app.d['desk-uuid-1'].w[0].x, 10, 'desktop 1 kept its layout')
    assert.equal(w._connected('desktopsChanged'), 0)
})

test('a window moved to another desktop before its restore is not restored', () => {
    const rt = buildRuntime()
    const a = makeWindow({ cls: 'konsole', caption: 'One', x: 10, y: 10, width: 800, height: 600 })
    const b = makeWindow({ cls: 'konsole', caption: 'Two', x: 900, y: 10, width: 700, height: 500 })
    rt.trackWindow(a)
    rt.trackWindow(b)
    closeAll(a, b)

    const w = makeWindow({ cls: 'konsole', caption: 'Something else', x: 0, y: 0, width: 640, height: 480 })
    rt.trackWindow(w)
    assert.equal(w._geometryWrites, 0, 'ambiguous: waits for the deadline')
    w._moveToDesktop(2)
    sleepTick(rt, Engine.RESTORE_TIMEOUT_MS + 1)
    rt.tick()
    assert.equal(w._geometryWrites, 0)
    assert.equal(rt.tickRef().running, false)
})

test('a window opening on another desktop is tiled in that desktop\'s layout', () => {
    const rt = buildRuntime()
    const layout2 = makeCustomRoot(outputs[0])
    fakeWorkspace._customRoots.set('DP-1/desk-uuid-2', layout2)
    fakeWorkspace._customRoots.set(outputs[0], makeCustomRoot(outputs[0])) // the current desktop's
    const w0 = makeWindow({ cls: 'doc', caption: 'Doc', desktop: 2, x: 300, y: 200, width: 1000, height: 700 })
    rt.trackWindow(w0)
    w0._tileTo(layout2.tiles[0])
    w0.emitClosed()

    const w = makeWindow({ cls: 'doc', caption: 'Doc', desktop: 2, x: 40, y: 40, width: 640, height: 480 })
    rt.trackWindow(w)
    assert.equal(w.tile, layout2.tiles[0])
})

test('a quick-tiled neighbour on the window\'s own desktop is used, whatever desktop is current', () => {
    const rt = buildRuntime()
    const root2 = makeQuickRoot(outputs[0])
    saveOn(rt, 'doc', 2, { x: 300, y: 200, width: 1000, height: 700 })
    const saved = savedApp(rt, 'doc')
    assert.ok(saved)
    const w0 = makeWindow({ cls: 'mon', caption: 'Mon', desktop: 2, x: 300, y: 200, width: 1000, height: 700 })
    rt.trackWindow(w0)
    w0._tileTo(root2.tiles[1])
    w0.emitClosed()
    const neighbour = makeWindow({ cls: 'other', caption: 'Other', desktop: 2 })
    neighbour._tileTo(root2.tiles[0])
    fakeWorkspace.stackingOrder = [neighbour]
    let w
    try {
        w = makeWindow({ cls: 'mon', caption: 'Mon', desktop: 2, x: 40, y: 40, width: 640, height: 480 })
        rt.trackWindow(w)
    } finally {
        fakeWorkspace.stackingOrder = []
    }
    assert.equal(w.tile, root2.tiles[1], 'desktop 1 is current, but the window lives on desktop 2')
})

test('a tile KWin refuses leaves the window floating at its pre-tile geometry', () => {
    const rt = buildRuntime()
    const layout = makeCustomRoot(outputs[0])
    fakeWorkspace._customRoots.set(outputs[0], layout)
    saveTiled(rt, 'doc', layout.tiles[0])
    layout.tiles[0].manage = () => false

    const w = reopen(rt, 'doc')
    assert.equal(w.tile, null)
    assert.deepEqual([w.x, w.y, w.width, w.height], [300, 200, 1000, 700])
    assert.ok(rt.getLogs().some((l) => l.includes('KWin did not accept the window into its tile')))
    assert.ok(!rt.getLogs().some((l) => l.includes('put the window back into its tile')))
})

test('a window restored into a quick tile that holds another window takes the tile\'s size', () => {
    const rt = buildRuntime()
    const root = quickRootOf(outputs[0])
    const w0 = makeWindow({ cls: 'bazaar', caption: 'Doc', x: 300, y: 200, width: 1000, height: 700 })
    rt.trackWindow(w0)
    w0._tileTo(root.tiles[0])
    root.tiles[0].relativeGeometry = { x: 0, y: 0, width: 0.6, height: 1 }
    w0.emitClosed()

    const mon = makeWindow({ cls: 'mon', caption: 'Mon' })
    mon._tileTo(root.tiles[0])
    root.tiles[0].relativeGeometry = { x: 0, y: 0, width: 0.41, height: 1 }
    fakeWorkspace.stackingOrder = [mon]
    let w
    try {
        w = reopen(rt, 'bazaar')
    } finally {
        fakeWorkspace.stackingOrder = []
    }
    assert.equal(w.tile, root.tiles[0])
    assert.equal(root.tiles[0].relativeGeometry.width, 0.41, 'the tile keeps its size')
    assert.equal(mon.width, 787, 'the window already in the tile is not resized')
    assert.equal(w.width, 787)
})

test('shutdown saves each desktop\'s layout separately', () => {
    const rt = buildRuntime()
    const one = makeWindow({ cls: 'konsole', caption: 'Doc', desktop: 1, x: 10, y: 10, width: 800, height: 600 })
    const two = makeWindow({ cls: 'konsole', caption: 'Doc', desktop: 2, x: 900, y: 10, width: 700, height: 500 })
    rt.trackWindow(one)
    rt.trackWindow(two)
    rt.shutdown()
    const app = savedApp(rt, 'konsole')
    assert.equal(app.d['desk-uuid-1'].w[0].x, 10)
    assert.equal(app.d['desk-uuid-2'].w[0].x, 900)
})

test('a window moved away during a restore that goes on for other windows is not restored', () => {
    const rt = buildRuntime()
    const a = makeWindow({ cls: 'konsole', caption: 'One', x: 10, y: 10, width: 800, height: 600 })
    const b = makeWindow({ cls: 'konsole', caption: 'Two', x: 900, y: 10, width: 700, height: 500 })
    const c = makeWindow({ cls: 'konsole', caption: 'Three', x: 300, y: 500, width: 600, height: 400 })
    rt.trackWindow(a)
    rt.trackWindow(b)
    rt.trackWindow(c)
    closeAll(a, b, c)

    // Caption matches without the size: not decisive, so both wait for the deadline.
    const stays = makeWindow({ cls: 'konsole', caption: 'One', x: 0, y: 0, width: 640, height: 480 })
    const moves = makeWindow({ cls: 'konsole', caption: 'Two', x: 0, y: 0, width: 640, height: 480 })
    rt.trackWindow(stays)
    rt.trackWindow(moves)
    assert.equal(stays._geometryWrites + moves._geometryWrites, 0, 'both waiting')
    moves._moveToDesktop(2)
    sleepTick(rt, Engine.RESTORE_TIMEOUT_MS + 1)
    rt.tick()
    assert.ok(stays._geometryWrites > 0, 'the window that stayed got a save at the deadline')
    assert.equal(moves._geometryWrites, 0, 'the moved window was left alone')
})

test('a window closed maximized saves its floating geometry, not the maximized frame', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'app', caption: 'App', x: 300, y: 200, width: 1000, height: 650 })
    rt.trackWindow(w)
    w.maximizeMode = 3
    w._setFrame({ x: 0, y: 0, width: 1920, height: 1080 })
    w.emitClosed()
    const [s] = savedApp(rt, 'app').w
    assert.deepEqual([s.x, s.y, s.w, s.h], [300, 200, 1000, 650])
})

test('a window maximized all along saves nothing, so the previous layout stays', () => {
    const rt = buildRuntime()
    saveOn(rt, 'app', 1, { x: 40, y: 50, width: 900, height: 600 })
    const w = makeWindow({ cls: 'app', caption: 'Other', x: 0, y: 0, width: 1920, height: 1080 })
    w.maximizeMode = 3
    rt.trackWindow(w)
    w.emitClosed()
    assert.equal(savedApp(rt, 'app').d['desk-uuid-1'].w[0].x, 40)
})

// KWin moves the windows of a monitor that goes away to another one first, then reports it.
function unplug(window, to, rect) {
    fakeWorkspace.screens = [outputs[0]]
    window._output = to
    window._setFrame(rect)
}

test('a window KWin moved off an unplugged monitor is saved where it was on that monitor', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'app', caption: 'App', x: 2100, y: 150, width: 900, height: 600, outputIndex: 1 })
    rt.trackWindow(w)
    try {
        unplug(w, outputs[0], { x: 180, y: 150, width: 900, height: 600 })
        w.emitClosed()
    } finally {
        fakeWorkspace.screens = [outputs[0], outputs[1]]
    }
    const [s] = savedApp(rt, 'app').w
    assert.deepEqual([s.x, s.y, s.w, s.h, s.o.n], [2100, 150, 900, 600, 'HDMI-A-1'])
})

test('once KWin moves it back to its monitor, the window is tracked as usual again', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'app', caption: 'App', x: 2100, y: 150, width: 900, height: 600, outputIndex: 1 })
    rt.trackWindow(w)
    try {
        unplug(w, outputs[0], { x: 180, y: 150, width: 900, height: 600 })
    } finally {
        fakeWorkspace.screens = [outputs[0], outputs[1]]
    }
    w._output = outputs[1]
    w._setFrame({ x: 2100, y: 150, width: 900, height: 600 })
    w._setFrame({ x: 2200, y: 250, width: 800, height: 500 })
    w.emitClosed()
    const [s] = savedApp(rt, 'app').w
    assert.deepEqual([s.x, s.y, s.w, s.h], [2200, 250, 800, 500])
})

test('a window the user moves after its monitor went away is saved where the user put it', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'app', caption: 'App', x: 2100, y: 150, width: 900, height: 600, outputIndex: 1 })
    rt.trackWindow(w)
    try {
        unplug(w, outputs[0], { x: 180, y: 150, width: 900, height: 600 })
        w.emitMoveResizeStarted()
        w._setFrame({ x: 400, y: 300, width: 900, height: 600 })
        w.emitClosed()
    } finally {
        fakeWorkspace.screens = [outputs[0], outputs[1]]
    }
    const [s] = savedApp(rt, 'app').w
    assert.deepEqual([s.x, s.y, s.o.n], [400, 300, 'DP-1'])
})

test('a window placed on a fallback screen keeps its saved monitor when it closes there', () => {
    const rt = buildRuntime()
    saveOn(rt, 'app', 1, { x: 2100, y: 150, width: 900, height: 600, outputIndex: 1 })
    fakeWorkspace.screens = [outputs[0]]
    try {
        const w = makeWindow({ cls: 'app', caption: 'Doc', x: 0, y: 0, width: 640, height: 480 })
        rt.trackWindow(w)
        assert.equal(w._geometryWrites, 1, 'placed on the fallback screen')
        w.emitClosed()
    } finally {
        fakeWorkspace.screens = [outputs[0], outputs[1]]
    }
    const [s] = savedApp(rt, 'app').d['desk-uuid-1'].w
    assert.deepEqual([s.x, s.y, s.o.n], [2100, 150, 'HDMI-A-1'], 'not the fallback spot')
})

test('a monitor that comes back under another connector name counts as the window\'s own', () => {
    const rt = buildRuntime()
    const w = makeWindow({ cls: 'app', caption: 'App', x: 2100, y: 150, width: 900, height: 600, outputIndex: 1 })
    rt.trackWindow(w)
    const renamed = makeOutput('HDMI-A-2', 'SER-2', 2000, 0, 1280, 1024)
    try {
        unplug(w, outputs[0], { x: 180, y: 150, width: 900, height: 600 })
        fakeWorkspace.screens = [outputs[0], renamed]
        w._output = renamed
        w._setFrame({ x: 2100, y: 150, width: 900, height: 600 })
        w._setFrame({ x: 2300, y: 250, width: 800, height: 500 })
        w.emitClosed()
    } finally {
        fakeWorkspace.screens = [outputs[0], outputs[1]]
    }
    const [s] = savedApp(rt, 'app').w
    assert.deepEqual([s.x, s.y, s.o.n], [2300, 250, 'HDMI-A-2'])
})
