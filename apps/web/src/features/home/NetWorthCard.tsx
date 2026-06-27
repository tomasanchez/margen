/**
 * Net-worth card for Home (ADR-122/123/127/133).
 *
 * Appended below the existing month-status hero (incremental Home, ADR-127). It
 * shows the user's total net worth in their display currency plus a per-account
 * breakdown: each account's NATIVE balance and, when it differs, its value in the
 * display currency. The card renders WHATEVER the net-worth API returns and never
 * computes FX client-side (ADR-133): when the backend has no USD row to derive a
 * MEP rate from it degrades to native and `balanceConverted === balance`, in
 * which case the card shows just the one balance and a calm note explaining the
 * total is summed natively.
 *
 * Money arrives as Decimal strings (ADR-025/034) and is parsed to numbers only
 * here for the shared formatter (ADR-102). A loading skeleton, a calm error
 * fallback (ADR-037), and an empty state (no accounts yet) are all handled.
 */

import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { SectionCard } from '../../components/SectionCard'
import { ErrorState } from '../../components/ErrorState'
import { formatCurrency } from '../../lib/format'
import type { Currency } from '../../mock/types'
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

/**
 * One breakdown row (ADR-134): institution name + currency chip on the left,
 * native balance (and the converted value when it differs) on the right. The row
 * is a clickable drilldown to the account's transactions
 * (`/transactions?account=<id>`, ADR-116/134) — a bare TanStack {@link Link} so
 * the typed `to` / `search` inference is checked against the route schema.
 */
function BreakdownRow({
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
          py: 1.25,
          borderBottom: '1px solid var(--mg-border)',
          '&:last-of-type': { borderBottom: 'none' },
        }}
      >
        <Box
          sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}
        >
          <Typography
            sx={{ fontSize: 14, fontWeight: 500 }}
            color="text.primary"
            noWrap
          >
            {account.institutionName}
          </Typography>
          <Chip
            label={account.currency}
            size="small"
            variant="outlined"
            sx={{ borderRadius: '8px', fontSize: 11, height: 20, flex: 'none' }}
          />
        </Box>
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
          {netWorth.accounts.map((account) => (
            <BreakdownRow
              key={account.id}
              account={account}
              displayCurrency={displayCurrency}
            />
          ))}
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
