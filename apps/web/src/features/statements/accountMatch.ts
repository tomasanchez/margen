/**
 * Statement-import card-account matching (ADR-184, upgraded by ADR-190).
 *
 * Pure, React-free deduction of which of the user's CARD accounts an imported
 * statement's lines attach to. Argentine credit cards carry SEPARATE peso and
 * dólar balances — each is a distinct per-currency {@link Account} under one card
 * institution (e.g. "Galicia" with an ARS account and a USD account) — so the
 * match is keyed by **(institution, currency)**: an ARS line attaches to the
 * issuer's ARS card account, a USD line to its USD card account (ADR-184).
 *
 * The statement parse exposes `bankName` (normalized issuer), `network`
 * (VISA/AMEX), and `cardLast4`. ADR-190 persists `brand` (network) + `last4` on
 * the card {@link Institution}, so the PRIMARY match is now by **(brand + last4)**:
 * the card institution whose brand + last4 equal the parse's `network` +
 * `cardLast4`. This is precise — it distinguishes two cards from the same issuer.
 * When the parse or the institution lacks brand/last4 (older institutions), it
 * FALLS BACK to name-only matching by `bankName` ↔ `institutionName` (ADR-184).
 *
 * Once a card institution is resolved, its per-currency card accounts are indexed
 * by currency. When the parse carries no identity, or the user has no card
 * account for that institution + currency, the currency is left UNMATCHED (the
 * line imports unattached — backend-tolerant, ADR-184).
 *
 * Money/identity strings only; no UI, no i18n. The review UI seeds its per-
 * currency default selection from {@link matchCardAccounts} and lets the user
 * confirm/override before import.
 */

import type { Account, Currency, Institution } from '../../mock/types'
import type { StatementParse } from '../../api/statementsClient'

/** A resolved card account offered as the default for one currency section. */
export interface AccountMatch {
  /** The matched account's id — the value stamped onto that currency's lines. */
  id: string
  /** The owning institution's display name, e.g. "Galicia". */
  institutionName: string
  /** The account's native currency (ARS / USD) — must equal the line currency. */
  currency: Currency
}

/**
 * Normalize an institution / bank name for tolerant comparison: trimmed,
 * case-folded, and accent-stripped so "Galicia" matches "GALICIA" / "galicia".
 * A `null`/absent name normalizes to the empty string (never matches).
 */
