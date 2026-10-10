import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { CourseBrowse } from './browse'
import { COLLECTIONS, genres, LESSONS, LEVELS, lessonBacking, lessonList, lessonStage, type Lesson, type LessonBar } from './curriculum'
import { PIANO_LESSONS, PIANO_STAGES, pianoGenres, pianoLessonSong, type PianoLesson } from './piano'
import { tempoLabel } from './state'

/** Consecutive identical bars share one count and sticking line. */
function barGroups(lesson: Lesson): { from: number; to: number; bar: LessonBar }[] {
  const groups: { from: number; to: number; bar: LessonBar }[] = []
  lesson.bars.forEach((bar, index) => {
    const last = groups.at(-1)
    if (last && JSON.stringify(last.bar) === JSON.stringify(bar)) last.to = index + 1
    else groups.push({ from: index + 1, to: index + 1, bar })
  })
  return groups
}

/** A sticking line with each hand marked by its letter and its colour: blue L for the left, orange R for the right. */
function Sticking({ line }: { line: string }) {
  return (
    <span className="lesson-sticking">
      {line.split(' ').map((token, index) => (
        <span key={index} className="lesson-stroke">
          {token.split('+').map((hand, part) => (
            <span key={part}>{part > 0 && '+'}<b className={hand === 'L' ? 'hand-left' : 'hand-right'}>{hand}</b></span>
          ))}
        </span>
      ))}
    </span>
  )
}

/** Instructions beside a lesson's score, with the lessons before and after it in the same list. */
export function LessonPanel({ lesson, onLesson }: { lesson: Lesson; onLesson: (id: string) => void }) {
  const list = lessonList(lesson)
  const index = list.indexOf(lesson)
  const previous = list[index - 1]
  const next = list[index + 1]
  const meter = `${lesson.meter.numerator}/${lesson.meter.denominator}`
  const stage = lessonStage(lesson)
  const backing = lessonBacking(lesson)
  return (
    <aside className="lesson-panel" aria-label={`Lesson ${index + 1} instructions`}>
      <div className="lesson-main">
        <p className="lesson-goal">{lesson.goal}</p>
        <dl className="lesson-facts">
          {lesson.style && <div><dt>Style</dt><dd>{lesson.style}</dd></div>}
          {lesson.feel && <div><dt>Feel</dt><dd>{lesson.feel}</dd></div>}
          {stage && <div><dt>Step</dt><dd>{stage.name}, <span className="num">{stage.index + 1} of {stage.of}</span> in {lesson.style}</dd></div>}
          <div><dt>{lesson.collection ? 'Difficulty' : 'Level'}</dt><dd>{lesson.collection ? 'after ' : ''}Level {lesson.level}, {LEVELS[lesson.level - 1]}</dd></div>
          <div><dt>Meter</dt><dd className="num">{meter}</dd></div>
          <div><dt>Tempo</dt><dd className="num">start {tempoLabel(lesson, lesson.tempo.start)} → aim for {tempoLabel(lesson, lesson.tempo.target)}</dd></div>
          {lesson.limbs && <div><dt>Limbs</dt><dd>{lesson.limbs}</dd></div>}
          {backing && <div><dt>Backing</dt><dd>{backing.tracks.map((track) => track.name).join(' and ')}, playing <span className="num">{backing.chords.join(' – ')}</span>.
            Original parts made for this lesson; mute or turn them down in the track list.</dd></div>}
        </dl>
        <table className="lesson-counts">
          <tbody>
            {barGroups(lesson).map(({ from, to, bar }) => (
              <tr key={from}>
                <th scope="row" className="num">{from === to ? `Bar ${from}` : `Bars ${from}–${to}`}</th>
                <td><span className="lesson-label">Count</span> {bar.count}</td>
                {bar.sticking && <td><span className="lesson-label">Hands</span> <Sticking line={bar.sticking} /></td>}
              </tr>
            ))}
          </tbody>
        </table>
        <details className="lesson-steps">
          <summary>How to practise</summary>
          <ol>{lesson.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          <p className="lesson-note">Speed starts at the lesson&apos;s starting tempo until you choose your own speed, which Mizan then remembers;
            raise it with ] as it gets comfortable. The pattern loops and the 3D kit shows each stroke. Hands are the lesson&apos;s sticking,
            from the player&apos;s side: <b className="hand-left">L</b> left hand in blue, <b className="hand-right">R</b> right hand in orange; feet have no letter.
            {lesson.collection === 'inspired' && ' This is an original exercise in the drummer\'s style, not a transcription of a recording.'}</p>
        </details>
      </div>
      <nav className="lesson-nav" aria-label="Other lessons">
        <button className="btn" disabled={!previous} onClick={() => previous && onLesson(previous.id)}
          aria-label={previous ? `Previous lesson: ${previous.title}` : 'No previous lesson'}>
          <ChevronLeft size={16} aria-hidden /> Previous
        </button>
        <button className="btn" disabled={!next} onClick={() => next && onLesson(next.id)}
          aria-label={next ? `Next lesson: ${next.title}` : 'No next lesson'}>
          Next <ChevronRight size={16} aria-hidden />
        </button>
      </nav>
    </aside>
  )
}

