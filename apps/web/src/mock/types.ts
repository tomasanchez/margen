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

/**
 * Spending/earning categories shown in filters and the Add form.
 *
 * `Housing` + `Education` are the MVP budget-category delta (ADR-140). `Rent` is
 * RETAINED as a tolerant alias for historical rows (do NOT remove); the picker
 * prefers `Housing`. `Social` is a discretionary "Wants" category (group
 * meals/outings); it groups under Wants via the backend `isEssential=false`
 * flag. The remaining Phase-2 additions (Utilities/DebtService/FamilySupport)
 * are intentionally NOT here yet.
 */
export type Category =
  | 'Income'
  | 'Food'
  | 'Housing'
  | 'Rent'
  | 'Transport'
  | 'Subscriptions'
  | 'Health'
  | 'Education'
  | 'Shopping'
  | 'Entertainment'
  | 'Services'
  | 'Social'
  | 'Taxes'
  | 'Fees'
  | 'Other'

/**
 * Normalized bank / payment-method name a transaction is attributed to (ADR-117).
 *
 * This is the FILTERABLE identity: one bank value catches every transaction for
 * that bank regardless of which card was used. The card-level detail (e.g. the
 * network + last4) lives separately in {@link Transaction.card} for display only.
 * The backend normalizes `bank` to exactly one of these six; unknown legacy
 * strings are still tolerated by the client adapter (`asBank`).
 */
export type Bank =
  | 'Galicia'
  | 'Santander'
  | 'Mercado Pago'
  | 'Brubank'
  | 'Deel'
  | 'Transfer'

/**
 * The kind of financial provider an institution represents (ADR-134). `bank` is
 * a bank, `cash` is physical/uncarded money, `card` is a card-only provider, and
 * `wallet` covers payment platforms (Deel, Payoneer, Mercado Pago) that are
 * neither banks nor cards. Drives the institution's icon + label; not used for
 * net-worth math (every liquid type counts). Lives on {@link Institution} now —
 * the old flat `Account.type` (ADR-122) was moved up a level by ADR-134.
 */
export type AccountType = 'bank' | 'cash' | 'card' | 'wallet'

/**
 * A first-class financial provider (ADR-134). One row per provider per user; it
 * carries the human-readable `name` and the `type`. An institution owns one or
 * more per-currency {@link Account} leaves (e.g. Galicia with an ARS account and
 * a USD account); the institution row is the label those sub-accounts share.
 */
export interface Institution {
  /** Stable UUID identity issued by the backend (ADR-130/134). */
  id: string
  /** User-facing provider name, e.g. "Galicia" or "Deel". */
  name: string
  /** Provider kind (ADR-134): bank / cash / card / wallet. */
  type: AccountType
}

/** Input the Add-institution flow produces for a create/update (ADR-134). */
export interface InstitutionWriteBody {
  name: string
  type: AccountType
}

/**
 * A per-currency money account leaf under an {@link Institution} (ADR-134).
 *
 * Each account holds a single native `currency` (ARS or USD): a USD account
 * stores and reports balances in USD, and net worth aggregates across currencies
 * via the MEP rate (ADR-123/133). The `name` + `type` live on the institution;
 * responses denormalize `institutionName` + `type` onto the account for display
 * so the UI never needs a second lookup. Money crosses the API boundary as a
 * Decimal string (ADR-025/034), so `openingBalance` is a string here and is
 * parsed to a number only at the display edge.
 */
export interface Account {
  /** Stable UUID identity issued by the backend (ADR-130/134). */
  id: string
  /** The owning institution's id (ADR-134). */
  institutionId: string
  /** The owning institution's name, denormalized into the response for display. */
  institutionName: string
  /** The owning institution's type, denormalized into the response for display. */
  type: AccountType
  /** Native currency the account holds (ADR-123/134): ARS or USD. */
  currency: Currency
  /**
   * Opening balance as a Decimal string (ADR-025/034), e.g. "150000.00". The
   * running balance is opening + transaction deltas; the backend computes it for
   * the net-worth read (ADR-122). Kept as a string end-to-end on the form.
   */
  openingBalance: string
}

