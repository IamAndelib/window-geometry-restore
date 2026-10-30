.pragma library

// Persisted key legend (compact on purpose - the blob lives in a single KConfig entry):
//   app:  { t: lastAccessTime, w: [saves], d: { desktopKey: { t, w: [saves] } } }
//         d holds one layout per virtual desktop (key: the desktop's id, or '*' for windows on
//         all or several desktops); restores read only d. w is the latest layout from any
//         desktop, kept so that versions without d still work.
//   save: { c: caption, x: globalX, y: globalY, w: width, h: height,
//           o: { x, y, s: outputSerial, n: outputName }  output-relative position,
//           t: tile (only when tiled at close):
//              { k: 'q', i: quickTileIndex, g: { x, y, w, h } }  KWin's order: L, R, T, B, TL, TR, BL, BR
//              { k: 'c', p: [childIndexes], g: { x, y, w, h } }  custom tile, relativeGeometry
//           f: { x, y, w, h, o }  pre-tile (floating) geometry, same shape as the save's own }
//   Only geometry (and the tile a window sat in) is saved and restored; everything
//   else is left to KWin.
//   Runtime save objects use the long names below and are never mutated.
//   v1 blobs (which also stored desktop/activities/state flags) decode fine - those
//   fields are simply ignored.

var SCHEMA_VERSION = 2
var CAPTION_FALLBACK = 80
var BURST_MS = 1500
var RESTORE_TIMEOUT_MS = 10000
var RETRY_MAX_AGE_MS = 10000
var MAX_GEOMETRY_TRIES = 3
var TICK_MS = 250
var MAX_BUFFER = 64
var EXPIRY_MS = 30 * 24 * 60 * 60 * 1000
var MAX_APPS = 500
var MAX_DESKTOP_KEY = 64
// KWin creates the quick tiles in this order; the actions quick-tile the active window.
var QUICK_TILE_ACTIONS = [
    'slotWindowQuickTileLeft', 'slotWindowQuickTileRight', 'slotWindowQuickTileTop', 'slotWindowQuickTileBottom',
    'slotWindowQuickTileTopLeft', 'slotWindowQuickTileTopRight', 'slotWindowQuickTileBottomLeft', 'slotWindowQuickTileBottomRight'
]
var QUICK_TILES = QUICK_TILE_ACTIONS.length
var TILE_TOLERANCE = 0.01
var MAX_TILE_DEPTH = 32

function numberOr(value, fallback) {
    var n = typeof value === 'number' ? value : parseFloat(value)
    return isFinite(n) ? n : fallback
}

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseList(text) {
    var parsed = { exact: [], patterns: [] }
    if (!text) return parsed
    var lines = String(text).split(/\r?\n/)
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim().toLowerCase()
        if (!line) continue
        if (line.indexOf('*') === -1) {
            parsed.exact.push(line)
        } else {
            var parts = line.split('*')
            for (var j = 0; j < parts.length; j++) parts[j] = escapeRegExp(parts[j])
            parsed.patterns.push(new RegExp('^' + parts.join('.*') + '$'))
        }
    }
    return parsed
}

// Case-insensitive: KWin lowercases X11 classes, Wayland app ids keep their case.
function isListed(name, parsed) {
    if (!name) return false
    name = String(name).toLowerCase()
    if (parsed.exact.indexOf(name) !== -1) return true
    for (var i = 0; i < parsed.patterns.length; i++)
        if (parsed.patterns[i].test(name)) return true
    return false
}

function captionScore(a, b) {
    if (a === b) return 100
    if (!a || !b) return 0
    a = String(a).replace(/\d+/g, '')
    b = String(b).replace(/\d+/g, '')
    if (a === b) return 100
    if (!a.length || !b.length) return 0
    var lenA = a.length
    var lenB = b.length
    var min = Math.min(lenA, lenB)
    var max = Math.max(lenA, lenB)
    var forward = 0
    var reverse = 0
    for (var i = 0; i < min; i++) {
        if (a[i] === b[i]) forward++
        if (a[lenA - 1 - i] === b[lenB - 1 - i]) reverse++
    }
    return Math.max(Math.min((Math.max(forward, reverse) * 100 / max), 100), 0)
}

// Ranking shared by single-window matching and the deadline sweep:
// lower tier first, then more matching dimensions, then higher caption score.
function isBetterMatch(a, b) {
    if (a.tier !== b.tier) return a.tier < b.tier
    if (a.dims !== b.dims) return a.dims > b.dims
    return a.score > b.score
}

