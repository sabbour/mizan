import { alternatives, type Alternative } from './harmonize'
import { chordAt, hasPitchedScore, invert, smoothInversions, sustainedChords, type Chord, type PianoNote, type Song, type Track } from './song'

/** A generated part to play along with the song harmonically. Not a transcription: nothing here is what the recording plays. */
export type CreativeTrack = Track & { chords: Chord[]; piano: PianoNote[] }

/** Keep the local groove in score beats; empty bars use the written meter. */
export function accompanimentRhythm(song: Song): number[] {
  const unit = song.beatUnit ?? 4
  const numerator = song.beatsPerBar * unit / 4
  const pulse = unit === 8 && numerator >= 6 && numerator % 3 === 0 ? 1.5 : 4 / unit
  const totalBeats = song.bars * song.beatsPerBar
  if (!Number.isSafeInteger(unit) || unit <= 0 || 2 ** Math.round(Math.log2(unit)) !== unit ||
      !Number.isSafeInteger(numerator) || numerator <= 0 ||
      !Number.isSafeInteger(song.bars) || song.bars <= 0 ||
      !Number.isFinite(totalBeats) || totalBeats + pulse <= totalBeats) {
    throw new RangeError('The song has invalid meter or length data.')
  }
  const percussion = new Map<number, number[]>()
  const backbeat = new Map<number, number[]>()
  const pitched = new Map<number, number[]>()
  const add = (map: Map<number, number[]>, beat: number) => {
    if (!Number.isFinite(beat) || beat < 0 || beat >= totalBeats) return
    const bar = Math.floor(beat / song.beatsPerBar)
    const beats = map.get(bar) ?? []
    beats.push(beat)
    map.set(bar, beats)
  }
  for (const hit of song.drums) {
    if (!(hit.velocity > 0)) continue
    add(percussion, hit.startBeat)
    if (hit.lane === 'kick' || hit.lane === 'snare') add(backbeat, hit.startBeat)
  }
  for (const note of [...song.piano, ...song.vocals, ...Object.values(song.instrumentNotes ?? {}).flat()]) {
    if (note.beats > 0 && (note.velocity ?? 1) > 0) add(pitched, note.startBeat)
  }
  const rhythm: number[] = []
  for (let bar = 0; bar < song.bars; bar++) {
    const local = backbeat.get(bar) ?? percussion.get(bar) ?? pitched.get(bar)
    if (local) rhythm.push(...local)
    else for (let index = 0; index < Math.ceil(song.beatsPerBar / pulse); index++) {
      rhythm.push(bar * song.beatsPerBar + index * pulse)
    }
  }
  return [...new Set(rhythm)].sort((a, b) => a - b)
}

export function chordRhythm(chord: Pick<Chord, 'startBeat' | 'beats'>, rhythm: readonly number[]): { startBeat: number; beats: number }[] {
  const end = chord.startBeat + chord.beats
  if (!(chord.beats > 0)) return []
  const attacks = [...new Set([chord.startBeat, ...rhythm.filter((beat) => beat > chord.startBeat && beat < end)])].sort((a, b) => a - b)
  return attacks.map((startBeat, i) => ({ startBeat, beats: (attacks[i + 1] ?? end) - startBeat }))
}

/**
 * A livelier progression to play along with: each chord in its colour (seventh, add9), long chords
 * turn to a substitute halfway, and most changes are approached by a passing chord (the dominant of
 * the next chord, or one borrowed from the minor key) on beat 3, or on beat 4 for variety.
 */
