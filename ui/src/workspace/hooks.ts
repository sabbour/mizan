import { useEffect, useRef, useState } from 'react'
import type { Engine, Transport } from './engine'

/** Calls `onFrame` every animation frame with the engine's transport. */
export function useFrame(engine: Engine, onFrame: (t: Transport) => void): void {
  const cb = useRef(onFrame)
  useEffect(() => {
    cb.current = onFrame
  })
  useEffect(() => {
    let id = 0
    const loop = () => {
      // The next frame is booked first, so one failing frame cannot stop every later one.
      id = requestAnimationFrame(loop)
      cb.current(engine.read())
    }
    id = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(id)
  }, [engine])
}

export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const mq = matchMedia(query)
    const on = () => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

export function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, number, number] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) =>
      setSize({ w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) }),
    )
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size.w, size.h]
}
