/**
 * Per-device collapsed/expanded state for a {@link CollapsibleSection}.
 *
 * A section's open/closed choice is a per-DEVICE view preference — not synced to
 * the backend or tied to the account — so it lives in localStorage rather than
 * server state (no TanStack Query), mirroring {@link useHomePrivacy} (ADR-157).
 * Default is EXPANDED: a returning user sees a section's content unless they
 * chose to collapse it on this device.
 *
 * SSR / absent-storage safe: every `localStorage` touch is guarded so a missing
 * or throwing storage (private mode, SSR) degrades to the default rather than
 * crashing the page. State is keyed per section
 * (`margen.accounts.section.<key>.collapsed`) so sections persist independently.
 */

import { useCallback, useState } from 'react'

/** Build the per-section localStorage key from a stable section key. */
export function sectionCollapsedStorageKey(key: string): string {
  return `margen.accounts.section.${key}.collapsed`
}

/** The persisted "collapsed" value; anything else (incl. absent) reads expanded. */
const STORED_COLLAPSED = '1'

/** Read the persisted preference, defaulting to expanded when unavailable. */
function readStored(key: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return (
      window.localStorage.getItem(sectionCollapsedStorageKey(key)) ===
      STORED_COLLAPSED
    )
  } catch {
    // Private mode / disabled storage: degrade to the default (expanded).
    return false
  }
}

/** Persist the preference, swallowing storage failures (quota / private mode). */
function writeStored(key: string, collapsed: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (collapsed) {
      window.localStorage.setItem(
        sectionCollapsedStorageKey(key),
        STORED_COLLAPSED,
      )
    } else {
      window.localStorage.removeItem(sectionCollapsedStorageKey(key))
    }
  } catch {
    // Best-effort: the in-memory state still updates so the UI stays correct
    // for this session even if persistence fails.
  }
}

export interface SectionCollapsed {
  /** Whether the section body is currently collapsed (hidden). */
  collapsed: boolean
  /** Flip the preference and persist it to localStorage. */
  toggle: () => void
}

/**
 * Own a section's collapsed toggle: `{ collapsed, toggle }`, initialized from
 * localStorage (lazily, so the read runs once per mount) and written through on
 * every change. Keyed per section so multiple sections persist independently.
 */
export function useSectionCollapsed(key: string): SectionCollapsed {
  const [collapsed, setCollapsed] = useState<boolean>(() => readStored(key))

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      writeStored(key, next)
      return next
    })
  }, [key])

  return { collapsed, toggle }
}
