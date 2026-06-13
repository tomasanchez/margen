/**
 * Connection-state derivation for the backend readiness indicator (ADR-006).
 *
 * Kept in a non-component module so the React component file stays
 * Fast-Refresh-friendly (it must only export components) and so tests can
 * exercise the mapping directly.
 */

export type ConnectionState = 'connecting' | 'connected' | 'error'

/**
 * Derive the discrete connection state from the readiness query flags.
 *
 * Exported so tests can exercise the mapping directly, and to keep the
 * component a thin presentation layer over the readiness query.
 */
export function deriveConnectionState(query: {
  isSuccess: boolean
  isError: boolean
}): ConnectionState {
  if (query.isSuccess) return 'connected'
  if (query.isError) return 'error'
  return 'connecting'
}
