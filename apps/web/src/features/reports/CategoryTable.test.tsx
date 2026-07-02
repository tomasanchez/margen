/**
 * Render tests for {@link CategoryTable} (ADR-163, ADR-019).
 *
 * The table renders the reused summaries `categories` in the display currency
 * with the SIGNED month-over-month delta (rises AND falls, never color alone).
 * Covered: the populated rows (category label, ARS amount, share, +/− delta), the
 * loading skeleton, and the empty state. English-pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../../theme'
import { CategoryTable } from './CategoryTable'
import type { CategorySpend } from '../../mock/types'

const categories: CategorySpend[] = [
  { category: 'Food', amount: 300_000, pct: 50, deltaPct: 12, up: '+12%' },
  { category: 'Rent', amount: 200_000, pct: 33.33, deltaPct: -8 },
  { category: 'Health', amount: 100_000, pct: 16.67, deltaPct: null },
]

function renderTable(props: Partial<React.ComponentProps<typeof CategoryTable>> = {}) {
  return render(
    <ThemeProvider theme={darkTheme}>
      <CategoryTable categories={categories} loading={false} {...props} />
    </ThemeProvider>,
  )
}

describe('<CategoryTable>', () => {
  test('renders a row per category with amount, share, and signed delta', () => {
    renderTable()
    const table = screen.getByRole('table', { name: /spending by category/i })

    const food = within(table).getByText('Food').closest('tr')!
    expect(within(food).getByText('ARS 300.000')).toBeInTheDocument()
    expect(within(food).getByText('50%')).toBeInTheDocument()
    expect(within(food).getByText('+12%')).toBeInTheDocument()

    // A fall shows a signed negative delta (not just the Home "up" badge).
    const rent = within(table).getByText('Rent').closest('tr')!
    expect(within(rent).getByText('−8%')).toBeInTheDocument()

    // A null prior month shows the em-dash placeholder, not a broken percent.
    const health = within(table).getByText('Health').closest('tr')!
    expect(within(health).getByText('—')).toBeInTheDocument()
  })

  test('shows a skeleton while loading', () => {
    const { container } = renderTable({ categories: undefined, loading: true })
    expect(container.querySelector('.MuiSkeleton-root')).not.toBeNull()
  })

  test('shows the empty state when there is no spend', () => {
    renderTable({ categories: [] })
    expect(screen.getByText(/No spending recorded/i)).toBeInTheDocument()
  })
})
