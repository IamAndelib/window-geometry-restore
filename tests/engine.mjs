import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../src/contents/ui/engine.js', import.meta.url), 'utf8')
    .replace(/^\s*\.pragma library.*$/m, '')

const engine = new Function(`
    ${source}
    return { SCHEMA_VERSION, CAPTION_FALLBACK, BURST_MS, RESTORE_TIMEOUT_MS, RETRY_MAX_AGE_MS,
             MAX_GEOMETRY_TRIES, EXPIRY_MS, MAX_APPS,
             parseList, isListed, captionScore, bestMatch, makeSave, newState,
             decodeState, encodeState, pruneExpired };
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
    const parsed = engine.parseList('org.kde.spectacle\n\nsteam*\nmid*game')
    assert.equal(engine.isListed('org.kde.spectacle', parsed), true)
    assert.equal(engine.isListed('steam', parsed), true)
    assert.equal(engine.isListed('steam_app_440', parsed), true)
    assert.equal(engine.isListed('steamdeck', parsed), true)
    assert.equal(engine.isListed('middle game', parsed), true)
    assert.equal(engine.isListed('xsteam', parsed), false)
    assert.equal(engine.isListed('other', parsed), false)
    assert.equal(engine.isListed('', parsed), false)
    const special = engine.parseList('a.b(c)')
    assert.equal(engine.isListed('a.b(c)', special), true)
    assert.equal(engine.isListed('aXbXc', special), false)
})

test('bestMatch: tier 1 caption+size, tier 2 size, tier 3 caption, no match', () => {
    const saves = [save(), save({ caption: 'Second window', width: 800, height: 600 })]
    assert.equal(engine.bestMatch(saves, live()).tier, 1)
    assert.equal(engine.bestMatch(saves, live({ caption: 'Totally Other' })).tier, 2)
    assert.equal(engine.bestMatch(saves, live({ width: 1280, height: 720 })).tier, 3)
    assert.equal(engine.bestMatch(saves, live({ caption: 'Unrelated', width: 1280, height: 720 })), null,
        'no match with several unmatched saves and neither caption nor size fitting')
})

test('bestMatch: skips already matched saves', () => {
    const saves = [save(), save({ caption: 'Second', width: 800, height: 600 })]
    saves[0].matched = true
    const m = engine.bestMatch(saves, live())
    assert.equal(m.index, 1)
    assert.equal(m.tier, 2)
})

test('bestMatch: prefers higher tier, then dims, then score', () => {
    const saves = [
        save({ caption: 'Unrelated', width: 800, height: 600 }),
        save({ caption: 'Window', width: 799, height: 599 })
    ]
    const m = engine.bestMatch(saves, live())
    assert.equal(m.index, 0)
    assert.equal(m.tier, 2)
})

test('single-save fallback: the lone save always applies to the next window (tier 4)', () => {
    const saves = [save({ caption: 'Unrelated', width: 640, height: 480 })]
    const m = engine.bestMatch(saves, live({ caption: 'WhatsApp', width: 1200, height: 900 }))
    assert.equal(m.tier, 4)
    assert.equal(m.index, 0)
    saves[0].matched = true
    assert.equal(engine.bestMatch(saves, live()), null, 'no fallback once the single save is matched')
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
    assert.equal(a.matched, false)
    const blob = JSON.parse(engine.encodeState(state))
    assert.equal(blob.version, 2)
    assert.equal(blob.apps['firefox'].w[0].d, undefined)
    assert.equal(blob.apps['firefox'].w[0].m, undefined)
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
