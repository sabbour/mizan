import { GUITAR } from './fretboard'
import { FrettedInstrumentView, type FrettedInstrumentViewProps } from './FrettedInstrumentView'

export type GuitarViewProps = FrettedInstrumentViewProps

export function GuitarView(props: GuitarViewProps) {
  return <FrettedInstrumentView {...props} config={GUITAR} />
}
