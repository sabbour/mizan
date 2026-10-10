import type { Feedback } from './kitRenderer'
import type { Target, Vec3 } from './kitAsset'
import type { Hand } from './sticking'

/**
 * The shared hit feedback for the 3D kit, from the playback clock alone: as a note on a piece approaches it glows,
 * at the note it pulses, and the part then reacts and fades. The same for every kit and look. Colours follow the
 * sticking when it is on and the hand is known (blue left, orange right, both shown side by side), and otherwise
 * each piece's own colour. Nothing is kept between frames, so pausing, seeking or opening new music clears it.
 */
export type Strike = { beat: number; velocity: number; specified: boolean; hand?: Hand | 'both' }
export type Clock = { beat: number; playing: boolean; countingIn: boolean; countBeat: number }
export type FeedbackOptions = {
  /** Seconds per quarter-note beat at the current tempo and speed. */
  secondsPerBeat: number
  /** Loop bounds in beats, when looping. */
  loop?: { start: number; end: number } | null
  /** Pulses in the count-in, so the first note can be anticipated while counting. */
  countLength: number
  /** Sticking letters on: known hands colour the feedback. */
  sticking: boolean
  /** Reduced motion: no swing or wobble, a steady mark instead of a fading pulse. */
  reduced: boolean
}

/** The same blue and orange as the L and R markers, brightened to read as light. */
export const HAND_GLOW: Record<Hand, Vec3> = { left: [0.16, 0.45, 0.95], right: [0.98, 0.47, 0.06] }
/** Each piece's own colour, when no hand applies (feet, unknown hands, sticking off). */
export const PIECE_GLOW: Record<Target, Vec3> = {
  kick: [0.55, 0.2, 1.0], snare: [0.05, 0.9, 1.0], tom1: [0.1, 0.4, 1.0], tom2: [0.3, 0.15, 0.85], floor: [1.0, 0.15, 0.75],
  hihat: [1.0, 0.88, 0.1], hatPedal: [1.0, 0.88, 0.1], crash: [1.0, 0.45, 0.05], ride: [0.15, 1.0, 0.35],
}
/** Beats of anticipation before a note. */
export const LOOKAHEAD = 1
/** Seconds the hit pulse takes to fade when the piece's next note is far enough away. */
export const PULSE_SECONDS = 0.45
/** Share of the gap to the piece's next note that a pulse may use; the rest stays dark, then anticipates. */
export const PULSE_SHARE = 0.45

const colours = (target: Target, hand: Strike['hand'], sticking: boolean): { tint: Vec3; tint2: Vec3; split: boolean } => {
  if (!sticking || !hand) return { tint: PIECE_GLOW[target], tint2: PIECE_GLOW[target], split: false }
  if (hand === 'both') return { tint: HAND_GLOW.left, tint2: HAND_GLOW.right, split: true }
  return { tint: HAND_GLOW[hand], tint2: HAND_GLOW[hand], split: false }
}

/** Index of the last strike at or before `beat` (-1 if none). */
function lastAt(list: Strike[], beat: number) {
  let lo = 0, hi = list.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].beat <= beat + 1e-9) lo = mid + 1; else hi = mid }
  return lo - 1
}

export function feedbackAt(strikes: Map<Target, Strike[]>, clock: Clock, options: FeedbackOptions): Map<Target, Feedback> {
  const out = new Map<Target, Feedback>()
  if (!clock.playing) return out
  const { secondsPerBeat, loop, countLength, sticking, reduced } = options
  for (const [target, list] of strikes) {
    if (!list.length) continue
    let upcoming = 0, upcomingTint: Vec3 = [0, 0, 0], pulse = 0, since = 99
    let hit: Strike | undefined
    if (clock.countingIn) {
      // While counting in, only notes right at the start are anticipated, rising with the count.
      const first = list[lastAt(list, clock.beat - 1e-6) + 1]
      if (first && first.beat - clock.beat < 1e-6 + 0.01) {
        upcoming = Math.min(1, clock.countBeat / Math.max(1, countLength)) * (0.5 + 0.5 * first.velocity)
        upcomingTint = colours(target, first.hand, sticking).tint
      }
    } else {
      const i = lastAt(list, clock.beat)
      hit = i >= 0 ? list[i] : undefined
      if (hit && loop && hit.beat < loop.start - 1e-9) hit = undefined
      let next: Strike | undefined = list[i + 1]
      let distance = next ? next.beat - clock.beat : Infinity
      if (loop && (!next || next.beat >= loop.end - 1e-9)) {
        // Across the loop's end, the next note is the first one inside the loop.
        const wrap = list[lastAt(list, loop.start - 1e-6) + 1]
        next = wrap && wrap.beat < loop.end ? wrap : undefined
        distance = next ? loop.end - clock.beat + (next.beat - loop.start) : Infinity
      }
      // Close notes on one piece stay distinct: the pulse fades within the first part of the gap to the piece's
      // next note, and that note's glow rises only after it, so each hit flashes and goes dark before the next.
      const gapBeats = hit && next ? clock.beat - hit.beat + distance : Infinity
      const fade = Math.max(0.03, Math.min(PULSE_SECONDS, gapBeats * secondsPerBeat * PULSE_SHARE))
      const ahead = Math.min(LOOKAHEAD, gapBeats - fade / secondsPerBeat)
      if (next && ahead > 0 && distance <= ahead) {
        upcoming = Math.pow(1 - distance / ahead, 1.6) * (0.45 + 0.55 * next.velocity)
        upcomingTint = colours(target, next.hand, sticking).tint
      }
      if (hit) {
        since = (clock.beat - hit.beat) * secondsPerBeat
        pulse = reduced ? (since < fade / 2 ? 0.8 : 0) : Math.max(0, 1 - since / fade) ** 1.5 * (0.45 + 0.55 * hit.velocity)
        if (reduced) since = 99
      }
    }
    if (upcoming < 0.01 && pulse < 0.01 && since > 1.5) continue
    const c = colours(target, hit?.hand, sticking)
    out.set(target, { upcoming, upcomingTint, pulse, tint: c.tint, tint2: c.tint2, split: c.split, since, velocity: hit?.velocity ?? 0 })
  }
  return out
}
