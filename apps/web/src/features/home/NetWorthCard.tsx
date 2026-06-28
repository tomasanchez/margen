/**
 * Net-worth card for Home (ADR-122/123/127/133/134).
 *
 * Appended below the existing month-status hero (incremental Home, ADR-127). It
 * shows the user's total net worth in their display currency, then a breakdown
 * GROUPED BY INSTITUTION (ADR-134): each institution gets a header (name + a
 * non-color type cue, ADR-019), its per-currency accounts listed underneath with
 * each account's NATIVE balance (and, when it differs, its value in the display
 * currency), and a per-institution subtotal in the display currency. The card
 * renders WHATEVER the net-worth API returns and never computes FX client-side
 * (ADR-133): when the backend has no USD row to derive a MEP rate from it degrades
 * to native and `balanceConverted === balance`, in which case the row shows just
 * the one balance and a calm note explains the total is summed natively. The
 * subtotal merely SUMS the already-converted `balanceConverted` values — no FX is
 * derived here.
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

/**
 * The user's real USD holdings and, when a rate can be derived from the response,
 * their approximate value in ARS (ADR-123/133). `arsApprox`/`rate` are null when
 * no cross-currency account lets us derive the display-per-native rate — we never
 * fabricate one (ADR-133 degrade-to-native), so the callout shows USD only.
 */
interface UsdHoldings {
  /** Sum of native `balance` across USD accounts (actual dollars held). */
  realUsd: number
  /** That USD total valued in ARS at the derived rate, or null when none. */
  arsApprox: number | null
  /** The ARS-per-USD rate used for `arsApprox`, or null when none. */
  rate: number | null
}

/**
 * Derive USD holdings + an ARS approximation from the net-worth response
 * (ADR-123/133) WITHOUT fabricating an FX rate. The rate is recovered from the
 * response's own already-converted balances: for any account whose native
 * `currency` differs from the display `currency`, `balanceConverted / balance`
 * is the display-per-native rate.
 *
 * - Display = ARS: ARS value of USD = sum of `balanceConverted` for USD accounts
 *   (already in ARS); the implied rate = that sum / realUsd.
 * - Display = USD: recover ARS-per-USD from an ARS account
 *   (`balance / balanceConverted`) and multiply realUsd by it.
 *
 * Returns null when there are no USD accounts (callout hidden). `arsApprox`/`rate`
 * stay null when no usable cross-currency account exists (degrade-to-native).
 */
function deriveUsdHoldings(
  accounts: NetWorthAccount[],
  displayCurrency: Currency,
): UsdHoldings | null {
  const usdAccounts = accounts.filter((a) => asCurrency(a.currency) === 'USD')
  if (usdAccounts.length === 0) return null

  const realUsd = usdAccounts.reduce((sum, a) => sum + num(a.balance), 0)

  // No dollars actually held (all-zero USD rows): nothing meaningful to convert.
  if (realUsd <= 0) return { realUsd, arsApprox: null, rate: null }

  if (displayCurrency === 'ARS') {
    // ARS value of USD holdings is already converted in each USD account
    // (ADR-133); a degraded response leaves balanceConverted === balance, in
    // which case there is no real ARS figure to sum, so we omit the approximation.
    const arsSum = usdAccounts.reduce((sum, a) => {
      const converted = num(a.balanceConverted)
      return a.balanceConverted !== a.balance ? sum + converted : sum
    }, 0)
    if (arsSum <= 0) return { realUsd, arsApprox: null, rate: null }
    return { realUsd, arsApprox: arsSum, rate: arsSum / realUsd }
  }

  // Display = USD: recover ARS-per-USD from any ARS account that was converted
  // (balance in ARS / balanceConverted in USD). Skip degraded/zero rows.
  for (const account of accounts) {
    if (asCurrency(account.currency) !== 'ARS') continue
    if (account.balanceConverted === account.balance) continue
    const ars = num(account.balance)
    const usd = num(account.balanceConverted)
    if (ars > 0 && usd > 0) {
      const rate = ars / usd
      return { realUsd, arsApprox: realUsd * rate, rate }
    }
  }
  // No cross-currency ARS account to derive the rate from: degrade to USD only.
  return { realUsd, arsApprox: null, rate: null }
}

/**
 * Calm USD-holdings callout below the total (ADR-013/037): the real dollars held,
 * and — when a rate was derivable from the response (ADR-133) — their approximate
 * ARS value with the rate spelled out. Tabular-nums, localized via the shared
 * formatter (ADR-102); the ARS approximation is omitted when no rate exists.
 */
