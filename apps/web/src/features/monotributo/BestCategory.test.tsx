/**
 * BestCategory tests (ADR-200, ADR-019 non-color cues, ADR-037 calm states).
 *
 * The block reads the standing's `recommendation` and renders one of three calm
 * states, all conveyed by words: a fitting recommendation (category + fees +
 * effective rate), an above-scale note (points at the régimen general), and a
 * null nudge. English is asserted (the suite is en-pinned). The `<Trans>` body
 * fragments the sentence across spans, so the interpolated figures are asserted
 * individually rather than as one contiguous string.
 */

import { describe, expect, test } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '../../test/renderWithProviders'
import { BestCategory } from './BestCategory'
import type { MonotributoRecommendation } from '../../mock/types'

const FITTING: MonotributoRecommendation = {
  avgMonthlyExpenses: 850_000,
  neededAnnualInvoicing: 10_200_000,
  category: 'B',
  monthlyFee: 48_251,
  annualFee: 579_012,
  effectiveTaxRatePct: 5.68,
  aboveScale: false,
}

describe('BestCategory', () => {
  test('renders the recommended category, its fees, expenses and the effective rate', () => {
    renderWithProviders(<BestCategory recommendation={FITTING} />)

    // The section heading is always present.
    expect(
      screen.getByRole('heading', { name: 'Best category for you' }),
    ).toBeInTheDocument()

    // The recommended category letter is emphasized in its own span (exact).
    expect(screen.getByText('B')).toBeInTheDocument()
    // The monthly fee is wrapped in its own emphasized span (exact match).
    expect(screen.getByText('ARS 48.251')).toBeInTheDocument()
    // The unwrapped figures sit inside the surrounding sentence — matched as
    // substrings. es-AR ARS grouping (ADR-102).
    expect(screen.getByText(/ARS 850\.000/)).toBeInTheDocument()
    expect(screen.getByText(/ARS 10\.200\.000/)).toBeInTheDocument()
    expect(screen.getByText(/ARS 579\.012/)).toBeInTheDocument()
    // The effective rate is spelled out with its percent sign (word, not color).
    // The suite is pinned to English, so the decimal separator is a dot.
    expect(screen.getByText('5.68%')).toBeInTheDocument()
  })

  test('above-scale points at the régimen general and names no best-fit category', () => {
    renderWithProviders(
      <BestCategory
        recommendation={{ ...FITTING, aboveScale: true }}
      />,
    )

    expect(
      screen.getByText(/beyond the top Monotributo category/),
    ).toBeInTheDocument()
    expect(screen.getByText(/régimen general/)).toBeInTheDocument()
    // No fitting category is named — the letter chip from the fitting body is absent.
    expect(screen.queryByText('B')).not.toBeInTheDocument()
  })

  test('null recommendation renders the calm nudge to add expenses', () => {
    renderWithProviders(<BestCategory recommendation={null} />)

    expect(
      screen.getByText(
        "Add a few expenses and we'll suggest the most cost-effective category.",
      ),
    ).toBeInTheDocument()
  })
})
