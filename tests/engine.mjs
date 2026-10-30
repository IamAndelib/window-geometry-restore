import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../src/contents/ui/engine.js', import.meta.url), 'utf8')
    .replace(/^\s*\.pragma library.*$/m, '')

const engine = new Function(`
    ${source}
    return { SCHEMA_VERSION, CAPTION_FALLBACK, BURST_MS, RESTORE_TIMEOUT_MS, RETRY_MAX_AGE_MS,
             MAX_GEOMETRY_TRIES, EXPIRY_MS, MAX_APPS,
             parseList, isListed, captionScore, isBetterMatch, bestMatch, makeSave, newState,
             decodeState, encodeState, pruneExpired, mergeDiskApps, layoutFor, recordLayout, MAX_DESKTOP_KEY };
`)()

function save(overrides = {}) {
    return engine.makeSave({
        caption: 'Window',
        x: 100, y: 50, width: 800, height: 600,
        output: { x: 10, y: 20, serial: 'SER1', name: 'DP-1' },
        ...overrides
    })
}

function live(overrides = {}) {
    return { caption: 'Window', width: 800, height: 600, ...overrides }
}

test('captionScore: exact, numeric drift, prefix/suffix drift, unrelated', () => {
    assert.equal(engine.captionScore('Same', 'Same'), 100)
    assert.equal(engine.captionScore('Inbox (12) - Mail', 'Inbox (3) - Mail'), 100)
    assert.ok(engine.captionScore('Konsole', 'Konsole') === 100)
    const drifted = engine.captionScore('text editor - main.py', 'text editor - utils.py')
    assert.ok(drifted > 50 && drifted < 100, `drift score ${drifted}`)
    assert.ok(drifted < engine.CAPTION_FALLBACK, 'different files must stay below tier-3 threshold')
    assert.ok(engine.captionScore('Firefox', 'Totally Different') < 30)
    assert.equal(engine.captionScore('', 'x'), 0)
    assert.equal(engine.captionScore(null, 'x'), 0)
})

test('parseList/isListed: exact, wildcard, no false positives', () => {
    const parsed = engine.parseList('org.kde.spectacle\n\nsteam*\nmid*game\nChrome-ABC-Default')
    assert.equal(engine.isListed('org.kde.spectacle', parsed), true)
    assert.equal(engine.isListed('steam', parsed), true)
    assert.equal(engine.isListed('steam_app_440', parsed), true)
    assert.equal(engine.isListed('steamdeck', parsed), true)
    assert.equal(engine.isListed('middle game', parsed), true)
    assert.equal(engine.isListed('xsteam', parsed), false)
    assert.equal(engine.isListed('other', parsed), false)
    assert.equal(engine.isListed('', parsed), false)
    assert.equal(engine.isListed('Steam', parsed), true, 'case-insensitive wildcard')
    assert.equal(engine.isListed('chrome-abc-default', parsed), true, 'case-insensitive exact')
    assert.equal(engine.isListed('ORG.KDE.SPECTACLE', parsed), true)
    const special = engine.parseList('a.b(c)')
    assert.equal(engine.isListed('a.b(c)', special), true)
    assert.equal(engine.isListed('aXbXc', special), false)
})

test('bestMatch: tier 1 caption+size, tier 2 size, tier 3 caption, no match', () => {
    const saves = [save(), save({ caption: 'Second window', width: 800, height: 600 })]
    assert.equal(engine.bestMatch(saves, live(), []).tier, 1)
    assert.equal(engine.bestMatch(saves, live({ caption: 'Totally Other' }), []).tier, 2)
    assert.equal(engine.bestMatch(saves, live({ width: 1280, height: 720 }), []).tier, 3)
    assert.equal(engine.bestMatch(saves, live({ caption: 'Unrelated', width: 1280, height: 720 }), []), null,
        'no match with several unmatched saves and neither caption nor size fitting')
})

test('bestMatch: skips taken saves without mutating them', () => {
    const saves = [save(), save({ caption: 'Second', width: 800, height: 600 })]
    const before = JSON.stringify(saves)
    const m = engine.bestMatch(saves, live(), [true])
    assert.equal(JSON.stringify(saves), before)
    assert.equal(m.index, 1)
    assert.equal(m.tier, 2)
})

