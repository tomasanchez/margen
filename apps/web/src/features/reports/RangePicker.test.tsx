/**
 * Tests for the range picker + its URL wiring (ADR-167).
 *
 * The picker is a segmented control over 3M / 6M / 12M / YTD; the selected range
 * lives in the URL as `?range=`. These mount the picker bound to the REAL
 * `useReportRange` hook under a memory router registered with
 * `validateReportsSearch`, then assert: selecting a non-default range WRITES
 * `?range=` to the URL; selecting the default 6M CLEARS it (short URL); and the
 * initial `?range=` in the URL drives the active segment. English-pinned (ADR-105).
 */

import { describe, expect, test } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '@mui/material/styles'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { darkTheme } from '../../theme'
import { RangePicker } from './RangePicker'
import { useReportRange } from './useReportRange'
import { validateReportsSearch } from './reportsSearch'

/** A tiny harness: the picker bound to the real URL-syncing hook. */
function RangeHarness() {
  const { range, setRange } = useReportRange()
  return (
    <>
      <div data-testid="active">{range}</div>
      <RangePicker value={range} onChange={setRange} />
    </>
  )
}

/** Mount the harness under a memory router at `/reports` with the given search. */
function renderPicker(initialEntry = '/reports') {
  const rootRoute = createRootRoute()
  const reportsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/reports',
    validateSearch: validateReportsSearch,
    component: RangeHarness,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([reportsRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  render(
    <ThemeProvider theme={darkTheme}>
      <RouterProvider router={router} />
    </ThemeProvider>,
  )
  return router
}

describe('RangePicker URL wiring', () => {
  test('defaults to 6M with no range in the URL', async () => {
    renderPicker('/reports')
    expect(await screen.findByTestId('active')).toHaveTextContent('6M')
  })

  test('selecting a non-default range writes ?range= to the URL', async () => {
    const router = renderPicker('/reports')
    await screen.findByTestId('active')

    await userEvent.click(screen.getByRole('button', { name: '12M' }))

    await waitFor(() =>
      expect(
        (router.state.location.search as { range?: string }).range,
      ).toBe('12M'),
    )
    expect(screen.getByTestId('active')).toHaveTextContent('12M')
  })

  test('selecting the default 6M clears the range from the URL (short URL)', async () => {
    const router = renderPicker('/reports?range=3M')
    await waitFor(() =>
      expect(screen.getByTestId('active')).toHaveTextContent('3M'),
    )

    await userEvent.click(screen.getByRole('button', { name: '6M' }))

    await waitFor(() =>
      expect(
        (router.state.location.search as { range?: string }).range,
      ).toBeUndefined(),
    )
  })

  test('an initial ?range= drives the active segment', async () => {
    renderPicker('/reports?range=YTD')
    await waitFor(() =>
      expect(screen.getByTestId('active')).toHaveTextContent('YTD'),
    )
  })
})
