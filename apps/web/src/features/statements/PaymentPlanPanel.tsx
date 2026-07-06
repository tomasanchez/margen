/**
 * Per-currency card-payment plan panel (ADR-188/189).
 *
 * A calm, suggest-only summary shown in the statement import review between the
 * header strip and the account-attach section. For each currency present in the
 * kept lines it shows NEED vs AVAILABLE in native units and either a "Sufficient"
 * badge (the main / pay-from account covers the balance) or a concrete ordered
 * greedy transfer list ("Move USD 4,000 from Deel → Galicia, then USD 1,990 from
 * Payoneer") plus any residual gap that can't be closed (ADR-189). The main
 * pay-from account is a per-currency Select the user can change; the whole plan
 * recomputes live as lines are toggled or the main account changes (the parent
 * owns the plan + selection state, so this component is a pure presenter).
 *
 * Money is per-currency, native, never summed across ARS + USD or re-converted
 * (ADR-133/188); figures format through `lib/format` (ADR-102). When today is on
 * or before the statement due date the panel carries a calm "Pending — due {date}"
 * label (computed, no writes, ADR-188).
 *
 * Accessibility (ADR-019): the panel is a labelled `region` with an `aria-live`
 * body so a screen reader announces the recomputed plan; status is conveyed with
 * real words ("Sufficient" / "Shortfall …" / the transfer sentences), never color
 * alone; the main-account Select is a native, labelled control.
 */

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import EventAvailableRoundedIcon from '@mui/icons-material/EventAvailableRounded'
import SwapHorizRoundedIcon from '@mui/icons-material/SwapHorizRounded'
import { formatCurrency, isoToDispDateLike } from './format'
import type { Currency } from '../../mock/types'
import type {
  CurrencyPlan,
  FundingAccount,
  PaymentPlan,
} from './paymentPlan'

/** Uppercase eyebrow used by the panel facts (mirrors the header strip). */
function FactLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      variant="overline"
      component="span"
      sx={{ display: 'block', color: 'text.disabled', lineHeight: 1.4 }}
    >
      {children}
    </Typography>
  )
}

/** One fact (label + native money value). */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <FactLabel>{label}</FactLabel>
      <Typography sx={{ fontSize: 13.5, color: 'text.primary' }}>
        {value}
      </Typography>
    </Box>
  )
}

