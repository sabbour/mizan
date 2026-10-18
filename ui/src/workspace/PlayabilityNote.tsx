import type { Engine } from './engine'
import { barAt, barStart } from './meter'
import { NoticeDetails } from './NoticeDetails'
import { playabilityNotice, type PlayabilityIssue, type PlayabilitySummary } from './playability'
import type { Song } from './song'

type Props = {
  summary: PlayabilitySummary
  song: Song
  engine: Engine
  asTranscribed: boolean
  onToggle: (asTranscribed: boolean) => void
}

const MAX_LISTED = 40

const describe = (issue: PlayabilityIssue, instrument: PlayabilitySummary['instrument']) => {
  const notes = `${issue.count} note${issue.count === 1 ? '' : 's'}`
  if (issue.kind === 'unplayable') return instrument === 'drums'
    ? `${issue.count} simultaneous stroke${issue.count === 1 ? '' : 's'} left unassigned`
    : `${notes} can't be played as written`
  if (issue.kind === 'repeat') return `${issue.count} fast same-hand repeat${issue.count === 1 ? '' : 's'}`
  if (issue.kind === 'octave') return `${notes} shifted by an octave to preserve the chord`
  if (issue.kind === 'jump') return 'quick jump between hand positions'
  return instrument === 'piano' ? `${notes} moved to the other hand`
    : instrument === 'drums' ? `${issue.count} stroke${issue.count === 1 ? '' : 's'} assigned a hand`
      : `${notes} repositioned on the fretboard`
}

/** A small, non-blocking note about what the playability repair changed, with a way to see where and to compare. */
export function PlayabilityNote({ summary, song, engine, asTranscribed, onToggle }: Props) {
  const lines = playabilityNotice(summary)
  if (!lines.length) return null
  const where = (beat: number) => {
    const bar = barAt(song, beat)
    return `Bar ${bar + 1}, beat ${Number((beat - barStart(song, bar) + 1).toFixed(2))}`
  }
  return (
    <div className="playability-note" role="status" data-playability={asTranscribed ? 'as-transcribed' : 'playable'}>
      <p className="playability-lines">
        {asTranscribed ? 'Showing the music as transcribed. ' : ''}{lines.join(' ')}
      </p>
      <div className="playability-switch" role="group" aria-label="Which version to show">
        <button type="button" aria-pressed={!asTranscribed} onClick={() => onToggle(false)}>Playable</button>
        <button type="button" aria-pressed={asTranscribed} onClick={() => onToggle(true)}>As transcribed</button>
      </div>
      <NoticeDetails className="playability-where" summary="Show where">
        <ul>
          {summary.issues.slice(0, MAX_LISTED).map((issue) =>
            <li key={`${issue.kind}:${issue.beat}`} data-kind={issue.kind}>
              <button type="button" onClick={() => engine.seek(issue.beat)}>{where(issue.beat)}</button>
              {' · '}{describe(issue, summary.instrument)}
            </li>)}
        </ul>
        {summary.issues.length > MAX_LISTED && <p>{summary.issues.length - MAX_LISTED} more not listed.</p>}
      </NoticeDetails>
    </div>
  )
}
