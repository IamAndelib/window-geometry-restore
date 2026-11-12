// Type-checks the shipped JavaScript without changing it (see CONTRIBUTING.md, Testing).
// KWin runs engine.js as a QML ".pragma library" and main.qml's functions inside QML, neither
// of which TypeScript reads. This writes a checkable copy into build/typecheck/, keeping every
// line where it is, runs tsc on it with the types in types/, and reports errors against the
// real files and lines:
//   engine.js: the ".pragma library" line blanked, its names exported on an added last line;
//   main.js:   main.qml's 4-space functions (as tests/lifecycle.mjs extracts them) on their
//              own lines, everything else blanked, and Engine imported on line 1.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const repo = new URL('..', import.meta.url).pathname
if (!existsSync(repo + 'node_modules/.bin/tsc')) {
    console.error('TypeScript is not installed: run `npm ci` in the repository once (dev container).')
    process.exit(1)
}
const ui = repo + 'src/contents/ui/'
const out = repo + 'build/typecheck/'
mkdirSync(out, { recursive: true })

const engine = readFileSync(ui + 'engine.js', 'utf8').split('\n')
if (!/^\s*\.pragma library/.test(engine[0])) throw new Error('engine.js: expected ".pragma library" on line 1')
const names = [...engine.join('\n').matchAll(/^(?:var|function) (\w+)/gm)].map((m) => m[1])
writeFileSync(out + 'engine.js', ['', ...engine.slice(1), `export { ${names.join(', ')} }`].join('\n'))

const qml = readFileSync(ui + 'main.qml', 'utf8').split('\n')
const kept = qml.map(() => '')
kept[0] = "import * as Engine from './engine.js'"
for (let i = 0; i < qml.length; i++) {
    if (!/^    function \w+\(/.test(qml[i])) continue
    let depth = 0
    for (let j = i; j < qml.length; j++) {
        kept[j] = qml[j]
        for (const c of qml[j]) depth += c === '{' ? 1 : c === '}' ? -1 : 0
        if (depth === 0) { i = j; break }
    }
}
// And the JSDoc blocks: the types of the functions below them.
for (let i = 0; i < qml.length; i++) {
    if (!/^    \/\*\*/.test(qml[i])) continue
    for (let j = i; j < qml.length; j++) {
        kept[j] = qml[j]
        if (/\*\//.test(qml[j])) { i = j; break }
    }
}
writeFileSync(out + 'main.js', kept.join('\n'))

let output = ''
try {
    execFileSync(repo + 'node_modules/.bin/tsc', ['-p', repo + 'tsconfig.json', '--pretty', 'false'], { encoding: 'utf8', stdio: 'pipe' })
} catch (e) {
    output = String(e.stdout || '') + String(e.stderr || '')
    if (!output.trim()) throw e
}
const report = output
    .replaceAll('build/typecheck/main.js', 'src/contents/ui/main.qml')
    .replaceAll('build/typecheck/engine.js', 'src/contents/ui/engine.js')
    .trim()
if (report) {
    console.error(report)
    console.error(`\n${(report.match(/error TS/g) || []).length} type error(s)`)
    process.exit(1)
}
console.log('types: ok')
