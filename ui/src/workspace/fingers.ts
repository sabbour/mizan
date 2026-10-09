import type { PianoNote } from './song'

export type Finger = { hand: 'left' | 'right'; finger: number }

export const keyOf = (midi: number) => Math.ceil(midi - 0.5)

/**
 * Suggested fingers from note spacing alone: an estimate for practice, not detected fingering.
 * Each hand keeps a five-finger position; chords spread across it, single notes stay inside it,
 * and a note outside it moves the hand so that note lands on the thumb (or the fifth finger).
 */
export function suggestFingers(notes: readonly PianoNote[]): Map<PianoNote, Finger> {
  const result = new Map<PianoNote, Finger>()
  for (const hand of ['right', 'left'] as const) {
    const groups = new Map<number, PianoNote[]>()
    for (const note of notes) {
      if ((note.hand === 'left') !== (hand === 'left')) continue
      groups.set(note.startBeat, [...(groups.get(note.startBeat) ?? []), note])
    }
    // The thumb's key; a five-finger position covers about a sixth above (right) or below (left) it.
    let thumb: number | null = null
    const span = 8
    for (const start of [...groups.keys()].sort((a, b) => a - b)) {
      const group = groups.get(start)!.slice().sort((a, b) => a.midi - b.midi)
      const keys = group.map((note) => keyOf(note.midi))
      if (group.length > 1) {
        const width = keys[keys.length - 1] - keys[0]
        const spread = group.length === 2 ? [1, width <= 4 ? 3 : width <= 7 ? 4 : 5]
          : group.length === 3 ? [1, 3, 5] : group.length === 4 ? [1, 2, 3, 5] : [1, 2, 3, 4, 5]
        group.forEach((note, index) => {
          const finger = spread[Math.min(index, spread.length - 1)]
          // The left hand's thumb plays the top of a chord.
          result.set(note, { hand, finger: hand === 'right' ? finger : spread[Math.min(group.length - 1 - index, spread.length - 1)] })
        })
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
    }
  }
  return result
}
