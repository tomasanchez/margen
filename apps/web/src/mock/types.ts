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
  id: number
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
  /**
   * Optional month override; when omitted the mock API defaults to the current
   * prototype month (June).
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
