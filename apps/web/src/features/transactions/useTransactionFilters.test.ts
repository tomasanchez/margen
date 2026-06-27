/**
 * Tests for the URL-synced Transactions filters hook (ADR-116).
 *
 * The pure URL <-> filter mapping (`validateTransactionsSearch`, `searchToFilters`,
 * `filtersToSearch`) is covered in filtering.test.ts. Here we cover the hook:
 * `useTransactionFilters` derives the live filters from the route search, and its
 * controls navigate in `replace` mode with the default-omitted encoding. The hook
 * MUST run inside a router for the `/transactions` route, so the harness mounts a
 * real memory router and reads the hook through an in-route consumer.
 */

import { describe, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { act, render } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { currentViewingMonth, serializeMonth } from '../../components/months'
import { validateTransactionsSearch } from './filtering'
import {
  useTransactionFilters,
  type UseTransactionFilters,
} from './useTransactionFilters'

/**
 * Mount a memory router at `entry` with a `/transactions` route validated exactly
 * like the app, exposing the hook's value via a captured ref so a test can read
 * filters and fire controls, and the router so it can assert the resulting URL.
 */
function renderFiltersAt(entry: string) {
  const captured: { current: UseTransactionFilters | null } = { current: null }
  const rootRoute = createRootRoute()
  // An uppercase named component so the `useTransactionFilters` call satisfies
  // the rules-of-hooks lint (a route `component` is rendered as a component).
  function FiltersProbe() {
    captured.current = useTransactionFilters()
    return null
  }
  const transactionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/transactions',
    validateSearch: validateTransactionsSearch,
    component: FiltersProbe,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([transactionsRoute]),
    history: createMemoryHistory({ initialEntries: [entry] }),
  })
  render(createElement(RouterProvider, { router }))
  return { router, captured }
}

describe('useTransactionFilters (URL-synced)', () => {
  test('derives current-month default filters from an empty search', async () => {
    const { captured } = renderFiltersAt('/transactions')
    await vi.waitFor(() => expect(captured.current).not.toBeNull())
    const { filters } = captured.current!
    expect(filters.month).toEqual(currentViewingMonth())
    expect(filters.type).toBe('all')
    expect(filters.categories).toEqual([])
  })

  test('a deep-linked search hydrates the matching filters', async () => {
    const { captured } = renderFiltersAt(
      '/transactions?type=invoice&month=last12',
    )
    await vi.waitFor(() => expect(captured.current).not.toBeNull())
    expect(captured.current!.filters.type).toBe('invoice')
    expect(captured.current!.filters.month).toBe('last12')
  })

  test('setType writes a replace navigation with only the non-default param', async () => {
    const { router, captured } = renderFiltersAt('/transactions')
    await vi.waitFor(() => expect(captured.current).not.toBeNull())

    act(() => {
      captured.current!.controls.setType('invoice')
    })
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({ type: 'invoice' }),
    )
    // The current-month default is omitted — only `type` is serialized.
    expect(router.state.location.search).not.toHaveProperty('month')
  })

  test('setMonth to a specific month serializes YYYY-MM', async () => {
    const { router, captured } = renderFiltersAt('/transactions')
    await vi.waitFor(() => expect(captured.current).not.toBeNull())

    act(() => {
      captured.current!.controls.setMonth({ year: 2026, month: 4 })
    })
    const expected = serializeMonth({ year: 2026, month: 4 })
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({ month: expected }),
    )
  })

  test('toggleAccount writes the account id to the URL (ADR-134)', async () => {
    const { router, captured } = renderFiltersAt('/transactions')
    await vi.waitFor(() => expect(captured.current).not.toBeNull())

    act(() => {
      captured.current!.controls.toggleAccount('acc-1')
    })
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({ account: 'acc-1' }),
    )

    // Toggling the same id off drops the param.
    act(() => {
      captured.current!.controls.toggleAccount('acc-1')
    })
    await vi.waitFor(() =>
      expect(router.state.location.search).not.toHaveProperty('account'),
    )
  })

  test('clear widens to All time (month=all) and drops every other param', async () => {
    const { router, captured } = renderFiltersAt(
      '/transactions?type=invoice&category=Food',
    )
    await vi.waitFor(() => expect(captured.current).not.toBeNull())

    act(() => {
      captured.current!.controls.clear()
    })
    await vi.waitFor(() =>
      expect(router.state.location.search).toEqual({ month: 'all' }),
    )
  })
})
