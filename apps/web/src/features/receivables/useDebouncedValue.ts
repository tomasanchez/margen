/**
 * Debounce a fast-changing value (a typed amount or search text) so a query keyed
 * on it only fires once the user pauses — the receivables suggested-allocation
 * prefill and the expense link picker search (ADR-220/221). Mirrors the
 * transactions search box's 300ms pause (ADR-116).
 */

import { useEffect, useState } from 'react'

/** The default pause before a debounced value settles. */
export const DEBOUNCE_MS = 300

/** Return `value` once it has stopped changing for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs: number = DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}
