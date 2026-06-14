/**
 * dolarapi.com FX adapter — suggested MEP + official rates for USD transactions
 * (ADR-044).
 *
 * The Add/Edit form fetches SUGGESTED rates from the public, CORS-friendly
 * dolarapi.com endpoints (no API key) and the user picks the source — MEP,
 * Official, or Manual — and confirms or overrides the value (ADR-045). This
 * module is the single boundary to that external dependency; it never throws to
 * the UI. On any failure (network error, non-2xx, timeout, or unexpected shape)
 * the affected rate resolves to `null` so the form can fall back to a required
 * MANUAL entry — it must never silently apply a guessed rate.
 *
 * The `venta` (sell) side is returned as the suggested rate for each source,
 * matching how a USD-buyer experiences the dollar.
 */

/** Base URLs of dolarapi.com (read-only public GET; no key). */
const DOLARAPI_MEP_URL = 'https://dolarapi.com/v1/dolares/bolsa'
const DOLARAPI_OFFICIAL_URL = 'https://dolarapi.com/v1/dolares/oficial'

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
 * Both suggested rates (ARS per USD). Each is independently `null` when its
 * endpoint failed — one bad endpoint must never null the other.
 */
export interface SuggestedRates {
  /** Suggested MEP/Bolsa rate, or `null` on failure. */
  mep: number | null
  /** Suggested official rate, or `null` on failure. */
  official: number | null
}

/**
 * Fetch a single dolarapi quote endpoint and return its `venta` (sell) value
 * when present and positive; returns `null` on any failure or unexpected
 * response so the caller can prompt for manual entry. Never throws — all errors
 * are swallowed into a `null` result (ADR-037: calm unavailable UX). An
 * `AbortSignal` can be supplied so a component can cancel an in-flight
 * suggestion on unmount; an internal timeout also guards against hangs.
 */
async function fetchVentaRate(
  url: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  // If the caller aborts, propagate to our controller so the fetch is cancelled.
  const onCallerAbort = () => controller.abort()
  signal?.addEventListener('abort', onCallerAbort)

  try {
    const response = await fetch(url, {
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

/**
 * Fetch the suggested MEP rate (ARS per USD) from dolarapi.com. Returns `null`
 * on any failure or unexpected response. Never throws.
 */
export function fetchSuggestedMepRate(
  signal?: AbortSignal,
): Promise<number | null> {
  return fetchVentaRate(DOLARAPI_MEP_URL, signal)
}

/**
 * Fetch the suggested official rate (ARS per USD) from dolarapi.com. Returns
 * `null` on any failure or unexpected response. Never throws.
 */
export function fetchSuggestedOfficialRate(
  signal?: AbortSignal,
): Promise<number | null> {
  return fetchVentaRate(DOLARAPI_OFFICIAL_URL, signal)
}

/**
 * Fetch BOTH suggested rates in parallel (ADR-044 update). Each endpoint is
 * fetched and null-guarded independently, so a failure of one (e.g. official is
 * down) does not null the other (MEP still arrives). Never throws — failures
 * surface as `null` for the affected source so the form can require a manual
 * value for that choice.
 */
export async function fetchSuggestedRates(
  signal?: AbortSignal,
): Promise<SuggestedRates> {
  const [mep, official] = await Promise.all([
    fetchSuggestedMepRate(signal),
    fetchSuggestedOfficialRate(signal),
  ])
  return { mep, official }
}
