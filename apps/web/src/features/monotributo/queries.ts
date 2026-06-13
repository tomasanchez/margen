/**
 * TanStack Query hooks for the Monotributo page, over the in-memory mock API
 * (ADR-015, ADR-023).
 *
 * The page reuses the Home `useMonotributo()` snapshot for the meter standing
 * (re-exported here for ergonomics) and adds three read-only reference queries:
 * the AFIP 2026 category scale, the fiscal-period invoices behind the annual
 * total, and the linear pace projection figures. All are seed snapshots in the
 * prototype (ADR-020 hardcodes the figures); they are keyed under a dedicated
 * `monotributo` namespace so a future backend swap is localized.
 */

import { useQuery } from '@tanstack/react-query'
import {
  getMonotributoInvoices,
  getMonotributoProjection,
  getMonotributoScale,
} from '../../mock/api'
import type {
  MonotributoInvoice,
  MonotributoProjection,
  MonotributoScaleRow,
} from '../../mock/types'

// Reuse the Home snapshot hook for the meter standing rather than duplicating it.
export { useMonotributo } from '../home/queries'

/** Stable query-key factory for the Monotributo domain. */
export const monotributoQueryKeys = {
  all: ['monotributo'] as const,
  scale: () => [...monotributoQueryKeys.all, 'scale'] as const,
  invoices: () => [...monotributoQueryKeys.all, 'invoices'] as const,
  projection: () => [...monotributoQueryKeys.all, 'projection'] as const,
}

/** Official AFIP/ARCA 2026 category scale A–K (reference data). */
export function useMonotributoScale() {
  return useQuery<MonotributoScaleRow[]>({
    queryKey: monotributoQueryKeys.scale(),
    queryFn: () => getMonotributoScale(),
    staleTime: Infinity,
  })
}

/** The fiscal-period invoices behind the annual total (oldest-first). */
export function useMonotributoInvoices() {
  return useQuery<MonotributoInvoice[]>({
    queryKey: monotributoQueryKeys.invoices(),
    queryFn: () => getMonotributoInvoices(),
  })
}

/** Linear pace projection figures for the meter + breakdown. */
export function useMonotributoProjection() {
  return useQuery<MonotributoProjection>({
    queryKey: monotributoQueryKeys.projection(),
    queryFn: () => getMonotributoProjection(),
  })
}
