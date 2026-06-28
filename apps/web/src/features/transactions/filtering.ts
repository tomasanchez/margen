/**
 * Pure filtering / grouping / totals logic for the Transactions screen.
 *
 * Ported from the concept script (Margen Transactions.dc.html `renderVals`):
 * search matches name OR category; the type filter maps All / Expenses / Income
 * / Invoices onto `type`/`kind`; currency, month, multi-select category, and
 * multi-select account narrow the list; an amount-range bucket filters by the
 * ARS-equivalent magnitude. Rows are sorted newest-first within months ordered
 * June → May → April and grouped per month with per-group in/out sums and an
 * overall count + inflow + outflow + net.
 *
 * This module is intentionally free of React and MUI so the rules can be unit
 * tested directly and reused by both the desktop bar and the mobile sheet.
 */

import type {
  Category,
  Currency,
  MonthName,
  Transaction,
} from '../../mock/types'
import {
  ALL_MONTHS,
  LAST_12_MONTHS,
  THIS_YEAR,
  currentViewingMonth,
  isSameViewingMonth,
  parseMonthToken,
  serializeMonth,
  type MonthSelection,
  type ViewingMonth,
} from '../../components/months'
import { CATEGORIES } from '../../mock/seed'
import {
  occurredInLast12Months,
  occurredInMonth,
  occurredInYearToDate,
} from '../home/homeMetrics'

/** Type segment options (concept: All / Expenses / Income / Invoices). */
export type TypeFilter = 'all' | 'expense' | 'income' | 'invoice'

/** Currency segment options. */
export type CurrencyFilter = 'all' | Currency

/**
 * Month filter for the Transactions page (ADR-040: the ledger owns its own
 * per-screen month, independent of the global Home navigator). Either a
 * specific year+month {@link ViewingMonth} or the `'all'` ("All time")
 * sentinel. Matching is year-aware against the transaction's `occurredOn` ISO
 * date (the same approach Home uses via `occurredInMonth`), NOT the bare
 * `t.month` name — so the same calendar month in different years is never
 * conflated.
 */
export type MonthFilter = MonthSelection

/** Amount-range bucket ids (ARS-equivalent magnitude). */
export type AmountRange = 'any' | 'lt10' | '10_100' | '100_1m' | 'gt1m'

/** Newest-first month display order (concept ORDER, June current). */
export const MONTH_ORDER: readonly MonthName[] = [
  'June',
  'May',
  'April',
  'March',
  'February',
  'January',
] as const

/** Amount-range options, in menu order. */
export const AMOUNT_RANGES: readonly { id: AmountRange; label: string }[] = [
  { id: 'any', label: 'Any amount' },
  { id: 'lt10', label: 'Under ARS 10.000' },
  { id: '10_100', label: 'ARS 10.000 – 100.000' },
  { id: '100_1m', label: 'ARS 100.000 – 1.000.000' },
  { id: 'gt1m', label: 'Over ARS 1.000.000' },
] as const

/** Type segment options, in display order (label + short mobile label). */
export const TYPE_OPTIONS: readonly {
  id: TypeFilter
  label: string
  short: string
}[] = [
  { id: 'all', label: 'All', short: 'All' },
  { id: 'expense', label: 'Expenses', short: 'Out' },
  { id: 'income', label: 'Income', short: 'In' },
  { id: 'invoice', label: 'Invoices', short: 'Inv' },
] as const

/** Currency segment options, in display order. */
export const CURRENCY_OPTIONS: readonly { id: CurrencyFilter; label: string }[] =
  [
    { id: 'all', label: 'All' },
    { id: 'ARS', label: 'ARS' },
    { id: 'USD', label: 'USD' },
  ] as const

/** The full filter + search state for the Transactions screen. */
export interface TransactionFilters {
  /** Free-text query matched against name OR category (case-insensitive). */
  q: string
  type: TypeFilter
  currency: CurrencyFilter
  month: MonthFilter
  /** Selected categories; empty means "all categories". */
  categories: Category[]
  /**
   * Selected account ids (ADR-134); empty means "all accounts". Filters by
   * `t.accountId ∈ accounts`. Account ids are opaque UUIDs, so unknown ids are a
   * harmless no-op match.
   */
  accounts: string[]
  amount: AmountRange
}

