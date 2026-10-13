import type { Position } from '../library/bridge'
import { lessonMeter, type Lesson } from './curriculum'
import type { PianoLesson } from './piano'
import type { FrettedLesson } from './fretted'

/** A lesson that opens in the practice workspace. */
export type CourseLesson = Lesson | PianoLesson | FrettedLesson
const barCount = (lesson: CourseLesson) => typeof lesson.bars === 'number' ? lesson.bars : lesson.bars.length
/** The track a lesson opens on: the piano part for a piano lesson, otherwise the drums. */
export const lessonTrack = (lesson: CourseLesson) => {
  if ('instrument' in lesson) return lesson.instrument === 'piano' ? 'piano' : lesson.instrument
  return 'drums'
}

/** Course practice state lives under its own keys, apart from library songs and their saved positions. */
const key = (id: string) => `mizan:course:position:${id}`

/** Where a lesson starts: bar 1, looping the whole exercise, at its starting tempo. */
export function freshPosition(lesson: CourseLesson): Position {
  return {
    bar: 1, loop: { startBar: 1, endBar: barCount(lesson) }, loopName: null,
    rate: Math.round(lesson.tempo.start / lesson.tempo.target * 20) / 20, trackId: lessonTrack(lesson), muted: [], solo: [],
  }
}

/** The saved setup for a lesson, or a fresh start with a console warning when what is stored cannot be used. */
export function lessonPosition(lesson: CourseLesson): Position {
  const fresh = freshPosition(lesson)
  let value: unknown
  try {
    value = JSON.parse(localStorage.getItem(key(lesson.id)) ?? 'null')
  } catch (error) {
    console.warn('Could not restore the lesson practice position; starting the lesson fresh.', error)
    return fresh
  }
  if (value === null) return fresh
  const bars = barCount(lesson)
  const saved = (typeof value === 'object' ? value : {}) as Partial<Position>
  const loop = saved.loop
  // Bounds follow the workspace controls: bars of this lesson, and Speed from 25% to 100%.
  const valid = typeof value === 'object' && !Array.isArray(value) &&
    Number.isInteger(saved.bar) && saved.bar! >= 1 && saved.bar! <= bars &&
    (loop === null || (!!loop && Number.isInteger(loop.startBar) && Number.isInteger(loop.endBar) &&
      loop.startBar >= 1 && loop.startBar <= loop.endBar && loop.endBar <= bars)) &&
    typeof saved.rate === 'number' && saved.rate >= 0.25 && saved.rate <= 1 &&
    [saved.muted, saved.solo].every((list) => Array.isArray(list) && list.every((item) => typeof item === 'string'))
  if (!valid) {
    console.warn('Could not restore the lesson practice position; starting the lesson fresh.', new Error(`Invalid saved position for ${lesson.id}`))
    return fresh
  }
  return { bar: saved.bar!, loop: loop ?? null, loopName: null, rate: saved.rate!, trackId: lessonTrack(lesson), muted: saved.muted!, solo: saved.solo! }
}

export function saveLessonPosition(lesson: CourseLesson, position: Position): void {
  try {
    localStorage.setItem(key(lesson.id), JSON.stringify(position))
  } catch (error) {
    console.warn('Could not save lesson practice position.', error)
  }
}

/** Tempo in the lesson's counted pulse, with the note it counts. */
export function tempoLabel(lesson: Pick<Lesson, 'meter'>, bpm: number): string {
  const { compound, pulse } = lessonMeter(lesson)
  return `${Math.round(bpm)} ${compound ? '♩.' : pulse === 0.5 ? '♪' : '♩'}`
}
