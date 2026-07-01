/**
 * Home "hide amounts" privacy toggle state (ADR-157).
 *
 * A per-DEVICE preference — NOT synced to the backend or tied to the account —
 * so it belongs in localStorage rather than server state (no TanStack Query).
 * Default is OFF (amounts visible): privacy is opt-in, and a returning user sees
 * their figures unless they chose otherwise on this device.
 *
 * The masking is display-only (the values are still fetched, ADR-157) so
 * toggling off is instant; this hook owns nothing but the boolean + its
 * persistence. SSR / absent-storage safe: every `localStorage` touch is guarded
 * so a missing or throwing storage (private mode, SSR) degrades to the default
 * rather than crashing Home.
 */

import { useCallback, useState } from 'react'

/** localStorage key for the per-device Home privacy preference. */
export const HOME_PRIVACY_STORAGE_KEY = 'margen.home.privacy'

/** The persisted "on" value; anything else (incl. absent) reads as visible. */
const STORED_ON = '1'

/** Read the persisted preference, defaulting to visible when unavailable. */
function readStored(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(HOME_PRIVACY_STORAGE_KEY) === STORED_ON
  } catch {
    // Private mode / disabled storage: degrade to the default.
    return false
  }
}

/** Persist the preference, swallowing storage failures (quota / private mode). */
function writeStored(hidden: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (hidden) {
      window.localStorage.setItem(HOME_PRIVACY_STORAGE_KEY, STORED_ON)
    } else {
      window.localStorage.removeItem(HOME_PRIVACY_STORAGE_KEY)
    }
  } catch {
    // Best-effort: the in-memory state still updates so the UI stays correct
    // for this session even if persistence fails.
  }
}

export interface HomePrivacy {
  /** Whether the headline amounts are currently masked. */
  hidden: boolean
  /** Flip the preference and persist it to localStorage. */
  toggle: () => void
}

/**
 * Own the Home privacy toggle: `{ hidden, toggle }`, initialized from
 * localStorage (lazily, so the read runs once) and written through on every
 * change.
 */
export function useHomePrivacy(): HomePrivacy {
  const [hidden, setHidden] = useState<boolean>(readStored)

  const toggle = useCallback(() => {
    setHidden((prev) => {
      const next = !prev
      writeStored(next)
      return next
    })
  }, [])

  return { hidden, toggle }
}
