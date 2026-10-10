import type { HarmonyOptions } from './creative'

type Option<T> = { id: T; label: string; hint: string }

/** A labelled radiogroup in the chord-view style, with arrow-key movement. */
function Choice<T extends string | number>({ label, options, value, onChange }: { label: string; options: Option<T>[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="chordview" role="radiogroup" aria-label={label}>
      <span className="chordview-label" aria-hidden="true">
        {label}
      </span>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          tabIndex={value === o.id ? 0 : -1}
          className="chordview-option"
          title={o.hint}
          onClick={() => onChange(o.id)}
          onKeyDown={(e) => {
            const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
            if (!step) return
            e.preventDefault()
            e.stopPropagation()
            const i = (options.findIndex((x) => x.id === value) + step + options.length) % options.length
            onChange(options[i].id)
            ;(e.currentTarget.parentElement?.children[i + 1] as HTMLElement | undefined)?.focus()
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const PLACES: Option<'below' | 'above'>[] = [
  { id: 'below', label: 'Below', hint: 'Under the melody, like a second piano voice' },
  { id: 'above', label: 'Above', hint: 'Over the melody, like a harmony singer' },
]
const SOURCES: Option<HarmonyOptions['source']>[] = [
  { id: 'melody', label: 'Melody', hint: 'Follow the lead melody in its detected key' },
  { id: 'chords', label: 'Chords', hint: 'Follow identified chord tones with sustained notes; skip uncertain and no-chord passages' },
]
const INTERVALS: Option<HarmonyOptions['interval']>[] = [
  { id: 3, label: '3rds', hint: 'Close and sweet' },
  { id: 6, label: '6ths', hint: 'More open' },
  { id: 10, label: '10ths', hint: 'Wide, a classic piano sound; below, it moves to the left hand' },
]

/** How the Harmony line is generated: where it sits, how far from the melody, and how many notes. The choices open
 * from one compact button that names the current setting, so they never crowd the title and track. */
export function HarmonyLineView({ value, onChange }: { value: HarmonyOptions; onChange: (v: HarmonyOptions) => void }) {
  const current = [SOURCES.find((o) => o.id === value.source)?.label, value.above ? 'above' : 'below',
    INTERVALS.find((o) => o.id === value.interval)?.label, value.source === 'melody' && value.sparse ? 'long notes' : null].filter(Boolean).join(' · ')
  return (
    <details className="harmony-options">
      <summary className="harmony-summary" title="How the harmony line is made">Harmony: {current}</summary>
    <div className="chordview-bar harmony-options-panel">
      <Choice label="Follow" options={SOURCES} value={value.source} onChange={(source) => onChange({ ...value, source })} />
      <Choice label="Harmony" options={PLACES} value={value.above ? 'above' : 'below'} onChange={(p) => onChange({ ...value, above: p === 'above' })} />
      <Choice label="In" options={INTERVALS} value={value.interval} onChange={(interval) => onChange({ ...value, interval })} />
      {value.source === 'melody' && <button
        type="button"
        className="chordview-smooth"
        aria-pressed={value.sparse}
        onClick={() => onChange({ ...value, sparse: !value.sparse })}
        title="Harmonize only the notes on the beat that last a beat or more, so it is easier to play"
      >
        Long notes only
      </button>}
    </div>
    </details>
  )
}
