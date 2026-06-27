/**
 * i18n resources + namespace registry (ADR-101).
 *
 * Single source of truth for the supported locales, the per-feature namespace
 * list (mirroring `src/features/*` per ADR-016), and the statically-imported
 * JSON catalogs. Both the runtime bootstrap (`./index.ts`) and the Vitest setup
 * (`src/test/setup.ts`) consume this so the app and the test environment stay in
 * lockstep — the test setup can register the exact same English resources and
 * initialize synchronously (ADR-105).
 *
 * Static JSON imports (vs. lazy `i18next-http-backend`) keep the suite
 * synchronous and the bundle deterministic; the catalogs are small and tree of
 * labels, not heavy content.
 */

// English catalogs.
import enCommon from './locales/en/common.json'
import enShell from './locales/en/shell.json'
import enAccount from './locales/en/account.json'
import enAccounts from './locales/en/accounts.json'
import enAuth from './locales/en/auth.json'
import enHome from './locales/en/home.json'
import enInsights from './locales/en/insights.json'
import enTransactions from './locales/en/transactions.json'
import enStatements from './locales/en/statements.json'
import enMonotributo from './locales/en/monotributo.json'
import enSettings from './locales/en/settings.json'

// Spanish catalogs.
import esCommon from './locales/es/common.json'
import esShell from './locales/es/shell.json'
import esAccount from './locales/es/account.json'
import esAccounts from './locales/es/accounts.json'
import esAuth from './locales/es/auth.json'
import esHome from './locales/es/home.json'
import esInsights from './locales/es/insights.json'
import esTransactions from './locales/es/transactions.json'
import esStatements from './locales/es/statements.json'
import esMonotributo from './locales/es/monotributo.json'
import esSettings from './locales/es/settings.json'

/** Supported UI locales (ADR-100/ADR-101): English + Argentine Spanish. */
export const SUPPORTED_LANGUAGES = ['en', 'es'] as const
export type Language = (typeof SUPPORTED_LANGUAGES)[number]

/** Default / fallback locale. */
export const FALLBACK_LANGUAGE: Language = 'en'

/**
 * Per-feature namespaces, mirroring `src/features/*` plus cross-cutting
 * `common`, `shell`, and `account` (ADR-016, ADR-101). `common` is the default
 * namespace, so `t('key')` without a prefix resolves against it.
 */
export const NAMESPACES = [
  'common',
  'shell',
  'account',
  'accounts',
  'auth',
  'home',
  'insights',
  'transactions',
  'statements',
  'monotributo',
  'settings',
] as const
export type Namespace = (typeof NAMESPACES)[number]

/** Default namespace used by bare `t('key')` calls. */
export const DEFAULT_NAMESPACE: Namespace = 'common'

/**
 * The full resource map registered at init. Both locales carry every namespace
 * so they are maintained in lockstep (ADR-101). Catalogs are currently empty
 * placeholders; downstream tasks fill them in.
 */
export const resources = {
  en: {
    common: enCommon,
    shell: enShell,
    account: enAccount,
    accounts: enAccounts,
    auth: enAuth,
    home: enHome,
    insights: enInsights,
    transactions: enTransactions,
    statements: enStatements,
    monotributo: enMonotributo,
    settings: enSettings,
  },
  es: {
    common: esCommon,
    shell: esShell,
    account: esAccount,
    accounts: esAccounts,
    auth: esAuth,
    home: esHome,
    insights: esInsights,
    transactions: esTransactions,
    statements: esStatements,
    monotributo: esMonotributo,
    settings: esSettings,
  },
} as const

/** localStorage key for the persisted language choice (mirrors ColorMode). */
export const LANGUAGE_STORAGE_KEY = 'margen.language'

/**
 * The shared i18next init options for a DETECTOR-driven instance (ADR-101) —
 * the single source of truth consumed by BOTH the runtime bootstrap
 * (`./index.ts`) and the detection test (`./detection.test.ts`), so the test can
 * never pass against a stale, hand-copied config. Supply the
 * `LanguageDetector`-using `.use(...)` chain at the call site; this returns just
 * the options object (resources, supported langs, namespaces, region collapse,
 * detection order/lookup/cache, interpolation).
 *
 * `react-i18next`'s `initReactI18next` is intentionally NOT included here — only
 * the runtime app wires React; the test asserts on `resolvedLanguage` directly.
 */
export function detectionInitOptions() {
  return {
    resources,
    supportedLngs: [...SUPPORTED_LANGUAGES],
    fallbackLng: FALLBACK_LANGUAGE,
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NAMESPACE,
    // Collapse region codes (es-AR → es) so detection matches a supported base.
    load: 'languageOnly' as const,
    nonExplicitSupportedLngs: true,
    interpolation: {
      // React already escapes interpolated values.
      escapeValue: false,
    },
    detection: {
      // Stored choice wins, then the browser's navigator language (ADR-101).
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ['localStorage'],
    },
  }
}
