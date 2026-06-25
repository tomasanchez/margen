/**
 * i18n bootstrap (ADR-101).
 *
 * Initializes the singleton i18next instance for the app at module load: wires
 * `react-i18next`, registers the statically-imported per-feature namespace
 * catalogs for `en` + `es`, and configures browser-language detection with
 * localStorage persistence. Import this ONCE near the app entry (it's pulled in
 * transitively via `LanguageProvider`).
 *
 * Detection precedence (ADR-101): stored choice (localStorage `margen.language`)
 * > `navigator.language` > `'en'`. Region codes collapse to their base locale
 * (e.g. `es-AR` → `es`) via `load: 'languageOnly'`, so an Argentine browser
 * resolves to `es`. The chosen language is cached back to localStorage,
 * mirroring the ColorModeProvider persistence pattern.
 *
 * The test environment initializes its own synchronous English-pinned instance
 * (ADR-105, `src/test/setup.ts`) and does NOT import this module.
 */

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { detectionInitOptions } from './resources'

/**
 * Under Vitest the shared singleton is already initialized — synchronously and
 * pinned to English, WITHOUT a detector — by `src/test/setup.ts` (ADR-105).
 * Re-running this detector-driven `init` on that same singleton would let the
 * host machine's `navigator.language` / `localStorage` flip the whole en-pinned
 * suite to Spanish (e.g. on an Argentine dev machine). So we skip the bootstrap
 * under test and leave the deterministic en instance in place. The detector
 * itself is still exercised in isolation by `detection.test.ts` (a throwaway
 * `createInstance`). At runtime (`MODE !== 'test'`) this initializes normally.
 */
if (import.meta.env.MODE !== 'test') {
  void i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    // Shared detector init options (ADR-101) — the same factory the detection
    // test consumes, so the runtime config and the test can't drift apart.
    .init(detectionInitOptions())
}

export { default } from 'i18next'
