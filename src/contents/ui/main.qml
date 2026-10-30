import QtQuick
import QtCore
import org.kde.kwin
import "engine.js" as Engine

// Window Geometry Restore - a lightweight assistant to KWin's native window
// management. Saves window geometry when an app's last window closes and
// restores it on the next launch, only for windows that KWin (rules, session
// restore, app self-management) did not already place correctly.
// Never touches focus, stacking or z-order.

Item {
    id: root

    readonly property string storeKey: 'windowgeometryrestore_windows'
    readonly property string defaultBlacklist: [
        'org.kde.spectacle',
        'org.kde.polkit-kde-authentication-agent-1',
        'steam*',
        'org.kde.plasmashell',
        'kwin',
        'ksmserver',
        'systemsettings',
        'kcm_kwinrules',
        'org.kde.kmenuedit',
        'org.kde.ark',
        'org.kde.plasma.emojier',
        'org.freedesktop.impl.portal.desktop.kde'
    ].join('\n')

    property bool debugMode: false
    property bool restoreTiles: true
    property var blacklist: Engine.parseList('')
    // Problems already logged once (see logOnce): { key: true }
    property var reported: ({})
    // The saved data as this script last wrote it: when the file still holds it, no other KWin
    // instance wrote in between, and saving skips reading it back.
    property string lastWritten: ''
    // Persisted: { apps: { cls: { lastAccess, saves, desktops: { key: { lastAccess, saves } } } } }.
    // Each virtual desktop keeps its own layout per app, until the app's next close on that
    // desktop replaces it, so a crash or power loss still restores the last layout.
    property var store: Engine.newState()
    // Runtime, per group (an app on one desktop key, see desktopKeyOf) with open windows:
    // { cls, desk, label, open: [ids], buffer: [closes], session, settled }
    property var live: ({})
    // Runtime, per window id: { w, cls, desk, group, label, assigned, userPlaced, provisional,
    //                          home, tile, free, pendingTile,
    //                          captionHandler, moveHandler, geometryHandler, tileHandler, desktopsHandler, outputHandler }
    // `home` is the last geometry on a connected screen, `tile` the last tile seen and `free` the
    // last floating geometry (all save-shaped).
    // `pendingTile` is a quick tile waiting for the window to become active.
    property var tracked: ({})
    // Geometry writes that have not stuck yet: { id, target, tries, born }
    property var retries: []

    function log(message) {
        console.warn('WindowGeometryRestore: ' + message)
    }

    function dbg(message) {
        if (debugMode) log(message)
    }

    // For problems that would repeat on every window or frame.
    function logOnce(key, message) {
        if (reported[key]) return
        reported[key] = true
        log(message)
    }

    function removeFromArray(array, item) {
        var index = array.indexOf(item)
        if (index !== -1) array.splice(index, 1)
    }

    // Connects `handler`, wrapped so that an error is logged under the script's name instead of
    // reaching KWin's log as an anonymous QML error. Returns what disconnectSignal needs.
    function connectSignal(w, name, handler) {
        var guarded = function () {
            try {
                handler.apply(null, arguments)
            } catch (e) {
                log('handling ' + name + ' failed: ' + e)
            }
        }
        try {
            w[name].connect(guarded)
            return guarded
        } catch (e) {
            logOnce('signal:' + name, "cannot connect to KWin's " + name + ' signal (' + e + '); that part is skipped')
            return null
        }
    }

    function disconnectSignal(w, name, handler) {
        if (!handler) return
        try {
            w[name].disconnect(handler)
        } catch (e) {}
    }

    function isValidWindow(w) {
        if (!w || w.deleted) return false
        if (!w.normalWindow || w.popupWindow || w.skipTaskbar) return false
        if (w.modal || w.transient || w.splash) return false
        if (typeof w.resourceClass !== 'string' || w.resourceClass.length === 0) return false
        return true
    }

    function loadConfig() {
        debugMode = KWin.readConfig('debug', false)
        restoreTiles = KWin.readConfig('restoreTiles', true)
        blacklist = Engine.parseList(KWin.readConfig('blacklist', defaultBlacklist))
        dbg('blacklist entries: ' + (blacklist.exact.length + blacklist.patterns.length))
    }

    function loadPersisted() {
        var raw = String(settings.value(storeKey, '{}'))
        var result = Engine.decodeState(raw)
        if (result.error) {
            log('saved window data unreadable (' + result.error + ') - kept a copy, starting fresh')
            settings.setValue(storeKey + '_corrupt', raw)
        } else if (result.version > Engine.SCHEMA_VERSION) {
            log('saved window data was written by a newer version of the script - kept a copy, reading what this version understands')
            settings.setValue(storeKey + '_v' + result.version, raw)
        } else {
            lastWritten = raw
        }
        store = result.state
        var removed = Engine.pruneExpired(store, Date.now())
        var count = 0
        for (var cls in store.apps) {
            for (var key in store.apps[cls].desktops) count += store.apps[cls].desktops[key].saves.length
        }
        log('loaded ' + count + ' saved window(s) for ' + Object.keys(store.apps).length + ' app(s)' +
            (removed > 0 ? ', pruned ' + removed + ' expired app(s)' : ''))
        if (removed > 0 || result.error) persist()
    }

    // Write the store and flush it to disk at once. sync() first reloads the file,
    // so apps saved by another KWin instance are adopted instead of erased.
    function persist() {
        try {
            settings.sync()
            var raw = String(settings.value(storeKey, '{}'))
            if (raw !== lastWritten) {
                var disk = Engine.decodeState(raw)
                if (!disk.error) {
                    Engine.mergeDiskApps(store, disk.state)
                } else {
                    log('saved window data on disk unreadable (' + disk.error + ') - kept a copy before saving')
                    settings.setValue(storeKey + '_corrupt', raw)
                }
            }
            Engine.pruneExpired(store, Date.now())
            lastWritten = Engine.encodeState(store)
            settings.setValue(storeKey, lastWritten)
            settings.sync()
        } catch (e) {
            log('failed to persist: ' + e)
        }
    }

    // The desktop a window's layout belongs to: the desktop's id when the window is on exactly
    // one desktop, '*' when it is on all or several. Ids survive logins and desktop reordering.
    function desktopKeyOf(w) {
        var desktops = w.desktops || []
        if (w.onAllDesktops || desktops.length !== 1) return '*'
        return String(desktops[0].id || desktops[0].x11DesktopNumber)
    }

    // Puts a tracked window in the group of its app on its current desktop key.
    function joinGroup(entry, id) {
        var w = entry.w
        entry.desk = desktopKeyOf(w)
        entry.group = entry.cls + '\n' + entry.desk
        entry.label = entry.cls + (entry.desk === '*' ? ' (all desktops)' : ' (desktop ' + w.desktops[0].x11DesktopNumber + ')')
        if (!live[entry.group]) {
            live[entry.group] = { cls: entry.cls, desk: entry.desk, label: entry.label, open: [], buffer: [], session: null, settled: false }
        }
        live[entry.group].open.push(id)
        return live[entry.group]
    }

    // `adopted` windows were open before the script started (reload, KWin restart):
    // they are left where they are and only saved when they close.
    function trackWindow(w, adopted) {
        if (!isValidWindow(w)) return
        var cls = w.resourceClass
        if (Engine.isListed(cls, blacklist)) {
            dbg('ignoring blacklisted app: ' + cls)
            return
        }
        var id = String(w.internalId)
        if (tracked[id]) return
        var entry = {
            w: w, cls: cls, desk: '', group: '', label: cls, assigned: !!adopted, userPlaced: false, provisional: null,
            home: null, tile: null, free: null, pendingTile: null,
            captionHandler: null, moveHandler: null, geometryHandler: null, tileHandler: null, desktopsHandler: null, outputHandler: null
        }
        tracked[id] = entry
        var app = joinGroup(entry, id)
        entry.moveHandler = connectSignal(w, 'interactiveMoveResizeStarted', function () { onUserMoveResize(id) })
        entry.geometryHandler = connectSignal(w, 'frameGeometryChanged', function () { noteGeometry(id) })
        entry.tileHandler = connectSignal(w, 'tileChanged', function () { noteTile(id) })
        entry.desktopsHandler = connectSignal(w, 'desktopsChanged', function () { onDesktopsChanged(id) })
        entry.outputHandler = connectSignal(w, 'outputChanged', function () { onOutputChanged(id) })
        noteGeometry(id)
        dbg('tracking window for ' + entry.label)
        var rule = adopted ? null : geometryRuleOf(w)
        if (adopted) {
            app.settled = true
        } else if (app.session && app.session.monitor && !sameMonitor(app.session.monitor, monitorOf(entry))) {
            dbg(entry.label + ': a restore for another monitor is under way, leaving this window')
        } else if (rule) {
            // Still saved, so removing the rule brings restores back. On a fresh start the app's
            // other windows restore as usual; for a running app, the window occupies its monitor.
            entry.assigned = true
            log(entry.label + ': a KWin window rule places this window (' + (rule.description || rule.id) + '), leaving it to KWin')
            if (app.session || (!app.settled && startSession(entry.group, null))) {
                app.session.deadline = Math.max(app.session.deadline, Date.now() + Engine.RESTORE_TIMEOUT_MS)
            }
        } else if (app.session || startSessionFor(entry, id)) {
            joinSession(entry.group, id)
        }
        // Without a restore under way, the app is running here from this window on.
        if (!app.session) app.settled = true
    }

    // The first KWin window rule that places or sizes this window, or null. The rules file is
    // read afresh, never created or written: StandardPaths finds it only if it exists.
    function geometryRuleOf(w) {
        try {
            var url = String(StandardPaths.locate(StandardPaths.GenericConfigLocation, 'kwinrulesrc') || '')
            if (!url) return null
            var file = Qt.createQmlObject('import QtCore; Settings { location: ' + JSON.stringify(url) + ' }', root)
            try {
                var rules = Engine.parseRules(function (key) { return file.value(key, undefined) })
                rules.forEach(function (r) {
                    if (r.unreadable) logOnce('rule:' + r.id + '/' + r.unreadable, 'cannot read the regular expression of KWin window rule ' +
                        (r.description || r.id) + ' (' + r.unreadable + '): matching its plain text instead')
                })
                return Engine.geometryRuleFor(rules, {
                    resourceClass: String(w.resourceClass),
                    resourceName: String(w.resourceName || ''),
                    caption: String(w.caption || '')
                })
            } finally {
                file.destroy()
            }
        } catch (e) {
            logOnce('rules', 'reading KWin window rules failed: ' + e)
            return null
        }
    }

    // A window moved to another desktop joins that desktop's group, as a window of a running
    // app there. Leaving is not a close: the old desktop keeps its saved layout.
    function onDesktopsChanged(id) {
        var entry = tracked[id]
        if (!entry || desktopKeyOf(entry.w) === entry.desk) return
        var old = live[entry.group]
        removeFromArray(old.open, id)
        if (old.session && old.session.pending.indexOf(id) !== -1) {
            removeFromArray(old.session.pending, id)
            entry.assigned = true
            unwatchCaption(entry)
            dbg(entry.label + ': window moved to another desktop before its restore, not restoring it')
        }
        if (old.buffer.length && finalizeLeftMonitors(old)) persist()
        if (!old.open.length) delete live[entry.group]
        entry.provisional = null
        cancelPendingTile(entry)
        joinGroup(entry, id).settled = true
        dbg('window of ' + old.label + ' moved, now in ' + entry.label)
    }

    function untrack(id) {
        var entry = tracked[id]
        delete tracked[id]
        unwatchCaption(entry)
        cancelPendingTile(entry)
        disconnectSignal(entry.w, 'interactiveMoveResizeStarted', entry.moveHandler)
        disconnectSignal(entry.w, 'frameGeometryChanged', entry.geometryHandler)
        disconnectSignal(entry.w, 'tileChanged', entry.tileHandler)
        disconnectSignal(entry.w, 'desktopsChanged', entry.desktopsHandler)
        disconnectSignal(entry.w, 'outputChanged', entry.outputHandler)
        return entry
    }

    // A rect in save shape: global position plus the position on `output`.
    function geometryOf(output, x, y, width, height) {
        var relative = output ? output.mapFromGlobal(Qt.point(x, y)) : null
        return {
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(width),
            height: Math.round(height),
            output: output ? {
                x: Math.round(relative.x),
                y: Math.round(relative.y),
                serial: String(output.serialNumber || ''),
                name: String(output.name || '')
            } : null
        }
    }

    // { kind: 'quick', index, rel } | { kind: 'custom', path, rel } | null. Quick tiles have no
    // layoutDirection and sit directly under their root, in KWin's fixed creation order.
    // Custom tiles are found again by their child-index path from the root.
    function describeTile(tile) {
        if (!tile) return null
        try {
            var path = []
            for (var node = tile; node.parent; node = node.parent) {
                var siblings = node.parent.tiles || []
                var index = -1
                for (var i = 0; i < siblings.length; i++) {
                    if (siblings[i] === node) index = i
                }
                if (index === -1 || path.length >= Engine.MAX_TILE_DEPTH) return null
                path.unshift(index)
            }
            var g = tile.relativeGeometry
            var rel = {
                x: Math.round(g.x * 10000) / 10000,
                y: Math.round(g.y * 10000) / 10000,
                width: Math.round(g.width * 10000) / 10000,
                height: Math.round(g.height * 10000) / 10000
            }
            if (tile.layoutDirection === undefined) {
                return path.length === 1 && path[0] < Engine.QUICK_TILES ? { kind: 'quick', index: path[0], rel: rel } : null
            }
            return { kind: 'custom', path: path, rel: rel }
        } catch (e) {
            logOnce('tile', 'reading a tile failed: ' + e)
            return null
        }
    }

    // KWin moves the windows of a monitor that goes away to another one, and back when it
    // returns. Those moves are not the user's: while the window's own screen is missing, its
    // last geometry there (`home`) is what counts. A window the script placed on a fallback
    // screen belongs to its saved screen the same way. The user moving it ends this.
    function isAway(entry) {
        var home = entry.home && entry.home.output
        if (!home) return false
        var screens = Workspace.screens || []
        var sameSerial = []
        for (var i = 0; i < screens.length; i++) {
            if (String(screens[i].name) === home.name) return false
            if (home.serial && String(screens[i].serialNumber) === home.serial) sameSerial.push(screens[i])
        }
        // Its screen came back under another connector name (a serial no other screen shares).
        return !(sameSerial.length === 1 && entry.w.output === sameSerial[0])
    }

    // KWin's own maximize state (MaximizeRestore is 0).
    function isMaximized(w) {
        return !!w.maximizeMode
    }

    // Only records a tile, never clears one: KWin may drop the tile while it closes the
    // window, and that close must still save the tile. A floating frame clears it instead.
    function noteTile(id) {
        var entry = tracked[id]
        if (entry && entry.w.tile && !isAway(entry)) entry.tile = describeTile(entry.w.tile) || entry.tile
    }

    // KWin sets the requested tile before it moves the window into it, so tile-sized
    // frames always arrive with `tile` set and are never taken as the floating size.
    function noteGeometry(id) {
        var entry = tracked[id]
        if (!entry) return
        var w = entry.w
        try {
            if (isAway(entry)) {
                if (entry.pendingTile) quickTileWhenActive(id)
                return
            }
            var frame = geometryOf(w.output, w.x, w.y, w.width, w.height)
            entry.home = frame
            if (w.tile) {
                noteTile(id)
            } else {
                // A frame without a tile: the window left it (KWin also untiles a window it maximizes).
                entry.tile = null
                if (!w.fullScreen && w.width >= 1 && w.height >= 1 && !isMaximized(w) && (w.move || !isMaximizedLike(w))) entry.free = frame
            }
        } catch (e) {
            logOnce('geometry', 'reading window geometry failed: ' + e)
        }
        if (entry.pendingTile) quickTileWhenActive(id)
    }

    // KWin carries a tiled or maximized window's restore geometry along when it sends the window
    // to another monitor. The floating geometry follows the same way: same place on the window's
    // current monitor.
    function onCurrentMonitor(g, w) {
        var output = w.output
        if (!g || !g.output || !output || sameMonitor(g.output, monitorOf({ w: w, home: null }))) return g
        var at = output.mapToGlobal(Qt.point(g.output.x, g.output.y))
        return geometryOf(output, at.x, at.y, g.width, g.height)
    }

    // A quick tile still waiting for the window to get focus is the window's tile all the same.
    function waitingQuickTile(entry) {
        var pending = entry.pendingTile
        return pending ? { kind: 'quick', index: pending.index, rel: pending.rel || null } : null
    }

    function copyGeometry(g) {
        return { x: g.x, y: g.y, width: g.width, height: g.height, output: g.output }
    }

    function snapshotWindow(entry) {
        var w = entry.w
        try {
            if (w.fullScreen || !(w.width >= 1) || !(w.height >= 1)) return null
            var away = isAway(entry)
            var fields
            if (away) {
                fields = copyGeometry(entry.home)
                dbg(entry.label + ': closed while its screen ' + entry.home.output.name + ' is missing, saved its place there')
            } else if (isMaximized(w) && !w.tile) {
                // Maximizing is the app's and KWin's: the layout is the window's normal geometry.
                if (!entry.free) {
                    dbg(entry.label + ': closed maximized, normal geometry unknown, not saved')
                    return null
                }
                fields = copyGeometry(onCurrentMonitor(entry.free, w))
            } else {
                fields = geometryOf(w.output, w.x, w.y, w.width, w.height)
            }
            fields.caption = String(w.caption || '')
            // The tile as last seen while the window was open: on close, KWin lets go of the window
            // before scripts hear of it, and resets the quick-tile split if no quick tile is used.
            var current = away ? null : describeTile(w.tile)
            if (w.tile && !current && !away) dbg(entry.label + ': closed in a tile that could not be identified')
            fields.tile = entry.tile || current || waitingQuickTile(entry)
            fields.free = fields.tile ? (away ? entry.free : onCurrentMonitor(entry.free, w)) : null
            if (fields.tile) {
                dbg(entry.label + ': closed in ' + fields.tile.kind + ' tile ' +
                    (fields.tile.kind === 'quick' ? fields.tile.index : '[' + fields.tile.path.join(',') + ']') +
                    (fields.tile.rel ? ' at ' + Math.round(fields.tile.rel.width * 100) + '%x' + Math.round(fields.tile.rel.height * 100) + '%' : '') +
                    (current ? '' : ' (last tile seen, none at close)') +
                    (fields.free ? ', pre-tile ' + fields.free.width + 'x' + fields.free.height : ', pre-tile size unknown'))
            }
            return Engine.makeSave(fields)
        } catch (e) {
            log(entry.label + ': saving the window failed: ' + e)
            return null
        }
    }

    // The monitor a window belongs to, as a saved screen: its own while KWin keeps it on
    // another one (see isAway).
    function monitorOf(entry) {
        if (isAway(entry)) return entry.home.output
        var output = entry.w.output
        return output ? { name: String(output.name || ''), serial: String(output.serialNumber || '') } : null
    }

    // Saved screens are the same monitor when they resolve to the same connected screen, or,
    // when neither is connected, have the same name and serial.
    function sameMonitor(a, b) {
        if (!a || !b) return !a && !b
        var screenA = resolveOutput(a)
        var screenB = resolveOutput(b)
        if (screenA || screenB) return screenA === screenB
        return a.name === b.name && a.serial === b.serial
    }

    function hasWindowOn(app, monitor, except) {
        for (var i = 0; i < app.open.length; i++) {
            var other = tracked[app.open[i]]
            if (app.open[i] !== except && other && sameMonitor(monitorOf(other), monitor)) return true
        }
        return false
    }

    // Forget a window. Returns true when it was its app's last one on its monitor and new
    // saves were made.
    function releaseWindow(id) {
        var entry = tracked[id]
        var app = live[entry.group]
        removeFromArray(app.open, id)
        // A window still awaiting its restore shows the app's default placement, not the user's layout.
        var awaitingRestore = !!app.session && app.session.pending.indexOf(id) !== -1
        if (app.session) removeFromArray(app.session.pending, id)
        // Snapshot first: untrack() drops what the window was still waiting for (its quick tile).
        var snap = awaitingRestore ? null : snapshotWindow(entry)
        untrack(id)
        if (snap) {
            app.buffer.push({ closeTime: Date.now(), snap: snap, monitor: snap.output })
            if (app.buffer.length > Engine.MAX_BUFFER) app.buffer.shift()
        }
        var saved = finalizeLeftMonitors(app)
        if (!app.open.length) delete live[entry.group]
        return saved
    }

    // Saves the closes of every monitor the app has no window on any more: its last window there
    // closed, or was moved to another monitor or desktop.
    function finalizeLeftMonitors(app) {
        var monitors = []
        app.buffer.forEach(function (close) {
            if (!monitors.some(function (m) { return sameMonitor(m, close.monitor) })) monitors.push(close.monitor)
        })
        var saved = false
        monitors.forEach(function (monitor) {
            if (!hasWindowOn(app, monitor) && finalizeMonitor(app, monitor)) saved = true
        })
        return saved
    }

    // KWin reports a window's new monitor after moving it. A user move can leave a monitor without
    // windows of the app, which completes the closes buffered there.
    function onOutputChanged(id) {
        var entry = tracked[id]
        if (!entry) return
        var app = live[entry.group]
        try {
            if (app.buffer.length && finalizeLeftMonitors(app)) persist()
        } catch (e) {
            log(entry.label + ': saving after a monitor change failed: ' + e)
        }
    }

    // The windows that closed together on one monitor (each within BURST_MS of the next) become
    // that monitor's part of the app's layout on this desktop. Other monitors keep theirs.
    function finalizeMonitor(app, monitor) {
        var closed = []
        var others = []
        for (var i = 0; i < app.buffer.length; i++) {
            (sameMonitor(app.buffer[i].monitor, monitor) ? closed : others).push(app.buffer[i])
        }
        app.buffer = others
        if (!closed.length) return false
        var saves = []
        var last = closed[closed.length - 1].closeTime
        for (var j = closed.length - 1; j >= 0 && last - closed[j].closeTime <= Engine.BURST_MS; j--) {
            saves.unshift(closed[j].snap)
            last = closed[j].closeTime
        }
        var layout = Engine.layoutFor(store, app.cls, app.desk)
        var kept = []
        for (var k = 0; layout && k < layout.saves.length; k++) {
            if (!sameMonitor(layout.saves[k].output, monitor)) kept.push(layout.saves[k])
        }
        Engine.recordLayout(store, app.cls, app.desk, kept.concat(saves), Date.now())
        log(app.label + ' closed' + (monitor ? ' on ' + monitor.name : '') + ', saved ' + saves.length + ' window(s)')
        return true
    }

    // A fresh start restores the app's whole layout on this desktop, each window back on its own
    // monitor. An app already running here restores a new window only from the layout of the
    // monitor KWin opened it on, and only if the app has no other window there.
    function startSessionFor(entry, id) {
        var app = live[entry.group]
        if (!app.settled) return startSession(entry.group, null)
        var monitor = monitorOf(entry)
        return !hasWindowOn(app, monitor, id) && startSession(entry.group, monitor)
    }

    // Only the layout saved on the group's own desktop is restored: desktops are independent.
    // With `monitor`, only that monitor's part of it.
    function startSession(group, monitor) {
        var app = live[group]
        var saved = Engine.layoutFor(store, app.cls, app.desk)
        if (!saved) return false
        var saves = saved.saves
        if (monitor) {
            saves = []
            for (var i = 0; i < saved.saves.length; i++) {
                if (sameMonitor(saved.saves[i].output, monitor)) saves.push(saved.saves[i])
            }
            if (!saves.length) return false
        }
        saved.lastAccess = store.apps[app.cls].lastAccess = Date.now()
        app.session = { saves: saves, monitor: monitor, taken: [], remaining: saves.length, pending: [], deadline: 0 }
        dbg(app.label + ': restore session started - ' + saves.length + ' saved window(s)' +
            (monitor ? ' for ' + monitor.name + ', where it has no window yet' : ''))
        ensureTick()
        return true
    }

    function joinSession(group, id) {
        var session = live[group].session
        session.pending.push(id)
        session.deadline = Math.max(session.deadline, Date.now() + Engine.RESTORE_TIMEOUT_MS)
        watchCaption(id)
        tryAssign(id)
    }

    function watchCaption(id) {
        var entry = tracked[id]
        if (!entry.captionHandler) entry.captionHandler = connectSignal(entry.w, 'captionChanged', function () { tryAssign(id) })
    }

    function unwatchCaption(entry) {
        disconnectSignal(entry.w, 'captionChanged', entry.captionHandler)
        entry.captionHandler = null
    }

    function onUserMoveResize(id) {
        var entry = tracked[id]
        if (!entry || entry.userPlaced) return
        entry.userPlaced = true
        entry.provisional = null
        entry.home = null
        cancelPendingTile(entry)
        var session = live[entry.group].session
        if (entry.assigned || !session) return
        entry.assigned = true
        unwatchCaption(entry)
        removeFromArray(session.pending, id)
        log(entry.label + ': window placed by the user, not restoring it')
    }

    function matchFor(entry, session) {
        var w = entry.w
        return Engine.bestMatch(session.saves, {
            caption: String(w.caption || ''),
            width: Math.round(w.width),
            height: Math.round(w.height)
        }, session.taken)
    }

    // Unambiguous matches apply at once; the rest wait for the set to arrive or the deadline.
    function tryAssign(id) {
        var entry = tracked[id]
        if (!entry || entry.assigned) return
        var session = live[entry.group].session
        if (!session) return
        var match = matchFor(entry, session)
        if (!match || (match.tier !== 1 && session.remaining !== 1)) return
        assignSave(entry, id, session, match, false)
        if (session.remaining === 0) {
            endSession(entry.group)
        } else if (session.remaining === 1) {
            var waiting = session.pending.slice()
            for (var i = 0; i < waiting.length; i++) tryAssign(waiting[i])
        }
    }

    function assignSave(entry, id, session, match, bestEffort) {
        session.taken[match.index] = true
        session.remaining--
        entry.assigned = true
        unwatchCaption(entry)
        removeFromArray(session.pending, id)
        var moved = false
        try {
            moved = applySave(entry, id, session.saves[match.index], Date.now() + Engine.RESTORE_TIMEOUT_MS)
        } catch (e) {
            log(entry.label + ': placing the window failed: ' + e)
            return
        }
        var mode = bestEffort ? 'best effort' : (moved ? 'moved' : 'left as is')
        log(entry.label + ': restored window to saved state (' + mode + '), caption match ' + Math.round(match.score) + '%')
    }

    // Deadline: give each waiting window the best remaining save, best pair first.
    function endSession(group) {
        var app = live[group]
        var session = app.session
        for (;;) {
            var best = null
            for (var i = 0; i < session.pending.length; i++) {
                var match = matchFor(tracked[session.pending[i]], session)
                if (match && (!best || Engine.isBetterMatch(match, best.match))) best = { id: session.pending[i], match: match }
            }
            if (!best) break
            assignSave(tracked[best.id], best.id, session, best.match, true)
        }
        for (var j = 0; j < session.pending.length; j++) unwatchCaption(tracked[session.pending[j]])
        app.session = null
        app.settled = true
        dbg(app.label + ': restore session ended')
    }

    // The desktop shown on `output`: KWin 6.7 can show a different one on each monitor.
    function currentDesktopOn(output) {
        try {
            if (output && typeof Workspace.currentDesktopForScreen === 'function') return Workspace.currentDesktopForScreen(output)
        } catch (e) {}
        return Workspace.currentDesktop
    }

    function workArea(output) {
        try {
            return Workspace.clientArea(KWin.MaximizeArea, output, currentDesktopOn(output))
        } catch (e) {
            return null
        }
    }

    // Serial + name first, then a serial no other screen shares (identical monitor
    // models often report the same one), then the connector name.
    function resolveOutput(saved) {
        var screens = Workspace.screens || []
        var bySerial = []
        var byName = null
        for (var i = 0; i < screens.length; i++) {
            var serialMatch = !!saved.serial && String(screens[i].serialNumber) === saved.serial
            var nameMatch = !!saved.name && String(screens[i].name) === saved.name
            if (serialMatch && nameMatch) return screens[i]
            if (serialMatch) bySerial.push(screens[i])
            if (nameMatch && !byName) byName = screens[i]
        }
        if (bySerial.length === 1) return bySerial[0]
        return byName || bySerial[0] || null
    }

    function outputUnderCursor() {
        try {
            var at = Workspace.screenAt(Workspace.cursorPos)
            if (at) return at
        } catch (e) {}
        try {
            return Workspace.activeScreen
        } catch (e) {
            return null
        }
    }

    function isOnScreen(x, y) {
        var screens = Workspace.screens || []
        for (var i = 0; i < screens.length; i++) {
            var g = screens[i].geometry
            if (x >= g.x && x < g.x + g.width && y >= g.y && y < g.y + g.height) return true
        }
        return false
    }

    function isMaximizedLike(w) {
        try {
            var area = Workspace.clientArea(KWin.MaximizeArea, w)
            return Math.round(w.width) >= Math.round(area.width) && Math.round(w.height) >= Math.round(area.height)
        } catch (e) {
            return false
        }
    }

    // Windows that KWin, the app or the user is managing right now are never moved.
    function canPlace(w) {
        return !w.tile && !w.fullScreen && w.moveable && !w.move && !w.resize && !isMaximizedLike(w)
    }

    function fitLength(saved, min, max, limit) {
        var upper = max ? Math.min(Math.floor(max), limit) : limit
        return Math.max(min ? Math.ceil(min) : 0, Math.min(saved, upper))
    }

    // Returns { rect, provisional, output } or null. `provisional` means the saved screen is
    // missing and a fallback screen was used; the size then fits that screen.
    function targetFor(w, save) {
        var virtual = Workspace.virtualScreenGeometry
        if (!virtual || virtual.width <= 0 || virtual.height <= 0) return null
        var x = save.x
        var y = save.y
        var output = null
        var provisional = false
        if (save.output) {
            output = resolveOutput(save.output)
            if (!output) {
                output = Workspace.screens.length === 1 ? Workspace.screens[0] : outputUnderCursor()
                provisional = true
            }
            if (output) {
                var position = output.mapToGlobal(Qt.point(save.output.x, save.output.y))
                x = position.x
                y = position.y
            }
        }
        var bounds = (provisional && output && workArea(output)) || virtual
        var width = w.resizeable ? fitLength(save.width, w.minSize && w.minSize.width, w.maxSize && w.maxSize.width, bounds.width) : w.width
        var height = w.resizeable ? fitLength(save.height, w.minSize && w.minSize.height, w.maxSize && w.maxSize.height, bounds.height) : w.height
        x = Math.max(virtual.x, Math.min(x, virtual.x + virtual.width - width))
        y = Math.max(virtual.y, Math.min(y, virtual.y + virtual.height - height))
        // The virtual bounding box has gaps between unequal screens: keep the title bar reachable.
        var area = !isOnScreen(x + width / 2, y) && workArea(output || outputUnderCursor())
        if (area) {
            x = Math.max(area.x, Math.min(x, area.x + area.width - width))
            y = Math.max(area.y, Math.min(y, area.y + area.height - height))
        }
        return { rect: { x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }, provisional: provisional, output: output }
    }

    function rectEquals(w, target) {
        return Math.round(w.x) === target.x && Math.round(w.y) === target.y &&
               Math.round(w.width) === target.w && Math.round(w.height) === target.h
    }

    function setGeometry(w, rect) {
        w.frameGeometry = Qt.rect(rect.x, rect.y, rect.w, rect.h)
    }

    // Returns true when the window was moved. A provisional placement may be redone
    // until `until` if the saved screen shows up (see reapplyProvisional).
    // A tiled save first goes to its pre-tile geometry and is then tiled, so KWin keeps that
    // geometry as the one a drag out of the tile gives back. Without its saved screen or its
    // tile, it restores as plain geometry at the tile rect, as untiled saves do.
    function applySave(entry, id, save, until) {
        var w = entry.w
        if (!canPlace(w)) return false
        var tiling = restoreTiles && save.tile && w.resizeable ? planTile(entry, save) : null
        var target = targetFor(w, tiling && save.free ? save.free : save)
        // The pre-tile geometry was on a screen that is missing: start from the tile rect.
        if (target && tiling && target.provisional) target = targetFor(w, save)
        if (!target) return false
        entry.provisional = target.provisional ? { save: save, until: until } : null
        if (target.provisional) entry.home = copyGeometry(save)
        var moved = !rectEquals(w, target.rect)
        if (moved) {
            setGeometry(w, target.rect)
            for (var i = retries.length - 1; i >= 0; i--) {
                if (retries[i].id === id) retries.splice(i, 1)
            }
            retries.push({ id: id, target: target.rect, tries: 1, born: Date.now() })
            ensureTick()
        }
        if (tiling) {
            // On Wayland the frame of this write arrives after the window is tiled, so
            // noteGeometry never sees it: record the pre-tile geometry here.
            var r = target.rect
            entry.free = geometryOf(target.output || w.output, r.x, r.y, r.w, r.h)
            startTile(entry, id, tiling, until)
        }
        return moved
    }

    function rootTileFor(output, desktop) {
        try {
            if (typeof Workspace.rootTile === 'function') return Workspace.rootTile(output, desktop)
        } catch (e) {}
        try {
            return Workspace.tilingForScreen(output).rootTile
        } catch (e) {
            return null
        }
    }

    function isTileAt(tile, rel) {
        if (!tile || (tile.tiles && tile.tiles.length)) return false
        var g = tile.relativeGeometry
        var near = function (a, b) { return Math.abs(a - b) <= Engine.TILE_TOLERANCE }
        return near(g.x, rel.x) && near(g.y, rel.y) && near(g.width, rel.width) && near(g.height, rel.height)
    }

    // The saved path first; after a layout edit, any leaf tile with the same geometry.
    function findCustomTile(root, saved) {
        if (!root) return null
        var node = root
        for (var i = 0; i < saved.path.length && node; i++) node = (node.tiles || [])[saved.path[i]]
        if (isTileAt(node, saved.rel)) return node
        var queue = [root]
        while (queue.length) {
            var tile = queue.shift()
            if (isTileAt(tile, saved.rel)) return tile
            var children = tile.tiles || []
            for (var j = 0; j < children.length; j++) queue.push(children[j])
        }
        return null
    }

    // Scripts cannot ask for the quick-tile root of a screen, but a window already
    // quick-tiled on the same screen and desktop leads to it.
    function quickRootFor(w, output, desktop) {
        var windows = Workspace.stackingOrder || []
        for (var i = 0; i < windows.length; i++) {
            var other = windows[i]
            if (other === w || !other.tile || other.output !== output) continue
            if (!other.desktops || other.desktops.length !== 1 || other.desktops[0] !== desktop) continue
            var described = describeTile(other.tile)
            if (described && described.kind === 'quick') return other.tile.parent
        }
        return null
    }

    // { tile, rel? } to manage now, { quick, rel, output } to quick-tile once the window is active,
    // or null when the saved tile cannot be found.
    function planTile(entry, save) {
        try {
            var output = save.output ? resolveOutput(save.output) : entry.w.output
            if (!output) return null
            // Tile layouts are per desktop; a window on all desktops is tiled on the current one.
            var desktops = entry.w.desktops || []
            var desktop = desktops.length === 1 ? desktops[0] : currentDesktopOn(output)
            if (save.tile.kind === 'quick') {
                var root = quickRootFor(entry.w, output, desktop)
                var quick = root && root.tiles ? root.tiles[save.tile.index] : null
                return quick ? { tile: quick, rel: save.tile.rel } : { quick: save.tile.index, rel: save.tile.rel, output: output }
            }
            var tile = findCustomTile(rootTileFor(output, desktop), save.tile)
            if (!tile) log(entry.label + ': saved tile is not in the current layout, restoring plain geometry')
            return tile ? { tile: tile } : null
        } catch (e) {
            log(entry.label + ': looking up the saved tile failed: ' + e)
            return null
        }
    }

    function startTile(entry, id, tiling, until) {
        if (!tiling.tile) {
            cancelPendingTile(entry)
            var pending = { index: tiling.quick, rel: tiling.rel, output: tiling.output, until: until, handler: null }
            pending.handler = connectSignal(entry.w, 'activeChanged', function () { quickTileWhenActive(id) })
            if (!pending.handler) return
            entry.pendingTile = pending
            if (!entry.w.active) dbg(entry.label + ': waiting for the window to become active to quick-tile it')
            quickTileWhenActive(id)
            return
        }
        try {
            var managed = true
            if (typeof tiling.tile.manage === 'function') managed = tiling.tile.manage(entry.w) !== false
            else entry.w.tile = tiling.tile
            if (!managed) {
                log(entry.label + ': KWin did not accept the window into its tile')
                return
            }
            log(entry.label + ': put the window back into its tile')
            restoreQuickSplit(entry, tiling.rel)
        } catch (e) {
            log(entry.label + ': tiling the window failed: ' + e)
        }
    }

    // KWin's quick-tile action works on the active window, so it runs only once the window
    // is active by itself: focus stays native. Runs on activation and on every frame change,
    // because on Wayland a window only reaches its saved screen once its new frame arrives.
    function quickTileWhenActive(id) {
        var entry = tracked[id]
        var pending = entry && entry.pendingTile
        if (!pending) return
        var w = entry.w
        if (Date.now() > pending.until || !canPlace(w)) {
            cancelPendingTile(entry)
            dbg(entry.label + ': not quick-tiling the window, it was not active on its screen in time')
            return
        }
        if (!w.active || Workspace.activeWindow !== w || w.output !== pending.output) return
        cancelPendingTile(entry)
        try {
            Workspace[Engine.QUICK_TILE_ACTIONS[pending.index]]()
            log(entry.label + ': put the window back into its quick tile')
            restoreQuickSplit(entry, pending.rel)
        } catch (e) {
            log(entry.label + ': quick-tiling the window failed: ' + e)
        }
    }

    // KWin resets the quick-tile split once no quick tile on a screen holds a window, so a
    // resized quick tile would come back at half size. The split is shared: windows in the
    // other quick tiles follow it, as when the user resized the tile. A tile that already
    // holds another window keeps its size: a tile has one size, and that window was there first.
    function restoreQuickSplit(entry, rel) {
        var tile = entry.w.tile
        if (!rel || !tile || isTileAt(tile, rel)) return
        var windows = tile.windows || []
        for (var i = 0; i < windows.length; i++) {
            if (windows[i] !== entry.w) {
                dbg(entry.label + ': quick tile already holds another window, keeping its size')
                return
            }
        }
        try {
            tile.relativeGeometry = Qt.rect(rel.x, rel.y, rel.width, rel.height)
            dbg(entry.label + ': quick tile resized back to ' + Math.round(rel.width * 100) + '%x' + Math.round(rel.height * 100) + '%')
        } catch (e) {
            log(entry.label + ': resizing the quick tile failed: ' + e)
        }
    }

    function cancelPendingTile(entry) {
        if (!entry.pendingTile) return
        disconnectSignal(entry.w, 'activeChanged', entry.pendingTile.handler)
        entry.pendingTile = null
    }

    // A screen came or went (e.g. a monitor that finished initialising after login):
    // windows restored onto a fallback screen get another chance to reach their own.
    function reapplyProvisional() {
        var now = Date.now()
        for (var id in tracked) {
            var entry = tracked[id]
            if (!entry.provisional) continue
            if (entry.userPlaced || now > entry.provisional.until) {
                entry.provisional = null
                continue
            }
            try {
                applySave(entry, id, entry.provisional.save, entry.provisional.until)
            } catch (e) {
                log(entry.label + ': moving the window to its screen failed: ' + e)
            }
        }
    }

    function sweepRetries(now) {
        for (var i = retries.length - 1; i >= 0; i--) {
            var retry = retries[i]
            var entry = tracked[retry.id]
            try {
                if (!entry || entry.userPlaced || now - retry.born > Engine.RETRY_MAX_AGE_MS ||
                        !canPlace(entry.w) || rectEquals(entry.w, retry.target)) {
                    retries.splice(i, 1)
                } else if (retry.tries >= Engine.MAX_GEOMETRY_TRIES) {
                    dbg(entry.label + ': geometry did not stick, giving up silently (a window rule or the app owns this window)')
                    retries.splice(i, 1)
                } else {
                    retry.tries++
                    setGeometry(entry.w, retry.target)
                }
            } catch (e) {
                log((entry ? entry.label : 'window') + ': placing the window again failed: ' + e)
                retries.splice(i, 1)
            }
        }
    }

    function sweepSessions(now) {
        for (var group in live) {
            var app = live[group]
            if (!app.session || now < app.session.deadline) continue
            try {
                endSession(group)
            } catch (e) {
                log(app.label + ': ending restore session failed: ' + e)
                app.session = null
                app.settled = true
            }
        }
    }

    function isIdle() {
        if (retries.length > 0) return false
        for (var group in live) {
            if (live[group].session) return false
        }
        return true
    }

    function ensureTick() {
        if (!tickTimer.running) tickTimer.start()
    }

    function onTick() {
        var now = Date.now()
        sweepRetries(now)
        sweepSessions(now)
        if (isIdle()) tickTimer.stop()
    }

    function handleAdded(w) {
        try {
            trackWindow(w, false)
        } catch (e) {
            log('tracking a new window failed: ' + e)
        }
    }

    function handleRemoved(w) {
        try {
            var id = w ? String(w.internalId) : ''
            if (tracked[id] && releaseWindow(id)) persist()
        } catch (e) {
            log('close handling failed: ' + e)
        }
    }

    function startup() {
        loadConfig()
        loadPersisted()
        var windows = Workspace.stackingOrder
        for (var i = 0; i < windows.length; i++) {
            try {
                trackWindow(windows[i], true)
            } catch (e) {
                log('tracking an existing window failed: ' + e)
            }
        }
    }

    // Script unload or KWin exit: windows still open are saved as if they closed now,
    // so a logout, reboot or reload that never closed them keeps their layout.
    function shutdown() {
        for (var id in tracked) {
            try {
                releaseWindow(id)
            } catch (e) {
                log('saving a window on shutdown failed: ' + e)
            }
        }
        persist()
    }

    Timer {
        id: tickTimer
        interval: Engine.TICK_MS
        repeat: true
        onTriggered: root.onTick()
    }

    // The file KWin's default settings location has always given this script, named explicitly
    // so that a change of KWin's application name can't move the saved layouts.
    Settings {
        id: settings
        location: StandardPaths.writableLocation(StandardPaths.GenericConfigLocation) + '/kde.org/kwin.conf'
    }

    Connections {
        target: Workspace

        function onWindowAdded(window) {
            root.handleAdded(window)
        }

        function onWindowRemoved(window) {
            root.handleRemoved(window)
        }

        function onScreensChanged() {
            root.reapplyProvisional()
        }
    }

    Component.onCompleted: startup()

    Component.onDestruction: shutdown()
}
