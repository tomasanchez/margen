/**
 * Review ranked income-match suggestions for one person (ADR-207, ADR-037).
 *
 * Income matching is SUGGESTION-ONLY (ADR-207): this lists the ranked candidate
 * incomes ({@link useReceivableMatchSuggestions} — server-scored fuzzy matches
 * against the person's name) and NOTHING auto-applies. Each row shows the income's
 * counterparty, amount, and date plus a light relevance indicator derived from the
 * match `score` (so ranking reads without relying on color alone, ADR-019). The
 * owner picks a suggestion to "Review", which opens {@link ConfirmMatchForm} to
 * choose which item(s) it settles + the allocation amounts before confirming.
 *
 * On a successful confirm the hook invalidates this person's suggestions, so the
 * now-claimed income drops out of the list (ADR-207). Suggestions are sorted by
 * score (highest first) defensively, even though the server already ranks them.
 * Calm loading / error / empty states throughout (ADR-037). Receivables are
 * ARS-only (ADR-204), so amounts format as ARS; money is a Decimal string parsed
 * only at the display edge (ADR-025/034/102).
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { ErrorState } from '../../components/ErrorState'
import { formatCurrency } from '../../lib/format'
import type { MatchSuggestion } from '../../api/receivablesClient'
import { ConfirmMatchForm } from './ConfirmMatchForm'
import { useReceivableMatchSuggestions } from './queries'

/** Parse a Decimal string to a number for the display edge (0 on a bad value). */
function num(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Relevance buckets for a fuzzy-match score (higher = stronger, ADR-207). */
type Relevance = 'strong' | 'likely' | 'possible'

/**
 * Bucket a fuzzy-match score into a relevance band. The band is shown as a WORD
 * (not color alone, ADR-019) so ranking is legible to everyone.
 */
function relevanceOf(score: number): Relevance {
  if (score >= 0.8) return 'strong'
  if (score >= 0.5) return 'likely'
  return 'possible'
}

/** Theme color token that merely reinforces the relevance word (never alone). */
function relevanceColor(relevance: Relevance): string {
  if (relevance === 'strong') return 'success.main'
  if (relevance === 'likely') return 'text.primary'
  return 'text.secondary'
}

/** One suggestion row: income name + amount + date, relevance, and Review. */
function SuggestionRow({
  suggestion,
  onReview,
}: {
  suggestion: MatchSuggestion
  onReview: () => void
}) {
  const { t } = useTranslation('receivables')
  const amount = formatCurrency(num(suggestion.amount), 'ARS')
  const relevance = relevanceOf(suggestion.score)
  return (
    <Box
      data-testid="receivable-suggestion"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        py: 1.25,
        borderBottom: '1px solid var(--mg-border)',
        '&:last-of-type': { borderBottom: 'none' },
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          sx={{ fontSize: 14, fontWeight: 600 }}
          color="text.primary"
          noWrap
        >
          {suggestion.name}
        </Typography>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 0.75,
            mt: 0.25,
          }}
        >
          <Typography sx={{ fontSize: 12.5 }} color="text.secondary">
            {`${suggestion.occurredOn} · ${amount}`}
          </Typography>
          {/* Relevance word carries the ranking cue; color only reinforces it. */}
          <Typography
            component="span"
            sx={{
              fontSize: 11.5,
              fontWeight: 600,
              px: 0.75,
              py: 0.125,
              borderRadius: '999px',
              bgcolor: 'var(--mg-raised)',
              border: '1px solid var(--mg-border-2)',
              color: relevanceColor(relevance),
            }}
          >
            {t(`match.relevance.${relevance}`)}
          </Typography>
        </Box>
      </Box>
      <Button
        onClick={onReview}
        size="small"
        variant="outlined"
        color="secondary"
        aria-label={t('match.reviewAria', {
          amount,
          name: suggestion.name,
          date: suggestion.occurredOn,
        })}
        sx={{
          flex: 'none',
          textTransform: 'none',
          fontWeight: 600,
          borderColor: 'var(--mg-border-2)',
          color: 'text.primary',
        }}
      >
        {t('match.review')}
      </Button>
    </Box>
  )
}

export interface MatchSuggestionsProps {
  /** The person whose ranked income-match suggestions to review. */
  personId: string
  /** The person's display name (for the confirm dialog + labels). */
  personName: string
}

export function MatchSuggestions({ personId, personName }: MatchSuggestionsProps) {
  const { t } = useTranslation('receivables')
  const suggestionsQuery = useReceivableMatchSuggestions(personId)
  const [selected, setSelected] = useState<MatchSuggestion | null>(null)

  // Highest score first (defensive — the server already ranks these).
  const suggestions = useMemo(
    () => [...(suggestionsQuery.data ?? [])].sort((a, b) => b.score - a.score),
    [suggestionsQuery.data],
  )

  let body: React.ReactNode
  if (suggestionsQuery.isPending) {
    body = (
      <Box aria-label={t('match.loadingAria')}>
        <Skeleton
          variant="rounded"
          height={44}
          sx={{ mb: 1, borderRadius: '10px' }}
        />
        <Skeleton variant="rounded" height={44} sx={{ borderRadius: '10px' }} />
      </Box>
    )
  } else if (suggestionsQuery.isError) {
    body = (
      <ErrorState
        title={t('match.errorTitle')}
        description={t('match.errorDescription')}
        onRetry={() => {
          void suggestionsQuery.refetch()
        }}
      />
    )
  } else if (suggestions.length === 0) {
    body = (
      <Typography
        sx={{ fontSize: 13.5, py: 1 }}
        color="text.secondary"
        role="status"
      >
        {t('match.empty')}
      </Typography>
    )
  } else {
    body = suggestions.map((suggestion) => (
      <SuggestionRow
        key={suggestion.transactionId}
        suggestion={suggestion}
        onReview={() => setSelected(suggestion)}
      />
    ))
  }

  return (
    <Box sx={{ mt: 2 }} aria-label={t('match.title')} component="section">
      <Typography
        sx={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 0.3 }}
        color="text.secondary"
      >
        {t('match.title')}
      </Typography>
      <Typography sx={{ fontSize: 12.5, mt: 0.25, mb: 0.5 }} color="text.secondary">
        {t('match.subtitle', { name: personName })}
      </Typography>

      {body}

      {selected ? (
        <ConfirmMatchForm
          key={`confirm-${selected.transactionId}`}
          open
          personId={personId}
          personName={personName}
          suggestion={selected}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </Box>
  )
}

export default MatchSuggestions
