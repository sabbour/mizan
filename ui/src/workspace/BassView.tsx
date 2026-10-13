import { BASS } from './fretboard'
import { FrettedInstrumentView, type FrettedInstrumentViewProps } from './FrettedInstrumentView'

export type BassViewProps = FrettedInstrumentViewProps

export function BassView(props: BassViewProps) {
  return <FrettedInstrumentView {...props} config={BASS} />
}
