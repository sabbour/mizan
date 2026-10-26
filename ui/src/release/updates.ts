export type ReleaseCheckStatus = 'update-available' | 'up-to-date' | 'unavailable' | 'unsupported'

export type ReleaseUpdateResult = {
  status: ReleaseCheckStatus
  currentVersion: string | null
  latestVersion: string | null
  tagName: string | null
  releaseNotes: string | null
  releaseUrl: string | null
  message: string | null
}

export type ReleaseUpdateUiState = {
  result: ReleaseUpdateResult | null
  checking: boolean
  statusMessage: string | null
  showNotification: boolean
}

export const EMPTY_RELEASE_UPDATE_STATE: ReleaseUpdateUiState = {
  result: null,
  checking: false,
  statusMessage: null,
  showNotification: false,
}

export const BACKGROUND_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const MANUAL_CHECK_COOLDOWN_MS = 60 * 1000

const VERSION_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/
const MAX_VERSION_PART = 65535
const MAX_NOTES_LENGTH = 64 * 1024
const MAX_RELEASE_PAYLOAD_LENGTH = 1_048_576
const MAX_MESSAGE_LENGTH = 300

export function parseReleaseVersion(value: unknown): [number, number, number, number] | null {
  if (typeof value !== 'string') return null
  const match = VERSION_PATTERN.exec(value)
  if (!match) return null
  const parts = match.slice(1).map((part) => part === undefined ? 0 : Number(part))
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0 || part > MAX_VERSION_PART)) return null
  return [parts[0], parts[1], parts[2], parts[3]]
}

export function compareReleaseVersions(left: unknown, right: unknown): number | null {
  const a = parseReleaseVersion(left)
  const b = parseReleaseVersion(right)
  if (!a || !b) return null
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return 0
}

export function displayReleaseVersion(value: unknown): string | null {
  const version = parseReleaseVersion(value)
  if (!version) return null
  return version[3] === 0
    ? version.slice(0, 3).join('.')
    : version.join('.')
}

