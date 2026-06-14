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

import type { Bank, Category, Insight } from './types'

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
 * Authoritative ARCA (ex-AFIP) Monotributo categories table (ADR-023).
 *
 * The Monotributo data itself is now real (ADR-049/052); this URL is the only
 * Monotributo constant kept here, referenced by the projection adapter
 * (`features/monotributo/derive.ts`) for the "View on ARCA" link until the
 * backend surfaces it.
 */
export const ARCA_SCALE_URL =
  'https://www.afip.gob.ar/monotributo/categorias.asp'

/** Home insights list. */
export const SEED_INSIGHTS: readonly Insight[] = [
  { id: 'spending', kind: 'spending', label: 'Spending', text: 'Food is up 22% vs. May — mostly delivery & groceries.' },
  { id: 'recurring', kind: 'recurring', label: 'Recurring', text: '3 recurring expenses due this week (≈ ARS 748.200).' },
  { id: 'projection', kind: 'projection', label: 'Projection', text: 'At this pace, projected savings: USD 820 this month.' },
  { id: 'fx', kind: 'fx', label: 'FX', text: 'Latest invoice · USD 500 at MEP ARS 1.245 · Jun 12.' },
] as const

/** Hardcoded MEP rate used for new USD entries (ADR-020, non-goal of live FX). */
export const MEP_RATE = 1245
