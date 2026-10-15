// Run from ui\: node tests\playability.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'

globalThis.matchMedia = () => ({ matches: false })
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { repairPiano, repairFretted, applyPlayability, playabilityNotice, shapeFits } = await vite.ssrLoadModule('/src/workspace/playability.ts')
  const { GUITAR, BASS, planFrettedTab } = await vite.ssrLoadModule('/src/workspace/fretboard.ts')
  const { buildSong } = await vite.ssrLoadModule('/src/workspace/song.ts')
  const { pianoXml, instrumentXml, frettedTabXml } = await vite.ssrLoadModule('/src/workspace/musicxml.ts')
  const { keyOf } = await vite.ssrLoadModule('/src/workspace/fingers.ts')

  const piano = (midi, hand, startBeat = 0, beats = 4, extra = {}) => ({ midi, hand, startBeat, beats, ...extra })
  const keysOf = (notes, hand) => [...new Set(notes.filter((n) => n.hand === hand).map((n) => keyOf(n.midi)))]
  const span = (keys) => keys.length ? Math.max(...keys) - Math.min(...keys) : 0

  // ---- Piano: one hand with seven notes
  {
    const notes = [piano(48, 'left'), ...[60, 62, 64, 65, 67, 69, 71].map((m) => piano(m, 'right'))]
    const { notes: fixed, summary } = repairPiano(notes, { bpm: 100 })
    assert.equal(summary.flagged, 1, 'seven notes in one hand is one flagged moment')
    assert.equal(summary.unplayable, 0)
    assert.ok(keysOf(fixed, 'right').length <= 5 && keysOf(fixed, 'left').length <= 5, 'no hand holds more than five notes')
    assert.equal(summary.moved, 2, 'the minimum number of notes moves')
    assert.equal(fixed.filter((n) => n.adjusted).length, 2)
    assert.equal(fixed.find((n) => n.midi === 48).hand, 'left', 'bass stays in the left hand')
    assert.equal(fixed.find((n) => n.midi === 71).hand, 'right', 'top voice stays in the right hand')
    assert.equal(notes[1].hand, 'right', 'the input is never changed')
    assert.deepEqual(repairPiano(notes, { bpm: 100 }).notes, fixed, 'deterministic')
  }

  // ---- Piano: a left hand spanning two octaves
  {
    const notes = [piano(36, 'left'), piano(48, 'left'), piano(60, 'left'), piano(72, 'right'), piano(74, 'right')]
    const { notes: fixed, summary } = repairPiano(notes, { bpm: 100 })
    assert.equal(summary.flagged, 1)
    assert.ok(span(keysOf(fixed, 'left')) <= 14 && span(keysOf(fixed, 'right')) <= 14, 'every hand within a ninth')
    assert.equal(fixed.find((n) => n.midi === 36).hand, 'left')
    assert.equal(fixed.find((n) => n.midi === 60).hand, 'right', 'the top of the stretch moves to the right hand')
    assert.equal(summary.moved, 1)
  }

  // ---- Piano: a tenth is accepted only when no split avoids it
  {
    const tenth = [piano(48, 'left'), piano(64, 'left')]
    const { notes, summary } = repairPiano(tenth, { bpm: 100 })
    assert.equal(summary.unplayable, 0)
    assert.ok(span(keysOf(notes, 'left')) <= 14, 'a sixteen-semitone left hand is split, because a split exists')
    const forced = [piano(48, 'left'), piano(52, 'left'), piano(56, 'left'), piano(60, 'left'), piano(64, 'left'),
      piano(65, 'right'), piano(67, 'right'), piano(69, 'right'), piano(71, 'right'), piano(73, 'right')]
    const wide = repairPiano(forced, { bpm: 100 })
    assert.equal(wide.summary.unplayable, 0, 'five notes and a tenth in each hand is allowed when nothing better exists')
    assert.equal(wide.summary.moved, 0)
  }

  // ---- Piano: crossed hands
  {
    const long = [piano(72, 'left', 0, 4), piano(60, 'right', 0, 4)]
    const { notes: fixed, summary } = repairPiano(long, { bpm: 120 })
    assert.equal(summary.flagged, 1, 'hands crossed for two seconds are flagged')
    assert.deepEqual(fixed.map((n) => n.hand), ['right', 'left'])
    const brief = [piano(72, 'left', 0, 0.25), piano(60, 'right', 0, 0.25), piano(64, 'left', 1, 1), piano(76, 'right', 1, 1)]
    const kept = repairPiano(brief, { bpm: 120 })
    assert.equal(kept.summary.flagged, 0, 'a short crossing is allowed')
    assert.equal(kept.notes, brief, 'nothing changes, same array')
  }

  // ---- Piano: a valid split is left alone
  {
    const notes = [piano(48, 'left', 0, 2), piano(55, 'left', 0, 2), piano(64, 'right', 0, 1), piano(67, 'right', 1, 1), piano(60, 'right', 2, 2),
      piano(43, 'left', 2, 2)]
    const result = repairPiano(notes, { bpm: 90 })
    assert.equal(result.notes, notes)
    assert.deepEqual([result.summary.flagged, result.summary.moved, result.summary.unplayable], [0, 0, 0])
    assert.deepEqual(playabilityNotice(result.summary), [])
  }

  // ---- Piano: written fingering stays where the hand did not change
  {
    const notes = [piano(48, 'left', 0, 4, { finger: 5 }),
      ...[60, 62, 64, 65, 67, 69, 71].map((m, i) => piano(m, 'right', 0, 4, { finger: (i % 5) + 1 }))]
    const { notes: fixed } = repairPiano(notes, { bpm: 100 })
    for (const [index, note] of fixed.entries()) {
      if (!note.adjusted) assert.equal(note.finger, notes[index].finger, 'unchanged notes keep their written finger')
    }
    const moved = fixed.filter((n) => n.adjusted)
    assert.ok(moved.length > 0 && moved.every((n) => n.hand === 'left'))
    assert.ok(moved.every((n) => n.finger === undefined || (n.finger >= 1 && n.finger <= 5)))
  }

  // ---- Piano: a bass note carried by the pedal does not hold the hand
  {
    const notes = [piano(43, 'left', 0, 3), piano(59, 'right', 1, 2), piano(62, 'right', 1, 2), piano(66, 'right', 1, 2), piano(81, 'right', 1, 2)]
    const { notes: fixed, summary } = repairPiano(notes, { bpm: 60 })
    assert.equal(summary.flagged, 1, 'a chord and a melody note two octaves higher are too wide for one hand')
    assert.equal(summary.unplayable, 0, 'the held bass is not counted against the left hand that now plays the chord')
    assert.deepEqual(fixed.map((n) => n.hand), ['left', 'left', 'left', 'left', 'right'])
    const held = [piano(43, 'left', 0, 3), piano(50, 'left', 1, 2)]
    assert.equal(repairPiano(held, { bpm: 60 }).summary.flagged, 0, 'a held bass under a chord a seventh up is fine')
  }

  // ---- Piano: not playable at all, and quick jumps
  {
    const cluster = Array.from({ length: 11 }, (_, i) => piano(50 + i, i < 5 ? 'left' : 'right'))
    const { notes: fixed, summary } = repairPiano(cluster, { bpm: 100 })
    assert.equal(summary.unplayable, 1, 'eleven notes at once cannot be played')
    assert.ok(summary.unplayableNotes > 0 && fixed.filter((n) => n.notPlayable).length === summary.unplayableNotes)
    assert.ok(fixed.find((n) => n.midi === 50).hand === 'left' && fixed.find((n) => n.midi === 60).hand === 'right', 'least-bad split keeps bass left and top right')
    const jump = repairPiano([piano(60, 'right', 0, 0.1), piano(100, 'right', 0.1, 0.1)], { bpm: 120 })
    assert.equal(jump.summary.warnings, 1, 'a three-octave jump in 50 ms is a warning')
    assert.equal(jump.summary.moved, 0, 'jumps are never repaired')
    assert.equal(jump.summary.unplayable, 0)
  }

  // ---- Piano: a long song is fast
  {
    const notes = []
    for (let bar = 0; bar < 150; bar++) for (let beat = 0; beat < 4; beat++) {
      notes.push(piano(36 + (bar % 5), 'left', bar * 4 + beat, 1), piano(48 + (bar % 7), 'left', bar * 4 + beat, 1))
      for (let k = 0; k < 4; k++) notes.push(piano(62 + k * 3 + (beat % 2), 'right', bar * 4 + beat, 1))
      if (bar % 20 === 0 && beat === 0) for (const m of [64, 66, 68, 70, 72, 74, 76]) notes.push(piano(m, 'right', bar * 4, 1))
    }
    repairPiano(notes, { bpm: 120 })
    const started = performance.now()
    const { summary } = repairPiano(notes, { bpm: 120 })
    const took = performance.now() - started
    assert.ok(summary.flagged > 0 && took < 50, `a ${notes.length}-note song repairs in ${took.toFixed(1)} ms`)
  }

  // ---- Guitar: shapes
  {
    assert.ok(shapeFits([{ string: 3, fret: 2 }, { string: 4, fret: 2 }, { string: 5, fret: 2 }], GUITAR), 'a mini barre')
    assert.ok(!shapeFits([{ string: 2, fret: 2 }, { string: 3, fret: 8 }], GUITAR), 'six frets apart at fret 2')
    assert.ok(shapeFits([{ string: 2, fret: 7 }, { string: 3, fret: 12 }], GUITAR), 'five frets apart from fret 7')
    assert.ok(shapeFits([{ string: 2, fret: 2 }, { string: 3, fret: 5 }], BASS), 'four frets apart on a bass')
    assert.ok(!shapeFits([{ string: 2, fret: 2 }, { string: 3, fret: 7 }], BASS), 'bass reach is four frets')
    assert.ok(!shapeFits([{ string: 2, fret: 3 }, { string: 2, fret: 5 }], GUITAR), 'one string cannot sound twice')
    assert.ok(!shapeFits([1, 2, 3, 4, 5].map((s, i) => ({ string: s, fret: i + 1 })), GUITAR), 'five different frets need five fingers')
  }

  const gnote = (midi, startBeat, beats, extra = {}) => ({ midi, startBeat, beats, ...extra })
  const distinctStrings = (notes, at) => {
    const sounding = notes.filter((n) => n.string && n.startBeat <= at + 1e-6 && n.startBeat + n.beats > at + 1e-6)
    return new Set(sounding.map((n) => n.string)).size === sounding.length
  }
  const fitsAt = (notes, at, config) => shapeFits(notes.filter((n) => n.string !== undefined && n.startBeat <= at + 1e-6 && n.startBeat + n.beats > at + 1e-6)
    .map((n) => ({ string: n.string, fret: n.fret })), config)

  // ---- Guitar: two notes on one string at once
  const collision = [gnote(52, 0, 4), gnote(50, 1, 1)]
  {
    const before = planFrettedTab(collision, GUITAR)
    assert.equal(before[0].position.string, before[1].position.string, 'the first placement puts both on one string')
    const { notes, summary } = repairFretted(collision, GUITAR)
    assert.equal(summary.flagged, 1)
    assert.ok(distinctStrings(notes, 1.5), 'the repair puts them on different strings')
    assert.equal(summary.unplayable, 0)
    assert.ok(summary.moved >= 1 && notes.some((n) => n.adjusted))
    const plan = planFrettedTab(notes, GUITAR)
    assert.deepEqual(plan.map((n) => n.position.midi), [52, 50], 'the tab shows the same pitches')
    assert.notEqual(plan[0].position.string, plan[1].position.string)
  }

  // ---- Guitar: a six-fret stretch at fret 2
  const stretch = [gnote(47, 0, 2, { string: 2, fret: 2 }), gnote(58, 0, 2, { string: 3, fret: 8 })]
  {
    const { notes, summary } = repairFretted(stretch, GUITAR)
    assert.equal(summary.flagged, 1)
    assert.equal(summary.unplayable, 0)
    assert.ok(fitsAt(notes, 0, GUITAR), 'the chord can now be held')
    assert.equal(notes[1].string, 4, 'the high note moves to another string, on the G string at fret 3')
    assert.equal(notes[1].fret, 3)
    assert.deepEqual([notes[0].string, notes[0].fret], [2, 2], 'the playable note keeps its written place')
  }

  // ---- Guitar: a let-ring arpeggio stays playable
  {
    const arpeggio = [48, 52, 55, 60, 64].map((m, i) => gnote(m, i * 0.5, 4 - i * 0.5))
    const result = repairFretted(arpeggio, GUITAR)
    assert.equal(result.notes, arpeggio, 'an open C arpeggio needs no change')
    assert.equal(result.summary.flagged, 0)
    const spread = [40, 47, 52, 56, 59, 64].map((m, i) => gnote(m, i * 0.25, 4 - i * 0.25))
    const fixed = repairFretted(spread, GUITAR)
    for (let at = 0; at < 4; at += 0.25) assert.ok(fitsAt(fixed.notes, at, GUITAR) && distinctStrings(fixed.notes, at), `moment ${at} is playable`)
    assert.equal(fixed.summary.unplayable, 0)
  }

  // ---- Guitar: seven notes on six strings
  {
    const seven = [40, 45, 50, 55, 59, 64, 69].map((m) => gnote(m, 0, 2))
    const { notes, summary } = repairFretted(seven, GUITAR)
    assert.equal(summary.unplayable, 1)
    assert.equal(summary.unplayableNotes, 1, 'the fewest notes are dropped')
    const marked = notes.filter((n) => n.notPlayable)
    assert.equal(marked.length, 1)
    assert.ok(marked[0].midi !== 40 && marked[0].midi !== 69, 'the bass and the melody are kept')
    assert.equal(marked[0].string, undefined)
    assert.ok(fitsAt(notes, 0, GUITAR))
    const plan = planFrettedTab(notes, GUITAR)
    assert.equal(plan.find((n) => n.reason === 'not-playable').midi, marked[0].midi, 'the tab still lists the dropped note, with a reason')
    assert.ok(playabilityNotice(summary).includes("1 moment can't be played as written; marked in the score and tab."))
    const outOfRange = repairFretted([gnote(30, 0, 1), gnote(52, 0, 1, { string: 3, fret: 2 }), gnote(50, 0.5, 1, { string: 3, fret: 0 })], GUITAR)
    assert.equal(outOfRange.notes[0].notPlayable, undefined, 'a note below the instrument keeps its own reason')
  }

  // ---- Bass
  {
    const wide = [gnote(33, 0, 2, { string: 2, fret: 0 }), gnote(40, 0, 2, { string: 3, fret: 2 })]
    assert.equal(repairFretted(wide, BASS).summary.flagged, 0)
    const reach = [gnote(35, 0, 2, { string: 2, fret: 2 }), gnote(46, 0, 2, { string: 3, fret: 8 })]
    const { notes, summary } = repairFretted(reach, BASS)
    assert.equal(summary.flagged, 1)
    assert.ok(fitsAt(notes, 0, BASS))
  }

  // ---- The song a practice view shows
  {
    const song = { ...buildSong() }
    const track = { id: 'gtr', instrument: 'other', name: 'Guitar', detail: '', gmProgram: 27 }
    song.tracks = [...song.tracks, track]
    song.instrumentNotes = { gtr: collision }
    const stored = JSON.stringify(song)
    const result = applyPlayability(song, { instrument: 'guitar', track })
    assert.equal(JSON.stringify(song), stored, 'the stored song is never changed')
    assert.notEqual(result.song, song)
    assert.ok(result.summary.moved >= 1)
    assert.equal(applyPlayability(song, { instrument: 'guitar', track }).song.instrumentNotes.gtr, result.song.instrumentNotes.gtr, 'cached')
    assert.deepEqual(song.instrumentNotes.gtr, collision)
    const none = applyPlayability(song, { instrument: null })
    assert.equal(none.song, song)

    // The score's MusicXML puts a reassigned piano note on the other staff.
    const seven = [piano(48, 'left'), ...[60, 62, 64, 65, 67, 69, 71].map((m) => piano(m, 'right'))].map((n) => ({ ...n, beats: 1 }))
    const handSong = { ...buildSong(), piano: seven, chords: [], chordLabels: undefined }
    const staffOf = (xml, step, octave) => new RegExp(`<pitch><step>${step}</step><octave>${octave}</octave></pitch>[^]*?<staff>(\\d)</staff>`).exec(xml)?.[1]
    const written = pianoXml(handSong, false)
    assert.equal(staffOf(written, 'C', 4), '1')
    assert.equal(staffOf(written, 'D', 4), '1')
    const fixed = applyPlayability(handSong, { instrument: 'piano' })
    assert.equal(fixed.song.piano.filter((n) => n.adjusted).length, 2)
    const repairedXml = pianoXml(fixed.song, false)
    assert.equal(staffOf(repairedXml, 'C', 4), '2', 'the moved C goes to the bass staff')
    assert.equal(staffOf(repairedXml, 'D', 4), '2', 'the moved D goes to the bass staff')
    assert.equal(staffOf(repairedXml, 'E', 4), '1', 'the others stay on the treble staff')
    assert.equal(staffOf(repairedXml, 'C', 3), '2')
    assert.equal(handSong.piano[1].hand, 'right', 'the stored notes keep their hands')

    // An unplayable moment is marked in the score.
    const cluster = { ...buildSong(), chords: [], piano: Array.from({ length: 11 }, (_, i) => piano(50 + i, i < 5 ? 'left' : 'right', 0, 1)) }
    const clusterXml = pianoXml(applyPlayability(cluster, { instrument: 'piano' }).song, false)
    assert.ok(clusterXml.includes('<notehead parentheses="yes">normal</notehead>') && clusterXml.includes('<lyric><text>!</text></lyric>'))
    assert.ok(!pianoXml(cluster, false).includes('parentheses'))

    // The exported tab uses the repaired positions.
    const written2 = frettedTabXml(song, track, GUITAR)
    const repaired = frettedTabXml(result.song, track, GUITAR)
    const strings = (xml) => [...xml.matchAll(/<string>(\d)<\/string><fret>(\d+)<\/fret>/g)].map((m) => [Number(m[1]), Number(m[2])])
    const before = strings(written2)
    const after = strings(repaired)
    assert.equal(before.length, 2)
    assert.equal(before[0][0], before[1][0], 'as transcribed, both notes are on one string')
    assert.notEqual(after[0][0], after[1][0], 'repaired, they are on different strings')
    const plan = planFrettedTab(result.song.instrumentNotes.gtr, GUITAR)
    assert.deepEqual(after, plan.map((n) => [n.position.conventionalStringNumber, n.position.fret]), 'the export matches the tab view')
    assert.ok(repaired.includes('<sign>TAB</sign>') && repaired.includes('<staff-lines>6</staff-lines>'))

    // Notes that cannot be played are marked in the tab export and the score.
    const sevenSong = { ...song, instrumentNotes: { gtr: [40, 45, 50, 55, 59, 64, 69].map((m) => gnote(m, 0, 2)) } }
    const sevenFixed = applyPlayability(sevenSong, { instrument: 'guitar', track }).song
    assert.ok(frettedTabXml(sevenFixed, track, GUITAR).includes('<lyric><text>!</text></lyric>'))
    assert.ok(instrumentXml(sevenFixed, track).includes('<lyric><text>!</text></lyric>'))
    assert.ok(!instrumentXml(sevenSong, track).includes('<text>!</text>'))
  }
  console.log('playability tests passed')
} finally {
  await vite.close()
}
