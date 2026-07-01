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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MetricCards, type MetricCardsProps } from './MetricCards'
import { maskAmount } from '../../lib/format'
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
    defaultOptions: { queries: { retry: false } },
  })
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
