import { lessonById } from './curriculum'
import { pianoLessonById } from './piano'
import { lessonKey, type KeyMode } from './pianoTonal'

/** Where the Course tab is: the instrument, each instrument's shelf, the genre shown and the key chosen. Held in memory only. */
export type CourseInstrument = 'drums' | 'piano'
export type DrumShelf = 'course' | 'inspired' | 'genre'
export type PianoShelf = 'genre' | 'inspired' | 'progression' | 'scale'
export type CourseBrowse = {
  instrument: CourseInstrument; shelf: DrumShelf; genre: string
  pianoShelf: PianoShelf; pianoGenre: string; pianoKey: { pitch: number; mode: KeyMode }; pianoScale: string
}

export const DEFAULT_BROWSE: CourseBrowse = {
  instrument: 'drums', shelf: 'course', genre: 'Rock', pianoShelf: 'genre', pianoGenre: 'Rock', pianoKey: { pitch: 0, mode: 'major' }, pianoScale: 'major',
}

/** The browse position that shows a lesson, so Back returns to the list (and key) it was opened from. */
export function browseTo(id: string, current: CourseBrowse): CourseBrowse {
  const piano = pianoLessonById(id)
  if (piano) {
    const key = lessonKey(piano)
    return { ...current, instrument: 'piano', pianoShelf: piano.kind, ...piano.kind === 'genre' ? { pianoGenre: piano.style } : {},
      ...key ? { pianoKey: { pitch: key.pitch, mode: key.mode } } : {}, ...key?.family ? { pianoScale: key.family } : {} }
  }
  const lesson = lessonById(id)
  if (!lesson) return current
  return { ...current, instrument: 'drums', shelf: lesson.collection ?? 'course', genre: lesson.collection === 'genre' ? lesson.style! : current.genre }
}