function normalizeName(name: string | null | undefined): string {
  if (!name) return ''
  return name
    .trim()
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

/** Normalize a card last-4 for comparison: trimmed digits only (empty ⇒ absent). */
function normalizeLast4(value: string | null | undefined): string {
  if (!value) return ''
  const digits = value.replace(/\D/g, '')
  return digits.length === 4 ? digits : ''
}

/** Normalize a card brand/network for tolerant comparison (case/accents/space). */
function normalizeBrand(value: string | null | undefined): string {
  return normalizeName(value)
}

/**
 * Resolve the id of the card {@link Institution} a parse belongs to (ADR-190).
 *
 * PRIMARY: match by (brand + last4) — the card institution whose normalized
 * `brand` equals the parse's `network` AND whose `last4` equals the parse's
 * `cardLast4`. This is precise across same-issuer cards. Only attempted when BOTH
 * the parse and a candidate carry a brand + last4.
 *
 * FALLBACK: match by name — the FIRST card institution whose `name` equals the
 * parse's `bankName` (ADR-184; used for older institutions without brand/last4).
 *
 * Returns the institution id, or `null` when nothing matches. Deterministic:
 * first-in-list wins on a (shouldn't-happen) tie.
 */
function resolveCardInstitutionId(
  parse: StatementParse,
  institutions: readonly Institution[],
): string | null {
  const parseBrand = normalizeBrand(parse.network)
  const parseLast4 = normalizeLast4(parse.cardLast4)
  // Primary: precise (brand + last4) match when the parse carries both.
  if (parseBrand !== '' && parseLast4 !== '') {
    for (const inst of institutions) {
      if (inst.type !== 'card') continue
      if (
        normalizeBrand(inst.brand) === parseBrand &&
        normalizeLast4(inst.last4) === parseLast4
      ) {
        return inst.id
      }
    }
  }
  // Fallback: name-only match (ADR-184) for institutions without brand/last4.
  const parseName = normalizeName(parse.bankName)
  if (parseName === '') return null
  for (const inst of institutions) {
    if (inst.type !== 'card') continue
    if (normalizeName(inst.name) === parseName) return inst.id
  }
  return null
}

/**
 * The card accounts the user holds under the resolved card institution, indexed
 * by currency. Only `type === 'card'` accounts under that institution id are
 * eligible (ADR-184: a statement charge belongs to a credit-card account, never a
 * bank / cash / wallet leaf). When two card accounts share the institution +
 * currency (shouldn't normally happen), the FIRST in list order wins.
 */
function cardAccountsByCurrency(
  accounts: readonly Account[],
  institutionId: string | null,
): Map<Currency, Account> {
  const byCurrency = new Map<Currency, Account>()
  if (institutionId === null) return byCurrency
  for (const account of accounts) {
    if (account.type !== 'card') continue
    if (account.institutionId !== institutionId) continue
    if (!byCurrency.has(account.currency)) byCurrency.set(account.currency, account)
  }
  return byCurrency
}

/**
 * The set of line currencies present in a parse (ARS and/or USD). Only these
 * need a default selection — a statement with no USD line shows no USD section.
 */
export function currenciesInParse(parse: StatementParse): Currency[] {
  const seen = new Set<Currency>()
  for (const line of parse.lines) seen.add(line.currency)
  // Deterministic ARS-before-USD order for a stable section layout.
  return (['ARS', 'USD'] as const).filter((c) => seen.has(c))
}

/**
 * Synthesize a minimal {@link Institution} list from the accounts when the caller
 * did not pass one (backward-compat with the ADR-184 name-only signature). Each
 * distinct `institutionId` becomes an institution carrying its name + type but NO
 * brand/last4, so the resolver degrades to name-only matching (ADR-184).
 */
function institutionsFromAccounts(
  accounts: readonly Account[],
): Institution[] {
  const byId = new Map<string, Institution>()
  for (const account of accounts) {
    if (byId.has(account.institutionId)) continue
    byId.set(account.institutionId, {
      id: account.institutionId,
      name: account.institutionName,
      type: account.type,
    })
  }
  return [...byId.values()]
}

/**
 * Auto-match each line-currency present in the parse to the user's card account
 * for the resolved card institution + that currency (ADR-184/190). Returns a map
 * keyed by currency; a currency with no matching card account is ABSENT from the
 * map (the UI shows it unmatched, and its lines import unattached). Pure +
 * deterministic.
 *
 * The institution is resolved by (brand + last4) when the parse + an institution
 * both carry them (ADR-190), else by name (ADR-184). When `institutions` is
 * omitted, a synthetic name-only list is derived from the accounts so existing
 * callers keep the ADR-184 behavior.
 *
 * @param parse The successful statement parse (its `network`/`cardLast4`/`bankName` name the card).
 * @param accounts The user's account list (card leaves are the match candidates).
 * @param institutions The user's institutions (carry `brand`/`last4` for the precise match).
 */
export function matchCardAccounts(
  parse: StatementParse,
  accounts: readonly Account[],
  institutions?: readonly Institution[],
): Map<Currency, AccountMatch> {
  // Fall back to a synthetic name-only institution list when none was passed OR
  // an empty one was (older callers / a still-loading institutions query) so the
  // ADR-184 name match keeps working even without ADR-190 brand/last4 data.
  const resolvedInstitutions =
    institutions && institutions.length > 0
      ? institutions
      : institutionsFromAccounts(accounts)
  const institutionId = resolveCardInstitutionId(parse, resolvedInstitutions)
  const byCurrency = cardAccountsByCurrency(accounts, institutionId)
  const matches = new Map<Currency, AccountMatch>()
  for (const currency of currenciesInParse(parse)) {
    const account = byCurrency.get(currency)
    if (!account) continue
    matches.set(currency, {
      id: account.id,
      institutionName: account.institutionName,
      currency: account.currency,
    })
  }
  return matches
}
