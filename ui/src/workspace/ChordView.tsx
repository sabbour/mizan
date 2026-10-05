export type ChordMode = 'names' | 'shapes'

const MODES: { id: ChordMode; label: string; hint: string }[] = [
  { id: 'names', label: 'Names', hint: 'The chords on a staff, with names above (K)' },
  { id: 'shapes', label: 'Shapes', hint: 'A chord chart: a small keyboard for every chord (K)' },
]

/** `smooth` is null where voicing is fixed by the track, which hides the toggle. */
type Props = { value: ChordMode; onChange: (mode: ChordMode) => void; smooth: boolean | null; onSmooth: () => void }

/** How chords are shown over the score, and whether they are voiced for the least hand movement. */
export function ChordView({ value, onChange, smooth, onSmooth }: Props) {
  return (
    <div className="chordview-bar">
    <div className="chordview" role="radiogroup" aria-label="Show chords as">
      <span className="chordview-label" aria-hidden="true">
        Chords
      </span>
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={value === m.id}
          tabIndex={value === m.id ? 0 : -1}
          className="chordview-option"
          title={m.hint}
          onClick={() => onChange(m.id)}
          onKeyDown={(e) => {
            const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
            if (!step) return
            e.preventDefault()
            e.stopPropagation()
            const next = MODES[(MODES.findIndex((x) => x.id === value) + step + MODES.length) % MODES.length]
            onChange(next.id)
            ;(e.currentTarget.parentElement?.querySelector(`[data-mode="${next.id}"]`) as HTMLElement | null)?.focus()
          }}
          data-mode={m.id}
        >
          {m.label}
        </button>
      ))}
    </div>
      {smooth !== null && <button
        type="button"
        className="chordview-smooth"
        aria-pressed={smooth}
        onClick={onSmooth}
        title="Play each chord in the inversion closest to the one before, so your hand barely moves (V)."
      >
        Smooth voicing
      </button>}
    </div>
  )
}
