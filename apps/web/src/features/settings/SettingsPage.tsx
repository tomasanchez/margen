/**
 * Settings — the small, real preferences surface (Issue #10, ADR-053/057).
 *
 * Reachable from the account menu (avatar). Four preferences, each driving real
 * behavior:
 *
 *  - Display currency (ARS / USD) — drives the Home cards + summaries (ADR-056).
 *  - FX default rate source (MEP / Official) — pre-selects the Add/Edit USD
 *    source (ADR-044/045).
 *  - Monotributo category (A–K) + activity type — writes to `PATCH /settings`
 *    (ADR-054); the Monotributo page reads the same value (one source of truth).
 *  - A read-only manual-threshold indicator (ADR-051/059).
 *
 * Each control PATCHes a partial update via {@link useUpdateSettings} on change;
 * the page shows a calm loading skeleton, a calm error state if the GET fails,
 * and surfaces a save failure (incl. a 422 on a bad value) as a calm inline
 * message (ADR-037). The configured fields are read from {@link useSettings}.
 *
 * The visible page <h1> ("Settings") names the route landmark. English-only.
 */

import { useId } from 'react'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { SectionCard } from '../../components/SectionCard'
import { ErrorState } from '../../components/ErrorState'
import { SettingsApiError } from '../../api/settingsClient'
import type {
  DisplayCurrency,
  FxDefaultRateType,
  SettingsPatch,
} from '../../api/settingsClient'
import { useSettings, useUpdateSettings } from './queries'
import { ManualThresholdNote } from './ManualThresholdNote'

/** The A–K Monotributo categories (the maintained scale, ADR-051). */
const CATEGORY_LETTERS = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
] as const

/** Field-level row: a label + helper text beside its control. */
function SettingRow({
  label,
  helper,
  control,
  htmlFor,
}: {
  label: string
  helper: string
  control: React.ReactNode
  htmlFor?: string
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: { xs: 'column', sm: 'row' },
        alignItems: { xs: 'stretch', sm: 'center' },
        justifyContent: 'space-between',
        gap: { xs: 1.25, sm: 2.5 },
        py: 1.75,
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography
          component="label"
          htmlFor={htmlFor}
          sx={{ fontSize: 14, fontWeight: 600, display: 'block' }}
          color="text.primary"
        >
          {label}
        </Typography>
        <Typography
          sx={{ fontSize: 12.5, mt: 0.25, maxWidth: 360 }}
          color="text.secondary"
        >
          {helper}
        </Typography>
      </Box>
      <Box sx={{ flex: 'none' }}>{control}</Box>
    </Box>
  )
}

