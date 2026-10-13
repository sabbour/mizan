import type { FrettedInstrumentConfig } from './fretboard'
import { LOOKS, type Look } from './prefs'

export type FrettedStyle = Look

export const styleIndex = (style: FrettedStyle): number => LOOKS.indexOf(style)

export function modelUrl(config: FrettedInstrumentConfig): string {
  return `${import.meta.env.BASE_URL ?? '/'}models/${config.file}`
}
