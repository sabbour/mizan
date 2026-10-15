import { useCallback, useState } from 'react'
import { loadPrefs, savePref } from './prefs'

/** The shared Hands switch of the 3D views: on unless the player turned it off, and remembered everywhere. */
export function useHandsPref(): [boolean, () => void] {
  const [on, setOn] = useState(() => loadPrefs().hands ?? true)
  const toggle = useCallback(() => setOn((value) => {
    const next = !value
    savePref('hands', next)
    return next
  }), [])
  return [on, toggle]
}
