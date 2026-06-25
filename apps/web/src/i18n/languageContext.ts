import { createContext, useContext } from 'react'
import type { Language } from './resources'

export interface LanguageContextValue {
  /** Current active UI language (collapsed to a supported base locale). */
  language: Language
  /** Switch to an explicit language; persists and re-renders translations. */
  setLanguage: (language: Language) => void
  /** The list of supported languages, for building a selector. */
  supported: readonly Language[]
}

/**
 * Language context (ADR-101).
 *
 * Kept in a non-component module so the provider component file stays
 * Fast-Refresh-friendly (it must only export components), mirroring
 * {@link ./theme/colorModeContext}.
 */
export const LanguageContext = createContext<LanguageContextValue | null>(null)

/** Access the active language and its setter. Must be used under the provider. */
export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext)
  if (!ctx) {
    throw new Error('useLanguage must be used within a LanguageProvider')
  }
  return ctx
}
