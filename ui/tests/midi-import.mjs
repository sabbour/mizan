// Set MIZAN_TEST_PYTHON to a supported host Python, then run node tests\midi-import.mjs.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createServer } from 'vite'

const host = resolve('..', 'host')
const python = process.env.MIZAN_TEST_PYTHON ?? resolve(host, '.venv', 'Scripts', 'python.exe')
const opened = JSON.parse(execFileSync(python, ['-c', `
import base64, io, json, os, tempfile
import mido
with tempfile.TemporaryDirectory(prefix="mizan-midi-playback-") as home:
    os.environ["MIZAN_HOME"] = home
    from mizan.api import Api
    from mizan.jobs import JobRunner, JobStore
    midi = mido.MidiFile(type=0, ticks_per_beat=480)
    midi.tracks.append(mido.MidiTrack([
        mido.Message("program_change", channel=0, program=21),
        mido.MetaMessage("set_tempo", tempo=500000),
        mido.Message("note_on", channel=0, note=60, velocity=90),
        mido.Message("note_on", channel=9, note=43, velocity=100),
        mido.Message("note_off", channel=9, note=43, time=120),
        mido.MetaMessage("set_tempo", tempo=1000000, time=840),
        mido.Message("note_on", channel=0, note=64, velocity=80),
        mido.Message("note_off", channel=0, note=60, time=480),
        mido.Message("note_off", channel=0, note=64),
    ]))
    output = io.BytesIO()
    midi.save(file=output)
    runner = JobRunner(JobStore(), lambda job, report, cancelled: None)
    try:
        api = Api(runner)
        created = api.import_file("synthetic.mid", base64.b64encode(output.getvalue()).decode())
        assert created["ok"], created
        print(json.dumps(api.open_song(created["entry"]["id"])))
    finally:
        runner.close()
`], { env: { ...process.env, PYTHONPATH: host }, encoding: 'utf8' }))
assert.equal(opened.ok, true)

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
const originalWindow = globalThis.window
globalThis.window = { setInterval: () => 1, setTimeout: () => 2 }
try {
  const { fromHost } = await vite.ssrLoadModule('/src/library/adapt.ts')
  const { Engine } = await vite.ssrLoadModule('/src/workspace/engine.ts')
  const song = fromHost(opened.song)
  assert.equal(song.piano.length, 0)
  assert.equal(song.drums.length, 1)
  assert.equal(song.drums[0].sourceMidi, 43)
  assert.ok(song.tracks.some((track) => track.gmProgram === 21))
  assert.equal(song.bpm, 120)
  assert.deepEqual(song.tempoMap, [{ beat: 0, time: 0 }, { beat: 2, time: 1 }, { beat: 3, time: 2 }])
  for (const rate of [1, 0.75, 0.5]) {
    const engine = new Engine(song)
    engine.rate = rate
    engine.countIn = false
    engine.ctx = { currentTime: 0 }
    const calls = []
    engine.gmNote = (time, midi, duration, velocity, id, program) => calls.push({ time, midi, duration, id, program })
    engine.drum = (time, hit, id) => calls.push({ time, hit, id })
    engine.piano = () => assert.fail('Accordion and drums must not reach piano playback')
    engine.sampleNote = () => {}
    engine.pad = () => {}
    engine.startAt(0, false)
    for (let seconds = 0; seconds < 4 / rate; seconds += 0.025) {
      engine.ctx.currentTime = seconds
      if (engine.timer !== -1) engine.schedule()
    }
    const pitched = calls.filter((call) => call.program != null)
    assert.deepEqual(pitched.map((call) => call.program), [21, 21])
    const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} differs from ${expected}`)
    close(pitched[0].time, 0.05)
    close(pitched[0].duration, 2 / rate)
    close(pitched[1].time, 0.05 + 1 / rate)
    close(pitched[1].duration, 1 / rate)
    const drums = calls.filter((call) => call.hit)
    assert.equal(drums.length, 1)
    assert.equal(drums[0].hit.sourceMidi, 43)
    close(drums[0].time, pitched[0].time)
  }
  console.log('MIDI playback passed: real import/save/reopen, mixed-channel drums, accordion GM21, and exact 120-to-60 onsets/durations at full, 75% and half speed.')
} finally {
  globalThis.window = originalWindow
  await vite.close()
}
