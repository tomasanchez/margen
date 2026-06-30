/**
 * Guided onboarding wizard for a NEW institution + its currency accounts
 * (ADR-134, ADR-019/037, ADR-100/101).
 *
 * Replaces the old two-step "Add institution" then per-section "Add account"
 * dance for first-time onboarding: a single MUI {@link Stepper} dialog walks the
 * user through
 *
 *  1. Institution — name + type (bank / card / cash / wallet). Required to
 *     advance (ADR-134).
 *  2. Accounts (optional) — queue zero or more per-currency accounts (ARS / USD)
 *     each with an opening balance. The user can Skip to create the institution
 *     with no accounts and add them later from the list (the per-institution
 *     "Add account" affordance stays on the page for that case).
 *
 * Finish creates the institution first (`POST /institutions`), THEN each queued
 * account (`POST /accounts` with the freshly-issued `institutionId`). On a
 * partial failure (institution created but one or more account POSTs fail) we
 * NEVER discard the institution (ADR-037): we keep it, surface exactly which
 * queued accounts failed, and let the user retry just those — a re-Finish only
 * re-POSTs the still-failed rows and skips the institution + already-created
 * accounts. The grouped accounts list refreshes via the mutations'
 * `accountsKeys.all` invalidation.
 *
 * Duplicate currencies under one institution are prevented at the queue edge:
 * the "Add account" row only offers currencies not already queued, and disables
 * itself once both ARS and USD are taken.
 *
 * Keyboard + focus (ADR-019): the MUI Dialog traps focus and restores it to the
 * trigger on close; Back / Next / Skip / Finish / Add are real <button>s; the
 * active step's heading receives focus on each step change so screen-reader and
 * keyboard users are oriented; the Stepper is non-color (numbered + labelled).
 */

import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import FormControl from '@mui/material/FormControl'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Step from '@mui/material/Step'
import StepLabel from '@mui/material/StepLabel'
import Stepper from '@mui/material/Stepper'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import { ResponsiveModal } from '../../components/ResponsiveModal'
import type { AccountType, Currency } from '../../mock/types'
import { ACCOUNT_TYPES, accountTypeLabel } from './presentation'
import { parseBalance, toDecimalString } from './balance'

/** The currencies the wizard can queue, in display order. */
const CURRENCIES: readonly Currency[] = ['ARS', 'USD'] as const

/** One account queued in step 2 before any network call. */
export interface QueuedAccount {
  /** Stable local key so React + the failure set survive reorders/removals. */
  key: string
  currency: Currency
  /** Opening balance as the raw string the user typed (Decimal preserved). */
  balanceText: string
}

/**
 * Outcome the wizard reports to its host on Finish. The host owns the actual
 * mutations; the wizard just collects validated input and renders the
 * resulting per-account status so a retry can target the failures.
 */
export interface WizardSubmit {
  institution: { name: string; type: AccountType }
  /** Queued accounts with their balances already serialized to Decimal strings. */
  accounts: Array<{ key: string; currency: Currency; openingBalance: string }>
}

/**
 * Per-account result the host feeds back so the wizard can show which rows
 * failed and let the user retry only those (ADR-037). Keyed by
 * {@link QueuedAccount.key}.
 */
export type AccountResult = 'pending' | 'created' | 'failed'

export interface InstitutionWizardProps {
  /** Whether the wizard dialog is open. */
  open: boolean
  /** True once the institution has been created (locks step 1, enables retry-only). */
  institutionCreated: boolean
  /** True while a Finish (create institution and/or accounts) is in flight. */
  isSubmitting: boolean
  /** True when the institution create itself failed (calm inline error, ADR-037). */
  institutionError: boolean
  /** Per-queued-account outcome by key; absent key === not yet attempted. */
  accountResults: Record<string, AccountResult>
  /** True once everything (institution + every queued account) succeeded. */
  allDone: boolean
  /** Finish handler — receives the validated institution + queued accounts. */
  onFinish: (submit: WizardSubmit) => void
  /** Dismiss the wizard (also used by the success "Done" action). */
  onClose: () => void
}

const STEPS = 2