// Deterministic slot matching: pick the best save not yet taken for one live window.
// Tier 1: caption 100% (numbers stripped) and same size
// Tier 2: same size
// Tier 3: caption >= CAPTION_FALLBACK
// Tier 4: the only save left, whatever it is - the "app never remembers anything" case
// Returns { index, tier, dims, score } or null.
function bestMatch(saves, live, taken) {
    var best = null
    var free = -1
    var freeCount = 0
    for (var i = 0; i < saves.length; i++) {
        if (taken[i]) continue
        free = i
        freeCount++
        var s = saves[i]
        var dims = (s.width === live.width ? 1 : 0) + (s.height === live.height ? 1 : 0)
        var score = captionScore(s.caption, live.caption)
        var tier
        if (score === 100 && dims === 2) tier = 1
        else if (dims === 2) tier = 2
        else if (score >= CAPTION_FALLBACK) tier = 3
        else continue
        var candidate = { index: i, tier: tier, dims: dims, score: score }
        if (!best || isBetterMatch(candidate, best)) best = candidate
    }
    if (!best && freeCount === 1) {
        return { index: free, tier: 4, dims: 0, score: captionScore(saves[free].caption, live.caption) }
    }
    return best
}

function makeSave(fields) {
    return {
        caption: String(fields.caption || ''),
        x: fields.x,
        y: fields.y,
        width: fields.width,
        height: fields.height,
        output: fields.output || null,
        tile: fields.tile || null,
        free: fields.free || null
    }
}

function newState() {
    return { apps: {} }
}

function encodeOutput(output) {
    return output ? { x: output.x, y: output.y, s: output.serial, n: output.name } : null
}

function decodeOutput(o) {
    if (!isObject(o)) return null
    return {
        x: numberOr(o.x, 0),
        y: numberOr(o.y, 0),
        serial: typeof o.s === 'string' ? o.s : '',
        name: typeof o.n === 'string' ? o.n : ''
    }
}

// A rect with a usable size, or null.
function decodeGeometry(g) {
    if (!isObject(g)) return null
    var width = numberOr(g.w, NaN)
    var height = numberOr(g.h, NaN)
    if (!(width >= 1) || !(height >= 1)) return null
    return { x: numberOr(g.x, 0), y: numberOr(g.y, 0), width: width, height: height, output: decodeOutput(g.o) }
}

function isIndex(value, limit) {
    return typeof value === 'number' && value >= 0 && value < limit && Math.floor(value) === value
}

function encodeTile(tile) {
    var g = tile.rel ? { x: tile.rel.x, y: tile.rel.y, w: tile.rel.width, h: tile.rel.height } : undefined
    if (tile.kind === 'quick') return g ? { k: 'q', i: tile.index, g: g } : { k: 'q', i: tile.index }
    return { k: 'c', p: tile.path, g: g }
}

// A tile's relativeGeometry: fractions of the screen, inside it.
function decodeRel(g) {
    if (!isObject(g)) return null
    var rel = { x: g.x, y: g.y, width: g.w, height: g.h }
    for (var key in rel) {
        if (typeof rel[key] !== 'number' || !isFinite(rel[key])) return null
    }
    var slack = 0.001
    if (rel.x < 0 || rel.y < 0 || !(rel.width > 0) || !(rel.height > 0) ||
            rel.x + rel.width > 1 + slack || rel.y + rel.height > 1 + slack) return null
    return rel
}

// Anything unexpected is rejected: the save then restores as plain geometry. A quick tile
// without a usable size (older saves) still restores into the tile, at KWin's current size.
function decodeTile(t) {
    if (!isObject(t)) return null
    if (t.k === 'q') return isIndex(t.i, QUICK_TILES) ? { kind: 'quick', index: t.i, rel: decodeRel(t.g) } : null
    if (t.k !== 'c' || !Array.isArray(t.p) || t.p.length > MAX_TILE_DEPTH) return null
    for (var i = 0; i < t.p.length; i++) {
        if (!isIndex(t.p[i], Infinity)) return null
    }
    var rel = decodeRel(t.g)
    return rel ? { kind: 'custom', path: t.p.slice(), rel: rel } : null
}

function encodeSave(s) {
    var out = {
        c: s.caption,
        x: s.x,
        y: s.y,
        w: s.width,
        h: s.height,
        o: encodeOutput(s.output)
    }
    if (s.tile) out.t = encodeTile(s.tile)
    if (s.free) out.f = { x: s.free.x, y: s.free.y, w: s.free.width, h: s.free.height, o: encodeOutput(s.free.output) }
    return out
}

