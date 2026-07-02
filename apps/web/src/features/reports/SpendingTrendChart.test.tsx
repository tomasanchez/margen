/**
 * Render tests for {@link SpendingTrendChart} (ADR-163, ADR-166, ADR-037, ADR-019).
 *
 * The chart renders the reused 6-month summaries `trend` as a Recharts bar chart.
 * Recharts' `ResponsiveContainer` uses `ResizeObserver` (absent in jsdom) and
 * measures the DOM, so we assert on the accessible text summary (ADR-019) — the
 * same numbers as the visual bars — rather than the SVG geometry. Covered: the
 * populated figures; the loading skeleton; and the calm {@link ErrorState}
 * (never an eternal skeleton) when the summary query errors, with a wired retry.
 * English-pinned (ADR-105).
 */

import { beforeAll, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../../theme'
import { SpendingTrendChart } from './SpendingTrendChart'
import type { TrendPoint } from '../../mock/types'

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

const trend: TrendPoint[] = [
  { month: 'May', value: 300_000 },
  { month: 'Jun', value: 400_000, current: true },
]

function renderChart(
  props: Partial<React.ComponentProps<typeof SpendingTrendChart>> = {},
) {
  return render(
    <ThemeProvider theme={darkTheme}>
      <SpendingTrendChart trend={trend} loading={false} {...props} />
    </ThemeProvider>,
  )
}

describe('<SpendingTrendChart>', () => {
  test('renders the monthly figures in the accessible summary', () => {
    renderChart()
    // The accessible summary carries the same formatted figures as the bars (ADR-019).
    const summary = screen.getByText(/Monthly expenses:/i)
    expect(summary).toHaveTextContent('ARS 300.000')
    expect(summary).toHaveTextContent('ARS 400.000')
  })

  test('shows a skeleton while loading', () => {
    const { container } = renderChart({ trend: undefined, loading: true })
    expect(container.querySelector('.MuiSkeleton-root')).not.toBeNull()
    expect(screen.queryByText(/Monthly expenses:/i)).toBeNull()
  })

  test('renders the calm ErrorState (not a skeleton) when the query errors', () => {
    // Query error: isError, no data. Must NOT spin an eternal skeleton (ADR-037).
    const { container } = renderChart({ trend: undefined, isError: true })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/Couldn't load the spending trend/i)).toBeInTheDocument()
    expect(container.querySelector('.MuiSkeleton-root')).toBeNull()
  })

  test('offers a retry action wired to the callback on error', async () => {
    const onRetry = vi.fn()
    const user = userEvent.setup()
    renderChart({ trend: undefined, isError: true, onRetry })
    await user.click(screen.getByRole('button', { name: /retry|try again/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