function movingChords(song: Song, rhythm: readonly number[]): CreativeTrack {
  const chords: Chord[] = []
  const take = (c: Chord, a: Alternative | undefined, startBeat: number, beats: number): Chord =>
    a ? { ...c, startBeat, beats, symbol: a.symbol, numeral: a.numeral, tones: a.tones, flats: a.flats } : { ...c, startBeat, beats }
  song.chords.forEach((c, i) => {
    let options: Alternative[] = []
    try {
      options = alternatives(song, i, 8)
    } catch {
      // Symbols the theory helpers do not know stay as detected.
    }
    const colour = options.find((x) => x.kind === 'color')
    const next = song.chords[i + 1]
    const approach = next?.symbol && next.symbol !== c.symbol && c.beats >= 2
      ? options.find((x) => (x.kind === 'secondary' || x.kind === 'borrowed') && x.symbol !== next.symbol)
      : undefined
    const substitute = c.beats >= 8 ? options.find((x) => x.kind === 'substitute') : undefined
    if (!c.tones.length || (!approach && !substitute)) {
      chords.push(colour ? take(c, colour, c.startBeat, c.beats) : c)
      return
    }
    const lead = approach ? (c.beats >= 4 && i % 3 !== 2 ? 2 : 1) : 0
    const end = c.startBeat + c.beats
    const half = substitute ? c.startBeat + Math.floor(c.beats / 2) : end - lead
    chords.push(take(c, colour, c.startBeat, half - c.startBeat))
    if (substitute) chords.push(take(c, substitute, half, end - lead - half))
    if (approach) chords.push(take(c, approach, end - lead, lead))
  })
  return {
    id: 'colour', instrument: 'piano', group: 'creative', chordal: true, name: 'Colour chords',
    detail: 'Richer chords, with passing chords leading into each change',
    chords, piano: sustainedPattern(sustainedChords(chords), rhythm),
  }
}

/** Follow the source attacks with connected voicings and a held bass. */
function sustainedPattern(chords: Chord[], rhythm: readonly number[]): PianoNote[] {
  const piano: PianoNote[] = []
  chords.forEach((chord) => {
    if (!chord.tones.length) return
    piano.push({ midi: chord.tones[0] - 24, startBeat: chord.startBeat, beats: chord.beats, hand: 'left', velocity: 0.66 })
    for (const { startBeat, beats } of chordRhythm(chord, rhythm)) {
      chord.tones.forEach((midi) => piano.push({ midi, startBeat, beats, hand: 'right', velocity: 0.62 }))
    }
  })
  return piano
}

export type HarmonyOptions = { source: 'melody' | 'chords'; above: boolean; interval: 3 | 6 | 10; sparse: boolean }
export const HARMONY_DEFAULT: HarmonyOptions = { source: 'melody', above: false, interval: 3, sparse: false }

const DISTANCE = { 3: 4, 6: 9, 10: 16 }
const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const SCALE = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] }

/**
 * Melody mode shadows the lead in the detected key, even when a chord is uncertain.
 * Chord mode follows only identified chord tones; neither mode relabels an unknown chord.
 */
