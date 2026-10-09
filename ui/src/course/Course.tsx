import { ChevronLeft, ChevronRight } from 'lucide-react'
import { LESSONS, LEVELS, type Lesson, type LessonBar } from './curriculum'
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

/** The workspace subtitle for a lesson: where it sits in the course. */
export function LessonPanel({ lesson, onLesson }: { lesson: Lesson; onLesson: (id: string) => void }) {
  const index = LESSONS.indexOf(lesson)
  const previous = LESSONS[index - 1]
  const next = LESSONS[index + 1]
  const meter = `${lesson.meter.numerator}/${lesson.meter.denominator}`
  return (
    <aside className="lesson-panel" aria-label={`Lesson ${index + 1} instructions`}>
      <div className="lesson-main">
        <p className="lesson-goal">{lesson.goal}</p>
        <dl className="lesson-facts">
          <div><dt>Level</dt><dd>{lesson.level}, {LEVELS[lesson.level - 1]}</dd></div>
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
                {bar.sticking && <td><span className="lesson-label">Hands</span> {bar.sticking}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        <details className="lesson-steps">
          <summary>How to practise</summary>
          <ol>{lesson.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          <p className="lesson-note">Speed starts at the lesson&apos;s starting tempo; raise it with ] as it gets comfortable. The pattern loops, the click
            and count-in are on, and the 3D kit shows each stroke. Hands are a suggested sticking.</p>
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

/** The built-in course in the library: lessons in order, grouped by level. */
export function CourseSection({ onLesson }: { onLesson: (id: string) => void }) {
  return (
    <section className="course" aria-labelledby="course-title">
      <h2 id="course-title" className="lib-h2">Drum course <span className="dim num">{LESSONS.length}</span></h2>
      <p className="course-intro">
        Built-in practice from a steady pulse to fills, ghost notes and 6/8. Each lesson opens with its score, the 3D kit,
        the click and a loop at its starting tempo. Lessons are separate from your songs.
      </p>
      <ol className="course-levels">
        {LEVELS.map((name, level) => (
          <li key={name} className="course-level">
            <h3>Level {level + 1} · {name}</h3>
            <ol>
              {LESSONS.filter((lesson) => lesson.level === level + 1).map((lesson) => (
                <li key={lesson.id}>
                  <button className="course-lesson" onClick={() => onLesson(lesson.id)}>
                    <span className="course-number num">{LESSONS.indexOf(lesson) + 1}</span>
                    <span className="course-title">{lesson.title}</span>
                    <span className="course-meta num">{lesson.meter.numerator}/{lesson.meter.denominator} · {lesson.tempo.start}–{tempoLabel(lesson, lesson.tempo.target)}</span>
                  </button>
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </section>
  )
}
