import type { Position } from '../library/bridge'
import { lessonMeter, type Lesson } from './curriculum'

/** Course practice state lives under its own keys, apart from library songs and their saved positions. */
const key = (id: string) => `mizan:course:position:${id}`

/** Where a lesson starts: bar 1, looping the whole exercise, at its starting tempo. */
export function freshPosition(lesson: Lesson): Position {
  return {
    bar: 1, loop: { startBar: 1, endBar: lesson.bars.length }, loopName: null,
    rate: Math.round(lesson.tempo.start / lesson.tempo.target * 20) / 20, trackId: 'drums', muted: [], solo: [],
  }
}

export function lessonPosition(lesson: Lesson): Position {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(lesson.id)) ?? 'null')
    if (!value || typeof value !== 'object') return freshPosition(lesson)
    const saved = value as Partial<Position>
    const bars = lesson.bars.length
    const bar = Number.isInteger(saved.bar) && saved.bar! >= 1 && saved.bar! <= bars ? saved.bar! : 1
    const loop = saved.loop && Number.isInteger(saved.loop.startBar) && Number.isInteger(saved.loop.endBar) &&
      saved.loop.startBar >= 1 && saved.loop.startBar <= saved.loop.endBar && saved.loop.endBar <= bars ? saved.loop : null
    const rate = typeof saved.rate === 'number' && saved.rate >= 0.25 && saved.rate <= 1 ? saved.rate : freshPosition(lesson).rate
    const list = (items: unknown) => Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : []
    return { bar, loop, loopName: null, rate, trackId: 'drums', muted: list(saved.muted), solo: list(saved.solo) }
  } catch {
    return freshPosition(lesson)
  }
}

export function saveLessonPosition(lesson: Lesson, position: Position): void {
  try {
    localStorage.setItem(key(lesson.id), JSON.stringify(position))
  } catch (error) {
    console.warn('Could not save lesson practice position.', error)
  }
}

/** Tempo in the lesson's counted pulse, with the note it counts. */
export function tempoLabel(lesson: Lesson, bpm: number): string {
  return `${Math.round(bpm)} ${lessonMeter(lesson).compound ? '♩.' : '♩'}`
}