/**
 * The neutral starting point — nothing filtered (month is "All time").
 *
 * NOTE: the page seeds its month to the CURRENT month on first load (the
 * defaulting lives in {@link useTransactionFilters}); this neutral default is
 * what "Clear filters" resets to, so clearing widens to all time.
 */
export const DEFAULT_FILTERS: TransactionFilters = {
  q: '',
  type: 'all',
  currency: 'all',
  month: ALL_MONTHS,
  categories: [],
  accounts: [],
  amount: 'any',
}

/** True when any filter (or the search box) is narrowing the list. */
export function hasActiveFilters(f: TransactionFilters): boolean {
  return (
    f.q.trim().length > 0 ||
    f.type !== 'all' ||
    f.currency !== 'all' ||
    f.month !== ALL_MONTHS ||
    f.categories.length > 0 ||
    f.accounts.length > 0 ||
    f.amount !== 'any'
  )
}

/**
 * Count of active filters surfaced on the mobile "Filters" button. Mirrors the
 * concept: currency + month + each category + each account + a non-default
 * amount. (Search and the type segment live outside the sheet, so they are
 * excluded.)
 */
export function activeFilterCount(f: TransactionFilters): number {
  return (
    (f.currency !== 'all' ? 1 : 0) +
    (f.month !== ALL_MONTHS ? 1 : 0) +
    f.categories.length +
    f.accounts.length +
    (f.amount !== 'any' ? 1 : 0)
  )
}

/** Whether an amount (ARS-equivalent magnitude) falls in the given range. */
function amountInRange(range: AmountRange, n: number): boolean {
  switch (range) {
    case 'any':
      return true
    case 'lt10':
      return n < 10_000
    case '10_100':
      return n >= 10_000 && n < 100_000
    case '100_1m':
      return n >= 100_000 && n < 1_000_000
    case 'gt1m':
      return n >= 1_000_000
  }
}

/**
 * True when an ISO `occurredOn` satisfies the month filter. Exhaustive over the
 * {@link MonthFilter} union: `'all'` matches everything (no scope), the two
 * range sentinels match their windows (reusing the Home date helpers so ISO
 * parsing is never duplicated), and a {@link ViewingMonth} matches that exact
 * calendar month. Pure and unit-testable; `now` is injectable for tests.
 */
export function matchesMonth(
  month: MonthFilter,
  occurredOn: string,
  now: Date = new Date(),
): boolean {
  if (month === ALL_MONTHS) return true
  if (month === LAST_12_MONTHS) return occurredInLast12Months(occurredOn, now)
  if (month === THIS_YEAR) return occurredInYearToDate(occurredOn, now)
  return occurredInMonth(occurredOn, month)
}

/** True when a transaction passes every active filter and the search query. */
function matchesFilters(t: Transaction, f: TransactionFilters): boolean {
  const q = f.q.trim().toLowerCase()
  if (
    q &&
    !(
      t.name.toLowerCase().includes(q) ||
      t.category.toLowerCase().includes(q)
    )
  ) {
    return false
  }
  // Type segment: Expenses by `type`, Income/Invoices by the finer `kind`.
  if (f.type === 'expense' && t.type !== 'expense') return false
  if (f.type === 'income' && t.kind !== 'income') return false
  if (f.type === 'invoice' && t.kind !== 'invoice') return false
  if (f.currency !== 'all' && t.currency !== f.currency) return false
  // Year-aware date match against the ISO `occurredOn` (ADR-040), reusing the
  // exact parse Home uses — never the bare `t.month` name. `'all'` is no scope;
  // the two range sentinels match a rolling/year-to-date window; otherwise it's
  // a specific year+month.
  if (!matchesMonth(f.month, t.occurredOn)) {
    return false
  }
  if (f.categories.length && !f.categories.includes(t.category)) return false
  // Account filter (ADR-134): the row must be attributed to one of the selected
  // accounts. Unlinked rows (accountId null/absent) never match a non-empty
  // selection; an empty selection means "all accounts".
  if (
    f.accounts.length &&
    !(t.accountId != null && f.accounts.includes(t.accountId))
  ) {
    return false
  }
  if (!amountInRange(f.amount, t.amountNum)) return false
  return true
}

