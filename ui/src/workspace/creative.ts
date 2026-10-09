import { alternatives, type Alternative } from './harmonize'
import { barAt, measures, pulseBeats, songBeats } from './meter'
import { chordAt, hasPitchedScore, invert, smoothInversions, sustainedChords, type Chord, type PianoNote, type Song, type Track } from './song'

/** A generated part to play along with the song harmonically. Not a transcription: nothing here is what the recording plays. */
export type CreativeTrack = Track & { chords: Chord[]; piano: PianoNote[] }

/** Preserve sparse source accents; dense bars fall back to two meter-aware attacks. */
export function accompanimentRhythm(song: Song): number[] {
  const bars = measures(song)
  const totalBeats = songBeats(song)
  const percussion = new Map<number, number[]>()
  const backbeat = new Map<number, number[]>()
  const pitched = new Map<number, number[]>()
  const add = (map: Map<number, number[]>, beat: number) => {
    if (!Number.isFinite(beat) || beat < 0 || beat >= totalBeats) return
    const bar = barAt(song, beat)
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
  for (const [bar, measure] of bars.entries()) {
    const pulse = pulseBeats(measure)
    const compound = measure.denominator === 8 && measure.numerator >= 6 && measure.numerator % 3 === 0
    const second = compound
      ? Math.round((measure.beats / 2) / pulse) * pulse
      : measure.denominator === 4
        ? Math.min(2, measure.beats - pulse)
        : Math.min(measure.beats - pulse, Math.max(pulse, Math.round((measure.beats / 2) / pulse) * pulse))
    const anchors = [...new Set([0, second].filter((beat) => beat >= 0 && beat < measure.beats))]
    const local = backbeat.get(bar) ?? percussion.get(bar) ?? pitched.get(bar)
    const unique = local ? [...new Set(local)].sort((a, b) => a - b) : []
    if (unique.length > 0 && unique.length <= 2) rhythm.push(...unique)
    else if (!unique.length) rhythm.push(...anchors.map((beat) => measure.startBeat + beat))
    else {
      const barStart = measure.startBeat
      const selected = new Set<number>()
      for (const anchor of anchors) {
        const candidate = unique.filter((beat) => !selected.has(beat))
          .sort((a, b) => {
            const localA = a - barStart
            const localB = b - barStart
            return Math.abs(localA - anchor) - Math.abs(localB - anchor) ||
              Number(localA < anchor) - Number(localB < anchor) || a - b
          })[0]
        if (candidate !== undefined) selected.add(candidate)
      }
      rhythm.push(...selected)
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

function melodyNotes(song: Song): PianoNote[] {
  if (song.vocals.length) return song.vocals.map((note) => ({ ...note, hand: 'right' }))
  const right = song.piano.filter((note) => note.hand === 'right')
  if (right.length) return right
  return Object.values(song.instrumentNotes ?? {}).flat().map((note) => ({ ...note, hand: 'right' }))
}

function harmonicSlots(song: Song): number[] {
  return accompanimentRhythm({ ...song, piano: [], vocals: [], drums: [], instrumentNotes: undefined })
}

function melodyFit(notes: readonly PianoNote[], start: number, end: number, tones: readonly number[]): number {
  const pitchClasses = new Set(tones.map((tone) => ((tone % 12) + 12) % 12))
  return notes.reduce((score, note) => {
    const overlap = Math.min(note.startBeat + note.beats, end) - Math.max(note.startBeat, start)
    if (!(overlap > 0) || !Number.isFinite(note.midi)) return score
    const attacked = note.startBeat >= start && note.startBeat < end ? 0.05 : 0
    const velocity = Math.min(1.25, Math.max(0.5, (note.velocity ?? 0.7) / 0.7))
    const weight = (Math.min(1, overlap / Math.max(0.5, end - start)) + attacked) * velocity
    const pitch = ((Math.round(note.midi) % 12) + 12) % 12
    return score + (pitchClasses.has(pitch) ? weight : -weight)
  }, 0)
}

function sharedTones(left: readonly number[], right: readonly number[]): number {
  const pcs = new Set(left.map((tone) => ((tone % 12) + 12) % 12))
  return new Set(right.map((tone) => ((tone % 12) + 12) % 12).filter((tone) => pcs.has(tone))).size
}

/** Choose melody-supported variants at strong meter slots, keeping compatible chords steady. */
function movingChords(song: Song, rhythm: readonly number[], slots: readonly number[]): CreativeTrack {
  const notes = melodyNotes(song)
  const slotSet = new Set(slots)
  const changes = new Map<number, number>()
  let previous: Chord | undefined
  const chords = song.chords.map((source, index) => {
    if (source.symbol === 'N.C.') {
      previous = undefined
      return { ...source, tones: [...source.tones] }
    }
    if (!source.symbol || !source.tones.length) return { ...source, tones: [...source.tones] }
    const start = source.startBeat
    const end = start + source.beats
    const sourceCopy = { ...source, tones: [...source.tones] }
    let chosen: Chord = sourceCopy
    const hasMelody = notes.some((note) => note.startBeat < end && note.startBeat + note.beats > start)
    if (previous && hasMelody && sharedTones(previous.tones, source.tones) >= 2 &&
        melodyFit(notes, start, end, previous.tones) >= melodyFit(notes, start, end, source.tones) - 0.25) {
      chosen = { ...source, symbol: previous.symbol, numeral: previous.numeral,
        tones: [...previous.tones], flats: previous.flats }
    } else if (slotSet.has(start) && (changes.get(barAt(song, start)) ?? 0) < 2) {
      let options: Alternative[] = []
      try {
        options = alternatives(song, index, 8)
      } catch {
        previous = chosen
        return chosen
      }
      const sourceFit = melodyFit(notes, start, end, source.tones)
      const option = options
        .filter((candidate) => (candidate.kind === 'color' || candidate.kind === 'substitute') &&
          sharedTones(candidate.tones, source.tones) >= 2)
        .map((candidate, order) => ({ candidate, order, gain: melodyFit(notes, start, end, candidate.tones) - sourceFit }))
        .filter(({ gain }) => gain >= 0.65)
        .sort((a, b) => b.gain - a.gain || a.order - b.order)[0]?.candidate
      if (option) {
        chosen = { ...sourceCopy, symbol: option.symbol, numeral: option.numeral,
          tones: [...option.tones], flats: option.flats }
        const bar = barAt(song, start)
        changes.set(bar, (changes.get(bar) ?? 0) + 1)
      }
    }
    previous = chosen
    return chosen
  })
  const merged: Chord[] = []
  for (const chord of chords) {
    const prior = merged.at(-1)
    if (prior && chord.symbol && prior.symbol === chord.symbol &&
        prior.startBeat + prior.beats === chord.startBeat &&
        prior.tones.length === chord.tones.length &&
        prior.tones.every((tone, index) => tone === chord.tones[index])) prior.beats += chord.beats
    else merged.push(chord)
  }
  return {
    id: 'colour', instrument: 'piano', group: 'creative', chordal: true, name: 'Colour chords',
    detail: 'Melody-supported chord colours, played with phrase-shaped rhythm, a walking bass and resolving suspensions',
    chords: merged, piano: sustainedPattern(song, sustainedChords(merged), rhythm),
  }
}

/** How busy each bar of the recording is (source attacks), ranked 0..1 within the song; flat when nothing is transcribed. */
function barEnergy(song: Song): number[] {
  const counts = measures(song).map(() => 0)
  const add = (beat: number) => {
    if (Number.isFinite(beat) && beat >= 0 && beat < songBeats(song)) counts[barAt(song, beat)]++
  }
  for (const hit of song.drums) if (hit.velocity > 0) add(hit.startBeat)
  for (const note of [...song.piano, ...song.vocals, ...Object.values(song.instrumentNotes ?? {}).flat()]) add(note.startBeat)
  const sorted = [...counts].sort((a, b) => a - b)
  if (sorted[0] === sorted.at(-1)) return counts.map(() => 0.5)
  return counts.map((count) => {
    const below = sorted.findIndex((value) => value >= count)
    const through = sorted.length - 1 - [...sorted].reverse().findIndex((value) => value <= count)
    return (below + through) / 2 / (sorted.length - 1)
  })
}

/** Each bar's place in its phrase: sections, split into four-bar phrases when longer than eight bars. */
function phrasePositions(song: Song): { index: number; length: number }[] {
  const count = measures(song).length
  const out = Array.from({ length: count }, (_, bar) => ({ index: bar % 4, length: 4 }))
  for (const section of song.sections) {
    const start = section.startBar - 1
    const length = Math.min(section.bars, count - start)
    const size = length > 8 ? 4 : length
    for (let offset = 0; offset < length; offset++) {
      const phraseStart = Math.floor(offset / size) * size
      out[start + offset] = { index: offset - phraseStart, length: Math.min(size, length - phraseStart) }
    }
  }
  return out
}

const pc = (midi: number) => ((Math.round(midi) % 12) + 12) % 12

type Texture = 'broken' | 'comp' | 'drive' | 'hold'

/**
 * A play-along part that breathes with the song instead of repeating one block-chord pattern:
 * - texture follows how busy the recording is: arpeggiated in quiet bars, the source accents in
 *   moderate ones, added off-beat stabs and a moving bass in busy ones, and a held chord to release
 *   each phrase's cadence;
 * - the right hand keeps the nearest inversion (common tones held, other voices by step) and
 *   alternates a full and a lighter voicing;
 * - the bass alternates root and fifth and walks into the next chord by a step;
 * - velocities shape the meter (downbeat, strong pulses, off-beats) and arch over each phrase;
 * - with `suspensions`, a dominant resolving down a fifth starts as sus4 and resolves to its third.
 * Every right-hand pitch class comes from its chord except a labelled suspension's fourth.
 */
function accompany(song: Song, chords: Chord[], rhythm: readonly number[], suspensions = false): PianoNote[] {
  const bars = measures(song)
  const energy = barEnergy(song)
  const phrases = phrasePositions(song)
  const tonic = song.key ? (NAMES.includes(song.key.tonic) ? NAMES.indexOf(song.key.tonic) : SHARPS.indexOf(song.key.tonic)) : -1
  const scale = tonic >= 0 ? SCALE[song.key!.mode].map((step) => (step + tonic) % 12) : null
  const inversions = smoothInversions(chords)
  const piano: PianoNote[] = []
  const push = (midi: number, startBeat: number, beats: number, hand: 'left' | 'right', velocity: number) => {
    if (beats > 1e-6) piano.push({ midi, startBeat, beats, hand, velocity: Math.round(Math.min(0.85, Math.max(0.35, velocity)) * 100) / 100 })
  }
  chords.forEach((chord, index) => {
    if (!chord.tones.length) return
    const voiced = invert(chord.tones, inversions[index])
    const light = voiced.length > 3 ? voiced.filter((_, i) => i !== 1) : voiced.slice(1)
    const root = chord.tones[0] - 24
    const fifth = chord.tones.find((tone) => pc(tone - chord.tones[0]) === 7)
    const next = chords[index + 1]
    const end = chord.startBeat + chord.beats
    const resolvesDownAFifth = next && next.startBeat === end && next.tones.length &&
      pc(next.tones[0] - chord.tones[0]) === 5 && chord.tones.some((tone) => pc(tone - chord.tones[0]) === 4)
    const sus = !!(suspensions && resolvesDownAFifth)
    const suspendUntil = chord.startBeat + chord.beats / 2
    for (let bar = barAt(song, chord.startBeat); bar < bars.length && bars[bar].startBeat < end; bar++) {
      const measure = bars[bar]
      const start = Math.max(chord.startBeat, measure.startBeat)
      const stop = Math.min(end, measure.startBeat + measure.beats)
      if (stop - start <= 1e-6) continue
      const pulse = pulseBeats(measure)
      const { index: position, length } = phrases[bar]
      const cadence = position === length - 1 && stop >= end - 1e-6
      const level = energy[bar]
      const texture: Texture = cadence && level < 0.67 ? 'hold' : level < 0.34 ? 'broken' : level > 0.67 ? 'drive' : 'comp'
      const arch = 0.05 * Math.sin(Math.PI * (position + 0.5) / length) + (level - 0.5) * 0.12
      const accent = (beat: number) => {
        const local = beat - measure.startBeat
        if (local < 1e-6) return 0.7
        return Math.abs(local / pulse - Math.round(local / pulse)) < 1e-6 ? 0.6 : 0.5
      }
      // The suspension lives in the third: sounded as the fourth until the chord's midpoint, then resolved there even
      // when no new attack falls on it (a held or spanning note is split); the other voices keep sounding.
      const strike = (tone: number, at: number, beats: number, velocity: number) => {
        if (!sus || pc(tone - chord.tones[0]) !== 4 || at >= suspendUntil - 1e-6) return push(tone, at, beats, 'right', velocity)
        if (at + beats <= suspendUntil + 1e-6) return push(tone + 1, at, beats, 'right', velocity)
        push(tone + 1, at, suspendUntil - at, 'right', velocity)
        push(tone, suspendUntil, at + beats - suspendUntil, 'right', velocity - 0.06)
      }
      // Right hand.
      if (texture === 'hold') {
        for (const tone of voiced) strike(tone, start, stop - start, 0.56 + arch)
      } else if (texture === 'broken') {
        const step = pulse === 1.5 ? 0.5 : pulse
        // Alternate the arpeggio's contour from bar to bar within the phrase.
        const order = voiced.length >= 3 ? (position % 2 ? [0, 1, 2, 1] : [0, 2, 1, 2]) : [0, 1]
        for (let beat = start, k = 0; beat < stop - 1e-6; beat += step, k++) {
          strike(voiced[order[k % order.length] % voiced.length], beat, Math.min(step, stop - beat), accent(beat) - 0.08 + arch)
        }
      } else {
        const attacks = chordRhythm({ startBeat: start, beats: stop - start }, rhythm)
        const stabs = new Set(attacks.map((attack) => attack.startBeat))
        if (texture === 'drive') {
          // Off-beat stabs; every other bar keeps only the backbeat ones so the groove answers itself.
          for (let beat = measure.startBeat + pulse / 2, k = 0; beat < stop - 1e-6; beat += pulse, k++)
            if (beat > start && (position % 2 === 0 || k % 2 === 1)) stabs.add(beat)
        } else if (position % 2 === 1 && stop - start >= 2 * pulse - 1e-6) {
          // A syncopated push on the last off-beat leans into the next bar.
          stabs.add(stop - pulse / 2)
        }
        const sorted = [...stabs].sort((a, b) => a - b)
        attacks.splice(0, attacks.length, ...sorted.map((beat, i) => ({ startBeat: beat, beats: (sorted[i + 1] ?? stop) - beat })))
        attacks.forEach(({ startBeat, beats }, k) => {
          for (const tone of k % 2 === 0 ? voiced : light) strike(tone, startBeat, beats, accent(startBeat) + arch)
        })
      }
      // Left hand: root, the fifth on the second strong pulse, and a step into the next chord.
      const approach = next && next.startBeat === end && stop >= end - 1e-6 && next.tones.length &&
        pc(next.tones[0] - chord.tones[0]) !== 0 && stop - start >= 2 * pulse - 1e-6
      const nextRoot = approach ? next.tones[0] - 24 : 0
      const below = scale ? [1, 2].map((d) => nextRoot - d).find((m) => scale.includes(pc(m))) ?? nextRoot - 1 : nextRoot - 1
      const lead = approach ? stop - pulse : stop
      if (texture === 'drive') {
        for (let beat = start, k = 0; beat < lead - 1e-6; beat += pulse, k++)
          push(k % 2 && fifth !== undefined ? fifth - 24 : root, beat, Math.min(pulse, lead - beat), 'left', accent(beat) + arch)
      } else if (texture === 'comp' && fifth !== undefined && lead - start >= 2 * pulse - 1e-6) {
        const middle = start + Math.floor((lead - start) / pulse / 2) * pulse
        push(root, start, middle - start, 'left', accent(start) + arch)
        push(fifth - 24, middle, lead - middle, 'left', accent(middle) - 0.05 + arch)
      } else push(root, start, lead - start, 'left', accent(start) + arch)
      if (approach) push(below, lead, stop - lead, 'left', 0.55 + arch)
    }
  })
  return piano.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi)
}

/** Follow the source attacks with connected voicings and a held bass. */
function sustainedPattern(song: Song, chords: Chord[], rhythm: readonly number[]): PianoNote[] {
  return accompany(song, chords, rhythm, true)
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
function harmonyLine(song: Song, { source, above, interval, sparse }: HarmonyOptions, slots: readonly number[]): CreativeTrack {
  const top = new Map<number, PianoNote>()
  const lead = melodyNotes(song)
  for (const n of lead) if ((top.get(n.startBeat)?.midi ?? -1) < n.midi) top.set(n.startBeat, n)
  const melody = [...top.values()].sort((a, b) => a.startBeat - b.startBeat)
  const tonic = song.key && (NAMES.includes(song.key.tonic) ? NAMES.indexOf(song.key.tonic) : SHARPS.indexOf(song.key.tonic))
  const scale = tonic !== null && tonic >= 0 ? SCALE[song.key!.mode].map((pc) => (pc + tonic) % 12) : null
  const direction = above ? 1 : -1
  const target = (midi: number) => midi + direction * DISTANCE[interval]
  const nearest = (midi: number, pcs: number[], avoid?: number, previous?: number) => {
    const candidates = Array.from({ length: 84 }, (_, i) => i + 24)
      .filter((note) => pcs.includes(note % 12) && note !== avoid && Math.abs(note - midi) <= 4)
    return candidates.sort((a, b) =>
      Math.abs(a - midi) + (previous === undefined ? 0 : Math.abs(a - previous) * 0.35) -
      Math.abs(b - midi) - (previous === undefined ? 0 : Math.abs(b - previous) * 0.35))[0]
  }
  const piano: PianoNote[] = []
  if (source === 'chords') {
    let previousPitch: number | undefined
    for (const chord of sustainedChords(song.chords)) {
      const lead = [...melody].reverse().find((m) => m.startBeat <= chord.startBeat)?.midi ?? 67
      const pcs = chord.tones.map((tone) => tone % 12)
      const pitch = nearest(target(lead), pcs, lead, previousPitch) ??
        nearest(lead + direction * 7, pcs, lead, previousPitch)
      if (pitch === undefined) continue
      piano.push({ midi: pitch, startBeat: chord.startBeat, beats: chord.beats,
        hand: !above && interval === 10 ? 'left' : 'right', velocity: 0.8 })
      previousPitch = pitch
    }
  } else {
    const selected = new Map<number, PianoNote>()
    for (const beat of slots) {
      const measure = measures(song)[barAt(song, beat)]
      const barStart = measure.startBeat
      const barEnd = barStart + measure.beats
      const candidates = melody.filter((note) => note.startBeat >= barStart && note.startBeat < barEnd &&
        (!sparse || (Math.abs(note.startBeat - Math.round(note.startBeat)) < 0.12 && note.beats >= 1)))
      const candidate = candidates.sort((a, b) =>
        Math.abs(a.startBeat - beat) - Math.abs(b.startBeat - beat) || a.startBeat - b.startBeat)[0]
      if (candidate) selected.set(candidate.startBeat, candidate)
    }
    const chosen = [...selected.values()].sort((a, b) => a.startBeat - b.startBeat)
    const phrases = phrasePositions(song)
    let previousPitch: number | undefined
    for (const [i, m] of chosen.entries()) {
      const next = melody.find((note) => note.startBeat > m.startBeat)
      const chord = song.chords[chordAt(song, m.startBeat)]
      const chordPcs = chord?.symbol && chord.symbol !== 'N.C.' ? chord.tones.map((tone) => tone % 12) : []
      const bar = barAt(song, m.startBeat)
      const measure = measures(song)[bar]
      const pulse = pulseBeats(measure)
      const local = (m.startBeat - measure.startBeat) / pulse
      const strong = Math.abs(local - Math.round(local)) < 0.02
      const aimed = target(m.midi)
      // Strong beats lean on chord tones; weaker ones may pass through the scale. Both prefer small steps.
      const chordPitch = chordPcs.length ? nearest(aimed, chordPcs, m.midi, previousPitch) : undefined
      let pitch = (chordPitch !== undefined && Math.abs(chordPitch - aimed) <= (strong ? 2 : 1) ? chordPitch : undefined)
        ?? (scale ? nearest(aimed, scale, m.midi, previousPitch) : aimed) ?? aimed
      const following = chosen[i + 1]
      const ending = !following || following.startBeat - (m.startBeat + m.beats) >= 1 ||
        (phrases[bar].index === phrases[bar].length - 1 && barAt(song, following.startBeat) !== bar)
      // A phrase ends at rest on a chord tone.
      if (ending && chordPcs.length) pitch = nearest(pitch, chordPcs, m.midi, previousPitch) ?? pitch
      if (pitch === m.midi) continue
      const beats = Math.min(m.beats, (next?.startBeat ?? Infinity) - m.startBeat)
      if (!(beats > 0)) continue
      const last = piano.at(-1)
      // Oblique motion: where the melody repeats over the same harmony note, hold it instead of re-striking.
      if (last && last.midi === pitch && Math.abs(last.startBeat + last.beats - m.startBeat) < 1e-6) {
        last.beats += beats
        continue
      }
      piano.push({ ...m, midi: pitch, beats, hand: !above && interval === 10 ? 'left' : 'right',
        velocity: ending ? 0.7 : strong ? 0.78 : 0.64 })
      previousPitch = pitch
    }
  }
  const name = { 3: '3rds', 6: '6ths', 10: '10ths' }[interval]
  return {
    id: 'harmony-line', instrument: 'piano', group: 'creative', name: 'Harmony line',
    detail: `A second voice in ${name} ${above ? 'above' : 'under'} the ${source}${sparse && source === 'melody' ? ', long notes only' : ''}`,
    chords: song.chords, piano,
  }
}

/** The detected chords with nearby inversions, a texture that follows the song's energy and a walking bass. */
function smoothComping(song: Song, rhythm: readonly number[]): CreativeTrack {
  return {
    id: 'comping', instrument: 'piano', group: 'creative', chordal: true, name: 'Smooth comping',
    detail: 'The detected chords in nearby inversions: arpeggios when quiet, the song’s accents when moderate, off-beat drive when busy',
    chords: song.chords, piano: accompany(song, sustainedChords(song.chords), rhythm),
  }
}

export function creativeTracks(song: Song, harmony: HarmonyOptions = HARMONY_DEFAULT): CreativeTrack[] {
  if (!hasPitchedScore(song)) return []
  const namedChords = song.chords.some((chord) => chord.symbol && chord.symbol !== 'N.C.' && chord.tones.length)
  const rhythm = accompanimentRhythm(song)
  const slots = harmonicSlots(song)
  const colour = namedChords ? movingChords(song, rhythm, slots) : undefined
  const harmonySong = harmony.source === 'chords' && colour ? { ...song, chords: colour.chords } : song
  return [...(colour ? [colour, smoothComping(song, rhythm)] : []), harmonyLine(harmonySong, harmony, slots)]
}
