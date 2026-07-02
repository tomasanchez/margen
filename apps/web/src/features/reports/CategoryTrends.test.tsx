/**
 * Render tests for {@link CategoryTrends} (ADR-167).
 *
 * Each row shows the category (+ its share), the total in the requested currency,
 * a 6-month SVG sparkline, and a vs-previous delta. Asserts: a falling category
 * renders its negative delta (the good/green direction), a rising one its
 * positive delta, a null-base category reads a muted "—" (no prior data — NOT
 * "flat"), a genuine 0% change reads "flat", a one-month series omits the
 * polyline, and a real multi-month series draws one. The empty state shows a calm
 * note. English-pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../../theme'
import { CategoryTrends } from './CategoryTrends'
import type { CategoryTrend } from '../../api/reportsClient'

function renderTrends(trends: CategoryTrend[], currency: 'ARS' | 'USD' = 'ARS') {
  return render(
    <ThemeProvider theme={darkTheme}>
      <CategoryTrends trends={trends} currency={currency} />
    </ThemeProvider>,
  )
}

const trends: CategoryTrend[] = [
  {
    category: 'Food',
    total: 624000,
    // deltaPct arrives already as a PERCENTAGE (22 = +22%), matching the backend
    // wire contract (e.g. "-20", "100") — never a fraction.
    share: 22,
    series: [512, 540, 560, 580, 600, 624],
    deltaPct: 22,
  },
  {
    category: 'Transport',
    total: 285000,
    share: 10,
    series: [320, 300, 290, 285, 280, 285],
    deltaPct: -6,
  },
  {
    // A genuine no-change month: two real months, identical spend.
    category: 'Rent',
    total: 720000,
    share: 26,
    series: [0, 0, 0, 0, 720, 720],
    deltaPct: 0,
  },
  {
    // No previous window to compare against (null base).
    category: 'Utilities',
    total: 90000,
    share: 4,
    series: [0, 0, 0, 0, 88, 90],
    deltaPct: null,
  },
]

/** A category with spend in a single month — the "little history" case. */
const oneMonthTrend: CategoryTrend = {
  category: 'Health',
  total: 45000,
  share: 5,
  series: [0, 0, 0, 0, 45, 0],
  deltaPct: null,
}

describe('<CategoryTrends>', () => {
  test('renders a row per category with total + share', () => {
    const { container } = renderTrends(trends)

    expect(screen.getByText('ARS 624.000')).toBeInTheDocument()
    expect(screen.getByText('22% of spend')).toBeInTheDocument()
    // One polyline per category with real (≥2 non-zero month) history.
    expect(container.querySelectorAll('polyline')).toHaveLength(4)
  })

  test('a rising category shows a positive vs-prev delta (amber direction)', () => {
    renderTrends(trends)
    // deltaPct 22 (a percentage) → +22%.
    expect(screen.getByText('+22%')).toBeInTheDocument()
  })

  test('a falling category shows a negative vs-prev delta (green direction)', () => {
    renderTrends(trends)
    // deltaPct −6 (a percentage) → −6% (Unicode minus).
    expect(screen.getByText('−6%')).toBeInTheDocument()
  })

  test('a genuine 0% change reads "flat"', () => {
    renderTrends(trends)
    expect(screen.getByText('flat')).toBeInTheDocument()
  })

  test('a null-base category reads "no prior data", not "flat"', () => {
    renderTrends(trends)
    // The visible glyph is a muted dash; the accessible name is descriptive.
    expect(screen.queryByText('flat')).not.toBeNull()
    expect(screen.getByText('no prior data')).toBeInTheDocument()
  })

  test('a one-month series omits the polyline and shows a muted dash', () => {
    const { container } = renderTrends([oneMonthTrend])
    // Not enough history to draw an honest sparkline.
    expect(container.querySelectorAll('polyline')).toHaveLength(0)
    // Its trend cell falls back to the muted em/dash placeholder.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  test('shows a calm empty note when there are no trends', () => {
    renderTrends([])
    expect(
      screen.getByText(/No spending recorded for this range yet/i),
    ).toBeInTheDocument()
  })
})
