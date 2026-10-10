import { useState, type ReactNode } from 'react'
import { CaseUpper, Hand, Hash, Metronome, Minus, Pause, Play, Plus, Repeat, SkipBack, SkipForward, Timer } from 'lucide-react'

type Props = {
  playing: boolean
  countBeat: number
  rate: number
  loop: { startBar: number; endBar: number } | null
  countIn: boolean
  click: boolean
  /** Null when the current track has no pitched notes to name. */
  noteNames: boolean | null
  /** Finger numbers on the piano keyboards (never on the score); null when the track is not a piano part. */
  fingering: boolean | null
  /** Sticking letters and hand colours; null when the current track is not drums. */
  sticking: boolean | null
  onPlay: () => void
  onStep: (delta: number) => void
  onRate: (rate: number) => void
  onLoop: () => void
  onCountIn: () => void
  onClick: () => void
  onNoteNames: () => void
  onFingering: () => void
  onSticking: () => void
  onGo: (query: string) => boolean
}

function Toggle({ on, onPress, icon, label, keyHint, state }: { on: boolean; onPress: () => void; icon: ReactNode; label: string; keyHint?: string; state: string }) {
  return (
    <button type="button" className="toggle" aria-pressed={on} onClick={onPress} title={keyHint ? `${label} (${keyHint})` : label}>
      {icon}
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        <span className="toggle-state">{state}</span>
      </span>
      {keyHint && <kbd>{keyHint}</kbd>}
    </button>
  )
}

export function Transport(p: Props) {
  const [query, setQuery] = useState('')
  const [miss, setMiss] = useState(false)
  const pct = Math.round(p.rate * 100)

  return (
    <div className="transport" role="toolbar" aria-label="Playback">
      <div className="transport-speed">
        <button type="button" className="icon-button" onClick={() => p.onRate(p.rate - 0.05)} disabled={pct <= 25} aria-label="Slower">
          <Minus aria-hidden="true" />
        </button>
        <label className="speed">
          <span className="speed-label">Speed</span>
          <input
            type="range"
            min={25}
            max={100}
            step={5}
            value={pct}
            onChange={(e) => p.onRate(Number(e.target.value) / 100)}
            aria-valuetext={`${pct} percent`}
          />
          <output className="speed-value">{pct}%</output>
        </label>
        <button type="button" className="icon-button" onClick={() => p.onRate(p.rate + 0.05)} disabled={pct >= 100} aria-label="Faster">
          <Plus aria-hidden="true" />
        </button>
      </div>
      <form
          className="goto"
          onSubmit={(e) => {
            e.preventDefault()
            const ok = p.onGo(query)
            setMiss(!ok)
            if (ok) setQuery('')
          }}
        >
          <label htmlFor="goto">Go to</label>
          <input
            id="goto"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setMiss(false)
            }}
            placeholder="bar or section"
            aria-invalid={miss || undefined}
            aria-describedby={miss ? 'goto-miss' : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          {miss && (
            <span id="goto-miss" className="goto-miss" role="alert">
              No bar or section called “{query}”
            </span>
          )}
      </form>

      <div className="transport-main">
        <button type="button" className="icon-button" onClick={() => p.onStep(-1)} aria-label="Previous bar" title="Previous bar (←)">
          <SkipBack aria-hidden="true" />
        </button>
        <button
          type="button"
          className="play"
          data-counting={p.countBeat > 0 || undefined}
          onClick={p.onPlay}
          aria-label={p.countBeat > 0 ? `Counting in, beat ${p.countBeat}` : p.playing ? 'Pause' : 'Play'}
          title={p.playing ? 'Pause (Space)' : 'Play (Space)'}
        >
          {p.countBeat > 0 ? <span className="play-count num">{p.countBeat}</span> : p.playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </button>
        <button type="button" className="icon-button" onClick={() => p.onStep(1)} aria-label="Next bar" title="Next bar (→)">
          <SkipForward aria-hidden="true" />
        </button>
      </div>

      <div className="transport-tools">
        <Toggle on={!!p.loop} onPress={p.onLoop} icon={<Repeat aria-hidden="true" />} label="Loop" keyHint="L" state={p.loop ? `${p.loop.startBar}–${p.loop.endBar}` : 'off'} />
        <Toggle on={p.countIn} onPress={p.onCountIn} icon={<Timer aria-hidden="true" />} label="Count-in" state={p.countIn ? 'on' : 'off'} />
        <Toggle on={p.click} onPress={p.onClick} icon={<Metronome aria-hidden="true" />} label="Click" keyHint="C" state={p.click ? 'on' : 'off'} />
        {p.sticking !== null && (
          <Toggle on={p.sticking} onPress={p.onSticking} icon={<Hand aria-hidden="true" />} label="Sticking" state={p.sticking ? 'L / R' : 'off'} />
        )}
        {p.noteNames !== null && (
          <Toggle on={p.noteNames} onPress={p.onNoteNames} icon={<CaseUpper aria-hidden="true" />} label="Note letters" keyHint="N" state={p.noteNames ? 'on' : 'off'} />
        )}
        {p.fingering !== null && (
          <Toggle on={p.fingering} onPress={p.onFingering} icon={<Hash aria-hidden="true" />} label="Fingering" keyHint="F" state={p.fingering ? 'on' : 'off'} />
        )}
      </div>
    </div>
  )
}
