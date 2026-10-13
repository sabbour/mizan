import type { FrettedInstrumentConfig } from './fretboard'

export const FRETTED_STYLES = [
  'Realistic', 'HandPaintedAnime', 'Stylized3D', 'NeonRhythm',
  'TechnicalLearning', 'ToyDiorama', 'Watercolor', 'VintageConcert',
] as const

export type FrettedStyle = (typeof FRETTED_STYLES)[number]
export type FrettedViewMode = 'fretboard' | 'whole'

export const FRETTED_STYLE_LABEL: Record<FrettedStyle, string> = {
  Realistic: 'Realistic',
  HandPaintedAnime: 'Hand-painted anime',
  Stylized3D: 'Stylized 3D',
  NeonRhythm: 'Neon rhythm',
  TechnicalLearning: 'Technical learning',
  ToyDiorama: 'Toy diorama',
  Watercolor: 'Watercolor',
  VintageConcert: 'Vintage concert',
}

export const styleIndex = (style: FrettedStyle): number => FRETTED_STYLES.indexOf(style)

export function modelUrl(config: FrettedInstrumentConfig): string {
  return `${import.meta.env.BASE_URL ?? '/'}models/${config.file}`
}