export function summarizeReleaseNotes(notes: unknown): string | null {
  if (typeof notes !== 'string' || !notes.trim()) return null

  const paragraphs = notes.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)
  for (const paragraph of paragraphs) {
    const plain = paragraph
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
      .replace(/^\s{0,3}#{1,6}\s+[^\n]*(?:\n|$)/gm, ' ')
      .replace(/<\/?h[1-6]\b[^>]*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '')
      .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)]\[[^\]]*]/g, '$1')
      .replace(/[`*_~]/g, '')
      .replace(/&(?:nbsp|#160);/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim()
    if (!plain || /^(?:what(?:'|’)s new(?: in)?(?: v?\d+(?:\.\d+){1,3})?|release notes?|changelog|changes|mizan(?: v?\d+(?:\.\d+){1,3})?|v\d+(?:\.\d+){1,3})$/i.test(plain))
      continue

    const sentenceText = plain.replace(/(?<=\d)\.(?=\d)/g, '\uE000')
    const sentences = (sentenceText.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [sentenceText])
      .map((sentence) => sentence.replace(/\uE000/g, '.'))
    let summary = sentences.slice(0, 2).join('').trim()
    if (summary.length > 360) {
      const bounded = summary.slice(0, 357)
      const lastSpace = bounded.lastIndexOf(' ')
      summary = `${bounded.slice(0, lastSpace > 240 ? lastSpace : bounded.length).trimEnd()}…`
    }
    return summary
  }
  return null
}

export function isCanonicalReleaseUrl(url: unknown, tagName: unknown): url is string {
  if (typeof url !== 'string' || typeof tagName !== 'string' || !parseReleaseVersion(tagName)) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
      && parsed.hostname === 'github.com'
      && !parsed.port
      && !parsed.username
      && !parsed.password
      && parsed.pathname === `/sabbour/mizan/releases/tag/${encodeURIComponent(tagName)}`
      && !parsed.search
      && !parsed.hash
  } catch {
    return false
  }
}

function isCanonicalAssetUrl(url: unknown, tagName: string, assetName: string): url is string {
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
      && parsed.hostname === 'github.com'
      && !parsed.port
      && !parsed.username
      && !parsed.password
      && parsed.pathname === `/sabbour/mizan/releases/download/${encodeURIComponent(tagName)}/${encodeURIComponent(assetName)}`
      && !parsed.search
      && !parsed.hash
  } catch {
    return false
  }
}

export function parseGitHubReleasePayload(
  payload: unknown,
  currentVersionValue: unknown,
  architecture: unknown,
): ReleaseUpdateResult {
  const unavailable = (message = 'GitHub returned an invalid release response. Try again later.'): ReleaseUpdateResult => ({
    status: 'unavailable',
    currentVersion: null,
    latestVersion: null,
    tagName: null,
    releaseNotes: null,
    releaseUrl: null,
    message,
  })
  if (typeof payload === 'string') {
    if (payload.length > MAX_RELEASE_PAYLOAD_LENGTH) return unavailable()
    try { payload = JSON.parse(payload) } catch { return unavailable() }
  }
  const currentParts = parseReleaseVersion(currentVersionValue)
  if (!currentParts || typeof currentVersionValue !== 'string'
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(currentVersionValue)
    || (architecture !== 'x64' && architecture !== 'arm64')
    || !payload || typeof payload !== 'object' || Array.isArray(payload))
    return unavailable()

  const release = payload as Record<string, unknown>
  if (release.draft !== false || release.prerelease !== false)
    return unavailable('GitHub did not return a stable release.')

  const tagName = typeof release.tag_name === 'string' ? release.tag_name : null
  const latestParts = parseReleaseVersion(tagName)
  if (!tagName || !latestParts) return unavailable('GitHub returned an invalid stable release tag.')
  const currentVersion = currentParts.join('.')
  const latestVersion = latestParts.join('.')
  const comparison = compareReleaseVersions(latestVersion, currentVersion)
  if (comparison === null) return unavailable()
  if (comparison <= 0) {
    return {
      status: 'up-to-date',
      currentVersion,
      latestVersion,
      tagName: null,
      releaseNotes: null,
      releaseUrl: null,
      message: null,
    }
  }

  const assetVersion = latestParts[3] === 0 ? latestParts.slice(0, 3).join('.') : latestParts.join('.')
  const expectedAsset = `Mizan_${assetVersion}_${architecture}.msix`
  const assets = Array.isArray(release.assets) ? release.assets : []
  const matchingAsset = assets.find((asset: unknown) => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return false
    const candidate = asset as Record<string, unknown>
    return candidate.name === expectedAsset
      && candidate.state === 'uploaded'
      && typeof candidate.size === 'number'
      && Number.isFinite(candidate.size)
      && candidate.size > 0
      && isCanonicalAssetUrl(candidate.browser_download_url, tagName, expectedAsset)
  })
  if (!matchingAsset)
    return unavailable('A newer release exists, but a matching Windows package is not available yet.')

  if (!isCanonicalReleaseUrl(release.html_url, tagName))
    return unavailable('GitHub returned an invalid release page link.')
  return {
    status: 'update-available',
    currentVersion,
    latestVersion,
    tagName,
    releaseNotes: typeof release.body === 'string' ? release.body.slice(0, MAX_NOTES_LENGTH) : null,
    releaseUrl: release.html_url,
    message: null,
  }
}

export function validateReleaseUpdateResult(value: unknown): ReleaseUpdateResult {
  const unavailable = (message = 'The update check returned an unexpected response.'): ReleaseUpdateResult => ({
    status: 'unavailable',
    currentVersion: null,
    latestVersion: null,
    tagName: null,
    releaseNotes: null,
    releaseUrl: null,
    message,
  })
  if (!value || typeof value !== 'object') return unavailable()

  const result = value as Record<string, unknown>
  const status = result.status
  if (status === 'checked')
    return parseGitHubReleasePayload(result.releasePayload, result.currentVersion, result.architecture)

  const currentVersion = typeof result.currentVersion === 'string' && parseReleaseVersion(result.currentVersion)
    ? result.currentVersion : null
  const latestVersion = typeof result.latestVersion === 'string' && parseReleaseVersion(result.latestVersion)
    ? result.latestVersion : null
  const message = typeof result.message === 'string' ? result.message.slice(0, MAX_MESSAGE_LENGTH) : null

  if (status === 'unsupported') {
    return { status, currentVersion, latestVersion: null, tagName: null, releaseNotes: null, releaseUrl: null, message }
  }
  if (status === 'unavailable') return unavailable(message ?? 'GitHub Releases could not be checked. Try again later.')
  if (!currentVersion || !latestVersion || (status !== 'up-to-date' && status !== 'update-available'))
    return unavailable()

  const comparison = compareReleaseVersions(latestVersion, currentVersion)
  if (comparison === null) return unavailable()

  if (status === 'up-to-date') {
    return comparison <= 0
      ? { status, currentVersion, latestVersion, tagName: null, releaseNotes: null, releaseUrl: null, message }
      : unavailable()
  }

  const tagName = typeof result.tagName === 'string' && parseReleaseVersion(result.tagName) ? result.tagName : null
  const tagComparison = compareReleaseVersions(tagName, latestVersion)
  if (comparison <= 0 || tagComparison !== 0 || !isCanonicalReleaseUrl(result.releaseUrl, tagName))
    return unavailable()

  const releaseNotes = typeof result.releaseNotes === 'string'
    ? result.releaseNotes.slice(0, MAX_NOTES_LENGTH)
    : null
  return {
    status,
    currentVersion,
    latestVersion,
    tagName,
    releaseNotes,
    releaseUrl: result.releaseUrl,
    message,
  }
}

export function isBackgroundCheckDue(lastAttempt: string | null, now = Date.now()): boolean {
  if (!lastAttempt) return true
  const previous = Number(lastAttempt)
  return !Number.isFinite(previous) || previous > now || now - previous >= BACKGROUND_CHECK_INTERVAL_MS
}

export function shouldShowUpdateNotification(
  status: ReleaseCheckStatus,
  latestVersion: string | null,
  dismissedVersion: string | null,
  manualCheck: boolean,
): boolean {
  return status === 'update-available'
    && !!latestVersion
    && (manualCheck || latestVersion !== dismissedVersion)
}

export function releaseCheckMessage(result: ReleaseUpdateResult): string {
  if (result.status === 'update-available') return `Mizan ${result.tagName ?? 'has an update'} is available.`
  if (result.status === 'up-to-date') {
    const version = displayReleaseVersion(result.currentVersion)
    return version ? `You're up to date on v${version}.` : "You're up to date."
  }
  if (result.status === 'unsupported')
    return result.message ?? 'Update checks are available in the installed Windows app.'
  return result.message ?? 'GitHub Releases could not be checked. Try again later.'
}

