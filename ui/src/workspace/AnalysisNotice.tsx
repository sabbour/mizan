import type { ReactNode } from 'react'
import { NoticeDetails } from './NoticeDetails'

export const DECODING_DETAIL = 'Some notes may be missing or cut short. Check this saved draft against the recording.'

type Props = {
  decodingHeadline?: string | null
  status?: { headline: string; detail: string; action?: ReactNode } | null
  error?: string | null
}

/** A saved song's transcription warning and analysis status: one compact line each, the explanation one click away. */
export function AnalysisNotice({ decodingHeadline, status, error }: Props) {
  if (!decodingHeadline && !status && !error) return null
  return (
    <aside className="analysis-notice" aria-label={decodingHeadline ? 'Transcription warning' : 'Analysis status'}>
      {decodingHeadline && (
        <div className="analysis-notice-item" data-kind="decoding">
          <strong role="status">{decodingHeadline}</strong>
          <NoticeDetails summary="What this means"><p>{DECODING_DETAIL}</p></NoticeDetails>
        </div>
      )}
      {status && (
        <div className="analysis-notice-item" data-kind="status">
          <strong role={decodingHeadline ? undefined : 'status'}>{status.headline}</strong>
          <NoticeDetails summary="Details"><p>{status.detail}</p></NoticeDetails>
          {status.action}
        </div>
      )}
      {error && <p className="analysis-notice-error" role="alert">{error}</p>}
    </aside>
  )
}
