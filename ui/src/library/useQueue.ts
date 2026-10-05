import { useCallback, useEffect, useRef, useState } from 'react'
import { host, type QueueJob } from './bridge'

/** Polls the host queue; reports each job that finishes while the app is open. */
export function useQueue() {
  const [jobs, setJobs] = useState<QueueJob[]>([])
  const [finished, setFinished] = useState<QueueJob | null>(null)
  const [version, setVersion] = useState(0)
  const seen = useRef<Map<string, QueueJob['status']> | null>(null)
  const clearFinished = useCallback(() => setFinished(null), [])

  const refresh = useCallback(async () => {
    const next = await host.queue().catch(() => null)
    if (!next) return
    const before = seen.current
    const done = before ? next.filter((j) => j.status === 'done' && before.get(j.id) !== 'done') : []
    seen.current = new Map(next.map((j) => [j.id, j.status]))
    setJobs(next)
    if (done.length) {
      setFinished(done[done.length - 1])
      setVersion((v) => v + 1)
    }
  }, [])

  const busy = jobs.some((j) => j.status === 'running' || j.status === 'queued')
  useEffect(() => {
    const initial = setTimeout(refresh, 0)
    const timer = setInterval(refresh, busy ? 700 : 3000)
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
    }
  }, [refresh, busy])

  return { jobs, refresh, finished, clearFinished, version, bump: () => setVersion((v) => v + 1) }
}
