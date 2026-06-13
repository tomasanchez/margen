/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Margen backend API (ADR-006/ADR-007). */
  readonly VITE_API_BASE_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
