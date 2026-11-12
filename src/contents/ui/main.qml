import QtQuick
import QtCore
import org.kde.kwin
import "engine.js" as Engine

// Window Geometry Restore: saves an app's window geometry (with its tile or maximized state)
// per virtual desktop and monitor when its last window there closes, and restores it when the
// app opens there again. Works with KWin, not against it: tiles and maximizing are restored
// through KWin's own calls, focus, stacking and desktops stay KWin's, windows a KWin rule places
// are left to KWin, and KWin's own moves (monitor unplugged) aren't taken for the user's layout.

Item {
    id: root

    readonly property string storeKey: 'windowgeometryrestore_windows'
    readonly property string defaultExcluded: [
        'org.kde.spectacle',
        'org.kde.polkit-kde-authentication-agent-1',
        'steam*',
        'org.kde.plasmashell',
        'kwin',
        'ksmserver',
        'kcm_kwinrules',
        'org.kde.kmenuedit',
        'org.kde.ark',
        'org.kde.plasma.emojier',
        'org.freedesktop.impl.portal.desktop.kde'
    ].join('\n')

    property bool debugMode: false
    property bool restoreTiles: true
    property var excluded: Engine.parseList('')
    // Problems already logged once (see logOnce): { key: true }
    property var reported: ({})
    // The saved data as this script last wrote it: when the file still holds it, no other KWin
    // instance wrote in between, and saving skips reading it back.
    property string lastWritten: ''
    // Persisted: { apps: { cls: { lastAccess, saves, desktops: { desktopKey: { lastAccess, saves } } } } }.
    // A desktop's layout keeps each monitor's part until the app's next close on that monitor
    // (or of a window restored from it), so a crash or power loss still restores the last layout.
    property var store: Engine.newState()
    // Runtime, per group (an app on one desktop key, see desktopKeyOf) with open windows:
    // { key, cls, desktopKey, label, open: [ids], buffer: [closes], session, settled }
    property var live: ({})
    // Runtime, per window id: { id, w, cls, desktopKey, groupKey, label, assigned, userPlaced,
    //   provisional, home, tile, free, pendingTile, and the handlers connected to the window }
    // - `home`: the window's geometry on its own monitor: the last one seen while not away (see
    //   isAway), or the saved one after a provisional placement; null once the user moves it.
    // - `tile`: the last tile seen; `free`: the last floating geometry (both save-shaped).
    // - `pendingTile`: a quick tile waiting for the window to become active.
    property var tracked: ({})
    // Geometry writes that have not stuck yet: { id, target, tries, born }
    property var retries: []

    // ---- logging and signals -------------------------------------------------------------

    // Messages carry app-chosen names and titles: control characters (a newline faking a log
    // line) are replaced.
    /**
     * @param {string} message
     */
    function log(message) {
        console.warn('WindowGeometryRestore: ' + String(message).replace(/[\x00-\x1f\x7f]/g, ' '))
    }

    /**
     * @param {string} message
     */
    function dbg(message) {
        if (debugMode) log(message)
    }

    // For problems that would repeat on every window or frame.
    /**
     * @param {string} key
     * @param {string} message
     */
    function logOnce(key, message) {
        if (reported[key]) return
        reported[key] = true
        log(message)
    }

    /**
     * @template T
     * @param {T[]} array
     * @param {T} item
     */
    function removeFromArray(array, item) {
        var index = array.indexOf(item)
        if (index !== -1) array.splice(index, 1)
    }

    // Connects `handler`, wrapped so that an error is logged under the script's name instead of
    // reaching KWin's log as an anonymous QML error. Returns what disconnectSignal needs.
    /**
     * @param {KWindow} w
     * @param {KWindowSignal} name
     * @param {KHandler} handler
     * @returns {KHandler | null}
     */
    function connectSignal(w, name, handler) {
        var guarded = function () {
            try {
                handler.apply(null, /** @type {any} */ (arguments))
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

    /**
     * @param {KWindow} w
     * @param {KWindowSignal} name
     * @param {KHandler | null} handler
     */
    function disconnectSignal(w, name, handler) {
        if (!handler) return
        try {
            w[name].disconnect(handler)
        } catch (e) {}
    }

    // ---- configuration and saved data ------------------------------------------------------

    function loadConfig() {
        debugMode = KWin.readConfig('debug', false)
        restoreTiles = KWin.readConfig('restoreTiles', true)
        // The exclusion list's config key is still the one of earlier versions.
        excluded = Engine.parseList(KWin.readConfig('blacklist', defaultExcluded))
        dbg('excluded apps: ' + (excluded.exact.length + excluded.patterns.length))
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

    // Writes the store and flushes it to disk at once. If another KWin instance wrote the file
    // since, its apps are adopted instead of erased.
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

    // ---- tracking windows ------------------------------------------------------------------

    /**
     * @param {KWindow | null} w
     * @returns {boolean}
     */
    function isValidWindow(w) {
        if (!w || w.deleted) return false
        if (!w.normalWindow || w.popupWindow || w.skipTaskbar) return false
        if (w.modal || w.transient || w.splash) return false
        if (typeof w.resourceClass !== 'string' || w.resourceClass.length === 0) return false
        return true
    }

    // The desktop a window's layout belongs to: the desktop's id when the window is on exactly
    // one desktop, '*' when it is on all or several. Ids survive logins and desktop reordering.
    /**
     * @param {KWindow} w
     * @returns {string}
     */
    function desktopKeyOf(w) {
        var desktops = w.desktops || []
        if (w.onAllDesktops || desktops.length !== 1) return '*'
        return String(desktops[0].id)
    }

    // Puts a tracked window in the group of its app on its current desktop key.
    /**
     * @param {Entry} entry
     * @returns {Group}
     */
    function joinGroup(entry) {
        var w = entry.w
        entry.desktopKey = desktopKeyOf(w)
        entry.groupKey = entry.cls + '\n' + entry.desktopKey
        // x11DesktopNumber is KWin's name for a desktop's position, on Wayland too.
        entry.label = entry.cls + (entry.desktopKey === '*' ? ' (all desktops)' : ' (desktop ' + w.desktops[0].x11DesktopNumber + ')')
        if (!live[entry.groupKey]) {
            live[entry.groupKey] = {
                key: entry.groupKey, cls: entry.cls, desktopKey: entry.desktopKey, label: entry.label,
                legacyCls: entry.resourceClass !== entry.cls ? entry.resourceClass : null,
                open: [], buffer: [], session: null, settled: false
            }
        }
        live[entry.groupKey].open.push(entry.id)
        return live[entry.groupKey]
    }

    // Takes a window out of its group when it moves to another desktop or app. Closes buffered
    // there are completed if it leaves a monitor without the app's windows. Returns whether the
    // window was still waiting for its restore in that group.
    /**
     * @param {Entry} entry
     * @returns {boolean}
     */
    function leaveGroup(entry) {
        var old = live[entry.groupKey]
        removeFromArray(old.open, entry.id)
        var waiting = !!old.session && old.session.pending.indexOf(entry.id) !== -1
        if (waiting && old.session) {
            removeFromArray(old.session.pending, entry.id)
            unwatchCaption(entry)
        }
        if (old.buffer.length && finalizeLeftMonitors(old)) persist()
        if (!old.open.length) delete live[old.key]
        entry.provisional = null
        cancelPendingTile(entry)
        return waiting
    }

    // `adopted` windows were open before the script started (reload, KWin restart):
    // they are left where they are and only saved when they close.
    /**
     * @param {KWindow} w
     * @param {boolean} adopted
     */
    function trackWindow(w, adopted) {
        if (!isValidWindow(w)) return
        var resourceClass = String(w.resourceClass)
        var named = Engine.appKeyFor(resourceClass, w.desktopFileName)
        // Either name excludes it, so lists written for window classes keep working.
        if (Engine.isListed(named, excluded) || Engine.isListed(resourceClass, excluded)) {
            dbg('ignoring excluded app: ' + named)
            return
        }
        var id = String(w.internalId)
        if (tracked[id]) return
        // KWin may name a window only after showing it: a rule matching a web app's title applies
        // once the browser sets it. A window that opens the way one did before it was renamed is
        // taken for that app from the start, so it is restored at once, as itself.
        var caption = Engine.openingTitle(w.caption)
        var predicted = adopted ? null : Engine.predictedKey(store, named, caption)
        if (predicted && Engine.isListed(predicted, excluded)) predicted = null
        var cls = predicted || named
        /** @type {Entry} */
        var entry = {
            id: id, w: w, cls: cls, resourceClass: resourceClass, desktopKey: '', groupKey: '', label: cls,
            assigned: !!adopted, userPlaced: false, provisional: null, openedAt: adopted ? 0 : Date.now(), restoredFrom: null, placedFrom: null, dialog: null, unmaximizedUntil: 0,
            openedKey: named, openingCaption: caption, learnedAs: null, learnings: 0, prediction: predicted ? { from: named, until: Date.now() + Engine.PREDICTION_MS } : null,
            home: null, tile: null, free: null, pendingTile: null,
            captionHandler: null, moveHandler: null, geometryHandler: null, tileHandler: null,
            desktopsHandler: null, outputHandler: null, desktopFileHandler: null
        }
        tracked[id] = entry
        var group = joinGroup(entry)
        entry.moveHandler = connectSignal(w, 'interactiveMoveResizeStarted', function () { onUserMoveResize(id) })
        entry.geometryHandler = connectSignal(w, 'frameGeometryChanged', function () { noteGeometry(id) })
        entry.tileHandler = connectSignal(w, 'tileChanged', function () { noteTile(id) })
        entry.desktopsHandler = connectSignal(w, 'desktopsChanged', function () { onDesktopsChanged(id) })
        entry.outputHandler = connectSignal(w, 'outputChanged', function () { onOutputChanged(id) })
        entry.desktopFileHandler = connectSignal(w, 'desktopFileNameChanged', function () { onAppKeyChanged(id) })
        noteGeometry(id)
        dbg('tracking window for ' + entry.label + (predicted ? ', opened as ' + named + ' titled "' + caption + '", as it does before KWin names it' : ''))
        if (predicted) ensureTick()
        if (!adopted) placeNewWindow(entry, group)
        // Without a restore under way, the app is running here from this window on.
        if (!group.session) group.settled = true
    }

    // A window new to its group: restored from the group's layout, unless a window rule places
    // it or a restore for another monitor is under way.
    /**
     * @param {Entry} entry
     * @param {Group} group
     */
    function placeNewWindow(entry, group) {
        // Nothing saved that this window could be restored from: no need to read the rules.
        if (!group.session && !Engine.layoutFor(store, group.cls, group.desktopKey) &&
                !(group.legacyCls && Engine.layoutFor(store, group.legacyCls, group.desktopKey))) return
        var rule = geometryRuleOf(entry.w)
        if (group.session && group.session.monitor && !sameMonitor(group.session.monitor, monitorOf(entry))) {
            dbg(entry.label + ': a restore for another monitor is under way, leaving this window')
        } else if (rule) {
            // Still saved, so removing the rule brings restores back. On a fresh start the app's
            // other windows restore as usual; for a running app, the window occupies its monitor.
            entry.assigned = true
            log(entry.label + ': a KWin window rule places this window (' + (rule.description || rule.id) + '), leaving it to KWin')
            if (!group.session && !group.settled) startSession(group, null)
            if (group.session) extendSession(group.session)
        } else if (group.session || startSessionFor(entry)) {
            joinSession(group, entry)
        }
    }

    // The first KWin window rule that places or sizes this window, or null. The rules file is
    // read afresh, never created or written: StandardPaths finds it only if it exists.
    /**
     * @param {KWindow} w
     * @returns {Rule | null}
     */
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
                // captionNormal, as KWin matches rules: without the " <2>" or "(Not Responding)" it adds.
                return Engine.geometryRuleFor(rules, {
                    resourceClass: String(w.resourceClass),
                    resourceName: String(w.resourceName || ''),
                    caption: String(w.captionNormal !== undefined ? w.captionNormal : (w.caption || ''))
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
    /**
     * @param {string} id
     */
    function onDesktopsChanged(id) {
        var entry = tracked[id]
        if (!entry || desktopKeyOf(entry.w) === entry.desktopKey) return
        var label = entry.label
        if (leaveGroup(entry)) {
            entry.assigned = true
            log(label + ': window moved to another desktop before its restore, not restoring it')
        }
        joinGroup(entry).settled = true
        dbg('window of ' + label + ' moved, now in ' + entry.label)
    }

    // KWin reports a window's new monitor after moving it. A user move can leave a monitor without
    // windows of the app, which completes the closes buffered there.
    /**
     * @param {string} id
     */
    function onOutputChanged(id) {
        var entry = tracked[id]
        if (!entry) return
        var group = live[entry.groupKey]
        try {
            if (group.buffer.length && finalizeLeftMonitors(group)) persist()
        } catch (e) {
            log(entry.label + ': saving after a monitor change failed: ' + e)
        }
    }

    /**
     * @param {Entry} entry
     */
    function untrack(entry) {
        delete tracked[entry.id]
        unwatchCaption(entry)
        cancelPendingTile(entry)
        disconnectSignal(entry.w, 'interactiveMoveResizeStarted', entry.moveHandler)
        disconnectSignal(entry.w, 'frameGeometryChanged', entry.geometryHandler)
        disconnectSignal(entry.w, 'tileChanged', entry.tileHandler)
        disconnectSignal(entry.w, 'desktopsChanged', entry.desktopsHandler)
        disconnectSignal(entry.w, 'outputChanged', entry.outputHandler)
        disconnectSignal(entry.w, 'desktopFileNameChanged', entry.desktopFileHandler)
    }

    // ---- app identity: names KWin gives late, openings learned from them ---------------------

    // KWin may give a window its desktop file name after showing it: a window rule matching its
    // title applies when the app sets the title, and an app may set its id late. The window then
    // belongs to another app. A fresh one is restored as if it had opened as that app, and a save
    // it took from the old app's restore goes back to that restore. One that has been open a
    // while, or that the user placed, only changes app.
    /**
     * @param {string} id
     */
    function onAppKeyChanged(id) {
        var entry = tracked[id]
        if (!entry) return
        var resourceClass = String(entry.w.resourceClass)
        var cls = Engine.appKeyFor(resourceClass, entry.w.desktopFileName)
        if (entry.prediction) {
            // Still named as the app it opened as: KWin hasn't named it yet.
            if (cls === entry.prediction.from) return
            entry.prediction = null
            if (cls === entry.cls) {
                dbg(entry.label + ': KWin named it as expected')
                return
            }
            // Another app opens the same way: it is learned too below, and predictedKey stops
            // guessing for an opening two apps share, instead of guessing wrong every other time.
            log(entry.label + ': KWin named the window ' + cls + ', which opens the same way; not guessing this opening any more')
        }
        if (!cls || cls === entry.cls) return
        // Renamed again: what it was named before was a step on the way, not how that app opens.
        if (entry.learnedAs && entry.learnedAs !== cls && Engine.forgetOpening(store, entry.learnedAs, entry.openedKey, entry.openingCaption)) persist()
        var label = entry.label
        var fresh = !entry.userPlaced && Date.now() - entry.openedAt < Engine.RESTORE_TIMEOUT_MS
        var from = entry.restoredFrom
        if (fresh && from && live[entry.groupKey].session === from.session) {
            from.session.taken[from.index] = false
            from.session.remaining++
        }
        var waiting = leaveGroup(entry)
        if (fresh && from) undoRestore(entry, from)
        entry.cls = cls
        entry.resourceClass = resourceClass
        entry.restoredFrom = null
        entry.placedFrom = null
        entry.dialog = null
        if (Engine.isListed(cls, excluded) || Engine.isListed(resourceClass, excluded)) {
            untrack(entry)
            dbg('window of ' + label + ' is now ' + cls + ', an excluded app: no longer tracked')
            return
        }
        var group = joinGroup(entry)
        dbg('window of ' + label + ' now belongs to ' + entry.label)
        // Renamed right after opening, untouched: its next window opening the same way is this
        // app, unless the old app's own windows have that title too.
        // At most twice per window (a name on the way, then the last): a window renaming itself
        // over and over must not fill the saved data and push out real layouts.
        if (!entry.userPlaced && entry.learnings < 2 && Date.now() - entry.openedAt < Engine.LEARN_MS && !isOwnTitle(entry.openedKey, entry.openingCaption) &&
                Engine.learnOpening(store, cls, entry.openedKey, entry.openingCaption, Date.now())) {
            entry.learnedAs = cls
            entry.learnings++
            log(entry.label + ': learned that it opens as ' + entry.openedKey + ' titled "' + entry.openingCaption + '"')
            persist()
        }
        if (fresh) {
            entry.assigned = false
            placeNewWindow(entry, group)
        } else if (waiting) {
            entry.assigned = true
        }
        if (!group.session) group.settled = true
    }

    // Whether windows of app `cls`, saved or open, have this title.
    /**
     * @param {string} cls
     * @param {string} caption
     * @returns {boolean}
     */
    function isOwnTitle(cls, caption) {
        if (Engine.captionSavedFor(store, cls, caption)) return true
        for (var id in tracked) {
            if (tracked[id].cls === cls && Engine.openingTitle(tracked[id].w.caption) === caption) return true
        }
        return false
    }

    // Puts a window back the way KWin opened it, before the old app's restore tiled, maximized
    // or moved it: otherwise the new app's restore would leave it as the old app left it.
    /**
     * @param {Entry} entry
     * @param {RestoredFrom} from
     */
    function undoRestore(entry, from) {
        var w = entry.w
        try {
            dropRetries(entry.id)
            var before = from.before
            // The app opened it maximized, or KWin tiled it: the restore didn't touch it.
            if (before.maximized || before.tile) return
            if (w.tile) {
                if (typeof w.tile.unmanage === 'function') w.tile.unmanage(w)
                else w.tile = null
            }
            if (from.save.maximized && w.maximizeMode) {
                w.setMaximize(false, false)
                // The frame stays maximized until the app follows: canPlace must not wait for it.
                entry.unmaximizedUntil = Date.now() + Engine.RETRY_MAX_AGE_MS
            }
            setGeometry(w, before)
            entry.free = null
            // The old app's place on a missing screen is not the window's own.
            entry.home = null
            entry.provisional = null
            dbg(entry.label + ': put back as KWin opened it, before restoring it as its new app')
        } catch (e) {
            log(entry.label + ': undoing the restore of its old app failed: ' + e)
        }
    }

    // ---- observing windows -----------------------------------------------------------------

    // A rect in save shape: global position plus the position on `output`.
    /**
     * @param {KOutput | null} output
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     * @returns {Geometry}
     */
    function geometryOf(output, x, y, width, height) {
        var relative = output ? output.mapFromGlobal(Qt.point(x, y)) : null
        return {
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(width),
            height: Math.round(height),
            output: output && relative ? {
                x: Math.round(relative.x),
                y: Math.round(relative.y),
                serial: String(output.serialNumber || ''),
                name: String(output.name || '')
            } : null
        }
    }

    /**
     * @param {Geometry} g
     * @returns {Geometry}
     */
    function copyGeometry(g) {
        return { x: g.x, y: g.y, width: g.width, height: g.height, output: g.output }
    }

    // { kind: 'quick', index, rel } | { kind: 'custom', path, rel } | null. Quick tiles have no
    // layoutDirection and sit directly under their root, in KWin's fixed creation order.
    // Custom tiles are found again by their child-index path from the root.
    /**
     * @param {KTile | null} tile
     * @returns {TileRef | null}
     */
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
            var round = /** @param {number} v */ function (v) { return Math.round(v * 10000) / 10000 }
            var rel = { x: round(g.x), y: round(g.y), width: round(g.width), height: round(g.height) }
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
    /**
     * @param {{ w: KWindow, home: Home | null }} entry
     * @returns {boolean}
     */
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
    /**
     * @param {KWindow} w
     * @returns {boolean}
     */
    function isMaximized(w) {
        return !!w.maximizeMode
    }

    // As large as the work area: never moved, never taken for the floating size.
    /**
     * @param {KWindow} w
     * @returns {boolean}
     */
    function isMaximizedLike(w) {
        try {
            var area = Workspace.clientArea(KWin.MaximizeArea, w)
            return Math.round(w.width) >= Math.round(area.width) && Math.round(w.height) >= Math.round(area.height)
        } catch (e) {
            return false
        }
    }

    // Only records a tile, never clears one: KWin may drop the tile while it closes the
    // window, and that close must still save the tile. A floating frame clears it instead.
    /**
     * @param {string} id
     */
    function noteTile(id) {
        var entry = tracked[id]
        if (entry && entry.w.tile && !isAway(entry)) entry.tile = describeTile(entry.w.tile) || entry.tile
    }

    // KWin sets the requested tile before it moves the window into it, so tile-sized
    // frames always arrive with `tile` set and are never taken as the floating size.
    /**
     * @param {string} id
     */
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
            // A window taken for a dialog that grew out of it (the app sized it, or the user did)
            // is the app's window after all: saved, and counted.
            if (entry.dialog && !Engine.isDialog(dialogSizeOf(w), entry.dialog.saves, [])) {
                entry.dialog = null
                dbg(entry.label + ': no longer dialog-sized, the app\'s window after all')
            }
            // Unmaximized by the script and the app has followed: maximized means maximized again.
            if (entry.unmaximizedUntil && !isMaximizedLike(w)) entry.unmaximizedUntil = 0
            if (w.tile) {
                noteTile(id)
            } else {
                // A frame without a tile: the window left it (KWin also untiles a window it maximizes).
                entry.tile = null
                // Not when screen-sized: an app opening at its maximized size, or a maximized window
                // being dragged out (its size shrinks only once the app has followed).
                // Nor while a quick tile waits: the window waits at the tile's rect, and its pre-tile
                // geometry is the one written just before tiling (see quickTileWhenActive).
                if (!w.fullScreen && w.width >= 1 && w.height >= 1 && !isMaximized(w) && !isMaximizedLike(w) && !entry.pendingTile) entry.free = frame
            }
        } catch (e) {
            logOnce('geometry', 'reading window geometry failed: ' + e)
        }
        if (entry.pendingTile) quickTileWhenActive(id)
    }

    // ---- saving closes ---------------------------------------------------------------------

    // KWin carries a tiled or maximized window's restore geometry along when it sends the window
    // to another monitor. The floating geometry follows the same way: same place on the window's
    // current monitor.
    /**
     * @param {Geometry | null} g
     * @param {KWindow} w
     * @returns {Geometry | null}
     */
    function onCurrentMonitor(g, w) {
        var output = w.output
        if (!g || !g.output || !output || sameMonitor(g.output, monitorOf({ w: w, home: null }))) return g
        var at = output.mapToGlobal(Qt.point(g.output.x, g.output.y))
        return geometryOf(output, at.x, at.y, g.width, g.height)
    }

    // A quick tile still waiting for the window to get focus is the window's tile all the same.
    /**
     * @param {Entry} entry
     * @returns {QuickTileRef | null}
     */
    function waitingQuickTile(entry) {
        var pending = entry.pendingTile
        return pending ? { kind: 'quick', index: pending.index, rel: pending.rel || null } : null
    }

    /**
     * @param {Entry} entry
     * @returns {Save | null}
     */
    function snapshotWindow(entry) {
        var w = entry.w
        try {
            if (w.fullScreen || !(w.width >= 1) || !(w.height >= 1)) return null
            // Away only with a home (see isAway).
            var home = isAway(entry) ? entry.home : null
            var away = !!home
            /** @type {SaveFields} */
            var fields
            if (home) {
                // KWin keeps a maximized window maximized on the screen it moves it to: its
                // normal geometry at home is the one to save, as for any maximized window.
                if (isMaximized(w) && !w.tile && entry.free && sameMonitor(entry.free.output, home.output)) {
                    fields = copyGeometry(entry.free)
                    fields.maximized = w.maximizeMode
                } else {
                    fields = copyGeometry(home)
                    // A provisional placement: the save it came from, maximized or tiled.
                    fields.maximized = home.maximized || 0
                }
                dbg(entry.label + ': closed while its screen ' + (home.output ? home.output.name : '') + ' is missing, saved its place there')
            } else if (isMaximized(w) && !w.tile) {
                // Saved as its normal geometry, to maximize it with again (see applyMaximized).
                if (!entry.free) {
                    dbg(entry.label + ': closed maximized, normal geometry unknown, not saved')
                    return null
                }
                fields = copyGeometry(/** @type {Geometry} */ (onCurrentMonitor(entry.free, w)))
                fields.maximized = w.maximizeMode
            } else {
                fields = geometryOf(w.output, w.x, w.y, w.width, w.height)
            }
            fields.caption = String(w.caption || '').slice(0, Engine.MAX_CAPTION)
            // The tile as last seen while the window was open: on close, KWin lets go of the window
            // before scripts hear of it, and resets the quick-tile split if no quick tile is used.
            var current = away ? null : describeTile(w.tile)
            if (w.tile && !current && !away) dbg(entry.label + ': closed in a tile that could not be identified')
            var tile = entry.tile || current || waitingQuickTile(entry) || (home && home.tile) || null
            fields.tile = tile
            fields.free = tile ? (home ? (home.tile ? home.free : entry.free) : onCurrentMonitor(entry.free, w)) : null
            if (tile) {
                dbg(entry.label + ': closed in ' + tile.kind + ' tile ' +
                    (tile.kind === 'quick' ? tile.index : '[' + tile.path.join(',') + ']') +
                    (tile.rel ? ' at ' + percentText(tile.rel) : '') +
                    (current ? '' : ' (last tile seen, none at close)') +
                    (fields.free ? ', pre-tile ' + fields.free.width + 'x' + fields.free.height : ', pre-tile size unknown'))
            }
            return Engine.makeSave(fields)
        } catch (e) {
            log(entry.label + ': saving the window failed: ' + e)
            return null
        }
    }

    // Forgets a window. Returns true when new saves were made: it was the app's last window on
    // its monitor.
    /**
     * @param {string} id
     * @returns {boolean}
     */
    function releaseWindow(id) {
        var entry = tracked[id]
        var group = live[entry.groupKey]
        removeFromArray(group.open, id)
        // A window still awaiting its restore shows the app's default placement, not the user's layout.
        // Nor a window taken for an app KWin hasn't confirmed: it may belong to another.
        // Nor a dialog without a parent (see matchFor): its place isn't the app's layout.
        var skipSave = !!entry.prediction || !!entry.dialog || (!!group.session && group.session.pending.indexOf(id) !== -1)
        if (group.session) removeFromArray(group.session.pending, id)
        // Snapshot first: untrack() drops what the window was still waiting for (its quick tile).
        var snap = null
        try {
            snap = skipSave ? null : snapshotWindow(entry)
        } finally {
            untrack(entry)
        }
        if (snap) {
            group.buffer.push({ closeTime: Date.now(), snap: snap, monitor: snap.output, from: entry.placedFrom })
            if (group.buffer.length > Engine.MAX_BUFFER) group.buffer.shift()
        }
        var saved = finalizeLeftMonitors(group)
        if (!group.open.length) delete live[group.key]
        return saved
    }

    // Saves the closes of every monitor the app has no window on any more: its last window there
    // closed, or was moved to another monitor or desktop.
    /**
     * @param {Group} group
     * @returns {boolean}
     */
    function finalizeLeftMonitors(group) {
        /** @type {(SavedScreen | null)[]} */
        var monitors = []
        group.buffer.forEach(function (close) {
            if (!monitors.some(function (m) { return sameMonitor(m, close.monitor) })) monitors.push(close.monitor)
        })
        var saved = false
        monitors.forEach(function (monitor) {
            if (!hasWindowOn(group, monitor) && finalizeMonitor(group, monitor)) saved = true
        })
        return saved
    }

    // The windows that closed together on one monitor (each within BURST_MS of the next) become
    // that monitor's part of the app's layout on this desktop. Other monitors keep theirs, except
    // the saves these windows were restored from: a window moved here keeps no save where it left.
    /**
     * @param {Group} group
     * @param {SavedScreen | null} monitor
     * @returns {boolean}
     */
    function finalizeMonitor(group, monitor) {
        /** @type {Close[]} */
        var closed = []
        /** @type {Close[]} */
        var others = []
        for (var i = 0; i < group.buffer.length; i++) {
            (sameMonitor(group.buffer[i].monitor, monitor) ? closed : others).push(group.buffer[i])
        }
        group.buffer = others
        if (!closed.length) return false
        /** @type {Save[]} */
        var saves = []
        // The saves these windows were placed from: each is replaced by the window's new save.
        // Only for closes kept here, or a window would lose its old save and its new one.
        /** @type {Save[]} */
        var replaced = []
        var last = closed[closed.length - 1].closeTime
        for (var j = closed.length - 1; j >= 0 && last - closed[j].closeTime <= Engine.BURST_MS; j--) {
            saves.unshift(closed[j].snap)
            var from = closed[j].from
            if (from) replaced.push(from)
            last = closed[j].closeTime
        }
        var layout = Engine.layoutFor(store, group.cls, group.desktopKey)
        var kept = []
        for (var k = 0; layout && k < layout.saves.length; k++) {
            var save = layout.saves[k]
            if (sameMonitor(save.output, monitor)) continue
            // By identity: the store keeps a layout's save objects while the script runs (recordLayout
            // and the sessions reuse them). A monitor the app still has windows on keeps them until
            // its own closes rewrite it, so a crash meanwhile loses nothing.
            if (replaced.indexOf(save) !== -1 && !hasWindowOn(group, save.output)) {
                dbg(group.label + ': dropped the save on ' + (save.output ? save.output.name : 'no screen') + ' of a window moved away from it')
                continue
            }
            kept.push(save)
        }
        Engine.recordLayout(store, group.cls, group.desktopKey, kept.concat(saves), Date.now())
        log(group.label + ' closed' + (monitor ? ' on ' + monitor.name : '') + ', saved ' + saves.length + ' window(s)')
        return true
    }

    // ---- screens and monitors --------------------------------------------------------------

    // Serial + name first, then a serial no other screen shares (identical monitor
    // models often report the same one), then the connector name.
    /**
     * @param {MonitorRef} saved
     * @returns {KOutput | null}
     */
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

    // The monitor a window belongs to, as a saved screen: its own while KWin keeps it on
    // another one (see isAway).
    /**
     * @param {{ w: KWindow, home: Home | null }} entry
     * @returns {MonitorRef | null}
     */
    function monitorOf(entry) {
        // Away only with a home (see isAway).
        if (entry.home && isAway(entry)) return entry.home.output
        var output = entry.w.output
        return output ? { name: String(output.name || ''), serial: String(output.serialNumber || '') } : null
    }

    // Saved screens are the same monitor when they resolve to the same connected screen, or,
    // when neither is connected, have the same name and serial.
    /**
     * @param {MonitorRef | null} a
     * @param {MonitorRef | null} b
     * @returns {boolean}
     */
    function sameMonitor(a, b) {
        if (!a || !b) return !a && !b
        var screenA = resolveOutput(a)
        var screenB = resolveOutput(b)
        if (screenA || screenB) return screenA === screenB
        return a.name === b.name && a.serial === b.serial
    }

    // Whether the app has a window open on `monitor` (undefined: on any; null is a save's "no
    // screen"). A dialog without a parent (see matchFor) doesn't count: the app's window still
    // gets restored.
    /**
     * @param {Group} group
     * @param {MonitorRef | null | undefined} monitor
     * @param {string} [exceptId]
     * @returns {boolean}
     */
    function hasWindowOn(group, monitor, exceptId) {
        for (var i = 0; i < group.open.length; i++) {
            var other = tracked[group.open[i]]
            if (group.open[i] === exceptId || !other || other.dialog) continue
            if (monitor === undefined || sameMonitor(monitorOf(other), monitor)) return true
        }
        return false
    }

    // The desktop shown on `output`: KWin 6.7 can show a different one on each monitor.
    /**
     * @param {KOutput | null} output
     * @returns {KVirtualDesktop}
     */
    function currentDesktopOn(output) {
        try {
            if (output && typeof Workspace.currentDesktopForScreen === 'function') return Workspace.currentDesktopForScreen(output)
        } catch (e) {}
        return Workspace.currentDesktop
    }

    /**
     * @param {KOutput | null} output
     * @returns {KRect | null}
     */
    function workArea(output) {
        try {
            return Workspace.clientArea(KWin.MaximizeArea, output, currentDesktopOn(output))
        } catch (e) {
            return null
        }
    }

    /**
     * @returns {KOutput | null}
     */
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

    /**
     * @param {number} x
     * @param {number} y
     * @returns {boolean}
     */
    function isOnScreen(x, y) {
        var screens = Workspace.screens || []
        for (var i = 0; i < screens.length; i++) {
            var g = screens[i].geometry
            if (x >= g.x && x < g.x + g.width && y >= g.y && y < g.y + g.height) return true
        }
        return false
    }

    // ---- restore sessions ------------------------------------------------------------------

    // A fresh start restores the app's whole layout on this desktop, each window back on its own
    // monitor. An app already running here restores a new window only from the layout of the
    // monitor KWin opened it on, and only if the app has no other window there.
    // An app with only dialogs open (see matchFor) hasn't started yet: a fresh start.
    /**
     * @param {Entry} entry
     * @returns {boolean}
     */
    function startSessionFor(entry) {
        var group = live[entry.groupKey]
        if (!group.settled || !hasWindowOn(group, undefined, entry.id)) return startSession(group, null)
        var monitor = monitorOf(entry)
        return !hasWindowOn(group, monitor, entry.id) && startSession(group, monitor)
    }

    // Only the layout saved on the group's own desktop is restored: desktops are independent.
    // With `monitor`, only that monitor's part of it.
    // An app keyed by its desktop file name that has nothing saved under that key yet (saved by
    // a version that keyed by window class) restores once from its class's layout, read only.
    // A web app shared that layout with its browser: only windows whose caption matches take a
    // save from it.
    /**
     * @param {Group} group
     * @param {MonitorRef | null} monitor
     * @returns {boolean}
     */
    function startSession(group, monitor) {
        var saved = Engine.layoutFor(store, group.cls, group.desktopKey)
        var legacy = !saved && !!group.legacyCls && !Engine.hasLayouts(store.apps[group.cls])
        if (legacy && group.legacyCls) saved = Engine.layoutFor(store, group.legacyCls, group.desktopKey)
        if (!saved) return false
        var saves = saved.saves
        if (monitor) {
            saves = []
            for (var i = 0; i < saved.saves.length; i++) {
                if (sameMonitor(saved.saves[i].output, monitor)) saves.push(saved.saves[i])
            }
            if (!saves.length) return false
        }
        if (!legacy) saved.lastAccess = store.apps[group.cls].lastAccess = Date.now()
        group.session = {
            saves: saves, monitor: monitor, taken: [], remaining: saves.length, pending: [], deadline: 0,
            captionOnly: legacy && Engine.isSubApp(group.cls, group.legacyCls)
        }
        dbg(group.label + ': restore session started - ' + saves.length + ' saved window(s)' +
            (monitor ? ' for ' + monitor.name + ', where it has no window yet' : '') +
            (legacy ? ' saved under ' + group.legacyCls + ' by an earlier version' : ''))
        ensureTick()
        return true
    }

    /**
     * @param {Session} session
     */
    function extendSession(session) {
        session.deadline = Math.max(session.deadline, Date.now() + Engine.RESTORE_TIMEOUT_MS)
    }

    /**
     * @param {Group} group
     */
    function closeSession(group) {
        group.session = null
        group.settled = true
    }

    /**
     * @param {Group} group
     * @param {Entry} entry
     */
    function joinSession(group, entry) {
        // Called once a session runs (placeNewWindow).
        var session = /** @type {Session} */ (group.session)
        session.pending.push(entry.id)
        extendSession(session)
        watchCaption(entry)
        tryAssign(entry.id)
    }

    /**
     * @param {Entry} entry
     */
    function watchCaption(entry) {
        if (!entry.captionHandler) entry.captionHandler = connectSignal(entry.w, 'captionChanged', function () { tryAssign(entry.id) })
    }

    /**
     * @param {Entry} entry
     */
    function unwatchCaption(entry) {
        disconnectSignal(entry.w, 'captionChanged', entry.captionHandler)
        entry.captionHandler = null
    }

    /**
     * @param {string} id
     */
    function onUserMoveResize(id) {
        var entry = tracked[id]
        if (!entry || entry.userPlaced) return
        entry.userPlaced = true
        entry.provisional = null
        entry.home = null
        cancelPendingTile(entry)
        var session = live[entry.groupKey].session
        if (entry.assigned || !session) return
        entry.assigned = true
        unwatchCaption(entry)
        removeFromArray(session.pending, id)
        log(entry.label + ': window placed by the user, not restoring it')
    }

    // A window's size as Engine.isDialog reads it.
    /**
     * @param {KWindow} w
     * @returns {DialogSize}
     */
    function dialogSizeOf(w) {
        return {
            width: Math.round(w.width),
            height: Math.round(w.height),
            clientWidth: Math.round(w.clientGeometry ? w.clientGeometry.width : w.width),
            minWidth: w.minSize ? Math.round(w.minSize.width) : 0
        }
    }

    // `scores` (optional): this window's caption scores against the session's saves, kept by a
    // caller that matches it again (endSession).
    /**
     * @param {Entry} entry
     * @param {Session} session
     * @param {number[]} [scores]
     * @returns {Match | null}
     */
    function matchFor(entry, session, scores) {
        var w = entry.w
        var caption = String(w.caption || '').slice(0, Engine.MAX_CAPTION)
        scores = scores || []
        var taken = session.taken
        var candidates = 0
        if (session.captionOnly) {
            // The class's layout holds another app's windows (the browser of a web app):
            // only a caption tells them apart, so saves with another caption are out.
            taken = session.taken.slice()
            for (var i = 0; i < session.saves.length; i++) {
                if (taken[i]) continue
                if (scores[i] === undefined) scores[i] = Engine.captionScore(session.saves[i].caption, caption)
                if (scores[i] < Engine.CAPTION_FALLBACK) taken[i] = true
                else candidates++
            }
        }
        // Not the app's window but a dialog shown without a parent (Engine.isDialog): Gecko's
        // primary-password prompt opens that way before the main window, and took the main
        // window's maximized or tiled state, then saved it as the app's layout. Judged against
        // the saves this window could take; noteGeometry looks again when its size changes.
        var size = dialogSizeOf(w)
        if (Engine.isDialog(size, session.saves, taken)) {
            if (!entry.dialog) log(entry.label + ': "' + caption + '" is a dialog-sized window (much smaller than the ' +
                'app\'s saved windows, at its minimum width): left as it is, not saved')
            entry.dialog = { saves: session.saves.filter(function (s, i) { return !taken[i] }) }
            return null
        }
        var match = Engine.bestMatch(session.saves, { caption: caption, width: size.width, height: size.height }, taken, scores)
        // A save after all (its title or size changed): the app's window.
        if (match) entry.dialog = null
        // The other app's saves never arrive: one save left for this caption is a clear match.
        if (match) match.only = candidates === 1
        return match
    }

    // Unambiguous matches apply at once; the rest wait for the set to arrive or the deadline.
    /**
     * @param {string} id
     */
    function tryAssign(id) {
        var entry = tracked[id]
        if (!entry || entry.assigned) return
        var group = live[entry.groupKey]
        var session = group.session
        if (!session) return
        var match = matchFor(entry, session)
        if (!match || (match.tier !== 1 && session.remaining !== 1 && !match.only)) return
        assignSave(entry, session, match, false)
        if (session.remaining === 0) {
            endSession(group)
        } else if (session.remaining === 1) {
            var waiting = session.pending.slice()
            for (var i = 0; i < waiting.length; i++) tryAssign(waiting[i])
        }
    }

    /**
     * @param {Entry} entry
     * @param {Session} session
     * @param {Match} match
     * @param {boolean} bestEffort
     */
    function assignSave(entry, session, match, bestEffort) {
        session.taken[match.index] = true
        session.remaining--
        entry.assigned = true
        var w = entry.w
        // What the window was like before: an undo (see undoRestore) reverts only what changed.
        entry.restoredFrom = {
            session: session, index: match.index, save: session.saves[match.index],
            before: { x: w.x, y: w.y, w: w.width, h: w.height, maximized: w.maximizeMode || 0, tile: w.tile || null }
        }
        unwatchCaption(entry)
        removeFromArray(session.pending, entry.id)
        var moved = false
        try {
            moved = applySave(entry, session.saves[match.index], Date.now() + Engine.RESTORE_TIMEOUT_MS)
        } catch (e) {
            log(entry.label + ': placing the window failed: ' + e)
            return
        }
        var mode = bestEffort ? 'best effort' : (moved ? 'moved' : 'left as is')
        log(entry.label + ': restored window to saved state (' + mode + '), caption match ' + Math.round(match.score) + '%')
    }

    // Deadline: give each waiting window the best remaining save, best pair first.
    /**
     * @param {Group} group
     */
    function endSession(group) {
        // Called for a running session (tryAssign, sweepSessions).
        var session = /** @type {Session} */ (group.session)
        // Caption scores don't change while the sweep runs: each pair is scored once.
        /** @type {Record<string, number[]>} */
        var scores = {}
        for (;;) {
            var best = null
            for (var i = 0; i < session.pending.length; i++) {
                var id = session.pending[i]
                var match = matchFor(tracked[id], session, scores[id] || (scores[id] = []))
                if (match && (!best || Engine.isBetterMatch(match, best.match))) best = { id: session.pending[i], match: match }
            }
            if (!best) break
            assignSave(tracked[best.id], session, best.match, true)
        }
        for (var j = 0; j < session.pending.length; j++) unwatchCaption(tracked[session.pending[j]])
        closeSession(group)
        dbg(group.label + ': restore session ended')
    }

    // ---- placement -------------------------------------------------------------------------

    // Windows that KWin, the app or the user is managing right now are never moved. A window
    // the script just unmaximized still shows its maximized frame until the app follows.
    /**
     * @param {KWindow} w
     * @returns {boolean}
     */
    function canPlace(w) {
        var entry = tracked[String(w.internalId)]
        var unmaximized = !!entry && entry.unmaximizedUntil > Date.now()
        return !w.tile && !w.fullScreen && w.moveable && !w.move && !w.resize && (unmaximized || !isMaximizedLike(w))
    }

    /**
     * @param {number} saved
     * @param {number | undefined} min
     * @param {number | undefined} max
     * @param {number} limit
     * @returns {number}
     */
    function fitLength(saved, min, max, limit) {
        var upper = max ? Math.min(Math.floor(max), limit) : limit
        return Math.max(min ? Math.ceil(min) : 0, Math.min(saved, upper))
    }

    // Returns { rect, provisional, output } or null. `provisional` means the saved screen is
    // missing and a fallback screen was used; the size then fits that screen.
    /**
     * @param {KWindow} w
     * @param {Geometry} save
     * @returns {Target | null}
     */
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

    /**
     * @param {KWindow} w
     * @param {PixelRect} target
     * @returns {boolean}
     */
    function rectEquals(w, target) {
        return Math.round(w.x) === target.x && Math.round(w.y) === target.y &&
               Math.round(w.width) === target.w && Math.round(w.height) === target.h
    }

    /**
     * @param {string} id
     */
    function dropRetries(id) {
        for (var i = retries.length - 1; i >= 0; i--) {
            if (retries[i].id === id) retries.splice(i, 1)
        }
    }

    /**
     * @param {KWindow} w
     * @param {PixelRect} rect
     */
    function setGeometry(w, rect) {
        w.frameGeometry = Qt.rect(rect.x, rect.y, rect.w, rect.h)
    }

    // Returns true when the window was moved. A provisional placement may be redone
    // until `until` if the saved screen shows up (see reapplyProvisional).
    // A tiled save first goes to its pre-tile geometry and is then tiled, so KWin keeps that
    // geometry as the one a drag out of the tile gives back. Without its saved screen or its
    // tile, it restores as plain geometry at the tile rect, as untiled saves do.
    /**
     * @param {Entry} entry
     * @param {Save} save
     * @param {number} until
     * @returns {boolean}
     */
    function applySave(entry, save, until) {
        var w = entry.w
        if (save.maximized && w.maximizable) return applyMaximized(entry, save, until)
        if (!canPlace(w)) return false
        var tiling = restoreTiles && save.tile && w.resizeable ? planTile(entry, save) : null
        var free = tiling && save.free ? targetFor(w, save.free) : null
        // The pre-tile geometry was on a screen that is missing: start from the tile rect.
        if (free && free.provisional) free = null
        // A quick tile waiting for the window to become active: the window waits at the tile's
        // rect, so it doesn't show at its floating geometry first (see quickTileWhenActive).
        var target = free && tiling && tiling.tile ? free : targetFor(w, save)
        if (!target) return false
        entry.provisional = target.provisional ? { save: save, until: until } : null
        if (target.provisional) entry.home = save // the whole save: maximized and tile included
        // Placed on the save's own monitor: a close elsewhere takes this save along (issue #8).
        // Not when its monitor is missing: the window didn't leave it, the script couldn't get there.
        entry.placedFrom = target.provisional ? null : save
        var moved = !rectEquals(w, target.rect)
        if (moved) {
            setGeometry(w, target.rect)
            dropRetries(entry.id)
            retries.push({ id: entry.id, target: target.rect, tries: 1, born: Date.now() })
            ensureTick()
        }
        if (tiling) {
            // On Wayland the frame of this write arrives after the window is tiled, so
            // noteGeometry never sees it: record the pre-tile geometry here.
            var pre = free || target
            var r = pre.rect
            entry.free = geometryOf(pre.output || w.output, r.x, r.y, r.w, r.h)
            tiling.free = free ? free.rect : null
            startTile(entry, tiling, until)
        }
        return moved
    }

    // A window closed maximized comes back maximized by KWin, with its normal geometry as the one
    // to return to (a drag out, the maximize button). Apps that reopen maximized, or at their
    // maximized size, by themselves leave KWin without that geometry otherwise. KWin takes a
    // restore geometry only when the maximize state changes, so a window that is maximized
    // already is unmaximized first; KWin configures the app once, for the final state.
    /**
     * @param {Entry} entry
     * @param {Save} save
     * @param {number} until
     * @returns {boolean}
     */
    function applyMaximized(entry, save, until) {
        var w = entry.w
        if (w.tile || w.fullScreen || w.move || w.resize) return false
        var target = targetFor(w, save)
        if (!target) return false
        entry.provisional = target.provisional ? { save: save, until: until } : null
        if (target.provisional) entry.home = save // the whole save: maximized and tile included
        // Placed on the save's own monitor: a close elsewhere takes this save along (issue #8).
        // Not when its monitor is missing: the window didn't leave it, the script couldn't get there.
        entry.placedFrom = target.provisional ? null : save
        var r = target.rect
        if (w.maximizeMode) w.setMaximize(false, false)
        setGeometry(w, r) // onto its monitor: KWin maximizes the window where it is
        w.setMaximize(!!(save.maximized & 1), !!(save.maximized & 2), Qt.rect(r.x, r.y, r.w, r.h))
        entry.free = geometryOf(target.output || w.output, r.x, r.y, r.w, r.h)
        log(entry.label + ': maximized again, ' + r.w + 'x' + r.h + ' to return to')
        return true
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
                applySave(entry, entry.provisional.save, entry.provisional.until)
            } catch (e) {
                log(entry.label + ': moving the window to its screen failed: ' + e)
            }
        }
    }

    // ---- tiles -----------------------------------------------------------------------------

    /**
     * @param {Rel} rel
     * @returns {string}
     */
    function percentText(rel) {
        return Math.round(rel.width * 100) + '%x' + Math.round(rel.height * 100) + '%'
    }

    /**
     * @param {KOutput} output
     * @param {KVirtualDesktop} desktop
     * @returns {KTile | null}
     */
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

    /**
     * @param {KTile | null | undefined} tile
     * @param {Rel} rel
     * @returns {boolean}
     */
    function isTileAt(tile, rel) {
        if (!tile || (tile.tiles && tile.tiles.length)) return false
        var g = tile.relativeGeometry
        var near = /** @param {number} a @param {number} b */ function (a, b) { return Math.abs(a - b) <= Engine.TILE_TOLERANCE }
        return near(g.x, rel.x) && near(g.y, rel.y) && near(g.width, rel.width) && near(g.height, rel.height)
    }

    // The saved path first; after a layout edit, any leaf tile with the same geometry.
    /**
     * @param {KTile | null} root
     * @param {CustomTileRef} saved
     * @returns {KTile | null}
     */
    function findCustomTile(root, saved) {
        if (!root) return null
        /** @type {KTile | null | undefined} */
        var node = root
        for (var i = 0; i < saved.path.length && node; i++) node = (node.tiles || [])[saved.path[i]]
        if (node && isTileAt(node, saved.rel)) return node
        var queue = [root]
        while (queue.length) {
            var tile = /** @type {KTile} */ (queue.shift()) // the queue isn't empty
            if (isTileAt(tile, saved.rel)) return tile
            var children = tile.tiles || []
            for (var j = 0; j < children.length; j++) queue.push(children[j])
        }
        return null
    }

    // Scripts cannot ask for the quick-tile root of a screen, but a window already
    // quick-tiled on the same screen and desktop leads to it.
    /**
     * @param {KWindow} w
     * @param {KOutput} output
     * @param {KVirtualDesktop} desktop
     * @returns {KTile | null}
     */
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
    /**
     * @param {Entry} entry
     * @param {Save} save
     * @returns {Tiling | null}
     */
    function planTile(entry, save) {
        try {
            var output = save.output ? resolveOutput(save.output) : entry.w.output
            if (!output) return null
            // Tile layouts are per desktop; a window on all desktops is tiled on the one its monitor shows.
            var desktops = entry.w.desktops || []
            var desktop = desktops.length === 1 ? desktops[0] : currentDesktopOn(output)
            var saved = save.tile
            if (!saved) return null
            if (saved.kind === 'quick') {
                var root = quickRootFor(entry.w, output, desktop)
                var quick = root && root.tiles ? root.tiles[saved.index] : null
                return quick ? { tile: quick, rel: saved.rel } : { quick: saved.index, rel: saved.rel, output: output }
            }
            var tile = findCustomTile(rootTileFor(output, desktop), saved)
            if (!tile) log(entry.label + ': saved tile is not in the current layout, restoring plain geometry')
            return tile ? { tile: tile } : null
        } catch (e) {
            log(entry.label + ': looking up the saved tile failed: ' + e)
            return null
        }
    }

    /**
     * @param {Entry} entry
     * @param {Tiling} tiling
     * @param {number} until
     */
    function startTile(entry, tiling, until) {
        if (!tiling.tile) {
            cancelPendingTile(entry)
            /** @type {PendingTile} */
            var pending = { index: tiling.quick, rel: tiling.rel, output: tiling.output, free: tiling.free || null, until: until, handler: null }
            pending.handler = connectSignal(entry.w, 'activeChanged', function () { quickTileWhenActive(entry.id) })
            if (!pending.handler) return
            entry.pendingTile = pending
            if (!entry.w.active) dbg(entry.label + ': waiting for the window to become active to quick-tile it')
            quickTileWhenActive(entry.id)
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
    /**
     * @param {string} id
     */
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
            // The pre-tile geometry goes in just before tiling: KWin keeps the requested
            // geometry for a drag out of the tile, and the app is only asked for the tile.
            dropRetries(entry.id)
            if (pending.free && !rectEquals(w, pending.free)) setGeometry(w, pending.free)
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
    /**
     * @param {Entry} entry
     * @param {Rel | null | undefined} rel
     */
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
            dbg(entry.label + ': quick tile resized back to ' + percentText(rel))
        } catch (e) {
            log(entry.label + ': resizing the quick tile failed: ' + e)
        }
    }

    /**
     * @param {Entry} entry
     */
    function cancelPendingTile(entry) {
        if (!entry.pendingTile) return
        disconnectSignal(entry.w, 'activeChanged', entry.pendingTile.handler)
        entry.pendingTile = null
    }

    // ---- timer: retries, session deadlines, unconfirmed guesses -----------------------------

    /**
     * @param {number} now
     */
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

    /**
     * @param {number} now
     */
    function sweepSessions(now) {
        for (var key in live) {
            var group = live[key]
            if (!group.session || now < group.session.deadline) continue
            try {
                endSession(group)
            } catch (e) {
                log(group.label + ': ending restore session failed: ' + e)
                closeSession(group)
            }
        }
    }

    // A window taken for an app it opens as, but that KWin didn't name so in time: it is that
    // app after all, and the opening is forgotten.
    /**
     * @param {number} now
     */
    function sweepPredictions(now) {
        for (var id in tracked) {
            var entry = tracked[id]
            if (!entry.prediction || now < entry.prediction.until) continue
            try {
                Engine.forgetOpening(store, entry.cls, entry.prediction.from, entry.openingCaption)
                log(entry.label + ': KWin did not name the window as learned; it is ' + entry.prediction.from + ' after all, left where it is')
                entry.prediction = null
                persist()
                onAppKeyChanged(id)
            } catch (e) {
                log(entry.label + ': correcting a mistaken app failed: ' + e)
                entry.prediction = null
            }
        }
    }

    /**
     * @returns {boolean}
     */
    function isIdle() {
        if (retries.length > 0) return false
        for (var id in tracked) {
            if (tracked[id].prediction) return false
        }
        for (var key in live) {
            if (live[key].session) return false
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
        sweepPredictions(now)
        if (isIdle()) tickTimer.stop()
    }

    // ---- KWin events -----------------------------------------------------------------------

    /**
     * @param {KWindow} w
     */
    function handleAdded(w) {
        try {
            trackWindow(w, false)
        } catch (e) {
            log('tracking a new window failed: ' + e)
        }
    }

    /**
     * @param {KWindow | null} w
     */
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
        try {
            loadPersisted()
        } catch (e) {
            log('loading saved window data failed: ' + e)
        }
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
