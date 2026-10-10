import { lessonById } from './curriculum'
import { pianoLessonById } from './piano'

/** Where the Course tab is: the instrument, the drum shelf and the genre shown for each instrument. Held in memory only. */
export type CourseInstrument = 'drums' | 'piano'
export type DrumShelf = 'course' | 'inspired' | 'genre'
export type CourseBrowse = { instrument: CourseInstrument; shelf: DrumShelf; genre: string; pianoGenre: string }

export const DEFAULT_BROWSE: CourseBrowse = { instrument: 'drums', shelf: 'course', genre: 'Rock', pianoGenre: 'Rock' }

/** The browse position that shows a lesson, so Back returns to the list it was opened from. */
export function browseTo(id: string, current: CourseBrowse): CourseBrowse {
  const piano = pianoLessonById(id)
  if (piano) return { ...current, instrument: 'piano', pianoGenre: piano.style }
  const lesson = lessonById(id)
  if (!lesson) return current
  return { ...current, instrument: 'drums', shelf: lesson.collection ?? 'course', genre: lesson.collection === 'genre' ? lesson.style! : current.genre }
}