export function InstitutionWizard({
  open,
  institutionCreated,
  isSubmitting,
  institutionError,
  accountResults,
  allDone,
  onFinish,
  onClose,
}: InstitutionWizardProps) {
  const { t } = useTranslation('accounts')

  const nameId = useId()
  const typeId = useId()
  const errorId = useId()

  const [activeStep, setActiveStep] = useState(0)

  // Step 1 — institution fields.
  const [name, setName] = useState('')
  const [type, setType] = useState<AccountType>('bank')

  // Step 2 — the queued accounts.
  const [queued, setQueued] = useState<QueuedAccount[]>([])

  // Focus the active step heading on each step change (ADR-019).
  const stepHeadingRef = useRef<HTMLHeadingElement | null>(null)
  useEffect(() => {
    if (open) stepHeadingRef.current?.focus()
  }, [activeStep, open, allDone])

  const nameValid = name.trim().length > 0

  // Currencies still free to queue (no dup currency under one institution).
  const usedCurrencies = new Set(queued.map((a) => a.currency))
  const freeCurrencies = CURRENCIES.filter((c) => !usedCurrencies.has(c))

  const addAccount = (currency: Currency) => {
    setQueued((prev) => [
      ...prev,
      { key: `q-${currency}-${prev.length}-${Date.now()}`, currency, balanceText: '' },
    ])
  }
  const removeAccount = (key: string) => {
    setQueued((prev) => prev.filter((a) => a.key !== key))
  }
  const setAccountCurrency = (key: string, currency: Currency) => {
    setQueued((prev) =>
      prev.map((a) => (a.key === key ? { ...a, currency } : a)),
    )
  }
  const setAccountBalance = (key: string, balanceText: string) => {
    setQueued((prev) =>
      prev.map((a) => (a.key === key ? { ...a, balanceText } : a)),
    )
  }

  // Every queued account must parse to a finite number to Finish (ADR-025/034).
  const allBalancesValid = queued.every((a) =>
    Number.isFinite(parseBalance(a.balanceText)),
  )
  // No duplicate currency may exist (the add row prevents it, but guard anyway).
  const noDuplicateCurrency = new Set(queued.map((a) => a.currency)).size === queued.length

  const goNext = () => setActiveStep((s) => Math.min(s + 1, STEPS - 1))
  const goBack = () => setActiveStep((s) => Math.max(s - 1, 0))

  const buildSubmit = (): WizardSubmit => ({
    institution: { name: name.trim(), type },
    accounts: queued.map((a) => ({
      key: a.key,
      currency: a.currency,
      openingBalance: toDecimalString(parseBalance(a.balanceText)),
    })),
  })

  const handleFinish = () => {
    if (!nameValid || !allBalancesValid || !noDuplicateCurrency) return
    onFinish(buildSubmit())
  }

  // Whether a queued row's network attempt failed (retry target, ADR-037).
  const hasFailures = Object.values(accountResults).some((r) => r === 'failed')
  const canFinish =
    nameValid && allBalancesValid && noDuplicateCurrency && !isSubmitting

  const stepLabels = [t('wizard.step1.label'), t('wizard.step2.label')]

  return (
    <ResponsiveModal
      open={open}
      onClose={onClose}
      title={t('wizard.title')}
      maxWidth={520}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        {allDone ? (
          <Box
            role="status"
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
              gap: 1.25,
              py: 3,
            }}
          >
            <CheckCircleOutlineRoundedIcon
              aria-hidden
              sx={{ fontSize: 48, color: 'success.main' }}
            />
            <Typography
              component="h2"
              ref={stepHeadingRef}
              tabIndex={-1}
              sx={{ fontSize: 17, fontWeight: 600, outline: 'none' }}
              color="text.primary"
            >
              {t('wizard.success.title', { name: name.trim() })}
            </Typography>
            <Typography sx={{ fontSize: 13.5 }} color="text.secondary">
              {queued.length === 0
                ? t('wizard.success.noAccounts')
                : t('wizard.success.body', { count: queued.length })}
            </Typography>
          </Box>
        ) : (
          <>
            <Stepper activeStep={activeStep} alternativeLabel sx={{ mt: 0.5 }}>
              {stepLabels.map((label) => (
                <Step key={label}>
                  <StepLabel>{label}</StepLabel>
                </Step>
              ))}
            </Stepper>

            {/* Institution-level failure (ADR-037): calm, keeps the wizard open. */}
            {institutionError ? (
              <Typography
                id={errorId}
                role="alert"
                sx={{ fontSize: 13 }}
                color="error.main"
              >
                {t('wizard.institutionError')}
              </Typography>
            ) : null}

            {activeStep === 0 ? (
              <Box
                sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}
              >
                <Typography
                  component="h2"
                  ref={stepHeadingRef}
                  tabIndex={-1}
                  sx={{ fontSize: 15, fontWeight: 600, outline: 'none' }}
                  color="text.primary"
                >
                  {t('wizard.step1.heading')}
                </Typography>

                <TextField
                  id={nameId}
                  label={t('institutionForm.name.label')}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  fullWidth
                  size="small"
                  disabled={isSubmitting || institutionCreated}
                  slotProps={{
                    htmlInput: {
                      'aria-describedby': institutionError ? errorId : undefined,
                    },
                  }}
                />

                <FormControl
                  fullWidth
                  size="small"
                  disabled={isSubmitting || institutionCreated}
                >
                  <InputLabel id={`${typeId}-label`}>
                    {t('institutionForm.type.label')}
                  </InputLabel>
                  <Select
                    id={typeId}
                    labelId={`${typeId}-label`}
                    label={t('institutionForm.type.label')}
                    value={type}
                    onChange={(event) =>
                      setType(event.target.value as AccountType)
                    }
                  >
                    {ACCOUNT_TYPES.map((value) => (
                      <MenuItem key={value} value={value}>
                        {accountTypeLabel(value)}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Box>
            ) : (
              <Box
                sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}
              >
                <Box>
                  <Typography
                    component="h2"
                    ref={stepHeadingRef}
                    tabIndex={-1}
                    sx={{ fontSize: 15, fontWeight: 600, outline: 'none' }}
                    color="text.primary"
                  >
                    {t('wizard.step2.heading')}
                  </Typography>
                  <Typography
                    sx={{ fontSize: 13, mt: 0.5 }}
                    color="text.secondary"
                  >
                    {t('wizard.step2.subheading')}
                  </Typography>
                </Box>

                {queued.length === 0 ? (
                  <Typography
                    sx={{ fontSize: 13.5, py: 0.5 }}
                    color="text.secondary"
                    role="status"
                  >
                    {t('wizard.step2.empty')}
                  </Typography>
                ) : (
                  <Box
                    sx={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 1.5,
                    }}
                  >
                    {queued.map((account, index) => {
                      const result = accountResults[account.key]
                      // Currencies this row may pick: free ones + its own.
                      const rowCurrencies = CURRENCIES.filter(
                        (c) =>
                          c === account.currency || !usedCurrencies.has(c),
                      )
                      const balance = parseBalance(account.balanceText)
                      const balanceTouched = account.balanceText.trim() !== ''
                      const balanceInvalid =
                        balanceTouched && !Number.isFinite(balance)
                      return (
                        <Box
                          key={account.key}
                          sx={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 1,
                          }}
                        >
                          <FormControl
                            size="small"
                            disabled={isSubmitting || result === 'created'}
                            sx={{ minWidth: 110, flex: 'none' }}
                          >
                            <InputLabel id={`${account.key}-cur-label`}>
                              {t('form.currency.label')}
                            </InputLabel>
                            <Select
                              labelId={`${account.key}-cur-label`}
                              label={t('form.currency.label')}
                              value={account.currency}
                              onChange={(event) =>
                                setAccountCurrency(
                                  account.key,
                                  event.target.value as Currency,
                                )
                              }
                            >
                              {rowCurrencies.map((c) => (
                                <MenuItem key={c} value={c}>
                                  {c}
                                </MenuItem>
                              ))}
                            </Select>
                          </FormControl>

                          <TextField
                            label={t('form.openingBalance.label')}
                            value={account.balanceText}
                            onChange={(event) =>
                              setAccountBalance(
                                account.key,
                                event.target.value,
                              )
                            }
                            fullWidth
                            size="small"
                            inputMode="decimal"
                            disabled={isSubmitting || result === 'created'}
                            error={balanceInvalid}
                            helperText={
                              result === 'failed'
                                ? t('wizard.step2.rowFailed')
                                : result === 'created'
                                  ? t('wizard.step2.rowCreated')
                                  : balanceInvalid
                                    ? t('wizard.step2.rowInvalid')
                                    : undefined
                            }
                          />

                          {result === 'failed' ? (
                            <ErrorOutlineRoundedIcon
                              aria-label={t('wizard.step2.rowFailedAria', {
                                currency: account.currency,
                              })}
                              sx={{
                                color: 'error.main',
                                mt: 1,
                                flex: 'none',
                              }}
                            />
                          ) : result === 'created' ? (
                            <CheckCircleOutlineRoundedIcon
                              aria-label={t('wizard.step2.rowCreatedAria', {
                                currency: account.currency,
                              })}
                              sx={{
                                color: 'success.main',
                                mt: 1,
                                flex: 'none',
                              }}
                            />
                          ) : (
                            <IconButton
                              size="small"
                              onClick={() => removeAccount(account.key)}
                              disabled={isSubmitting}
                              aria-label={t('wizard.step2.removeAria', {
                                currency: account.currency,
                                index: index + 1,
                              })}
                              sx={{ mt: 0.5, flex: 'none' }}
                            >
                              <DeleteOutlineRoundedIcon fontSize="small" />
                            </IconButton>
                          )}
                        </Box>
                      )
                    })}
                  </Box>
                )}

                {hasFailures ? (
                  <Typography
                    role="alert"
                    sx={{ fontSize: 13 }}
                    color="error.main"
                  >
                    {t('wizard.partialFailure')}
                  </Typography>
                ) : null}

                {/* Quick adds — only currencies not already queued (no dup). */}
                {freeCurrencies.length > 0 ? (
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                    {freeCurrencies.map((c) => (
                      <Button
                        key={c}
                        startIcon={<AddIcon />}
                        onClick={() => addAccount(c)}
                        disabled={isSubmitting}
                        size="small"
                        variant="outlined"
                        sx={{ textTransform: 'none', fontWeight: 600 }}
                      >
                        {t('wizard.step2.addCurrency', { currency: c })}
                      </Button>
                    ))}
                  </Box>
                ) : (
                  <Chip
                    label={t('wizard.step2.allCurrenciesAdded')}
                    size="small"
                    variant="outlined"
                    sx={{ borderRadius: '8px', alignSelf: 'flex-start' }}
                  />
                )}
              </Box>
            )}
          </>
        )}
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 0.5,
          mt: 3,
        }}
      >
        {allDone ? (
          <Button
            type="button"
            variant="contained"
            onClick={onClose}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {t('wizard.done')}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              onClick={onClose}
              color="secondary"
              disabled={isSubmitting}
              sx={{ textTransform: 'none', mr: 'auto' }}
            >
              {t('wizard.cancel')}
            </Button>

            {activeStep > 0 ? (
              <Button
                type="button"
                onClick={goBack}
                disabled={isSubmitting || institutionCreated}
                sx={{ textTransform: 'none' }}
              >
                {t('wizard.back')}
              </Button>
            ) : null}

            {activeStep === 0 ? (
              <Button
                type="button"
                variant="contained"
                onClick={goNext}
                disabled={!nameValid || isSubmitting}
                sx={{ textTransform: 'none', fontWeight: 600 }}
              >
                {t('wizard.next')}
              </Button>
            ) : (
              <>
                {queued.length === 0 && !institutionCreated ? (
                  <Button
                    type="button"
                    onClick={handleFinish}
                    disabled={!canFinish}
                    sx={{ textTransform: 'none' }}
                  >
                    {t('wizard.skip')}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="contained"
                  onClick={handleFinish}
                  disabled={!canFinish}
                  sx={{ textTransform: 'none', fontWeight: 600 }}
                >
                  {hasFailures ? t('wizard.retry') : t('wizard.finish')}
                </Button>
              </>
            )}
          </>
        )}
      </Box>
    </ResponsiveModal>
  )
}

export default InstitutionWizard