const meta = (lesson: Pick<Lesson, 'meter' | 'tempo'>) =>
  `${lesson.meter.numerator}/${lesson.meter.denominator} · ${lesson.tempo.start}–${tempoLabel(lesson, lesson.tempo.target)}`

function LessonButton({ lesson, onLesson }: { lesson: Lesson; onLesson: (id: string) => void }) {
  const stage = lessonStage(lesson)
  const detail = stage ? `${stage.name} · ${lesson.feel}` : lesson.collection === 'inspired' ? `${lesson.style} · ${lesson.feel}` : undefined
  return (
    <li>
      <button className={`course-lesson${detail ? ' course-lesson-two' : ''}`} onClick={() => onLesson(lesson.id)}>
        <span className="course-number num">{stage ? stage.index + 1 : lessonList(lesson).indexOf(lesson) + 1}</span>
        <span className="course-title">{lesson.title}{detail && <span className="course-style">{detail}</span>}</span>
        <span className="course-meta num">{meta(lesson)}{lesson.collection && <span className="course-level-tag">Level {lesson.level}</span>}</span>
      </button>
    </li>
  )
}

function PianoLessonButton({ lesson, onLesson }: { lesson: PianoLesson; onLesson: (id: string) => void }) {
  return (
    <li>
      <button className="course-lesson course-lesson-two" onClick={() => onLesson(lesson.id)}>
        <span className="course-number num">{lesson.level}</span>
        <span className="course-title">{lesson.title}<span className="course-style">{PIANO_STAGES[lesson.level - 1]} · {lesson.feel}</span></span>
        <span className="course-meta num">{meta(lesson)}{lesson.pedals && <span className="course-level-tag">Pedal</span>}</span>
      </button>
    </li>
  )
}

/** A row of choices with one selected, in the app's segmented style: arrows, Home and End move and choose. */
function Segments<T extends string>({ label, value, options, onChange, name }: {
  label: string; value: T; options: { id: T; label: string; count?: number }[]; onChange: (value: T) => void; name: string
}) {
  return (
    <div className={`chordview course-segments course-${name}`} role="radiogroup" aria-label={label}>
      <span className="chordview-label" aria-hidden="true">{label}</span>
      {options.map((option, index) => (
        <button key={option.id} type="button" role="radio" aria-checked={value === option.id} tabIndex={value === option.id ? 0 : -1}
          className="chordview-option" data-choice={option.id} {...{ [`data-${name}`]: option.id }} onClick={() => onChange(option.id)}
          onKeyDown={(event) => {
            const step = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0
            const target = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : step ? (index + step + options.length) % options.length : -1
            if (target < 0) return
            event.preventDefault()
            event.stopPropagation()
            onChange(options[target].id)
            ;(event.currentTarget.parentElement?.querySelector(`[data-choice="${options[target].id}"]`) as HTMLElement | null)?.focus()
          }}>
          {option.label}{option.count !== undefined && <span className="dim num"> {option.count}</span>}
        </button>
      ))}
    </div>
  )
}

/** Genres as a list beside the chosen genre's five lessons, so one style is read at a time. */
function GenreShelf({ id, styles, value, onChange, children }: {
  id: string; styles: { style: string; note: string }[]; value: string; onChange: (style: string) => void; children: ReactNode
}) {
  return (
    <div className="course-genre-shelf">
      <div className="course-genre-list" role="radiogroup" aria-label="Genre" id={`${id}-genres`}>
        {styles.map(({ style, note }, index) => (
          <button key={style} type="button" role="radio" aria-checked={value === style} tabIndex={value === style ? 0 : -1}
            className="course-genre-option" data-genre={style} onClick={() => onChange(style)}
            onKeyDown={(event) => {
              const step = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 0
              const target = event.key === 'Home' ? 0 : event.key === 'End' ? styles.length - 1 : step ? (index + step + styles.length) % styles.length : -1
              if (target < 0) return
              event.preventDefault()
              event.stopPropagation()
              onChange(styles[target].style)
              ;(event.currentTarget.parentElement?.querySelector(`[data-genre="${CSS.escape(styles[target].style)}"]`) as HTMLElement | null)?.focus()
            }}>
            <span className="course-genre-name">{style}</span>
            <span className="course-genre-note num">{note}</span>
          </button>
        ))}
      </div>
      <div className="course-genre course-genre-detail" aria-live="polite">{children}</div>
    </div>
  )
}

