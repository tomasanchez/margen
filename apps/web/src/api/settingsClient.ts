/**
 * App-settings API client + DTO boundary (ADR-054, ADR-057).
 *
 * The single boundary between the backend's `/settings` REST contract
 * (`GET /api/v1/settings`, `PATCH /api/v1/settings`, a `{ data }` envelope,
 * camelCase fields) and the frontend. The shape is already camelCase and flat,
 * so there is no field renaming to do here — this client just unwraps the
 * envelope and throws a status-carrying error on non-2xx so TanStack Query
 * treats it as a failure and the Settings page can show a calm error state
 * (ADR-037) and surface a 422 inline on a bad value.
 *
 * Mirrors {@link summariesClient} / {@link monotributoClient} (ADR-033):
 * `apiUrl()` for the versioned URL and `ensureOk` for the non-2xx guard.
 *
 * Since ADR-054, the Monotributo category lives here too — `PATCH /settings`
 * is the single write path for `monotributoCurrentCategory` (the separate
 * `PATCH /monotributo/config` endpoint was removed).
 */

import { apiUrl } from '../config'
import { authedFetch } from './http'

/** The backend `{ data: T }` response envelope (ADR-030). */
interface ResponseEnvelope<T> {
  data: T
}

/** Preferred display currency for Home cards + summaries (ADR-056). */
export type DisplayCurrency = 'ARS' | 'USD'

/** Default FX rate source used to pre-select Add/Edit USD entries (ADR-044/045). */
export type FxDefaultRateType = 'MEP' | 'official'

/** The app settings as the frontend consumes them (camelCase, flat). */
export interface Settings {
  /** Drives the Home cards + summaries currency (ADR-056). */
  preferredDisplayCurrency: DisplayCurrency
  /** Pre-selected FX source on the Add/Edit USD flow (ADR-044/045). */
  fxDefaultRateType: FxDefaultRateType
  /** Configured Monotributo category letter, `A`..`K` (ADR-046/054). */
  monotributoCurrentCategory: string
  /** Activity type; `services` in the MVP (ADR-053/059). */
  monotributoActivityType: string
}

/** Partial settings patch — every field is optional (ADR-054). */
export type SettingsPatch = Partial<Settings>

/** An API error that carries the HTTP status so callers can branch on it. */
export class SettingsApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'SettingsApiError'
    this.status = status
  }
}

/** Throw a {@link SettingsApiError} for any non-2xx response. */
async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    // Ignore body-read failures; the status is enough for the calm error state.
  }
  throw new SettingsApiError(
    response.status,
    `Settings API request failed with ${response.status}${
      detail ? `: ${detail}` : ''
    }`,
  )
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

/**
 * GET the app settings, unwrap the `{ data }` envelope. Throws
 * {@link SettingsApiError} on a non-2xx response.
 */
export async function fetchSettings(): Promise<Settings> {
  const response = await authedFetch(apiUrl('/settings'), {
    headers: { Accept: 'application/json' },
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<Settings>
  return envelope.data
}

/**
 * PATCH a partial settings update (any subset of the camelCase fields) and
 * return the full updated settings. Throws {@link SettingsApiError} on a
 * non-2xx response — notably a 422 for a bad value, which callers surface as a
 * calm inline message (ADR-057).
 */
export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const response = await authedFetch(apiUrl('/settings'), {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<Settings>
  return envelope.data
}

/** The settings API client, grouped for ergonomic import. */
export const settingsClient = {
  fetchSettings,
  updateSettings,
} as const
