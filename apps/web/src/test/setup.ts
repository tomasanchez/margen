/**
 * Vitest global setup (ADR-008).
 *
 * Registers jest-dom's custom matchers (e.g. toBeInTheDocument) and cleans up
 * the rendered DOM between tests so the lightweight frontend suite stays
 * isolated and order-independent.
 */
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import {
  DEFAULT_NAMESPACE,
  NAMESPACES,
  SUPPORTED_LANGUAGES,
  resources,
} from '../i18n/resources'

/**
 * Initialize i18n SYNCHRONOUSLY, pinned to English (ADR-105).
 *
 * Existing tests assert on visible English text; pinning `lng: 'en'` keeps
 * those queries green while catalogs are still empty/placeholder. Resources are
 * registered inline (no async backend) and `react.useSuspense` is disabled, so
 * `useTranslation` returns synchronously and no test hits async loading. We do
 * NOT wire the browser-language detector here — the locale is deterministic.
 * Detection/switch behavior is covered by dedicated tests that drive
 * `changeLanguage` / a custom instance.
 *
 * HOST-LOCALE LEAK GUARD: tests import `LanguageProvider` → `src/i18n/index.ts`,
 * whose detector-driven `init` runs on this same shared singleton. On a host
 * with a Spanish `navigator.language` or a stored `margen.language=es`, that
 * could flip the whole suite to Spanish. We seed a neutral, empty environment
 * here (clear any stored choice, stub `navigator.language` to English) AND
 * `src/i18n/index.ts` skips its bootstrap under `MODE === 'test'`, so the
 * deterministic en instance below always wins regardless of the dev machine.
 */
if (typeof window !== 'undefined') {
  window.localStorage.removeItem('margen.language')
}
Object.defineProperty(navigator, 'language', {
  configurable: true,
  value: 'en-US',
})

void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: [...SUPPORTED_LANGUAGES],
  ns: [...NAMESPACES],
  defaultNS: DEFAULT_NAMESPACE,
  resources,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
})

afterEach(() => {
  cleanup()
})