function harmonyLine(song: Song, { source, above, interval, sparse }: HarmonyOptions, rhythm: readonly number[]): CreativeTrack {
  const top = new Map<number, PianoNote>()
  const pitched = Object.values(song.instrumentNotes ?? {}).flat()
  const lead = song.vocals.length ? song.vocals.map((n) => ({ ...n, hand: 'right' as const })) : song.piano.length
    ? song.piano.filter((n) => n.hand === 'right') : pitched.map((n) => ({ ...n, hand: 'right' as const }))
  for (const n of lead) if ((top.get(n.startBeat)?.midi ?? -1) < n.midi) top.set(n.startBeat, n)
  const melody = [...top.values()].sort((a, b) => a.startBeat - b.startBeat)
  const tonic = song.key && (NAMES.includes(song.key.tonic) ? NAMES.indexOf(song.key.tonic) : SHARPS.indexOf(song.key.tonic))
  const scale = tonic !== null && tonic >= 0 ? SCALE[song.key!.mode].map((pc) => (pc + tonic) % 12) : null
  const direction = above ? 1 : -1
  const target = (midi: number) => midi + direction * DISTANCE[interval]
  const nearest = (midi: number, pcs: number[], avoid?: number) => {
    const candidates = Array.from({ length: 84 }, (_, i) => i + 24)
      .filter((note) => pcs.includes(note % 12) && note !== avoid && Math.abs(note - midi) <= 4)
    return candidates.sort((a, b) => Math.abs(a - midi) - Math.abs(b - midi))[0]
  }
  const piano: PianoNote[] = []
  if (source === 'chords') {
    for (const chord of sustainedChords(song.chords)) {
      const lead = [...melody].reverse().find((m) => m.startBeat <= chord.startBeat)?.midi ?? 67
      const pcs = chord.tones.map((tone) => tone % 12)
      const pitch = nearest(target(lead), pcs, lead) ?? nearest(lead + direction * 7, pcs, lead)
      if (pitch === undefined) continue
      for (const { startBeat, beats } of chordRhythm(chord, rhythm)) {
        piano.push({ midi: pitch, startBeat, beats,
          hand: !above && interval === 10 ? 'left' : 'right', velocity: 0.8 })
      }
    }
  } else {
    for (let i = 0; i < melody.length; i++) {
      const m = melody[i]
      if (sparse && !(Math.abs(m.startBeat - Math.round(m.startBeat)) < 0.12 && m.beats >= 1)) continue
      const chord = song.chords[chordAt(song, m.startBeat)]
      const chordPcs = chord?.symbol && chord.symbol !== 'N.C.' ? chord.tones.map((tone) => tone % 12) : []
      const aimed = target(m.midi)
      const chordPitch = chordPcs.length ? nearest(aimed, chordPcs) : undefined
      const pitch = (chordPitch !== undefined && Math.abs(chordPitch - aimed) <= 1 ? chordPitch : undefined)
        ?? (scale ? nearest(aimed, scale) : aimed)
      if (pitch === m.midi) continue
      const beats = Math.min(m.beats, (melody[i + 1]?.startBeat ?? Infinity) - m.startBeat)
      if (beats > 0) piano.push({ ...m, midi: pitch, beats, hand: !above && interval === 10 ? 'left' : 'right', velocity: 0.8 })
    }
  }
  const name = { 3: '3rds', 6: '6ths', 10: '10ths' }[interval]
  return {
    id: 'harmony-line', instrument: 'piano', group: 'creative', name: 'Harmony line',
    detail: `A second voice in ${name} ${above ? 'above' : 'under'} the ${source}${sparse && source === 'melody' ? ', long notes only' : ''}`,
    chords: song.chords, piano,
  }
}

/** Follow the groove with nearby inversions over a held root. */
function smoothComping(song: Song, rhythm: readonly number[]): CreativeTrack {
  const chords = sustainedChords(song.chords)
  const inv = smoothInversions(chords)
  const piano: PianoNote[] = []
  chords.forEach((c, i) => {
    if (!c.tones.length) return
    const tones = invert(c.tones, inv[i])
    piano.push({ midi: c.tones[0] - 24, startBeat: c.startBeat, beats: c.beats, hand: 'left' })
    for (const { startBeat, beats } of chordRhythm(c, rhythm)) {
      for (const m of tones) piano.push({ midi: m, startBeat, beats, hand: 'right' })
    }
  })
  return {
    id: 'comping', instrument: 'piano', group: 'creative', chordal: true, name: 'Smooth comping',
    detail: 'Chords that barely move your hand, following the song rhythm',
    chords: song.chords, piano,
  }
}

export function creativeTracks(song: Song, harmony: HarmonyOptions = HARMONY_DEFAULT): CreativeTrack[] {
  if (!hasPitchedScore(song)) return []
  const namedChords = song.chords.some((chord) => chord.symbol && chord.symbol !== 'N.C.' && chord.tones.length)
  const rhythm = accompanimentRhythm(song)
  return [...(namedChords ? [movingChords(song, rhythm), smoothComping(song, rhythm)] : []), harmonyLine(song, harmony, rhythm)]
}
