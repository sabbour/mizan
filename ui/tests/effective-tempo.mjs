import assert from 'node:assert/strict'
import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { buildSong } = await vite.ssrLoadModule('/src/workspace/song.ts')
  const { Engine } = await vite.ssrLoadModule('/src/workspace/engine.ts')
  const engine = new Engine({ ...buildSong(), tempoMap: [
    { beat: 0, time: 0 },
    { beat: 4, time: 2 },
    { beat: 8, time: 5 },
  ] })
  engine.rate = 0.5
  engine.pausedBeat = 5
  assert.ok(Math.abs(engine.getEffectiveQuarterBpm() - 40) < 1e-8)

  engine.song.tempoMap = undefined
  engine.pausedBeat = 0
  assert.equal(engine.getEffectiveQuarterBpm(), engine.song.bpm * engine.rate)
  console.log('Effective quarter-BPM checks passed')
} finally {
  await vite.close()
}