/** Months present in the mock dataset, newest-first ordering handled elsewhere. */
export type MonthName =
  | 'January'
  | 'February'
  | 'March'
  | 'April'
  | 'May'
  | 'June'
  | 'July'
  | 'August'
  | 'September'
  | 'October'
  | 'November'
  | 'December'

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
  /**
   * Optional card-level detail for display (ADR-117), e.g. "AMEX ·1234",
   * "VISA ·5771", "Visa", "Mastercard". Set on import (statement parser); manual
   * entries leave it undefined. NOT filterable — the filterable identity is
   * {@link Transaction.bank}. Rendered as `bank · card` when present.
   */
  card?: string
  /**
   * The account this transaction is attributed to (ADR-122/133), or `null` when
   * unlinked (manual rows with no account; nullable per ADR-133). The account
   * SUPERSEDES the bank tag for attribution, but the bank/card detail (ADR-117)
   * is kept for display. Absent on legacy rows the adapter never saw an id for.
   */
  accountId?: string | null
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
  /**
   * Provenance of the per-transaction FX snapshot (ADR-148), e.g. `'bolsa'`,
   * `'oficial'`, `'manual'`, or `'backfill'`. Present once a snapshot has been
   * captured (on create, import rate-fill, or backfill); absent on rows still
   * pending a snapshot — those are excluded from USD spend with a calm note
   * (ADR-152). Distinct from {@link Transaction.fxRateType} (the ADR-044 family).
   */
  fxSource?: string
  /**
   * The captured per-transaction FX snapshot rate (ARS per 1 USD) as a Decimal
   * STRING (ADR-148). Present once a snapshot exists; carried through so the
   * Add/Edit form can SHOW and re-seed the stored rate on edit. Distinct from the
   * USD-row {@link Transaction.rate} (a number for the USD→ARS conversion).
   */
  fxRate?: string
  /**
   * Optional free-text note carried from the backend contract (ADR-088, mirrors
   * `name`). Seeded back into the Add/Edit form on edit so it survives a re-save.
   */
  notes?: string
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
  /**
   * Optional legacy bank tag (ADR-117). No longer set by the Add/Edit form
   * (ADR-136 extension — attribution is the `accountId` below); kept optional so
   * non-form create paths (e.g. statement import) may still carry it. Omitted by
   * manual entries; the client sends it only when present.
   */
  bank?: Bank
  /**
   * Optional card-level display detail (ADR-117), e.g. "VISA ·5771". Import-set,
   * not user-editable; carried through an edit's prefill + save so editing an
   * imported row never drops its card. Omitted for manual entries.
   */
  card?: string
  /**
   * The account this transaction is attributed to (ADR-122/133), or `null`/absent
   * when unlinked. Set by the account selector; supersedes the bank tag for
   * attribution while the bank/card detail (ADR-117) is kept for display. The
   * create/patch client sends it as `accountId`; ownership is enforced server-side
   * (a user may only link their own account, ADR-130).
   */
  accountId?: string | null
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
  /**
   * Per-transaction FX snapshot rate as a Decimal STRING (ARS per 1 USD,
   * ADR-148/149). Supplied by the CLIENT on create so the backend materializes
   * `usd_amount = amount ÷ fxRate`. Captured from the day's preferred-source rate
   * (ADR-151); omitted for ARS rows with no USD involvement.
   */
  fxRate?: string
  /**
   * Provenance of {@link NewTransactionInput.fxRate} (ADR-148), e.g. `'bolsa'`,
   * `'oficial'`, `'manual'`, or `'backfill'`. Sent alongside `fxRate` so the
   * snapshot records which source was used.
   */
  fxSource?: string
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
 * An account-to-account transfer (ADR-135). A transfer moves money between two
 * of the user's own accounts; it is NOT income or expense and never touches the
 * income/expense or Monotributo readers — only the net-worth/balance union.
 *
 * `amountOut` is debited from `fromAccountId` in that account's currency;
 * `amountIn` is credited to `toAccountId` in ITS currency. For a same-currency
 * transfer they are equal (truly net-zero); for a cross-currency transfer the
 * user enters the actual amount received (the FX rate is implied, not fetched).
 * Money crosses the API boundary as a Decimal string (ADR-025/034). Any transfer
 * fees are recorded as separate `kind=expense`, category `"Fees"` transactions
 * (created atomically server-side) and are NOT part of this aggregate.
 */
export interface Transfer {
  /** Stable UUID identity issued by the backend (ADR-130/135). */
  id: string
  /** Source account the money is debited from. */
  fromAccountId: string
  /** Destination account the money is credited to. */
  toAccountId: string
  /** Amount debited from the source, in the source account's currency (Decimal string). */
  amountOut: string
  /** Amount credited to the destination, in the destination account's currency (Decimal string). */
  amountIn: string
  /** Date the transfer occurred (`YYYY-MM-DD`). */
  occurredOn: string
  /** Optional free-text note. */
  note?: string
}

/**
 * One fee line attached to a transfer-create (ADR-135). Each fee becomes a
 * `kind=expense`, category `"Fees"` transaction on `accountId`, recorded in that
 * account's currency. `amount` is a positive Decimal string; `label` is the
 * transaction's display name (e.g. "Deel transfer fee").
 */
export interface TransferFeeInput {
  /** Account the fee is charged to (a fee = an expense on this account). */
  accountId: string
  /** Fee amount as a positive Decimal string, in the account's currency. */
  amount: string
  /** Human-readable label, stored as the fee transaction's name. */
  label: string
}

/**
 * Input the New-transfer form produces (ADR-135). Mirrors the `POST /transfers`
 * body: the two accounts, the out/in amounts as Decimal strings, the date, an
 * optional note, and zero or more {@link TransferFeeInput} fee lines.
 */
export interface NewTransferInput {
  fromAccountId: string
  toAccountId: string
  amountOut: string
  amountIn: string
  occurredOn: string
  note?: string
  fees?: TransferFeeInput[]
}

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

