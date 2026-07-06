/**
 * Per-currency card-payment sufficiency + greedy transfer suggestion (ADR-188/189).
 *
 * Pure, React-free planning of how the user pays the balance of a statement being
 * imported. The obligation is evaluated PER CURRENCY in native units — ARS lines
 * are paid in pesos, USD lines in dollars — and the two are NEVER summed or
 * cross-converted (ADR-133/188): a USD shortfall must never be masked by a peso
 * surplus, and vice versa.
 *
 * For each currency present in the KEPT statement lines:
 *
 *  - **NEED** = Σ of that currency's kept lines. An ARS line contributes its
 *    native `amount`; a USD line contributes its `usdAmount` (its native dollar
 *    value) — NOT the pesos-only statement total, which would conflate currencies
 *    (ADR-188). A USD line missing a `usdAmount` contributes 0 (no fabrication).
 *  - **AVAILABLE** = Σ of the as-of-today native `balance` of the user's
 *    same-currency NON-card accounts (bank / cash / wallet). Card accounts are
 *    EXCLUDED — they are the destination obligation, not a funding source
 *    (ADR-184/188).
 *  - **MAIN / pay-from** account — the account the user intends to pay from first
 *    (ADR-189). The caller supplies a per-currency selection; the default is the
 *    largest-balance same-currency non-card account. When the selection is absent
 *    or no longer eligible, the default is used.
 *  - **Sufficient?** When the main account's balance ≥ need → sufficient, no
 *    transfer (ADR-188).
 *  - **Shortfall** = need − main.balance. **Greedy exact-to-zero** (ADR-189):
 *    from the OTHER same-currency non-card accounts sorted by balance DESC, pull
 *    `min(remaining_shortfall, source.balance)` from each until the shortfall hits
 *    0 — an ordered `[{ from, amount }]` list. If all combined still fall short,
 *    the `residualGap` is the amount that cannot be reached (no cross-currency
 *    conversion is suggested, ADR-189).
 *
 * Suggest-only: this module never mutates state or creates transfers (deferred to
 * a later slice, ADR-189). Money in / money out are plain numbers in native units;
 * the UI formats them at the display edge via `lib/format` (ADR-102).
 */

import type { Currency } from '../../mock/types'

/** Currencies evaluated, in a deterministic ARS-before-USD display order. */
const CURRENCY_ORDER: readonly Currency[] = ['ARS', 'USD'] as const

/**
 * A funding account candidate for the plan — a NON-card money account the user
 * could pay from. Carries the as-of-today native `balance` (opening + transaction
 * deltas, ADR-186) the plan sums for AVAILABLE and pulls from for transfers. Card
 * accounts must NOT be passed here — they are filtered out defensively anyway.
 */
export interface FundingAccount {
  /** The account's stable id (the transfer source/destination reference). */
  id: string
  /** The owning institution's display name, e.g. "Galicia" / "Deel". */
  institutionName: string
  /** The account kind — card accounts are excluded from funding (ADR-184/188). */
  type: 'bank' | 'cash' | 'card' | 'wallet'
  /** Native currency (ARS / USD) — only same-currency accounts fund a currency. */
  currency: Currency
  /** As-of-today native balance (ADR-186), a finite number in the account's currency. */
  balance: number
}

/** The minimal kept-line shape the NEED computation reads (native amounts only). */
export interface PlanLine {
  /** The line's native currency (ARS / USD). */
  currency: Currency
  /** Native ARS amount (used when `currency === 'ARS'`). */
  amount: number
  /** Native USD value (used when `currency === 'USD'`); absent ⇒ contributes 0. */
  usdAmount?: number
}

/** One suggested transfer leg: pull `amount` from `from` into the main account. */
export interface TransferLeg {
  /** The source funding account to move money from. */
  from: FundingAccount
  /** The amount to move, in the currency's native units (≤ the source balance). */
  amount: number
}

/** The plan for a single currency present in the kept lines (ADR-188/189). */
export interface CurrencyPlan {
  /** The currency this plan governs (ARS / USD). */
  currency: Currency
  /** Total NEED for this currency in native units (Σ kept lines, ADR-188). */
  need: number
  /** Total AVAILABLE across same-currency non-card accounts (ADR-188). */
  available: number
  /** The chosen main / pay-from account, or null when the user holds none of this currency. */
  main: FundingAccount | null
  /** Whether the main account alone covers the need (ADR-188). */
  sufficient: boolean
  /** The ordered greedy transfer legs that top the main account up to the need (ADR-189). */
  transfers: readonly TransferLeg[]
  /** Amount still uncovered after every same-currency account (0 when reachable, ADR-189). */
  residualGap: number
}

/** The full per-currency plan for a statement import (ARS before USD). */
export interface PaymentPlan {
  /** One entry per currency present in the kept lines, ARS before USD. */
  currencies: readonly CurrencyPlan[]
}

