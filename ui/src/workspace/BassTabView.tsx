import { BASS } from './fretboard'
import { FrettedTabView, type FrettedPracticeProps } from './FrettedTabView'

export type BassTabViewProps = FrettedPracticeProps

export function BassTabView(props: BassTabViewProps) {
  return <FrettedTabView {...props} config={BASS} />
}
