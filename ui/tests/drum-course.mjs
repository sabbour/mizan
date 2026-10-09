// Run from ui\: node tests\drum-course.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'

globalThis.matchMedia = () => ({ matches: false })
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { LESSONS, LEVELS, COLLECTIONS, FOOT_VOICES, VELOCITY, lessonHits, lessonList, lessonMeter, lessonNote, lessonSong } =
    await vite.ssrLoadModule('/src/course/curriculum.ts')
  const { freshPosition, tempoLabel } = await vite.ssrLoadModule('/src/course/state.ts')
  const { measures, songBeats } = await vite.ssrLoadModule('/src/workspace/meter.ts')
  const { drumXml } = await vite.ssrLoadModule('/src/workspace/musicxml.ts')
  const { kitStrike } = await vite.ssrLoadModule('/src/workspace/kit.ts')
  const { stickingFor, suggestSticking } = await vite.ssrLoadModule('/src/workspace/sticking.ts')
  const { loadPrefs, savePref } = await vite.ssrLoadModule('/src/workspace/prefs.ts')

  const course = lessonList({})
  const inspired = lessonList({ collection: 'inspired' })
  const genre = lessonList({ collection: 'genre' })
  assert.deepEqual(Object.keys(COLLECTIONS), ['inspired', 'genre'])
  assert.equal(course.length + inspired.length + genre.length, LESSONS.length, 'every lesson is in the course or one collection')
  assert.ok(course.length >= 30 && course.length <= 45, `a focused course (${course.length} lessons)`)
  assert.ok(inspired.length >= 6 && inspired.length <= 12 && genre.length >= 8 && genre.length <= 14, 'balanced collections')
  assert.equal(new Set(LESSONS.map((lesson) => lesson.id)).size, LESSONS.length, 'lesson ids are unique')
  assert.ok(course.every((lesson, i) => i === 0 || lesson.level >= course[i - 1].level), 'the course runs beginner to advanced')
  for (let level = 1; level <= LEVELS.length; level++)
    assert.ok(course.filter((lesson) => lesson.level === level).length >= 2, `level ${level} has at least two lessons`)
  assert.deepEqual(LEVELS, ['Pulse and rests', 'Subdivision', 'Rudiments', 'Grooves', 'Limb independence', 'Fills', 'Meter', 'Advanced'])
  // Existing lesson ids stay, so saved lesson positions still find their lessons.
  for (const id of ['quarter-pulse', 'quarter-rests', 'eighths', 'sixteenths', 'triplets', 'double-strokes', 'paradiddle', 'hat-and-kick',
    'rock-beat', 'paradiddle-groove', 'kick-syncopation', 'ride-and-hat-foot', 'snare-fill', 'tom-fill', 'accents-and-ghosts', 'waltz', 'six-eight'])
    assert.ok(course.some((lesson) => lesson.id === id), `${id} is still in the course`)
  for (const lesson of inspired) {
    assert.match(lesson.id, /^inspired-/)
    assert.match(lesson.style, /^Inspired by [A-Z]/, `${lesson.id} names the drummer it is inspired by`)
    assert.ok(lesson.feel?.length > 5, `${lesson.id} names its feel`)
    assert.match(lessonNote(lesson), /^Inspired by great drummers · Inspired by .* · Level \d · \d+ of \d+$/)
  }
  assert.ok(new Set(inspired.map((lesson) => lesson.style)).size === inspired.length, 'each inspired lesson has its own drummer')
  for (const lesson of genre) {
    assert.match(lesson.id, /^genre-/)
    assert.ok(lesson.style && lesson.feel, `${lesson.id} names its genre and feel`)
  }
  assert.ok(new Set(genre.map((lesson) => lesson.style)).size === genre.length, 'one lesson per genre')
  for (const lesson of [...inspired, ...genre]) {
    assert.ok(lesson.level >= 1 && lesson.level <= LEVELS.length, `${lesson.id} has a difficulty`)
    assert.ok(!/^Lesson \d/.test(lessonSong(lesson).title), 'collection lessons are not numbered as course lessons')
  }
  assert.equal(lessonSong(course[2]).title, `Lesson 3: ${course[2].title}`)

  // The spoken count for one step: in quarter-note meters by steps per quarter; in eighth-note meters by steps per eighth.
  const words = { 1: [''], 2: ['', '&'], 3: ['', 'trip', 'let'], 4: ['', 'e', '&', 'a'], 6: ['', 'la', 'li', '&', 'la', 'li'] }
  const patterns = new Set()
  const TOM_VOICES = ['t1', 't2', 'f1']
  for (const lesson of LESSONS) {
    const { beatsPerBar } = lessonMeter(lesson)
    assert.ok(lesson.goal.length > 20 && lesson.steps.length >= 2, `${lesson.id} has a goal and practical steps`)
    const ratio = lesson.tempo.start / lesson.tempo.target
    assert.ok(ratio >= 0.5 && ratio < 1 && Math.abs(ratio * 20 - Math.round(ratio * 20)) < 1e-9,
      `${lesson.id} starts below its target on the 5% speed steps`)
    assert.equal(freshPosition(lesson).rate, Math.round(ratio * 20) / 20)
    assert.ok(lesson.bars.length >= 2 && lesson.bars.length <= 4, `${lesson.id} is a short loop`)
    patterns.add(JSON.stringify(lesson.bars.map((bar) => [bar.notes, bar.sticking])))
    lesson.bars.forEach((bar, index) => {
      const where = `${lesson.id} bar ${index + 1}`
      const length = bar.steps * beatsPerBar
      for (const [voice, pattern] of Object.entries(bar.notes)) {
        assert.equal(pattern.length, length, `${where} ${voice} fills exactly one bar`)
        assert.match(pattern, voice === 'hh' ? /^[-xXgoOh]+$/ : /^[-xXg]+$/, `${where} ${voice} uses known symbols`)
        assert.ok(['hh', 'hp', 'sn', 'bd', 'rd', 'cr', ...TOM_VOICES].includes(voice), `${where} plays only the five-piece kit (${voice})`)
      }
      const tokens = bar.count.split(' ')
      assert.equal(tokens.length, length, `${where} counts every step`)
      const spoken = tokens.map((token) => token.replace(/^\((.*)\)$/, '$1'))
      const eighthMeter = lesson.meter.denominator === 8
      const perWord = eighthMeter ? bar.steps / 2 : bar.steps
      const expected = Array.from({ length }, (_, step) => {
        const word = (eighthMeter ? ['', '&'] : words[bar.steps])[step % perWord]
        return word || String(Math.floor(step / perWord) + 1)
      })
      assert.deepEqual(spoken, expected, `${where} counts in the right units for ${lesson.meter.numerator}/${lesson.meter.denominator}`)
      const voicesAt = (step) => Object.entries(bar.notes).filter(([, pattern]) => pattern[step] !== '-').map(([voice]) => voice)
      tokens.forEach((token, step) => {
        if (token.startsWith('(')) assert.equal(voicesAt(step).length, 0, `${where} rests where it counts silently (${token})`)
      })
      assert.ok(bar.sticking, `${where} has authored sticking`)
      const hands = Array.from({ length }, (_, step) => voicesAt(step).filter((voice) => !FOOT_VOICES.includes(voice)))
        .filter((voices) => voices.length)
      const sticking = bar.sticking.split(' ')
      assert.equal(sticking.length, hands.length, `${where} names a hand for every hand stroke`)
      sticking.forEach((token, i) => {
        assert.match(token, /^(R|L|R\+L)$/)
        assert.equal(token === 'R+L', hands[i].length > 1, `${where} uses R+L exactly where two hands play together`)
      })
    })
    const song = lessonSong(lesson)
    assert.equal(song.bars, lesson.bars.length)
    assert.ok(measures(song).every((bar) => bar.status === 'explicit'), `${lesson.id} uses its written meter`)
    assert.equal(song.bpm, lesson.tempo.target * lessonMeter(lesson).pulse)
    assert.equal(song.source, 'course')
    for (const hit of song.drums) {
      const strike = kitStrike(hit)
      assert.ok(hit.startBeat >= 0 && hit.startBeat < songBeats(song), `${lesson.id} hit inside the lesson`)
      assert.ok(strike.specified, `${lesson.id} names a specific kit piece for every hit`)
      assert.ok(Object.values(VELOCITY).includes(hit.velocity))
      assert.equal(!!hit.hand, !strike.foot, `${lesson.id}: every hand stroke has a hand and no foot stroke does`)
      if (/tom/.test(hit.lane)) {
        assert.ok([50, 47, 43].includes(hit.sourceMidi), `${lesson.id} uses one GM pitch per tom`)
        assert.ok(['tom1', 'tom2', 'floor'].includes(strike.pieces[0]), `${lesson.id} tom notes are on tom 1, tom 2 or the floor tom`)
      }
      assert.equal(hit.dynamic, hit.velocity === VELOCITY.g ? 'ghost' : hit.velocity === VELOCITY.X ? 'accent' : undefined)
    }
    // The hands read back from the hits match the sticking line, moment by moment.
    const moments = new Map()
    for (const hit of song.drums) if (hit.hand) moments.set(hit.startBeat, [...moments.get(hit.startBeat) ?? [], hit.hand])
    const written = lesson.bars.flatMap((bar) => bar.sticking.split(' '))
    assert.deepEqual([...moments.values()].map((list) => list.length > 1 ? (assert.deepEqual([...list].sort(), ['left', 'right']), 'R+L')
      : list[0] === 'right' ? 'R' : 'L'), written, `${lesson.id} hands follow the sticking in order`)
    assert.equal(stickingFor(song).source, 'lesson')
    const xml = drumXml(song, false, stickingFor(song).hands)
    assert.equal((xml.match(/<measure /g) ?? []).length, song.bars, `${lesson.id} engraves every bar`)
    const lyrics = (xml.match(/<lyric /g) ?? []).length
    assert.equal(lyrics, written.reduce((sum, token) => sum + token.split('+').length, 0), `${lesson.id} shows one letter per hand stroke`)
    assert.equal((xml.match(/parentheses="yes"/g) ?? []).length, song.drums.filter((hit) => hit.dynamic === 'ghost').length,
      `${lesson.id} parenthesises exactly its ghost notes`)
    assert.doesNotMatch(drumXml(song, false), /<lyric/, 'no letters when sticking is off')
  }
  assert.equal(patterns.size, LESSONS.length, 'every lesson plays a different pattern')

  const lesson = (id) => LESSONS.find((item) => item.id === id)
  const bar = (id, index = 0) => lesson(id).bars[index]
  // Rests are real rests in the score.
  assert.match(drumXml(lessonSong(lesson('quarter-rests')), false), /<rest\/>/)
  // Rudiment stickings.
  assert.equal(bar('double-strokes').sticking, 'R R L L R R L L R R L L R R L L')
  assert.equal(bar('paradiddle').sticking, 'R L R R L R L L R L R R L R L L')
  // Single-focus basics: hands alone, no kick mixed in.
  for (const id of ['sixteenths', 'triplets', 'double-strokes', 'paradiddle', 'moving-accents']) assert.deepEqual(Object.keys(bar(id).notes), ['sn'])
  // Hand mapping: alternating, doubles, the paradiddle, and both hands together (cymbal right, drum left).
  const handsOf = (id, lane) => lessonHits(lesson(id)).filter((hit) => !lane || hit.lane === lane).map((hit) => hit.hand)
  assert.deepEqual(handsOf('quarter-pulse').slice(0, 4), ['right', 'left', 'right', 'left'])
  assert.deepEqual(handsOf('double-strokes').slice(0, 8), ['right', 'right', 'left', 'left', 'right', 'right', 'left', 'left'])
  assert.deepEqual(handsOf('paradiddle').slice(0, 8), ['right', 'left', 'right', 'right', 'left', 'right', 'left', 'left'])
  assert.ok(handsOf('rock-beat', 'snare').every((hand) => hand === 'left') && handsOf('rock-beat', 'hihat').every((hand) => hand === 'right'))
  assert.ok(lessonHits(lesson('rock-beat')).filter((hit) => hit.lane === 'kick').every((hit) => !hit.hand), 'the kick has no hand')
  assert.ok(lessonHits(lesson('open-hi-hat')).filter((hit) => hit.sourceMidi === 44).every((hit) => !hit.hand), 'the hi-hat pedal has no hand')
  // Sticking that does not match the notes is an authoring error, not a guess.
  const broken = { ...lesson('rock-beat'), bars: [{ ...bar('rock-beat'), sticking: 'R R R R' }] }
  assert.throws(() => lessonHits(broken), /sticking/)
  // Dynamics: accents and ghost notes differ in velocity on the same snare.
  const ghosts = lessonHits(lesson('accents-and-ghosts')).filter((hit) => hit.lane === 'snare').map((hit) => hit.velocity)
  assert.ok(ghosts.includes(0.95) && ghosts.includes(0.3), 'backbeat accents and ghost notes')
  // Hi-hat articulations, one focus per lesson.
  const states = (id) => [...new Set(lessonHits(lesson(id)).map((hit) => kitStrike(hit).hat).filter(Boolean))].sort()
  assert.deepEqual(states('open-hi-hat'), ['closed', 'open', 'pedal'])
  assert.deepEqual(states('half-open-hi-hat'), ['closed', 'half-open', 'pedal'])
  // Fills: groove, then fill, then the crash on the next downbeat.
  for (const item of LESSONS.filter((candidate) => candidate.sections?.some((section) => section.name === 'Fill'))) {
    assert.ok(lessonHits(item).some((hit) => hit.lane === 'crash' && hit.startBeat === 0), `${item.id} lands on a crash at the loop's downbeat`)
    assert.deepEqual(item.sections.map((section) => section.name), ['Groove', 'Fill'])
  }
  const toms = lessonHits(lesson('tom-fill')).filter((hit) => /tom/.test(hit.lane)).map((hit) => kitStrike(hit).pieces[0])
  assert.deepEqual(toms, ['tom1', 'tom1', 'tom2', 'tom2', 'floor', 'floor', 'floor', 'floor'], 'the fill moves from tom 1 to tom 2 to the floor tom')
  assert.match(lesson('tom-fill').steps.join(' '), /tom 1, two on tom 2, then four on the floor tom/)
  const tomFill = bar('tom-fill', 3)
  ;['t1', 't2', 'f1'].forEach((voice) => assert.equal(tomFill.notes[voice].replace(/-/g, '')[0], 'X', `the first note on ${voice} is accented`))
  // Limb independence: a steady ostinato, a varied part, and the four-limb groove uses both feet.
  assert.equal(new Set(lesson('hat-ostinato-kick').bars.map((item) => item.notes.hh)).size, 1)
  assert.equal(new Set(lesson('hat-ostinato-kick').bars.map((item) => item.notes.bd)).size, 4, 'the kick changes every bar')
  assert.equal(new Set(lesson('snare-under-hat').bars.map((item) => item.notes.sn)).size, 4, 'the snare changes every bar')
  for (const item of lesson('four-limb-groove').bars) assert.ok(item.notes.bd.includes('x') && item.notes.hp.includes('x') && item.notes.rd && item.notes.sn)
  assert.ok(bar('offbeat-kick').notes.bd.split('').some((symbol, step) => symbol !== '-' && step % 2), 'the kick lands on sixteenth offbeats')
  const linear = lessonHits(lesson('linear-groove'))
  assert.equal(new Set(linear.map((hit) => hit.startBeat)).size, linear.length, 'the linear groove never plays two limbs at once')
  // Three against two is real: hands on triplets, kick on eighths, in separate voices so both rhythms are written.
  const threeTwo = lessonHits(lesson('three-over-two'))
  assert.deepEqual([...new Set(threeTwo.filter((hit) => hit.hand).map((hit) => +(hit.startBeat % 1).toFixed(3)))].sort(), [0, 0.333, 0.667])
  assert.deepEqual([...new Set(threeTwo.filter((hit) => hit.lane === 'kick').map((hit) => hit.startBeat % 1))].sort(), [0, 0.5])
  assert.match(drumXml(lessonSong(lesson('three-over-two')), false), /<voice>2<\/voice><type>eighth<\/type><stem>down<\/stem>/)
  // Swing and shuffle are triplet-based, not straight eighths relabelled.
  for (const [id, lane] of [['genre-jazz-swing', 'ride'], ['genre-blues-shuffle', 'hihat'], ['inspired-half-time-shuffle', 'hihat'], ['genre-reggae', 'hihat']]) {
    const offsets = new Set(lessonHits(lesson(id)).filter((hit) => hit.lane === lane).map((hit) => +(hit.startBeat % 1).toFixed(3)))
    assert.ok([...offsets].every((offset) => offset === 0 || offset === 0.667) && offsets.has(0.667), `${id} swings: beat and "let"`)
  }
  // Copy matches the authored patterns.
  for (const item of LESSONS) {
    const used = new Set()
    for (const lessonBar of item.bars) {
      for (const token of lessonBar.sticking?.split(' ') ?? []) for (const hand of token.split('+')) used.add(hand)
      if (lessonBar.notes.bd?.match(/[^-]/)) used.add('right foot')
      if (lessonBar.notes.hp?.match(/[^-]/)) used.add('left foot')
    }
    const text = [item.goal, item.limbs, ...item.steps].join(' ')
    const claimed = /\b(three|four)-limb\b/.exec(text)?.[1]
    if (claimed) assert.equal(used.size, claimed === 'three' ? 3 : 4, `${item.id} says ${claimed} limbs and uses ${[...used]}`)
  }
  const hatSteps = lesson('open-hi-hat').steps.join(' ')
  assert.ok(/pedal/.test(hatSteps) && /pressure/.test(hatSteps) && !/heel/.test(hatSteps), 'opening the hat is taught as easing pedal pressure')
  // Meters: simple, compound and odd, counted correctly.
  assert.deepEqual([...new Set(LESSONS.map((item) => `${item.meter.numerator}/${item.meter.denominator}`))].sort(), ['12/8', '3/4', '4/4', '5/4', '6/8', '7/8'])
  assert.equal(lessonSong(lesson('six-eight')).bpm, 90, '6/8 at 60 dotted quarters is 90 quarter notes per minute')
  assert.equal(lessonSong(lesson('seven-eight')).bpm, 100, '7/8 at 200 eighth notes is 100 quarter notes per minute')
  assert.equal(tempoLabel(lesson('seven-eight'), 200), '200 ♪')

  // Notation: one up-stemmed voice with beams inside each beat, ghost heads in parentheses, accents marked.
  {
    const ghostXml = drumXml(lessonSong(lesson('accents-and-ghosts')), false)
    assert.doesNotMatch(ghostXml, /<voice>2<\/voice>|<stem>down<\/stem>/, 'hands and feet share one up-stemmed voice')
    const ghostHeads = [...ghostXml.matchAll(/<note>(?:(?!<\/note>).)*parentheses="yes"(?:(?!<\/note>).)*<\/note>/g)].map(([note]) => note)
    assert.ok(ghostHeads.length && ghostHeads.every((note) => /<display-step>C<\/display-step><display-octave>5/.test(note)),
      'only the snare head is in parentheses, never the hi-hat in the same chord')
    assert.ok((ghostXml.match(/<accent /g) ?? []).length >= 4, 'the backbeat accents are marked')
    for (const measure of ghostXml.split('<measure ').slice(1)) {
      let open = 0
      for (const [, kind] of measure.matchAll(/<beam number="1">([a-z ]+)<\/beam>/g)) {
        if (kind === 'begin') { assert.equal(open, 0); open = 1 } else if (kind === 'end') { assert.equal(open, 1); open = 0 } else assert.equal(open, 1)
      }
      assert.equal(open, 0, 'every beam that begins ends in the same bar')
    }
    // A beam never crosses a beat: in sixteenth bars each group holds at most four notes.
    const groups = ghostXml.split('<beam number="1">begin</beam>').slice(1).map((part) => part.split('<beam number="1">end</beam>')[0])
    assert.ok(groups.every((part) => (part.match(/<beam number="1">continue<\/beam>/g) ?? []).length <= 2))
    const before = structuredClone(lessonHits(lesson('accents-and-ghosts')))
    drumXml(lessonSong(lesson('accents-and-ghosts')), false)
    assert.deepEqual(lessonHits(lesson('accents-and-ghosts')), before, 'notation leaves onsets and velocities alone')
    // 6/8 beams in dotted quarters and 7/8 as 2 + 2 + 3.
    const sixEight = drumXml(lessonSong(lesson('six-eight')), false).split('<measure ')[1]
    assert.equal((sixEight.match(/<beam number="1">begin<\/beam>/g) ?? []).length, 2)
    const sevenEight = drumXml(lessonSong(lesson('seven-eight')), false).split('<measure ')[1]
    assert.equal((sevenEight.match(/<beam number="1">begin<\/beam>/g) ?? []).length, 3)
    assert.equal((sevenEight.match(/<beam number="1">continue<\/beam>/g) ?? []).length, 1)
  }

  // Suggested sticking for transcribed drums: deterministic, right-hand lead, feet and ambiguous moments left blank.
  {
    const base = lessonSong(lesson('rock-beat'))
    const song = (drums) => ({ ...base, source: 'youtube', drums })
    const hit = (lane, startBeat, sourceMidi) => ({ trackId: 'drums', lane, startBeat, velocity: 0.7, ...(sourceMidi ? { sourceMidi } : {}) })
    const groove = song([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].flatMap((beat) => [hit('hihat', beat, 42),
      ...(beat === 1 || beat === 3 ? [hit('snare', beat)] : []), ...(beat === 0 || beat === 2 ? [hit('kick', beat)] : [])]))
    const grooveHands = stickingFor(groove)
    assert.equal(grooveHands.source, 'suggested')
    groove.drums.forEach((item, index) => assert.equal(grooveHands.hands[index],
      { hihat: 'right', snare: 'left', kick: undefined }[item.lane], `groove ${item.lane} at ${item.startBeat}`))
    const run = song([0, 0.25, 0.5, 0.75, 1, 1.25].map((beat) => hit('snare', beat)))
    assert.deepEqual(suggestSticking(run), ['right', 'left', 'right', 'left', 'right', 'left'], 'a fast run alternates from the right')
    const slow = song([0, 1, 2].map((beat) => hit('snare', beat)))
    assert.deepEqual(suggestSticking(slow), ['right', 'right', 'right'], 'slow single strokes stay with the right hand')
    const together = song([hit('snare', 0), hit('floortom', 0, 43)])
    assert.deepEqual(suggestSticking(together), ['left', 'right'], 'snare and floor tom together: left on the snare, right on the floor tom')
    const samePad = song([hit('hightom', 0, 50), hit('hightom', 0, 48)])
    assert.deepEqual(suggestSticking(samePad).sort(), ['left', 'right'], 'two GM toms on one drum are played with both hands')
    const crowded = song([hit('hihat', 0, 42), hit('snare', 0), hit('hightom', 0, 50)])
    assert.deepEqual(suggestSticking(crowded), [undefined, undefined, undefined], 'more than two hand strokes are not guessed')
    const cymbals = song([hit('crash', 0), hit('ride', 0)])
    assert.deepEqual(suggestSticking(cymbals), [undefined, undefined], 'two cymbals together are not guessed')
    const feet = song([hit('kick', 0), hit('hihat', 1, 44)])
    assert.deepEqual(suggestSticking(feet), [undefined, undefined], 'feet never get a hand')
    const before = structuredClone(groove.drums)
    const xml = drumXml(groove, false, grooveHands.hands)
    assert.deepEqual(groove.drums, before, 'suggestions never change the drum hits')
    assert.ok(!groove.drums.some((item) => 'hand' in item), 'suggestions are not written into the song')
    assert.equal((xml.match(/<lyric /g) ?? []).length, 8 + 2, 'every hi-hat stroke shows R; the backbeats add L')
    const crowdedXml = drumXml(crowded, false, suggestSticking(crowded))
    assert.doesNotMatch(crowdedXml, /<lyric/, 'no letters where no hand is suggested')
    assert.doesNotMatch(drumXml(groove, false), /<lyric|parentheses/, 'transcriptions without sticking or ghosts stay plain')
  }

  {
    const { lessonPosition, saveLessonPosition } = await vite.ssrLoadModule('/src/course/state.ts')
    const store = new Map()
    globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) }
    const warnings = []
    const warn = console.warn
    console.warn = (...args) => warnings.push(args[0])
    try {
      const fill = lesson('snare-fill')
      for (const rate of [0.25, 0.7, 1]) {
        const saved = { bar: 3, loop: { startBar: 2, endBar: 4 }, loopName: null, rate, trackId: 'drums', muted: [], solo: [] }
        saveLessonPosition(fill, saved)
        assert.deepEqual(lessonPosition(fill), saved, `a saved lesson at ${rate * 100}% speed round-trips`)
      }
      assert.equal(warnings.length, 0)
      for (const stored of ['{not json', '{"bar":9,"loop":null,"rate":0.7,"muted":[],"solo":[]}', '{"bar":1,"loop":null,"rate":1.25,"muted":[],"solo":[]}']) {
        store.set('mizan:course:position:snare-fill', stored)
        assert.deepEqual(lessonPosition(fill), freshPosition(fill), `unusable saved state starts fresh: ${stored}`)
      }
      assert.equal(warnings.length, 3, 'each unusable saved position is reported, not silently replaced')

      // Practice preferences: only what the player sets, each kept apart, false kept as false.
      warnings.length = 0
      store.clear()
      assert.deepEqual(loadPrefs(), {}, 'nothing saved: the workspace defaults apply')
      savePref('countIn', false)
      savePref('rate', 0.65)
      savePref('click', false)
      savePref('sticking', false)
      assert.deepEqual(loadPrefs(), { countIn: false, rate: 0.65, click: false, sticking: false })
      savePref('click', true)
      assert.deepEqual(loadPrefs(), { countIn: false, rate: 0.65, click: true, sticking: false }, 'saving one keeps the others')
      for (const style of ['acoustic', 'illustrated', 'electronic']) {
        savePref('kitStyle', style)
        assert.equal(loadPrefs().kitStyle, style, `the ${style} kit style is remembered`)
      }
      assert.deepEqual(loadPrefs(), { countIn: false, rate: 0.65, click: true, sticking: false, kitStyle: 'electronic' })
      assert.deepEqual([...store.keys()], ['mizan:practice'], 'one key, and nothing else is written')
      assert.equal(warnings.length, 0)
      for (const [stored, expected] of [
        ['{not json', {}], ['[1]', {}], ['{"rate":1.5,"countIn":"no","click":true}', { click: true }],
        ['{"rate":0.33,"sticking":false}', { sticking: false }], ['{"rate":0.25,"countIn":true}', { rate: 0.25, countIn: true }],
        ['{"kitStyle":"vintage","click":false}', { click: false }],
      ]) {
        store.set('mizan:practice', stored)
        assert.deepEqual(loadPrefs(), expected, `restores what it can from ${stored}`)
      }
      assert.equal(warnings.length, 6, 'each unusable value is reported')
    } finally {
      console.warn = warn
      delete globalThis.localStorage
    }
  }
  console.log(`Drum course checks passed: ${course.length} course lessons in ${LEVELS.length} levels, ${inspired.length} inspired and ${genre.length} genre lessons; ` +
    'counts, stickings and hands, five-piece kit, rests, dynamics, articulations, meters, notation, suggested sticking and preferences.')
} finally {
  await vite.close()
}
