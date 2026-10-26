import { ExternalLink, X } from 'lucide-react'
import './releaseUpdate.css'

type Props = {
  version: string
  summary: string | null
  releaseUrl: string
  onDismiss: () => void
}

export function ReleaseUpdateNotice({ version, summary, releaseUrl, onDismiss }: Props) {
  return (
    <aside className="release-update-notice" role="status" aria-live="polite" aria-atomic="true"
      aria-label={`Mizan ${version} update available`}>
      <div className="release-update-copy">
        <strong className="release-update-title">Mizan {version} is available</strong>
        <p className="release-update-summary">{summary ?? 'See the release notes for what’s new.'}</p>
        <a className="release-update-link" href={releaseUrl} target="_blank" rel="noopener noreferrer">
          Update on GitHub <ExternalLink size={14} aria-hidden />
        </a>
      </div>
      <button type="button" className="release-update-dismiss" aria-label="Dismiss update notification" onClick={onDismiss}>
        <X size={18} aria-hidden />
      </button>
    </aside>
  )
}
