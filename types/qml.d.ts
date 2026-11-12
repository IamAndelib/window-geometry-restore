// What main.qml's functions see besides each other: the component's properties and children
// (root, tickTimer, settings) and the objects QML and KWin give it. Keep in step with main.qml.

declare var storeKey: string
declare var defaultExcluded: string
declare var debugMode: boolean
declare var restoreTiles: boolean
declare var excluded: ExclusionList
declare var reported: Record<string, boolean>
declare var lastWritten: string
declare var store: State
declare var live: Record<string, Group>
declare var tracked: Record<string, Entry>
declare var retries: Retry[]

/** QML's console: console.warn goes to KWin's log (the journal). */
declare var console: { warn(...args: unknown[]): void }

declare var root: object
declare var tickTimer: { readonly running: boolean; start(): void; stop(): void }

/** QtCore Settings on the saved data's file. */
interface QSettingsObject {
    value(key: string, defaultValue?: unknown): any
    setValue(key: string, value: unknown): void
    sync(): void
    destroy(): void
}
declare var settings: QSettingsObject

declare var Workspace: KWorkspace
declare var KWin: {
    readConfig(key: string, defaultValue: unknown): any
    readonly MaximizeArea: number
}
declare var Qt: {
    rect(x: number, y: number, width: number, height: number): KRect
    point(x: number, y: number): KPoint
    createQmlObject(qml: string, parent: object): any
}
declare var StandardPaths: {
    readonly GenericConfigLocation: number
    locate(location: number, name: string): string
    writableLocation(location: number): string
}
