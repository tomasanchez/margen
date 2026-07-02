/**
 * Router bridge for the `/reports` screen (ADR-167).
 *
 * The route owns the router coupling: this component calls {@link useReportRange}
 * — which reads the route's validated `?range=` param and returns the live range
 * plus a URL-writing setter — and passes them to the router-agnostic
 * {@link ReportsPage} as props (mirroring {@link BudgetsRoute}). Keeping it in its
 * own module lets `router.tsx` keep exporting only the `router` value
 * (react-refresh components-only rule) and lets the page stay renderable
 * standalone in tests.
 */

import { ReportsPage } from './ReportsPage'
import { useReportRange } from './useReportRange'

/** Bind the URL-synced report range and hand it to the page. */
export function ReportsRoute() {
  const { range, setRange } = useReportRange()
  return <ReportsPage range={range} onRangeChange={setRange} />
}

export default ReportsRoute
