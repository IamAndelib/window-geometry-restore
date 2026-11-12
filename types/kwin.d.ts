// The part of KWin's scripting API this script uses, checked against KWin 6.8.2's source:
// src/window.h (Window), src/scripting/workspace_wrapper.h (Workspace), src/core/output.h
// (LogicalOutput), src/virtualdesktops.h, src/tiles/tile.h and customtile.h. A name missing here
// is one KWin doesn't give scripts (on Wayland it reads as undefined, silently): add it only after
// checking it in KWin's source for the version in the dev container.

interface KRect { x: number; y: number; width: number; height: number }
interface KPoint { x: number; y: number }
interface KSize { width: number; height: number }

type KHandler = (...args: any[]) => void
interface KSignal {
    connect(handler: KHandler): void
    disconnect(handler: KHandler): void
}

interface KVirtualDesktop {
    readonly id: string
    readonly x11DesktopNumber: number
}

interface KOutput {
    readonly name: string
    readonly serialNumber: string
    readonly geometry: KRect
    mapToGlobal(pos: KPoint): KPoint
    mapFromGlobal(pos: KPoint): KPoint
}

interface KTile {
    readonly tiles: KTile[]
    readonly parent: KTile | null
    relativeGeometry: KRect
    readonly windows: KWindow[]
    /** Custom (Meta+T) tiles only: quick tiles have none. */
    readonly layoutDirection?: number
    manage(window: KWindow): boolean
    unmanage(window: KWindow): boolean
}

interface KTileManager {
    readonly rootTile: KTile | null
}

/** The window signals the script connects to. */
type KWindowSignal = 'interactiveMoveResizeStarted' | 'frameGeometryChanged' | 'tileChanged' |
    'desktopsChanged' | 'outputChanged' | 'desktopFileNameChanged' | 'captionChanged' | 'activeChanged'

interface KWindow {
    readonly internalId: string
    readonly deleted: boolean
    readonly normalWindow: boolean
    readonly popupWindow: boolean
    readonly skipTaskbar: boolean
    readonly modal: boolean
    readonly transient: boolean
    readonly splash: boolean
    readonly resourceClass: string
    readonly resourceName: string
    readonly desktopFileName: string
    readonly caption: string
    /** The caption without the " <2>" or " (Not Responding)" KWin adds: what rules match. */
    readonly captionNormal: string
    readonly active: boolean
    readonly desktops: KVirtualDesktop[]
    readonly onAllDesktops: boolean
    readonly output: KOutput | null
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
    /** Writable: a script write moves and resizes the window (Window::moveResize). */
    frameGeometry: KRect
    /** Without decoration borders (as minSize is). */
    readonly clientGeometry: KRect
    readonly minSize: KSize
    readonly maxSize: KSize
    readonly fullScreen: boolean
    /** KWin::MaximizeMode, as the app acknowledged it: 0 restored, 1 vertical, 2 horizontal, 3 both. */
    readonly maximizeMode: number
    readonly maximizable: boolean
    readonly moveable: boolean
    readonly resizeable: boolean
    readonly move: boolean
    readonly resize: boolean
    /** The requested tile (Window::requestedTile); writable, deprecated in favour of Tile.manage. */
    tile: KTile | null
    setMaximize(vertically: boolean, horizontally: boolean, restore?: KRect): void
    readonly interactiveMoveResizeStarted: KSignal
    readonly frameGeometryChanged: KSignal
    readonly tileChanged: KSignal
    readonly desktopsChanged: KSignal
    readonly outputChanged: KSignal
    readonly desktopFileNameChanged: KSignal
    readonly captionChanged: KSignal
    readonly activeChanged: KSignal
}

/** KWin's quick-tile actions, in the order KWin creates the quick tiles (see Engine). */
type KQuickTileAction = 'slotWindowQuickTileLeft' | 'slotWindowQuickTileRight' | 'slotWindowQuickTileTop' |
    'slotWindowQuickTileBottom' | 'slotWindowQuickTileTopLeft' | 'slotWindowQuickTileTopRight' |
    'slotWindowQuickTileBottomLeft' | 'slotWindowQuickTileBottomRight'

type KWorkspace = {
    readonly screens: KOutput[]
    readonly stackingOrder: KWindow[]
    readonly activeWindow: KWindow | null
    readonly activeScreen: KOutput | null
    readonly currentDesktop: KVirtualDesktop
    readonly cursorPos: KPoint
    readonly virtualScreenGeometry: KRect
    clientArea(option: number, window: KWindow): KRect
    clientArea(option: number, output: KOutput | null, desktop: KVirtualDesktop): KRect
    screenAt(pos: KPoint): KOutput | null
    /** Since KWin 6.7. */
    currentDesktopForScreen?(output: KOutput): KVirtualDesktop
    /** Since KWin 6.4: the custom-tiling root of a screen and desktop. */
    rootTile?(output: KOutput, desktop: KVirtualDesktop): KTile | null
    tilingForScreen(output: KOutput): KTileManager
} & { [action in KQuickTileAction]: () => void }
