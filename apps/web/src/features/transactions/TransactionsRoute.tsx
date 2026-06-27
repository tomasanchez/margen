/**
 * Router bridge for the `/transactions` screen (ADR-116).
 *
 * The route owns the router coupling: this component calls
 * {@link useTransactionFilters} — which reads the route's validated search params
 * and returns a `{ filters, controls }` bundle (filters DERIVED from the URL,
 * controls navigating in `replace` mode) — and passes it to the router-agnostic
 * {@link TransactionsPage} as props. Keeping it in its own module lets `router.tsx`
 * keep exporting only the `router` value (react-refresh components-only rule) and
 * lets the page stay rendrable standalone in tests (ADR-062 note on its props).
 */

import { TransactionsPage } from './TransactionsPage'
import { useTransactionFilters } from './useTransactionFilters'

/** Bind the URL-synced filters and hand them to the page. */
export function TransactionsRoute() {
  const { filters, controls } = useTransactionFilters()
  return <TransactionsPage filters={filters} controls={controls} />
}
