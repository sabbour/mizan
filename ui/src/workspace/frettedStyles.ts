import type { FrettedInstrumentConfig } from './fretboard'
import { LOOKS, type Look } from './prefs'

export const FRETTED_LOOKS = LOOKS.filter((look) => look !== 'NeonRhythm') as readonly Exclude<Look, 'NeonRhythm'>[]
export type FrettedStyle = Exclude<Look, 'NeonRhythm'>

const MODEL_STYLE_INDEX: Record<FrettedStyle, number> = {
  Realistic: 0,
  ClayStudyModel: 1,
  TechnicalBlueprint: 3,
}

export const styleIndex = (style: FrettedStyle): number => MODEL_STYLE_INDEX[style]

export const normalizeFrettedStyle = (style?: Look): FrettedStyle =>
  style === 'NeonRhythm' || !style ? 'Realistic' : style

export function modelUrl(config: FrettedInstrumentConfig): string {
  return `${import.meta.env.BASE_URL ?? '/'}models/${config.file}`
}
