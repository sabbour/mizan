import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

globalThis.matchMedia = () => ({ matches: false })
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { buildSong } = await vite.ssrLoadModule('/src/workspace/song.ts')
  const { pianoXml, vocalXml, chordsXml, drumXml } = await vite.ssrLoadModule('/src/workspace/musicxml.ts')
  const { Engine } = await vite.ssrLoadModule('/src/workspace/engine.ts')
  const { ChordChart } = await vite.ssrLoadModule('/src/workspace/ChordChart.tsx')
  const React = await import('react')
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
    assert.deepEqual(ticks, [[0, true], [0.5, false], [1, false], [1.5, true]])
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
  console.log('3/4 and 6/8 score and chart meter checks passed')
} finally {
  await vite.close()
}
