/**
 * Render tests for {@link ForecastPanel} (ADR-176, ADR-177).
 *
 * Focus: the monotributo USD caveat (ADR-177). The AFIP-ARS cuota is a fixed
 * obligation the backend EXCLUDES from a USD total and returns only as its own ARS
 * commitment line; the panel then shows a calm note (echoing the ARS cuota) so the
 * USD forecast reads honestly. Asserts the caveat appears on a USD view when a
 * monotributo commitment is present, is absent on the ARS view (the cuota is
 * legitimately in the total), and that the chart total is the backend value — the
 * cuota is NOT added back in on USD. `useForecast` is mocked so no network runs;
 * the display currency is supplied via context. English-pinned (ADR-105).
 */

import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { darkTheme } from '../../theme'
import {
  DisplayCurrencyContext,
  DEFAULT_DISPLAY_CURRENCY_VALUE,
  type DisplayCurrencyValue,
} from '../settings/displayCurrencyContext'
import type { ForecastSeries } from '../../api/forecastClient'
import type { DisplayCurrency } from '../../api/settingsClient'
import { ForecastPanel } from './ForecastPanel'

// Mock the forecast query so the panel renders synchronously with a fixed series.
const useForecastMock = vi.fn()
vi.mock('./queries', () => ({
  useForecast: (...args: unknown[]) => useForecastMock(...args),
}))

/** A USD forecast series whose monotributo cuota is EXCLUDED from the totals. */
function usdSeries(): ForecastSeries {
  return {
    horizon: 6,
    currency: 'USD',
    // Backend totals exclude the ARS cuota on a USD request (ADR-177): the
    // subscription (USD 12/mo) is all that's committed here.
    months: [
      { month: '2026-08', committed: 12, total: 12, confidence: 'committed' },
      { month: '2026-09', committed: 12, total: 12, confidence: 'committed' },
    ],
    commitments: [
      {
        source: 'subscription',
        label: 'Figma',
        amount: 12,
        currency: 'USD',
        arsFixed: false,
        months: ['2026-08', '2026-09'],
        remainingCount: null,
      },
      {
        source: 'tax',
        label: 'Monotributo',
        amount: 85_000,
        currency: 'ARS',
        arsFixed: true,
        months: ['2026-08', '2026-09'],
        remainingCount: null,
      },
    ],
    unconverted: 0,
  }
}

function display(currency: DisplayCurrency): DisplayCurrencyValue {
  return {
    ...DEFAULT_DISPLAY_CURRENCY_VALUE,
    preferredCurrency: currency,
    effectiveCurrency: currency,
  }
}

/** Render the panel under a minimal memory router with a display-currency value. */
function renderPanel(value: DisplayCurrencyValue) {
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <ForecastPanel range="6M" />,
  })
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => <div>settings</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, settingsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <ThemeProvider theme={darkTheme}>
      <DisplayCurrencyContext.Provider value={value}>
        <RouterProvider router={router} />
      </DisplayCurrencyContext.Provider>
    </ThemeProvider>,
  )
}

describe('<ForecastPanel> monotributo USD caveat (ADR-177)', () => {
  test('shows the caveat on a USD view when a monotributo commitment exists', async () => {
    useForecastMock.mockReturnValue({ data: usdSeries(), isError: false })
    renderPanel(display('USD'))

    // Echoes the ARS cuota and states it is excluded from the USD total.
    expect(
      await screen.findByText(
        /Monotributo \(ARS 85\.000\/mo\) is shown separately/i,
      ),
    ).toBeInTheDocument()
  })

  test('does NOT add the cuota back into the USD total (chart shows backend value)', async () => {
    useForecastMock.mockReturnValue({ data: usdSeries(), isError: false })
    renderPanel(display('USD'))

    // The committed total is the backend value (USD 12 + USD 12 = USD 24) — the
    // ARS cuota is NOT re-converted or summed in.
    expect(await screen.findByText('USD 24')).toBeInTheDocument()
  })

  test('shows no caveat on the ARS view (the cuota is legitimately in the total)', async () => {
    useForecastMock.mockReturnValue({
      data: {
        ...usdSeries(),
        currency: 'ARS',
      } satisfies ForecastSeries,
      isError: false,
    })
    renderPanel(display('ARS'))

    // Wait for the panel to mount (its section title), then assert no caveat.
    expect(await screen.findByText('Cash-flow forecast')).toBeInTheDocument()
    expect(screen.queryByText(/is shown separately/i)).not.toBeInTheDocument()
  })
})
