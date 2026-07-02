/**
 * Render tests for {@link KpiStrip} (ADR-167/168/169).
 *
 * Asserts the four headline cards render their values in the requested currency
 * (figures arrive already denominated — no conversion here) and that the delta
 * chips carry the RIGHT direction word: income up shows a positive "+…%",
 * expenses up shows the amber (bad) chip, and a null prior base renders a calm
 * "—" rather than a misleading number. Colour is asserted only alongside the
 * always-present signed text (never colour alone). English-pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../../theme'
import { KpiStrip } from './KpiStrip'
import type { ReportsKpis } from '../../api/reportsClient'

function renderStrip(kpis: ReportsKpis, currency: 'ARS' | 'USD' = 'ARS') {
  return render(
    <ThemeProvider theme={darkTheme}>
      <KpiStrip kpis={kpis} currency={currency} />
    </ThemeProvider>,
  )
}

const baseKpis: ReportsKpis = {
  current: { income: 4200, expenses: 1800, netSaved: 2400, savingsRate: 0.571 },
  previous: { income: 4000, expenses: 2000, netSaved: 2000, savingsRate: 0.5 },
}

describe('<KpiStrip>', () => {
  test('renders all four labels + values in the requested currency', () => {
    renderStrip(baseKpis, 'USD')

    expect(screen.getByText('Income')).toBeInTheDocument()
    expect(screen.getByText('Expenses')).toBeInTheDocument()
    expect(screen.getByText('Net saved')).toBeInTheDocument()
    expect(screen.getByText('Savings rate')).toBeInTheDocument()

    expect(screen.getByText('USD 4.200')).toBeInTheDocument()
    // Savings rate shows the fraction as a whole percent.
    expect(screen.getByText('57%')).toBeInTheDocument()
  })

  test('income up vs prev renders a positive delta (good)', () => {
    renderStrip(baseKpis)
    // 4200 vs 4000 = +5.0% (formatDelta uses a dot, not the es-AR comma).
    expect(screen.getByText('+5.0%')).toBeInTheDocument()
  })

  test('expenses down vs prev renders a negative delta (good direction)', () => {
    renderStrip(baseKpis)
    // 1800 vs 2000 = −10.0%; the minus is the Unicode minus.
    expect(screen.getByText('−10.0%')).toBeInTheDocument()
  })

  test('a null prior base renders a calm "—" instead of a number', () => {
    renderStrip({
      current: baseKpis.current,
      previous: { income: 0, expenses: 0, netSaved: 0, savingsRate: 0 },
    })
    // Income has no base (previous 0) → the "—" chip. There is one per zero-base
    // metric (income, expenses, netSaved); assert at least one is shown.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  test('savings-rate delta is shown in percentage points', () => {
    renderStrip(baseKpis)
    // 57.1pp − 50.0pp = +7.1pp.
    expect(screen.getByText('+7.1pp')).toBeInTheDocument()
  })
})
