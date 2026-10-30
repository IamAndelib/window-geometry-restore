import { readFileSync } from 'node:fs'

// Loads src/contents/ui/engine.js, a QML `.pragma library` file, into Node with every top-level
// name it declares, the way QML gives them to main.qml as `Engine.*`.
const source = readFileSync(new URL('../src/contents/ui/engine.js', import.meta.url), 'utf8')
    .replace(/^\s*\.pragma library.*$/m, '')
const names = [...source.matchAll(/^(?:var|function) (\w+)/gm)].map((m) => m[1])

export default new Function(`${source}\nreturn { ${names.join(', ')} };`)()
