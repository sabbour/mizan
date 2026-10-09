/**
 * Choices that follow the player across songs, lessons and restarts: count-in, speed, click, the sticking letters
 * and the drum kit's look. Each is stored only when the player changes it, so an absent value keeps the default.
 */
export type KitType = 'acoustic' | 'electronic'
export const KIT_TYPES: KitType[] = ['electronic', 'acoustic']
/** Looks apply to either kit; only LowPoly changes the geometry (to the asset's own low level of detail). */
export const LOOKS = ['Realistic', 'HandPaintedAnime', 'StylizedAnimated3D', 'LowPoly', 'NeonRhythm', 'TechnicalBlueprint', 'ClayStudyModel'] as const
export type Look = (typeof LOOKS)[number]
/** A kit and its look, stored together, e.g. `electronic:Realistic`. */
export type KitStyle = `${KitType}:${Look}`
export const KIT_STYLES: KitStyle[] = KIT_TYPES.flatMap((kit) => LOOKS.map((look) => `${kit}:${look}` as KitStyle))
export const DEFAULT_KIT_STYLE: KitStyle = 'electronic:Realistic'
/** Earlier single-word choices, kept so a saved choice still opens the same kit. */
const LEGACY: Record<string, KitStyle> = {
  electronic: 'electronic:Realistic', studio: 'electronic:Realistic', acoustic: 'acoustic:Realistic', illustrated: 'acoustic:HandPaintedAnime',
}
export const splitKitStyle = (style: KitStyle) => {
  const [kit, look] = style.split(':') as [KitType, Look]
  return { kit, look }
}
export type PracticePrefs = { countIn?: boolean; rate?: number; click?: boolean; sticking?: boolean; kitStyle?: KitStyle }

const KEY = 'mizan:practice'
const SWITCHES = ['countIn', 'click', 'sticking'] as const

/** Speed as the transport sets it: 25% to 100% in 5% steps. */
export const validRate = (rate: unknown): rate is number =>
  typeof rate === 'number' && rate >= 0.25 && rate <= 1 && Math.abs(rate * 20 - Math.round(rate * 20)) < 1e-9

function read(warn: boolean): PracticePrefs {
  let value: unknown
  try {
    value = JSON.parse(localStorage.getItem(KEY) ?? 'null')
  } catch (error) {
    if (warn) console.warn('Could not restore practice preferences; using the defaults.', error)
    return {}
  }
  if (value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    if (warn) console.warn('Could not restore practice preferences; using the defaults.', new Error('Saved preferences are not an object'))
    return {}
  }
  const saved = value as Record<string, unknown>
  const prefs: PracticePrefs = {}
  for (const key of SWITCHES) {
    if (!(key in saved)) continue
    if (typeof saved[key] === 'boolean') prefs[key] = saved[key]
    else if (warn) console.warn(`Ignoring the saved ${key} preference; it is not on or off.`, saved[key])
  }
  if ('kitStyle' in saved) {
    if (KIT_STYLES.includes(saved.kitStyle as KitStyle)) prefs.kitStyle = saved.kitStyle as KitStyle
    else if (typeof saved.kitStyle === 'string' && saved.kitStyle in LEGACY) prefs.kitStyle = LEGACY[saved.kitStyle]
    else if (warn) console.warn('Ignoring the saved drum kit style; it is not one of the offered styles.', saved.kitStyle)
  }
  if ('rate' in saved) {
    if (validRate(saved.rate)) prefs.rate = saved.rate
    else if (warn) console.warn('Ignoring the saved speed; it is not 25% to 100% in 5% steps.', saved.rate)
  }
  return prefs
}

/** The saved preferences that can be used; unusable values are reported and left at their defaults. */
export const loadPrefs = (): PracticePrefs => read(true)

/** Store one preference, keeping the others. */
export function savePref<K extends keyof PracticePrefs>(key: K, value: NonNullable<PracticePrefs[K]>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...read(false), [key]: value }))
  } catch (error) {
    console.warn('Could not save practice preferences.', error)
  }
}
