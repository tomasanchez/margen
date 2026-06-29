/**
 * Shared net-worth grouping + ordering helpers (ADR-122/123/133/134).
 *
 * The Home {@link NetWorthCard} and the {@link AccountsPage} BOTH present the same
 * institutions-with-accounts breakdown, sourced from the net-worth read model so
 * the balances + ordering stay in lockstep (the Accounts page used to show the
 * stale opening balance — see ADR-122). These pure helpers are the single source
 * of truth for:
 *
 *  - the per-account CURRENT native balance (opening + transaction deltas) keyed
 *    by account id — {@link buildNetWorthBalanceIndex};
 *  - the institution ORDER (by net-worth subtotal DESC, name tie-break) and the
 *    per-institution account order (ARS before USD) — {@link orderInstitutionIds}
 *    and {@link compareAccountCurrencies};
 *  - the live-MEP conversion used to compute those subtotals — {@link convertAtMep}
 *    / {@link groupByInstitution} (ADR-133 amendment).
 *
 * Pure + unit-testable; no React, no i18n. Money arrives as Decimal strings
 * (ADR-025/034) and is parsed to numbers only here for arithmetic + the shared
 * formatter at the display edge (ADR-102).
 */

import type { AccountType, Currency } from '../../mock/types'
import type { NetWorthAccount } from '../../api/accountsClient'

/** Parse a Decimal string to a finite number for arithmetic (0 on garbage). */
export function num(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Narrow a backend currency string to {@link Currency} (default ARS). */
export function asCurrency(value: string): Currency {
  return value === 'USD' ? 'USD' : 'ARS'
}

/** Narrow a backend institution/account `type` string to {@link AccountType}. */
export function asAccountType(value: string): AccountType {
  return value === 'cash' || value === 'card' || value === 'wallet'
    ? value
    : 'bank'
}

/** Sort key for currency ordering within an institution: ARS before USD. */
export function currencyRank(currency: Currency): number {
  return currency === 'ARS' ? 0 : 1
}

/** Comparator that orders accounts ARS before USD (by native currency). */
export function compareAccountCurrencies(
  a: Currency,
  b: Currency,
): number {
  return currencyRank(a) - currencyRank(b)
}

/** The non-display currency (the one we have to convert at the live MEP). */
export function otherCurrencyOf(displayCurrency: Currency): Currency {
  return displayCurrency === 'USD' ? 'ARS' : 'USD'
}

/** A usable live MEP rate: finite and positive, else `null` (degrade). */
export function usableMep(mep: number | null | undefined): number | null {
  return typeof mep === 'number' && Number.isFinite(mep) && mep > 0 ? mep : null
}

/**
 * Convert `amount` from `from` currency into `displayCurrency` at the live MEP
 * (ARS per USD). Same currency → returned as-is. ARS→USD divides by the MEP;
 * USD→ARS multiplies. Returns `null` when no usable rate exists (degrade — we
 * never fabricate one, ADR-133).
 */
export function convertAtMep(
  amount: number,
  from: Currency,
  displayCurrency: Currency,
  mep: number | null,
): number | null {
  if (from === displayCurrency) return amount
  if (mep == null) return null
  return displayCurrency === 'USD' ? amount / mep : amount * mep
}

/**
 * One institution's grouped breakdown (ADR-134): its accounts (currency-ordered)
 * plus a `subtotal` in the display currency — the sum of each account's value
 * converted at the live MEP (ADR-133 amendment), so the subtotals sum to the
 * headline total. `subtotal` is `null` when an other-currency account couldn't
 * be converted (degrade), in which case the subtotal line is hidden.
 */
export interface InstitutionGroup {
  institutionId: string
  institutionName: string
  type: AccountType
  accounts: NetWorthAccount[]
  subtotal: number | null
}

/**
 * Group the flat net-worth breakdown by `institutionId` (ADR-134, client-side —
 * no backend change), converting each account at the live MEP (ADR-133
 * amendment) so the per-institution subtotals match the headline total.
 * Institutions are ordered by subtotal DESC (name as the tie-break); accounts
 * within an institution are ordered ARS before USD.
 */
export function groupByInstitution(
  accounts: NetWorthAccount[],
  displayCurrency: Currency,
  mep: number | null,
): InstitutionGroup[] {
  const byId = new Map<string, InstitutionGroup>()
  for (const account of accounts) {
    const converted = convertAtMep(
      num(account.balance),
      asCurrency(account.currency),
      displayCurrency,
      mep,
    )
    const existing = byId.get(account.institutionId)
    if (existing) {
      existing.accounts.push(account)
      existing.subtotal =
        existing.subtotal == null || converted == null
          ? null
          : existing.subtotal + converted
    } else {
      byId.set(account.institutionId, {
        institutionId: account.institutionId,
        institutionName: account.institutionName,
        type: asAccountType(account.type),
        accounts: [account],
        subtotal: converted,
      })
    }
  }
  const groups = [...byId.values()]
  for (const group of groups) {
    group.accounts.sort((a, b) =>
      compareAccountCurrencies(asCurrency(a.currency), asCurrency(b.currency)),
    )
  }
  groups.sort(
    (a, b) =>
      (b.subtotal ?? 0) - (a.subtotal ?? 0) ||
      a.institutionName.localeCompare(b.institutionName),
  )
  return groups
}

/**
 * Map of account id → CURRENT native balance (a finite number) from the
 * net-worth read model. The Accounts page uses this to display each account's
 * current balance (opening + transaction deltas) instead of the stale opening
 * balance — keeping the two screens identical (ADR-122).
 */
export function buildNetWorthBalanceIndex(
  accounts: NetWorthAccount[],
): Map<string, number> {
  const index = new Map<string, number>()
  for (const account of accounts) index.set(account.id, num(account.balance))
  return index
}

/**
 * The institution ids in net-worth display order: by per-institution subtotal
 * DESC, name as the tie-break (the SAME order the Home breakdown uses). Drives
 * the Accounts page so its institution sections match Home exactly.
 */
export function orderInstitutionIds(
  accounts: NetWorthAccount[],
  displayCurrency: Currency,
  mep: number | null,
): string[] {
  return groupByInstitution(accounts, displayCurrency, mep).map(
    (group) => group.institutionId,
  )
}
