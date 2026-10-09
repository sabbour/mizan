// Run from ui\: node tests\drum-course.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'

globalThis.matchMedia = () => ({ matches: false })
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { LESSONS, LEVELS, FOOT_VOICES, VELOCITY, lessonHits, lessonMeter, lessonSong } = await vite.ssrLoadModule('/src/course/curriculum.ts')
  const { freshPosition } = await vite.ssrLoadModule('/src/course/state.ts')
  const { measures, songBeats } = await vite.ssrLoadModule('/src/workspace/meter.ts')
  const { drumXml } = await vite.ssrLoadModule('/src/workspace/musicxml.ts')
  const { kitStrike } = await vite.ssrLoadModule('/src/workspace/kit.ts')

  assert.ok(LESSONS.length >= 16 && LESSONS.length <= 20, `about eighteen lessons (${LESSONS.length})`)
  assert.equal(new Set(LESSONS.map((lesson) => lesson.id)).size, LESSONS.length, 'lesson ids are unique')
  assert.ok(LESSONS.every((lesson, i) => i === 0 || lesson.level >= LESSONS[i - 1].level), 'lessons run beginner to intermediate')
  for (let level = 1; level <= LEVELS.length; level++)
    assert.ok(LESSONS.filter((lesson) => lesson.level === level).length >= 2, `level ${level} has at least two lessons`)

  // The spoken count for one step of the grid, by steps per quarter note.
  const words = { 1: [''], 2: ['', '&'], 3: ['', 'trip', 'let'], 4: ['', 'e', '&', 'a'] }
  const patterns = new Set()
  for (const lesson of LESSONS) {
    const { beatsPerBar, compound } = lessonMeter(lesson)
    assert.ok(lesson.goal.length > 20 && lesson.steps.length >= 2, `${lesson.id} has a goal and practical steps`)
    const ratio = lesson.tempo.start / lesson.tempo.target
    assert.ok(ratio >= 0.5 && ratio < 1 && Math.abs(ratio * 20 - Math.round(ratio * 20)) < 1e-9,
      `${lesson.id} starts below its target on the 5% speed steps`)
    assert.equal(freshPosition(lesson).rate, Math.round(ratio * 20) / 20)
    patterns.add(JSON.stringify(lesson.bars.map((bar) => bar.notes)))
    lesson.bars.forEach((bar, index) => {
      const where = `${lesson.id} bar ${index + 1}`
      const length = bar.steps * beatsPerBar
      for (const [voice, pattern] of Object.entries(bar.notes)) {
        assert.equal(pattern.length, length, `${where} ${voice} fills exactly one bar`)
        assert.match(pattern, voice === 'hh' ? /^[-xXgoOh]+$/ : /^[-xXg]+$/, `${where} ${voice} uses known symbols`)
      }
      const tokens = bar.count.split(' ')
      assert.equal(tokens.length, length, `${where} counts every step`)
      const spoken = tokens.map((token) => token.replace(/^\((.*)\)$/, '$1'))
      const expected = compound
        ? Array.from({ length }, (_, step) => String(step + 1))
        : Array.from({ length }, (_, step) => {
          const word = words[bar.steps][step % bar.steps]
          return word || String(Math.floor(step / bar.steps) + 1)
        })
      assert.deepEqual(spoken, expected, `${where} counts in the right units for ${lesson.meter.numerator}/${lesson.meter.denominator}`)
      const voicesAt = (step) => Object.entries(bar.notes).filter(([, pattern]) => pattern[step] !== '-').map(([voice]) => voice)
      tokens.forEach((token, step) => {
        if (token.startsWith('(')) assert.equal(voicesAt(step).length, 0, `${where} rests where it counts silently (${token})`)
      })
      if (bar.sticking) {
        const hands = Array.from({ length }, (_, step) => voicesAt(step).filter((voice) => !FOOT_VOICES.includes(voice)))
          .filter((voices) => voices.length)
        const sticking = bar.sticking.split(' ')
        assert.equal(sticking.length, hands.length, `${where} names a hand for every hand stroke`)
        sticking.forEach((token, i) => {
          assert.match(token, /^(R|L|R\+L)$/)
          assert.equal(token === 'R+L', hands[i].length > 1, `${where} uses R+L exactly where two hands play together`)
        })
      }
    })
    const song = lessonSong(lesson)
    assert.equal(song.bars, lesson.bars.length)
    assert.ok(measures(song).every((bar) => bar.status === 'explicit'), `${lesson.id} uses its written meter`)
    assert.equal(song.bpm, lesson.tempo.target * lessonMeter(lesson).pulse)
    assert.equal(song.source, 'course')
    for (const hit of song.drums) {
      assert.ok(hit.startBeat >= 0 && hit.startBeat < songBeats(song), `${lesson.id} hit inside the lesson`)
      assert.ok(kitStrike(hit).specified, `${lesson.id} names a specific kit piece for every hit`)
      assert.ok(Object.values(VELOCITY).includes(hit.velocity))
    }
    const xml = drumXml(song, false)
    assert.equal((xml.match(/<measure /g) ?? []).length, song.bars, `${lesson.id} engraves every bar`)
  }
  assert.equal(patterns.size, LESSONS.length, 'every lesson plays a different pattern')

  const lesson = (id) => LESSONS.find((item) => item.id === id)
  const bar = (id, index = 0) => lesson(id).bars[index]
  // Rests are real rests in the score.
  assert.match(drumXml(lessonSong(lesson('quarter-rests')), false), /<rest\/>/)
  // Rudiment stickings.
  assert.equal(bar('double-strokes').sticking, 'R R L L R R L L R R L L R R L L')
  assert.equal(bar('paradiddle').sticking, 'R L R R L R L L R L R R L R L L')
  // Dynamics: accents and ghost notes differ in velocity on the same snare.
  const ghosts = lessonHits(lesson('accents-and-ghosts')).filter((hit) => hit.lane === 'snare').map((hit) => hit.velocity)
  assert.ok(ghosts.includes(0.95) && ghosts.includes(0.3), 'backbeat accents and ghost notes')
  // Hi-hat articulations: closed, open, authored half-open and the pedal.
  const states = new Set(lessonHits(lesson('hi-hat-states')).map((hit) => kitStrike(hit).hat).filter(Boolean))
  assert.deepEqual([...states].sort(), ['closed', 'half-open', 'open', 'pedal'])
  // Fills: groove, then fill, then the crash on the next downbeat; the tom fill descends over five toms.
  for (const id of ['snare-fill', 'tom-fill']) {
    const hits = lessonHits(lesson(id))
    assert.ok(hits.some((hit) => hit.lane === 'crash' && hit.startBeat === 0), `${id} lands on a crash at the loop's downbeat`)
    assert.deepEqual(lesson(id).sections.map((section) => section.name), ['Groove', 'Fill'])
  }
  const toms = lessonHits(lesson('tom-fill')).filter((hit) => hit.lane === 'hightom' || hit.lane === 'floortom').map((hit) => hit.sourceMidi)
  assert.deepEqual(toms, [50, 50, 48, 48, 47, 47, 43, 41], 'the fill moves from the high tom to the low floor tom')
  // Meters: simple and compound, counted correctly.
  assert.deepEqual([...new Set(LESSONS.map((item) => `${item.meter.numerator}/${item.meter.denominator}`))].sort(), ['3/4', '4/4', '6/8'])
  assert.equal(lessonSong(lesson('six-eight')).bpm, 90, '6/8 at 60 dotted quarters is 90 quarter notes per minute')
  console.log(`Drum course checks passed: ${LESSONS.length} distinct lessons in ${LEVELS.length} levels; bar bounds, counts, stickings, rests, dynamics, articulations, meters and notation.`)
} finally {
  await vite.close()
}
