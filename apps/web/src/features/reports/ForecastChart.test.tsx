/**
 * Render tests for {@link ForecastChart} (ADR-176, ADR-166, ADR-037).
 *
 * The chart plots the committed outflow per future month. Recharts'
 * `ResponsiveContainer` uses `ResizeObserver` (absent in jsdom) and measures the
 * DOM, so we assert on the accessible text summary (ADR-019) — the same numbers as
 * the visual bars — plus the committed total, rather than the SVG geometry.
 * Figures are ALREADY in the requested currency (ADR-168): the assertions use the
 * es-AR grouped strings verbatim (no re-conversion). Covered: the committed months
 * render + a total; the empty horizon degrades to a calm note (no crash).
 * English-pinned (ADR-105).
 */

import { beforeAll, describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../../theme'
import { ForecastChart } from './ForecastChart'
import type { ForecastMonth } from '../../api/forecastClient'

beforeAll(() => {
  // Recharts' ResponsiveContainer needs ResizeObserver; jsdom lacks it.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver =
    globalThis.ResizeObserver ??
    (ResizeObserverStub as unknown as typeof ResizeObserver)
})

const months: ForecastMonth[] = [
  { month: '2026-08', committed: 120_000, total: 120_000, confidence: 'committed' },
  { month: '2026-09', committed: 90_000, total: 90_000, confidence: 'committed' },
]

function renderChart(
  props: Partial<React.ComponentProps<typeof ForecastChart>> = {},
) {
  return render(
    <ThemeProvider theme={darkTheme}>
      <ForecastChart months={months} currency="ARS" {...props} />
    </ThemeProvider>,
  )
}

describe('<ForecastChart>', () => {
  test('renders the committed months in its accessible summary + a total', () => {
    renderChart()

    // The accessible summary carries the same figures as the bars (ADR-019).
    expect(screen.getByText(/committed ARS 120\.000/i)).toBeInTheDocument()
    expect(screen.getByText(/committed ARS 90\.000/i)).toBeInTheDocument()
    // The committed total (sum across the horizon) sits top-right.
    expect(screen.getByText('ARS 210.000')).toBeInTheDocument()
    expect(screen.getByText(/committed total/i)).toBeInTheDocument()
  })

  test('an empty horizon degrades to a calm note, not a crash', () => {
    renderChart({ months: [] })

    expect(
      screen.getByText(/No committed expenses to project yet/i),
    ).toBeInTheDocument()
    // No total is shown when there is nothing to project.
    expect(screen.queryByText(/committed total/i)).not.toBeInTheDocument()
  })

  test('formats figures in the requested currency without re-converting', () => {
    renderChart({
      months: [
        { month: '2026-08', committed: 500, total: 500, confidence: 'committed' },
      ],
      currency: 'USD',
    })

    // USD figures render verbatim in the requested currency (ADR-168).
    expect(screen.getByText(/committed USD 500/i)).toBeInTheDocument()
    expect(screen.getByText('USD 500')).toBeInTheDocument()
  })
})
