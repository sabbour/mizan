import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { Engine } = await vite.ssrLoadModule('/src/workspace/engine.ts')
  const { instrumentXml } = await vite.ssrLoadModule('/src/workspace/musicxml.ts')
  const picker = await readFile(new URL('../src/workspace/TrackPicker.tsx', import.meta.url), 'utf8')
  const { buildSong } = await vite.ssrLoadModule('/src/workspace/song.ts')
  const track = { id: 'guitar', instrument: 'other', name: 'Steel guitar', detail: 'Imported guitar', gmProgram: 25 }
  const song = {
    ...buildSong(), bars: 1, chords: [], piano: [], vocals: [], drums: [], tracks: [track],
    instrumentNotes: { guitar: [{ midi: 64, startBeat: 0, beats: 1 }] },
  }
  assert.match(instrumentXml(song, track), /<midi-program>26<\/midi-program>/)
  assert.match(instrumentXml(song, { ...track, gmProgram: 40 }), /<midi-program>41<\/midi-program>/)
  assert.match(picker, /GM sample/)

  const engine = new Engine(song)
  const played = []
  engine.gmNote = (...args) => played.push(args)
  engine.sampleNote = () => assert.fail('GM guitar preview must not use piano samples')
  engine.bus = (id) => id
  engine.events(0, 0.5, 0, 0.5, false)
  assert.equal(played.length, 1)
  assert.equal(played[0][4], track.id)

  const originalFetch = globalThis.fetch
  const actualManifest = JSON.parse(await readFile(
    new URL('../public/samples/fluidr3/manifest.json', import.meta.url), 'utf8',
  ))
  const actualProgram = actualManifest.instruments.find((item) => item.program === 25)
  assert.ok(actualProgram, 'the actual manifest includes the imported GM program')
  const silentRoot = actualProgram.samples.find((sample) => sample.midi === 63)
  const nearestAudibleRoot = actualProgram.samples.find((sample) => sample.midi === 66)
  assert.ok(silentRoot && nearestAudibleRoot, 'the actual bank includes adjacent minor-third roots')
  silentRoot.silent = true
  nearestAudibleRoot.silent = false
  const requests = []
  globalThis.fetch = async (url) => {
    requests.push(url)
    if (url === '/samples/fluidr3/manifest.json') {
      return { ok: true, json: async () => actualManifest }
    }
    const bytes = await readFile(new URL(`../public${url}`, import.meta.url))
    return {
      ok: true,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  }
  const context = { decodeAudioData: async (data) => ({ duration: 1, data }) }
  try {
    const sampler = new Engine(song)
    sampler.ctx = context
    await sampler.loadGmSamples(context)
    assert.deepEqual(requests, [
      '/samples/fluidr3/manifest.json',
      `/samples/fluidr3/${actualProgram.name}/66.mp3`,
    ], 'the actual MP3 loader skips a silent nearest root')
    assert.equal(sampler.gmSamples.get(25)[0].midi, 66)
    assert.equal(sampler.gmSamples.size, 1)
    assert.equal(
      sampler.gmSamples.get(25)[0].buffer.data.byteLength,
      nearestAudibleRoot.bytes,
      'the selected packaged MP3 reaches the decoder with its manifest byte length',
    )

    for (const sample of actualProgram.samples) sample.silent = true
    const silentProgram = new Engine(song)
    silentProgram.ctx = context
    await assert.rejects(silentProgram.loadGmSamples(context), /no valid samples for program 26/,
      'a program with no audible roots fails instead of scheduling silence')

    actualManifest.instruments = actualManifest.instruments.filter((item) => item.program !== 40)
    const missing = new Engine({ ...song, tracks: [{ ...track, gmProgram: 40 }] })
    missing.ctx = context
    await assert.rejects(missing.loadGmSamples(context), /missing program 41/,
      'a missing recognized sound-bank program fails instead of falling back')

    const bassTrack = { ...track, id: 'contrabass', gmProgram: 43 }
    const bassSong = {
      ...song,
      tracks: [bassTrack],
      instrumentNotes: { contrabass: [{ midi: 60, startBeat: 0, beats: 1 }] },
    }
    requests.length = 0
    const bass = new Engine(bassSong)
    bass.ctx = context
    await bass.loadGmSamples(context)
    assert.deepEqual(requests, ['/samples/fluidr3/contrabass/57.mp3'],
      'silent C4 roots route to the nearest actually usable contrabass sample')
    assert.equal(bass.gmSamples.get(43)[0].midi, 57)
    assert.equal(
      bass.gmSamples.get(43)[0].buffer.data.byteLength,
      actualManifest.instruments.find((item) => item.program === 43)
        .samples.find((sample) => sample.midi === 57).bytes,
      'the selected contrabass MP3 reaches the decoder with its manifest byte length',
    )

    const errors = [], loading = []
    const unavailable = new Engine(song)
    unavailable.ensure = () => ({ state: 'running' })
    unavailable.loadSamples = async () => { throw new Error('GM sample decode failed') }
    unavailable.onError = (message) => errors.push(message)
    unavailable.onLoading = (value) => loading.push(value)
    await unavailable.prepare(false)
    assert.deepEqual(errors, ['GM sample decode failed'])
    assert.deepEqual(loading, [true, false], 'sample failures use the existing loading/error path')
  } finally {
    globalThis.fetch = originalFetch
  }
  console.log('GM sample routing, lazy loading, and MusicXML export checks passed')
} finally {
  await vite.close()
}