/** Parse the day number out of a seeded "Mon DD" display date (0 if absent). */
function dayOf(t: Transaction): number {
  const parts = t.dispDate.split(' ')
  return Number.parseInt(parts[1] ?? '0', 10) || 0
}

/** A month section: header totals + the rows it contains. */
export interface TransactionGroup {
  month: MonthName
  count: number
  /** Sum of ARS-equivalent income magnitudes in the group. */
  inflow: number
  /** Sum of ARS-equivalent expense magnitudes in the group. */
  outflow: number
  items: Transaction[]
}

/** Overall + grouped result of applying a filter set to the transactions. */
export interface FilteredTransactions {
  /** Filtered rows, sorted newest-first within month order. */
  rows: Transaction[]
  /** Per-month groups, in MONTH_ORDER, omitting empty months. */
  groups: TransactionGroup[]
  filteredCount: number
  inflow: number
  outflow: number
  /** inflow − outflow (may be negative). */
  net: number
}

/**
 * Apply `filters` to `transactions`, returning the sorted/grouped rows and the
 * overall totals. Months are emitted in {@link MONTH_ORDER}; rows inside a month
 * are newest-first by day. Empty months are skipped.
 */
export function filterTransactions(
  transactions: readonly Transaction[],
  filters: TransactionFilters,
): FilteredTransactions {
  const rows = transactions
    .filter((t) => matchesFilters(t, filters))
    .slice()
    .sort(
      (a, b) =>
        MONTH_ORDER.indexOf(a.month) - MONTH_ORDER.indexOf(b.month) ||
        dayOf(b) - dayOf(a),
    )

  const groups: TransactionGroup[] = []
  for (const month of MONTH_ORDER) {
    const items = rows.filter((t) => t.month === month)
    if (items.length === 0) continue
    const inflow = items
      .filter((t) => t.type === 'income')
      .reduce((sum, t) => sum + t.amountNum, 0)
    const outflow = items
      .filter((t) => t.type === 'expense')
      .reduce((sum, t) => sum + t.amountNum, 0)
    groups.push({ month, count: items.length, inflow, outflow, items })
  }

  const inflow = rows
    .filter((t) => t.type === 'income')
    .reduce((sum, t) => sum + t.amountNum, 0)
  const outflow = rows
    .filter((t) => t.type === 'expense')
    .reduce((sum, t) => sum + t.amountNum, 0)

  return {
    rows,
    groups,
    filteredCount: rows.length,
    inflow,
    outflow,
    net: inflow - outflow,
  }
}

// --- URL <-> filter mapping (ADR-116) -------------------------------------
//
// The URL is the single source of truth for the Transactions filters. The route
// validates raw search params into a {@link TransactionsSearch}; the page derives
// the live {@link TransactionFilters} from it via {@link searchToFilters} (applying
// defaults — notably the current month when `month` is absent), and filter writes
// go back through {@link filtersToSearch} (which omits every default so the URL
// stays short and shareable). Both directions are pure and unit-testable.

/**
 * Validated `/transactions` search params (ADR-062 generalized by ADR-116).
 *
 * Param names are URL-friendly and back-compatible with the existing drilldown
 * (`category` + `type` predate this change). All are optional; an absent param
 * means "use the filter default". Encodings:
 * - `q`: free-text query (omitted when empty).
 * - `type`: one {@link TypeFilter} other than `all`.
 * - `currency`: one {@link CurrencyFilter} other than `all`.
 * - `month`: a month token — `all` / `last12` / `thisYear` / `YYYY-MM` (absent
 *   means the current month, the per-screen default per ADR-040).
 * - `category`: comma-joined {@link Category} list (drops unknown entries).
 * - `account`: comma-joined account-id list (ADR-134; drops empties, but ids are
 *   opaque UUIDs so unknown ids are kept and are a harmless no-op match).
 * - `amount`: one {@link AmountRange} other than `any`.
 */
export interface TransactionsSearch {
  q?: string
  type?: TypeFilter
  currency?: CurrencyFilter
  month?: string
  category?: string
  account?: string
  amount?: AmountRange
}

