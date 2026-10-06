import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

globalThis.matchMedia = () => ({ matches: false })
if (process.argv[1]?.endsWith('meter.mjs')) await meterChecks()

async function meterChecks() {
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { buildSong } = await vite.ssrLoadModule('/src/workspace/song.ts')
  const { pianoXml, vocalXml, chordsXml, drumXml, instrumentXml, notationNotes } = await vite.ssrLoadModule('/src/workspace/musicxml.ts')
  const { Engine } = await vite.ssrLoadModule('/src/workspace/engine.ts')
  const { ChordChart } = await vite.ssrLoadModule('/src/workspace/ChordChart.tsx')
  const React = await import('react')
  const { measures, barAt, barStart, songBeats } = await vite.ssrLoadModule('/src/workspace/meter.ts')
  const { accompanimentRhythm, creativeTracks } = await vite.ssrLoadModule('/src/workspace/creative.ts')
  const { fromHost } = await vite.ssrLoadModule('/src/library/adapt.ts')
  for (const [beatsPerBar, beatUnit, numerator] of [[3, 4, 3], [3, 8, 6]]) {
    const song = {
      ...buildSong(), bpm: 120, beatsPerBar, beatUnit, bars: 2,
      sections: [{ name: 'Study', startBar: 1, bars: 2 }],
      chords: [
        { startBeat: 0, beats: 3, symbol: 'C', numeral: 'I', tones: [60, 64, 67], flats: false, confidence: 1 },
        { startBeat: 3, beats: 3, symbol: 'Dm', numeral: 'ii', tones: [62, 65, 69], flats: false, confidence: 1 },
      ],
      piano: [{ midi: 60, startBeat: 3, beats: 2, hand: 'right' }],
      vocals: [{ midi: 62, startBeat: 3, beats: 1 }],
      drums: [{ lane: 'kick', startBeat: 3, velocity: 1 }],
      confidence: { chords: ['high', 'high'] },
    }
    for (const exportXml of [pianoXml, vocalXml, chordsXml, drumXml]) {
      const xml = exportXml(song)
      assert.match(xml, new RegExp(`<time><beats>${numerator}</beats><beat-type>${beatUnit}</beat-type></time>`))
      assert.equal((xml.match(/<measure number=/g) ?? []).length, 2)
      assert.match(xml, /<backup><duration>48<\/duration><\/backup>|<duration>48<\/duration>/)
    }
    const chart = renderToStaticMarkup(React.createElement(ChordChart, {
      song, engine: {}, bar: 1, loop: null, confidence: song.confidence.chords, onPick: () => {},
    }))
    assert.equal((chart.match(/class="chart-bar"/g) ?? []).length, 2)
    const secondBar = chart.split('aria-label="Bar 2"')[1]?.split('</button>')[0]
    assert.ok(secondBar?.includes('Dm'), 'The chord at quarter beat 3 belongs to bar 2')
    const engine = new Engine({ ...song, chords: [], piano: [], vocals: [], drums: [] })
    engine.click = true
    const ticks = []
    engine.tick = (time, accented) => ticks.push([time, accented])
    engine.events(0, 3.25, 0, 0.5, false)
    assert.deepEqual(ticks, beatUnit === 8
      ? [[0, true], [0.75, false], [1.5, true]]
      : [[0, true], [0.5, false], [1, false], [1.5, true]])
  }
  const odd = new Engine({ ...buildSong(), beatsPerBar: 2.5, beatUnit: 8, chords: [], piano: [], vocals: [], drums: [] })
  const oddScore = { ...odd.song, bars: 1 }
  assert.match(pianoXml(oddScore), /<time><beats>5<\/beats><beat-type>8<\/beat-type><\/time>/)
  assert.match(pianoXml(oddScore), /<backup><duration>40<\/duration><\/backup>/)
  odd.click = true
  const ticks = []
  odd.tick = (time, accented) => ticks.push([time, accented])
  odd.events(2, 3.25, 0, 0.5, false)
  assert.deepEqual(ticks, [[0, false], [0.25, true], [0.5, false]])
  const song = {
    ...buildSong(), bpm: 120, bars: 4, beatsPerBar: 5, beatUnit: 4,
    barMap: [
      { startBeat: 0, beats: 5, numerator: 5, denominator: 4, status: 'explicit' },
      { startBeat: 5, beats: 3.5, numerator: 7, denominator: 8, status: 'explicit' },
      { startBeat: 8.5, beats: 4, numerator: 4, denominator: 4, status: 'explicit' },
      { startBeat: 12.5, beats: 1, numerator: 4, denominator: 4, status: 'explicit', partial: true },
    ],
    sections: [{ name: 'Mixed', startBar: 1, bars: 4 }], chords: [], drums: [], vocals: [],
    piano: [{ midi: 60, startBeat: 0, beats: 9, hand: 'right', generated: false, confidence: 1 }],
    instrumentNotes: undefined,
  }
  const snapshot = JSON.stringify(song)
  assert.equal(songBeats(song), 13.5)
  assert.deepEqual([0, 4.99, 5, 8.49, 8.5, 12.5].map((beat) => barAt(song, beat)), [0, 0, 1, 1, 2, 3])
  assert.deepEqual([0, 1, 2, 3, 4].map((bar) => barStart(song, bar)), [0, 5, 8.5, 12.5, 13.5])
  for (const exportXml of [pianoXml, vocalXml, chordsXml, drumXml]) {
    const xml = exportXml(song)
    assert.equal((xml.match(/<measure number=/g) ?? []).length, 4)
    assert.match(xml, /<time><beats>5<\/beats><beat-type>4<\/beat-type><\/time>/)
    assert.match(xml, /<time><beats>7<\/beats><beat-type>8<\/beat-type><\/time>/)
    assert.match(xml, /<time><beats>4<\/beats><beat-type>4<\/beat-type><\/time>/)
    assert.match(xml, /<measure number="4" implicit="yes">/)
  }
  assert.ok((pianoXml(song).match(/<tie type=/g) ?? []).length >= 4, 'Held notes tie across changing bar lengths')
  const empty = { ...song, piano: [] }
  assert.deepEqual(accompanimentRhythm(empty), [0, 2, 5, 7, 8.5, 10.5, 12.5])
  const adapted = fromHost({ ...song, confidence: {}, chords: [
    { startBeat: 8.5, beats: 1, symbol: 'C', numeral: 'I', tones: [60, 64, 67], flats: false, confidence: 0.2 },
  ] })
  assert.deepEqual(adapted.confidence.chords, ['high', 'high', 'low', 'high'])
  assert.ok(creativeTracks(adapted).every((track) => track.piano.every((note) =>
    note.startBeat >= 0 && note.startBeat + note.beats <= 13.5)))
  const engine = new Engine(empty)
  engine.click = true
  const mixedTicks = []
  engine.tick = (time, accented) => mixedTicks.push([time, accented])
  engine.events(5, 9, 0, 0.5, false)
  assert.deepEqual(mixedTicks, [[0, true], [0.25, false], [0.5, false], [0.75, false],
    [1, false], [1.25, false], [1.5, false], [1.75, true]])
  const originalWindow = globalThis.window
  globalThis.window = { setInterval: () => 1, setTimeout: () => 1 }
  try {
    for (const [beat, count] of [[5, 7], [8.5, 4], [12.5, 1]]) {
      const counter = new Engine(empty)
      counter.ctx = { currentTime: 0 }
      const ticks = []
      counter.tick = (time, accented) => ticks.push([time, accented])
      counter.startAt(beat, true)
      for (let i = 0; i < 100 && counter.counting; i++) {
        counter.ctx.currentTime += 0.05
        counter.schedule()
      }
      assert.equal(ticks.length, count, `Count-in at beat ${beat} uses the current measure`)
      assert.equal(ticks[0][1], true)
      counter.halt()
    }
    const loop = new Engine(empty)
    loop.ctx = { currentTime: 0 }
    loop.countIn = false
    loop.loop = { startBar: 2, endBar: 3 }
    loop.startAt(12.4, false)
    loop.ctx.currentTime = 0.2
    loop.schedule()
    assert.ok(loop.read().beat >= 5 && loop.read().beat < 6, 'The loop wraps at beat 12.5 to beat 5')
    loop.halt()
  } finally { globalThis.window = originalWindow }
  for (const barMap of [[], null, [{ ...song.barMap[0], startBeat: 1 }],
    [{ ...song.barMap[0], beats: Number.NaN }], [{ ...song.barMap[0], denominator: 3 }]]) {
    assert.throws(() => measures({ ...song, bars: barMap?.length ?? 1, barMap }), /bar|meter/)
  }
  assert.equal(JSON.stringify(song), snapshot, 'Meter views, playback and exports never mutate source data')
  for (const [tail, base, from, gate] of [
    [0.01, 4, 0.25, 0.5], [0.0000001, 4, 0.25, 0.5], [0.01, 4, 0.999999, 0.0000005],
    [0.01, 0, 0.25, 0.5], [0.0000001, 0, 0.25, 0.5],
  ]) {
    const note = { midi: 60, startBeat: base + tail * from, beats: tail * gate, hand: 'right',
      onset: (base + tail * from) / 2, offset: (base + tail * (from + gate)) / 2 }
    const tiny = { ...song, bars: 2, beatsPerBar: 4, beatUnit: 4,
      barMap: base === 0 ? [
        { startBeat: 0, beats: tail, numerator: 4, denominator: 4, status: 'explicit', partial: true },
        { startBeat: tail, beats: 4, numerator: 4, denominator: 4, status: 'explicit' },
      ] : [
        { startBeat: 0, beats: 4, numerator: 4, denominator: 4, status: 'explicit' },
        { startBeat: 4, beats: 4 + tail - 4, numerator: 4, denominator: 4, status: 'explicit', partial: true },
      ], piano: [note], vocals: [note], instrumentNotes: { flute: [note] },
      chords: [{ startBeat: note.startBeat, beats: note.beats, tones: [60], symbol: 'C', flats: false }],
      drums: [{ startBeat: note.startBeat, lane: 'kick', velocity: 1 }],
    }
    const before = JSON.stringify(tiny)
    for (const xml of [pianoXml(tiny), vocalXml(tiny), chordsXml(tiny), drumXml(tiny),
      instrumentXml(tiny, { id: 'flute', name: 'Flute', instrument: 'other' })]) {
      assert.equal((xml.match(/<measure number=/g) ?? []).length, 2)
      assert.ok([...xml.matchAll(/<duration>(\d+)<\/duration>/g)].every((match) => +match[1] > 0))
      assert.match(xml.split(`<measure number="${base === 0 ? 1 : 2}"`)[1].split('</measure>')[0], /<pitch>|<unpitched>/,
        'The source head inside a tiny partial measure must not be dropped')
    }
    assert.ok(notationNotes([note], 'piano', tiny)[0].endBeat <= songBeats(tiny))
    assert.equal(JSON.stringify(tiny), before, 'Adaptive engraving leaves source seconds and beat positions untouched')
  }
  console.log('Meter checks passed: legacy 3/4, compound 6/8, odd and changing maps, ties, clicks, count-in, loops, confidence, creative rhythm, partials, validation and source immutability.')
} finally {
  await vite.close()
}
}

