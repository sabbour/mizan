import { noteName } from './song'

const WHITE = [0, 2, 4, 5, 7, 9, 11]
const isWhite = (m: number) => WHITE.includes(((m % 12) + 12) % 12)
const KW = 21
const WH = 76
const BW = 13
const BH = 47

type Props = {
  tones: number[]
  flats: boolean
  /** Lowest and highest keys drawn; defaults to a tight range around the tones. */
  low?: number
  high?: number
  label: string
  className?: string
  /** Draw note letters in the circles (off for the smallest keyboards). */
  letters?: boolean
}

/** Chord tones circled on a compact keyboard. */
export function Keys({ tones, flats, low, high, label, className, letters = true }: Props) {
  const sorted = [...tones].sort((a, b) => a - b)
  let lo = low ?? sorted[0] ?? 60
  let hi = high ?? sorted.at(-1) ?? 72
  while (!isWhite(lo)) lo--
  while (!isWhite(hi)) hi++
  const whites: number[] = []
  const blacks: number[] = []
  for (let m = lo; m <= hi; m++) (isWhite(m) ? whites : blacks).push(m)
  const left = (m: number) => whites.indexOf(m) * KW
  const center = (m: number) => (isWhite(m) ? left(m) + KW / 2 : left(m - 1) + KW)
  const width = whites.length * KW
  const shown = sorted.filter((m) => m >= lo && m <= hi)
  const names = shown.map((m) => noteName(m, flats))
  const root = tones[0]
  return (
    <svg className={className} viewBox={`-1 -1 ${width + 2} ${WH + 2}`} role="img" aria-label={`${label}: ${names.join(', ')}`}>
      {whites.map((m) => (
        <rect key={m} x={left(m)} y={0} width={KW} height={WH} rx={2} className="key-white" />
      ))}
      {blacks.map((m) => (
        <rect key={m} x={left(m - 1) + KW - BW / 2} y={0} width={BW} height={BH} rx={1.5} className="key-black" />
      ))}
      {shown.map((m, i) => {
        const white = isWhite(m)
        const r = white ? 9 : 6.2
        const cy = white ? WH - 13 : BH - 10
        return (
          <g key={m} className={white ? 'tone' : 'tone tone-black'} data-root={m === root || undefined}>
            <circle cx={center(m)} cy={cy} r={r} />
            {letters && (
              <text x={center(m)} y={cy} dy="0.36em" textAnchor="middle">
                {names[i].replace(/[♯♭]/, '')}
                {/[♯♭]/.test(names[i]) && <tspan className="tone-acc">{names[i].slice(1)}</tspan>}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