test('bestMatch: prefers higher tier, then dims, then score', () => {
    const saves = [
        save({ caption: 'Unrelated', width: 800, height: 600 }),
        save({ caption: 'Window', width: 799, height: 599 })
    ]
    const m = engine.bestMatch(saves, live(), [])
    assert.equal(m.index, 0)
    assert.equal(m.tier, 2)
})

test('isBetterMatch: tier, then dims, then score', () => {
    assert.equal(engine.isBetterMatch({ tier: 1, dims: 0, score: 0 }, { tier: 2, dims: 2, score: 100 }), true)
    assert.equal(engine.isBetterMatch({ tier: 3, dims: 1, score: 80 }, { tier: 3, dims: 0, score: 99 }), true)
    assert.equal(engine.isBetterMatch({ tier: 3, dims: 1, score: 81 }, { tier: 3, dims: 1, score: 80 }), true)
    assert.equal(engine.isBetterMatch({ tier: 3, dims: 1, score: 80 }, { tier: 3, dims: 1, score: 80 }), false)
})

test('single-save fallback: the lone save always applies to the next window (tier 4)', () => {
    const saves = [save({ caption: 'Unrelated', width: 640, height: 480 })]
    const m = engine.bestMatch(saves, live({ caption: 'WhatsApp', width: 1200, height: 900 }), [])
    assert.equal(m.tier, 4)
    assert.equal(m.index, 0)
    assert.equal(engine.bestMatch(saves, live(), [true]), null, 'no fallback once the single save is taken')
    const two = [save({ caption: 'A', width: 1, height: 1 }), save({ caption: 'B', width: 2, height: 2 })]
    assert.equal(engine.bestMatch(two, live(), [false, true]).index, 0, 'fallback applies to the last free save')
})

test('decodeState: rejects garbage without throwing, returns empty state', () => {
    for (const garbage of ['', '   ', 'not json', '{"apps": 5}', '[]', 'null', '{"apps": {"a": {"w": "nope"}}}']) {
        const r = engine.decodeState(garbage)
        assert.equal(r.error === null || typeof r.error === 'string', true)
        assert.deepEqual(Object.keys(r.state.apps).length >= 0, true)
    }
    const r = engine.decodeState('not json')
    assert.ok(r.error)
    assert.deepEqual(r.state.apps, {})
    const empty = engine.decodeState('{}')
    assert.equal(empty.error, null)
})

test('encode/decode round-trip preserves geometry fields, drops runtime flags', () => {
    const state = engine.newState()
    state.apps['firefox'] = {
        lastAccess: 1234,
        saves: [
            save({ caption: 'One', output: { x: 30, y: 40, serial: 'SER9', name: 'HDMI-1' } }),
            save({ caption: 'Two', output: null })
        ]
    }
    const decoded = engine.decodeState(engine.encodeState(state))
    assert.equal(decoded.error, null)
    const app = decoded.state.apps['firefox']
    assert.equal(app.lastAccess, 1234)
    assert.equal(app.saves.length, 2)
    const [a, b] = app.saves
    assert.equal(a.caption, 'One')
    assert.equal(a.x, 100)
    assert.equal(a.width, 800)
    assert.deepEqual(a.output, { x: 30, y: 40, serial: 'SER9', name: 'HDMI-1' })
    assert.equal(b.output, null)
    assert.deepEqual(Object.keys(a).sort(), ['caption', 'free', 'height', 'output', 'tile', 'width', 'x', 'y'])
    assert.equal(a.tile, null)
    assert.equal(a.free, null)
    const blob = JSON.parse(engine.encodeState(state))
    assert.equal(blob.version, 2)
    assert.equal(blob.apps['firefox'].w[0].d, undefined)
    assert.equal(blob.apps['firefox'].w[0].m, undefined)
    assert.ok(!('t' in blob.apps['firefox'].w[0]) && !('f' in blob.apps['firefox'].w[0]), 'untiled saves stay compact')
})

function roundTrip(saves) {
    const state = engine.newState()
    state.apps['app'] = { lastAccess: 1, saves }
    return engine.decodeState(engine.encodeState(state)).state.apps['app'].saves
}

