// The script's data: what it saves, and what it keeps while windows are open. Engine.js builds
// and reads the saved part, main.qml the rest. Saves come in two shapes that must not be mixed:
// Encoded* is the compact form on disk (c, w, h, o, t, f), Save the long form in memory
// (caption, width, height, output, tile, free).

// ---- saved data, in memory ----------------------------------------------------------------

/** A screen as a save remembers it: the window's position on it, and how to find it again. */
interface SavedScreen { x: number; y: number; serial: string; name: string }
/** A monitor to compare (sameMonitor): a saved screen, or a connected one by name and serial. */
interface MonitorRef { name: string; serial: string }
/** Fractions of the screen: a tile's relativeGeometry. */
interface Rel { x: number; y: number; width: number; height: number }

interface QuickTileRef { kind: 'quick'; index: number; rel: Rel | null }
interface CustomTileRef { kind: 'custom'; path: number[]; rel: Rel }
type TileRef = QuickTileRef | CustomTileRef

/** A global rect and its place on its screen. */
interface Geometry { x: number; y: number; width: number; height: number; output: SavedScreen | null }

/** A remembered window (Engine.makeSave). Never mutated. */
interface Save extends Geometry {
    caption: string
    tile: TileRef | null
    /** The floating geometry from before the window was tiled. */
    free: Geometry | null
    /** KWin's maximize mode at close (0 none, 1 vertical, 2 horizontal, 3 both); x/y/width/height
     *  are then the normal geometry to return to. */
    maximized: number
    /** When the window closed (ms, strictly increasing per close: close order). 0 for saves from
     *  older versions. */
    closedAt: number
    /** Whether KWin drew a title bar on it, seen while not maximized; null if unknown (older
     *  versions, or never seen unmaximized). */
    framed: boolean | null
}

/** What Engine.makeSave is built from. */
type SaveFields = Geometry & { caption?: string; tile?: TileRef | null; free?: Geometry | null; maximized?: number; closedAt?: number; framed?: boolean | null }

/** An app's windows on one desktop. `saves` are in close order, the save closed last at the end:
 *  finalizeMonitor appends the closing monitor's part after the others' (kept in their order).
 *  Saves with close times are ranked by them (Engine.closeRanks); saves without (older versions)
 *  by this order, so keep it. */
interface Layout { lastAccess: number; saves: Save[] }

/** What Engine.recordLayout replaces for an app on one desktop (Engine.layoutBefore). */
interface LayoutBefore { layout: Layout | null; saves: Save[]; lastAccess: number }

/** How an app's windows open before KWin names them: as app `cls`, titled `caption`. */
interface Opening { cls: string; caption: string }

interface App {
    lastAccess: number
    /** The latest layout from any desktop, for versions without desktops. */
    saves: Save[]
    /** By desktop id, or '*' for windows on all or several desktops. Without a prototype. */
    desktops: Record<string, Layout>
    opens?: Opening[]
}

/** Without a prototype: app ids are app-chosen. */
interface State { apps: Record<string, App> }

interface DecodeResult { state: State; error: string | null; version: number }

// ---- saved data, on disk (compact) --------------------------------------------------------

interface EncodedOutput { x: number; y: number; s: string; n: string }
interface EncodedRect { x: number; y: number; w: number; h: number }
type EncodedTile = { k: 'q'; i: number; g?: EncodedRect } | { k: 'c'; p: number[]; g?: EncodedRect }
interface EncodedSave {
    c: string; x: number; y: number; w: number; h: number; o: EncodedOutput | null
    t?: EncodedTile
    f?: EncodedRect & { o: EncodedOutput | null }
    max?: number
    /** Close time (optional; older versions ignore it). */
    ct?: number
    /** 1 framed by KWin (a title bar), 0 not (optional; older versions ignore it). */
    fr?: number
}
interface EncodedApp {
    t: number
    w?: EncodedSave[]
    d?: Record<string, { t: number; w: EncodedSave[] }>
    o?: { k: string; c: string }[]
}
interface EncodedState { version: number; apps: Record<string, EncodedApp> }

// ---- matching, rules, the exclusion list --------------------------------------------------

interface Match {
    index: number
    /** 1 caption 100% and size, 2 caption 100%, 3 size, 4 caption alike, 5 the only save left. */
    tier: number
    /** Dimensions that match (0-2). */
    dims: number
    score: number
    /** The save's title is the window's exactly (score 100 also takes titles differing in digits). */
    exact: boolean
    /** The save's close rank (Engine.closeRanks): equal matches go to the lower. */
    rank: number
    /** A web app's one-time fallback: the only save with its caption. */
    only?: boolean
}

/** What bestMatch compares a window by. */
interface LiveWindow { caption: string; width: number; height: number; framed?: boolean | null }

/** What Engine.isDialog judges a window by. */
interface DialogSize {
    /** The frame, as saves are. */
    width: number
    height: number
    /** Without decoration borders, as KWin's minSize is. */
    clientWidth: number
    minWidth: number
}

/** The exclusion list: exact names, and wildcard patterns split at their stars. */
interface ExclusionList { exact: string[]; patterns: string[][] }

interface RuleCondition { test(value: string): boolean; unreadable?: boolean }

