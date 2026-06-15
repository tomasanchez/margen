/**
 * Small formatting re-exports for the statement import feature (ADR-016/080).
 *
 * Keeps the feature's display formatting in one place while delegating to the
 * shared `lib/format` (money) and the existing ISO→short-date helper from the
 * Add/Edit form state, so date and money rendering never drift from the rest of
 * the app.
 */

export { formatCurrency } from '../../lib/format'
export { isoToDispDate as isoToDispDateLike } from '../transactions/useAddEditFormState'
