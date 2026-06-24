/**
 * `useDocumentOpener` — open an authed PDF blob in a new tab, with calm state.
 *
 * Every document route now sits behind the Supabase bearer guard (ADR-092), so a
 * stored PDF can no longer be a plain `<a href>` (a bare GET sends no token and
 * 401s). This hook drives the authenticated path for an attachment control:
 *
 *   1. fetch the bytes through a client fetcher (which uses `authedFetch`),
 *   2. wrap them in a short-lived `URL.createObjectURL` object URL,
 *   3. open that URL in a new tab, then
 *   4. revoke the object URL so the sensitive PII bytes (ADR-073/081) never
 *      linger as a shareable, persistent link.
 *
 * It exposes a calm loading flag (disable/spinner the trigger while fetching) and
 * a calm error message (ADR-037) — never throwing into render, never logging the
 * bytes or the URL. The opened tab is reused for the revoke so the browser still
 * renders the PDF before the URL is released.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** Fetch the document bytes as a Blob (typically a `*Client` authed fetcher). */
export type DocumentFetcher = () => Promise<Blob>

export interface UseDocumentOpenerResult {
  /** Fetch + open the document in a new tab. Safe to call from a click handler. */
  open: () => void
  /** True while the authed fetch is in flight (drive a spinner / disabled state). */
  loading: boolean
  /** A calm, user-facing error message when the fetch failed; else null. */
  error: string | null
  /** Clear the current error (e.g. on retry or dismiss). */
  clearError: () => void
}

/** Generic fallback copy when a fetcher does not supply its own message. */
const GENERIC_ERROR = "Couldn't open the document. Please try again."

/**
 * How long to keep the object URL alive after opening before revoking it. The
 * new tab needs the URL only until it has fetched the blob; a few seconds is
 * ample, after which we release it so the sensitive PDF bytes (ADR-073/081) stop
 * being reachable through a lingering, shareable link.
 */
const REVOKE_DELAY_MS = 10_000

/**
 * Drive an accessible "open this PDF" control against an authed blob fetcher.
 *
 * @param fetchBlob Returns the document bytes as a Blob (authenticated).
 * @returns The trigger handler plus calm loading/error state for the control.
 */
export function useDocumentOpener(
  fetchBlob: DocumentFetcher,
): UseDocumentOpenerResult {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Guards against state updates after unmount (the fetch may outlive the row).
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const clearError = useCallback(() => setError(null), [])

  const open = useCallback(() => {
    setError(null)
    setLoading(true)
    void (async () => {
      let objectUrl: string | null = null
      try {
        const blob = await fetchBlob()
        objectUrl = URL.createObjectURL(blob)
        // Open in a new tab (the product default for viewing a PDF). If the
        // browser blocks the popup, `opened` is null and we fall through to the
        // calm error rather than silently doing nothing.
        const opened = window.open(objectUrl, '_blank', 'noopener,noreferrer')
        if (!opened) {
          setError('Allow pop-ups for this site to open the PDF, then try again.')
        }
      } catch (cause) {
        // Never log the bytes or the URL (sensitive PII — ADR-073/081); surface a
        // calm, friendly message only (ADR-037).
        setError(cause instanceof Error && cause.message ? cause.message : GENERIC_ERROR)
      } finally {
        // Revoke after a tick so the just-opened tab can load the PDF first; the
        // short-lived URL then stops being a shareable, persistent link.
        if (objectUrl) {
          const toRevoke = objectUrl
          window.setTimeout(() => URL.revokeObjectURL(toRevoke), REVOKE_DELAY_MS)
        }
        if (mountedRef.current) setLoading(false)
      }
    })()
  }, [fetchBlob])

  return { open, loading, error, clearError }
}
