import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Pause, Play, RotateCcw, X } from 'lucide-react'
import { host, type Found, type QueueJob } from './bridge'
import { decodingErrorHeadline, instrumentStatus, jobExecutionLabel, jobQueuePosition, jobStageLabel, jobStagePercent, jobStageState, jobTitle, roughly, smallerCpuRetryModel, stageModelLabel, stageProviderLabel, STAGE_LABEL, took } from './format'
import './jobpanel.css'

type Props = { job: QueueJob; jobs: QueueJob[]; onClose: () => void; onChange: () => void; onOpen: (songId: string) => void }

const ORDINAL = new Intl.PluralRules('en', { type: 'ordinal' })
const SUFFIX: Record<string, string> = { one: 'st', two: 'nd', few: 'rd', other: 'th' }
const nth = (n: number) => `${n}${SUFFIX[ORDINAL.select(n)]}`
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
const CLOUD_PROVIDER_NAMES: Record<string, string> = {
  azure: 'Azure',
  gcp: 'Google Cloud',
  aws: 'AWS',
}

export function JobPanel({ job: j, jobs, onClose, onChange, onOpen }: Props) {
  const panel = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [clockTime, setClockTime] = useState(() => Date.now())
  const actionInFlight = useRef(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null)
  const act = async (action: () => Promise<unknown>) => {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setActionBusy(true)
    setActionError(null)
    try {
      await action()
      onChange()
    } catch (reason) {
      setActionError({ id: j.id, message: reason instanceof Error ? reason.message : 'This job action failed. Try again.' })
    } finally {
      actionInFlight.current = false
      setActionBusy(false)
    }
  }

  useEffect(() => {
    if (j.status !== 'running') return
    const timer = window.setInterval(() => setClockTime(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [j.id, j.status])

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    heading.current?.focus()
    return () => before?.focus()
  }, [])

  // Non-modal: the library stays usable, a click on another queue row switches jobs, anything else closes.
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const down = (e: PointerEvent) => {
      const t = e.target as Element
      if (!panel.current?.contains(t) && !t.closest('.job')) onClose()
    }
    document.addEventListener('keydown', key)
    document.addEventListener('pointerdown', down)
    return () => {
      document.removeEventListener('keydown', key)
      document.removeEventListener('pointerdown', down)
    }
  }, [onClose])

  useEffect(() => heading.current?.focus({ preventScroll: true }), [j.id])

  const finished = Math.max(j.stages.filter((s) => s.seconds != null).length, j.stages.findIndex((s) => s.name === j.stage))
  const current = j.status === 'running'
  const jobElapsed = current
    ? Math.max(0, (clockTime - Date.parse(j.attemptQueuedAt ?? j.startedAt ?? j.createdAt)) / 1000) : null
  const stageElapsed = current && j.stageStartedAt
    ? Math.max(0, (clockTime - Date.parse(j.stageStartedAt)) / 1000) : null
  const stepPercent = jobStagePercent(j)
  const decodingHeadline = decodingErrorHeadline(j.decodingErrors?.count)
  const cloudProviderName = j.cloudProviderName
    ?? CLOUD_PROVIDER_NAMES[j.cloudProvider ?? 'azure']
    ?? j.cloudProvider
  const { ahead, place } = jobQueuePosition(j, jobs)
  const wait = ahead.reduce((t, q) => t + (q.eta?.seconds ?? 0), 0)
  const smallerRetryModel = smallerCpuRetryModel(j)

  let lead: string
  let sub: string
  if (j.status === 'running') {
    lead = j.eta ? `${cap(roughly(j.eta.seconds, j.eta.low, j.eta.high))} left` : 'Working'
    sub = `${jobStageLabel(j)}${stepPercent == null ? '' : ` · ${stepPercent}% step`}`
  } else if (j.status === 'queued') {
    lead = ahead.length ? wait > 0 ? `Starts in ${roughly(wait)}` : 'Waiting for earlier work' : 'Starts next'
    sub = `${place === 1 ? ahead.length ? 'Next after current job' : 'Next in line' : `${nth(place)} in line`}${j.eta ? ` · takes ${roughly(j.eta.seconds)}` : ''}`
  } else if (j.status === 'done') {
    lead = decodingHeadline ?? 'Ready to practise'
    sub = j.elapsedSeconds != null ? `Took ${took(j.elapsedSeconds)}` : 'Total time not recorded'
  } else if (j.status === 'failed') {
    lead = `Stopped while ${jobStageLabel(j).toLowerCase()}`
    sub = finished ? `${finished} of ${j.stages.length} steps finished` : 'Nothing finished yet'
  } else {
    lead = 'Cancelled'
    sub = finished ? `${finished} of ${j.stages.length} steps finished before it stopped` : 'Nothing was processed'
  }

  const title = jobTitle(j)
  const warnings = [...new Set(j.warnings)]
  return (
    <aside ref={panel} className="jp" role="dialog" aria-modal="false" aria-labelledby="jp-title" data-status={j.status}>
      <header className="jp-head">
        {j.thumbnail ? <img className="jp-thumb" src={j.thumbnail} alt="" /> : <span className="jp-thumb" aria-hidden />}
        <div className="jp-id">
          <h2 id="jp-title" ref={heading} tabIndex={-1}>
            {title}
          </h2>
          <p className="dim">{j.kind === 'align' ? 'Lining up an imported file with this recording' : j.url.replace(/^https?:\/\/(www\.)?/, '')}</p>
        </div>
        <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <X size={18} />
        </button>
      </header>

      <div className="jp-body">
        <section className="jp-now" aria-live="polite">
          <p className="jp-lead">{lead}</p>
          <p className="jp-sub num">{sub}</p>
          <p className="jp-elapsed">{jobExecutionLabel(j)}</p>
          {j.processingMode === 'cloud' && <p className="dim">HT-Demucs and MuScriptor use {cloudProviderName} GPU processing. Audio preparation and score processing run on this PC.</p>}
          {j.processingMode === 'cloud' && j.status === 'cancelled' && <p className="dim">Cancelled in Mizan. {cloudProviderName} stop requests are best-effort; check the remote execution if processing or charges continue.</p>}
          {j.status === 'running' && jobElapsed != null && (
            <p className="jp-elapsed num">
              {j.attemptQueuedAt ? 'Total elapsed' : j.startedAt ? 'Run elapsed' : 'Since queued'} {took(jobElapsed)}
            </p>
          )}
          {(j.status === 'failed' || j.status === 'cancelled') && (
            <p className="jp-elapsed num">
              {j.elapsedSeconds == null ? 'Total time not recorded' : `Total time ${took(j.elapsedSeconds)}`}
            </p>
          )}
          {j.processingMode === 'cloud' && (
            <p className="jp-elapsed num">
              {cloudProviderName} round trip {j.cloudElapsedSeconds != null ? `${took(j.cloudElapsedSeconds)} (included in total)` :
                j.status === 'running' ? 'available after processing' : 'not recorded'}
            </p>
          )}
          {j.status === 'running' && (
            <div className={`bar jp-bar${stepPercent == null ? ' is-indeterminate' : ''}`}
              role="progressbar" aria-label={`${title} ${jobStageLabel(j)} progress`}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={stepPercent ?? undefined}>
              {stepPercent != null && <span style={{ transform: `scaleX(${stepPercent / 100})` }} />}
            </div>
          )}
          <div className="jp-actions">
            {(j.status === 'failed' || j.status === 'cancelled') && (
              <button className="btn btn-primary" disabled={actionBusy} onClick={() => void act(() => host.retry(j.id))}>
                <RotateCcw size={15} aria-hidden /> Retry
              </button>
            )}
            {smallerRetryModel && (
              <button className="btn" disabled={actionBusy}
                onClick={() => void act(() => host.retry(j.id, smallerRetryModel))}>
                <RotateCcw size={15} aria-hidden /> Retry with MuScriptor Small
              </button>
            )}
            {(j.status === 'running' || j.status === 'queued') && (
              <button className="btn" disabled={actionBusy} onClick={() => void act(() => host.cancel(j.id))}>
                <X size={15} aria-hidden /> {actionBusy ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
          </div>
          {actionError?.id === j.id && <p className="jp-error" role="alert">
            {j.processingMode === 'cloud' ? `${cloudProviderName}: ` : ''}{actionError.message}
          </p>}
        </section>

        {decodingHeadline && (
          <div className="jp-incomplete" role="status">
            <strong>{decodingHeadline}</strong>
            <p>Some notes may be missing or cut short. Check this saved draft against the recording.</p>
          </div>
        )}

        {j.status === 'failed' && (
          <div className="jp-error" role="alert">
            <p>
              <strong>{j.processingMode === 'cloud' ? `${cloudProviderName}: ` : ''}{j.errorMessage ?? 'This job failed.'}</strong>
            </p>
            {j.fix && <p>{j.fix}</p>}
          </div>
        )}

        {warnings.length > 0 && (
          <details className="jp-limits">
            <summary>Analysis limitations <span className="num">{warnings.length}</span></summary>
            <ul className="jp-warnings">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        )}

        <FoundSoFar job={j} />

        <section aria-labelledby="jp-steps">
          <h3 id="jp-steps" className="jp-h3">
            Steps
          </h3>
          <ol className="jp-steps">
            {j.stages.map((s) => {
              const state = jobStageState(j, s.name)
              return (
                <li key={s.name} data-state={state}>
                  <span className="jp-dot" aria-hidden>
                    {state === 'done' && <Check size={13} strokeWidth={2.6} />}
                    {(state === 'failed' || state === 'cancelled') && <X size={13} strokeWidth={2.6} />}
                  </span>
                  <span className="jp-step">{state === 'now' || state === 'failed' || state === 'cancelled'
                    ? jobStageLabel(j) : STAGE_LABEL[s.name]}</span>
                  <span className="jp-time num">
                    {state === 'done' && (s.seconds != null ? took(s.seconds) : 'Complete')}
                    {state === 'now' && `Running${stepPercent == null ? '' : ` · ${stepPercent}% step`}${stageElapsed == null ? '' : ` · ${took(stageElapsed)}`}`}
                    {state === 'failed' && 'Failed'}
                    {state === 'cancelled' && 'Cancelled'}
                    {state === 'not-run' && 'Not run'}
                    {state === 'queued' && 'Not started'}
                    {state === 'todo' && s.estimate != null && `~${took(s.estimate)}`}
                  </span>
                  <span className="visually-hidden">{{ done: 'finished', now: 'running', failed: 'failed', cancelled: 'cancelled', 'not-run': 'not run', queued: 'not started', todo: 'not started' }[state]}</span>
                </li>
              )
            })}
          </ol>
        </section>

        <Technical key={j.id} job={j} elapsed={stageElapsed} />
      </div>
      {j.status === 'done' && j.songId && (
        <div className="jp-ready" role="status">
          <span>Song ready</span>
          <button className="btn btn-primary" onClick={() => onOpen(j.songId!)}>Open song</button>
        </div>
      )}
    </aside>
  )
}

function FoundSoFar({ job: j }: { job: QueueJob }) {
  const f = j.found
  const has = j.detected || f?.key || f?.tempo || f?.stems
  return (
    <section aria-labelledby="jp-found" className="jp-found">
      <h3 id="jp-found" className="jp-h3">
        {j.status === 'done' ? 'Found' : 'Found so far'}
      </h3>
      {j.detected && <p className="jp-level-note">These bars show how loud each isolated recording is, not transcription progress. Mizan still checks piano and drums for notes when a bar reads 0%.</p>}
      {!has && <p className="dim jp-none">Results show up here as each step finishes.</p>}
      {j.detected && (
        <dl className="jp-detect jp-reveal">
          {(['piano', 'drums', 'vocals'] as const).map((k) => (
            <div key={k}>
              <dt>{k === 'piano' ? 'Piano' : k === 'vocals' ? 'Vocal melody' : 'Drums'}</dt>
              <dd>
                <span className="meter" aria-hidden>
                  <span style={{ transform: `scaleX(${j.detected![k] ?? 0})` }} />
                </span>
                <span className="num" title="Isolated stem loudness relative to the mix, not transcription progress or confidence">{j.detected![k] == null ? 'Level unavailable' : `${Math.round(j.detected![k]! * 100)}% stem level`}</span>
                <span className="dim">{instrumentStatus(j, k)}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {(f?.key || f?.tempo) && (
        <dl className="jp-facts jp-reveal">
          {f.key && (
            <div>
              <dt>Key</dt>
              <dd>{f.key}</dd>
            </div>
          )}
          {f.tempo && (
            <div>
              <dt>Tempo</dt>
              <dd className="num">{Math.round(f.tempo)} BPM</dd>
            </div>
          )}
        </dl>
      )}
      {f?.stems && <Listen key={j.id} stems={f.stems} />}
    </section>
  )
}

const STEM_LABEL = { mix: 'Full mix', piano: 'Piano', drums: 'Drums' } as const

function Listen({ stems }: { stems: NonNullable<Found['stems']> }) {
  const kinds = (['mix', 'piano', 'drums'] as const).filter((k) => stems[k])
  const [pick, setPick] = useState<(typeof kinds)[number]>(kinds.includes('piano') ? 'piano' : kinds[0])
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement>(null)
  const position = useRef(0)
  const resume = useRef(false)
  const selected = kinds.includes(pick) ? pick : kinds[0]
  const play = (a: HTMLAudioElement) => {
    setError(null)
    void a.play().catch((reason: unknown) => {
      if (audio.current !== a) return
      setPlaying(false)
      setError(reason instanceof Error ? reason.message : 'Could not play this recording. Try again.')
    })
  }

  useEffect(() => {
    const player = audio.current
    return () => {
      resume.current = false
      player?.pause()
    }
  }, [])

  const choose = (k: typeof pick) => {
    if (k === selected) return
    const a = audio.current
    position.current = a?.currentTime ?? 0
    resume.current = playing
    a?.pause()
    setError(null)
    setPick(k)
  }
  const toggle = () => {
    const a = audio.current
    if (!a) return
    resume.current = false
    if (a.paused) play(a)
    else a.pause()
  }
  if (!kinds.length) return null
  return (
    <div className="jp-listen jp-reveal">
      <button className="jp-play" onClick={toggle} aria-label={playing ? 'Pause' : `Play ${STEM_LABEL[selected].toLowerCase()}`}>
        {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>
      <div className="jp-seg" role="radiogroup" aria-label="Listen to">
        {kinds.map((k) => (
          <button key={k} role="radio" aria-checked={selected === k} onClick={() => choose(k)}>
            {STEM_LABEL[k]}
          </button>
        ))}
      </div>
      <audio ref={audio} src={stems[selected]} preload="metadata"
        onLoadedMetadata={(event) => {
          const a = event.currentTarget
          if (position.current > 0 && Number.isFinite(a.duration)) {
            a.currentTime = Math.min(position.current, a.duration)
          }
          position.current = 0
          if (resume.current) {
            resume.current = false
            play(a)
          }
        }}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onError={() => { setPlaying(false); setError('Could not load this recording. Try again.') }} />
      {error && <p className="jp-error" role="alert">{error}</p>}
    </div>
  )
}

function Technical({ job: j, elapsed }: { job: QueueJob; elapsed: number | null }) {
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<string[] | null>(null)
  const [logError, setLogError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const live = j.status === 'running'

  useEffect(() => {
    if (!open) return
    let alive = true
    const load = () => host.jobLog(j.id).then(
      (result) => { if (alive) { setLines(result); setLogError(null) } },
      (error) => { if (alive) setLogError(error instanceof Error ? error.message : 'Could not load job activity.') },
    )
    void load()
    const t = live ? setInterval(load, 2000) : undefined
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [open, live, j.id])

  const copy = () =>
    void navigator.clipboard.writeText([`${jobTitle(j)} (${j.url})`, ...(j.errorCode ? [`Error code ${j.errorCode}`] : []), ...(lines ?? [])].join('\n')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })

  return (
    <details className="jp-tech" onToggle={(e) => {
      setOpen(e.currentTarget.open)
      if (e.currentTarget.open) {
        setLines(null)
        setLogError(null)
      }
    }}>
      <summary>Technical detail</summary>
      <ol className="jp-stage-list">
        {j.stages.map((s) => {
          const state = jobStageState(j, s.name)
          const active = state === 'now'
          const progress = active ? jobStagePercent(j) : null
          const details = [
            s.model || s.method ? stageModelLabel(s) : s.name === 'finalize' && (state === 'now' || state === 'done') ? 'Saving the song…' : null,
            s.provider ? stageProviderLabel(s.provider) : null,
            s.timingNote ?? null,
          ].filter((value): value is string => value !== null)
          return (
            <li className="jp-stage" key={s.name} data-todo={state === 'todo' || state === 'queued' || state === 'not-run' || undefined}
              data-active={active || undefined} data-state={state}>
              <div className="jp-stage-top">
                <strong>{active || state === 'failed' || state === 'cancelled' ? jobStageLabel(j) : STAGE_LABEL[s.name]}</strong>
                <span className="num">{active ? <span className="jp-live">Running{progress == null ? '' : ` · ${progress}% step`}{elapsed == null ? '' : ` · ${took(elapsed)} elapsed`}</span> :
                  state === 'failed' ? 'Failed' : state === 'cancelled' ? 'Cancelled'
                    : state === 'done' ? s.seconds != null ? `${s.seconds.toFixed(2)} s` : 'Complete'
                      : state === 'queued' ? 'Not started' : state === 'not-run' ? 'Not run' : 'Not started'}</span>
              </div>
              {details.length > 0 && <div className="jp-stage-detail">
                {details.map((detail) => <span key={detail}>{detail}</span>)}
              </div>}
              {active && (
                <div className="jp-stage-bar" data-indeterminate={progress == null || undefined}
                  role="progressbar" aria-label={`${jobStageLabel(j)} step progress`}
                  aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}>
                  {progress != null && <span style={{ transform: `scaleX(${progress / 100})` }} />}
                </div>
              )}
            </li>
          )
        })}
      </ol>
      {j.errorCode && <p className="jp-code num dim">Error code {j.errorCode}</p>}
      <div className="jp-log-head">
        <h4>Job activity</h4>
        <button className="btn btn-quiet" onClick={copy} disabled={!lines}>
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="jp-log" tabIndex={0}>{logError ?? (lines ? lines.join('\n') : 'Loading job activity…')}</pre>
    </details>
  )
}