function decodeOne(raw) {
    const r = engine.decodeState(JSON.stringify({ version: 2, apps: { app: { t: 1, w: [raw] } } }))
    assert.equal(r.error, null)
    return r.state.apps['app'] ? r.state.apps['app'].saves[0] : null
}

test('tiled saves round-trip their tile and pre-tile geometry', () => {
    const free = { x: 300, y: 200, width: 1000, height: 700, output: { x: 300, y: 200, serial: 'SER1', name: 'DP-1' } }
    const [quick, custom] = roundTrip([
        save({ tile: { kind: 'quick', index: 4, rel: { x: 0, y: 0, width: 0.68, height: 0.5 } }, free }),
        save({ tile: { kind: 'custom', path: [1, 0], rel: { x: 0.5, y: 0, width: 0.5, height: 0.5 } }, free: { ...free, output: null } })
    ])
    assert.deepEqual(quick.tile, { kind: 'quick', index: 4, rel: { x: 0, y: 0, width: 0.68, height: 0.5 } })
    assert.deepEqual(quick.free, free)
    assert.deepEqual(custom.tile, { kind: 'custom', path: [1, 0], rel: { x: 0.5, y: 0, width: 0.5, height: 0.5 } })
    assert.equal(custom.free.output, null)
    assert.equal(custom.free.width, 1000)
})

test('a quick tile without a recorded size keeps its index (older saves)', () => {
    assert.deepEqual(decodeOne({ c: '', x: 0, y: 0, w: 800, h: 600, t: { k: 'q', i: 3 } }).tile, { kind: 'quick', index: 3, rel: null })
    for (const g of ['x', { x: 0, y: 0, w: 0, h: 1 }, { x: 0.8, y: 0, w: 0.5, h: 1 }]) {
        assert.deepEqual(decodeOne({ c: '', x: 0, y: 0, w: 800, h: 600, t: { k: 'q', i: 3, g } }).tile, { kind: 'quick', index: 3, rel: null }, JSON.stringify(g))
    }
})

test('a tiled save without a known pre-tile geometry keeps its tile', () => {
    const [s] = roundTrip([save({ tile: { kind: 'quick', index: 0, rel: null } })])
    assert.deepEqual(s.tile, { kind: 'quick', index: 0, rel: null })
    assert.equal(s.free, null)
})

test('malformed tile or pre-tile data is dropped, the plain geometry still restores', () => {
    const base = { c: 'Win', x: 1, y: 2, w: 800, h: 600, o: null }
    const badTiles = [
        'q', 7, [], { k: 'x', i: 0 },
        { k: 'q' }, { k: 'q', i: -1 }, { k: 'q', i: 8 }, { k: 'q', i: 1.5 }, { k: 'q', i: '2' },
        { k: 'c', g: { x: 0, y: 0, w: 1, h: 1 } },
        { k: 'c', p: 'nope', g: { x: 0, y: 0, w: 1, h: 1 } },
        { k: 'c', p: [0, -1], g: { x: 0, y: 0, w: 1, h: 1 } },
        { k: 'c', p: [0.5], g: { x: 0, y: 0, w: 1, h: 1 } },
        { k: 'c', p: new Array(33).fill(0), g: { x: 0, y: 0, w: 1, h: 1 } },
        { k: 'c', p: [0] },
        { k: 'c', p: [0], g: { x: 0, y: 0, w: 0, h: 1 } },
        { k: 'c', p: [0], g: { x: 0.6, y: 0, w: 0.6, h: 1 } },
        { k: 'c', p: [0], g: { x: -0.1, y: 0, w: 0.5, h: 1 } },
        { k: 'c', p: [0], g: { x: 'a', y: 0, w: 0.5, h: 1 } }
    ]
    for (const t of badTiles) {
        const s = decodeOne({ ...base, t, f: { x: 5, y: 5, w: 900, h: 700, o: null } })
        assert.ok(s, `save kept for tile ${JSON.stringify(t)}`)
        assert.equal(s.tile, null, `tile rejected: ${JSON.stringify(t)}`)
        assert.equal(s.width, 800)
    }
    for (const f of ['x', [], { x: 1, y: 1, w: 0, h: 500 }, { x: 1, y: 1, w: 500 }]) {
        const s = decodeOne({ ...base, t: { k: 'q', i: 1 }, f })
        assert.deepEqual(s.tile, { kind: 'quick', index: 1, rel: null })
        assert.equal(s.free, null, `pre-tile geometry rejected: ${JSON.stringify(f)}`)
    }
})

