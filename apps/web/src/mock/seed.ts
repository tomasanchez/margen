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

import type { Bank, Category } from './types'

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

/** Hardcoded MEP rate used for new USD entries (ADR-020, non-goal of live FX). */
export const MEP_RATE = 1245
