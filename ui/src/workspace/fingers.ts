import type { PianoNote } from './song'

export type Finger = { hand: 'left' | 'right'; finger: number }

export const keyOf = (midi: number) => Math.ceil(midi - 0.5)
/** The widest chord (in semitones) given a suggestion: an octave between thumb and fifth finger. */
const REACH = 12

/**
 * Suggested fingers from note spacing alone: an estimate for practice, not detected fingering.
 * Each hand keeps a five-finger position; chords spread across it, single notes stay inside it,
 * and a note outside it moves the hand so that note lands on the thumb (or the fifth finger). Chords of more than five keys,
 * repeated keys or wider than an octave, and notes out of reach of held notes, get no suggestion; their keys still light.
 */
export function suggestFingers(notes: readonly PianoNote[]): Map<PianoNote, Finger> {
  const result = new Map<PianoNote, Finger>()
  for (const hand of ['right', 'left'] as const) {
    const groups = new Map<number, PianoNote[]>()
    for (const note of notes) {
      if (!note.hand || note.hand !== hand) continue
      groups.set(note.startBeat, [...(groups.get(note.startBeat) ?? []), note])
    }
    // The thumb's key; a five-finger position covers about a sixth above (right) or below (left) it.
    let thumb: number | null = null
    const span = 8
    const assigned: PianoNote[] = []
    const seen: PianoNote[] = []
    for (const start of [...groups.keys()].sort((a, b) => a - b)) {
      const group = groups.get(start)!.slice().sort((a, b) => a.midi - b.midi)
      const keys = group.map((note) => keyOf(note.midi))
      // While notes are still held the hand cannot move: new notes take free fingers within reach of
      // that position, and a note out of reach gets no suggestion rather than an impossible one. While a
      // note with no suggestion is held, the hand's position is unknown, so nothing new is guessed.
      const sounding = (note: PianoNote) => note.startBeat < start - 1e-6 && note.startBeat + note.beats > start + 1e-6
      const held = assigned.filter(sounding)
      const unknown = seen.some((note) => sounding(note) && !result.has(note))
      seen.push(...group)
      if (held.length || unknown) {
        if (thumb === null || unknown) continue
        const taken = new Set(held.map((note) => result.get(note)!.finger))
        for (const [index, note] of group.entries()) {
          const offset = hand === 'right' ? keys[index] - thumb : thumb - keys[index]
          if (offset < 0 || offset > span + 4) continue
          let finger = Math.min(5, 1 + Math.round(offset * 4 / span))
          while (taken.has(finger) && finger < 5) finger++
          if (taken.has(finger)) continue
          result.set(note, { hand, finger })
          taken.add(finger)
          assigned.push(note)
        }
        continue
      }
      if (group.length > 1) {
        const distinct = [...new Set(keys)]
        const width = keys[keys.length - 1] - keys[0]
        // More keys than fingers, a repeated key, or wider than an octave: no confident suggestion; the
        // keys still light, and the next note starts a fresh hand position.
        if (distinct.length !== group.length || group.length > 5 || width > REACH) {
          thumb = null
          continue
        }
        const spread = group.length === 2 ? [1, width <= 4 ? 3 : width <= 7 ? 4 : 5]
          : group.length === 3 ? [1, 3, 5] : group.length === 4 ? [1, 2, 3, 5] : [1, 2, 3, 4, 5]
        group.forEach((note, index) => {
          // The left hand's thumb plays the top of a chord.
          result.set(note, { hand, finger: spread[hand === 'right' ? index : group.length - 1 - index] })
        })
        assigned.push(...group)
        thumb = hand === 'right' ? keys[0] : keys[keys.length - 1]
        continue
      }
      const key = keys[0]
      const distance = thumb === null ? null : hand === 'right' ? key - thumb : thumb - key
      if (distance === null || distance < 0 || distance > span) {
        // Move the hand: rising passages put the thumb on the new note, falling ones the fifth finger.
        const rising: boolean = thumb === null || (hand === 'right' ? key > thumb : key < thumb)
        thumb = rising ? key : hand === 'right' ? key - span : key + span
      }
      const offset = hand === 'right' ? key - thumb! : thumb! - key
      result.set(group[0], { hand, finger: Math.min(5, 1 + Math.round(offset * 4 / span)) })
      assigned.push(group[0])
    }
  }
  return result
}
