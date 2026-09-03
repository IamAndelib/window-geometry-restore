.pragma library

// Persisted key legend (compact on purpose - the blob lives in a single KConfig entry):
//   app:  { t: lastAccessTime, w: [saves] }
//   save: { c: caption, x: globalX, y: globalY, w: width, h: height,
//           o: { x, y, s: outputSerial, n: outputName }  output-relative position }
//   Only geometry is saved and restored; everything else is left to KWin.
//   Runtime save objects use long names plus a `matched` flag (never persisted).
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

function numberOr(value, fallback) {
    var n = typeof value === 'number' ? value : parseFloat(value)
    return isFinite(n) ? n : fallback
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseList(text) {
    var parsed = { exact: [], patterns: [] }
    if (!text) return parsed
    var lines = String(text).split(/\r?\n/)
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim()
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

function isListed(name, parsed) {
    if (!name) return false
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

// Deterministic slot matching: pick the best unmatched save for one live window.
// Tier 1: caption 100% (numbers stripped) and same size
// Tier 2: same size
// Tier 3: caption >= CAPTION_FALLBACK
// Returns { index, tier, score } or null.
function bestMatch(saves, live) {
    var best = null
    for (var i = 0; i < saves.length; i++) {
        var s = saves[i]
        if (!s || s.matched) continue
        var dims = (s.width === live.width ? 1 : 0) + (s.height === live.height ? 1 : 0)
        var score = captionScore(s.caption, live.caption)
        var tier
        if (score === 100 && dims === 2) tier = 1
        else if (dims === 2) tier = 2
        else if (score >= CAPTION_FALLBACK) tier = 3
        else continue
        if (!best || tier < best.tier || (tier === best.tier && (dims > best.dims || (dims === best.dims && score > best.score)))) {
            best = { index: i, tier: tier, dims: dims, score: score }
        }
    }
    if (!best) {
        // Single-save fallback: an app with exactly one saved window always gets it
        // applied to its next window - this is the "app never remembers anything" case.
        var only = -1
        var count = 0
        for (var j = 0; j < saves.length; j++) {
            if (saves[j] && !saves[j].matched) {
                count++
                only = j
            }
        }
        if (count === 1 && saves[only]) {
            return { index: only, tier: 4, dims: 0, score: captionScore(saves[only].caption, live.caption) }
        }
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
        matched: false
    }
}

function newState() {
    return { version: SCHEMA_VERSION, apps: {} }
}

function encodeSave(s) {
    var o = null
    if (s.output) o = { x: s.output.x, y: s.output.y, s: s.output.serial, n: s.output.name }
    return {
        c: s.caption,
        x: s.x,
        y: s.y,
        w: s.width,
        h: s.height,
        o: o
    }
}

function decodeSave(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null
    var width = numberOr(s.w, NaN)
    var height = numberOr(s.h, NaN)
    if (!isFinite(width) || !isFinite(height)) return null
    var output = null
    if (s.o && typeof s.o === 'object' && !Array.isArray(s.o)) {
        output = {
            x: numberOr(s.o.x, 0),
            y: numberOr(s.o.y, 0),
            serial: typeof s.o.s === 'string' ? s.o.s : '',
            name: typeof s.o.n === 'string' ? s.o.n : ''
        }
    }
    return {
        caption: typeof s.c === 'string' ? s.c : '',
        x: numberOr(s.x, 0),
        y: numberOr(s.y, 0),
        width: width,
        height: height,
        output: output,
        matched: false
    }
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
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: state, error: 'unexpected root' }
    if (raw.apps === undefined) return { state: state, error: null }
    var apps = raw.apps
    if (!apps || typeof apps !== 'object' || Array.isArray(apps)) return { state: state, error: 'unexpected apps' }
    for (var cls in apps) {
        var app = apps[cls]
        if (!app || typeof app !== 'object' || Array.isArray(app) || !Array.isArray(app.w) || !app.w.length) continue
        var saves = []
        for (var i = 0; i < app.w.length; i++) {
            var save = decodeSave(app.w[i])
            if (save) saves.push(save)
        }
        if (saves.length) state.apps[cls] = { lastAccess: numberOr(app.t, 0), saves: saves }
    }
    return { state: state, error: null }
}

function encodeState(state) {
    var out = { version: SCHEMA_VERSION, apps: {} }
    if (!state || !state.apps) return JSON.stringify(out)
    for (var cls in state.apps) {
        var app = state.apps[cls]
        if (!app || !Array.isArray(app.saves) || !app.saves.length) continue
        var saves = []
        for (var i = 0; i < app.saves.length; i++) saves.push(encodeSave(app.saves[i]))
        out.apps[cls] = { t: numberOr(app.lastAccess, 0), w: saves }
    }
    return JSON.stringify(out)
}

function pruneExpired(state, now) {
    var removed = 0
    var keys = Object.keys(state.apps)
    for (var i = 0; i < keys.length; i++) {
        if (state.apps[keys[i]].lastAccess < now - EXPIRY_MS) {
            delete state.apps[keys[i]]
            removed++
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
