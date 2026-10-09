import { ChevronLeft, ChevronRight } from 'lucide-react'
import { COLLECTIONS, LEVELS, lessonList, type Collection, type Lesson, type LessonBar } from './curriculum'
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
  return (
    <aside className="lesson-panel" aria-label={`Lesson ${index + 1} instructions`}>
      <div className="lesson-main">
        <p className="lesson-goal">{lesson.goal}</p>
        <dl className="lesson-facts">
          {lesson.style && <div><dt>Style</dt><dd>{lesson.style}</dd></div>}
          {lesson.feel && <div><dt>Feel</dt><dd>{lesson.feel}</dd></div>}
          <div><dt>{lesson.collection ? 'Difficulty' : 'Level'}</dt><dd>{lesson.collection ? 'after ' : ''}Level {lesson.level}, {LEVELS[lesson.level - 1]}</dd></div>
          <div><dt>Meter</dt><dd className="num">{meter}</dd></div>
          <div><dt>Tempo</dt><dd className="num">start {tempoLabel(lesson, lesson.tempo.start)} → aim for {tempoLabel(lesson, lesson.tempo.target)}</dd></div>
          {lesson.limbs && <div><dt>Limbs</dt><dd>{lesson.limbs}</dd></div>}
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

function LessonButton({ lesson, onLesson }: { lesson: Lesson; onLesson: (id: string) => void }) {
  return (
    <li>
      <button className="course-lesson" onClick={() => onLesson(lesson.id)}>
        <span className="course-number num">{lessonList(lesson).indexOf(lesson) + 1}</span>
        <span className="course-title">{lesson.title}{lesson.style && <span className="course-style"> · {lesson.style}</span>}</span>
        <span className="course-meta num">{lesson.meter.numerator}/{lesson.meter.denominator} · {lesson.tempo.start}–{tempoLabel(lesson, lesson.tempo.target)}
          {lesson.collection && ` · Level ${lesson.level}`}</span>
      </button>
    </li>
  )
}

/** The built-in course in the library: lessons in order, grouped by level, then the two style collections. */
export function CourseSection({ onLesson }: { onLesson: (id: string) => void }) {
  const course = lessonList({})
  return (
    <>
      <section className="course" aria-labelledby="course-title">
        <h2 id="course-title" className="lib-h2">Drum course <span className="dim num">{course.length}</span></h2>
        <p className="course-intro">
          Built-in practice from a steady pulse to limb independence, fills, odd meters and advanced grooves. Each lesson opens with its score,
          the 3D kit, the click and a loop at its starting tempo. Lessons are separate from your songs.
        </p>
        <ol className="course-levels">
          {LEVELS.map((name, level) => (
            <li key={name} className="course-level">
              <h3>Level {level + 1} · {name}</h3>
              <ol>{course.filter((lesson) => lesson.level === level + 1).map((lesson) => <LessonButton key={lesson.id} lesson={lesson} onLesson={onLesson} />)}</ol>
            </li>
          ))}
        </ol>
      </section>
      {(Object.keys(COLLECTIONS) as Collection[]).map((collection) => {
        const lessons = lessonList({ collection })
        return (
          <section key={collection} className="course" aria-labelledby={`course-${collection}`}>
            <h2 id={`course-${collection}`} className="lib-h2">{COLLECTIONS[collection].title} <span className="dim num">{lessons.length}</span></h2>
            <p className="course-intro">{COLLECTIONS[collection].intro}</p>
            <ol className="course-levels course-collection">
              {lessons.map((lesson) => <LessonButton key={lesson.id} lesson={lesson} onLesson={onLesson} />)}
            </ol>
          </section>
        )
      })}
    </>
  )
}
