/**
 * Seed data for the Margen prototype, ported from the concept scripts
 * (Margen Transactions.dc.html and Margen Home.dc.html).
 *
 * IN-MEMORY ONLY (ADR-015): these are the initial values the mock API copies on
 * load. They are never persisted; reloading the app resets to exactly this.
 *
 * Money convention (see types.ts): `amountNum` is the ARS-equivalent magnitude;
 * USD rows additionally carry `usd` + `rate`.
 */

import type {
  Bank,
  Category,
  Insight,
  MonotributoInvoice,
  MonotributoProjection,
  MonotributoScaleRow,
  MonotributoState,
} from './types'

/** All categories, in the order shown in filters and the Add form. */
export const CATEGORIES: readonly Category[] = [
  'Income',
  'Food',
  'Rent',
  'Transport',
  'Subscriptions',
  'Health',
  'Shopping',
  'Services',
  'Taxes',
  'Other',
] as const

/** All banks / cards, in display order. */
export const BANKS: readonly Bank[] = [
  'Galicia · Visa',
  'Santander · Mastercard',
  'Mercado Pago',
  'Brubank',
  'Transfer',
] as const

/**
 * Monotributo standing (ADR-020: hardcoded from the AFIP scale).
 * Category C, ARS 12.713.696 used of 21.113.697 annual limit (60%),
 * projected Category D, ARS 8.400.000 margin.
 */
export const SEED_MONOTRIBUTO: MonotributoState = {
  category: 'C',
  used: 12_713_696,
  annualLimit: 21_113_697,
  usedRatio: 0.6,
  margin: 8_400_000,
  projectedCategory: 'D',
  projectedPaceLabel: '≈ ARS 24,3M / yr at this pace',
  status: 'watch',
}

/**
 * The official AFIP/ARCA Monotributo 2026 scale, categories A–K (ADR-020,
 * ADR-023). Annual gross-income ceiling + monthly fees (services / goods),
 * all in ARS. Hardcoded reference data; the page links to ARCA for the source
 * of truth and this must be refreshed when AFIP revises the scale.
 */
export const SEED_MONOTRIBUTO_SCALE: readonly MonotributoScaleRow[] = [
  { letter: 'A', annualCeiling: 10_277_988, cuotaServicios: 42_387, cuotaBienes: 42_387 },
  { letter: 'B', annualCeiling: 15_058_448, cuotaServicios: 48_251, cuotaBienes: 48_251 },
  { letter: 'C', annualCeiling: 21_113_697, cuotaServicios: 56_502, cuotaBienes: 55_227 },
  { letter: 'D', annualCeiling: 26_212_853, cuotaServicios: 72_414, cuotaBienes: 70_661 },
  { letter: 'E', annualCeiling: 30_833_964, cuotaServicios: 102_538, cuotaBienes: 92_658 },
  { letter: 'F', annualCeiling: 38_642_048, cuotaServicios: 129_045, cuotaBienes: 111_198 },
  { letter: 'G', annualCeiling: 46_211_109, cuotaServicios: 197_108, cuotaBienes: 135_918 },
  { letter: 'H', annualCeiling: 70_113_407, cuotaServicios: 447_347, cuotaBienes: 272_063 },
  { letter: 'I', annualCeiling: 78_479_212, cuotaServicios: 824_802, cuotaBienes: 406_512 },
  { letter: 'J', annualCeiling: 89_872_640, cuotaServicios: 999_008, cuotaBienes: 497_059 },
  { letter: 'K', annualCeiling: 108_357_084, cuotaServicios: 1_381_688, cuotaBienes: 600_880 },
] as const

/** Authoritative ARCA (ex-AFIP) Monotributo categories table (ADR-023). */
export const ARCA_SCALE_URL =
  'https://www.afip.gob.ar/monotributo/categorias.asp'

/**
 * The 7 fiscal-period invoices behind the annual total (ADR-023), oldest-first,
 * Jan–Jun 2026. `cumulative` is the running ARS total counted toward the limit;
 * the final cumulative equals SEED_MONOTRIBUTO.used (ARS 12.713.696). This list
 * is intentionally separate from the (now real-backed) transactions data so the
 * Monotributo page stays self-contained until #8 ships (ADR-035).
 */
export const SEED_MONOTRIBUTO_INVOICES: readonly MonotributoInvoice[] = (() => {
  const raw: ReadonlyArray<Omit<MonotributoInvoice, 'id' | 'cumulative'>> = [
    { dispDate: 'Jan 22', client: 'Beta Studio', note: 'Setup + retainer', amountNum: 4_106_196, fx: false },
    { dispDate: 'Feb 18', client: 'Delta Corp', note: 'Consulting Q1', amountNum: 3_150_000, fx: false },
    { dispDate: 'Mar 20', client: 'Atlas Co.', note: 'USD 1.500 · MEP 1.180', amountNum: 1_770_000, fx: true },
    { dispDate: 'Apr 27', client: 'Gamma SA', note: 'Web project', amountNum: 980_000, fx: false },
    { dispDate: 'May 12', client: 'Atlas Co.', note: 'USD 500 · MEP 1.210', amountNum: 605_000, fx: true },
    { dispDate: 'May 28', client: 'Beta Studio', note: 'Retainer · May', amountNum: 1_480_000, fx: false },
    { dispDate: 'Jun 12', client: 'Atlas Co.', note: 'USD 500 · MEP 1.245', amountNum: 622_500, fx: true },
  ]
  let running = 0
  return raw.map((r, index) => {
    running += r.amountNum
    return { id: index + 1, ...r, cumulative: running }
  })
})()

/**
 * Linear pace projection for the Monotributo page (ADR-023). Illustrative only:
 * monthly average × 12 → projected annual → lands-in category D. Not a real
 * recategorization engine (issue #8 backend scope).
 */
export const SEED_MONOTRIBUTO_PROJECTION: MonotributoProjection = {
  invoicedToDate: 12_713_696,
  monthlyAverage: 2_025_000,
  projectedAnnual: 24_300_000,
  projectedAnnualLabel: '≈ ARS 24,3M',
  landsInCategory: 'D',
  landsInCeilingLabel: '26,2M',
  currentCuota: 56_502,
  projectedCuota: 72_414,
  ceilingMonth: 'October',
  marginMonths: 4,
  nextRecategorization: 'Jul – Aug 2026',
  evaluates: 'Jan–Jun',
  arcaUrl: ARCA_SCALE_URL,
}

/** Home insights list. */
export const SEED_INSIGHTS: readonly Insight[] = [
  { id: 'spending', kind: 'spending', label: 'Spending', text: 'Food is up 22% vs. May — mostly delivery & groceries.' },
  { id: 'recurring', kind: 'recurring', label: 'Recurring', text: '3 recurring expenses due this week (≈ ARS 748.200).' },
  { id: 'projection', kind: 'projection', label: 'Projection', text: 'At this pace, projected savings: USD 820 this month.' },
  { id: 'fx', kind: 'fx', label: 'FX', text: 'Latest invoice · USD 500 at MEP ARS 1.245 · Jun 12.' },
] as const

/** Hardcoded MEP rate used for new USD entries (ADR-020, non-goal of live FX). */
export const MEP_RATE = 1245
