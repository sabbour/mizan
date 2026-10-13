import { GUITAR } from './fretboard'
import { FrettedTabView, type FrettedPracticeProps } from './FrettedTabView'

export type GuitarTabViewProps = FrettedPracticeProps

export function GuitarTabView(props: GuitarTabViewProps) {
  return <FrettedTabView {...props} config={GUITAR} />
}
