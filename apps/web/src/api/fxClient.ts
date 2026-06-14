/**
 * dolarapi.com FX adapter — suggested MEP rate for USD transactions (ADR-044).
 *
 * The Add/Edit form fetches a SUGGESTED MEP/Bolsa rate from the public,
 * CORS-friendly dolarapi.com endpoint (no API key) and the user confirms or
 * overrides it (ADR-045). This module is the single boundary to that external
 * dependency; it never throws to the UI. On any failure (network error, non-2xx,
 * timeout, or unexpected shape) it resolves to `null` so the form can fall back
 * to a required MANUAL entry — it must never silently apply a guessed rate.
 *
 * The `venta` (sell) side is returned as the suggested rate, matching how a
 * USD-buyer experiences the MEP dollar.
 */

/** Base URL of dolarapi.com (read-only public GET; no key). */
const DOLARAPI_MEP_URL = 'https://dolarapi.com/v1/dolares/bolsa'

/** Abort the fetch if dolarapi is slow so the form never hangs on the suggestion. */
const FETCH_TIMEOUT_MS = 6000

/**
 * The (partial) shape dolarapi.com returns for a single dollar quote. Only the
 * fields we consume are typed; everything else is ignored. Values arrive as
 * numbers in the JSON body.
 */
interface DolarApiQuote {
  compra?: number
  venta?: number
  fechaActualizacion?: string
  nombre?: string
  casa?: string
}

/** Narrow an unknown JSON value to {@link DolarApiQuote} (defensive). */
function isQuote(value: unknown): value is DolarApiQuote {
  return typeof value === 'object' && value !== null
}

/**
 * Fetch the suggested MEP rate (ARS per USD) from dolarapi.com.
 *
 * Returns the `venta` (sell) value when present and positive; returns `null` on
 * any failure or unexpected response so the caller can prompt for manual entry.
 * Never throws — all errors are swallowed into a `null` result (ADR-037: calm
 * unavailable UX). An `AbortSignal` can be supplied so a component can cancel an
 * in-flight suggestion on unmount; an internal timeout also guards against hangs.
 */
export async function fetchSuggestedMepRate(
  signal?: AbortSignal,
): Promise<number | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  // If the caller aborts, propagate to our controller so the fetch is cancelled.
  const onCallerAbort = () => controller.abort()
  signal?.addEventListener('abort', onCallerAbort)

  try {
    const response = await fetch(DOLARAPI_MEP_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return null

    const body: unknown = await response.json()
    if (!isQuote(body)) return null

    const rate = body.venta
    return typeof rate === 'number' && Number.isFinite(rate) && rate > 0
      ? rate
      : null
  } catch {
    // Network error, abort/timeout, or JSON parse failure → fall back to manual.
    return null
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onCallerAbort)
  }
}
