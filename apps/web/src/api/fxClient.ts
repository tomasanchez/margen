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

/**
 * The `casa` (house) path segment for each persisted rate source (ADR-151). The
 * preferred-rate-source setting is `'bolsa'` (MEP, default) or `'oficial'`; both
 * the current and the historical endpoints take the same segment, so capture,
 * backfill, and budgets all resolve to ONE source of truth.
 */
export type FxCasa = 'bolsa' | 'oficial'

/**
 * ArgentinaDatos historical per-date quote base. Path is
 * `/v1/cotizaciones/dolares/{casa}/{yyyy}/{mm}/{dd}`; the endpoint carries the
 * last published quote forward over weekends/holidays (no 404 on a non-business
 * day) and returns `{ compra, venta, fecha }` (ADR-150 — VERIFIED source).
 */
const ARGENTINADATOS_HISTORICAL_BASE =
  'https://api.argentinadatos.com/v1/cotizaciones/dolares'

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

/** Map the persisted preferred-rate-source `casa` to its CURRENT dolarapi URL. */
function currentUrlFor(casa: FxCasa): string {
  return casa === 'oficial' ? DOLARAPI_OFFICIAL_URL : DOLARAPI_MEP_URL
}

/**
 * Fetch the CURRENT preferred-source rate (ARS per USD) for the given `casa`
 * (ADR-149/151). Returns the `venta` (sell) leg — the same leg the suggested
 * rates + net-worth conversion use, so capture is consistent with display.
 * Returns `null` on any failure (never throws); the caller treats a `null` as
 * "no rate captured" rather than guessing.
 */
export function fetchCurrentRate(
  casa: FxCasa,
  signal?: AbortSignal,
): Promise<number | null> {
  return fetchVentaRate(currentUrlFor(casa), signal)
}

/**
 * Build the ArgentinaDatos historical URL for a `casa` + ISO date. The ISO date
 * (`YYYY-MM-DD`) is split into the path segments the endpoint expects
 * (`/{yyyy}/{mm}/{dd}`); only the date portion is consumed, so a full ISO
 * timestamp is tolerated.
 */
export function historicalUrlFor(casa: FxCasa, isoDate: string): string {
  const [yyyy, mm, dd] = isoDate.slice(0, 10).split('-')
  return `${ARGENTINADATOS_HISTORICAL_BASE}/${casa}/${yyyy}/${mm}/${dd}`
}

/**
 * In-memory cache of resolved historical rates, keyed by `casa|YYYY-MM-DD`. The
 * backfill (ADR-150) and import rate-fill (ADR-149) batch by unique date, so a
 * month of transactions sharing a date hits the network once. Only successful,
 * usable numeric resolutions are cached — a `null` (unavailable date) is NOT
 * cached so a later retry can still recover. Lives for the page session.
 */
const historicalCache = new Map<string, number>()

/** Cache key for a (casa, date) pair — the date is normalized to `YYYY-MM-DD`. */
function historicalCacheKey(casa: FxCasa, isoDate: string): string {
  return `${casa}|${isoDate.slice(0, 10)}`
}

/** Clear the historical-rate cache (test seam; never needed in normal use). */
export function clearHistoricalRateCache(): void {
  historicalCache.clear()
}

/**
 * Fetch the historical preferred-source rate (ARS per USD) for a `casa` on a
 * specific `isoDate` (ADR-150). Resolution order:
 *
 *  1. an in-memory cache hit for `(casa, date)` — returned without a fetch;
 *  2. the ArgentinaDatos per-date quote (`venta` leg, matching the current
 *     rate) — cached on success;
 *  3. graceful fallback to the CURRENT preferred-source rate when the date is
 *     unavailable (network failure, non-2xx, or unusable shape).
 *
 * Never throws — every failure path either falls back or resolves to `null` (no
 * current rate either), so the caller can skip a row rather than guess. The
 * fallback is NOT cached against the date so a later pass can still pick up the
 * date-accurate quote.
 */
export async function fetchHistoricalRate(
  casa: FxCasa,
  isoDate: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const key = historicalCacheKey(casa, isoDate)
  const cached = historicalCache.get(key)
  if (cached !== undefined) return cached

  const dated = await fetchVentaRate(historicalUrlFor(casa, isoDate), signal)
  if (dated != null) {
    historicalCache.set(key, dated)
    return dated
  }

  // The date was unavailable — fall back to the current preferred-source rate so
  // a snapshot can still be stamped (ADR-150). Not cached against the date.
  return fetchCurrentRate(casa, signal)
}