/** The per-currency main / pay-from account Select (ADR-189). */
function MainAccountSelect({
  currency,
  options,
  value,
  disabled,
  onChange,
}: {
  currency: Currency
  options: readonly FundingAccount[]
  value: string
  disabled: boolean
  onChange: (accountId: string) => void
}) {
  const { t } = useTranslation('statements')
  const labelId = useId()
  const label = t('review.plan.mainLabel', { currency })
  return (
    <FormControl size="small" sx={{ minWidth: 220 }} disabled={disabled}>
      <InputLabel id={labelId}>{label}</InputLabel>
      <Select
        labelId={labelId}
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        sx={{ borderRadius: '10px', bgcolor: 'var(--mg-paper)', fontSize: 13 }}
      >
        {options.map((account) => (
          <MenuItem key={account.id} value={account.id}>
            {`${account.institutionName} · ${formatCurrency(
              account.balance,
              account.currency,
            )}`}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  )
}

/** One currency's plan block: need/available facts + badge or transfer list. */
function CurrencyPlanBlock({
  plan,
  options,
  disabled,
  onMainChange,
}: {
  plan: CurrencyPlan
  options: readonly FundingAccount[]
  disabled: boolean
  onMainChange: (currency: Currency, accountId: string) => void
}) {
  const { t } = useTranslation('statements')
  const main = plan.main
  const shortfall = Math.max(plan.need - (main ? main.balance : 0), 0)
  return (
    <Box
      sx={{
        p: 1.75,
        borderRadius: 2,
        border: '1px solid var(--mg-border-2)',
        bgcolor: 'var(--mg-paper)',
      }}
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        useFlexGap
        sx={{ flexWrap: 'wrap', alignItems: 'flex-start' }}
      >
        <Chip
          label={plan.currency}
          size="small"
          variant="outlined"
          sx={{ borderRadius: '8px', fontSize: 12, flex: 'none', mt: 0.25 }}
        />
        <Fact
          label={t('review.plan.need')}
          value={formatCurrency(plan.need, plan.currency)}
        />
        <Fact
          label={t('review.plan.available')}
          value={formatCurrency(plan.available, plan.currency)}
        />
        {options.length > 0 ? (
          <Box sx={{ ml: { sm: 'auto' } }}>
            <MainAccountSelect
              currency={plan.currency}
              options={options}
              value={plan.main?.id ?? ''}
              disabled={disabled}
              onChange={(id) => onMainChange(plan.currency, id)}
            />
          </Box>
        ) : null}
      </Stack>

      <Box sx={{ mt: 1.5 }}>
        {main === null ? (
          <Typography sx={{ fontSize: 13, color: 'text.secondary' }} role="note">
            {t('review.plan.noAccounts', { currency: plan.currency })}
          </Typography>
        ) : plan.sufficient ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <CheckCircleOutlineRoundedIcon
              aria-hidden
              sx={{ fontSize: 18, color: 'success.main', flex: 'none' }}
            />
            <Typography sx={{ fontSize: 13, color: 'text.primary' }}>
              <Box
                component="span"
                sx={{ fontWeight: 600, color: 'success.main', mr: 0.75 }}
              >
                {t('review.plan.sufficient')}
              </Box>
              {t('review.plan.sufficientDetail', {
                account: main.institutionName,
                currency: plan.currency,
              })}
            </Typography>
          </Stack>
        ) : (
          <Box>
            <Typography
              sx={{
                fontSize: 12.5,
                fontWeight: 600,
                color: 'warning.main',
                mb: 0.75,
              }}
            >
              {t('review.plan.shortfall', {
                amount: formatCurrency(shortfall, plan.currency),
              })}
            </Typography>
            {plan.transfers.length > 0 ? (
              <Box>
                <FactLabel>{t('review.plan.transfersHeading')}</FactLabel>
                <Stack component="ol" spacing={0.5} sx={{ m: 0, pl: 0, listStyle: 'none' }}>
                  {plan.transfers.map((leg) => (
                    <Stack
                      key={leg.from.id}
                      component="li"
                      direction="row"
                      spacing={0.75}
                      sx={{ alignItems: 'center' }}
                    >
                      <SwapHorizRoundedIcon
                        aria-hidden
                        sx={{ fontSize: 16, color: 'text.disabled', flex: 'none' }}
                      />
                      <Typography sx={{ fontSize: 13, color: 'text.primary' }}>
                        {t('review.plan.transferLeg', {
                          amount: formatCurrency(leg.amount, plan.currency),
                          from: leg.from.institutionName,
                          main: main.institutionName,
                        })}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
              </Box>
            ) : null}
            {plan.residualGap > 0 ? (
              <Typography
                sx={{ mt: 0.75, fontSize: 12.5, color: 'error.main' }}
                role="note"
              >
                {t('review.plan.residual', {
                  amount: formatCurrency(plan.residualGap, plan.currency),
                  currency: plan.currency,
                })}
              </Typography>
            ) : null}
          </Box>
        )}
      </Box>
    </Box>
  )
}

/**
 * The one-click scheduling lifecycle (ADR-191). `idle` before the user acts,
 * `scheduling` while the legs are being POSTed, `done` after every leg landed,
 * `error` when a leg failed (the user can retry — the mutation is idempotent
 * enough that a re-run just creates the remaining/duplicate legs; we surface the
 * calm error rather than silently half-applying).
 */
export type ScheduleState = 'idle' | 'scheduling' | 'done' | 'error'

/** The footer that executes the plan as future-dated transfers (ADR-191). */
function ScheduleFooter({
  state,
  onSchedule,
}: {
  state: ScheduleState
  onSchedule: () => void
}) {
  const { t } = useTranslation('statements')
  if (state === 'done') {
    return (
      <Stack
        direction="row"
        spacing={1}
        sx={{ mt: 1.5, alignItems: 'center' }}
        role="status"
      >
        <CheckCircleOutlineRoundedIcon
          aria-hidden
          sx={{ fontSize: 18, color: 'success.main', flex: 'none' }}
        />
        <Typography sx={{ fontSize: 13, color: 'text.primary' }}>
          <Box
            component="span"
            sx={{ fontWeight: 600, color: 'success.main', mr: 0.75 }}
          >
            {t('review.plan.scheduled')}
          </Box>
          {t('review.plan.scheduledDetail')}
        </Typography>
      </Stack>
    )
  }
  const busy = state === 'scheduling'
  return (
    <Box sx={{ mt: 1.5 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
        useFlexGap
      >
        <Button
          type="button"
          variant="contained"
          color="primary"
          onClick={onSchedule}
          disabled={busy}
          startIcon={
            busy ? (
              <CircularProgress size={15} thickness={5} color="inherit" />
            ) : (
              <EventAvailableRoundedIcon fontSize="small" />
            )
          }
          sx={{ textTransform: 'none', fontWeight: 600, flex: 'none' }}
        >
          {busy ? t('review.plan.scheduling') : t('review.plan.schedule')}
        </Button>
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
          {t('review.plan.scheduleHint')}
        </Typography>
      </Stack>
      {state === 'error' ? (
        <Typography role="alert" sx={{ mt: 1, fontSize: 12.5, color: 'error.main' }}>
          {t('review.plan.scheduleError')}
        </Typography>
      ) : null}
    </Box>
  )
}

export interface PaymentPlanPanelProps {
  /** The computed per-currency plan (ADR-188/189). */
  plan: PaymentPlan
  /** The user's non-card funding accounts, for the per-currency main-account picker. */
  fundingAccounts: readonly FundingAccount[]
  /**
   * The statement due date (ISO `YYYY-MM-DD`) to label as "Pending — due …" when
   * today is on/before it, or null when the plan is not pending (ADR-188).
   */
  pendingDue: string | null
  /** Whether the surrounding import is in flight (disables the main-account picker). */
  disabled: boolean
  /** Change the main / pay-from account for a currency (ADR-189). */
  onMainChange: (currency: Currency, accountId: string) => void
  /**
   * Whether the whole plan can be executed as scheduled transfers (ADR-191) — a
   * fully-coverable shortfall with no residual gap. When false the panel stays
   * suggest-only (no Schedule button); the residual note guides the user instead.
   */
  canSchedule?: boolean
  /** The one-click scheduling lifecycle state (ADR-191). Defaults to `idle`. */
  scheduleState?: ScheduleState
  /** Execute the suggested legs as future-dated transfers (ADR-191). */
  onSchedule?: () => void
}

export function PaymentPlanPanel({
  plan,
  fundingAccounts,
  pendingDue,
  disabled,
  onMainChange,
  canSchedule = false,
  scheduleState = 'idle',
  onSchedule,
}: PaymentPlanPanelProps) {
  const { t } = useTranslation('statements')
  const headingId = useId()
  // Nothing to plan (no kept lines of any currency) → render nothing.
  if (plan.currencies.length === 0) return null

  // The Schedule affordance shows only when the plan is fully coverable (no
  // residual gap) and there is at least one leg to move (ADR-191). Once done it
  // stays visible as a calm "scheduled" confirmation.
  const showSchedule =
    onSchedule !== undefined &&
    (scheduleState === 'done' || (canSchedule && !disabled))

  return (
    <Box
      component="section"
      role="region"
      aria-label={t('review.plan.regionAria')}
      sx={{
        px: 2,
        py: 1.75,
        mb: 2,
        bgcolor: 'var(--mg-paper)',
        border: '1px solid var(--mg-border-2)',
        borderRadius: 2.5,
      }}
    >
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          gap: 1,
          mb: 1.5,
        }}
      >
        <Typography
          id={headingId}
          component="h3"
          sx={{ fontSize: 13.5, fontWeight: 600, color: 'text.primary' }}
        >
          {t('review.plan.title')}
        </Typography>
        {pendingDue ? (
          <Chip
            label={t('review.plan.pending', { date: isoToDispDateLike(pendingDue) })}
            size="small"
            sx={{
              height: 20,
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--mg-gold)',
              bgcolor: 'color-mix(in srgb, var(--mg-gold) 14%, transparent)',
              border: '1px solid color-mix(in srgb, var(--mg-gold) 30%, transparent)',
            }}
          />
        ) : null}
        <Typography
          sx={{ fontSize: 12, color: 'text.secondary', width: '100%' }}
        >
          {t('review.plan.subtitle')}
        </Typography>
      </Box>

      {/* Live region: the recomputed plan (line toggles / main-account change) is
          announced to assistive tech (ADR-019). */}
      <Stack spacing={1.5} aria-live="polite">
        {plan.currencies.map((currencyPlan) => (
          <CurrencyPlanBlock
            key={currencyPlan.currency}
            plan={currencyPlan}
            options={fundingAccounts.filter(
              (a) => a.type !== 'card' && a.currency === currencyPlan.currency,
            )}
            disabled={disabled}
            onMainChange={onMainChange}
          />
        ))}
      </Stack>

      {/* One-click execution (ADR-191): schedule the suggested legs as
          future-dated (pending-until-due) transfers. Suggest-then-execute — the
          user clicks to confirm; shown only when the plan fully covers the
          shortfall (no residual gap). */}
      {showSchedule && onSchedule ? (
        <ScheduleFooter state={scheduleState} onSchedule={onSchedule} />
      ) : null}
    </Box>
  )
}

export default PaymentPlanPanel