test('an empty custom path (a layout with no splits) is a valid tile', () => {
    const s = decodeOne({ c: '', x: 0, y: 0, w: 800, h: 600, t: { k: 'c', p: [], g: { x: 0, y: 0, w: 1, h: 1 } } })
    assert.deepEqual(s.tile, { kind: 'custom', path: [], rel: { x: 0, y: 0, width: 1, height: 1 } })
})

test('v1 blobs (with desktop/activities/state fields) decode cleanly - fields ignored', () => {
    const v1 = JSON.stringify({
        version: 1,
        apps: {
            app: {
                t: 42,
                w: [{ c: 'old', x: 5, y: 6, w: 700, h: 500, d: -1, a: ['act'], m: 1, v: 1, b: 1, o: { x: 7, y: 8, s: 'S1', n: 'DP-1' } }]
            }
        }
    })
    const r = engine.decodeState(v1)
    assert.equal(r.error, null)
    const save = r.state.apps['app'].saves[0]
    assert.equal(save.caption, 'old')
    assert.equal(save.x, 5)
    assert.equal(save.width, 700)
    assert.deepEqual(save.output, { x: 7, y: 8, serial: 'S1', name: 'DP-1' })
    const reencoded = JSON.parse(engine.encodeState(r.state))
    assert.equal(reencoded.version, 2)
    assert.equal(reencoded.apps['app'].w[0].d, undefined, 'v1 fields are not carried forward')
})

test('decodeState: drops malformed saves, keeps valid ones', () => {
    const blob = JSON.stringify({
        version: 1,
        apps: {
            app: {
                t: 1,
                w: [
                    { c: 'good', x: 1, y: 2, w: 100, h: 50, d: 2, a: ['x'], m: 1, v: 1, b: 0, o: { x: 3, y: 4, s: 'S', n: 'N' } },
                    { c: 'bad-size', x: 1, y: 2 },
                    null,
                    { c: 5, w: 10, h: 10 },
                    { c: 'zero', w: 0, h: 10 },
                    { c: 'negative', w: 10, h: -5 },
                    'string'
                ]
            },
            empty: { t: 1, w: [] }
        }
    })
    const r = engine.decodeState(blob)
    assert.equal(r.error, null)
    assert.equal(r.state.apps['app'].saves.length, 2)
    assert.equal(r.state.apps['empty'], undefined)
    const good = r.state.apps['app'].saves[0]
    assert.deepEqual(good.output, { x: 3, y: 4, serial: 'S', name: 'N' })
})

test('pruneExpired: removes stale apps, enforces MAX_APPS, keeps fresh', () => {
    const state = engine.newState()
    const now = 1_000_000_000
    state.apps['fresh'] = { lastAccess: now, saves: [save()] }
    state.apps['stale'] = { lastAccess: now - engine.EXPIRY_MS - 1, saves: [save()] }
    state.apps['ok'] = { lastAccess: now - engine.EXPIRY_MS + 1000, saves: [save()] }
    assert.equal(engine.pruneExpired(state, now), 1)
    assert.equal(state.apps['stale'], undefined)
    assert.ok(state.apps['fresh'])
    assert.ok(state.apps['ok'])

    const big = engine.newState()
    for (let i = 0; i < engine.MAX_APPS + 10; i++) {
        big.apps['app' + i] = { lastAccess: i, saves: [save()] }
    }
    assert.equal(engine.pruneExpired(big, now), 10)
    assert.equal(Object.keys(big.apps).length, engine.MAX_APPS)
})

test('burst window and retry constants are sane', () => {
    assert.ok(engine.BURST_MS >= 1000 && engine.BURST_MS <= 3000)
    assert.ok(engine.RESTORE_TIMEOUT_MS >= 5000 && engine.RESTORE_TIMEOUT_MS <= 15000)
    assert.ok(engine.MAX_GEOMETRY_TRIES >= 2 && engine.MAX_GEOMETRY_TRIES <= 5)
})

