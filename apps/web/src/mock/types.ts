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

/**
 * Source of a USD transaction's FX rate (ADR-044). `MEP` is the suggested
 * dolarapi.com MEP/Bolsa rate the user confirmed unchanged; `manual` is a value
 * the user entered or edited. `official` / `configured_default` are backend
 * stubs for future use (issue #10) — the UI currently only produces MEP/manual.
 */
export type FxRateType = 'MEP' | 'manual' | 'official' | 'configured_default'

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
  | 'Entertainment'
  | 'Services'
  | 'Taxes'
  | 'Fee'
  | 'Other'

/** Banks / cards a transaction can be attributed to. */
export type Bank =
  | 'Galicia · Visa'
  | 'Santander · Mastercard'
  | 'Mercado Pago'
  | 'Brubank'
  | 'Deel'
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
  /**
   * Source of the FX `rate`, present only for USD rows (ADR-044). Drives the
   * row's source indicator ("MEP" vs "manual"); see {@link FxRateType}.
   */
  fxRateType?: FxRateType
  /**
   * ISO datetime the FX rate was captured / applies as-of, present only for USD
   * rows (ADR-044). Defaults to the transaction's own date.
   */
  fxRateAsOf?: string
  recurring?: boolean
}

/** Input accepted by the add-transaction mutation (id + month derived by the API). */
export interface NewTransactionInput {
  /**
   * ISO calendar date (`YYYY-MM-DD`) the transaction occurred on, set by the
   * form's date picker (ADR-041). This is the source of truth sent to the
   * backend as `occurredOn` (no future dates; backdating allowed). `dispDate`
   * remains a derived display label.
   */
  occurredOn: string
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
  /**
   * Source of the FX `rate` for USD entries (ADR-044): `MEP` when the suggested
   * dolarapi.com rate was confirmed unchanged, `manual` when entered/edited.
   * Sent to the backend's create/patch contract; omitted for ARS entries.
   */
  fxRateType?: FxRateType
  /**
   * ISO datetime the FX rate applies as-of (ADR-044). Defaults to the
   * transaction's date; sent for USD entries, omitted for ARS.
   */
  fxRateAsOf?: string
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
  /**
   * Optional imported-invoice PDF attachment (ADR-070/072). Present only when the
   * transaction is created from an uploaded ARCA invoice; the create client sends
   * it as the backend's `document` object so the PDF is stored and linked. Typed
   * loosely here (the shape lives in `api/invoicesClient`) to keep this mock
   * module dependency-free.
   */
  document?: {
    pdfBase64: string
    contentType: string
    emisorCuit?: string
    ptoVta?: string
    tipoCmp?: string
    nroCmp?: string
    fecha?: string
    importe?: number
    moneda?: string
    ctz?: number
  }
}

/** Partial patch accepted by the update mutation. Id and identity stay fixed. */
export type TransactionPatch = Partial<Omit<Transaction, 'id'>>

/**
 * Status band used by the Monotributo meter and status pills.
 *
 * The backend's Monotributo read endpoint (ADR-046) returns four bands keyed by
 * percentage of the category ceiling: `safe` (<70%), `watch` (70–90%), `close`
 * (90–100%), and `over` (>100%). The Home month-status surfaces (StatusHero /
 * MetricCards) only ever map the dashboard's own derived standing onto the
 * legacy three (`safe` / `watch` / `risk`); the two Monotributo-only bands
 * (`close` / `over`) flow through {@link StatusPill} with their own calm copy.
 */
export type StatusLevel = 'safe' | 'watch' | 'close' | 'over' | 'risk'

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
  /** ARS invoiced in the evaluated trailing-12-month period. */
  invoicedToDate: number
  /** Label for the evaluated period, derived from the standing dates, e.g. "Jun 2025 – Jun 2026". */
  periodLabel: string
  /** Approximate monthly average (ARS). */
  monthlyAverage: number
  /** Projected trailing-12-month total (ARS) at the current pace. */
  projectedAnnual: number
  /** Short label for the projected annual total, e.g. "≈ ARS 24,3M". */
  projectedAnnualLabel: string
  /** The current AFIP category letter, e.g. "A". */
  currentCategory: string
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
  /** Authoritative ARCA (ex-AFIP) scale URL. */
  arcaUrl: string
}

/**
 * A single trailing-12-month Monotributo standing (ADR-046, ADR-052).
 *
 * Returned for both the live `current` period and the prior `previous` window
 * by `GET /api/v1/monotributo`. Money fields are already parsed to numbers in
 * the client adapter; `status` carries one of the four bands; `ratio` is the
 * convenience `percentUsed / 100` in [0, 1] the meters consume.
 */
export interface MonotributoStanding {
  /** Current AFIP category letter, e.g. "C". */
  category: string
  /** Activity type — `services` for MVP (ADR-046). */
  activityType: string
  /** ARS annual ceiling for the category. */
  annualLimit: number
  /** ARS invoiced over the trailing 12-month window. */
  used: number
  /** Remaining ARS before the ceiling (`annualLimit − used`). */
  remaining: number
  /** Percentage of the ceiling used, 0–100+. */
  percentUsed: number
  /** Convenience ratio in [0, 1] (`percentUsed / 100`) for the meters. */
  ratio: number
  /** Status band for non-color status cues (ADR-046). */
  status: StatusLevel
  /** Projected category letter at the current pace, e.g. "D". */
  projectedCategory: string
  /** Explicit estimate note (e.g. "Estimate, assumes steady pace"). */
  projectionNote: string
  /** ISO date the trailing window starts (`YYYY-MM-DD`). */
  periodStart: string
  /** ISO date the trailing window ends (`YYYY-MM-DD`). */
  periodEnd: string
}

/** A signed delta between the current and previous standing for one field. */
export interface MonotributoNumericDelta {
  /** Current-period value. */
  current: number
  /** Previous-period value. */
  previous: number
  /** `current − previous`. */
  diff: number
}

/**
 * Period-over-period deltas surfaced by the "Compare to previous period" toggle
 * (ADR-052). Derived from `current` vs `previous`; only present when a prior
 * trailing-12-month snapshot exists.
 */
export interface MonotributoComparison {
  used: MonotributoNumericDelta
  percentUsed: MonotributoNumericDelta
  /** Category letters; `changed` is true when they differ. */
  category: { current: string; previous: string; changed: boolean }
  /** Status bands; `changed` is true when they differ. */
  status: {
    current: StatusLevel
    previous: StatusLevel
    changed: boolean
  }
}

/**
 * The full Monotributo snapshot the page consumes (ADR-049, ADR-052).
 *
 * One query owns it; the page derives the meter standing, scale, invoices, and
 * projection from it. `previous` is null when no prior trailing-12-month period
 * exists yet (calm empty state for the comparison toggle).
 */
export interface MonotributoSnapshot {
  current: MonotributoStanding
  previous: MonotributoStanding | null
  scale: MonotributoScaleRow[]
  invoices: MonotributoInvoice[]
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

