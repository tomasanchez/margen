/**
 * <SavingsSection> — pay-yourself-first saving allocations (ADR-138, ADR-143,
 * ADR-037, ADR-019).
 *
 * A profile picker (Conservative / Balanced / Aggressive) that, on selection,
 * applies the preset via `POST /budgets/apply-profile`; the returned saving rows
 * (bucket label + % of net income + ARS amount) render read-mostly below. When
 * the preset would push essentials below the household floor, the floor guard
 * returns `floorBreached` (+ `gap`) and a calm warning suggests Conservative —
 * it never silently rebalances (ADR-138).
 *
 * Requires a net-income base first (ADR-139): without one the section shows a
 * neutral prompt. Selection is a ToggleButtonGroup (keyboard-navigable, single
 * select); the in-flight profile shows a quiet spinner (ADR-037). Bucket labels
 * localize off the closed SAVING_BUCKETS set.
 */

import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined'
import { SectionCard } from '../../components/SectionCard'
import { formatCurrency } from '../../lib/format'
import { parseMoney, PROFILE_SAVINGS_PCT } from './derive'
import type { SavingLine, SavingProfile } from '../../api/budgetsClient'
import type { Currency } from '../../mock/types'

const PROFILES: readonly SavingProfile[] = [
  'conservative',
  'balanced',
  'aggressive',
] as const

export interface SavingsSectionProps {
  /** Saving-bucket rows for the month (ADR-138); empty until a profile applies. */
  savings: SavingLine[]
  /** Whether a net-income base exists (the profile picker requires it, ADR-139). */
  hasIncome: boolean
  /** Period currency (ARS for the MVP). */
  currency: Currency
  /** The currently-applied profile (best-effort; null when none / unknown). */
  selectedProfile: SavingProfile | null
  /** The profile whose apply is in flight, or null. */
  applyingProfile?: SavingProfile | null
  /** Whether the last apply failed (calm retry hint). */
  applyError?: boolean
  /** Whether the last apply breached the household floor (ADR-138). */
  floorBreached?: boolean
  /** The floor-breach gap as a Decimal string, when breached. */
  floorGap?: string | null
  /** Apply a profile (the page wires the mutation). */
  onApply: (profile: SavingProfile) => void
}

export function SavingsSection({
  savings,
  hasIncome,
  currency,
  selectedProfile,
  applyingProfile = null,
  applyError = false,
  floorBreached = false,
  floorGap = null,
  onApply,
}: SavingsSectionProps) {
  const { t } = useTranslation('budgets')

  if (!hasIncome) {
    return (
      <SectionCard title={t('savings.title')} subtitle={t('savings.subtitle')}>
        <Typography sx={{ fontSize: 13.5 }} color="text.secondary" role="note">
          {t('savings.needIncome')}
        </Typography>
      </SectionCard>
    )
  }

  return (
    <SectionCard title={t('savings.title')} subtitle={t('savings.subtitle')}>
      <ToggleButtonGroup
        exclusive
        value={selectedProfile}
        onChange={(_, value: SavingProfile | null) => {
          if (value != null) onApply(value)
        }}
        aria-label={t('savings.profileLegend')}
        sx={{
          flexWrap: 'wrap',
          gap: 1,
          '& .MuiToggleButton-root': {
            textTransform: 'none',
            borderRadius: '10px !important',
            border: '1px solid var(--mg-border-2)',
            px: 2,
            minHeight: 44,
          },
        }}
      >
        {PROFILES.map((profile) => (
          <ToggleButton key={profile} value={profile} disabled={applyingProfile != null}>
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Typography sx={{ fontSize: 14, fontWeight: 600 }} color="text.primary">
                  {t(`savings.profile.${profile}`)}
                </Typography>
                {applyingProfile === profile ? (
                  <CircularProgress size={14} aria-label={t('savings.applying')} />
                ) : null}
              </Box>
              <Typography sx={{ fontSize: 12 }} color="text.secondary">
                {t('savings.profilePct', { pct: PROFILE_SAVINGS_PCT[profile] })}
              </Typography>
            </Box>
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      {floorBreached ? (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 1,
            mt: 1.75,
            p: 1.5,
            borderRadius: '10px',
            border: '1px solid color-mix(in srgb, var(--mg-watch) 35%, transparent)',
            bgcolor: 'color-mix(in srgb, var(--mg-watch) 10%, transparent)',
          }}
          role="status"
        >
          <ReportProblemOutlinedIcon
            sx={{ fontSize: 18, color: 'var(--mg-watch)', flex: 'none', mt: '1px' }}
            aria-hidden
          />
          <Typography sx={{ fontSize: 13 }} color="text.primary">
            {t('savings.floorBreach', {
              gap: formatCurrency(parseMoney(floorGap), currency),
            })}
          </Typography>
        </Box>
      ) : null}

      {applyError ? (
        <Typography sx={{ fontSize: 12.5, mt: 1.25 }} color="var(--mg-watch)" role="alert">
          {t('savings.applyError')}
        </Typography>
      ) : null}

      {savings.length === 0 ? (
        <Typography sx={{ fontSize: 13.5, mt: 2 }} color="text.secondary" role="note">
          {t('savings.empty')}
        </Typography>
      ) : (
        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, mt: 2 }}>
          {savings.map((line) => (
            <Box
              component="li"
              key={line.bucket}
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
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: 14, fontWeight: 600 }} color="text.primary" noWrap>
                  {t(`savings.buckets.${line.bucket}`)}
                </Typography>
                <Typography sx={{ fontSize: 12.5 }} color="text.secondary">
                  {t('savings.bucketPct', { pct: line.percent })}
                </Typography>
              </Box>
              <Typography
                sx={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', flex: 'none' }}
                color="text.primary"
              >
                {formatCurrency(parseMoney(line.amount), currency)}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </SectionCard>
  )
}

export default SavingsSection
