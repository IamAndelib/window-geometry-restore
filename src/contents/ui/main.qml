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

    property bool debugMode: false
    property var config: ({})
    property var state: Engine.newState()
    property var tracked: ({})
    property var retries: []

    property string defaultBlacklist: [
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

    function log(message) {
        console.warn('WindowGeometryRestore: ' + message)
    }

    function dbg(message) {
        if (debugMode) console.warn('WindowGeometryRestore: ' + message)
    }

    function removeFromArray(array, item) {
        var index = array.indexOf(item)
        if (index !== -1) array.splice(index, 1)
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
        config.blacklist = Engine.parseList(KWin.readConfig('blacklist', defaultBlacklist))
        dbg('blacklist entries: ' + (config.blacklist.exact.length + config.blacklist.patterns.length))
    }

    function loadPersisted() {
        var result = Engine.decodeState(settings.windowgeometryrestore_windows)
        if (result.error) log('saved window data unreadable (' + result.error + ') - starting fresh')
        state = result.state
        var removed = Engine.pruneExpired(state, Date.now())
        var count = 0
        for (var cls in state.apps) count += state.apps[cls].saves.length
        log('loaded ' + count + ' saved window(s) for ' + Object.keys(state.apps).length + ' app(s)' +
            (removed > 0 ? ', pruned ' + removed + ' expired app(s)' : ''))
        if (removed > 0) persist()
    }

    function persist() {
        try {
            Engine.pruneExpired(state, Date.now())
            settings.windowgeometryrestore_windows = Engine.encodeState(state)
        } catch (e) {
            log('failed to persist: ' + e)
        }
    }

    function ensureApp(cls) {
        if (!state.apps[cls]) state.apps[cls] = {}
        var app = state.apps[cls]
        if (!app.lastAccess) app.lastAccess = Date.now()
        if (!Array.isArray(app.saves)) app.saves = []
        if (!Array.isArray(app.open)) app.open = []
        if (!Array.isArray(app.buffer)) app.buffer = []
        if (app.finalizeAt === undefined) app.finalizeAt = null
        if (app.session === undefined) app.session = null
        return app
    }

    function trackWindow(w) {
        if (!isValidWindow(w)) return
        var cls = w.resourceClass
        if (Engine.isListed(cls, config.blacklist)) {
            dbg('ignoring blacklisted app: ' + cls)
            return
        }
        var id = String(w.internalId)
        if (tracked[id]) return
        var app = ensureApp(cls)
        app.open.push(id)
        tracked[id] = { w: w, cls: cls, assigned: false, captionHandler: null }
        w.closed.connect(function () { onWindowClosed(w) })
        dbg('tracking window for ' + cls)
        if (app.session) {
            app.session.pending.push(id)
            app.session.deadline = Math.max(app.session.deadline, Date.now() + Engine.RESTORE_TIMEOUT_MS)
            watchCaption(id)
            tryAssign(id)
        } else {
            maybeStartSession(cls)
        }
    }

    function snapshotWindow(w) {
        try {
            var output = w.output
            var relative = output ? output.mapFromGlobal(w.pos) : Qt.point(w.x, w.y)
            return Engine.makeSave({
                caption: String(w.caption || ''),
                x: Math.round(w.x),
                y: Math.round(w.y),
                width: Math.round(w.width),
                height: Math.round(w.height),
                desktopNumber: w.onAllDesktops ? -1 : (w.desktops.length > 0 ? w.desktops[0].x11DesktopNumber : 1),
                activities: w.activities ? w.activities.slice() : [],
                minimized: w.minimized,
                keepAbove: w.keepAbove,
                keepBelow: w.keepBelow,
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

    function onWindowClosed(w) {
        try {
            if (!w) return
            var id = String(w.internalId)
            var entry = tracked[id]
            if (!entry) return
            delete tracked[id]
            var app = state.apps[entry.cls]
            if (!app) return
            removeFromArray(app.open, id)
            if (app.session) {
                removeFromArray(app.session.pending, id)
                unwatchCaption(id)
            }
            var snap = snapshotWindow(w)
            if (snap) app.buffer.push({ closeTime: Date.now(), snap: snap })
            if (app.open.length === 0 && !app.finalizeAt) app.finalizeAt = Date.now() + Engine.BURST_MS
            ensureTick()
        } catch (e) {
            dbg('close handling failed: ' + e)
        }
    }

    function finalizeApp(cls) {
        var app = state.apps[cls]
        app.finalizeAt = null
        if (!app.buffer.length) return
        app.buffer.sort(function (a, b) { return a.closeTime - b.closeTime })
        var saves = []
        var last = app.buffer[app.buffer.length - 1].closeTime
        for (var i = app.buffer.length - 1; i >= 0; i--) {
            if (last - app.buffer[i].closeTime > Engine.BURST_MS) break
            saves.unshift(app.buffer[i].snap)
            last = app.buffer[i].closeTime
        }
        app.buffer = []
        if (!saves.length) return
        app.saves = saves
        app.lastAccess = Date.now()
        log(cls + ' closed, saved ' + saves.length + ' window(s)')
        persist()
        maybeStartSession(cls)
    }

    function maybeStartSession(cls) {
        var app = state.apps[cls]
        if (!app || app.session || !app.saves.length || app.open.length === 0) return
        var pending = []
        for (var i = 0; i < app.open.length; i++) {
            var entry = tracked[app.open[i]]
            if (entry && !entry.assigned) pending.push(app.open[i])
        }
        app.session = { saves: app.saves, deadline: Date.now() + Engine.RESTORE_TIMEOUT_MS, pending: pending }
        dbg(cls + ': restore session started - ' + pending.length + ' window(s) open, ' + app.saves.length + ' saved')
        for (i = 0; i < pending.length; i++) watchCaption(pending[i])
        for (i = 0; i < pending.length; i++) tryAssign(pending[i])
        ensureTick()
    }

    function watchCaption(id) {
        var entry = tracked[id]
        if (!entry || entry.captionHandler) return
        entry.captionHandler = function () { tryAssign(id) }
        try {
            entry.w.captionChanged.connect(entry.captionHandler)
        } catch (e) {
            entry.captionHandler = null
        }
    }

    function unwatchCaption(id) {
        var entry = tracked[id]
        if (entry && entry.captionHandler) {
            try {
                entry.w.captionChanged.disconnect(entry.captionHandler)
            } catch (e) {}
            entry.captionHandler = null
        }
    }

    function tryAssign(id) {
        var entry = tracked[id]
        if (!entry || entry.assigned) return
        var app = state.apps[entry.cls]
        if (!app || !app.session) return
        var w = entry.w
        if (!w || w.deleted) return
        var match = Engine.bestMatch(app.session.saves, {
            caption: String(w.caption || ''),
            width: Math.round(w.width),
            height: Math.round(w.height)
        })
        if (!match) return
        // Only unambiguous matches apply instantly; the rest wait for the set to arrive.
        var immediate = match.tier === 1 || app.session.saves.length === 1
        if (!immediate) return
        assignSave(entry.cls, id, match.index, match.score)
    }

    function assignSave(cls, id, index, score) {
        var app = state.apps[cls]
        var session = app.session
        var entry = tracked[id]
        if (!session || !entry) return
        var save = session.saves[index]
        save.matched = true
        entry.assigned = true
        unwatchCaption(id)
        removeFromArray(session.pending, id)
        var changes = applySnapshot(entry.w, save, cls)
        log(cls + ': restored window to saved state' + (changes.length ? ' (' + changes.join(', ') + ')' : ' (already correct)') + ', caption match ' + score + '%')
        for (var i = 0; i < session.saves.length; i++) {
            if (!session.saves[i].matched) return
        }
        endSession(cls)
    }

    function endSession(cls) {
        var app = state.apps[cls]
        var session = app.session
        if (!session) return
        app.session = null
        for (var i = session.pending.length - 1; i >= 0; i--) {
            var id = session.pending[i]
            var entry = tracked[id]
            unwatchCaption(id)
            session.pending.splice(i, 1)
            if (!entry) continue
            var w = entry.w
            if (!w || w.deleted) continue
            var match = Engine.bestMatch(session.saves, {
                caption: String(w.caption || ''),
                width: Math.round(w.width),
                height: Math.round(w.height)
            })
            if (match) {
                session.saves[match.index].matched = true
                entry.assigned = true
                applySnapshot(w, session.saves[match.index], cls)
                log(cls + ': restored window to saved state (' + 'best effort, caption match ' + match.score + '%)')
            }
        }
        if (app.saves === session.saves) app.saves = []
        persist()
        dbg(cls + ': restore session ended')
    }

    function findOutput(savedOutput) {
        if (!savedOutput) return null
        var screens = Workspace.screens
        if (savedOutput.serial) {
            for (var i = 0; i < screens.length; i++) {
                if (String(screens[i].serialNumber) === savedOutput.serial) return screens[i]
            }
        }
        if (savedOutput.name) {
            for (var j = 0; j < screens.length; j++) {
                if (String(screens[j].name) === savedOutput.name) return screens[j]
            }
        }
        return null
    }

    function isMaximizedLike(w) {
        try {
            var area = Workspace.clientArea(KWin.MaximizeArea, w)
            return Math.round(w.width) >= Math.round(area.width) && Math.round(w.height) >= Math.round(area.height)
        } catch (e) {
            return false
        }
    }

    function targetFor(w, save) {
        var virtual = Workspace.virtualScreenGeometry
        if (!virtual || virtual.width <= 0 || virtual.height <= 0) return null
        var x = save.x
        var y = save.y
        if (save.output) {
            var output = findOutput(save.output)
            if (output) {
                var position = output.mapToGlobal(Qt.point(save.output.x, save.output.y))
                x = Math.round(position.x)
                y = Math.round(position.y)
            }
        }
        var maxWidth = Math.min(w.maxSize ? Math.floor(w.maxSize.width) : virtual.width, virtual.width)
        var maxHeight = Math.min(w.maxSize ? Math.floor(w.maxSize.height) : virtual.height, virtual.height)
        var minWidth = w.minSize ? Math.ceil(w.minSize.width) : 0
        var minHeight = w.minSize ? Math.ceil(w.minSize.height) : 0
        var width = Math.max(minWidth, Math.min(save.width, maxWidth))
        var height = Math.max(minHeight, Math.min(save.height, maxHeight))
        x = Math.max(virtual.x, Math.min(x, virtual.x + virtual.width - width))
        y = Math.max(virtual.y, Math.min(y, virtual.y + virtual.height - height))
        return { x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }
    }

    function rectEquals(w, target) {
        return Math.round(w.x) === target.x && Math.round(w.y) === target.y &&
               Math.round(w.width) === target.w && Math.round(w.height) === target.h
    }

    function applySnapshot(w, save, cls) {
        var changes = []
        if (!w || w.deleted) return changes

        if (save.desktopNumber === -1) {
            if (!w.onAllDesktops) {
                w.onAllDesktops = true
                changes.push('desktop')
            }
        } else {
            var target = null
            for (var i = 0; i < Workspace.desktops.length; i++) {
                if (Workspace.desktops[i].x11DesktopNumber === save.desktopNumber) {
                    target = Workspace.desktops[i]
                    break
                }
            }
            if (target) {
                var current = w.onAllDesktops ? null : (w.desktops.length === 1 ? w.desktops[0] : undefined)
                if (current !== target) {
                    w.desktops = [target]
                    changes.push('desktop')
                }
            }
        }

        if (save.activities.length > 0 && Workspace.activities.length > 0) {
            var valid = []
            for (var j = 0; j < save.activities.length; j++) {
                if (Workspace.activities.indexOf(save.activities[j]) !== -1) valid.push(save.activities[j])
            }
            if (valid.length > 0 && JSON.stringify(valid) !== JSON.stringify(w.activities)) {
                w.activities = valid
                changes.push('activities')
            }
        }

        if (!w.tile && !w.fullScreen && w.moveable && w.resizeable && !w.move && !w.resize && !isMaximizedLike(w)) {
            var geometry = targetFor(w, save)
            if (geometry && !rectEquals(w, geometry)) {
                w.frameGeometry = Qt.rect(geometry.x, geometry.y, geometry.w, geometry.h)
                retries.push({ w: w, cls: cls, target: geometry, tries: 1, born: Date.now(), interacted: false })
                changes.push('geometry')
            }
        }

        if (save.minimized && w.minimizable && !w.minimized) {
            w.minimized = true
            changes.push('minimized')
        }
        if (save.keepAbove && !w.keepAbove) {
            w.keepAbove = true
            changes.push('keepAbove')
        }
        if (save.keepBelow && !w.keepBelow) {
            w.keepBelow = true
            changes.push('keepBelow')
        }

        return changes
    }

    function sweepRetries(now) {
        for (var i = retries.length - 1; i >= 0; i--) {
            var retry = retries[i]
            var w = retry.w
            if (!w || w.deleted) {
                retries.splice(i, 1)
                continue
            }
            if (w.move || w.resize) {
                retry.interacted = true
                continue
            }
            if (retry.interacted || now - retry.born > Engine.RETRY_MAX_AGE_MS) {
                dbg(retry.cls + ': stopped restoring geometry (window is user-managed now)')
                retries.splice(i, 1)
                continue
            }
            if (rectEquals(w, retry.target)) {
                retries.splice(i, 1)
                continue
            }
            if (retry.tries >= Engine.MAX_GEOMETRY_TRIES) {
                dbg(retry.cls + ': geometry did not stick, giving up silently (a window rule or the app owns this window)')
                retries.splice(i, 1)
                continue
            }
            retry.tries++
            w.frameGeometry = Qt.rect(retry.target.x, retry.target.y, retry.target.w, retry.target.h)
        }
    }

    function sweepSessions(now) {
        for (var cls in state.apps) {
            var app = state.apps[cls]
            if (app.finalizeAt && now >= app.finalizeAt) finalizeApp(cls)
            if (app.session && now >= app.session.deadline) endSession(cls)
        }
    }

    function stopTickIfIdle() {
        if (retries.length > 0) return
        for (var cls in state.apps) {
            var app = state.apps[cls]
            if (app.finalizeAt || app.session) return
        }
        tickTimer.stop()
    }

    function ensureTick() {
        if (!tickTimer.running) tickTimer.start()
    }

    function onTick() {
        var now = Date.now()
        sweepRetries(now)
        sweepSessions(now)
        stopTickIfIdle()
    }

    Timer {
        id: tickTimer
        interval: 250
        repeat: true
        running: false
        onTriggered: root.onTick()
    }

    Settings {
        id: settings
        property string windowgeometryrestore_windows: '{}'
    }

    Connections {
        target: Workspace

        function onWindowAdded(window) {
            trackWindow(window)
        }

        function onWindowRemoved(window) {
            onWindowClosed(window)
        }
    }

    Component.onCompleted: {
        loadConfig()
        loadPersisted()
        var clients = Workspace.stackingOrder
        for (var i = 0; i < clients.length; i++) {
            trackWindow(clients[i])
        }
    }

    Component.onDestruction: {
        persist()
    }
}