/** The built-in course in the library: drums (the levelled course, the inspired lessons or the genres) or piano by genre. */
export function CourseSection({ onLesson, browse, onBrowse }: {
  onLesson: (id: string) => void; browse: CourseBrowse; onBrowse: (value: CourseBrowse) => void
}) {
  const course = lessonList({})
  const inspired = lessonList({ collection: 'inspired' })
  const drumGenres = genres()
  const pianoGenreList = pianoGenres()
  const set = (change: Partial<CourseBrowse>) => onBrowse({ ...browse, ...change })
  const drumGenre = drumGenres.find(({ style }) => style === browse.genre) ?? drumGenres[0]
  const pianoGenre = pianoGenreList.find(({ style }) => style === browse.pianoGenre) ?? pianoGenreList[0]
  const backing = lessonBacking(drumGenre.lessons[0])!
  const pianoBass = pianoLessonSong(pianoGenre.lessons[0]).tracks.find((track) => track.id === 'bass')!
  return (
    <div className="course-browse">
      <div className="course-switches">
        <Segments name="instrument" label="Instrument" value={browse.instrument} onChange={(instrument) => set({ instrument })}
          options={[{ id: 'drums', label: 'Drums', count: LESSONS.length }, { id: 'piano', label: 'Piano', count: PIANO_LESSONS.length }]} />
        {browse.instrument === 'drums' && (
          <Segments name="shelf" label="Lessons" value={browse.shelf} onChange={(shelf) => set({ shelf })}
            options={[{ id: 'course', label: 'Course', count: course.length }, { id: 'inspired', label: 'Inspired', count: inspired.length },
              { id: 'genre', label: 'Genres', count: lessonList({ collection: 'genre' }).length }]} />
        )}
      </div>
      {browse.instrument === 'piano' ? (
        <section className="course" aria-labelledby="course-piano">
          <h2 id="course-piano" className="lib-h2">Piano by genre <span className="dim num">{PIANO_LESSONS.length}</span></h2>
          <p className="course-intro">
            Five lessons per style: two right-hand rhythms over a simple left hand, a left-hand pattern, a fill and a four-bar phrase.
            Every note has its written finger. Each lesson opens on the piano score and a 3D keyboard, with an original drum and bass backing.
          </p>
          <GenreShelf id="course-piano" value={pianoGenre.style} onChange={(pianoGenre) => set({ pianoGenre })}
            styles={pianoGenreList.map(({ style, lessons }) => ({ style, note: `${lessons[0].meter.numerator}/${lessons[0].meter.denominator}` }))}>
            <h3>{pianoGenre.style}</h3>
            <p className="course-genre-facts">
              <span className="num">{pianoGenre.lessons.length} lessons · {pianoGenre.lessons[0].meter.numerator}/{pianoGenre.lessons[0].meter.denominator} ·
                aim for {tempoLabel(pianoGenre.lessons[0], pianoGenre.lessons[0].tempo.target)}</span>
              <span>Backing: drum kit and {pianoBass.name.toLowerCase()}{pianoGenre.lessons.some((lesson) => lesson.pedals) ? ' · sustain pedal written' : ''}</span>
            </p>
            <ol className="course-steps">{pianoGenre.lessons.map((lesson) => <PianoLessonButton key={lesson.id} lesson={lesson} onLesson={onLesson} />)}</ol>
          </GenreShelf>
        </section>
      ) : browse.shelf === 'inspired' ? (
        <section className="course" aria-labelledby="course-inspired">
          <h2 id="course-inspired" className="lib-h2">{COLLECTIONS.inspired.title} <span className="dim num">{inspired.length}</span></h2>
          <p className="course-intro">{COLLECTIONS.inspired.intro}</p>
          <ol className="course-levels course-collection">
            {inspired.map((lesson) => <LessonButton key={lesson.id} lesson={lesson} onLesson={onLesson} />)}
          </ol>
        </section>
      ) : browse.shelf === 'genre' ? (
        <section className="course" aria-labelledby="course-genre">
          <h2 id="course-genre" className="lib-h2">{COLLECTIONS.genre.title} <span className="dim num">{lessonList({ collection: 'genre' }).length}</span></h2>
          <p className="course-intro">{COLLECTIONS.genre.intro}</p>
          <GenreShelf id="course-genre" value={drumGenre.style} onChange={(genre) => set({ genre })}
            styles={drumGenres.map(({ style, lessons }) => ({ style, note: `Level ${lessons[0].level}–${lessons.at(-1)!.level}` }))}>
            <h3>{drumGenre.style}</h3>
            <p className="course-genre-facts">
              <span className="num">{drumGenre.lessons.length} lessons · {drumGenre.lessons[0].meter.numerator}/{drumGenre.lessons[0].meter.denominator} ·
                Level {drumGenre.lessons[0].level}–{drumGenre.lessons.at(-1)!.level}</span>
              <span>Backing: {backing.tracks.map((track) => track.name.toLowerCase()).join(' and ')}</span>
            </p>
            <ol className="course-steps">{drumGenre.lessons.map((lesson) => <LessonButton key={lesson.id} lesson={lesson} onLesson={onLesson} />)}</ol>
          </GenreShelf>
        </section>
      ) : (
        <section className="course" aria-labelledby="course-title">
          <h2 id="course-title" className="lib-h2">Drum course <span className="dim num">{course.length}</span></h2>
          <p className="course-intro">
            Built-in practice from a steady pulse to limb independence, fills, odd meters and advanced grooves. Each lesson opens with its score,
            the 3D kit, the click and a loop at its starting tempo. Lessons are separate from your songs.
          </p>
          <ol className="course-levels">
            {LEVELS.map((name, level) => {
              const lessons = course.filter((lesson) => lesson.level === level + 1)
              return (
                <li key={name} className="course-level">
                  <h3>Level {level + 1} · {name} <span className="dim num">{lessons.length}</span></h3>
                  <ol>{lessons.map((lesson) => <LessonButton key={lesson.id} lesson={lesson} onLesson={onLesson} />)}</ol>
                </li>
              )
            })}
          </ol>
        </section>
      )}
    </div>
  )
}
/** Instructions beside a piano lesson's score, with the lessons before and after it. */
export function PianoLessonPanel({ lesson, onLesson }: { lesson: PianoLesson; onLesson: (id: string) => void }) {
  const index = PIANO_LESSONS.indexOf(lesson)
  const previous = PIANO_LESSONS[index - 1]
  const next = PIANO_LESSONS[index + 1]
  const song = pianoLessonSong(lesson)
  const bass = song.tracks.find((track) => track.id === 'bass')!
  return (
    <aside className="lesson-panel" aria-label={`Piano lesson ${lesson.level} instructions`}>
      <div className="lesson-main">
        <p className="lesson-goal">{lesson.goal}</p>
        <dl className="lesson-facts">
          <div><dt>Style</dt><dd>{lesson.style}</dd></div>
          <div><dt>Feel</dt><dd>{lesson.feel}</dd></div>
          <div><dt>Step</dt><dd>{PIANO_STAGES[lesson.level - 1]}, <span className="num">{lesson.level} of 5</span> in {lesson.style}</dd></div>
          <div><dt>Meter</dt><dd className="num">{lesson.meter.numerator}/{lesson.meter.denominator}</dd></div>
          <div><dt>Tempo</dt><dd className="num">start {tempoLabel(lesson, lesson.tempo.start)} → aim for {tempoLabel(lesson, lesson.tempo.target)}</dd></div>
          <div><dt>Hands</dt><dd>{lesson.hands}</dd></div>
          <div><dt>Pedal</dt><dd>{lesson.pedals ? 'Sustain, changed each bar (shown on the 3D keyboard)' : 'None written'}</dd></div>
          <div><dt>Backing</dt><dd>Drum kit and {bass.name.toLowerCase()}, playing <span className="num">{lesson.chords.join(' – ')}</span>.
            Original parts made for this lesson; mute or turn them down in the track list.</dd></div>
        </dl>
        <table className="lesson-counts">
          <tbody>
            {lesson.chords.map((chord, bar) => (
              <tr key={bar}>
                <th scope="row" className="num">Bar {bar + 1}</th>
                <td><span className="lesson-label">Chord</span> {chord}</td>
                <td>{lesson.sections && bar === lesson.bars - 1 ? 'Groove, then the fill from the middle of the bar' : 'Groove'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <details className="lesson-steps">
          <summary>How to practise</summary>
          <ol>{lesson.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          <p className="lesson-note">Finger numbers are written over the notes (1 thumb to 5 little finger) and shown on the 3D keyboard as each key plays:
            <b className="hand-left"> left hand in blue</b>, <b className="hand-right">right hand in orange</b>. Speed starts at the lesson&apos;s starting tempo;
            raise it with ] as it gets comfortable. This is an original exercise in the style, not a transcription of a recording.</p>
        </details>
      </div>
      <nav className="lesson-nav" aria-label="Other lessons">
        <button className="btn" disabled={!previous} onClick={() => previous && onLesson(previous.id)}
          aria-label={previous ? `Previous lesson: ${previous.title}` : 'No previous lesson'}>
          <ChevronLeft size={16} aria-hidden /> Previous
        </button>
        <button className="btn" disabled={!next} onClick={() => next && onLesson(next.id)}
          aria-label={next ? `Next lesson: ${next.title}` : 'No next lesson'}>
          Next <ChevronRight size={16} aria-hidden />
        </button>
      </nav>
    </aside>
  )
}