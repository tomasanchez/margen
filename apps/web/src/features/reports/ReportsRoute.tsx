/**
 * Router bridge for the `/reports` screen (ADR-128, ADR-163).
 *
 * The route owns the router coupling: this component calls {@link useReportMonth}
 * — which reads the route's validated `?month=YYYY-MM` param and returns the live
 * month plus a URL-writing setter — and passes them to the router-agnostic
 * {@link ReportsPage} as props (mirroring {@link BudgetsRoute}). Keeping it in its
 * own module lets `router.tsx` keep exporting only the `router` value
 * (react-refresh components-only rule) and lets the page stay renderable
 * standalone in tests.
 */

import { ReportsPage } from './ReportsPage'
import { useReportMonth } from './useReportMonth'

/** Bind the URL-synced report month and hand it to the page. */
export function ReportsRoute() {
  const { month, setMonth } = useReportMonth()
  return <ReportsPage month={month} onMonthChange={setMonth} />
}

export default ReportsRoute
