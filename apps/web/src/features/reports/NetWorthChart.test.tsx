/**
 * Render tests for {@link NetWorthChart} (ADR-164, ADR-166, ADR-037).
 *
 * The chart converts the NATIVE per-currency history to the display currency at a
 * stubbed live rate and renders a Recharts line. Recharts' `ResponsiveContainer`
 * uses `ResizeObserver` (absent in jsdom) and measures the DOM, so we assert on
 * the accessible text summary (ADR-019) — the same numbers as the visual line —
 * rather than the SVG geometry. Covered: the converted ARS figures at the stubbed
 * rate; the loading skeleton (rate pending); the empty state; and the calm
 * "rate unavailable" degrade when a cross-currency balance has no rate.
 * English-pinned (ADR-105).
 */

import { beforeAll, describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../../theme'
import { NetWorthChart } from './NetWorthChart'
import type { NetWorthHistory } from '../../api/reportsClient'

beforeAll(() => {
  // Recharts' ResponsiveContainer needs ResizeObserver; jsdom lacks it.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver =
    globalThis.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver)
})

const history: NetWorthHistory = {
  months: [
    { month: '2026-01', arsTotal: 1_000_000, usdTotal: 0 },
    { month: '2026-02', arsTotal: 1_000_000, usdTotal: 100 },
  ],
}

function renderChart(props: Partial<React.ComponentProps<typeof NetWorthChart>> = {}) {
  return render(
    <ThemeProvider theme={darkTheme}>
      <NetWorthChart
        history={history}
        loading={false}
        displayCurrency="ARS"
        rate={1200}
        rateLoading={false}
        {...props}
      />
    </ThemeProvider>,
  )
}

describe('<NetWorthChart>', () => {
  test('converts native subtotals to the display currency at the stubbed rate', () => {
    renderChart()
    // Jan: 1.000.000 ARS (no USD). Feb: 1.000.000 + 100 × 1200 = 1.120.000 ARS.
    // The accessible summary carries both formatted figures (ADR-019).
    const summary = screen.getByText(/Net worth by month/i)
    expect(summary).toHaveTextContent('ARS 1.000.000')
    expect(summary).toHaveTextContent('ARS 1.120.000')
  })

  test('shows a skeleton while the live rate is loading', () => {
    const { container } = renderChart({ rateLoading: true })
    expect(container.querySelector('.MuiSkeleton-root')).not.toBeNull()
    expect(screen.queryByText(/Net worth by month/i)).toBeNull()
  })

  test('shows the empty state when there is no history', () => {
    renderChart({ history: { months: [] } })
    expect(screen.getByText(/No balance history yet/i)).toBeInTheDocument()
  })

  test('degrades to a calm note when a cross-currency month has no rate', () => {
    // USD display + only-ARS months need a rate; none → every value degrades.
    renderChart({ displayCurrency: 'USD', rate: null })
    expect(screen.getByText(/Live rate unavailable/i)).toBeInTheDocument()
  })
})
