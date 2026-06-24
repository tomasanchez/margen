/**
 * Typed router context for TanStack Router (ADR-096, ADR-014).
 *
 * The router is created with `createRootRouteWithContext<RouterContext>()` so
 * every route's `beforeLoad` receives a typed `context.auth` — the live auth
 * value provided by {@link AuthProvider}. Guards read `context.auth.session`
 * to decide whether to allow the route or redirect to `/login`.
 *
 * `main.tsx` passes the live value into `<RouterProvider context={{ auth }} />`
 * and calls `router.invalidate()` on every auth change so `beforeLoad`
 * re-evaluates with the fresh session (sign-in unlocks the app; sign-out kicks
 * back to `/login`). Kept in its own module so both the router definition and
 * the provider wiring import the same type without a cycle.
 */

import type { AuthContextValue } from '../auth/authContext'

/** The dependencies every route's `beforeLoad`/`loader` can read. */
export interface RouterContext {
  /** The live auth session + actions (ADR-096). */
  auth: AuthContextValue
}
