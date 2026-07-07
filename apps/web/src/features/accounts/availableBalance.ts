/**
 * Commitment-aware available balance — the shared pure primitive (ADR-193).
 *
 * A single, React-free source of truth for "how much of an account is really
 * mine right now" once already-scheduled (future-dated) own-account transfers
 * are accounted for. It layers PENDING transfer legs on top of the account's
 * as-of-today native balance (ADR-186) WITHOUT re-deriving that balance and
 * WITHOUT ever crossing currencies (ADR-133): every figure is native to its own
 * account, and ARS and USD are never summed or converted here.
 *
 * A transfer is PENDING when its `occurredOn` is STRICTLY in the future
 * (`occurredOn > today`, ADR-191): it is a real, balance-moving record that has
 * not yet taken effect (the date is the state — no status field). Such legs are
 * excluded from the as-of-today balance (ADR-186), so they must be surfaced
 * separately as commitments:
 *
 *  - `pendingOut` = Σ `amountOut` of pending transfers whose `fromAccountId` is
 *    this account — money already promised to leave. It debits the account in
 *    ITS OWN currency (the source side, per the transfer's `amountOut`).
 *  - `pendingIn` = Σ `amountIn` of pending transfers whose `toAccountId` is this
 *    account — a scheduled top-up arriving into it, credited in ITS currency.
 *
 * Two derived views sit on top (ADR-194/195):
 *
 *  - `spendableNow = balance − pendingOut` — what the user can safely commit
 *    TODAY. Pending inflows are NOT added: money that has not arrived cannot be
 *    spent (the conservative, no-double-source view the account selector shows,
 *    ADR-194).
 *  - `projected = balance + pendingIn − pendingOut` — the account's balance ON a
 *    future due date once every scheduled leg has settled. This is what the
 *    card-payment planner sources against (ADR-195): a promised outflow reduces
 *    what the account can fund, and a scheduled top-up counts toward it.
 *
 * Pure and deterministic — the caller supplies `today` (an ISO `YYYY-MM-DD`
 * string) so tests pin it and the UI passes `todayIsoDate()`. Money is a plain
 * number in native units; parsing from the Decimal-string API boundary
 * (ADR-025/034) happens at the edge, before this function.
 */

import type { Currency, Transfer } from '../../mock/types'

/** The minimal account shape the primitive reads: id + native currency + balance. */
export interface AvailableAccountInput {
  /** The account's stable id (the transfer source/destination reference). */
  id: string
  /** Native currency (ARS / USD) — every figure below stays in it (ADR-133). */
  currency: Currency
  /** As-of-today native balance (ADR-186); reused as-is, never recomputed. */
  balance: number
}

/** The commitment-aware breakdown for one account, all in its NATIVE currency. */
export interface AvailableBalance {
  /** Native currency the three figures below are expressed in (ADR-133). */
  currency: Currency
  /** As-of-today native balance (ADR-186), passed through unchanged. */
  balance: number
  /** Σ pending inflows (`amountIn` of future-dated transfers INTO this account). */
  pendingIn: number
  /** Σ pending outflows (`amountOut` of future-dated transfers OUT of this account). */
  pendingOut: number
}

/** Coerce a Decimal-string / possibly-absent amount to a finite number (0 on garbage). */
function num(value: string | number | null | undefined): number {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

/**
 * Whether a transfer is PENDING relative to `today`: its `occurredOn` is a valid
 * ISO date STRICTLY in the future (ADR-191). Comparison is date-only lexical (ISO
 * dates sort chronologically) so there is no time-zone drift — it mirrors
 * `todayIsoDate` / `pendingDueDate`. A malformed / absent date is never pending.
 */
export function isPendingTransfer(transfer: Transfer, today: string): boolean {
  const on = transfer.occurredOn?.slice(0, 10)
  if (!on || !/^\d{4}-\d{2}-\d{2}$/.test(on)) return false
  return on > today
}

/**
 * Compute the commitment-aware available breakdown for each account (ADR-193).
 *
 * Returns a Map keyed by account id → {@link AvailableBalance} (native units).
 * Every input account is present in the map, even when it has no pending legs
 * (its `pendingIn`/`pendingOut` are 0 and `balance` is unchanged). Pending legs
 * whose from/to account is not in `accounts` are ignored (nothing to attribute
 * to). Pure — pass `today` as an ISO `YYYY-MM-DD` string.
 *
 * @param accounts The accounts to break down (native balance + currency).
 * @param transfers The full transfers list; only future-dated legs count (ADR-191).
 * @param today The reference date (ISO `YYYY-MM-DD`); injectable for tests.
 * @returns A map of account id → native `{ balance, pendingIn, pendingOut }`.
 */
export function computeAvailable(
  accounts: readonly AvailableAccountInput[],
  transfers: readonly Transfer[],
  today: string,
): Map<string, AvailableBalance> {
  const result = new Map<string, AvailableBalance>()
  for (const account of accounts) {
    result.set(account.id, {
      currency: account.currency,
      balance: num(account.balance),
      pendingIn: 0,
      pendingOut: 0,
    })
  }
  for (const transfer of transfers) {
    if (!isPendingTransfer(transfer, today)) continue
    // Source side: the promised outflow debits `fromAccountId` in its own
    // currency (the transfer's `amountOut`). Destination side: the scheduled
    // top-up credits `toAccountId` (the transfer's `amountIn`). Each side is
    // attributed only when the account is in the input set (native, no cross-sum).
    const from = result.get(transfer.fromAccountId)
    if (from) from.pendingOut += num(transfer.amountOut)
    const to = result.get(transfer.toAccountId)
    if (to) to.pendingIn += num(transfer.amountIn)
  }
  return result
}

/**
 * Spendable-now for an account (ADR-194): `balance − pendingOut`. The
 * conservative "what I can commit TODAY" figure — a promised outflow reduces it,
 * but a not-yet-arrived inflow is NEVER added (money you don't have yet can't be
 * spent). Native units; the account selector shows this (ADR-194).
 */
export function spendableNow(available: AvailableBalance): number {
  return available.balance - available.pendingOut
}

/**
 * Projected due-date balance for an account (ADR-195):
 * `balance + pendingIn − pendingOut`. The account's balance once every scheduled
 * leg has settled — a promised outflow reduces what it can source and a
 * scheduled top-up counts toward it. The card-payment planner funds against this
 * (ADR-195). Native units.
 */
export function projectedBalance(available: AvailableBalance): number {
  return available.balance + available.pendingIn - available.pendingOut
}
