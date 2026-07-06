/**
 * In-flow "Register this card" confirm form (ADR-190).
 *
 * When the statement import finds no matching card account for a currency, the
 * review offers a "Register this card" action that opens this prefilled dialog.
 * It is a thin, card-specific confirm-with-override form (ADR-037/184): the
 * parser's `bankName` seeds the name, `network` the brand, `cardLast4` the last-4,
 * and the currencies PRESENT in the statement are queued as the card's per-currency
 * accounts (ARS and/or USD). The user reviews/edits and confirms; the host then
 * creates the institution (type = card, carrying brand + last4, ADR-190) and its
 * accounts, after which the import auto-match resolves the card by (brand + last4,
 * currency).
 *
 * Keyboard + focus (ADR-019): the dialog traps focus and restores it on close;
 * every control has an associated label; a save failure keeps the dialog open with
 * the input intact and surfaces a calm inline error (ADR-037).
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { ResponsiveModal } from '../../components/ResponsiveModal'
import type { Currency } from '../../mock/types'
import { parseBalance, toDecimalString } from '../accounts/balance'

/** One currency account queued for the new card (ARS and/or USD). */
interface QueuedAccount {
  currency: Currency
  /** Opening balance as the raw string the user typed (Decimal preserved). */
  balanceText: string
}

/**
 * The confirmed card registration the host acts on (ADR-190): the institution
 * (type = card, brand + last4) and the per-currency accounts to create, each with
 * an opening balance already serialized to a Decimal string.
 */
export interface RegisterCardSubmit {
  institution: {
    name: string
    type: 'card'
    brand: string | null
    last4: string | null
  }
  accounts: Array<{ currency: Currency; openingBalance: string }>
}

export interface RegisterCardFormProps {
  /** Whether the dialog is open. */
  open: boolean
  /** Prefill: the parser's normalized issuer name (seeds the editable name). */
  bankName: string | undefined
  /** Prefill: the parser's card network (seeds the editable brand). */
  network: string | undefined
  /** Prefill: the parser's four-digit card suffix (seeds the editable last-4). */
  cardLast4: string | undefined
  /** The currencies present in the statement — queued as the card's accounts. */
  currencies: readonly Currency[]
  /** Whether a create is in flight (disables the form / shows progress). */
  isSaving: boolean
  /** True when the last registration failed — surfaces the calm inline error (ADR-037). */
  saveError: boolean
  /** Confirm handler; receives the assembled institution + accounts. */
  onSubmit: (submit: RegisterCardSubmit) => void
  /** Cancel / dismiss the dialog. */
  onClose: () => void
}

export function RegisterCardForm({
  open,
  bankName,
  network,
  cardLast4,
  currencies,
  isSaving,
  saveError,
  onSubmit,
  onClose,
}: RegisterCardFormProps) {
  const { t } = useTranslation('statements')
  const nameId = useId()
  const brandId = useId()
  const last4Id = useId()
  const errorId = useId()

  const [name, setName] = useState(bankName ?? '')
  const [brand, setBrand] = useState(network ?? '')
  const [last4, setLast4] = useState(cardLast4 ?? '')
  // One queued account per currency present in the statement, ARS before USD.
  const [queued, setQueued] = useState<QueuedAccount[]>(() =>
    (['ARS', 'USD'] as const)
      .filter((c) => currencies.includes(c))
      .map((currency) => ({ currency, balanceText: '' })),
  )

  const nameValid = name.trim().length > 0
  // Blank balances default to 0 (a card typically starts at 0); a typed balance
  // must parse to a finite number to confirm (ADR-025/034).
  const balancesValid = queued.every(
    (a) => a.balanceText.trim() === '' || Number.isFinite(parseBalance(a.balanceText)),
  )
  const canConfirm = nameValid && balancesValid && !isSaving

  const setBalance = (currency: Currency, balanceText: string) => {
    setQueued((prev) =>
      prev.map((a) => (a.currency === currency ? { ...a, balanceText } : a)),
    )
  }

  const handleConfirm = () => {
    if (!canConfirm) return
    const trimmedBrand = brand.trim()
    const trimmedLast4 = last4.trim()
    onSubmit({
      institution: {
        name: name.trim(),
        type: 'card',
        brand: trimmedBrand === '' ? null : trimmedBrand,
        last4: trimmedLast4 === '' ? null : trimmedLast4,
      },
      accounts: queued.map((a) => ({
        currency: a.currency,
        openingBalance: toDecimalString(
          a.balanceText.trim() === '' ? 0 : parseBalance(a.balanceText),
        ),
      })),
    })
  }

  return (
    <ResponsiveModal
      open={open}
      onClose={onClose}
      title={t('review.registerCard.title')}
      maxWidth={460}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
          {t('review.registerCard.subtitle')}
        </Typography>

        {saveError ? (
          <Typography
            id={errorId}
            role="alert"
            sx={{ fontSize: 13 }}
            color="error.main"
          >
            {t('review.registerCard.error')}
          </Typography>
        ) : null}

        <TextField
          id={nameId}
          label={t('review.registerCard.name.label')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          fullWidth
          size="small"
          disabled={isSaving}
          slotProps={{
            htmlInput: { 'aria-describedby': saveError ? errorId : undefined },
          }}
        />

        <Box sx={{ display: 'flex', gap: 1.5 }}>
          <TextField
            id={brandId}
            label={t('review.registerCard.brand.label')}
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            fullWidth
            size="small"
            disabled={isSaving}
          />
          <TextField
            id={last4Id}
            label={t('review.registerCard.last4.label')}
            value={last4}
            onChange={(e) =>
              setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))
            }
            size="small"
            disabled={isSaving}
            slotProps={{
              htmlInput: { inputMode: 'numeric', maxLength: 4, style: { width: 72 } },
            }}
          />
        </Box>

        <Box>
          <Typography
            component="h3"
            sx={{ fontSize: 13.5, fontWeight: 600, color: 'text.primary' }}
          >
            {t('review.registerCard.accountsHeading')}
          </Typography>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.25, mb: 1 }}>
            {t('review.registerCard.accountsSubheading')}
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            {queued.map((account) => {
              const parsed = parseBalance(account.balanceText)
              const touched = account.balanceText.trim() !== ''
              const invalid = touched && !Number.isFinite(parsed)
              return (
                <Box
                  key={account.currency}
                  sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}
                >
                  <Chip
                    label={account.currency}
                    size="small"
                    variant="outlined"
                    sx={{ borderRadius: '8px', fontSize: 12, mt: 1, flex: 'none' }}
                  />
                  <TextField
                    label={t('review.registerCard.openingBalance.label', {
                      currency: account.currency,
                    })}
                    value={account.balanceText}
                    onChange={(e) => setBalance(account.currency, e.target.value)}
                    fullWidth
                    size="small"
                    inputMode="decimal"
                    disabled={isSaving}
                    error={invalid}
                  />
                </Box>
              )
            })}
          </Box>
        </Box>
      </Box>

      <Box
        sx={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 1,
          mt: 3,
        }}
      >
        <Button
          type="button"
          onClick={onClose}
          color="secondary"
          disabled={isSaving}
          sx={{ textTransform: 'none' }}
        >
          {t('review.registerCard.cancel')}
        </Button>
        <Button
          type="button"
          variant="contained"
          onClick={handleConfirm}
          disabled={!canConfirm}
          sx={{ textTransform: 'none', fontWeight: 600 }}
        >
          {t('review.registerCard.confirm')}
        </Button>
      </Box>
    </ResponsiveModal>
  )
}

export default RegisterCardForm
