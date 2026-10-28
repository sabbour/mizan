import assert from 'node:assert/strict'
import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
const originalWindow = globalThis.window
const originalFetch = globalThis.fetch
globalThis.window = { setInterval: () => 101, setTimeout: () => 102 }
try {
  const { Engine } = await vite.ssrLoadModule('/src/workspace/engine.ts')
  const { fromHost } = await vite.ssrLoadModule('/src/library/adapt.ts')
  const { buildSong } = await vite.ssrLoadModule('/src/workspace/song.ts')
  const { firstPlayableBeat } = await vite.ssrLoadModule('/src/workspace/firstNote.ts')
  const { GM_CHOICES, detectedGmProgram } = await vite.ssrLoadModule('/src/workspace/gmInstruments.ts')
  assert.deepEqual(GM_CHOICES.map((item) => item.name),
    GM_CHOICES.map((item) => item.name).sort((a, b) => a.localeCompare(b, 'en')))
  assert.equal(new Set(GM_CHOICES.map((item) => item.program)).size, 120)
  for (const [source, program] of [['violin', 40], ['flute', 73], ['electric_piano_1', 4],
    ['program_0', 0], ['program_127', 127], ['clean_electric_guitar', 27], ['electric_guitar', undefined]]) {
    assert.equal(detectedGmProgram(source), program)
  }
  const track = { id: 'instrument-organ', instrument: 'other', name: 'Flute', detail: '', gmProgram: 73 }
  const note = { midi: 60, startBeat: 4.25, beats: 4, velocity: 0.7 }
  const song = { ...buildSong(), bars: 8, tracks: [track], piano: [], vocals: [], drums: [], chords: [],
    instrumentNotes: { [track.id]: [note] } }
  const hydrated = fromHost({ ...song, tracks: [
    { ...track, gmProgram: undefined, sourceInstrument: 'violin' },
    { ...track, id: 'zero', gmProgram: 0, sourceInstrument: 'flute' },
    { ...track, id: 'drums', instrument: 'drums', gmProgram: undefined, sourceInstrument: 'violin' },
  ] })
  assert.deepEqual(hydrated.tracks.map((part) => part.gmProgram), [40, 0, undefined])

  const routed = new Engine(song)
  const played = []
  routed.gmNote = (...args) => played.push(args)
  routed.organ = routed.piano = routed.sampleNote = () => assert.fail('known programs must not use a legacy fallback')
  routed.events(4, 5, 0, 0.5, false)
  assert.equal(played[0][5], 73, 'a saved program outranks the stable organ ID')
  routed.song = { ...song, tracks: [{ ...track, instrument: 'piano', gmProgram: 4 }],
    piano: [{ ...note, trackId: track.id }], instrumentNotes: {} }
  routed.events(4, 5, 0, 0.5, false)
  assert.equal(played[1][5], 4, 'legacy piano-category tracks honor explicit non-grand programs')

  const requests = []
  globalThis.fetch = async (url) => {
    requests.push(url)
    return url.endsWith('manifest.json') ? { ok: true, json: async () => ({ instruments: [0, 40, 73].map((program) => ({
      program, name: String(program), samples: [60, 63].map((midi) => ({
        midi, url: `/samples/fluidr3/program_${program}/${midi}.mp3`,
      })),
    })) }) } : { ok: true, arrayBuffer: async () => new ArrayBuffer(4) }
  }
  const context = { currentTime: 2, decodeAudioData: async () => ({ duration: 1 }) }
  const sampler = new Engine(song)
  sampler.ctx = context
  await sampler.loadGmSamples(context)
  await sampler.loadGmSamples(context)
  assert.equal(requests.filter((url) => url.endsWith('/60.mp3')).length, 1, 'decoded roots are reused')
  await sampler.loadGmSamples(context, { ...song, instrumentNotes: { [track.id]: [{ ...note, midi: 63 }] } })
  assert.equal(sampler.gmSamples.get(73).length, 2, 'new pitch roots extend, not replace, the cache')
  const zero = { ...song, tracks: [{ ...track, gmProgram: 0 }] }
  await sampler.loadGmSamples(context, zero)
  assert.ok(sampler.gmSamples.has(0), 'GM0 is a real program, not missing')
  const errors = []
  sampler.onError = (error) => errors.push(error)
  globalThis.fetch = async () => ({ ok: false, status: 404 })
  await sampler.updateSong({ ...song, tracks: [{ ...track, gmProgram: 40 }] })
  assert.match(errors[0], /program 41.*404/)
  assert.equal(sampler.song, song, 'failed timbre preparation leaves the previous valid score playing')

  for (const playing of [false, true]) {
    const engine = new Engine(song)
    engine.ctx = context
    engine.rate = 0.65
    engine.loop = { startBar: 2, endBar: 5 }
    engine.muted = new Set(['sibling'])
    engine.trackGains.set(track.id, 0.4)
    engine.pausedBeat = 5.75
    let stopped = 0
    const recording = { media: { pause: () => assert.fail('instrument correction must not pause recording') } }
    engine.recording = recording
    if (playing) {
      engine.timer = 101
      engine.anchors = [{ time: 2, beat: 5.75, spb: 0.5, count: 0 }]
      engine.nodes.add({ stop: () => stopped++ })
    }
    let complete
    engine.loadGmSamples = () => new Promise((resolve) => { complete = resolve })
    const scheduled = []
    engine.schedule = () => scheduled.push([engine.cursorBeat, engine.resumeNotes])
    engine.halt = () => assert.fail('live updates must not halt the transport')
    const updated = { ...song, tracks: [{ ...track, gmProgram: 40 }] }
    const pending = engine.updateSong(updated)
    const anchors = engine.anchors
    assert.equal(engine.song, song, 'old timbre continues during asset loading')
    context.currentTime += playing ? 0.25 : 0
    const expected = engine.read().beat
    complete()
    await pending
    assert.equal(engine.playing, playing)
    assert.equal(engine.read().beat, expected, 'no reset or loading-time rewind')
    assert.equal(engine.anchors, anchors, 'the transport clock is retained')
    assert.equal(engine.recording, recording)
    assert.equal(engine.rate, 0.65)
    assert.deepEqual(engine.loop, { startBar: 2, endBar: 5 })
    assert.equal(engine.trackGains.get(track.id), 0.4)
    assert.ok(engine.muted.has('sibling'))
    assert.equal(stopped, playing ? 1 : 0, 'old held and scheduled voices are cancelled once')
    assert.deepEqual(scheduled, playing ? [[expected, true]] : [], 'held notes resume once at the current beat')
  }
  const counting = new Engine(song)
  counting.ctx = { currentTime: 2 }
  counting.timer = 101
  counting.anchors = [
    { time: 1.8, beat: 4.25, spb: 0.5, count: 4 },
    { time: 2.1, beat: 4.25, spb: 0.5, count: 0 },
  ]
  let cancelled = 0
  counting.nodes.add({ stop: () => cancelled++ })
  counting.schedule = () => {}
  counting.rescheduleSynth()
  assert.equal(cancelled, 1, 'old-timbre notes queued beyond the count-in are cancelled')
  assert.equal(counting.cursorTime, 2.1, 'the existing count-in entrance is retained')
  assert.equal(counting.read().countBeat, 4)
  assert.equal(counting.read().beat, 4.25)
  const reverted = new Engine(song)
  reverted.ctx = context
  let resolvePending
  reverted.loadGmSamples = () => new Promise((resolve) => { resolvePending = resolve })
  const obsolete = reverted.updateSong({ ...song, tracks: [{ ...track, gmProgram: 40 }] })
  await reverted.updateSong(song)
  resolvePending()
  await obsolete
  assert.equal(reverted.song, song, 'an obsolete asset load cannot overwrite a later score revision')

  const firstSong = { ...song, tracks: [track, { id: 'second', instrument: 'other' }],
    instrumentNotes: {
      [track.id]: [
        { ...note, startBeat: 0, midi: NaN }, { ...note, startBeat: 1, beats: 0 },
        { ...note, startBeat: 2, notPlayable: true }, { ...note, startBeat: 3, velocity: 0 },
        { ...note, startBeat: -1 }, note,
      ],
      second: [{ ...note, startBeat: 9.5 }],
    }, chordLabels: [{ startBeat: 0, beats: 1, symbol: 'C' }] }
  assert.equal(firstPlayableBeat(firstSong, track), 4.25, 'leading rests, labels and unusable events are skipped')
  assert.equal(firstPlayableBeat(firstSong, firstSong.tracks[1]), 9.5, 'only the active part is searched')
  assert.equal(firstPlayableBeat({ ...song, instrumentNotes: {} }, track), null)
  assert.equal(firstPlayableBeat(song, { ...track, chordal: true }), null)
  assert.equal(firstPlayableBeat({ ...song, piano: [
    { ...note, startBeat: 0, midi: 0 }, { ...note, startBeat: 2, midi: 109 }, note,
  ] }, { ...track, instrument: 'piano', gmProgram: 0 }), 4.25, 'dummy notes outside the keyboard are skipped')
  const drum = { id: 'drums', instrument: 'drums' }
  assert.equal(firstPlayableBeat({ ...song, drums: [
    { trackId: 'other-kit', lane: 'kick', startBeat: 0, velocity: 1 },
    { lane: 'invalid', startBeat: 1, velocity: 1 },
    { lane: 'kick', startBeat: 3.5, velocity: 0.8 },
  ] }, drum), 3.5)
  for (const playing of [false, true]) {
    const engine = new Engine(firstSong)
    engine.ctx = { currentTime: 0 }
    engine.rate = 0.5
    engine.startAt = (beat, countIn) => {
      engine.pausedBeat = beat
      engine.timer = 101
      assert.equal(countIn, false)
    }
    if (playing) engine.timer = 101
    engine.seek(firstPlayableBeat(firstSong, track))
    assert.equal(engine.read().beat, 4.25)
    assert.equal(engine.playing, playing, 'first-note seek does not autoplay a paused transport')
  }
  const mapped = new Engine({ ...firstSong, tempoMap: [
    { beat: 0, time: 0 }, { beat: 4, time: 2 }, { beat: 8, time: 6 },
  ] })
  mapped.rate = 0.5
  mapped.recording = { media: { hasAttribute: () => true, duration: 100, currentTime: 0 } }
  mapped.seek(firstPlayableBeat(mapped.song, track))
  assert.equal(mapped.recording.media.currentTime, 2.25, 'first-note beats seek to exact recording seconds across tempo changes')
  assert.equal(mapped.playing, false)
  console.log('Instrument identity, sorting, cache, live corrections, errors and first-note seek checks passed')
} finally {
  globalThis.fetch = originalFetch
  globalThis.window = originalWindow
  await vite.close()
}
