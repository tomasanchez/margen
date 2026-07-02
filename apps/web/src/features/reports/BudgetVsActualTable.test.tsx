/**
 * Render tests for {@link BudgetVsActualTable} (ADR-163, ADR-019).
 *
 * The table renders the reused budgets period (target vs spent/remaining) in the
 * budget's own currency. Covered: only target-bearing rows appear; an over-budget
 * remaining is flagged with an explicit "over" word (not color alone); the
 * loading skeleton; and the empty state when no category has a target.
 * English-pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../../theme'
import { BudgetVsActualTable } from './BudgetVsActualTable'
import type { BudgetCategory, BudgetPeriod } from '../../api/budgetsClient'

function line(overrides: Partial<BudgetCategory>): BudgetCategory {
  return {
    category: 'Food',
    target: '120000.00',
    targetCurrency: 'ARS',
    spent: '90000.00',
    reimbursed: '0',
    remaining: '30000.00',
    isEssential: true,
    ...overrides,
  }
}

const period: BudgetPeriod = {
  month: '2026-06',
  currency: 'ARS',
  categories: [
    line({ category: 'Food', target: '120000.00', spent: '90000.00', remaining: '30000.00' }),
    line({ category: 'Rent', target: '200000.00', spent: '250000.00', remaining: '-50000.00' }),
    // Target-less row: excluded from the comparison table.
    line({ category: 'Health', target: null, remaining: null }),
  ],
  savings: [],
  floor: null,
  suggestedStrategy: null,
  pressure: null,
  unconverted: 0,
}

function renderTable(props: Partial<React.ComponentProps<typeof BudgetVsActualTable>> = {}) {
  return render(
    <ThemeProvider theme={darkTheme}>
      <BudgetVsActualTable period={period} loading={false} {...props} />
    </ThemeProvider>,
  )
}

describe('<BudgetVsActualTable>', () => {
  test('renders only target-bearing rows with target, spent, and remaining', () => {
    renderTable()
    const table = screen.getByRole('table', { name: /budget versus actual/i })

    const food = within(table).getByText('Food').closest('tr')!
    expect(within(food).getByText('ARS 120.000')).toBeInTheDocument()
    expect(within(food).getByText('ARS 90.000')).toBeInTheDocument()
    expect(within(food).getByText('ARS 30.000')).toBeInTheDocument()

    // The target-less Health row is not part of the comparison.
    expect(within(table).queryByText('Health')).toBeNull()
  })

  test('flags an over-budget remaining with an explicit "over" word', () => {
    renderTable()
    const table = screen.getByRole('table', { name: /budget versus actual/i })
    const rent = within(table).getByText('Rent').closest('tr')!
    // The magnitude plus the "over" word — not color alone (ADR-019).
    expect(within(rent).getByText(/ARS 50\.000 over/i)).toBeInTheDocument()
  })

  test('shows a skeleton while loading', () => {
    const { container } = renderTable({ period: undefined, loading: true })
    expect(container.querySelector('.MuiSkeleton-root')).not.toBeNull()
  })

  test('shows the empty state when no category has a target', () => {
    renderTable({
      period: { ...period, categories: [line({ target: null, remaining: null })] },
    })
    expect(screen.getByText(/No budget targets set/i)).toBeInTheDocument()
  })
})