function UsdHoldingsCallout({ holdings }: { holdings: UsdHoldings }) {
  const { t } = useTranslation('accounts')
  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        columnGap: 1,
        rowGap: 0.25,
        mt: 1,
      }}
    >
      <Typography sx={{ fontSize: 12.5 }} color="text.secondary">
        {t('netWorth.usdHoldingsLabel')}
      </Typography>
      <Typography
        sx={{ fontSize: 13.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
        color="text.primary"
      >
        {formatCurrency(holdings.realUsd, 'USD')}
      </Typography>
      {holdings.arsApprox != null && holdings.rate != null ? (
        <Typography
          sx={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
          color="text.secondary"
        >
          {t('netWorth.usdHoldingsApprox', {
            amount: formatCurrency(holdings.arsApprox, 'ARS'),
            rate: `AR$ ${formatARS(holdings.rate)}`,
          })}
        </Typography>
      ) : null}
    </Box>
  )
}

/**
 * One institution's grouped breakdown (ADR-134): its accounts (currency-ordered)
 * plus a `subtotal` in the display currency — the sum of the group's already
 * converted `balanceConverted` values (ADR-133: no FX derived here).
 */
interface InstitutionGroup {
  institutionId: string
  institutionName: string
  type: AccountType
  accounts: NetWorthAccount[]
  subtotal: number
}

/**
 * Group the flat net-worth breakdown by `institutionId` (ADR-134, client-side —
 * no backend change). Institutions are ordered by subtotal DESC (name as the
 * tie-break); accounts within an institution are ordered ARS before USD.
 */
function groupByInstitution(accounts: NetWorthAccount[]): InstitutionGroup[] {
  const byId = new Map<string, InstitutionGroup>()
  for (const account of accounts) {
    const existing = byId.get(account.institutionId)
    if (existing) {
      existing.accounts.push(account)
      existing.subtotal += num(account.balanceConverted)
    } else {
      byId.set(account.institutionId, {
        institutionId: account.institutionId,
        institutionName: account.institutionName,
        type: asAccountType(account.type),
        accounts: [account],
        subtotal: num(account.balanceConverted),
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
      b.subtotal - a.subtotal ||
      a.institutionName.localeCompare(b.institutionName),
  )
  return groups
}

/**
 * One per-currency account row inside an institution group. The clickable
 * drilldown to the account's transactions (`/transactions?account=<id>`,
 * ADR-116/134) — a bare TanStack {@link Link} so the typed `to` / `search`
 * inference is checked against the route schema — shows the native balance and,
 * when conversion actually happened, a secondary `≈ converted` line.
 */
function AccountRow({
  account,
  displayCurrency,
}: {
  account: NetWorthAccount
  displayCurrency: Currency
}) {
  const { t } = useTranslation('accounts')
  const nativeCurrency = asCurrency(account.currency)
  const native = num(account.balance)
  const converted = num(account.balanceConverted)
  // Show the converted line only when conversion actually happened (ADR-133): a
  // degraded backend returns balanceConverted === balance, so there is nothing
  // extra to show. Also skip it when the account is already in display currency.
  const showConverted =
    nativeCurrency !== displayCurrency && account.balanceConverted !== account.balance

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
                amount: formatCurrency(converted, displayCurrency),
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
 * label naming the institution + amount.
 */
function InstitutionBlock({
  group,
  displayCurrency,
}: {
  group: InstitutionGroup
  displayCurrency: Currency
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
          />
        ))}
      </Box>

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

  if (loading || !netWorth) {
    return (
      <SectionCard title={t('netWorth.title')}>
        <Skeleton variant="text" width={180} height={40} />
        <Skeleton variant="rounded" height={48} sx={{ mt: 1.5, borderRadius: '10px' }} />
        <Skeleton variant="rounded" height={48} sx={{ mt: 1, borderRadius: '10px' }} />
      </SectionCard>
    )
  }

  const displayCurrency = asCurrency(netWorth.currency)
  const total = num(netWorth.total)
  // Grouping is a cheap pure pass over the breakdown; computing it inline avoids
  // a conditional hook after the loading/error early returns above.
  const groups = groupByInstitution(netWorth.accounts)
  // USD holdings + (when derivable) their ARS approximation — null when the user
  // holds no dollars, in which case the callout is hidden (ADR-123/133).
  const usdHoldings = deriveUsdHoldings(netWorth.accounts, displayCurrency)
  // The total is summed natively (no conversion) when EVERY account already
  // reports its converted balance equal to its native one (ADR-133 degrade).
  const degraded =
    netWorth.accounts.length > 0 &&
    netWorth.accounts.every((a) => a.balanceConverted === a.balance) &&
    netWorth.accounts.some((a) => asCurrency(a.currency) !== displayCurrency)

  return (
    <SectionCard title={t('netWorth.title')} subtitle={t('netWorth.subtitle')}>
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
          {formatCurrency(total, displayCurrency)}
        </Typography>
        {usdHoldings ? <UsdHoldingsCallout holdings={usdHoldings} /> : null}
      </Box>

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
                />
              ))}
            </Box>
          </Collapse>
        </Box>
      )}

      {degraded ? (
        <Typography
          sx={{ fontSize: 12, mt: 1.5 }}
          color="text.secondary"
          role="note"
        >
          {t('netWorth.degradeNote')}
        </Typography>
      ) : null}
    </SectionCard>
  )
}

export default NetWorthCard