function decodeSave(s) {
    var geometry = decodeGeometry(s)
    if (!geometry) return null
    var tile = decodeTile(s.t)
    geometry.caption = typeof s.c === 'string' ? s.c : ''
    geometry.tile = tile
    geometry.free = tile ? decodeGeometry(s.f) : null
    return makeSave(geometry)
}

function decodeSaves(list) {
    var saves = []
    if (!Array.isArray(list)) return saves
    for (var i = 0; i < list.length; i++) {
        var save = decodeSave(list[i])
        if (save) saves.push(save)
    }
    return saves
}

function decodeDesktops(d, fallbackTime) {
    var desktops = {}
    if (!isObject(d)) return desktops
    for (var key in d) {
        if (!key || key.length > MAX_DESKTOP_KEY || !isObject(d[key])) continue
        var saves = decodeSaves(d[key].w)
        if (saves.length) desktops[key] = { lastAccess: numberOr(d[key].t, fallbackTime), saves: saves }
    }
    return desktops
}

function hasLayouts(app) {
    return !!app && ((Array.isArray(app.saves) && app.saves.length > 0) ||
                     (isObject(app.desktops) && Object.keys(app.desktops).length > 0))
}

// Never throws. Returns { state, error } - error is null when the blob was usable.
function decodeState(text) {
    var state = newState()
    if (!text || !String(text).trim()) return { state: state, error: null }
    var raw
    try {
        raw = JSON.parse(text)
    } catch (e) {
        return { state: state, error: String(e) }
    }
    if (!isObject(raw)) return { state: state, error: 'unexpected root' }
    if (raw.apps === undefined) return { state: state, error: null }
    var apps = raw.apps
    if (!isObject(apps)) return { state: state, error: 'unexpected apps' }
    for (var cls in apps) {
        var app = apps[cls]
        if (!isObject(app)) continue
        var lastAccess = numberOr(app.t, 0)
        var decoded = { lastAccess: lastAccess, saves: decodeSaves(app.w), desktops: decodeDesktops(app.d, lastAccess) }
        if (hasLayouts(decoded)) state.apps[cls] = decoded
    }
    return { state: state, error: null }
}

function encodeSaves(saves) {
    var out = []
    for (var i = 0; i < saves.length; i++) out.push(encodeSave(saves[i]))
    return out
}

function encodeState(state) {
    var out = { version: SCHEMA_VERSION, apps: {} }
    if (!state || !state.apps) return JSON.stringify(out)
    for (var cls in state.apps) {
        var app = state.apps[cls]
        if (!hasLayouts(app)) continue
        var encoded = { t: numberOr(app.lastAccess, 0) }
        if (Array.isArray(app.saves) && app.saves.length) encoded.w = encodeSaves(app.saves)
        var desktops = isObject(app.desktops) ? app.desktops : {}
        var keys = Object.keys(desktops)
        if (keys.length) {
            encoded.d = {}
            for (var i = 0; i < keys.length; i++) {
                var layout = desktops[keys[i]]
                encoded.d[keys[i]] = { t: numberOr(layout.lastAccess, 0), w: encodeSaves(layout.saves) }
            }
        }
        out.apps[cls] = encoded
    }
    return JSON.stringify(out)
}

// The layout an app left on one desktop: { lastAccess, saves } or null.
function layoutFor(state, cls, key) {
    var app = state.apps[cls]
    return app && isObject(app.desktops) && app.desktops[key] ? app.desktops[key] : null
}

function recordLayout(state, cls, key, saves, now) {
    var app = state.apps[cls]
    if (!app) app = state.apps[cls] = { lastAccess: now, saves: [], desktops: {} }
    if (!isObject(app.desktops)) app.desktops = {}
    app.desktops[key] = { lastAccess: now, saves: saves }
    app.saves = saves
    app.lastAccess = now
}

function pruneExpired(state, now) {
    var removed = 0
    var cutoff = now - EXPIRY_MS
    var keys = Object.keys(state.apps)
    for (var i = 0; i < keys.length; i++) {
        var app = state.apps[keys[i]]
        if (app.lastAccess < cutoff) {
            delete state.apps[keys[i]]
            removed++
            continue
        }
        // A deleted desktop's layouts go the same way as an unused app's.
        for (var key in app.desktops || {}) {
            if (app.desktops[key].lastAccess < cutoff) delete app.desktops[key]
        }
    }
    var remaining = Object.keys(state.apps)
    if (remaining.length > MAX_APPS) {
        remaining.sort(function (a, b) { return state.apps[a].lastAccess - state.apps[b].lastAccess })
        for (var j = 0; j < remaining.length - MAX_APPS; j++) {
            delete state.apps[remaining[j]]
            removed++
        }
    }
    return removed
}

