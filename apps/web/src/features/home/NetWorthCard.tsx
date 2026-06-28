/**
 * Net-worth card for Home (ADR-122/123/127/133/134).
 *
 * Appended below the existing month-status hero (incremental Home, ADR-127). It
 * shows the user's total net worth in their display currency, computed
 * CLIENT-SIDE from each account's NATIVE balance + the LIVE MEP rate (ADR-133
 * amendment: net worth now converts via the live MEP from `fxClient` (ADR-044),
 * NOT the last-transaction rate baked into the backend's `balanceConverted` /
 * `total`). Those stale converted fields are intentionally IGNORED for display.
 *
 * The headline is `<displayCcy> <total>`, where `total = nativeDisplay +
 * convertedOther`: the sum of accounts already in the display currency plus the
 * other currency's native sum converted at the live MEP. When both currencies
 * are present a smaller secondary line decomposes the total:
 * `<native> + ~ <convertedOther> (<otherNative> at ARS <mep> / USD)` — the `~`
 * marks the approximate converted part.
 *
 * Below it is a breakdown GROUPED BY INSTITUTION (ADR-134): each institution gets
 * a header (name + a non-color type cue, ADR-019), its per-currency accounts with
 * each account's NATIVE balance (and, when it differs from the display currency,
 * its value converted at the SAME live MEP), and a per-institution subtotal in
 * the display currency — so the subtotals sum to the headline total.
 *
 * Degrade (ADR-037): the MEP rate is NEVER fabricated. While it loads the card
 * shows a skeleton; if it resolves to `null` the card degrades to native amounts
 * (no `~ converted`, no rate, a calm "MEP unavailable" note) and the breakdown
 * shows native balances only. When there is no other-currency account there is
 * nothing to convert, so the headline shows alone with no decomposition or note.
 *
 * Money arrives as Decimal strings (ADR-025/034) and is parsed to numbers only
 * here for the shared formatter (ADR-102). A loading skeleton, a calm error
 * fallback (ADR-037), and an empty state (no accounts yet) are all handled.
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Collapse from '@mui/material/Collapse'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { SectionCard } from '../../components/SectionCard'
import { ErrorState } from '../../components/ErrorState'
import { formatARS, formatCurrency } from '../../lib/format'
import { useMepRate } from './queries'
import type { AccountType, Currency } from '../../mock/types'
import type { NetWorth, NetWorthAccount } from '../../api/accountsClient'

/** Shared class for the clickable net-worth breakdown rows (account drilldown). */
const breakdownRowLinkClass = 'mg-networth-row-link'

