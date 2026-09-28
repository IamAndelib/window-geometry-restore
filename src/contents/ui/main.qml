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
    property var blacklist: Engine.parseList('')
    // Persisted: { apps: { cls: { lastAccess, saves } } }. Saves stay until replaced
    // by the app's next close, so a crash or power loss still restores the last layout.
    property var store: Engine.newState()
    // Runtime, per app with open windows: { open: [ids], buffer: [closes], session, settled }
    property var live: ({})
    // Runtime, per window id: { w, cls, assigned, userPlaced, provisional, captionHandler, moveHandler }
    property var tracked: ({})
    // Geometry writes that have not stuck yet: { id, target, tries, born }
    property var retries: []

    function log(message) {
        console.warn('WindowGeometryRestore: ' + message)
    }

    function dbg(message) {
        if (debugMode) log(message)
    }

    function removeFromArray(array, item) {
        var index = array.indexOf(item)
        if (index !== -1) array.splice(index, 1)
    }

    function connectSignal(w, name, handler) {
        try {
            w[name].connect(handler)
            return handler
        } catch (e) {
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
        blacklist = Engine.parseList(KWin.readConfig('blacklist', defaultBlacklist))
        dbg('blacklist entries: ' + (blacklist.exact.length + blacklist.patterns.length))
    }

    function loadPersisted() {
        var raw = settings.value(storeKey, '{}')
        var result = Engine.decodeState(raw)
        if (result.error) {
            log('saved window data unreadable (' + result.error + ') - kept a copy, starting fresh')
            settings.setValue(storeKey + '_corrupt', String(raw))
        }
        store = result.state
        var removed = Engine.pruneExpired(store, Date.now())
        var count = 0
        for (var cls in store.apps) count += store.apps[cls].saves.length
        log('loaded ' + count + ' saved window(s) for ' + Object.keys(store.apps).length + ' app(s)' +
            (removed > 0 ? ', pruned ' + removed + ' expired app(s)' : ''))
        if (removed > 0 || result.error) persist()
    }

    // Write the store and flush it to disk at once. sync() first reloads the file,
    // so apps saved by another KWin instance are adopted instead of erased.
    function persist() {
        try {
            settings.sync()
            var disk = Engine.decodeState(settings.value(storeKey, '{}'))
            if (!disk.error) Engine.mergeDiskApps(store, disk.state)
            Engine.pruneExpired(store, Date.now())
            settings.setValue(storeKey, Engine.encodeState(store))
            settings.sync()
        } catch (e) {
            log('failed to persist: ' + e)
        }
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
        if (!live[cls]) live[cls] = { open: [], buffer: [], session: null, settled: false }
        var app = live[cls]
        var entry = { w: w, cls: cls, assigned: !!adopted, userPlaced: false, provisional: null, captionHandler: null, moveHandler: null }
        tracked[id] = entry
        app.open.push(id)
        entry.moveHandler = connectSignal(w, 'interactiveMoveResizeStarted', function () { onUserMoveResize(id) })
        dbg('tracking window for ' + cls)
        if (adopted) {
            app.settled = true
        } else if (app.session || startSession(cls)) {
            joinSession(cls, id)
        }
    }

    function untrack(id) {
        var entry = tracked[id]
        delete tracked[id]
        unwatchCaption(entry)
        disconnectSignal(entry.w, 'interactiveMoveResizeStarted', entry.moveHandler)
        return entry
    }

    function snapshotWindow(w) {
        try {
            if (w.fullScreen || !(w.width >= 1) || !(w.height >= 1)) return null
            var output = w.output
            var relative = output ? output.mapFromGlobal(w.pos) : Qt.point(w.x, w.y)
            return Engine.makeSave({
                caption: String(w.caption || ''),
                x: Math.round(w.x),
                y: Math.round(w.y),
                width: Math.round(w.width),
                height: Math.round(w.height),
                output: output ? {
                    x: Math.round(relative.x),
                    y: Math.round(relative.y),
                    serial: String(output.serialNumber || ''),
                    name: String(output.name || '')
                } : null
            })
        } catch (e) {
            dbg('snapshot failed: ' + e)
            return null
        }
    }

    // Forget a window. Returns true when it was the app's last one and new saves were made.
    function releaseWindow(id) {
        var entry = untrack(id)
        var app = live[entry.cls]
        removeFromArray(app.open, id)
        // A window still awaiting its restore shows the app's default placement, not the user's layout.
        var awaitingRestore = !!app.session && app.session.pending.indexOf(id) !== -1
        if (app.session) removeFromArray(app.session.pending, id)
        var snap = awaitingRestore ? null : snapshotWindow(entry.w)
        if (snap) {
            app.buffer.push({ closeTime: Date.now(), snap: snap })
            if (app.buffer.length > Engine.MAX_BUFFER) app.buffer.shift()
        }
        if (app.open.length > 0) return false
        delete live[entry.cls]
        return finalizeApp(entry.cls, app.buffer)
    }

    // The windows that closed together (each within BURST_MS of the next) become the app's layout.
    function finalizeApp(cls, buffer) {
        if (!buffer.length) return false
        var saves = []
        var last = buffer[buffer.length - 1].closeTime
        for (var i = buffer.length - 1; i >= 0 && last - buffer[i].closeTime <= Engine.BURST_MS; i--) {
            saves.unshift(buffer[i].snap)
            last = buffer[i].closeTime
        }
        store.apps[cls] = { lastAccess: Date.now(), saves: saves }
        log(cls + ' closed, saved ' + saves.length + ' window(s)')
        return true
    }

    function startSession(cls) {
        var app = live[cls]
        var saved = store.apps[cls]
        if (app.settled || !saved) return false
        saved.lastAccess = Date.now()
        app.session = { saves: saved.saves, taken: [], remaining: saved.saves.length, pending: [], deadline: 0 }
        dbg(cls + ': restore session started - ' + saved.saves.length + ' saved window(s)')
        ensureTick()
        return true
    }

    function joinSession(cls, id) {
        var session = live[cls].session
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
        var session = live[entry.cls].session
        if (entry.assigned || !session) return
        entry.assigned = true
        unwatchCaption(entry)
        removeFromArray(session.pending, id)
        dbg(entry.cls + ': window placed by the user, not restoring it')
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
        var session = live[entry.cls].session
        if (!session) return
        var match = matchFor(entry, session)
        if (!match || (match.tier !== 1 && session.remaining !== 1)) return
        assignSave(entry, id, session, match, false)
        if (session.remaining === 0) {
            endSession(entry.cls)
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
        var moved = applySave(entry, id, session.saves[match.index], Date.now() + Engine.RESTORE_TIMEOUT_MS)
        var mode = bestEffort ? 'best effort' : (moved ? 'moved' : 'left as is')
        log(entry.cls + ': restored window to saved state (' + mode + '), caption match ' + match.score + '%')
    }

    // Deadline: give each waiting window the best remaining save, best pair first.
    function endSession(cls) {
        var app = live[cls]
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
        dbg(cls + ': restore session ended')
    }

    function workArea(output) {
        try {
            return Workspace.clientArea(KWin.MaximizeArea, output, Workspace.currentDesktop)
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

    // Returns { rect, provisional } or null. `provisional` means the saved screen is
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
        return { rect: { x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }, provisional: provisional }
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
    function applySave(entry, id, save, until) {
        if (!canPlace(entry.w)) return false
        var target = targetFor(entry.w, save)
        if (!target) return false
        entry.provisional = target.provisional ? { save: save, until: until } : null
        if (rectEquals(entry.w, target.rect)) return false
        setGeometry(entry.w, target.rect)
        for (var i = retries.length - 1; i >= 0; i--) {
            if (retries[i].id === id) retries.splice(i, 1)
        }
        retries.push({ id: id, target: target.rect, tries: 1, born: Date.now() })
        ensureTick()
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
                applySave(entry, id, entry.provisional.save, entry.provisional.until)
            } catch (e) {
                dbg('re-placing window failed: ' + e)
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
                    dbg(entry.cls + ': geometry did not stick, giving up silently (a window rule or the app owns this window)')
                    retries.splice(i, 1)
                } else {
                    retry.tries++
                    setGeometry(entry.w, retry.target)
                }
            } catch (e) {
                dbg('geometry retry failed: ' + e)
                retries.splice(i, 1)
            }
        }
    }

    function sweepSessions(now) {
        for (var cls in live) {
            var app = live[cls]
            if (!app.session || now < app.session.deadline) continue
            try {
                endSession(cls)
            } catch (e) {
                log(cls + ': ending restore session failed: ' + e)
                app.session = null
                app.settled = true
            }
        }
    }

    function isIdle() {
        if (retries.length > 0) return false
        for (var cls in live) {
            if (live[cls].session) return false
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

    Settings {
        id: settings
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
