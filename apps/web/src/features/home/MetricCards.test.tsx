/**
 * Unit tests for the Home metric cards' privacy masking (ADR-157).
 *
 * The cards are fed a {@link MonthMetrics} + {@link MonotributoState} directly;
 * the display-currency conversion is covered elsewhere. These tests assert the
 * "hide amounts" toggle behavior at the display edge: when `hidden`, the Income /
 * Expenses / Est. savings VALUES are masked (with an accessible "hidden" label)
 * while the delta captions and the Monotributo margin stay visible. English-
 * pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ColorModeProvider } from '../../theme/colorMode'
import { DisplayCurrencyProvider } from '../settings/displayCurrency'
import { settingsQueryKeys } from '../settings/queries'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MetricCards, type MetricCardsProps } from './MetricCards'
import { maskAmount } from '../../lib/format'
import type { Settings } from '../../api/settingsClient'
import type { CommittedSplit } from '../../api/committedClient'
import type { MonthMetrics } from './homeMetrics'
import type { MonotributoState } from '../../mock/types'

/** Live month metrics with clean round figures for stable assertions. */
const METRICS: MonthMetrics = {
  income: 1_000_000,
  expenses: 400_000,
  savings: 600_000,
  savingsUsd: 480,
}

/** A minimal Monotributo standing so the margin card renders a real figure. */
const MONOTRIBUTO: MonotributoState = {
  status: 'watch',
  category: 'C',
  projectedCategory: 'D',
  usedRatio: 0.6,
  margin: 8_400_001,
} as MonotributoState

function renderCards(props: Partial<MetricCardsProps> = {}) {
  const queryClient = new QueryClient({
    // `staleTime: Infinity` + seeded settings below keep the DisplayCurrency
    // provider's `useSettings` query from firing a real (jsdom-rejecting) fetch
    // whose late rejection would otherwise leak into a later test's run.
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  // Seed settings (ARS default) so the provider resolves synchronously with no
  // network — no un-awaited fetch escapes this test.
  queryClient.setQueryData(settingsQueryKeys.detail(), {
    preferredDisplayCurrency: 'ARS',
    fxDefaultRateType: 'MEP',
    preferredRateSource: 'bolsa',
    monotributoCurrentCategory: 'C',
    monotributoActivityType: 'services',
    monotributoEnabled: true,
  } satisfies Settings)
  return render(
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <DisplayCurrencyProvider>
          <MetricCards
            metrics={METRICS}
            monotributo={MONOTRIBUTO}
            incomeDeltaPct={12}
            expenseDeltaPct={-8}
            previousMonthLabel="May"
            {...props}
          />
        </DisplayCurrencyProvider>
      </ColorModeProvider>
    </QueryClientProvider>,
  )
}

describe('MetricCards privacy masking', () => {
  test('shows the real Income / Expenses / Savings figures when not hidden', () => {
    renderCards({ hidden: false })

    expect(screen.getByText('ARS 1.000.000')).toBeInTheDocument()
    expect(screen.getByText('ARS 400.000')).toBeInTheDocument()
    expect(screen.getByText('ARS 600.000')).toBeInTheDocument()
    // No mask string anywhere while visible.
    expect(screen.queryByText(maskAmount())).not.toBeInTheDocument()
  })

  test('masks the Income / Expenses / Savings VALUES when hidden', () => {
    renderCards({ hidden: true })

    // The three headline values are gone, replaced by the mask (3 occurrences).
    expect(screen.queryByText('ARS 1.000.000')).not.toBeInTheDocument()
    expect(screen.queryByText('ARS 400.000')).not.toBeInTheDocument()
    expect(screen.queryByText('ARS 600.000')).not.toBeInTheDocument()
    expect(screen.getAllByText(maskAmount())).toHaveLength(3)
    // Each masked figure carries the accessible "hidden" label.
    expect(screen.getAllByLabelText('hidden')).toHaveLength(3)
  })

  test('keeps the delta captions and the Monotributo margin visible when hidden', () => {
    renderCards({ hidden: true })

    // Deltas stay (never masked).
    expect(screen.getByText('+12% vs. May')).toBeInTheDocument()
    expect(screen.getByText('−8% vs. May')).toBeInTheDocument()
    // The Monotributo margin figure is NOT masked (regulatory, always shown).
    expect(screen.getByText('ARS 8.400.001')).toBeInTheDocument()
  })
})

describe('MetricCards committed-spend accent (ADR-179)', () => {
  /** A split with both a paid share (already in Expenses) and pending outflows. */
  const COMMITTED_WITH_PENDING: CommittedSplit = {
    month: '2026-07',
    currency: 'ARS',
    paid: { subscription: 12_000, installment: 30_000, tax: 85_000, total: 127_000 },
    pending: { subscription: 5_000, installment: 0, tax: 0, total: 5_000 },
    unconverted: 0,
  }

  test('shows the paid committed share and the pending upcoming note under Expenses', () => {
    renderCards({ committed: COMMITTED_WITH_PENDING })

    // The obligated share already inside the Expenses total.
    expect(screen.getByText(/ARS 127\.000 committed/)).toBeInTheDocument()
    // The pending, clearly marked as still-committed this month (not in the total).
    expect(
      screen.getByText(/ARS 5\.000 still committed this month/),
    ).toBeInTheDocument()
  })

  test('hides the pending note when there is no pending committed spend', () => {
    renderCards({
      committed: {
        ...COMMITTED_WITH_PENDING,
        pending: { subscription: 0, installment: 0, tax: 0, total: 0 },
      },
    })

    expect(screen.getByText(/ARS 127\.000 committed/)).toBeInTheDocument()
    expect(
      screen.queryByText(/still committed this month/),
    ).not.toBeInTheDocument()
  })

  test('renders no accent at all when nothing is committed this month', () => {
    renderCards({
      committed: {
        ...COMMITTED_WITH_PENDING,
        paid: { subscription: 0, installment: 0, tax: 0, total: 0 },
        pending: { subscription: 0, installment: 0, tax: 0, total: 0 },
      },
    })

    expect(screen.queryByText(/committed/)).not.toBeInTheDocument()
  })

  test('does not re-convert — formats the split figure in the display currency as-is', () => {
    // The Expenses figure is ARS 400.000; the paid committed (127.000) is shown
    // verbatim in ARS (the effective currency), never divided by a rate.
    renderCards({ committed: COMMITTED_WITH_PENDING })
    expect(screen.getByText('ARS 400.000')).toBeInTheDocument()
    expect(screen.getByText(/ARS 127\.000 committed/)).toBeInTheDocument()
  })
})
