/**
 * Centralized runtime configuration for the Margen web app.
 *
 * The API base URL is environment-driven (ADR-007): it is read exclusively
 * from `VITE_API_BASE_URL` here and never hardcoded elsewhere in the codebase.
 * Supabase credentials follow the same pattern (ADR-093): only the anon
 * (publishable) key ever reaches the frontend — never the service-role key.
 * Contributors copy `.env.example` to `.env` and fill in real values.
 */

const apiBaseUrl: string | undefined = import.meta.env.VITE_API_BASE_URL

if (!apiBaseUrl) {
  // Fail loudly in development so a missing env var is obvious rather than
  // silently producing broken requests to an empty origin.
  console.warn(
    '[margen] VITE_API_BASE_URL is not set. Copy .env.example to .env and set it.',
  )
}

const supabaseUrl: string | undefined = import.meta.env.VITE_SUPABASE_URL

if (!supabaseUrl) {
  console.warn(
    '[margen] VITE_SUPABASE_URL is not set. Copy .env.example to .env and set it.',
  )
}

const supabaseAnonKey: string | undefined = import.meta.env
  .VITE_SUPABASE_ANON_KEY

if (!supabaseAnonKey) {
  console.warn(
    '[margen] VITE_SUPABASE_ANON_KEY is not set. Copy .env.example to .env and set it.',
  )
}

export const config = {
  /** Base URL of the Margen backend API (e.g. http://localhost:8000). */
  apiBaseUrl: apiBaseUrl ?? '',
  /** Supabase project URL (e.g. https://xxxx.supabase.co). */
  supabaseUrl: supabaseUrl ?? '',
  /** Supabase anon/publishable key — safe for the browser (ADR-093). */
  supabaseAnonKey: supabaseAnonKey ?? '',
} as const

export type AppConfig = typeof config

/**
 * Build a fully-qualified API URL for a versioned path.
 *
 * Joins `config.apiBaseUrl` with the `/api/v1` prefix and the supplied path,
 * tolerating a trailing slash on the base. This is the single place the API
 * version prefix is assembled, so endpoints never hardcode it (ADR-007/ADR-033).
 *
 * @example apiUrl('/transactions') // http://localhost:8000/api/v1/transactions
 */
export function apiUrl(path: string): string {
  const base = config.apiBaseUrl.replace(/\/$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}/api/v1${suffix}`
}
