import { lessonById } from './curriculum'
import { pianoLessonById } from './piano'
import { frettedLessonById } from './fretted'
import { lessonKey, type KeyMode } from './pianoTonal'
import { artistOf } from './inspired'

/** Where the Course tab is: the instrument, each instrument's shelf, the genre shown and the key chosen. Held in memory only. */
export type CourseInstrument = 'drums' | 'piano' | 'guitar' | 'bass'
export type DrumShelf = 'course' | 'inspired' | 'genre'
export type PianoShelf = 'genre' | 'inspired' | 'progression' | 'scale'
export type FrettedShelf = 'course' | 'genre'
export type CourseBrowse = {
  instrument: CourseInstrument; shelf: DrumShelf; genre: string; drumArtist: string
  pianoShelf: PianoShelf; pianoGenre: string; pianoKey: { pitch: number; mode: KeyMode }; pianoScale: string; pianoArtist: string
  guitarShelf: FrettedShelf; guitarGenre: string; bassShelf: FrettedShelf; bassGenre: string
}

export const DEFAULT_BROWSE: CourseBrowse = {
  instrument: 'drums', shelf: 'course', genre: 'Rock', drumArtist: '', pianoArtist: '', pianoShelf: 'genre', pianoGenre: 'Rock', pianoKey: { pitch: 0, mode: 'major' }, pianoScale: 'major',
  guitarShelf: 'course', guitarGenre: 'Rock', bassShelf: 'course', bassGenre: 'Rock',
}

/** The browse position that shows a lesson, so Back returns to the list (and key) it was opened from. */
export function browseTo(id: string, current: CourseBrowse): CourseBrowse {
  const fretted = frettedLessonById(id)
  if (fretted) return {
    ...current,
    instrument: fretted.instrument,
    ...(fretted.instrument === 'guitar'
      ? { guitarShelf: fretted.kind === 'genre' ? 'genre' as const : 'course' as const, ...(fretted.genre ? { guitarGenre: fretted.genre } : {}) }
      : { bassShelf: fretted.kind === 'genre' ? 'genre' as const : 'course' as const, ...(fretted.genre ? { bassGenre: fretted.genre } : {}) }),
  }
  const piano = pianoLessonById(id)
  if (piano) {
    const key = lessonKey(piano)
    return { ...current, instrument: 'piano', pianoShelf: piano.kind, ...piano.kind === 'genre' ? { pianoGenre: piano.style } : {},
      ...piano.kind === 'inspired' ? { pianoArtist: artistOf(piano) } : {},
      ...key ? { pianoKey: { pitch: key.pitch, mode: key.mode } } : {}, ...key?.family ? { pianoScale: key.family } : {} }
  }
  const lesson = lessonById(id)
  if (!lesson) return current
  return { ...current, instrument: 'drums', shelf: lesson.collection ?? 'course', genre: lesson.collection === 'genre' ? lesson.style! : current.genre,
    drumArtist: lesson.collection === 'inspired' ? artistOf(lesson) : current.drumArtist }
}