const KNOWN_TYPES = new Set<string>(TYPE_OPTIONS.map((o) => o.id))
const KNOWN_CURRENCIES = new Set<string>(CURRENCY_OPTIONS.map((o) => o.id))
const KNOWN_AMOUNTS = new Set<string>(AMOUNT_RANGES.map((o) => o.id))
const KNOWN_CATEGORIES = new Set<string>(CATEGORIES)

/**
 * Parse a comma-separated multi-select param into its validated members, in
 * order, dropping unknown entries and de-duplicating. A single unknown entry in
 * an otherwise-valid list drops only that entry (the rest survive). Returns
 * `undefined` when nothing valid remains so the param is omitted entirely.
 */
function parseCsv<T extends string>(
  raw: unknown,
  known: ReadonlySet<string>,
): T[] | undefined {
  if (typeof raw !== 'string') return undefined
  const seen = new Set<string>()
  const out: T[] = []
  for (const part of raw.split(',')) {
    const value = part.trim()
    if (value && known.has(value) && !seen.has(value)) {
      seen.add(value)
      out.push(value as T)
    }
  }
  return out.length > 0 ? out : undefined
}

/**
 * Parse a comma-separated id list (ADR-134) into its non-empty, de-duplicated
 * members, in order. Account ids are opaque UUIDs with no fixed allow-set, so we
 * keep any non-empty trimmed token (an id that doesn't match any account is a
 * harmless no-op match). Returns `undefined` when nothing valid remains.
 */
