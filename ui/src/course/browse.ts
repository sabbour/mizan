import { lessonById } from './curriculum'
import { pianoLessonById } from './piano'
import { frettedLessonById } from './fretted'
import { lessonKey, type KeyMode } from './pianoTonal'
import { artistOf } from './inspired'

/** Where the Course tab is: the instrument, each instrument's shelf, the genre shown and the key chosen. Held in memory only. */
export type CourseInstrument = 'drums' | 'piano' | 'guitar' | 'bass'
export type DrumShelf = 'course' | 'inspired' | 'genre'
export type PianoShelf = 'genre' | 'inspired' | 'progression' | 'scale'
export type FrettedShelf = 'course' | 'genre' | 'inspired' | 'scale'
export type CourseBrowse = {
  instrument: CourseInstrument; shelf: DrumShelf; genre: string; drumArtist: string
  pianoShelf: PianoShelf; pianoGenre: string; pianoKey: { pitch: number; mode: KeyMode }; pianoScale: string; pianoArtist: string
  guitarShelf: FrettedShelf; guitarGenre: string; guitarArtist: string; guitarKey: { pitch: number }; guitarScale: string
  bassShelf: FrettedShelf; bassGenre: string; bassArtist: string; bassKey: { pitch: number }; bassScale: string
}

export const DEFAULT_BROWSE: CourseBrowse = {
  instrument: 'drums', shelf: 'course', genre: 'Rock', drumArtist: '', pianoArtist: '', pianoShelf: 'genre', pianoGenre: 'Rock', pianoKey: { pitch: 0, mode: 'major' }, pianoScale: 'major',
  guitarShelf: 'course', guitarGenre: 'Rock', guitarArtist: '', guitarKey: { pitch: 0 }, guitarScale: 'major',
  bassShelf: 'course', bassGenre: 'Rock', bassArtist: '', bassKey: { pitch: 0 }, bassScale: 'major',
}

/** The browse position that shows a lesson, so Back returns to the list (and key) it was opened from. */
export function browseTo(id: string, current: CourseBrowse): CourseBrowse {
  const fretted = frettedLessonById(id)
  if (fretted) return {
    ...current,
    instrument: fretted.instrument,
    ...(fretted.instrument === 'guitar'
      ? {
        guitarShelf: fretted.kind,
        ...(fretted.genre ? { guitarGenre: fretted.genre } : {}),
        ...(fretted.artist ? { guitarArtist: fretted.artist } : {}),
        ...(fretted.family && fretted.tonic !== undefined ? { guitarKey: { pitch: fretted.tonic }, guitarScale: fretted.family } : {}),
      }
      : {
        bassShelf: fretted.kind,
        ...(fretted.genre ? { bassGenre: fretted.genre } : {}),
        ...(fretted.artist ? { bassArtist: fretted.artist } : {}),
        ...(fretted.family && fretted.tonic !== undefined ? { bassKey: { pitch: fretted.tonic }, bassScale: fretted.family } : {}),
      }),
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
