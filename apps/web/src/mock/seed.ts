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
  Transaction,
  TrendPoint,
  CategorySpend,
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
 * The 19-transaction concept dataset (June current, May/April historical).
 * Sorting/grouping is the consumer's responsibility; this is source order.
 */
export const SEED_TRANSACTIONS: readonly Transaction[] = [
  { id: 1, dispDate: 'Jun 12', month: 'June', name: 'Invoice · Cliente Atlas', category: 'Income', bank: 'Transfer', currency: 'USD', type: 'income', kind: 'invoice', amountNum: 622500, usd: 500, rate: 1245 },
  { id: 2, dispDate: 'Jun 11', month: 'June', name: 'Supermercado Coto', category: 'Food', bank: 'Galicia · Visa', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 38400 },
  { id: 3, dispDate: 'Jun 10', month: 'June', name: 'Netflix · Spotify', category: 'Subscriptions', bank: 'Galicia · Visa', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 14200, recurring: true },
  { id: 4, dispDate: 'Jun 09', month: 'June', name: 'Alquiler depto', category: 'Rent', bank: 'Transfer', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 720000, recurring: true },
  { id: 5, dispDate: 'Jun 08', month: 'June', name: 'Uber', category: 'Transport', bank: 'Brubank', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 6800 },
  { id: 6, dispDate: 'Jun 07', month: 'June', name: 'Refund · MercadoLibre', category: 'Income', bank: 'Mercado Pago', currency: 'ARS', type: 'income', kind: 'income', amountNum: 18500 },
  { id: 7, dispDate: 'Jun 06', month: 'June', name: 'Farmacity', category: 'Health', bank: 'Galicia · Visa', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 22300 },
  { id: 8, dispDate: 'Jun 05', month: 'June', name: 'Mercado Libre', category: 'Shopping', bank: 'Mercado Pago', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 48900 },
  { id: 9, dispDate: 'Jun 03', month: 'June', name: 'AWS', category: 'Subscriptions', bank: 'Galicia · Visa', currency: 'USD', type: 'expense', kind: 'expense', amountNum: 39616, usd: 32, rate: 1238, recurring: true },
  { id: 10, dispDate: 'May 28', month: 'May', name: 'Invoice · Beta Studio', category: 'Income', bank: 'Transfer', currency: 'ARS', type: 'income', kind: 'invoice', amountNum: 1480000 },
  { id: 11, dispDate: 'May 24', month: 'May', name: 'Carrefour', category: 'Food', bank: 'Santander · Mastercard', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 41200 },
  { id: 12, dispDate: 'May 20', month: 'May', name: 'Edenor (luz)', category: 'Services', bank: 'Galicia · Visa', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 33500, recurring: true },
  { id: 13, dispDate: 'May 15', month: 'May', name: 'YPF Nafta', category: 'Transport', bank: 'Santander · Mastercard', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 28000 },
  { id: 14, dispDate: 'May 12', month: 'May', name: 'Invoice · Cliente Atlas', category: 'Income', bank: 'Transfer', currency: 'USD', type: 'income', kind: 'invoice', amountNum: 605000, usd: 500, rate: 1210 },
  { id: 15, dispDate: 'May 09', month: 'May', name: 'Alquiler depto', category: 'Rent', bank: 'Transfer', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 700000, recurring: true },
  { id: 16, dispDate: 'May 05', month: 'May', name: 'Spotify · Netflix', category: 'Subscriptions', bank: 'Galicia · Visa', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 13900, recurring: true },
  { id: 17, dispDate: 'Apr 27', month: 'April', name: 'Invoice · Gamma SA', category: 'Income', bank: 'Transfer', currency: 'ARS', type: 'income', kind: 'invoice', amountNum: 980000 },
  { id: 18, dispDate: 'Apr 18', month: 'April', name: 'Coto', category: 'Food', bank: 'Galicia · Visa', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 37800 },
  { id: 19, dispDate: 'Apr 10', month: 'April', name: 'Alquiler depto', category: 'Rent', bank: 'Transfer', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 700000, recurring: true },
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
 * ADR-023). Annual gross-income ceiling + monthly cuotas (servicios / bienes),
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
 * is intentionally separate from SEED_TRANSACTIONS (recent months only) so the
 * already-reviewed Home/Transactions data stays untouched.
 */
export const SEED_MONOTRIBUTO_INVOICES: readonly MonotributoInvoice[] = (() => {
  const raw: ReadonlyArray<Omit<MonotributoInvoice, 'id' | 'cumulative'>> = [
    { dispDate: 'Jan 22', client: 'Beta Studio', note: 'Setup + retainer', amountNum: 4_106_196, fx: false },
    { dispDate: 'Feb 18', client: 'Delta Corp', note: 'Consultoría Q1', amountNum: 3_150_000, fx: false },
    { dispDate: 'Mar 20', client: 'Cliente Atlas', note: 'USD 1.500 · MEP 1.180', amountNum: 1_770_000, fx: true },
    { dispDate: 'Apr 27', client: 'Gamma SA', note: 'Proyecto web', amountNum: 980_000, fx: false },
    { dispDate: 'May 12', client: 'Cliente Atlas', note: 'USD 500 · MEP 1.210', amountNum: 605_000, fx: true },
    { dispDate: 'May 28', client: 'Beta Studio', note: 'Retainer · mayo', amountNum: 1_480_000, fx: false },
    { dispDate: 'Jun 12', client: 'Cliente Atlas', note: 'USD 500 · MEP 1.245', amountNum: 622_500, fx: true },
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

/** 6-month spending trend (monthly expenses, ARS). June is the current month. */
export const SEED_TREND: readonly TrendPoint[] = [
  { month: 'Jan', value: 2_450_000 },
  { month: 'Feb', value: 2_300_000 },
  { month: 'Mar', value: 2_620_000 },
  { month: 'Apr', value: 2_410_000 },
  { month: 'May', value: 2_580_000 },
  { month: 'Jun', value: 2_850_000, current: true },
] as const

/** "Where it went" category breakdown for the current month (June). */
export const SEED_CATEGORY_BREAKDOWN: readonly CategorySpend[] = [
  { category: 'Rent', amount: 720_000, pct: 25 },
  { category: 'Food', amount: 624_000, pct: 22, up: '+22%' },
  { category: 'Subscriptions', amount: 342_000, pct: 12 },
  { category: 'Transport', amount: 285_000, pct: 10 },
  { category: 'Health', amount: 228_000, pct: 8 },
  { category: 'Taxes', amount: 199_500, pct: 7 },
  { category: 'Other', amount: 451_500, pct: 16 },
] as const

/** Home insights list. */
export const SEED_INSIGHTS: readonly Insight[] = [
  { id: 'spending', kind: 'spending', label: 'Spending', text: 'Food is up 22% vs. May — mostly delivery & groceries.' },
  { id: 'recurring', kind: 'recurring', label: 'Recurring', text: '3 recurring expenses due this week (≈ ARS 748.200).' },
  { id: 'projection', kind: 'projection', label: 'Projection', text: 'At this pace, projected savings: USD 820 this month.' },
  { id: 'fx', kind: 'fx', label: 'FX', text: 'Latest invoice · USD 500 at MEP ARS 1.245 · Jun 12.' },
] as const

/** Hardcoded MEP rate used for new USD entries (ADR-020, non-goal of live FX). */
export const MEP_RATE = 1245
