/**
 * Domain types for the Margen mock data layer (ADR-015).
 *
 * These shapes preview the eventual backend contract (issue #3). They are
 * defined once here and consumed by the mock async API, the query hooks, and
 * the rendering components, so a future swap to a real client is localized to
 * `src/mock/*`.
 */

/** Currencies the prototype handles. ARS is the base; USD rows carry an FX rate. */
export type Currency = 'ARS' | 'USD'

/** High-level money direction used for totals and filtering. */
export type TxType = 'expense' | 'income'

/**
 * Finer-grained transaction kind. `invoice` is income that counts toward the
 * Monotributo annual limit; `income` is other inflow (e.g. a refund).
 */
export type TxKind = 'expense' | 'income' | 'invoice'

/** Spending/earning categories shown in filters and the Add form. */
export type Category =
  | 'Income'
  | 'Food'
  | 'Rent'
  | 'Transport'
  | 'Subscriptions'
  | 'Health'
  | 'Shopping'
  | 'Services'
  | 'Taxes'
  | 'Other'

/** Banks / cards a transaction can be attributed to. */
export type Bank =
  | 'Galicia · Visa'
  | 'Santander · Mastercard'
  | 'Mercado Pago'
  | 'Brubank'
  | 'Transfer'

/** Months present in the mock dataset, newest-first ordering handled elsewhere. */
export type MonthName =
  | 'January'
  | 'February'
  | 'March'
  | 'April'
  | 'May'
  | 'June'

/**
 * A single transaction.
 *
 * `amountNum` is ALWAYS the ARS-equivalent magnitude (positive number; the sign
 * is derived from {@link Transaction.type}). For USD rows, `usd` + `rate` carry
 * the original USD amount and the MEP rate used to convert it to `amountNum`.
 */
export interface Transaction {
  /** Stable UUID identity issued by the backend (ADR-034). */
  id: string
  /**
   * ISO calendar date the transaction occurred on (`YYYY-MM-DD`), carried from
   * the backend contract (ADR-024/ADR-030). Unlike the `month` label this
   * encodes the year too, so Home can filter precisely by year+month across
   * years (ADR-040). The Add/Edit form still works off `dispDate`/`month`.
   */
  occurredOn: string
  /** Short display date as seeded, e.g. "Jun 12". */
  dispDate: string
  month: MonthName
  name: string
  category: Category
  bank: Bank
  currency: Currency
  type: TxType
  kind: TxKind
  /** ARS-equivalent magnitude (always positive; sign comes from `type`). */
  amountNum: number
  /** Original USD amount, present only when `currency === 'USD'`. */
  usd?: number
  /** MEP rate used for the USD→ARS conversion, present only for USD rows. */
  rate?: number
  recurring?: boolean
}

/** Input accepted by the add-transaction mutation (id + month derived by the API). */
export interface NewTransactionInput {
  dispDate: string
  name: string
  category: Category
  bank: Bank
  currency: Currency
  type: TxType
  kind: TxKind
  amountNum: number
  usd?: number
  rate?: number
  recurring?: boolean
  /** Optional free-text note, distinct from `name` (backend contract, ADR-033). */
  notes?: string
  /**
   * Whether this income/invoice row counts toward the Monotributo annual total.
   * Income-only; the backend forces `false` for expenses (ADR-031).
   */
  countsTowardMonotributo?: boolean
  /**
   * Optional month override; when omitted the API derives the month from the
   * supplied date. Carried so an Edit can preserve the original month.
   */
  month?: MonthName
}

/** Partial patch accepted by the update mutation. Id and identity stay fixed. */
export type TransactionPatch = Partial<Omit<Transaction, 'id'>>

/** Safe / Watch / Risk status used by the Monotributo meter and status pills. */
export type StatusLevel = 'safe' | 'watch' | 'risk'

/**
 * Monotributo standing for the current period.
 *
 * Limits and category thresholds are hardcoded from the AFIP scale (ADR-020);
 * there is no real calculation engine in the prototype.
 */
