/**
 * Shared opening-balance parsing + serialization for the accounts feature
 * (ADR-025/034).
 *
 * Opening balance is a Decimal STRING end-to-end: the user types it free-form
 * (es-AR-ish: comma OR dot decimal, optional thousands grouping), it is parsed
 * to a finite number only for validation, then serialized back to the fixed
 * 2-decimal Decimal string the API expects. Extracted so both {@link AccountForm}
 * (the per-institution add/edit dialog) and the onboarding {@link InstitutionWizard}
 * use one implementation rather than two divergent copies.
 */

/** Parse a free-text balance to a finite number (es-AR-ish: comma OR dot). */
export function parseBalance(raw: string): number {
  const cleaned = raw.replace(/\s/g, '').replace(/[^\d.,-]/g, '')
  if (cleaned === '') return Number.NaN
  const lastComma = cleaned.lastIndexOf(',')
  const lastDot = cleaned.lastIndexOf('.')
  let normalized: string
  if (lastComma > -1 && lastDot > -1) {
    const decimalSep = lastComma > lastDot ? ',' : '.'
    const groupSep = decimalSep === ',' ? '.' : ','
    normalized = cleaned.split(groupSep).join('').replace(decimalSep, '.')
  } else if (lastComma > -1) {
    normalized = cleaned.replace(',', '.')
  } else {
    normalized = cleaned
  }
  const value = Number(normalized)
  return Number.isFinite(value) ? value : Number.NaN
}

/** Round to 2 decimals and serialize as the Decimal string the API expects. */
export function toDecimalString(value: number): string {
  return value.toFixed(2)
}