export type ReleaseUpdateControllerOptions = {
  check: () => Promise<unknown>
  readLastAttempt: () => string | null
  readDismissedVersion: () => string | null
  writeLastAttempt: (timestamp: string) => void
  writeDismissedVersion: (version: string) => void
  now?: () => number
}

export class ReleaseUpdateController {
  private state = EMPTY_RELEASE_UPDATE_STATE
  private readonly listeners = new Set<() => void>()
  private request: Promise<ReleaseUpdateResult> | null = null
  private lastManualCheck = 0
  private startupStarted = false
  private readonly now: () => number
  private readonly options: ReleaseUpdateControllerOptions

  constructor(options: ReleaseUpdateControllerOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  getSnapshot = (): ReleaseUpdateUiState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  start = (): Promise<void> => {
    if (this.startupStarted) return Promise.resolve()
    this.startupStarted = true
    if (!isBackgroundCheckDue(this.options.readLastAttempt(), this.now())) return Promise.resolve()
    return this.check()
  }

  check = async (manual = false): Promise<void> => {
    const existing = this.request
    const now = this.now()
    if (manual) {
      if (!existing && this.lastManualCheck > 0) {
        const elapsed = now - this.lastManualCheck
        if (elapsed >= 0 && elapsed < MANUAL_CHECK_COOLDOWN_MS) {
          const remaining = Math.ceil((MANUAL_CHECK_COOLDOWN_MS - elapsed) / 1000)
          this.update({ ...this.state, statusMessage: `Try again in ${remaining} seconds.` })
          return
        }
      }
      this.lastManualCheck = now
      this.update({ ...this.state, checking: true, statusMessage: 'Checking GitHub Releases…' })
    }

    let request = existing
    if (!request) {
      this.options.writeLastAttempt(String(now))
      this.update({ ...this.state, checking: true })
      request = Promise.resolve().then(this.options.check).then(validateReleaseUpdateResult)
      this.request = request
      void request.finally(() => {
        if (this.request === request) this.request = null
      }).catch(() => {})
    }

    try {
      const result = await request
      if (result.status === 'unavailable')
        console.warn(`GitHub release ${manual ? 'manual' : 'background'} check returned unavailable result.`)
      const current = this.state
      const showNotification = result.status === 'unavailable'
        ? current.showNotification
        : result.status === 'update-available' && current.showNotification
          ? true
          : shouldShowUpdateNotification(
            result.status,
            result.latestVersion,
            this.options.readDismissedVersion(),
            manual,
          )
      this.update({
        result,
        checking: false,
        statusMessage: manual ? releaseCheckMessage(result) : current.statusMessage,
        showNotification,
      })
    } catch (error) {
      console.warn(`GitHub release ${manual ? 'manual' : 'background'} check failed.`,
        error instanceof Error ? error.name : 'Unknown error')
      this.update({
        ...this.state,
        checking: false,
        statusMessage: manual
          ? error instanceof Error ? error.message : 'GitHub Releases could not be checked. Try again later.'
          : this.state.statusMessage,
      })
    }
  }

  dismiss = (): void => {
    const result = this.state.result
    if (result?.status === 'update-available' && result.latestVersion)
      this.options.writeDismissedVersion(result.latestVersion)
    this.update({ ...this.state, showNotification: false })
  }

  private update(state: ReleaseUpdateUiState): void {
    this.state = state
    this.listeners.forEach((listener) => listener())
  }
}
