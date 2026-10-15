import { poseFrettedHand, type FrettedHandAssets, type FrettedHandPose,
  type FrettedHandPoseContact } from './frettedHandAsset'

export type HandSolveJob = {
  kind: 'solve'
  key: string
  side: 'left' | 'right'
  contacts: FrettedHandPoseContact[]
  state: 'pressed' | 'preview' | 'relaxed'
  neck: { halfWidth: number; depth: number }
  /** A pose for a coming onset: solved after the one needed now, and never discarded by it. */
  ahead?: boolean
  /** Coming poses are solved in this order (lowest first), then in the order they arrived. */
  order?: number
}
export type HandWorkerRequest =
  | { kind: 'init'; assets: FrettedHandAssets }
  | { kind: 'window'; jobs: HandSolveJob[] }
  | HandSolveJob
export type HandWorkerResponse =
  | { kind: 'pose'; key: string; pose: FrettedHandPose; ms?: number }
  | { kind: 'discarded'; key: string }
  | { kind: 'error'; key: string; message: string }

let assets: FrettedHandAssets | null = null
// The pose needed now always goes first and replaces an older "now" request; poses for coming onsets wait their turn.
let latest: HandSolveJob | null = null
let ahead: HandSolveJob[] = []
const MAX_AHEAD = 96
let scheduled = false
const cache = new Map<string, FrettedHandPose>()
const send = (response: HandWorkerResponse) => self.postMessage(response)

const run = () => {
  scheduled = false
  let job = latest
  if (latest) latest = null
  else if (ahead.length) {
    let best = 0
    for (let index = 1; index < ahead.length; index++)
      if ((ahead[index].order ?? Infinity) < (ahead[best].order ?? Infinity)) best = index
    job = ahead.splice(best, 1)[0]
  }
  if (!job) return
  try {
    if (!assets) throw new Error('The fretting-hand models are not ready.')
    const startedAt = performance.now()
    let pose = cache.get(job.key)
    if (!pose) {
      pose = poseFrettedHand(assets[job.side], job.contacts, job.state, job.neck, !!job.ahead)
      // Not solved quickly: the full search runs here, off the page's thread, long before the pose is needed.
      if (job.ahead && pose.unavailable && job.contacts.length)
        pose = poseFrettedHand(assets[job.side], job.contacts, job.state, job.neck, false)
      cache.set(job.key, pose)
      if (cache.size > 256) cache.delete(cache.keys().next().value!)
    }
    send({ kind: 'pose', key: job.key, pose, ms: Math.round(performance.now() - startedAt) })
  } catch (error) {
    send({ kind: 'error', key: job.key, message: error instanceof Error ? error.message : String(error) })
  }
  if (latest || ahead.length) schedule()
}
const schedule = () => {
  if (scheduled) return
  scheduled = true
  setTimeout(run, 0)
}

self.onmessage = (event: MessageEvent<HandWorkerRequest>) => {
  const request = event.data
  if (request.kind === 'init') {
    assets = request.assets
    return
  }
  if (request.kind === 'window') {
    // The coming poses replace the old queue, so work for onsets the playhead has left is dropped.
    const keys = new Set(request.jobs.map((job) => job.key))
    for (const job of ahead) if (!keys.has(job.key)) send({ kind: 'discarded', key: job.key })
    ahead = request.jobs.filter((job) => job.key !== latest?.key && !cache.has(job.key)).slice(0, MAX_AHEAD)
    for (const job of request.jobs) if (cache.has(job.key)) send({ kind: 'pose', key: job.key, pose: cache.get(job.key)! })
    schedule()
    return
  }
  if (request.ahead) {
    const queued = ahead.find((job) => job.key === request.key)
    if (queued) { queued.order = request.order; return }
    if (latest?.key === request.key) return
    ahead.push(request)
    if (ahead.length > MAX_AHEAD) {
      let worst = 0
      for (let index = 1; index < ahead.length; index++)
        if ((ahead[index].order ?? Infinity) >= (ahead[worst].order ?? Infinity)) worst = index
      send({ kind: 'discarded', key: ahead.splice(worst, 1)[0].key })
    }
    schedule()
    return
  }
  const queued = ahead.findIndex((job) => job.key === request.key)
  if (queued >= 0) ahead.splice(queued, 1)
  if (latest && latest.key !== request.key) send({ kind: 'discarded', key: latest.key })
  latest = request
  schedule()
}
