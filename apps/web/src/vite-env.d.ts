/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Margen backend API (ADR-006/ADR-007). */
  readonly VITE_API_BASE_URL: string
  /** Supabase project URL (ADR-093). */
  readonly VITE_SUPABASE_URL: string
  /** Supabase anon/publishable key — browser-safe (ADR-093). */
  readonly VITE_SUPABASE_ANON_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
