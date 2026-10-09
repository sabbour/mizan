export type Span = { top: number; bottom: number }

/**
 * Scroll offset that centres the active score line in the usable viewport. A line taller than the
 * viewport is aligned near its top instead. The scroll container clamps the result at the start
 * and end of the song, so the first and last lines stay at their natural positions.
 */
export function centerDelta(viewport: Span, line: Span): number {
  const height = viewport.bottom - viewport.top
  if (line.bottom - line.top > height) return line.top - (viewport.top + Math.min(12, height / 2))
  return (line.top + line.bottom) / 2 - (viewport.top + viewport.bottom) / 2
}

/** The part of a scroll container not covered by its own sticky children pinned to the bottom edge. */
export function usableSpan(container: HTMLElement): Span {
  const box = container.getBoundingClientRect()
  let bottom = box.bottom
  for (const child of container.children) {
    if (getComputedStyle(child).position !== 'sticky') continue
    const rect = child.getBoundingClientRect()
    if (rect.height && Math.abs(rect.bottom - box.bottom) < 2) bottom = Math.min(bottom, rect.top)
  }
  return { top: box.top, bottom }
}