function parseIds(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string') return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(',')) {
    const value = part.trim()
    if (value && !seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return out.length > 0 ? out : undefined
}

/**
 * Validate (and narrow) the raw `/transactions` search params (ADR-116). Every
 * param is narrowed to its known set/shape; unknown or malformed values are
 * ignored (omitted) rather than throwing, matching the lenient robustness of the
 * original `category`/`type`-only validator (ADR-031/ADR-062). Default values
 * (`type=all`, `currency=all`, `amount=any`, empty multi-selects, empty `q`) are
 * dropped so the route never round-trips a redundant param.
 */
export function validateTransactionsSearch(
  search: Record<string, unknown>,
): TransactionsSearch {
  const result: TransactionsSearch = {}

  const rawQ = search.q
  if (typeof rawQ === 'string' && rawQ.trim().length > 0) {
    result.q = rawQ
  }

  const rawType = search.type
  if (
    typeof rawType === 'string' &&
    rawType !== 'all' &&
    KNOWN_TYPES.has(rawType)
  ) {
    result.type = rawType as TypeFilter
  }

  const rawCurrency = search.currency
  if (
    typeof rawCurrency === 'string' &&
    rawCurrency !== 'all' &&
    KNOWN_CURRENCIES.has(rawCurrency)
  ) {
    result.currency = rawCurrency as CurrencyFilter
  }

  const rawMonth = search.month
  if (typeof rawMonth === 'string' && parseMonthToken(rawMonth) !== undefined) {
    result.month = rawMonth
  }

  const categories = parseCsv<Category>(search.category, KNOWN_CATEGORIES)
  if (categories) result.category = categories.join(',')

  const accounts = parseIds(search.account)
  if (accounts) result.account = accounts.join(',')

  const rawAmount = search.amount
  if (
    typeof rawAmount === 'string' &&
    rawAmount !== 'any' &&
    KNOWN_AMOUNTS.has(rawAmount)
  ) {
    result.amount = rawAmount as AmountRange
  }

  return result
}

/**
 * Derive the live {@link TransactionFilters} from validated search params
 * (ADR-116). Absent params fall back to defaults; crucially, an absent `month`
 * resolves to the CURRENT month (ADR-040 — the ledger owns its per-screen month),
 * with `now` injectable for deterministic tests. The month token is re-parsed
 * defensively (validateSearch already accepted it; a bad value still falls back).
 */
export function searchToFilters(
  search: TransactionsSearch,
  now: Date = new Date(),
): TransactionFilters {
  const month: MonthFilter =
    search.month !== undefined
      ? (parseMonthToken(search.month) ?? currentViewingMonth(now))
      : currentViewingMonth(now)

  return {
    q: search.q ?? '',
    type: search.type ?? 'all',
    currency: search.currency ?? 'all',
    month,
    categories: search.category
      ? (parseCsv<Category>(search.category, KNOWN_CATEGORIES) ?? [])
      : [],
    accounts: search.account ? (parseIds(search.account) ?? []) : [],
    amount: search.amount ?? 'any',
  }
}

/**
 * Encode live {@link TransactionFilters} back into URL search params (ADR-116),
 * OMITTING every default so the URL carries only what narrows the list: no
 * `type=all` / `currency=all` / `amount=any`, no empty `q` / `categories` /
 * `accounts`, and no `month` when it equals the current-month default (the absence
 * of `month` IS the current month, so writing it would be redundant). Specific
 * months serialize to `YYYY-MM`; ranges to their sentinel.
 */
export function filtersToSearch(
  filters: TransactionFilters,
  now: Date = new Date(),
): TransactionsSearch {
  const search: TransactionsSearch = {}

  const q = filters.q.trim()
  if (q.length > 0) search.q = filters.q

  if (filters.type !== 'all') search.type = filters.type
  if (filters.currency !== 'all') search.currency = filters.currency
  if (filters.amount !== 'any') search.amount = filters.amount

  // Omit the current-month default; serialize any other month/range.
  const isCurrentMonth =
    filters.month !== ALL_MONTHS &&
    filters.month !== LAST_12_MONTHS &&
    filters.month !== THIS_YEAR &&
    isSameViewingMonth(filters.month as ViewingMonth, currentViewingMonth(now))
  if (!isCurrentMonth) search.month = serializeMonth(filters.month)

  if (filters.categories.length > 0) {
    search.category = filters.categories.join(',')
  }
  if (filters.accounts.length > 0) search.account = filters.accounts.join(',')

  return search
}

/** Count of transactions in `transactions` whose category equals `category`. */
export function countByCategory(
  transactions: readonly Transaction[],
  category: Category,
): number {
  return transactions.filter((t) => t.category === category).length
}

/** Count of transactions in `transactions` attributed to account `id` (ADR-134). */
export function countByAccount(
  transactions: readonly Transaction[],
  id: string,
): number {
  return transactions.filter((t) => t.accountId === id).length
}

/** Months actually present in the data, in display order (for the month filter). */
export function presentMonths(
  transactions: readonly Transaction[],
): MonthName[] {
  return MONTH_ORDER.filter((m) => transactions.some((t) => t.month === m))
}

/**
 * Build the prefill passed to the Add/Edit seam from a row (concept `onEdit`).
 *
 * Income/invoice rows carry the `Income` category, which is not a user-pickable
 * expense category in the form, so the concept resets it to `Food`; we keep that
 * behavior. USD rows surface their original USD figure as the amount. The row
 * `id` is carried so the Add/Edit form runs the UPDATE mutation (not ADD).
 */
export function buildEditPrefill(
  t: Transaction,
): import('./addContext').AddPrefill {
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    kind: t.kind,
    currency: t.currency,
    category: t.category === 'Income' ? 'Food' : t.category,
    // Seed the Account selector from the row's linked account so editing a
    // transaction shows its current account (ADR-122/136). Omitted when unlinked.
    ...(t.accountId ? { accountId: t.accountId } : {}),
    bank: t.bank,
    // Card detail is import-set, not user-editable (ADR-117); carry it through so
    // editing an imported row preserves its card on save (omitted when absent).
    ...(t.card ? { card: t.card } : {}),
    amountNum: t.amountNum,
    // The date picker prefills from the row's ISO occurredOn (ADR-041).
    occurredOn: t.occurredOn,
    dispDate: t.dispDate,
    month: t.month,
    ...(t.usd !== undefined ? { usd: t.usd } : {}),
    ...(t.rate !== undefined ? { rate: t.rate } : {}),
    // Carry the existing FX source + as-of so the form reloads the rate and its
    // origin (MEP vs manual) on edit (ADR-044/045).
    ...(t.fxRateType !== undefined ? { fxRateType: t.fxRateType } : {}),
    ...(t.fxRateAsOf !== undefined ? { fxRateAsOf: t.fxRateAsOf } : {}),
    ...(t.recurring !== undefined ? { recurring: t.recurring } : {}),
    // Carry the existing free-text note so it survives a re-save on edit (ADR-088).
    ...(t.notes ? { notes: t.notes } : {}),
  }
}
