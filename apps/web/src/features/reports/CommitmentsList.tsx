/**
 * Upcoming commitments / installments tail for Reports (ADR-173, ADR-176, ADR-177).
 *
 * The "how expenses pro-rate going forward" view the owner asked for: the distinct
 * committed streams feeding the forecast, GROUPED by source — subscriptions,
 * taxes, and installments. Each row shows the stream label + its per-occurrence
 * amount; an installment row also shows its remaining-cuota count (e.g.
 * "Cuota — 9 left"), the load-bearing signal for the installment tail. Money is
 * ALREADY in the requested currency (ADR-168), except the monotributo `tax` stream
 * which is AFIP-ARS on both paths (ADR-177) — each line carries its own `currency`,
 * so a line renders in exactly the denomination the backend computed and never
 * re-converts.
 *
 * Grouped in a fixed, stable order (subscriptions → taxes → installments) so the
 * panel reads the same each render; an empty group is omitted. When there are no
 * commitments at all the card shows a calm note (the v1 commitment-tagging caveat,
 * ADR-173). Accessibility (ADR-019): the remaining-count is a WORD ("left"), never
 * a colour; each group is a labelled list.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { SectionCard } from '../../components/SectionCard'
import { monoFontFamily } from '../../theme'
import { formatCurrency } from '../../lib/format'
import type { CommitmentLine, CommitmentSource } from '../../api/forecastClient'

export interface CommitmentsListProps {
  /** The distinct committed streams feeding the forecast (ADR-176). */
  commitments: CommitmentLine[]
}

/** The fixed render order of the commitment groups (ADR-176/177). */
const GROUP_ORDER: readonly CommitmentSource[] = [
  'subscription',
  'tax',
  'installment',
] as const

/** One committed stream as a labelled row. */
function CommitmentRow({ line }: { line: CommitmentLine }) {
  const { t } = useTranslation('reports')
  // The remaining-cuota count is the installment tail's load-bearing signal
  // (ADR-176): show it as a WORD-bearing caption, e.g. "9 left" (never colour).
  const showRemaining =
    line.source === 'installment' &&
    typeof line.remainingCount === 'number' &&
    line.remainingCount > 0

  return (
    <Box
      component="li"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1.5,
        py: 1,
        borderBottom: '1px solid var(--mg-border-2)',
        '&:last-of-type': { borderBottom: 'none' },
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography
          sx={{
            fontSize: 13.5,
            color: 'text.primary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {line.label}
        </Typography>
        {showRemaining ? (
          <Typography sx={{ fontSize: 11.5 }} color="text.secondary">
            {t('forecast.commitments.remaining', {
              count: line.remainingCount ?? 0,
            })}
          </Typography>
        ) : null}
      </Box>
      <Typography
        component="span"
        sx={{
          flex: 'none',
          fontFamily: monoFontFamily,
          fontSize: 13.5,
          color: 'text.primary',
        }}
      >
        {formatCurrency(line.amount, line.currency)}
      </Typography>
    </Box>
  )
}

/** One source group (subscriptions / taxes / installments) with its heading + rows. */
function CommitmentGroup({
  source,
  lines,
}: {
  source: CommitmentSource
  lines: CommitmentLine[]
}) {
  const { t } = useTranslation('reports')
  const heading =
    source === 'subscription'
      ? t('forecast.commitments.subscriptions')
      : source === 'tax'
        ? t('forecast.commitments.taxes')
        : t('forecast.commitments.installments')

  return (
    <Box component="section" sx={{ '& + &': { mt: 2 } }}>
      <Typography variant="overline" component="h3" sx={{ display: 'block', mb: 0.5 }}>
        {heading}
      </Typography>
      <Box
        component="ul"
        aria-label={heading}
        sx={{ listStyle: 'none', m: 0, p: 0 }}
      >
        {lines.map((line, index) => (
          <CommitmentRow key={`${line.source}-${line.label}-${index}`} line={line} />
        ))}
      </Box>
    </Box>
  )
}

export function CommitmentsList({ commitments }: CommitmentsListProps) {
  const { t } = useTranslation('reports')

  // Group by source, preserving the backend's within-group order, and emit only
  // non-empty groups in the fixed display order.
  const groups = useMemo(
    () =>
      GROUP_ORDER.map((source) => ({
        source,
        lines: commitments.filter((line) => line.source === source),
      })).filter((group) => group.lines.length > 0),
    [commitments],
  )

  const isEmpty = groups.length === 0

  return (
    <SectionCard
      title={t('forecast.commitments.title')}
      subtitle={t('forecast.commitments.subtitle')}
    >
      {isEmpty ? (
        <Typography
          role="note"
          sx={{ fontSize: 13, py: 2 }}
          color="text.secondary"
        >
          {t('forecast.commitments.empty')}
        </Typography>
      ) : (
        <Box>
          {groups.map((group) => (
            <CommitmentGroup
              key={group.source}
              source={group.source}
              lines={group.lines}
            />
          ))}
        </Box>
      )}
    </SectionCard>
  )
}

export default CommitmentsList
