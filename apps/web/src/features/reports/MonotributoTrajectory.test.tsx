/**
 * Render tests for {@link MonotributoTrajectory} (ADR-167, ADR-170).
 *
 * The panel is a ceiling-awareness view from the trailing-12 reader: invoiced
 * (`used`) vs the category ceiling (`annualLimit`). Asserts the invoiced/ceiling
 * figures render, an under-ceiling standing shows the "OK" badge + a "remaining"
 * row, and an OVER-ceiling standing shows the "Watch" badge + an "over by" row
 * with the over-shoot magnitude — proving the panel reflects used vs limit. NO
 * forward-projection copy is present (deferred, ADR-170). It links to the planner.
 * Rendered under a memory router (the panel uses a router `<Link>`). English-
 * pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
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
import { MonotributoTrajectory } from './MonotributoTrajectory'
import type { MonotributoStanding, StatusLevel } from '../../mock/types'

function standing(overrides: Partial<MonotributoStanding> = {}): MonotributoStanding {
  return {
    category: 'C',
    activityType: 'services',
    annualLimit: 21_000_000,
    used: 12_710_000,
    remaining: 8_290_000,
    percentUsed: 60,
    ratio: 0.6,
    status: 'watch' as StatusLevel,
    projectedCategory: 'C',
    projectionNote: '',
    periodStart: '2025-07-01',
    periodEnd: '2026-06-30',
    ...overrides,
  }
}

/** Render the panel under a minimal memory router (it uses a router `<Link>`). */
function renderPanel(model: MonotributoStanding) {
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <MonotributoTrajectory standing={model} />,
  })
  const monotributoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/monotributo',
    component: () => <div>planner</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, monotributoRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <ThemeProvider theme={darkTheme}>
      <RouterProvider router={router} />
    </ThemeProvider>,
  )
}

describe('<MonotributoTrajectory>', () => {
  test('renders invoiced + ceiling figures and links to the planner', async () => {
    renderPanel(standing())

    expect(await screen.findByText('ARS 12.710.000')).toBeInTheDocument()
    expect(screen.getByText('ARS 21.000.000')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /Open Monotributo planner/i }),
    ).toBeInTheDocument()
  })

  test('under ceiling: OK badge + remaining row (used < limit)', async () => {
    renderPanel(standing({ status: 'safe', used: 10_000_000, remaining: 11_000_000 }))

    expect(await screen.findByText('OK')).toBeInTheDocument()
    expect(screen.getByText(/Remaining before ceiling/i)).toBeInTheDocument()
    expect(screen.getByText('ARS 11.000.000')).toBeInTheDocument()
  })

  test('over ceiling: Watch badge + over-by row with the overshoot', async () => {
    renderPanel(
      standing({
        status: 'over',
        used: 24_000_000,
        annualLimit: 21_000_000,
        remaining: -3_000_000,
        percentUsed: 114,
      }),
    )

    expect(await screen.findByText('Watch')).toBeInTheDocument()
    expect(screen.getByText(/Over the ceiling by/i)).toBeInTheDocument()
    // The overshoot magnitude (|remaining|) is shown.
    expect(screen.getByText('ARS 3.000.000')).toBeInTheDocument()
    // The "over ceiling" legend appears only when invoiced crossed the ceiling.
    expect(screen.getByText(/Over ceiling/i)).toBeInTheDocument()
  })

  test('shows no forward-projection copy (deferred, ADR-170)', async () => {
    renderPanel(standing())
    await screen.findByText('ARS 12.710.000')
    expect(screen.queryByText(/Projected/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/next 12/i)).not.toBeInTheDocument()
  })
})