export interface MonotributoState {
  /** Current AFIP category letter, e.g. "C". */
  category: string
  /** ARS invoiced so far this annual period. */
  used: number
  /** ARS annual limit for the current category. */
  annualLimit: number
  /** Convenience ratio in [0, 1] (used / annualLimit), pre-computed in the seed. */
  usedRatio: number
  /** Remaining ARS before the next category boundary. */
  margin: number
  /** Projected category letter at the current invoicing pace, e.g. "D". */
  projectedCategory: string
  /** Human label for the projected annual pace, e.g. "≈ ARS 24,3M / yr". */
  projectedPaceLabel: string
  /** Safe / Watch / Risk standing for non-color status cues (ADR-019). */
  status: StatusLevel
}

/**
 * One row of the official AFIP/ARCA Monotributo scale (ADR-020, ADR-023).
 *
 * Reference data hardcoded from the 2026 scale; amounts are numeric (ARS) and
 * formatted by the consumer via lib/format. There is no live fetch — the page
 * links to the authoritative ARCA table for the source of truth.
 */
export interface MonotributoScaleRow {
  /** Category letter, e.g. "C". */
  letter: string
  /** Annual gross-income ceiling (ARS) for the category. */
  annualCeiling: number
  /** Monthly fee for "services" activity (ARS). */
  cuotaServicios: number
  /** Monthly fee for "goods" activity (ARS). */
  cuotaBienes: number
}

/**
 * One fiscal-period invoice behind the Monotributo annual total (ADR-023).
 *
 * Oldest-first; `cumulative` is the running total counted toward the annual
 * limit up to and including this invoice. This list is separate from the shared
 * recent-transactions store so Home/Transactions data is undisturbed.
 */
export interface MonotributoInvoice {
  id: number
  /** Short display date as seeded, e.g. "Jan 22". */
  dispDate: string
  /** Client / payer name. */
  client: string
  /** Short note (e.g. "Setup + retainer" or the USD/MEP detail). */
  note: string
  /** ARS-equivalent amount counted toward the annual limit. */
  amountNum: number
  /** Running cumulative ARS total through this invoice (computed in the seed). */
  cumulative: number
  /** Whether this was a foreign-currency (USD) invoice (drives the FX badge). */
  fx: boolean
}

/**
 * Linear pace projection inputs for the Monotributo page (ADR-023).
 *
 * A simple monthly-average × 12 estimate, explicitly illustrative — not a real
 * recategorization engine (that is issue #8's backend scope).
 */
export interface MonotributoProjection {
  /** ARS invoiced in the evaluated period (Jan–Jun 2026). */
  invoicedToDate: number
  /** Approximate monthly average (ARS). */
  monthlyAverage: number
  /** Projected trailing-12-month total (ARS) at the current pace. */
  projectedAnnual: number
  /** Short label for the projected annual total, e.g. "≈ ARS 24,3M". */
  projectedAnnualLabel: string
  /** Category the projection lands in, e.g. "D". */
  landsInCategory: string
  /** Compact ceiling label for the landing category, e.g. "26,2M". */
  landsInCeilingLabel: string
  /** Current monthly fee (ARS) before any recategorization. */
  currentCuota: number
  /** Projected monthly fee (ARS) after recategorization. */
  projectedCuota: number
  /** Approx. month the ceiling is reached at this pace, e.g. "October". */
  ceilingMonth: string
  /** Approx. months of margin left at this pace. */
  marginMonths: number
  /** Window of the next recategorization, e.g. "Jul – Aug 2026". */
  nextRecategorization: string
  /** Period the recategorization evaluates, e.g. "Jan–Jun". */
  evaluates: string
  /** Authoritative ARCA (ex-AFIP) scale URL. */
  arcaUrl: string
}

/** One bar in the 6-month spending trend. `current` flags the active month. */
export interface TrendPoint {
  /** Short month label, e.g. "Jun". */
  month: string
  /** Monthly expenses in ARS. */
  value: number
  current?: boolean
}

/** One row in the "Where it went" category breakdown. */
export interface CategorySpend {
  category: Category
  /** Spend in ARS for the period. */
  amount: number
  /** Share of total spend, 0–100. */
  pct: number
  /** Optional month-over-month rise label, e.g. "+22%". */
  up?: string
}

/** Insight category, drives the dot color / icon in the insights list. */
export type InsightKind = 'spending' | 'recurring' | 'projection' | 'fx'

/** One item in the Home insights list. */
export interface Insight {
  id: string
  kind: InsightKind
  /** Eyebrow label, e.g. "Spending". */
  label: string
  text: string
}