test('mergeDiskApps: adopts disk-only apps, memory wins for known apps', () => {
    const memory = engine.newState()
    memory.apps['known'] = { lastAccess: 5, saves: [save()] }
    const disk = engine.newState()
    disk.apps['known'] = { lastAccess: 1, saves: [save({ caption: 'stale on disk' })] }
    disk.apps['lost'] = { lastAccess: 2, saves: [save({ caption: 'lost' })] }
    disk.apps['broken'] = null

    const adopted = engine.mergeDiskApps(memory, disk)
    assert.equal(adopted, 1)
    assert.equal(memory.apps['known'].saves[0].caption, 'Window', 'memory wins for known apps')
    assert.equal(memory.apps['lost'].saves[0].caption, 'lost', 'disk-only app re-adopted')
})

function desktopState() {
    const state = engine.newState()
    engine.recordLayout(state, 'konsole', 'uuid-desk-1', [save({ caption: 'On one' })], 100)
    engine.recordLayout(state, 'konsole', '*', [save({ caption: 'Everywhere' })], 200)
    engine.recordLayout(state, 'konsole', 'uuid-desk-2', [save({ caption: 'On two' }), save({ caption: 'Also two' })], 300)
    return state
}

test('recordLayout keeps one layout per desktop, and the latest one for older versions', () => {
    const state = desktopState()
    const app = state.apps['konsole']
    assert.equal(app.lastAccess, 300)
    assert.deepEqual(app.saves.map((s) => s.caption), ['On two', 'Also two'], 'w: the latest layout, any desktop')
    assert.deepEqual(engine.layoutFor(state, 'konsole', 'uuid-desk-1').saves.map((s) => s.caption), ['On one'])
    assert.equal(engine.layoutFor(state, 'konsole', 'uuid-desk-1').lastAccess, 100)
    assert.deepEqual(engine.layoutFor(state, 'konsole', '*').saves.map((s) => s.caption), ['Everywhere'])
    assert.equal(engine.layoutFor(state, 'konsole', 'uuid-desk-3'), null)
    assert.equal(engine.layoutFor(state, 'dolphin', 'uuid-desk-1'), null)
})

test('per-desktop layouts round-trip; older versions still read w', () => {
    const blob = JSON.parse(engine.encodeState(desktopState()))
    assert.equal(blob.version, 2, 'additive: no version bump')
    const app = blob.apps['konsole']
    assert.deepEqual(app.w.map((s) => s.c), ['On two', 'Also two'])
    assert.deepEqual(Object.keys(app.d).sort(), ['*', 'uuid-desk-1', 'uuid-desk-2'])
    assert.equal(app.d['uuid-desk-1'].t, 100)

    const decoded = engine.decodeState(JSON.stringify(blob))
    assert.equal(decoded.error, null)
    assert.deepEqual(engine.layoutFor(decoded.state, 'konsole', 'uuid-desk-2').saves.map((s) => s.caption), ['On two', 'Also two'])
    assert.equal(engine.layoutFor(decoded.state, 'konsole', '*').lastAccess, 200)
})

test('data from older versions has no per-desktop layout, so it restores nothing', () => {
    const r = engine.decodeState(JSON.stringify({ version: 2, apps: { konsole: { t: 5, w: [{ c: 'Old', x: 1, y: 2, w: 800, h: 600 }] } } }))
    assert.equal(r.error, null)
    assert.equal(r.state.apps['konsole'].saves.length, 1, 'kept, and written back for older versions')
    assert.equal(engine.layoutFor(r.state, 'konsole', 'uuid-desk-1'), null)
    assert.equal(engine.layoutFor(r.state, 'konsole', '*'), null)
    assert.ok(!('d' in JSON.parse(engine.encodeState(r.state)).apps['konsole']), 'no empty d written')
})

