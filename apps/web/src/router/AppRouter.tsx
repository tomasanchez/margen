/**
 * AppRouter — bridges the live auth value into the router context (ADR-096).
 *
 * Sits just inside {@link AuthProvider} so it can read `useAuth()` and hand the
 * live value to `<RouterProvider context={{ auth }} />`. Because `context` is a
 * render prop on the provider, the router always sees the current session when
 * it (re-)evaluates `beforeLoad`. The matching `router.invalidate()` on every
 * auth change is wired by {@link AuthProvider}'s `onAuthChange` in main.tsx, so
 * a sign-in unlocks the guarded routes and a sign-out bounces back to `/login`
 * without a manual reload.
 */

import { RouterProvider } from '@tanstack/react-router'
import { useAuth } from '../auth/useAuth'
import { router } from '../router'

export function AppRouter() {
  const auth = useAuth()
  return <RouterProvider router={router} context={{ auth }} />
}

export default AppRouter