export function SettingsPage() {
  const settingsQuery = useSettings()
  const updateSettings = useUpdateSettings()

  const displayCurrencyId = useId()
  const fxDefaultId = useId()
  const categoryId = useId()
  const errorId = useId()

  const settings = settingsQuery.data

  // Surface a 422 (bad value) as a calm inline message; other failures fall
  // back to a generic line. The page itself stays usable either way (ADR-037).
  const saveError =
    updateSettings.isError && updateSettings.error
      ? updateSettings.error instanceof SettingsApiError &&
        updateSettings.error.status === 422
        ? "That value isn't allowed. Pick one from the list."
        : "We couldn't save that change. Try again."
      : null

  function save(patch: SettingsPatch) {
    updateSettings.mutate(patch)
  }

  const saving = updateSettings.isPending

  if (settingsQuery.isError) {
    return (
      <Box>
        <Typography
          component="h1"
          sx={{
            fontSize: { xs: '1.25rem', md: '1.375rem' },
            fontWeight: 600,
            mb: 2.5,
          }}
          color="text.primary"
        >
          Settings
        </Typography>
        <ErrorState
          title="Settings unavailable"
          description="We couldn't load your settings. Check your connection and try again."
          onRetry={() => void settingsQuery.refetch()}
        />
      </Box>
    )
  }

  return (
    <Box>
      <Typography
        component="h1"
        sx={{
          fontSize: { xs: '1.25rem', md: '1.375rem' },
          fontWeight: 600,
          mb: 0.5,
        }}
        color="text.primary"
      >
        Settings
      </Typography>
      <Typography sx={{ fontSize: 13.5, mb: 2.5 }} color="text.secondary">
        Preferences that shape how Margen reads and what it calculates.
      </Typography>

      {saveError ? (
        <Typography
          id={errorId}
          role="alert"
          sx={{ fontSize: 13, mb: 1.75 }}
          color="error.main"
        >
          {saveError}
        </Typography>
      ) : null}

      {settingsQuery.isPending || !settings ? (
        <SectionCard title="Preferences">
          <Skeleton variant="rounded" height={64} sx={{ mb: 1.5, borderRadius: '10px' }} />
          <Skeleton variant="rounded" height={64} sx={{ mb: 1.5, borderRadius: '10px' }} />
          <Skeleton variant="rounded" height={64} sx={{ borderRadius: '10px' }} />
        </SectionCard>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: { xs: 1.75, md: 2.25 } }}>
          <SectionCard title="Display">
            <SettingRow
              label="Display currency"
              helper="The currency for the Home metric cards and monthly summaries. ARS stays the stored value; USD converts at your default rate."
              htmlFor={displayCurrencyId}
              control={
                <FormControl size="small" sx={{ minWidth: 168 }} disabled={saving}>
                  <InputLabel id={`${displayCurrencyId}-label`}>
                    Currency
                  </InputLabel>
                  <Select
                    id={displayCurrencyId}
                    labelId={`${displayCurrencyId}-label`}
                    label="Currency"
                    value={settings.preferredDisplayCurrency}
                    aria-describedby={saveError ? errorId : undefined}
                    onChange={(event) =>
                      save({
                        preferredDisplayCurrency: event.target
                          .value as DisplayCurrency,
                      })
                    }
                    sx={{ borderRadius: '10px', bgcolor: 'var(--mg-paper)' }}
                  >
                    <MenuItem value="ARS">ARS (pesos)</MenuItem>
                    <MenuItem value="USD">USD (dollars)</MenuItem>
                  </Select>
                </FormControl>
              }
            />

            <SettingRow
              label="FX default source"
              helper="The dollar rate pre-selected when you add a USD transaction, and used for the USD display conversion."
              htmlFor={fxDefaultId}
              control={
                <FormControl size="small" sx={{ minWidth: 168 }} disabled={saving}>
                  <InputLabel id={`${fxDefaultId}-label`}>Rate source</InputLabel>
                  <Select
                    id={fxDefaultId}
                    labelId={`${fxDefaultId}-label`}
                    label="Rate source"
                    value={settings.fxDefaultRateType}
                    onChange={(event) =>
                      save({
                        fxDefaultRateType: event.target
                          .value as FxDefaultRateType,
                      })
                    }
                    sx={{ borderRadius: '10px', bgcolor: 'var(--mg-paper)' }}
                  >
                    <MenuItem value="MEP">MEP</MenuItem>
                    <MenuItem value="official">Official</MenuItem>
                  </Select>
                </FormControl>
              }
            />
          </SectionCard>

          <SectionCard title="Monotributo">
            <SettingRow
              label="Category"
              helper="Your current Monotributo category. Drives the limit meter and projection on the Monotributo page."
              htmlFor={categoryId}
              control={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <FormControl size="small" sx={{ minWidth: 140 }} disabled={saving}>
                    <InputLabel id={`${categoryId}-label`}>Category</InputLabel>
                    <Select
                      id={categoryId}
                      labelId={`${categoryId}-label`}
                      label="Category"
                      value={settings.monotributoCurrentCategory}
                      onChange={(event) =>
                        save({
                          monotributoCurrentCategory: event.target.value,
                          monotributoActivityType:
                            settings.monotributoActivityType,
                        })
                      }
                      sx={{ borderRadius: '10px', bgcolor: 'var(--mg-paper)' }}
                    >
                      {CATEGORY_LETTERS.map((letter) => (
                        <MenuItem key={letter} value={letter}>
                          Category {letter}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  {/* Activity type is fixed to services in the MVP (ADR-053/059). */}
                  <Chip
                    label="Services"
                    size="small"
                    variant="outlined"
                    title="Activity type is services in this version"
                    sx={{ borderRadius: '8px' }}
                  />
                </Box>
              }
            />

            <Box sx={{ pt: 1.25 }}>
              <ManualThresholdNote />
            </Box>
          </SectionCard>
        </Box>
      )}
    </Box>
  )
}

export default SettingsPage
