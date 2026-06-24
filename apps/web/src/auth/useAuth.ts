/**
 * `useAuth` — read the live auth session + actions (ADR-096).
 *
 * Thin hook over {@link AuthContext}; kept separate from the context module so
 * consumers import a hook (stable API) rather than the raw context object.
 */

import { useContext } from 'react'
import { AuthContext, type AuthContextValue } from './authContext'

/** Access the current session, user, loading flag, and auth actions. */
export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}