/** A KWin window rule that places, sizes or maximizes windows. */
interface Rule {
    id: string
    description: string
    geometry: string[]
    wmclass: RuleCondition
    wmclasscomplete: boolean
    title: RuleCondition
    types: string
    unreadable: 'wmclass' | 'title' | null
}

/** What a rule is matched against. */
interface RuleWindow { resourceClass: string; resourceName: string; caption: string }

/** A value from the rules file as QSettings reads it: a string, or a list for comma values. */
type RuleValue = string | ArrayLike<string> | undefined | null

// ---- runtime (main.qml) -------------------------------------------------------------------

/** A target rect for a window: global, in whole pixels. */
interface PixelRect { x: number; y: number; w: number; h: number }

/** Where a save puts a window (targetFor). `provisional`: its screen is missing, `output` is a
 *  fallback screen. */
interface Target { rect: PixelRect; provisional: boolean; output: KOutput | null }

/** A restore of an app's layout on one desktop (and, if `monitor`, one monitor). */
interface Session {
    saves: Save[]
    /** Engine.closeRanks(saves), computed once: the saves don't change while the session runs. */
    ranks: number[]
    monitor: MonitorRef | null
    /** By save index. */
    taken: boolean[]
    remaining: number
    /** Window ids waiting for their save. */
    pending: string[]
    deadline: number
    /** A web app restoring once from its browser's layout: only matching captions count. */
    captionOnly: boolean
}

/** A window's close, waiting until the app has no window left on its monitor. */
interface Close {
    closeTime: number
    snap: Save
    monitor: SavedScreen | null
    /** The save the script placed the window at: replaced by this close (issue #8). */
    from: Save | null
    /** Set when the window closed as the script left it (Engine.keepsPlacement); a possible
     *  hand-off (main.qml handOff) if it is its monitor's only close (finalizeMonitor). */
    handoff: HandoffSource | null
}

/** A closed window that may have handed over: its window class, process (0 unknown), and
 *  whether it couldn't be resized. */
interface HandoffSource { resourceClass: string; pid: number; fixedSize: boolean }

/** A layout saved from a window that may have been a splash screen or startup prompt: undone if
 *  the window it handed over to opens by `until` (main.qml handOff). */
interface Handoff {
    from: HandoffSource
    cls: string
    desktopKey: string
    caption: string
    until: number
    recorded: Layout
    before: LayoutBefore
}

/** An app's open windows on one desktop key. */
interface Group {
    key: string
    cls: string
    desktopKey: string
    label: string
    /** The window class, when the app is keyed by another name (a desktop file name). */
    legacyCls: string | null
    open: string[]
    buffer: Close[]
    session: Session | null
    /** The app is running here: later windows are restored only on a monitor it has none on. */
    settled: boolean
}

/** A quick tile waiting for its window to become active. */
interface PendingTile {
    index: number
    rel: Rel | null
    output: KOutput
    /** The pre-tile geometry, written just before tiling. */
    free: PixelRect | null
    until: number
    handler: KHandler | null
}

/** How to tile a window (planTile): a tile to manage now, or a quick tile once it is active.
 *  `free`: the pre-tile geometry applySave wrote, if any. */
type Tiling =
    | { tile: KTile; quick?: undefined; rel?: Rel | null; free?: PixelRect | null }
    | { tile?: undefined; quick: number; rel: Rel | null; output: KOutput; free?: PixelRect | null }

/** A window's geometry on its own monitor, or the save a provisional placement came from. */
type Home = Geometry & { maximized?: number; tile?: TileRef | null; free?: Geometry | null }

/** The save an app's restore gave a window, and the window as it was before (undoRestore). */
interface RestoredFrom {
    session: Session
    index: number
    save: Save
    before: PixelRect & { maximized: number; tile: KTile | null }
}

/** A tracked window. */
interface Entry {
    id: string
    w: KWindow
    /** Its app key (Engine.appKeyFor), or the app it is taken for (prediction). */
    cls: string
    resourceClass: string
    desktopKey: string
    groupKey: string
    label: string
    /** Its restore is decided: done, declined, or not for it. */
    assigned: boolean
    userPlaced: boolean
    provisional: { save: Save; until: number } | null
    openedAt: number
    /** Where it opened; null if adopted or sent to another desktop (Engine.keepsPlacement). */
    opened: PixelRect | null
    restoredFrom: RestoredFrom | null
    placedFrom: Save | null
    /** A dialog without a parent (Engine.isDialog), or a window framed unlike the app's saves
     *  (Engine.isFramedUnlike: a splash or welcome screen), and the saves it was judged against. */
    dialog: { saves: Save[]; framedUnlike: boolean } | null
    /** Whether KWin draws a title bar on it, last seen unmaximized; null until then. */
    framed: boolean | null
    unmaximizedUntil: number
    openedKey: string
    openingCaption: string
    learnedAs: string | null
    learnings: number
    prediction: { from: string; until: number } | null
    home: Home | null
    tile: TileRef | null
    free: Geometry | null
    pendingTile: PendingTile | null
    captionHandler: KHandler | null
    moveHandler: KHandler | null
    geometryHandler: KHandler | null
    tileHandler: KHandler | null
    desktopsHandler: KHandler | null
    outputHandler: KHandler | null
    desktopFileHandler: KHandler | null
}

/** A geometry write that hasn't stuck yet. */
interface Retry { id: string; target: PixelRect; tries: number; born: number }
