/**
 * Insights — a compact list of short observations (Issue #12, ADR-017).
 *
 * Each item pairs a colored dot (keyed to the insight kind, purely decorative)
 * with an uppercase eyebrow label and the insight text. The label carries the
 * category meaning so the dot color is never the only cue (ADR-019). This is a
 * deliberately small list, not a wall of charts (ADR-017).
 */

import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import type { Insight, InsightKind } from '../../mock/types'
import { SectionCard } from './SectionCard'

/** Dot token per insight kind — a redundant cue beside the text label. */
const KIND_DOT: Record<InsightKind, string> = {
  spending: 'var(--mg-watch)',
  recurring: 'var(--mg-text-2)',
  projection: 'var(--mg-safe)',
  fx: 'var(--mg-gold)',
}

export interface InsightsProps {
  insights: Insight[] | undefined
  loading?: boolean
}

function InsightRow({ insight }: { insight: Insight }) {
  return (
    <Box sx={{ display: 'flex', gap: 1.375, minWidth: 0 }}>
      <Box
        aria-hidden
        sx={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          flex: 'none',
          mt: '6px',
          bgcolor: KIND_DOT[insight.kind],
        }}
      />
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="overline" component="p" sx={{ mb: 0.375 }}>
          {insight.label}
        </Typography>
        <Typography
          sx={{ fontSize: 13.5, lineHeight: 1.45, textWrap: 'pretty' }}
          color="var(--mg-text-mid)"
        >
          {insight.text}
        </Typography>
      </Box>
    </Box>
  )
}

export function Insights({ insights, loading = false }: InsightsProps) {
  if (loading || !insights) {
    return (
      <SectionCard title="Insights">
        <Stack spacing={2}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Box key={i}>
              <Skeleton variant="text" width="30%" />
              <Skeleton variant="text" width="85%" />
            </Box>
          ))}
        </Stack>
      </SectionCard>
    )
  }

  if (insights.length === 0) {
    return (
      <SectionCard title="Insights">
        <Typography sx={{ fontSize: 13.5 }} color="text.disabled">
          No insights yet — add a few transactions to see patterns here.
        </Typography>
      </SectionCard>
    )
  }

  return (
    <SectionCard title="Insights">
      <Stack spacing={2}>
        {insights.map((insight) => (
          <InsightRow key={insight.id} insight={insight} />
        ))}
      </Stack>
    </SectionCard>
  )
}

export default Insights
