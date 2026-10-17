import { useEffect, useRef, type ReactNode } from 'react'

type Props = { summary: ReactNode; className?: string; children: ReactNode }

/** A notice's longer explanation, one click away. It opens over the practice view instead of pushing it down, and
 * closes with Escape or a click elsewhere. */
export function NoticeDetails({ summary, className, children }: Props) {
  const details = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const close = (event: PointerEvent) => {
      const element = details.current
      if (element?.open && !element.contains(event.target as Node)) element.open = false
    }
    // Escape closes it even after focus has moved on, and hands focus back to its toggle.
    const escape = (event: KeyboardEvent) => {
      const element = details.current
      if (event.key !== 'Escape' || !element?.open) return
      event.stopPropagation()
      element.open = false
      element.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape, true)
    }
  }, [])
  return (
    <details ref={details} className={className ? `notice-details ${className}` : 'notice-details'}>
      <summary>{summary}</summary>
      <div className="notice-details-panel">{children}</div>
    </details>
  )
}