/** Coerce a possibly-absent number to a finite value (0 on garbage/absent). */
function finite(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * The plan's "pending" due date (ADR-188): the statement's `periodDue` (preferred)
 * or `periodClose` (fallback) when it is TODAY or later, else `null` (nothing is
 * pending — the due date has passed or none was parsed). Dates are ISO
 * `YYYY-MM-DD`; comparison is date-only (no time zone drift) against `today`
 * (defaults to the current date). Pure — the UI turns the returned ISO date into a
 * "Pending — due {date}" label (no writes, ADR-188/189).
 *
 * @param periodDue The statement due date (ISO `YYYY-MM-DD`), if parsed.
 * @param periodClose The statement close date (ISO), used when no due date exists.
 * @param today The reference date; defaults to now (injectable for tests).
 * @returns The pending due date (ISO), or null when not pending.
 */
export function pendingDueDate(
  periodDue: string | undefined,
  periodClose: string | undefined,
  today: Date = new Date(),
): string | null {
  const due = (periodDue ?? periodClose)?.slice(0, 10)
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return null
  // Compare date-only in the LOCAL calendar: build today's YYYY-MM-DD and compare
  // lexically (ISO dates sort chronologically). Pending when today <= due.
  const y = today.getFullYear()
  const m = String(today.getMonth() + 1).padStart(2, '0')
  const d = String(today.getDate()).padStart(2, '0')
  const todayIso = `${y}-${m}-${d}`
  return todayIso <= due ? due : null
}

/**
 * The `occurred_on` date the scheduled top-up transfers should carry (ADR-191).
 *
 * A statement is reviewed BEFORE the due date, so a transfer created today would
 * immediately reduce the as-of-today balance (ADR-186) even though the bank
 * payment has not happened. To defer it, the transfer is dated on the statement
 * due date so it stays PENDING (excluded from the balance) until then:
 *
 *  - `today < due` → the transfer is dated on the due date (`periodDue`, or
 *    `periodClose` as a fallback) — it activates on that day.
 *  - `today >= due` (or no due date parsed) → the transfer is dated TODAY — the
 *    due date has passed, so there's nothing to defer; move the funds now.
 *
 * Dates are ISO `YYYY-MM-DD`; the comparison is date-only in the LOCAL calendar
 * (mirrors {@link pendingDueDate} / `todayIsoDate`, no time-zone drift). Pure —
 * the caller stamps the returned date on each `POST /transfers`.
 *
 * @param periodDue The statement due date (ISO `YYYY-MM-DD`), if parsed.
 * @param periodClose The statement close date (ISO), used when no due date exists.
 * @param today The reference date; defaults to now (injectable for tests).
 * @returns The `occurred_on` ISO date to stamp on the scheduled transfers.
 */
export function scheduleOccurredOn(
  periodDue: string | undefined,
  periodClose: string | undefined,
  today: Date = new Date(),
): string {
  const y = today.getFullYear()
  const m = String(today.getMonth() + 1).padStart(2, '0')
  const d = String(today.getDate()).padStart(2, '0')
  const todayIso = `${y}-${m}-${d}`
  const due = (periodDue ?? periodClose)?.slice(0, 10)
  // Use the due date only when it is a valid ISO date STRICTLY in the future
  // (today < due). On/after the due date, or no due parsed, date it today.
  if (due && /^\d{4}-\d{2}-\d{2}$/.test(due) && todayIso < due) return due
  return todayIso
}

/**
 * Whether the whole plan can be executed as scheduled transfers (ADR-191): at
 * least one currency needs a top-up that is fully coverable by suggested legs,
 * and NO currency has a residual gap. When any currency is still short after all
 * its accounts, execution is withheld (suggest-only) so the user is never left
 * with a half-scheduled, still-incomplete plan — the residual note guides them.
 */
export function isPlanSchedulable(plan: PaymentPlan): boolean {
  let hasLegs = false
  for (const currencyPlan of plan.currencies) {
    if (currencyPlan.residualGap > 0) return false
    if (!currencyPlan.sufficient && currencyPlan.transfers.length > 0) {
      hasLegs = true
    }
  }
  return hasLegs
}

/** A same-currency NON-card funding account (card excluded — it's the obligation). */
function isFunding(account: FundingAccount, currency: Currency): boolean {
  return account.type !== 'card' && account.currency === currency
}

/**
 * A line's native contribution to its currency's NEED (ADR-188): an ARS line uses
 * `amount`; a USD line uses `usdAmount` (0 when absent — never fabricated).
 */
function lineNeed(line: PlanLine): number {
  return line.currency === 'USD' ? finite(line.usdAmount) : finite(line.amount)
}

/** The distinct currencies present in the kept lines, ARS before USD. */
function currenciesInLines(lines: readonly PlanLine[]): Currency[] {
  const seen = new Set<Currency>()
  for (const line of lines) seen.add(line.currency)
  return CURRENCY_ORDER.filter((c) => seen.has(c))
}

/**
 * Choose the main / pay-from account for a currency (ADR-189). Honors the user's
 * selection when it is still an eligible same-currency non-card account; otherwise
 * defaults to the largest-balance eligible account (ties broken by institution
 * name for determinism). Returns null when the user holds no such account.
 */
function chooseMain(
  eligible: readonly FundingAccount[],
  selectedId: string | undefined,
): FundingAccount | null {
  if (eligible.length === 0) return null
  if (selectedId !== undefined) {
    const chosen = eligible.find((a) => a.id === selectedId)
    if (chosen) return chosen
  }
  // Default: largest balance first, institution name as a stable tie-break.
  return [...eligible].sort(
    (a, b) =>
      b.balance - a.balance ||
      a.institutionName.localeCompare(b.institutionName) ||
      a.id.localeCompare(b.id),
  )[0]
}

/**
 * The greedy exact-to-zero transfer legs that top the main account up to the need
 * (ADR-189). Pulls from the OTHER same-currency non-card accounts, largest balance
 * first, `min(remaining, source.balance)` from each until the shortfall is 0.
 * Returns the ordered legs plus any `residualGap` (amount still short when the
 * combined balances cannot cover it). No source is over-drawn; a zero/negative
 * source contributes nothing.
 */
function greedyTransfers(
  eligible: readonly FundingAccount[],
  main: FundingAccount,
  shortfall: number,
): { transfers: TransferLeg[]; residualGap: number } {
  const transfers: TransferLeg[] = []
  if (shortfall <= 0) return { transfers, residualGap: 0 }
  // Sources = every eligible account except the main, largest balance first.
  const sources = eligible
    .filter((a) => a.id !== main.id && a.balance > 0)
    .sort(
      (a, b) =>
        b.balance - a.balance ||
        a.institutionName.localeCompare(b.institutionName) ||
        a.id.localeCompare(b.id),
    )
  let remaining = shortfall
  for (const source of sources) {
    if (remaining <= 0) break
    const contribution = Math.min(remaining, source.balance)
    if (contribution > 0) {
      transfers.push({ from: source, amount: contribution })
      remaining -= contribution
    }
  }
  // Guard tiny floating-point residue so an exactly-covered plan reads as 0.
  const residualGap = remaining > 1e-6 ? remaining : 0
  return { transfers, residualGap }
}

/** Build the per-currency plan for one currency (ADR-188/189). */
function planForCurrency(
  currency: Currency,
  lines: readonly PlanLine[],
  accounts: readonly FundingAccount[],
  selectedMainId: string | undefined,
): CurrencyPlan {
  const need = lines
    .filter((line) => line.currency === currency)
    .reduce((sum, line) => sum + lineNeed(line), 0)
  const eligible = accounts.filter((a) => isFunding(a, currency))
  const available = eligible.reduce((sum, a) => sum + a.balance, 0)
  const main = chooseMain(eligible, selectedMainId)
  const mainBalance = main ? main.balance : 0
  const sufficient = main !== null && mainBalance >= need
  if (sufficient || main === null) {
    // Sufficient, or the user holds no same-currency account: no transfers. When
    // there is no main account the whole need is a residual gap (nothing to pull).
    return {
      currency,
      need,
      available,
      main,
      sufficient,
      transfers: [],
      residualGap: main === null ? need : 0,
    }
  }
  const shortfall = need - mainBalance
  const { transfers, residualGap } = greedyTransfers(eligible, main, shortfall)
  return { currency, need, available, main, sufficient: false, transfers, residualGap }
}

/**
 * Compute the per-currency payment plan for a statement import (ADR-188/189).
 *
 * @param keptLines The lines the user is keeping (their native amounts drive NEED).
 * @param accounts The user's funding accounts (non-card leaves with native balances).
 * @param mainAccountByCurrency The user's per-currency main-account selection (id);
 *   an absent/ineligible entry falls back to the largest-balance default (ADR-189).
 * @returns One {@link CurrencyPlan} per currency present in the kept lines, ARS
 *   before USD. A currency with zero kept lines is omitted.
 */
export function computePaymentPlan(
  keptLines: readonly PlanLine[],
  accounts: readonly FundingAccount[],
  mainAccountByCurrency: Partial<Record<Currency, string>> = {},
): PaymentPlan {
  const currencies = currenciesInLines(keptLines).map((currency) =>
    planForCurrency(
      currency,
      keptLines,
      accounts,
      mainAccountByCurrency[currency],
    ),
  )
  return { currencies }
}