test('malformed per-desktop data is dropped, valid layouts are kept', () => {
    const good = { c: 'Win', x: 1, y: 2, w: 800, h: 600 }
    const blob = JSON.stringify({ version: 2, apps: {
        a: { t: 1, w: [good], d: 'nope' },
        b: { t: 1, w: [good], d: { '': { t: 1, w: [good] }, ['x'.repeat(engine.MAX_DESKTOP_KEY + 1)]: { t: 1, w: [good] },
                                   bad: 7, empty: { t: 1, w: [] }, junk: { t: 1, w: [{ c: 'no size' }] }, ok: { t: 'x', w: [good] } } },
        onlyDesktops: { t: 9, d: { 'uuid-desk-1': { t: 9, w: [good] } } },
        nothing: { t: 9, d: { 'uuid-desk-1': { t: 9, w: [] } } }
    } })
    const r = engine.decodeState(blob)
    assert.equal(r.error, null)
    assert.equal(engine.layoutFor(r.state, 'a', 'nope'), null)
    assert.deepEqual(Object.keys(r.state.apps['b'].desktops), ['ok'])
    assert.equal(engine.layoutFor(r.state, 'b', 'ok').lastAccess, 1, 'no valid time: the app\'s')
    assert.equal(engine.layoutFor(r.state, 'onlyDesktops', 'uuid-desk-1').saves.length, 1, 'an app with only per-desktop layouts is kept')
    assert.equal(r.state.apps['onlyDesktops'].saves.length, 0)
    assert.equal(r.state.apps['nothing'], undefined)
    const reencoded = JSON.parse(engine.encodeState(r.state))
    assert.equal(reencoded.apps['onlyDesktops'].w, undefined, 'no empty w written')
})

test('pruneExpired drops stale desktop layouts and keeps fresh ones', () => {
    const now = 1_000_000_000
    const state = engine.newState()
    engine.recordLayout(state, 'konsole', 'gone-desktop', [save()], now - engine.EXPIRY_MS - 1)
    engine.recordLayout(state, 'konsole', 'uuid-desk-1', [save()], now - 1000)
    engine.recordLayout(state, 'old', 'uuid-desk-1', [save()], now - engine.EXPIRY_MS - 1)

    assert.equal(engine.pruneExpired(state, now), 1, 'counts removed apps')
    assert.equal(state.apps['old'], undefined)
    assert.equal(engine.layoutFor(state, 'konsole', 'gone-desktop'), null)
    assert.ok(engine.layoutFor(state, 'konsole', 'uuid-desk-1'))
})

test('mergeDiskApps adopts desktop layouts missing from memory; memory wins per desktop', () => {
    const memory = engine.newState()
    engine.recordLayout(memory, 'konsole', 'uuid-desk-1', [save({ caption: 'memory' })], 50)
    const disk = engine.newState()
    engine.recordLayout(disk, 'konsole', 'uuid-desk-1', [save({ caption: 'stale on disk' })], 10)
    engine.recordLayout(disk, 'konsole', 'uuid-desk-2', [save({ caption: 'other instance' })], 20)

    assert.equal(engine.mergeDiskApps(memory, disk), 1)
    assert.equal(engine.layoutFor(memory, 'konsole', 'uuid-desk-1').saves[0].caption, 'memory')
    assert.equal(engine.layoutFor(memory, 'konsole', 'uuid-desk-2').saves[0].caption, 'other instance')
    assert.equal(memory.apps['konsole'].saves[0].caption, 'memory', 'w stays the in-memory latest')
})

test('default exclusion list is identical in main.qml and config/main.xml', () => {
    const qml = readFileSync(new URL('../src/contents/ui/main.qml', import.meta.url), 'utf8')
    const xml = readFileSync(new URL('../src/contents/config/main.xml', import.meta.url), 'utf8')
    const qmlBlock = qml.match(/defaultBlacklist: \[([\s\S]*?)\]\.join/)[1]
    const fromQml = [...qmlBlock.matchAll(/'([^']+)'/g)].map((m) => m[1])
    const fromXml = xml.match(/<entry name="blacklist"[\s\S]*?<default>([\s\S]*?)<\/default>/)[1].split('\n').map((l) => l.trim()).filter(Boolean)
    assert.ok(fromQml.length > 0)
    assert.deepEqual(fromQml, fromXml)
})
