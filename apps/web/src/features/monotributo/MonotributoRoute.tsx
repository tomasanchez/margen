/**
 * MonotributoRoute — the settings-gated entry to the Monotributo page (ADR-126).
 *
 * Monotributo is an optional module: when a user has it disabled
 * (`monotributoEnabled === false`), the page is inaccessible. This guard reads
 * the flag from the single settings query (the same source the nav item and
 * Home card read, mirroring the display-currency provider pattern, ADR-056) and:
 *
 *  - while settings are still loading (flag unknown), renders nothing so the
 *    page never flashes then redirects — a clean, flicker-free gate;
 *  - once settled and DISABLED, redirects to Home (`/`) so a disabled user who
 *    types/bookmarks `/monotributo` lands somewhere calm rather than on a module
 *    that should be hidden (ADR-126, ADR-014);
 *  - once settled and ENABLED, renders the real {@link MonotributoPage}.
 *
 * The guard lives in the component tree (not `beforeLoad`) because the flag is
 * TanStack Query server state, not router context — gating here keeps the read
 * path identical to nav/Home and avoids threading the query client through the
 * router context just for this one route.
 */

import { Navigate } from '@tanstack/react-router'
import { useMonotributoEnabled } from '../settings/queries'
import { MonotributoPage } from './MonotributoPage'

export function MonotributoRoute() {
  const { enabled, settled } = useMonotributoEnabled()

  // Flag not yet known: render nothing rather than flashing the page (or a
  // disabled state) that we might immediately replace once settings resolve.
  if (!settled) return null

  // Settled + disabled: the module is hidden everywhere, so a direct visit lands
  // back on Home (ADR-126).
  if (!enabled) return <Navigate to="/" replace />

  return <MonotributoPage />
}

export default MonotributoRoute
