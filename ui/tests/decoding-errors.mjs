import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/library/format.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext },
})
const { decodingErrorHeadline } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)

assert.equal(decodingErrorHeadline(undefined), null, 'legacy telemetry is unknown')
assert.equal(decodingErrorHeadline(null), null, 'missing telemetry is unknown')
assert.equal(decodingErrorHeadline(0), null, 'zero does not claim best-effort errors')
assert.equal(decodingErrorHeadline(1), 'Best-effort transcription · 1 decoding error')
assert.equal(decodingErrorHeadline(2), 'Best-effort transcription · 2 decoding errors')
assert.equal(decodingErrorHeadline(-1), null)
assert.equal(decodingErrorHeadline(Number.MAX_SAFE_INTEGER + 1), null)

const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const notice = await readFile(new URL('../src/workspace/AnalysisNotice.tsx', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/library/JobPanel.tsx', import.meta.url), 'utf8')
const library = await readFile(new URL('../src/library/Library.tsx', import.meta.url), 'utf8')
assert.match(app, /decodingErrorHeadline\(opened\?\.song\.decodingErrors\?\.count\)/)
assert.match(app, /<AnalysisNotice\s+decodingHeadline=\{decodingHeadline\}/)
assert.match(notice, /Some notes may be missing or cut short/)
assert.match(notice, /role="status"/)
assert.match(panel, /decodingErrorHeadline\(j\.decodingErrors\?\.count\)/)
assert.match(panel, /Some notes may be missing or cut short/)
assert.match(panel, /className="jp-incomplete" role="status"/)
assert.match(library, /decodingErrorHeadline\(j\.decodingErrors\?\.count\)/)
console.log('Best-effort decoding warning and legacy-unknown presentation checks passed.')
