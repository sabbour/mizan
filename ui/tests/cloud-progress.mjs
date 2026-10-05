import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

async function importTypeScript(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext },
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
}

const { createCloudOperationGate, runWithCloudOperation } =
  await importTypeScript('../src/library/cloudOperation.ts')
const { jobStageLabel, jobStagePercent, jobStageState, STAGE_LABEL } =
  await importTypeScript('../src/library/format.ts')

const gate = createCloudOperationGate()
let resolveRun
const running = runWithCloudOperation(
  (label) => gate.acquire(label),
  () => new Promise((resolve) => { resolveRun = resolve }),
  'Checking Azure setup…',
)
assert.equal(gate.isLocked(), true)
assert.equal(await runWithCloudOperation(
  (label) => gate.acquire(label),
  async () => assert.fail('A duplicate Cloud operation ran'),
), undefined)
resolveRun('checked')
assert.equal(await running, 'checked')
assert.equal(gate.isLocked(), false)

await assert.rejects(runWithCloudOperation(
  () => gate.acquire(),
  async () => { throw new Error('operation failed') },
), /operation failed/)
assert.equal(gate.isLocked(), false, 'failure releases the shared guard')
await assert.rejects(runWithCloudOperation(
  () => gate.acquire(),
  async () => { throw new Error('cancelled') },
), /cancelled/)
assert.equal(gate.isLocked(), false, 'cancellation releases the shared guard')

const stages = Object.keys(STAGE_LABEL).map((name) => ({ name, seconds: null, estimate: null }))
const runningJob = {
  status: 'running', stage: 'detect', stageProgress: null,
  stageMessage: 'Azure GPU Job running', stages,
}
assert.equal(jobStagePercent(runningJob), null, 'unknown progress is indeterminate')
assert.equal(jobStageLabel(runningJob), 'Azure GPU Job running')
assert.equal(jobStagePercent({ ...runningJob, stageProgress: 0.42 }), 42)
assert.equal(jobStagePercent({ ...runningJob, stageProgress: 1.2 }), null)
assert.equal(jobStagePercent({ ...runningJob, status: 'done', stageProgress: 1 }), null)
const failedJob = { ...runningJob, status: 'failed', stageMessage: 'Checking Azure GPU Job' }
assert.equal(jobStageLabel(failedJob), 'Checking Azure GPU Job',
  'the failed job retains its operation-level phase message')
assert.equal(jobStageState(runningJob, 'inspect'), 'done')
assert.equal(jobStageState(runningJob, 'detect'), 'now')
assert.equal(jobStageState(runningJob, 'finalize'), 'todo')
assert.equal(jobStageState({ ...runningJob, status: 'failed' }, 'detect'), 'failed')
assert.equal(jobStageState({ ...runningJob, status: 'failed' }, 'finalize'), 'not-run')
assert.equal(jobStageState({ ...runningJob, status: 'cancelled' }, 'detect'), 'cancelled')
assert.equal(jobStageState({ ...runningJob, status: 'cancelled' }, 'finalize'), 'not-run')

const library = await readFile(new URL('../src/library/Library.tsx', import.meta.url), 'utf8')
const jobPanel = await readFile(new URL('../src/library/JobPanel.tsx', import.meta.url), 'utf8')
const setup = await readFile(new URL('../src/library/CloudSetup.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/library/library.css', import.meta.url), 'utf8')
assert.match(library, /Cloud is on for new songs/)
assert.match(library, /Azure is ready · Processing is Local/)
assert.match(library, /Review Azure setup/)
assert.match(library, /Check Azure access/)
assert.match(library, /role="status" aria-live="polite"/)
assert.match(jobPanel, /Stopped while \$\{jobStageLabel\(j\)\.toLowerCase\(\)\}/)
assert.match(jobPanel, /Took \$\{took\(j\.elapsedSeconds\)\}/)
assert.match(jobPanel, /Azure round trip/)
assert.match(jobPanel, /included in total/)
assert.match(jobPanel, /s\.timingNote \?\? null/)
assert.doesNotMatch(jobPanel, /const spent = done\.reduce/)
assert.match(library, /aria-busy=\{cloudOperationBusy\}/)
assert.match(library, /className="cloud-inline-spinner" aria-hidden="true"/)
assert.match(library, /Disconnecting makes Mizan forget its saved Azure setup/)
assert.match(library, /does not delete Azure resources or stop running Jobs, and charges may continue/)
assert.match(setup, /aria-busy=\{busy\}/)
assert.match(setup, /Checking Azure setup…/)
assert.match(setup, /enableCloudLogging\(true\)/)
assert.match(setup, /I approve creating or reusing the workspace and Azure log ingestion charges/)
assert.match(setup, /Retention is 30 days/)
assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.cloud-inline-spinner\s*\{\s*animation: none;/)
console.log('Cloud operation, honest progress, status, and accessibility checks passed.')
