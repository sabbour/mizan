import assert from 'node:assert/strict'

const rounded = (value) => Math.round(value * 1e6) / 1e6
const scaleIntervals = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
  'melodic-minor': [0, 2, 3, 5, 7, 9, 11],
  'major-pentatonic': [0, 2, 4, 7, 9],
  'minor-pentatonic': [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  'whole-tone': [0, 2, 4, 6, 8, 10],
  diminished: [0, 1, 3, 4, 6, 7, 9, 10],
}

function assertPianoNotes(song, id) {
  assert.ok(song.piano.length > 0, `${id}: the piano part exists`)
  const total = song.bars * song.beatsPerBar
  for (const note of song.piano) {
    assert.ok(Number.isInteger(note.midi) && note.midi >= 21 && note.midi <= 108, `${id}: notes fit the stage piano`)
    assert.ok(Number.isFinite(note.startBeat) && note.startBeat >= 0 && note.startBeat < total)
    assert.ok(Number.isFinite(note.beats) && note.beats > 0 && note.startBeat + note.beats <= total + 1e-6)
    assert.ok(note.hand === 'left' || note.hand === 'right')
    assert.ok(Number.isInteger(note.finger) && note.finger >= 1 && note.finger <= 5, `${id}: written fingering remains in the music data`)
  }
}

