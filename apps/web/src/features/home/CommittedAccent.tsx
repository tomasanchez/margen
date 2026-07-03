/**
 * <CommittedAccent> — the committed-spend accent inside the monthly Expenses
 * figures (ADR-179, ADR-019).
 *
 * NOT a card and NOT a new section: a calm caption rendered UNDER an existing
 * Expenses figure (the Home Expense metric card + the Budget "this month vs plan"
 * spent figure). It conveys how much of the month's spend is committed/obligated:
 *
 *  - the `paid` committed total — the obligated share ALREADY inside the Expenses
 *    number (rows already posted this month) — as "X committed";
 *  - when `pending > 0`, a second muted note "· Y still committed this month",
 *    clearly marked as UPCOMING and explicitly NOT added to the spent number
 *    (offset-0 no-double-count, ADR-179).
 *
 * The accent carries real TEXT, never color alone (ADR-019): the words
 * "committed" / "still committed this month" convey the meaning. Money is
 * formatted by the caller-supplied `formatMoney` so the figure stays in the same
 * denomination as the Expenses figure it annotates — this component NEVER
 * converts (the split already arrives denominated, ADR-168). When both figures
 * are zero (nothing committed) the accent renders nothing so a discretionary month
 * stays uncluttered.
 */

import { useTranslation } from 'react-i18next'
import Typography from '@mui/material/Typography'
import type { SxProps, Theme } from '@mui/material/styles'
import type { CommittedSplit } from '../../api/committedClient'

export interface CommittedAccentProps {
  /** The adapted committed split for the same month + currency as the figure. */
  committed: CommittedSplit | undefined
  /**
   * Formats a figure in the SAME denomination as the Expenses figure this accent
   * annotates (Home's display-currency formatter, or the Budget's
   * `formatCurrency` bound to the budget currency). The accent never converts.
   */
  formatMoney: (amount: number) => string
  /** Optional style overrides for the caption line (spacing to the parent figure). */
  sx?: SxProps<Theme>
}

/**
 * The quiet committed caption under an Expenses figure (ADR-179). Renders nothing
 * while the split is loading/absent, and nothing when there is no committed spend
 * at all (paid + pending both 0) so a fully discretionary month stays calm.
 */
export function CommittedAccent({
  committed,
  formatMoney,
  sx,
}: CommittedAccentProps) {
  const { t } = useTranslation('common')

  if (!committed) return null
  const paid = committed.paid.total
  const pending = committed.pending.total
  // Nothing obligated this month → no accent (keep discretionary months calm).
  if (paid <= 0 && pending <= 0) return null

  const paidText = t('committed.paid', { amount: formatMoney(paid) })
  const pendingText =
    pending > 0
      ? t('committed.pending', { amount: formatMoney(pending) })
      : null

  return (
    <Typography
      component="p"
      role="note"
      sx={{ fontSize: 12, color: 'var(--mg-text-2)', ...sx }}
    >
      {paidText}
      {pendingText ? (
        <Typography
          component="span"
          // The pending note is upcoming context, muted a touch further so it
          // never reads as part of the spent number (ADR-179).
          sx={{ color: 'var(--mg-text-3)' }}
        >
          {' '}
          {pendingText}
        </Typography>
      ) : null}
    </Typography>
  )
}

export default CommittedAccent
