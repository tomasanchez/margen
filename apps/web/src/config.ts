/**
 * Centralized runtime configuration for the Margen web app.
 *
 * The API base URL is environment-driven (ADR-007): it is read exclusively
 * from `VITE_API_BASE_URL` here and never hardcoded elsewhere in the codebase.
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

export const config = {
  /** Base URL of the Margen backend API (e.g. http://localhost:8000). */
  apiBaseUrl: apiBaseUrl ?? '',
} as const

export type AppConfig = typeof config