function assertSpelling(note, id) {
  assert.equal(typeof note.spell, 'string', `${id}: the generated note has an explicit key-aware spelling`)
  const spelling = note.spell.replaceAll('\u266f', '#').replaceAll('\u266d', 'b')
  const match = /^([A-G])(#{1,2}|b{1,2})?$/.exec(spelling)
  assert.ok(match, `${id}: valid pitch spelling ${note.spell}`)
  const natural = {C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11}[match[1]]
  const alteration = [...(match[2] ?? '')].reduce((total, accidental) => total + (accidental === '#' ? 1 : -1), 0)
  assert.equal((natural + alteration + 12) % 12, note.midi % 12, `${id}: ${note.spell} names the actual sounding pitch`)
}

export function inspectPianoScales(cases) {
  assert.equal(cases.length, 15 * 12 * 3, 'Every family, tonic and hand variant is checked')
  assert.equal(new Set(cases.map(entry => entry.id)).size, cases.length)
  const seen = new Set()
  let notesChecked = 0
  for (const {id, family, pitch, variant, song} of cases) {
    assert.ok(scaleIntervals[family], `${id}: a known scale family`)
    assert.ok(Number.isInteger(pitch) && pitch >= 0 && pitch < 12)
    assert.ok(Number.isInteger(variant) && variant >= 0 && variant < 3)
    const combination = `${family}:${pitch}:${variant}`
    assert.ok(!seen.has(combination), `${id}: no repeated family/tonic/hand combination`)
    seen.add(combination)
    assertPianoNotes(song, id)
    const up = scaleIntervals[family]
    const down = family === 'melodic-minor' ? scaleIntervals.minor : up
    const octaves = family === 'chromatic' ? [0] : [0, 12]
    const peak = octaves.length * 12
    const expected = [
      ...octaves.flatMap(octave => up.map(interval => octave + interval)), peak,
      ...[...octaves].reverse().flatMap(octave => [...down].reverse().map(interval => octave + interval)),
    ]
    assert.equal(song.beatsPerBar, 4, `${id}: scale studies use four-beat bars`)
    assert.equal(song.bars, Math.ceil(expected.length / 8), `${id}: the written scale fills the expected bar grid`)
    assertSpelling({spell: song.key?.tonic, midi: pitch}, id)
    const minorFamilies = ['minor', 'dorian', 'phrygian', 'locrian', 'harmonic-minor',
      'melodic-minor', 'minor-pentatonic', 'blues', 'diminished']
    assert.equal(song.key.mode, minorFamilies.includes(family) ? 'minor' : 'major',
      `${id}: key metadata agrees with the scale quality`)
    const hands = [...new Set(song.piano.map(note => note.hand))].sort()
    assert.deepEqual(hands, variant === 0 ? ['right'] : variant === 1 ? ['left'] : ['left', 'right'],
      `${id}: the selected hand variant changes the actual played notes`)
    for (const hand of hands) {
      const notes = song.piano.filter(note => note.hand === hand).sort((a, b) => a.startBeat - b.startBeat)
      assert.equal(notes[0].midi % 12, pitch, `${id}: the chosen tonic sets the sounding pitch`)
      assert.deepEqual(notes.map(note => note.midi - notes[0].midi), expected,
        `${id}: correct ascent and descent, including classical melodic-minor descent`)
      assert.deepEqual(notes.map(note => note.startBeat), expected.map((_, index) => index / 2),
        `${id}: even eighth-note timing`)
      assert.ok(notes.slice(0, -1).every(note => note.beats === 0.5), `${id}: moving notes last one eighth note`)
      assert.equal(notes.at(-1).beats, song.bars * song.beatsPerBar - notes.at(-1).startBeat,
        `${id}: the final tonic is held to the end of the written bar`)
      for (const note of notes) assertSpelling(note, id)
      if (up.length === 7) {
        const letters = 'CDEFGAB'
        const tonicLetter = letters.indexOf(song.key.tonic[0])
        assert.deepEqual(notes.slice(0, up.length).map(note => note.spell[0]),
          up.map((_, degree) => letters[(tonicLetter + degree) % 7]),
          `${id}: diatonic scale degrees use successive letter names, not enharmonic substitutions`)
      }
      if (hand === 'right' && family === 'major' && [1, 3, 6, 8, 10].includes(pitch)) {
        assert.notEqual(notes[0].finger, 1, `${id}: a black-key major tonic does not blindly inherit the C-major thumb`)
      }
    }
    notesChecked += song.piano.length
  }
  return {cases: cases.length, families: 15, tonics: 12, handVariants: 3, notesChecked}
}

export function inspectPianoProgressions(cases) {
  assert.equal(cases.length, 18 * 12, 'Every progression family is checked in all twelve tonics')
  assert.equal(new Set(cases.map(entry => entry.id)).size, cases.length)
  const roots = {
    major: [[0, 5, 7, 0], [0, 9, 5, 7], [2, 7, 0, 0], [0, 7, 9, 5], [0, 9, 2, 7],
      [0, 10, 5, 0], [0, 5, 7, 5], [0, 4, 5, 7], [0, 7, 9, 4, 5, 0, 5, 7], null],
    minor: [[0, 5, 7, 0], [0, 8, 3, 10], [0, 5, 10, 3], [0, 5, 7, 0], [0, 10, 8, 10],
      [0, 10, 8, 7], [2, 7, 0, 0], [0, 5, 0, 5]],
  }
  const qualities = {
    major: [['major', 'major', 'major', 'major'], ['major', 'minor', 'major', 'major'],
      ['minor7', 'dominant7', 'major7', 'major7'], ['major', 'major', 'minor', 'major'],
      ['major', 'minor', 'minor', 'major'], ['major', 'major', 'major', 'major'],
      ['major', 'major', 'major', 'major'], ['major', 'minor', 'major', 'major'],
      ['major', 'major', 'minor', 'minor', 'major', 'major', 'major', 'major'], null],
    minor: [['minor', 'minor', 'minor', 'minor'], ['minor', 'major', 'major', 'major'],
      ['minor', 'minor', 'major', 'major'], ['minor', 'minor', 'major', 'minor'],
      ['minor', 'major', 'major', 'major'], ['minor', 'major', 'major', 'major'],
      ['half-diminished', 'dominant7', 'minor', 'minor'], ['minor7', 'dominant7', 'minor7', 'dominant7']],
  }
  const chordTones = {
    major: [4], minor: [3], major7: [4, 11], minor7: [3, 10],
    dominant7: [4, 10], 'half-diminished': [3, 6, 10],
  }
  const seen = new Set()
  const variation = []
  let notesChecked = 0
  for (const {id, pitch, mode, variant, song, chords, title, hands} of cases) {
    assert.ok(Number.isInteger(pitch) && pitch >= 0 && pitch < 12)
    assert.ok(roots[mode] && Number.isInteger(variant) && variant >= 0 && variant < roots[mode].length)
    const combination = `${mode}:${variant}:${pitch}`
    assert.ok(!seen.has(combination), `${id}: no repeated progression/key combination`)
    seen.add(combination)
    assert.equal(song.beatsPerBar, 4)
    const pattern = roots[mode][variant]
    assert.equal(song.bars, pattern ? 16 : 24, `${id}: the actual music has the expanded written length`)
    assertSpelling({spell: song.key?.tonic, midi: pitch}, id)
    assert.equal(song.key.mode, mode, `${id}: key metadata agrees with the selected mode`)
    assert.equal(typeof title, 'string', `${id}: the progression has its displayed title`)
    assert.doesNotMatch(title, /\bas in\b/i, `${id}: song examples belong in the description, not the title`)
    assertPianoNotes(song, id)
    for (const note of song.piano) assertSpelling(note, id)
    const rootAt = beat => {
      const notes = song.piano.filter(note => note.hand === 'left' && Math.abs(note.startBeat - beat) < 1e-6)
        .sort((a, b) => a.midi - b.midi)
      assert.ok(notes.length, `${id}: the bass states the chord root at beat ${beat}`)
      return notes[0].midi % 12
    }
    const spans = []
    for (let bar = 0; bar < song.bars; bar++) {
      const indices = !pattern ? [bar % 12] : pattern.length === 8 ? [bar % 8] :
        bar >= 8 && bar < 12 ? [((bar - 8) * 2) % pattern.length, ((bar - 8) * 2 + 1) % pattern.length] :
        [bar % pattern.length]
      for (const [half, index] of indices.entries()) spans.push({
        bar, startBeat: bar * 4 + half * 4 / indices.length, beats: 4 / indices.length,
        root: pattern ? pattern[index] : [0, 0, 0, 0, 5, 5, 0, 0, 7, 5, 0, 7][index],
        quality: pattern ? qualities[mode][variant][index] : 'dominant7',
      })
    }
    assert.equal(chords.length, song.bars, `${id}: every written bar has its chord names`)
    assert.equal(song.chordLabels.length, spans.length, `${id}: every harmonic change appears in the score/audio chord timeline`)
    const labelsByBar = Array.from({length: song.bars}, () => [])
    for (const [index, span] of spans.entries()) {
      const label = song.chordLabels[index]
      assert.equal(label.startBeat, span.startBeat, `${id}: the chord label starts at its actual harmonic change`)
      assert.equal(label.beats, span.beats, `${id}: the chord label lasts exactly its harmonic span`)
      const symbol = label.symbol.replaceAll('\u266f', '#').replaceAll('\u266d', 'b')
      const symbolRoot = /^([A-G](?:#{1,2}|b{1,2})?)/.exec(symbol)?.[1]
      assertSpelling({spell: symbolRoot, midi: (pitch + span.root) % 12}, id)
      labelsByBar[span.bar].push(label.symbol)
      assert.equal(rootAt(span.startBeat), (pitch + span.root) % 12,
        `${id}: bar ${span.bar + 1}, beat ${span.startBeat % 4 + 1} plays the named harmonic root`)
      const {startBeat, beats, root, quality} = span
      for (const tone of chordTones[quality]) assert.ok(song.piano.some(note => note.hand === 'right' &&
        note.startBeat >= startBeat && note.startBeat < startBeat + beats &&
        note.midi % 12 === (pitch + root + tone) % 12),
      `${id}: bar ${span.bar + 1} actually contains ${quality} chord tone ${tone}`)
    }
    assert.deepEqual(chords, labelsByBar.map(labels => labels.join(' ')),
      `${id}: the written bar instructions agree with every actual chord span`)
    const pedals = song.pedals ?? []
    assert.equal(pedals.length > 0, /\bsustain pedal\b/i.test(hands),
      `${id}: the displayed right-foot instruction agrees with actual pedal data`)
    if (pedals.length) {
      assert.equal(pedals.length, spans.length, `${id}: sustain clears at every harmonic change`)
      for (const [index, pedal] of pedals.entries()) {
        assert.equal(pedal.controller, 64, `${id}: the event controls the sustain pedal`)
        assert.equal(pedal.startBeat, spans[index].startBeat + 0.25)
        assert.equal(pedal.beats, spans[index].beats - 0.5)
      }
    }
    assert.equal(rootAt(song.bars * 4 - 1), (pitch + (pattern?.[0] ?? 0) + 1) % 12,
      `${id}: the final bass pickup leads a semitone down into the next loop's first root`)
    if (pattern) {
      const phrases = Array.from({length: 4}, (_, phrase) => phraseSignature(song, phrase * 16, (phrase + 1) * 16))
      assert.equal(new Set(phrases).size, 4, `${id}: all four phrases contain real piano-part variation`)
      variation.push({id, distinctPhrases: 4})
    } else {
      assert.notEqual(phraseSignature(song, 0, 44), phraseSignature(song, 48, 92),
        `${id}: the second twelve-bar chorus varies the accompaniment, not only the final turnaround`)
      variation.push({id, distinctChoruses: 2})
    }
    notesChecked += song.piano.length
  }
  return {cases: cases.length, families: 18, tonics: 12, majorFamilies: 10, minorFamilies: 8, notesChecked, variation}
}

export function inspectPianoInspired(studies) {
  assert.equal(studies.length, 35, 'The final expanded Inspired piano catalog includes all 35 studies')
  assert.equal(new Set(studies.map(study => study.id)).size, 35)
  assert.equal(studies.filter(study => study.id.startsWith('piano-inspired-hans-zimmer-')).length, 9)
  for (const artist of ['pink-floyd', 'coldplay']) assert.ok(
    studies.filter(study => study.id.startsWith(`piano-inspired-${artist}-`)).length >= 2,
    `The expanded catalog retains the existing ${artist} studies`)
  const parts = new Map(), openings = new Map()
  const collisions = [], repeatedLoops = []
  for (const {id, song} of studies) {
    assert.ok(song.bars === 8 || song.bars === 16, `${id}: a developed eight- or sixteen-bar study`)
    assertPianoNotes(song, id)
    for (const [kind, signature, index] of [
      ['full', phraseSignature(song), parts],
      ['opening', phraseSignature(song, 0, 4 * song.beatsPerBar), openings],
    ]) {
      if (index.has(signature)) collisions.push({kind, first: index.get(signature), second: id})
      index.set(signature, id)
    }
    const phrases = Array.from({length: song.bars / 2}, (_, index) =>
      phraseSignature(song, index * 2 * song.beatsPerBar, (index + 1) * 2 * song.beatsPerBar))
    if (new Set(phrases).size === 1) repeatedLoops.push(id)
  }
  return {studies: studies.length, distinctParts: parts.size, distinctOpenings: openings.size, collisions, repeatedLoops}
}

export function phraseSignature(song, startBeat = 0, endBeat = song.bars * song.beatsPerBar) {
  const notes = song.piano.filter(note => note.startBeat >= startBeat && note.startBeat < endBeat)
    .map(note => ({...note, startBeat: rounded(note.startBeat - startBeat), beats: rounded(Math.min(note.beats, endBeat - note.startBeat))}))
    .sort((a, b) => a.startBeat - b.startBeat || a.hand.localeCompare(b.hand) || a.midi - b.midi || a.beats - b.beats)
  const anchors = new Map()
  for (const note of notes) if (!anchors.has(note.hand)) anchors.set(note.hand, note.midi)
  return JSON.stringify(notes.map(note => [
    note.startBeat, note.beats, note.hand, rounded(note.midi - anchors.get(note.hand)),
  ]))
}

export function rhythmSignature(song, endBeat = 4 * song.beatsPerBar) {
  const groups = new Map()
  for (const note of song.piano.filter(note => note.startBeat < endBeat)) {
    const key = JSON.stringify([rounded(note.startBeat), rounded(Math.min(note.beats, endBeat - note.startBeat)), note.hand])
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  const rhythm = [...groups].map(([key, count]) => [...JSON.parse(key), count])
    .sort((a, b) => a[0] - b[0] || a[2].localeCompare(b[2]) || a[1] - b[1] || a[3] - b[3])
  return JSON.stringify([rounded(endBeat), rhythm])
}

export function inspectPianoMusic(studies) {
  assert.equal(studies.length, 110, 'Every genre lesson is checked, not a sample')
  const genres = new Map()
  const signatures = {full: new Map(), phrase: new Map()}
  const collisions = []
  const rhythms = new Map()
  const rhythmCollisions = []
  const repeatedLoops = []
  for (const {id, style, level, song} of studies) {
    assert.ok(id && style && Number.isInteger(level) && level >= 1 && level <= 10)
    assert.equal(song.bars, level <= 5 ? 8 : 16, `${id}: the actual score/audio phrase has the required length`)
    assert.ok(Number.isFinite(song.beatsPerBar) && song.beatsPerBar > 0)
    assertPianoNotes(song, id)
    const levels = genres.get(style) ?? []
    levels.push(level)
    genres.set(style, levels)
    const phrases = [
      ['full', phraseSignature(song)],
      ['phrase', phraseSignature(song, 0, 4 * song.beatsPerBar)],
    ]
    for (const [kind, signature] of phrases) {
      const prior = signatures[kind].get(signature) ?? []
      for (const previous of prior) if (previous.style !== style) collisions.push({
        kind, first: previous.id, second: id, firstStyle: previous.style, secondStyle: style,
      })
      prior.push({id, style})
      signatures[kind].set(signature, prior)
    }
    const rhythm = rhythmSignature(song)
    const priorRhythms = rhythms.get(rhythm) ?? []
    for (const previous of priorRhythms) if (previous.style !== style) rhythmCollisions.push({
      first: previous.id, second: id, firstStyle: previous.style, secondStyle: style,
    })
    priorRhythms.push({id, style})
    rhythms.set(rhythm, priorRhythms)
    const twoBarPhrases = Array.from({length: song.bars / 2}, (_, index) =>
      phraseSignature(song, 2 * index * song.beatsPerBar, (2 * index + 2) * song.beatsPerBar))
    if (new Set(twoBarPhrases).size === 1) repeatedLoops.push(id)
  }
  assert.equal(genres.size, 11)
  for (const [style, levels] of genres) assert.deepEqual(
    levels.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], `${style}: all progression steps are checked`)
  return {
    lessons: studies.length, genres: genres.size,
    distinctParts: signatures.full.size, distinctOpeningPhrases: signatures.phrase.size,
    distinctOpeningRhythms: rhythms.size, collisions, rhythmCollisions, repeatedLoops,
  }
}
