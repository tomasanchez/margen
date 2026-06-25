/**
 * Browser-language detection test (ADR-101, ADR-105).
 *
 * Verifies the detection precedence the runtime bootstrap (`src/i18n/index.ts`)
 * configures: stored choice (localStorage `margen.language`) > `navigator.language`
 * > `'en'`, with region codes collapsing to their base locale (`es-AR` → `es`)
 * via `load: 'languageOnly'`.
 *
 * ISOLATION (ADR-105): the global test setup pins a singleton i18next instance
 * to English WITHOUT a detector, and the whole suite asserts on English text.
 * Importing `src/i18n/index.ts` would re-`init` that shared singleton with a
 * detector and could leave it on a non-English language, breaking other tests.
 * So instead this test builds a FRESH, throwaway instance via
 * `i18next.createInstance()` configured exactly like the bootstrap (same
 * LanguageDetector, `detection` options, `supportedLngs`, `load`,
 * `nonExplicitSupportedLngs`) and asserts on its `resolvedLanguage`. The shared
 * singleton is never touched, so the en-pinned suite is unaffected.
 *
 * `navigator.language` and `localStorage` are stubbed per case and restored in
 * `afterEach`, so the cases stay order-independent.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import i18next from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { LANGUAGE_STORAGE_KEY, detectionInitOptions } from './resources'

/**
 * Build a fresh detector-driven i18next instance mirroring `src/i18n/index.ts`,
 * fully isolated from the shared (en-pinned) singleton. `initAsync: false`
 * makes `init` resolve synchronously against the static resources so
 * `resolvedLanguage` is populated when this returns (the call is still awaited
 * for clarity).
 */
async function makeDetectingInstance() {
  const instance = i18next.createInstance()
  // Consume the SAME factory the runtime bootstrap (`./index.ts`) uses, so this
  // test can't pass against a stale hand-copied config (the whole point of the
  // shared factory). `initAsync: false` resolves init synchronously against the
  // static resources so `resolvedLanguage` is populated when this returns.
  await instance
    .use(LanguageDetector)
    .init({ ...detectionInitOptions(), initAsync: false })
  return instance
}

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('browser-language detection (isolated instance)', () => {
  test('Spanish navigator language with no stored choice resolves to es', async () => {
    // Argentine browser, region code, and an empty store: navigator wins and
    // es-AR collapses to es via load: 'languageOnly'.
    window.localStorage.clear()
    vi.stubGlobal('navigator', { language: 'es-AR', languages: ['es-AR'] })

    const instance = await makeDetectingInstance()

    expect(instance.resolvedLanguage).toBe('es')
  })

  test('a stored en choice wins over a Spanish navigator language', async () => {
    // localStorage precedes navigator in the detection order (ADR-101), so the
    // explicit stored 'en' beats the Argentine browser language.
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en')
    vi.stubGlobal('navigator', { language: 'es-AR', languages: ['es-AR'] })

    const instance = await makeDetectingInstance()

    expect(instance.resolvedLanguage).toBe('en')
  })

  test('a non-Spanish navigator language with no stored choice falls back to en', async () => {
    // French is unsupported and no choice is stored, so detection falls back to
    // the default 'en' rather than an unsupported locale.
    window.localStorage.clear()
    vi.stubGlobal('navigator', { language: 'fr-FR', languages: ['fr-FR'] })

    const instance = await makeDetectingInstance()

    expect(instance.resolvedLanguage).toBe('en')
  })

  test('the shared en-pinned singleton is untouched by the isolated instance', async () => {
    // Guard against locale leakage: building/using the throwaway instance must
    // not change the global singleton the rest of the suite relies on.
    vi.stubGlobal('navigator', { language: 'es-AR', languages: ['es-AR'] })
    await makeDetectingInstance()

    expect(i18next.language).toBe('en')
  })
})
