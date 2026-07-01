/**
 * Router bridge for the `/budgets` screen (ADR-040/125).
 *
 * The route owns the router coupling: this component calls {@link useBudgetMonth}
 * — which reads the route's validated `?month=YYYY-MM` param and returns the live
 * month plus a URL-writing setter — and passes them to the router-agnostic
 * {@link BudgetsPage} as props. Keeping it in its own module lets `router.tsx`
 * keep exporting only the `router` value (react-refresh components-only rule) and
 * lets the page stay renderable standalone in tests (it accepts an optional
 * month/setMonth bundle, defaulting to a local-state fallback).
 */

import { BudgetsPage } from './BudgetsPage'
import { useBudgetMonth } from './useBudgetMonth'

/** Bind the URL-synced budget month and hand it to the page. */
export function BudgetsRoute() {
  const { month, setMonth } = useBudgetMonth()
  return <BudgetsPage month={month} onMonthChange={setMonth} />
}

export default BudgetsRoute
