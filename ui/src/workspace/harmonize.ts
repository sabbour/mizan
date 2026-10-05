import type { Song } from './song'

export type Alternative = {
  symbol: string
  numeral: string | null
  tones: number[]
  flats: boolean
  kind: 'substitute' | 'borrowed' | 'secondary' | 'tritone' | 'color'
  effect: string
}

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
const QUALITY: Record<string, number[]> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  '7': [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  dim: [0, 3, 6],
  m7b5: [0, 3, 6, 10],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  add9: [0, 2, 4, 7],
  madd9: [0, 2, 3, 7],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
}
const mod = (n: number) => ((n % 12) + 12) % 12

function parse(symbol: string) {
  const match = /^([A-G])([#b]?)(.*)$/.exec(symbol)
  if (!match || !Object.hasOwn(QUALITY, match[3])) throw new RangeError(`Unsupported chord symbol: ${symbol}`)
  return {
    root: mod(PC[match[1]] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0)),
    name: match[1] + match[2],
    quality: match[3],
  }
}

export function chordTones(symbol: string): number[] {
  if (symbol === 'N.C.') return []
  const { root, quality } = parse(symbol)
  const midi = root > 6 ? 48 + root : 60 + root
  return QUALITY[quality].map((interval) => midi + interval)
}

function numeral(root: number, quality: string, key: NonNullable<Song['key']>, extension = true): string {
  const degrees = key.mode === 'major'
    ? ['I', 'bII', 'II', 'bIII', 'III', 'IV', '#IV', 'V', 'bVI', 'VI', 'bVII', 'VII']
    : ['I', 'bII', 'II', 'III', '#III', 'IV', '#IV', 'V', 'VI', '#VI', 'VII', '#VII']
  let degree = degrees[mod(root - parse(key.tonic).root)]
  if (quality === 'dim' || (quality.startsWith('m') && !quality.startsWith('maj'))) degree = degree.toLowerCase()
  if (quality === 'dim') return degree + '\u00b0'
  if (!extension) return degree
  return degree + (quality.startsWith('m') && !quality.startsWith('maj') ? quality.slice(1) : quality)
}

export function alternatives(song: Song, index: number, max = 3): Alternative[] {
  const chord = song.chords[index]
  if (!chord?.symbol || chord.symbol === 'N.C.' || !(max >= 1)) return []
  const original = parse(chord.symbol)
  const originalPcs = QUALITY[original.quality].map((n) => mod(original.root + n))
  const key = song.key
  const tonic = key ? parse(key.tonic).root : null
  const dominant = chord.role === 'dominant' || original.quality === '7'
    || (tonic !== null && mod(original.root - tonic) === 7
      && ['', 'sus2', 'sus4'].includes(original.quality))
  const flats = chord.flats || !!key && (key.tonic.includes('b') || (
    key.mode === 'major' ? key.tonic === 'F' : ['D', 'G', 'C', 'F'].includes(key.tonic)
  ))
  const candidates: { option: Alternative; score: number }[] = []
  const seen = new Set([chord.symbol])
  const melody = song.piano.filter((n) => n.hand === 'right' && n.beats > 0
    && n.startBeat < chord.startBeat + chord.beats && n.startBeat + n.beats > chord.startBeat)

  const add = (
    root: number, quality: string, kind: Alternative['kind'], effect: string,
    priority: number, useFlats = flats, degree?: string, name?: string,
  ) => {
    root = mod(root)
    const symbol = (name ?? (useFlats ? FLATS : SHARPS)[root]) + quality
    if (seen.has(symbol)) return
    seen.add(symbol)
    const tones = chordTones(symbol)
    const pcs = tones.map(mod)
    let clash = 0
    for (const note of melody) {
      const pc = mod(Math.round(note.midi))
      if (pcs.includes(pc)) continue
      const overlap = Math.min(note.startBeat + note.beats, chord.startBeat + chord.beats)
        - Math.max(note.startBeat, chord.startBeat)
      const semitone = pcs.some((p) => mod(pc - p) === 1 || mod(p - pc) === 1)
      clash += overlap / chord.beats * ((semitone ? 6 : 0) + (mod(pc - root) === 6 ? 4 : 0))
    }
    candidates.push({
      option: { symbol, numeral: degree ?? (key ? numeral(root, quality, key) : null), tones, flats: useFlats, kind, effect },
      score: clash + priority,
    })
  }

  if (key && tonic !== null) {
    const scale = key.mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10]
    const qualities = key.mode === 'major' ? ['', 'm', 'm', '', '', 'm', 'dim'] : ['m', 'dim', '', 'm', 'm', '', '']
    for (const [rank, degree] of [5, 2, 1, 3, 6, 0, 4].entries()) {
      const root = mod(tonic + scale[degree])
      if (root === original.root) continue
      const shared = QUALITY[qualities[degree]].filter((n) => originalPcs.includes(mod(root + n))).length
      if (shared >= 2) add(root, qualities[degree], 'substitute', 'Keeps familiar notes, changes the mood', 1 + rank * 0.05)
    }
    const borrowed: [number, string][] = key.mode === 'major'
      ? [[5, 'm'], [8, ''], [10, ''], [2, 'dim']]
      : [[0, ''], [5, '']]
    for (const [offset, quality] of borrowed) {
      const root = mod(tonic + offset)
      add(root, quality, 'borrowed', key.mode === 'major'
        ? 'Darker, borrowed from the minor key' : 'Brighter, borrowed from the major key',
      root === original.root ? 0.3 : 2, key.mode === 'major' || flats,
      undefined, root === original.root ? original.name : undefined)
    }
    const next = song.chords[index + 1]
    if (next?.symbol && next.symbol !== 'N.C.') {
      const target = parse(next.symbol)
      if (target.root !== tonic && target.quality !== 'dim' && target.quality !== 'm7b5') {
        add(target.root + 7, '7', 'secondary', `Pulls harder into ${next.symbol}`, 0.2, flats,
          `V/${numeral(target.root, target.quality, key, false)}`)
      }
    }
    if (dominant) {
      add(original.root + 6, '7', 'tritone', 'Adds a chromatic slide into the next chord', 0.5, true)
    }
  }

  const minor = original.quality.startsWith('m') && !original.quality.startsWith('maj')
  const diminished = original.quality === 'dim' || original.quality === 'm7b5'
  const seventh = diminished ? 'm7b5' : minor ? 'm7'
    : dominant ? '7' : 'maj7'
  const colors = diminished ? ['m7b5'] : [seventh, minor ? 'madd9' : 'add9', 'sus2', 'sus4', minor ? 'm6' : '6']
  colors.forEach((quality, i) => add(original.root, quality, 'color',
    quality.startsWith('sus') ? 'Leaves the harmony open' : quality.includes('add9') ? 'Adds shimmer' : 'Adds warmth',
    1.4 + i * 0.1, flats, undefined, original.name))

  const result: Alternative[] = []
  const kinds = new Set<Alternative['kind']>()
  while (candidates.length && result.length < Math.floor(max)) {
    // A small diversity penalty breaks musical near-ties without overriding strong clashes.
    let best = 0
    const score = (i: number) => candidates[i].score + (kinds.has(candidates[i].option.kind) ? 2.5 : 0)
    for (let i = 1; i < candidates.length; i++) if (score(i) < score(best)) best = i
    const [{ option }] = candidates.splice(best, 1)
    result.push(option)
    kinds.add(option.kind)
  }
  return result
}
