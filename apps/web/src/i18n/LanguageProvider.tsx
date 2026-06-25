/**
 * Language provider (ADR-101).
 *
 * Mirrors the ColorModeProvider pattern: reflects the language i18next resolved
 * on first load (stored choice > navigator > 'en'), exposes `setLanguage` to
 * switch + persist, and keeps React state in sync with any external
 * `changeLanguage` call via the `languageChanged` event.
 *
 * The detector's `caches: ['localStorage']` already persists the choice to
 * `margen.language`; we also write it explicitly for parity with the
 * ColorModeProvider and so the value is present even before the next detection
 * pass.
 *
 * Importing this module also bootstraps the i18n singleton (`./index`), so
 * mounting the provider is all the app needs.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import i18n from 'i18next'
import './index'
import { LanguageContext } from './languageContext'
import {
  FALLBACK_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
  type Language,
} from './resources'

/** Collapse any resolved language (e.g. `es-AR`) to a supported base locale. */
function toSupported(lng: string | undefined): Language {
  const base = (lng ?? '').split('-')[0]
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(base)
    ? (base as Language)
    : FALLBACK_LANGUAGE
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() =>
    toSupported(i18n.resolvedLanguage ?? i18n.language),
  )

  // Keep React state in sync with i18next, including external changeLanguage
  // calls. i18next emits `languageChanged` after a switch resolves. The initial
  // state already reflects the language resolved at module load, so we only
  // subscribe here (no synchronous reconcile that would cascade renders).
  useEffect(() => {
    const onChanged = (lng: string) => setLanguageState(toSupported(lng))
    i18n.on('languageChanged', onChanged)
    return () => {
      i18n.off('languageChanged', onChanged)
    }
  }, [])

  const setLanguage = useCallback((next: Language) => {
    // Explicit persistence for parity with ColorModeProvider; the detector
    // cache also writes this key.
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next)
    }
    void i18n.changeLanguage(next)
  }, [])

  const value = useMemo(
    () => ({ language, setLanguage, supported: SUPPORTED_LANGUAGES }),
    [language, setLanguage],
  )

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  )
}
