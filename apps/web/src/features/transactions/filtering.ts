/**
 * Pure filtering / grouping / totals logic for the Transactions screen.
 *
 * Ported from the concept script (Margen Transactions.dc.html `renderVals`):
 * search matches name OR category; the type filter maps All / Expenses / Income
 * / Invoices onto `type`/`kind`; currency, month, multi-select category, and
 * multi-select bank narrow the list; an amount-range bucket filters by the
 * ARS-equivalent magnitude. Rows are sorted newest-first within months ordered
 * June → May → April and grouped per month with per-group in/out sums and an
 * overall count + inflow + outflow + net.
 *
 * This module is intentionally free of React and MUI so the rules can be unit
 * tested directly and reused by both the desktop bar and the mobile sheet.
 */

import type {
  Bank,
  Category,
  Currency,
  MonthName,
  Transaction,
} from '../../mock/types'
import { ALL_MONTHS, type MonthSelection } from '../../components/months'
import { occurredInMonth } from '../home/homeMetrics'

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
  /** Selected banks/cards; empty means "all banks". */
  banks: Bank[]
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
  banks: [],
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
    f.banks.length > 0 ||
    f.amount !== 'any'
  )
}

/**
 * Count of active filters surfaced on the mobile "Filters" button. Mirrors the
 * concept: currency + month + each category + each bank + a non-default amount.
 * (Search and the type segment live outside the sheet, so they are excluded.)
 */
export function activeFilterCount(f: TransactionFilters): number {
  return (
    (f.currency !== 'all' ? 1 : 0) +
    (f.month !== ALL_MONTHS ? 1 : 0) +
    f.categories.length +
    f.banks.length +
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
  // Year-aware month match against the ISO `occurredOn` (ADR-040), reusing the
  // exact parse Home uses — never the bare `t.month` name. `'all'` = All time.
  if (f.month !== ALL_MONTHS && !occurredInMonth(t.occurredOn, f.month)) {
    return false
  }
  if (f.categories.length && !f.categories.includes(t.category)) return false
  if (f.banks.length && !f.banks.includes(t.bank)) return false
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

/** Count of transactions in `transactions` whose category equals `category`. */
export function countByCategory(
  transactions: readonly Transaction[],
  category: Category,
): number {
  return transactions.filter((t) => t.category === category).length
}

/** Count of transactions in `transactions` attributed to `bank`. */
export function countByBank(
  transactions: readonly Transaction[],
  bank: Bank,
): number {
  return transactions.filter((t) => t.bank === bank).length
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
    bank: t.bank,
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