// Re-adopt apps and desktop layouts that exist on disk but are missing from the in-memory
// state (written by another KWin instance, e.g. across a login). Memory wins for every app
// and desktop it already knows. Callers prune afterwards, so expired disk layouts still go.
function mergeDiskApps(state, diskState) {
    var adopted = 0
    if (!diskState || !diskState.apps) return adopted
    for (var cls in diskState.apps) {
        var app = diskState.apps[cls]
        if (!hasLayouts(app)) continue
        var known = state.apps[cls]
        if (!known) {
            state.apps[cls] = app
            adopted++
            continue
        }
        if (!isObject(known.desktops)) known.desktops = {}
        for (var key in app.desktops || {}) {
            if (!known.desktops[key]) {
                known.desktops[key] = app.desktops[key]
                adopted++
            }
        }
    }
    return adopted
}

// KWin window rules (kwinrulesrc) that place or size windows. KWin does not tell scripts which
// rules apply to a window, so the rules file is read and matched here, erring towards "a rule
// applies": the script then leaves that window to KWin.
// Rule kinds that last: Force (2), Apply initially (3), Remember (4), Force temporarily (6).
// Don't affect (1) and Apply now (5, a one-time change) leave new windows alone.
var RULE_GEOMETRY = ['position', 'size', 'screen', 'placement']
var RULE_KINDS = [2, 3, 4, 6]
var NORMAL_WINDOW_TYPE = 1

// `read(key)` returns a value from the rules file as QSettings reads it: [General] keys at
// the top level, rule groups as "group/key". Rules ids come from General/rules, or, in older
// files, the groups 1..count.
function parseRules(read) {
    var ids = read('rules')
    if (typeof ids === 'string') ids = ids.length ? ids.split(',') : []
    if (!Array.isArray(ids) || !ids.length) {
        ids = []
        var count = parseInt(read('count'), 10) || 0
        for (var n = 1; n <= count; n++) ids.push(String(n))
    }
    var rules = []
    for (var i = 0; i < ids.length; i++) {
        var id = String(ids[i]).trim()
        if (!id) continue
        var geometry = []
        for (var j = 0; j < RULE_GEOMETRY.length; j++) {
            if (RULE_KINDS.indexOf(parseInt(read(id + '/' + RULE_GEOMETRY[j] + 'rule'), 10)) !== -1) geometry.push(RULE_GEOMETRY[j])
        }
        if (!geometry.length) continue
        var text = function (key) { var v = read(id + '/' + key); return v === undefined || v === null ? '' : String(v) }
        rules.push({
            id: id, description: text('Description'), geometry: geometry,
            wmclass: text('wmclass'), wmclassmatch: text('wmclassmatch'), wmclasscomplete: text('wmclasscomplete') === 'true',
            title: text('title'), titlematch: text('titlematch'), types: text('types')
        })
    }
    return rules
}

// KWin's string matches: 0 unimportant, 1 exact, 2 substring, 3 regular expression.
function matchesRuleText(value, pattern, mode) {
    mode = parseInt(mode, 10) || 0
    if (mode === 0) return true
    value = String(value).toLowerCase()
    if (mode === 1) return value === pattern.toLowerCase()
    if (mode === 2) return value.indexOf(pattern.toLowerCase()) !== -1
    try {
        return new RegExp(pattern, 'i').test(value)
    } catch (e) {
        return true
    }
}

// The first rule that places or sizes this window, or null. `win`: { resourceClass,
// resourceName, caption }. Conditions the script can't check (window role, machine) are
// treated as met.
function geometryRuleFor(rules, win) {
    for (var i = 0; i < rules.length; i++) {
        var r = rules[i]
        if (r.types !== '' && !(parseInt(r.types, 10) & NORMAL_WINDOW_TYPE)) continue
        var cls = r.wmclasscomplete ? win.resourceName + ' ' + win.resourceClass : win.resourceClass
        if (!matchesRuleText(cls, r.wmclass, r.wmclassmatch)) continue
        if (!matchesRuleText(win.caption, r.title, r.titlematch)) continue
        return r
    }
    return null
}
