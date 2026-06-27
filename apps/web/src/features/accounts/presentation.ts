/**
 * Small presentation helpers for accounts (ADR-103/ADR-122).
 *
 * Account-type labels localize off the active UI language; the underlying enum
 * (`bank` / `cash` / `card`) stays canonical. Mirrors the transactions
 * presentation helpers — non-hook utils over the i18next singleton so they are
 * callable from plain modules and inside render alike.
 */

import i18n from 'i18next'

import type { AccountType } from '../../mock/types'

/** The institution types in display order (the Add-institution form's options). */
export const ACCOUNT_TYPES: readonly AccountType[] = [
  'bank',
  'card',
  'cash',
  'wallet',
] as const

/**
 * Localized label for an account type (ADR-103). Looks up
 * `accounts:type.<value>` and falls back to the raw enum value when unmapped.
 */
export function accountTypeLabel(type: AccountType): string {
  return i18n.t(`accounts:type.${type}`, { defaultValue: type })
}