export async function browserMeterChecks() {
  const { default: React } = await import('/node_modules/.vite/deps/react.js')
  const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js')
  const { buildSong } = await import('/src/workspace/song.ts')
  const { pianoXml, notationNotes } = await import('/src/workspace/musicxml.ts')
  const { Score, measure, scoreX } = await import('/src/workspace/Score.tsx')
  const { Workspace } = await import('/src/workspace/Workspace.tsx')
  const { Engine } = await import('/src/workspace/engine.ts')
  const { barStart } = await import('/src/workspace/meter.ts')
  const osmdModule = await import('/node_modules/.vite/deps/opensheetmusicdisplay.js')
  const OpenSheetMusicDisplay = osmdModule.OpenSheetMusicDisplay ?? osmdModule.default?.OpenSheetMusicDisplay
  const check = (value, message) => { if (!value) throw new Error(message) }
  const wait = async (test, message) => {
    for (let i = 0; i < 100; i++) {
      if (test()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(message)
  }
  const song = {
    ...buildSong(), title: 'Changing meter fixture', bars: 4, beatsPerBar: 5, beatUnit: 4,
    barMap: [
      { startBeat: 0, beats: 5, numerator: 5, denominator: 4, status: 'explicit' },
      { startBeat: 5, beats: 3.5, numerator: 7, denominator: 8, status: 'explicit' },
      { startBeat: 8.5, beats: 4, numerator: 4, denominator: 4, status: 'supported' },
      { startBeat: 12.5, beats: 1, numerator: 4, denominator: 4, status: 'unverified', partial: true },
    ],
    piano: [
      { midi: 60, startBeat: 0, beats: 9, hand: 'right' },
      { midi: 67, startBeat: 8.5, beats: 1, hand: 'right' },
      { midi: 69, startBeat: 12.5, beats: 1, hand: 'right' },
    ], drums: [], vocals: [], chords: [], instrumentNotes: undefined,
    sections: [{ name: 'Mixed', startBar: 1, bars: 4 }],
    confidence: { piano: ['high', 'high', 'high', 'high'] },
  }
  const snapshot = JSON.stringify(song)
  const automatic = [{ midi: 60, startBeat: 8.45, beats: 0.4, hand: 'right', generated: false, confidence: 0.3 }]
  const projected = notationNotes(automatic, 'piano', song)[0]
  check(projected.startBeat < 8.5 && projected.sourceStartBeat === 8.45,
    'Notation projection cannot cross a changing-meter boundary or rewrite its source onset')
  const host = document.createElement('div')
  host.style.width = '1050px'
  document.body.append(host)
  const osmd = new OpenSheetMusicDisplay(host, { autoResize: false, backend: 'svg', drawTitle: false, pageFormat: 'Endless' })
  try {
    await osmd.load(pianoXml(song))
    osmd.render()
    const layout = measure(osmd, host)
    check(layout.bars.length === 4, 'Changing meter and trailing partial engrave as four bars')
    const box = layout.bars[2]
    const x = scoreX(layout, 8.5, song)
    check(x !== null && x >= box.x && x <= box.x + box.w, 'Beat 8.5 is placed in the actual third bar')
  } finally { host.remove() }
  for (const [tail, base, from, gate] of [
    [0.01, 4, 0.25, 0.5], [0.0000001, 4, 0.25, 0.5], [0.01, 4, 0.999999, 0.0000005],
    [0.01, 0, 0.25, 0.5], [0.0000001, 0, 0.25, 0.5],
  ]) {
    const note = { midi: 60, startBeat: base + tail * from, beats: tail * gate, hand: 'right' }
    const later = { midi: 67, startBeat: tail + 2, beats: 1, hand: 'right' }
    const tiny = { ...song, bars: 2, beatsPerBar: 4, beatUnit: 4, piano: base === 0 ? [note, later] : [note],
      barMap: base === 0 ? [
        { startBeat: 0, beats: tail, numerator: 4, denominator: 4, status: 'explicit', partial: true },
        { startBeat: tail, beats: 4, numerator: 4, denominator: 4, status: 'explicit' },
      ] : [
        { startBeat: 0, beats: 4, numerator: 4, denominator: 4, status: 'explicit' },
        { startBeat: 4, beats: 4 + tail - 4, numerator: 4, denominator: 4, status: 'explicit', partial: true },
      ] }
    const host = document.createElement('div')
    host.style.width = '1050px'
    document.body.append(host)
    const osmd = new OpenSheetMusicDisplay(host, { autoResize: false, backend: 'svg', drawTitle: false, pageFormat: 'Endless' })
    try {
      await osmd.load(pianoXml(tiny))
      osmd.render()
      const layout = measure(osmd, host, tiny)
      check(layout.bars.length === 2, 'Tiny positive partial must engrave as a second measure')
      const heads = osmd.GraphicSheet.MeasureList[base === 0 ? 0 : 1].flatMap((staff) =>
        (staff?.staffEntries ?? []).flatMap((entry) => entry.graphicalVoiceEntries.flatMap((voice) =>
          voice.notes.filter((n) => !n.sourceNote.isRest()))))
      check(heads.length > 0, 'The source note inside a tiny partial must have an actual engraved head')
    } finally { host.remove() }
    const mount = document.createElement('div')
    mount.style.cssText = 'position:fixed;inset:0;width:1100px;height:800px;background:white;z-index:9999'
    document.body.append(mount)
    const root = ReactDOM.createRoot(mount)
    const snapshot = JSON.stringify(tiny)
    const engine = {
      beat: note.startBeat + note.beats / 2,
      read() { return { beat: this.beat, playing: true, countingIn: false } },
    }
    try {
      root.render(React.createElement(Score, {
        xml: pianoXml(tiny), song: tiny, engine, bar: base === 0 ? 1 : 2, loop: null, confidence: [], noteNames: false,
        instrument: 'piano', playing: true, audioLoading: false, audioError: false, onPick: () => {}, previewId: 'piano',
      }))
      await wait(() => mount.querySelector('.score-head-active'),
        'The engraved tiny-partial head must bind and highlight during its actual source interval')
      engine.beat = note.startBeat + note.beats
      await wait(() => !mount.querySelector('.score-head-active'),
        'Tiny-partial highlighting must end at its source offset, not its padded notation length')
      if (base === 0) {
        engine.beat = later.startBeat + 0.5
        await wait(() => mount.querySelector('.score-head-active'),
          'Notes after a padded pickup must still highlight on the original source timeline')
        engine.beat = later.startBeat + later.beats
        await wait(() => !mount.querySelector('.score-head-active'),
          'Later highlighting must not inherit the pickup notation offset')
      }
      check(JSON.stringify(tiny) === snapshot, 'Tiny-partial rendering leaves source notes and bar coverage untouched')
    } finally {
      root.unmount()
      mount.remove()
    }
  }
  const mount = document.createElement('div')
  mount.style.cssText = 'position:fixed;inset:0;width:1100px;height:800px;background:white;z-index:9999'
  document.body.append(mount)
  const root = ReactDOM.createRoot(mount)
  let engine
  const originalSeek = Engine.prototype.seek
  const originalDispose = Engine.prototype.dispose
  Engine.prototype.seek = function (beat) { engine = this; originalSeek.call(this, beat) }
  Engine.prototype.dispose = function () { if (this.ctx?.close) originalDispose.call(this); else this.halt() }
  try {
    root.render(React.createElement(Workspace, {
      song, onBack: () => {}, start: { bar: 2, trackId: 'piano', loop: null, rate: 1, muted: [], solo: [] },
    }))
    await wait(() => engine && mount.querySelector('.score-bar[aria-label="Bar 3"]'), 'Workspace did not render the variable-meter score')
    check(engine.read().beat === 5, 'Saved bar 2 resumes at quarter beat 5')
    mount.querySelector('.score-bar[aria-label="Bar 3"]').click()
    await wait(() => Math.abs(engine.read().beat - 8.5) < 1e-6, 'Picking bar 3 did not seek to its serialized start')
    await wait(() => mount.querySelector('.ws-where').textContent.includes('4/4'), 'The header did not change to the current bar meter')
    check(mount.querySelector('.ws-where').textContent.includes('unverified'), 'Estimated signature spelling is explicitly unverified')
    mount.querySelector('.score-bar[aria-label="Bar 4"]').click()
    await wait(() => Math.abs(engine.read().beat - barStart(song, 3)) < 1e-6, 'The partial fourth bar has its own seek target')
    check(JSON.stringify(song) === snapshot, 'Rendered score and navigation never mutate source data')
    return 'Browser meter checks passed: changing meters, tiny partial engraving and source-bound head highlighting, boundary-safe projection, resume, bar picks, live signatures and source immutability.'
  } finally {
    root.unmount()
    mount.remove()
    Engine.prototype.seek = originalSeek
    Engine.prototype.dispose = originalDispose
  }
}