/** Parse a Decimal string to a finite number for the formatter (0 on garbage). */
function num(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Narrow a backend currency string to {@link Currency} (default ARS). */
function asCurrency(value: string): Currency {
  return value === 'USD' ? 'USD' : 'ARS'
}

/** Narrow a backend institution/account `type` string to {@link AccountType}. */
function asAccountType(value: string): AccountType {
  return value === 'cash' || value === 'card' || value === 'wallet'
    ? value
    : 'bank'
}

/** Sort key for currency ordering within an institution: ARS before USD. */
function currencyRank(currency: Currency): number {
  return currency === 'ARS' ? 0 : 1
}

/** The non-display currency (the one we have to convert at the live MEP). */
function otherCurrencyOf(displayCurrency: Currency): Currency {
  return displayCurrency === 'USD' ? 'ARS' : 'USD'
}

/** A usable live MEP rate: finite and positive, else `null` (degrade). */
function usableMep(mep: number | null | undefined): number | null {
  return typeof mep === 'number' && Number.isFinite(mep) && mep > 0 ? mep : null
}

/**
 * Convert `amount` from `from` currency into `displayCurrency` at the live MEP
 * (ARS per USD). Same currency → returned as-is. ARS→USD divides by the MEP;
 * USD→ARS multiplies. Returns `null` when no usable rate exists (degrade — we
 * never fabricate one, ADR-133).
 */
function convertAtMep(
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
 * The client-side net-worth decomposition (ADR-133 amendment): native amount in
 * the display currency, the other currency's native sum, and that sum converted
 * at the live MEP. `convertedOther`/`total` are `null` when there is an
 * other-currency balance but no usable rate (degrade-to-native).
 */
interface Decomposition {
  /** Sum of native `balance` across accounts already in the display currency. */
  nativeDisplay: number
  /** The non-display currency. */
  otherCurrency: Currency
  /** Sum of native `balance` across other-currency accounts. */
  otherNative: number
  /** Whether any other-currency balance exists (drives the decomposition line). */
  hasOther: boolean
  /** `otherNative` converted to the display currency, or `null` when no rate. */
  convertedOther: number | null
  /** `nativeDisplay + convertedOther`, or `null` when conversion was skipped. */
  total: number | null
}

/**
 * Compute the net-worth decomposition from the NATIVE balances + the live MEP
 * (ADR-133 amendment), ignoring the backend's stale `balanceConverted`/`total`.
 * Pure and unit-testable; the breakdown reuses {@link convertAtMep} so it stays
 * consistent with this total.
 */
function decompose(
  accounts: NetWorthAccount[],
  displayCurrency: Currency,
  mep: number | null,
): Decomposition {
  const other = otherCurrencyOf(displayCurrency)
  let nativeDisplay = 0
  let otherNative = 0
  for (const account of accounts) {
    const value = num(account.balance)
    if (asCurrency(account.currency) === displayCurrency) nativeDisplay += value
    else otherNative += value
  }
  const hasOther = accounts.some(
    (a) => asCurrency(a.currency) === other,
  )
  const convertedOther = hasOther
    ? convertAtMep(otherNative, other, displayCurrency, mep)
    : 0
  const total = convertedOther == null ? null : nativeDisplay + convertedOther
  return {
    nativeDisplay,
    otherCurrency: other,
    otherNative,
    hasOther,
    convertedOther,
    total,
  }
}

/**
 * The headline + currency decomposition (ADR-133 amendment). The big total is in
 * the display currency; when both currencies are present a smaller secondary
 * line reads `<native> + ~ <converted> (<otherNative> at ARS <mep> / USD)` — the
 * `~` marking the converted (approximate) part. When the MEP is unavailable the
 * converted part and rate are omitted and a calm note is shown; when there is no
 * other-currency balance the headline stands alone.
 */
function NetWorthHeadline({
  decomp,
  displayCurrency,
  mep,
}: {
  decomp: Decomposition
  displayCurrency: Currency
  mep: number | null
}) {
  const { t } = useTranslation('accounts')
  // Headline value: the converted total when a rate exists, else the native
  // display-currency portion (we never invent a rate, ADR-133).
  const headlineValue = decomp.total ?? decomp.nativeDisplay

  const showConverted =
    decomp.hasOther && decomp.convertedOther != null && mep != null
  const showNoRate = decomp.hasOther && (decomp.convertedOther == null || mep == null)

  const nativeStr = formatCurrency(decomp.nativeDisplay, displayCurrency)
  const otherStr = formatCurrency(decomp.otherNative, decomp.otherCurrency)

  return (
    <Box>
      <Typography sx={{ fontSize: 12.5 }} color="text.secondary">
        {t('netWorth.totalLabel')}
      </Typography>
      <Typography
        sx={{
          fontSize: { xs: 26, md: 30 },
          fontWeight: 700,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.01em',
        }}
        color="text.primary"
      >
        {formatCurrency(headlineValue, displayCurrency)}
      </Typography>

      {showConverted ? (
        <Typography
          sx={{ fontSize: 12.5, mt: 0.25, fontVariantNumeric: 'tabular-nums' }}
          color="text.secondary"
        >
          {t('netWorth.decomposition', {
            native: nativeStr,
            converted: formatCurrency(decomp.convertedOther ?? 0, displayCurrency),
            other: otherStr,
            rate: t('netWorth.mepUnit', { rate: formatARS(mep) }),
          })}
        </Typography>
      ) : null}

      {showNoRate ? (
        <>
          <Typography
            sx={{ fontSize: 12.5, mt: 0.25, fontVariantNumeric: 'tabular-nums' }}
            color="text.secondary"
          >
            {t('netWorth.decompositionNoRate', {
              native: nativeStr,
              other: otherStr,
            })}
          </Typography>
          <Typography
            sx={{ fontSize: 12, mt: 0.25 }}
            color="text.secondary"
            role="note"
          >
            {t('netWorth.mepUnavailable')}
          </Typography>
        </>
      ) : null}
    </Box>
  )
}

/**
 * One institution's grouped breakdown (ADR-134): its accounts (currency-ordered)
 * plus a `subtotal` in the display currency — the sum of each account's value
 * converted at the live MEP (ADR-133 amendment), so the subtotals sum to the
 * headline total. `subtotal` is `null` when an other-currency account couldn't
 * be converted (degrade), in which case the subtotal line is hidden.
 */
interface InstitutionGroup {
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
function groupByInstitution(
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
    group.accounts.sort(
      (a, b) => currencyRank(asCurrency(a.currency)) - currencyRank(asCurrency(b.currency)),
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
 * One per-currency account row inside an institution group. The clickable
 * drilldown to the account's transactions (`/transactions?account=<id>`,
 * ADR-116/134) — a bare TanStack {@link Link} so the typed `to` / `search`
 * inference is checked against the route schema — shows the native balance and,
 * when the account is in another currency and a live MEP exists, a secondary
 * `≈ converted` line (computed at the SAME live rate as the headline, ADR-133).
 */
function AccountRow({
  account,
  displayCurrency,
  mep,
}: {
  account: NetWorthAccount
  displayCurrency: Currency
  mep: number | null
}) {
  const { t } = useTranslation('accounts')
  const nativeCurrency = asCurrency(account.currency)
  const native = num(account.balance)
  const converted = convertAtMep(native, nativeCurrency, displayCurrency, mep)
  // Show the converted line only when the account is in another currency AND a
  // live MEP let us convert it (ADR-133 degrade: no rate → native only).
  const showConverted = nativeCurrency !== displayCurrency && converted != null

  return (
    <Link
      to="/transactions"
      search={{ account: account.id, month: 'all' as const }}
      aria-label={t('netWorth.drilldownAria', {
        institution: account.institutionName,
        currency: account.currency,
      })}
      className={breakdownRowLinkClass}
      style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1.5,
          py: 1,
          pl: 1,
          borderBottom: '1px solid var(--mg-border)',
          '&:last-of-type': { borderBottom: 'none' },
        }}
      >
        <Chip
          label={account.currency}
          size="small"
          variant="outlined"
          sx={{ borderRadius: '8px', fontSize: 11, height: 20, flex: 'none' }}
        />
        <Box sx={{ textAlign: 'right', flex: 'none' }}>
          <Typography
            sx={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
            color="text.primary"
          >
            {formatCurrency(native, nativeCurrency)}
          </Typography>
          {showConverted ? (
            <Typography
              sx={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
              color="text.secondary"
            >
              {t('netWorth.converted', {
                amount: formatCurrency(converted ?? 0, displayCurrency),
              })}
            </Typography>
          ) : null}
        </Box>
      </Box>
    </Link>
  )
}

/**
 * One institution block (ADR-134): a header (name + a non-color type cue,
 * ADR-019) over the institution's per-currency account rows, capped by a subtotal
 * in the display currency. The header is an `h4` so the breakdown has a real
 * heading structure under the card title; the subtotal carries an accessible
 * label naming the institution + amount. The subtotal is hidden when it couldn't
 * be computed at the live MEP (degrade-to-native, ADR-133).
 */
function InstitutionBlock({
  group,
  displayCurrency,
  mep,
}: {
  group: InstitutionGroup
  displayCurrency: Currency
  mep: number | null
}) {
  const { t } = useTranslation('accounts')
  return (
    <Box
      component="section"
      aria-label={group.institutionName}
      sx={{
        py: 1,
        borderBottom: '1px solid var(--mg-border)',
        '&:last-of-type': { borderBottom: 'none' },
      }}
    >
      <Box
        sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}
      >
        <Typography
          component="h4"
          sx={{ fontSize: 14, fontWeight: 600, m: 0 }}
          color="text.primary"
          noWrap
        >
          {group.institutionName}
        </Typography>
        <Chip
          label={t(`type.${group.type}`)}
          size="small"
          variant="outlined"
          sx={{ borderRadius: '8px', fontSize: 11, height: 20, flex: 'none' }}
        />
      </Box>

      <Box sx={{ mt: 0.5 }}>
        {group.accounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            displayCurrency={displayCurrency}
            mep={mep}
          />
        ))}
      </Box>

      {group.subtotal != null ? (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 1.5,
            mt: 0.5,
            pl: 1,
          }}
        >
          <Typography sx={{ fontSize: 12 }} color="text.secondary">
            {t('netWorth.subtotalLabel')}
          </Typography>
          <Typography
            sx={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
            color="text.primary"
            aria-label={t('netWorth.subtotalAria', {
              institution: group.institutionName,
              amount: formatCurrency(group.subtotal, displayCurrency),
            })}
          >
            {formatCurrency(group.subtotal, displayCurrency)}
          </Typography>
        </Box>
      ) : null}
    </Box>
  )
}

