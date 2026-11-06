/**
 * Test fixture builders for the receivables DTOs (ADR-204/214/217).
 *
 * The API shapes grew the installment + link fields (`upcomingTotal`,
 * `dueOutstanding`, `installments`, `sourceTransaction`,
 * `linkedTotalExceedsExpense`); these builders fill every field with a calm
 * default so each test only spells out what it asserts on. Money stays a Decimal
 * STRING (ADR-025/034), exactly as the API serializes it.
 */

import type {
  ExpenseCandidate,
  Person,
  PersonDetail,
  ReceivableInstallment,
  ReceivableItem,
} from '../../../api/receivablesClient'

const CREATED_AT = '2026-08-01T12:00:00Z'

/** A people-list row; `outstanding` defaults to 0 and nothing upcoming. */
export function makePerson(
  fields: Pick<Person, 'id' | 'name'> & Partial<Person>,
): Person {
  return {
    createdAt: CREATED_AT,
    outstanding: '0.00',
    upcomingTotal: '0.00',
    ...fields,
  }
}

/**
 * An itemized debt. A FLAT item by default: `remaining` = `amount` −
 * `allocated`, and `dueOutstanding` = its remainder (0 once pardoned).
 */
export function makeItem(
  fields: Pick<ReceivableItem, 'id' | 'occurredOn' | 'amount'> &
    Partial<ReceivableItem>,
): ReceivableItem {
  const allocated = fields.allocated ?? '0.00'
  const remaining =
    fields.remaining ??
    (Number.parseFloat(fields.amount) - Number.parseFloat(allocated)).toFixed(2)
  const pardoned = fields.pardoned ?? false
  return {
    detail: null,
    allocated,
    remaining,
    pardoned,
    dueOutstanding: pardoned ? '0.00' : remaining,
    upcomingTotal: '0.00',
    installments: [],
    sourceTransaction: null,
    linkedTotalExceedsExpense: false,
    ...fields,
  }
}

/** One cuota; unpaid by default (`remaining` = `amount`). */
export function makeCuota(
  fields: Pick<ReceivableInstallment, 'id' | 'index' | 'dueOn' | 'amount' | 'status'> &
    Partial<ReceivableInstallment>,
): ReceivableInstallment {
  const paid = fields.paid ?? '0.00'
  return {
    paid,
    remaining: (
      Number.parseFloat(fields.amount) - Number.parseFloat(paid)
    ).toFixed(2),
    pardoned: fields.status === 'pardoned',
    ...fields,
  }
}

/** A person's detail; totals default to 0 (pass the ones a test asserts). */
export function makeDetail(
  fields: Pick<PersonDetail, 'id' | 'name' | 'items'> & Partial<PersonDetail>,
): PersonDetail {
  return {
    createdAt: CREATED_AT,
    outstanding: '0.00',
    upcomingTotal: '0.00',
    ...fields,
  }
}

/**
 * An expense candidate / linked expense (ARS, one-off, unlinked by default).
 * `planTotal` defaults the way the server derives it: `amount` × the card plan's
 * `installmentsTotal`, else `amount` (ADR-218).
 */
export function makeCandidate(
  fields: Pick<ExpenseCandidate, 'id' | 'name' | 'occurredOn' | 'amount'> &
    Partial<ExpenseCandidate>,
): ExpenseCandidate {
  const cuotas = fields.installmentsTotal ?? 1
  return {
    currency: 'ARS',
    usdAmount: null,
    installmentsIndex: null,
    installmentsTotal: null,
    planTotal: (Number.parseFloat(fields.amount) * cuotas).toFixed(2),
    linkedItemsTotal: '0.00',
    ...fields,
  }
}

/** A create response: the person's detail plus the created item's id. */
export function makeCreated(
  detail: PersonDetail,
  createdItemId: string,
): PersonDetail & { createdItemId: string } {
  return { ...detail, createdItemId }
}
