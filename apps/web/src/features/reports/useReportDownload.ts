/**
 * `useReportDownload` — trigger an authed CSV export as a browser download
 * (ADR-165, ADR-092, ADR-037).
 *
 * The CSV export endpoints sit behind the Supabase bearer guard, so a plain
 * `<a href>` link (which sends no `Authorization` header) 401s — the download
 * must go through the authed fetcher. This hook mirrors
 * {@link useDocumentOpener} but SAVES the bytes rather than opening a tab:
 *
 *   1. fetch the CSV bytes as a Blob through a client fetcher (`authedFetch`),
 *   2. wrap them in a short-lived `URL.createObjectURL` object URL,
 *   3. attach the URL to a hidden `<a download="…">`, click it to save, then
 *   4. revoke the object URL so the bytes stop being reachable via a link.
 *
 * It exposes a calm loading flag (disable/spinner the button while fetching) and
 * a calm error message (ADR-037) — never throwing into render. Multiple triggers
 * (transactions vs summary) each pass their own fetcher + filename, so one hook
 * instance backs one button.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** Fetch the export bytes as a Blob (typically a `reportsClient` authed fetcher). */
export type BlobFetcher = () => Promise<Blob>

export interface UseReportDownloadResult {
  /** Fetch + save the export as a file. Safe to call from a click handler. */
  download: (fetchBlob: BlobFetcher, filename: string) => void
  /** True while the authed fetch is in flight (drive a spinner / disabled state). */
  loading: boolean
  /** A calm, user-facing error message when the download failed; else null. */
  error: string | null
  /** Clear the current error (e.g. on retry or dismiss). */
  clearError: () => void
}

/** Generic fallback copy when a fetcher does not supply its own message. */
const GENERIC_ERROR = "Couldn't download the file. Please try again."

/**
 * Drive an accessible "download this CSV" control against an authed blob fetcher
 * (ADR-165). Returns a `download(fetchBlob, filename)` trigger plus calm
 * loading/error state for the button. The object URL is revoked immediately
 * after the click — unlike the PDF opener, a saved file needs no lingering URL.
 */
export function useReportDownload(): UseReportDownloadResult {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Guards against state updates after unmount (the fetch may outlive the page).
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const clearError = useCallback(() => setError(null), [])

  const download = useCallback(
    (fetchBlob: BlobFetcher, filename: string) => {
      setError(null)
      setLoading(true)
      void (async () => {
        let objectUrl: string | null = null
        try {
          const blob = await fetchBlob()
          objectUrl = URL.createObjectURL(blob)
          // Programmatic save via a hidden anchor: the standard authed-download
          // pattern (a bare `<a href>` can't attach the bearer token, ADR-165).
          const anchor = document.createElement('a')
          anchor.href = objectUrl
          anchor.download = filename
          anchor.rel = 'noopener'
          anchor.style.display = 'none'
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
        } catch (cause) {
          // Never throw into render — surface a calm, friendly message (ADR-037).
          setError(
            cause instanceof Error && cause.message ? cause.message : GENERIC_ERROR,
          )
        } finally {
          // A saved file doesn't need the URL after the click, so release it at
          // once (unlike the PDF opener, which keeps it alive for the new tab).
          if (objectUrl) URL.revokeObjectURL(objectUrl)
          if (mountedRef.current) setLoading(false)
        }
      })()
    },
    [],
  )

  return { download, loading, error, clearError }
}
