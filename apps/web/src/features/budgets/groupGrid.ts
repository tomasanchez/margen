/**
 * Shared layout constants for the category group tables (ADR-145).
 *
 * The comp's 3-column row template — Category | Monthly target | Spent vs target
 * — used by BOTH the column-header row in {@link GroupCard} and every
 * {@link BudgetRow}, so the columns line up on desktop. Kept in its own module
 * (no React, no JSX) so the two components share it without a circular import.
 */

/** Category | Monthly target | Spent vs target (matches the comp exactly). */
export const ROW_GRID_TEMPLATE = 'minmax(0, 1.1fr) 168px minmax(0, 1.6fr)'

/** Inter-column gap on the shared grid (the comp's 18px). */
export const ROW_GRID_GAP = '18px'