export interface NetWorthCardProps {
  /** The net-worth read model, or undefined while loading. */
  netWorth: NetWorth | undefined
  /** Whether the net-worth query is pending. */
  loading: boolean
  /** Whether the net-worth query errored (renders the calm fallback). */
  isError?: boolean
  /** Retry handler for the error state. */
  onRetry?: () => void
}

export function NetWorthCard({
  netWorth,
  loading,
  isError = false,
  onRetry,
}: NetWorthCardProps) {
  const { t } = useTranslation('accounts')
  // Live MEP rate (ADR-044/133): cached for a few minutes, cancellable. We never
  // fabricate a rate — `null` (failure) and `isPending` (loading) each degrade.
  const mepQuery = useMepRate()
  // Local-only expand state (persistence not required); default COLLAPSED for a
  // compact summary card the user opens for detail.
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsRegionId = useId()

  if (isError) {
    return (
      <ErrorState
        title={t('netWorth.errorTitle')}
        description={t('netWorth.errorDescription')}
        onRetry={onRetry}
      />
    )
  }

  // Wait on BOTH the net-worth read AND the live MEP so the headline total is
  // never shown at the wrong (pre-conversion) value (ADR-133/037).
  if (loading || !netWorth || mepQuery.isPending) {
    return (
      <SectionCard title={t('netWorth.title')}>
        <Skeleton variant="text" width={180} height={40} />
        <Skeleton variant="rounded" height={48} sx={{ mt: 1.5, borderRadius: '10px' }} />
        <Skeleton variant="rounded" height={48} sx={{ mt: 1, borderRadius: '10px' }} />
      </SectionCard>
    )
  }

  const displayCurrency = asCurrency(netWorth.currency)
  // A usable live MEP, or null on failure / unusable value → degrade-to-native.
  const mep = usableMep(mepQuery.data)
  // Decomposition + groups both convert at the SAME live MEP, so the breakdown
  // subtotals sum to the headline total (ADR-133 amendment).
  const decomp = decompose(netWorth.accounts, displayCurrency, mep)
  const groups = groupByInstitution(netWorth.accounts, displayCurrency, mep)

  return (
    <SectionCard title={t('netWorth.title')} subtitle={t('netWorth.subtitle')}>
      <NetWorthHeadline
        decomp={decomp}
        displayCurrency={displayCurrency}
        mep={mep}
      />

      {netWorth.accounts.length === 0 ? (
        <Typography
          sx={{ fontSize: 13.5, mt: 2 }}
          color="text.secondary"
          role="status"
        >
          {t('netWorth.empty')}
        </Typography>
      ) : (
        <Box sx={{ mt: 1.5 }}>
          <Button
            type="button"
            variant="text"
            size="small"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
            aria-controls={detailsRegionId}
            endIcon={
              <ExpandMoreIcon
                sx={{
                  transition: 'transform 150ms',
                  transform: detailsOpen ? 'rotate(180deg)' : 'none',
                  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
                }}
              />
            }
            sx={{
              textTransform: 'none',
              fontWeight: 600,
              fontSize: 13,
              px: 1,
              minHeight: 36,
            }}
          >
            {detailsOpen ? t('netWorth.hideDetails') : t('netWorth.showDetails')}
          </Button>
          <Collapse in={detailsOpen} unmountOnExit>
            <Box
              id={detailsRegionId}
              role="region"
              aria-label={t('netWorth.detailsRegionAria')}
              sx={{ mt: 0.5 }}
            >
              {groups.map((group) => (
                <InstitutionBlock
                  key={group.institutionId}
                  group={group}
                  displayCurrency={displayCurrency}
                  mep={mep}
                />
              ))}
            </Box>
          </Collapse>
        </Box>
      )}
    </SectionCard>
  )
}

export default NetWorthCard
