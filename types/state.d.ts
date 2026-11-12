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
}

/** What Engine.makeSave is built from. */
type SaveFields = Geometry & { caption?: string; tile?: TileRef | null; free?: Geometry | null; maximized?: number }

/** An app's windows on one desktop. */
interface Layout { lastAccess: number; saves: Save[] }

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
    /** 1 caption and size, 2 size, 3 caption, 4 the only save left. */
    tier: number
    /** Dimensions that match (0-2). */
    dims: number
    score: number
    /** A web app's one-time fallback: the only save with its caption. */
    only?: boolean
}

/** What bestMatch compares a window by. */
interface LiveWindow { caption: string; width: number; height: number }

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
    restoredFrom: RestoredFrom | null
    placedFrom: Save | null
    /** A dialog without a parent (Engine.isDialog), and the saves it was judged against. */
    dialog: { saves: Save[] } | null
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
