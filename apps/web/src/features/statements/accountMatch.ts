/**
 * Statement-import card-account matching (ADR-184, upgraded by ADR-190/196).
 *
 * Pure, React-free deduction of which of the user's CARD accounts an imported
 * statement's lines attach to. Argentine credit cards carry SEPARATE peso and
 * dólar balances — each is a distinct per-currency {@link Account} under one card
 * institution (e.g. "Galicia" with an ARS account and a USD account) — so the
 * match is keyed by **(institution, currency)**: an ARS line attaches to the
 * issuer's ARS card account, a USD line to its USD card account (ADR-184).
 *
 * Matching is INSTITUTION-FIRST. A credit card belongs to an issuer, and one
 * card institution's per-currency accounts serve BOTH the ARS and USD lines of a
 * statement. The user should not have to have "registered" a brand + last4 for an
 * existing card to be recognized — a card added through the accounts UI (no
 * brand/last4) still auto-matches by issuer name. So the PRIMARY key is the issuer
 * NAME (`bankName` ↔ `institutionName`, accent/case tolerant). brand + last4
 * (ADR-190) are a DISAMBIGUATOR, used only when the user holds TWO+ card
 * institutions at the SAME issuer — the one case where name alone is ambiguous.
 *
 * The statement parse exposes `bankName` (normalized issuer), `network`
 * (VISA/AMEX), and `cardLast4`. ADR-190 persists `brand` (network) + `last4` on
 * the card {@link Institution}. The resolution order is:
 *   1. Gather all card institutions whose name matches the parse's issuer.
 *   2. Exactly one → return it, whether or not it carries a brand/last4.
 *   3. Multiple → disambiguate by (brand + last4); one survivor → it, else null.
 *   4. Zero → null (issuer genuinely absent → register prompt). NO cross-issuer
 *      (brand + last4) fallback: that key is not unique across banks and could
 *      misroute the statement to the wrong institution's accounts.
 *
 * Once a card institution is resolved, its per-currency card accounts are indexed
 * by currency. When the parse carries no issuer name and no precise identity, or
 * the user has no card account for that institution + currency, the currency is
 * left UNMATCHED (the line imports unattached — backend-tolerant, ADR-184).
 *
 * A `null` resolution (issuer genuinely absent) is what drives the in-flow
 * "Register this card" prompt (ADR-190). A matched-but-brand/last4-less card is
 * NOT null, so registration does NOT fire for it — avoiding the duplicate-
 * institution bug the old brand+last4 gate caused.
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
 * Resolve the id of the card {@link Institution} a parse belongs to.
 *
 * INSTITUTION-FIRST (a card belongs to an issuer; the user should not have to have
 * registered a brand/last4 for their existing card to be recognized):
 *
 *   1. Gather all `type === 'card'` institutions whose normalized `name` equals the
 *      parse's normalized `bankName`.
 *   2. Exactly ONE name match → return it, REGARDLESS of whether it carries a
 *      brand/last4. This is the common case: one card per issuer. Its ARS + USD
 *      card accounts already serve the ARS + USD lines via
 *      {@link cardAccountsByCurrency}.
 *   3. MULTIPLE name matches (the user holds 2+ cards at the same issuer) →
 *      disambiguate by (brand + last4): keep those whose normalized `brand` + `last4`
 *      equal the parse's `network` + `cardLast4`. Exactly one survivor → it; none or
 *      ambiguous → `null` (the review UI / RegisterCardForm / manual selection
 *      resolves it — better than a confident-but-wrong same-issuer attribution).
 *   4. ZERO name matches → `null` (issuer genuinely absent → RegisterCardForm
 *      creates it, ADR-190). We deliberately do NOT fall back to a cross-issuer
 *      (brand + last4) match: `(network, last4)` is NOT unique across issuers, so a
 *      missed issuer-name normalization for the user's card combined with another
 *      bank's card sharing the same network + last4 would silently attach the
 *      statement to the WRONG institution's accounts (wrong ccBalance liability +
 *      wrong ADR-196 payment leg). A safe "register this card" prompt beats a silent
 *      wrong-bank attribution. brand + last4 disambiguate ONLY WITHIN a matched
 *      issuer name (step 3), never as a standalone cross-issuer key.
 *
 * Returns the institution id, or `null` when nothing resolves. Deterministic:
 * first-in-list wins on a (shouldn't-happen) tie within a disambiguated set.
 */
function resolveCardInstitutionId(
  parse: StatementParse,
  institutions: readonly Institution[],
): string | null {
  const parseName = normalizeName(parse.bankName)
  const parseBrand = normalizeBrand(parse.network)
  const parseLast4 = normalizeLast4(parse.cardLast4)
  const cardInstitutions = institutions.filter((inst) => inst.type === 'card')

  // Institution-first: the card institutions matching the parse's issuer name.
  const nameMatches =
    parseName === ''
      ? []
      : cardInstitutions.filter((inst) => normalizeName(inst.name) === parseName)

  if (nameMatches.length === 1) {
    // One card per issuer (the common case): matched regardless of brand/last4.
    return nameMatches[0].id
  }

  if (nameMatches.length > 1) {
    // Two+ cards at the same issuer: name alone is ambiguous — disambiguate by the
    // precise (brand + last4) identity when the parse carries both. This is the ONLY
    // place brand + last4 are consulted, and only WITHIN a matched issuer name.
    if (parseBrand !== '' && parseLast4 !== '') {
      const preciseWithinName = nameMatches.filter(
        (inst) =>
          normalizeBrand(inst.brand) === parseBrand &&
          normalizeLast4(inst.last4) === parseLast4,
      )
      if (preciseWithinName.length === 1) return preciseWithinName[0].id
    }
    // No distinguishing identity (or still ambiguous): let the user resolve it.
    return null
  }

  // Zero name matches: the issuer is genuinely absent. Return null so the review
  // prompts "Register this card" (ADR-190). We do NOT attempt a cross-issuer
  // (brand + last4) match: that key is not unique across banks and could misroute a
  // statement to the wrong institution's accounts — a safe prompt beats a silent
  // wrong-bank attribution.
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
 * The institution is resolved issuer-name-first (ADR-184), with brand + last4
 * (ADR-190) used only to disambiguate two+ cards at the same issuer. When
 * `institutions` is omitted, a synthetic name-only list is derived from the
 * accounts so existing callers keep the ADR-184 behavior (name-first is now the
 * default, so the synthetic fallback works better than ever).
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
