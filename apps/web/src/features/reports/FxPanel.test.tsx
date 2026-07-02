/**
 * Render tests for {@link FxPanel} (ADR-167, ADR-168).
 *
 * The panel shows the average CAPTURED MEP rate, an FX sparkline of the per-month
 * captured rate, and the USD invoiced this period. Asserts: the avg MEP + USD
 * invoiced render; a sparkline `<polyline>` is drawn when ≥2 months have a rate;
 * a null avg MEP degrades to a calm "no rate" note (never a fake 0); and the
 * inflation-adjusted "real spending" sub-panel from the concept is ABSENT
 * (deferred, ADR-171). English-pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../../theme'
import { FxPanel } from './FxPanel'
import type { FxSummary } from '../../api/reportsClient'

function renderPanel(fxSummary: FxSummary) {
  return render(
    <ThemeProvider theme={darkTheme}>
      <FxPanel fxSummary={fxSummary} />
    </ThemeProvider>,
  )
}

const populated: FxSummary = {
  avgMep: 1245,
  usdInvoiced: 3100,
  rateSeries: [
    { month: '2026-01', rate: 1205 },
    { month: '2026-02', rate: 1220 },
    { month: '2026-03', rate: 1245 },
  ],
}

describe('<FxPanel>', () => {
  test('renders the avg MEP, USD invoiced, and a sparkline', () => {
    const { container } = renderPanel(populated)

    expect(screen.getByText('1.245')).toBeInTheDocument()
    expect(screen.getByText('avg MEP captured')).toBeInTheDocument()
    expect(screen.getByText('USD 3.100')).toBeInTheDocument()
    expect(container.querySelectorAll('polyline')).toHaveLength(1)
  })

  test('degrades calmly when no month captured a rate (null avg MEP)', () => {
    const { container } = renderPanel({
      avgMep: null,
      usdInvoiced: 0,
      rateSeries: [
        { month: '2026-01', rate: null },
        { month: '2026-02', rate: null },
      ],
    })

    expect(screen.getByText('No rate captured')).toBeInTheDocument()
    // Fewer than two rated months → no sparkline drawn.
    expect(container.querySelectorAll('polyline')).toHaveLength(0)
  })

  test('omits the deferred inflation-adjusted sub-panel (ADR-171)', () => {
    renderPanel(populated)
    expect(screen.queryByText(/inflation/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/real spending/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Nominal/i)).not.toBeInTheDocument()
  })
})
