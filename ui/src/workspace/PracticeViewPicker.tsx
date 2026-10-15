export type PracticeView = 'score' | 'hands' | 'kit' | 'keyboard' | 'tab' | 'fretboard'
export type PracticeInstrument = 'piano' | 'drums' | 'guitar' | 'bass'

type Props = {
  instrument: PracticeInstrument
  value: PracticeView
  onChange: (view: PracticeView) => void
  handAssignments?: boolean
}

/** Adds a practice guide under the score for the instrument shown: a keyboard or a 3D kit. */
export function PracticeViewPicker({ instrument, value, onChange, handAssignments = true }: Props) {
  const options: { id: PracticeView; label: string; hint: string }[] = [
    { id: 'score', label: 'Score', hint: 'The score on its own' },
    ...(instrument === 'piano' ? [
      ...(handAssignments ? [
        { id: 'hands' as const, label: 'Hands & keys', hint: 'A keyboard under the score: keys sounding now, by hand, with suggested fingers' },
      ] : []),
      { id: 'keyboard' as const, label: '3D keyboard', hint: `A 3D piano beside the score: keys press as they play${handAssignments ? ', in their hand\'s colour, with written fingers' : ''}` },
    ] : instrument === 'drums' ? [
      { id: 'kit' as const, label: 'Drum kit', hint: 'A 3D kit under the score that lights each drum as it is hit' },
    ] : [
      { id: 'tab' as const, label: 'Tab', hint: 'Suggested strings and frets, with the highest string at the top' },
      { id: 'fretboard' as const, label: '3D fretboard & tab', hint: 'A steady fretboard close-up with current notes, next notes and tab' },
    ]),
  ]
  return (
    <div className="chordview-bar">
      <div className="chordview" role="radiogroup" aria-label="Practice guide">
        <span className="chordview-label" aria-hidden="true">Guide</span>
        {options.map((option, index) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={value === option.id}
            tabIndex={value === option.id ? 0 : -1}
            className="chordview-option"
            title={option.hint}
            data-view={option.id}
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => {
              const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
              if (!step) return
              event.preventDefault()
              event.stopPropagation()
              const next = options[(index + step + options.length) % options.length]
              onChange(next.id)
              ;(event.currentTarget.parentElement?.querySelector(`[data-view="${next.id}"]`) as HTMLElement | null)?.focus()
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
