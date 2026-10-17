import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/library/format.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } })
const { instrumentStatus, activeAnalysis, analysisProgress, smallerCpuRetryModel } =
  await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
const job = {
  status: 'running', stage: 'transcribe', detected: { piano: 0.46, drums: 0.14 },
  selectedInstruments: ['piano', 'drums'], transcribedInstruments: [],
}
assert.equal(instrumentStatus(job, 'piano'), 'transcribing')
assert.equal(instrumentStatus(job, 'drums'), 'transcribing')
assert.equal(instrumentStatus({ ...job, selectedInstruments: ['piano'] }, 'drums'), 'not requested')
assert.equal(instrumentStatus({ ...job, selectedInstruments: ['drums'] }, 'piano'), 'not requested')
assert.equal(instrumentStatus({ ...job, status: 'failed' }, 'drums'), 'attempt interrupted')
assert.equal(instrumentStatus({ ...job, status: 'done', selectedInstruments: undefined }, 'drums'), 'status unavailable')
const completed = { ...job, status: 'done', transcribedInstruments: ['piano', 'drums'],
  transcriptionQuality: { piano: { status: 'usable' }, drums: { status: 'tentative' } } }
assert.equal(instrumentStatus(completed, 'piano'), 'transcribed; draft')
assert.equal(instrumentStatus(completed, 'drums'), 'transcribed; tentative / low confidence')
assert.equal(instrumentStatus({ ...completed, transcriptionQuality: { drums: { status: 'usable', scoreWithheld: true } } }, 'drums'),
  'score withheld; insufficient instrument evidence')
assert.equal(instrumentStatus({ ...completed, transcriptionQuality: { piano: { status: 'tentative', scoreWithheld: true } } }, 'piano'),
  'score withheld; insufficient instrument evidence')
assert.equal(instrumentStatus({ ...completed, transcriptionQuality: { drums: { status: 'empty' } } }, 'drums'),
  'attempted; no events recovered')
assert.equal(instrumentStatus({ ...completed, transcriptionQuality: { vocals: { status: 'tentative' } } }, 'vocals'),
  'transcribed; tentative / low confidence')
assert.equal(instrumentStatus({ ...job, selectedInstruments: ['piano', 'drums', 'vocals'] }, 'vocals'), 'transcribing')
const update = { ...job, id: 'update', kind: 'transcribe', songId: 'saved', progress: 0.39, stage: 'detect',
  stageProgress: null, stageMessage: null }
assert.equal(activeAnalysis([update], 'saved'), update)
assert.equal(activeAnalysis([{ ...update, status: 'done' }], 'saved'), undefined)
assert.equal(activeAnalysis([update], 'different'), undefined)
assert.equal(analysisProgress(update), 'Updating analysis · Preparing audio and notes')
assert.doesNotMatch(analysisProgress(update), /39%/)
assert.match(analysisProgress({ ...update, stageProgress: 0.39 }), /39% step/)
assert.match(analysisProgress({ ...update, status: 'queued' }), /queued/)
const timedOutLarge = { ...update, status: 'failed', errorCode: 'model_failed',
  errorMessage: 'muscriptor-large CPU inference exceeded its bounded run time.',
  transcriptionModel: 'muscriptor-large', processingMode: 'local' }
assert.equal(smallerCpuRetryModel(timedOutLarge), 'muscriptor-small')
assert.equal(smallerCpuRetryModel({ ...timedOutLarge, errorMessage: 'Checkpoint failed.' }), null)
assert.equal(smallerCpuRetryModel({ ...timedOutLarge, processingMode: 'cloud' }), null)
assert.equal(smallerCpuRetryModel({ ...timedOutLarge, transcriptionModel: 'muscriptor-small' }), null)
console.log('Job status: auto, explicit, weak, empty, interrupted, and legacy cases passed.')
