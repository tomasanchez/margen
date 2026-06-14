/**
 * Test fixture: a representative transactions dataset for the pure filtering /
 * grouping unit tests.
 *
 * This is the former 19-row concept dataset (June current, May/April historical)
 * that used to live in `src/mock/seed.ts` as `SEED_TRANSACTIONS`. That seed was
 * removed when transactions moved to the real backend (ADR-035); the rows are
 * preserved here purely as deterministic input for `filtering.test.ts`. Ids are
 * UUID-style strings (ADR-034) so the fixture matches the live `Transaction`
 * shape exactly.
 */

import type { Transaction } from '../../../mock/types'

/** Build a stable, readable fixture id (mirrors a UUID string shape). */
function fid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

/** The 19-row sample dataset used by the pure filtering tests. */
export const TRANSACTIONS_FIXTURE: readonly Transaction[] = [
  { id: fid(1), dispDate: 'Jun 12', month: 'June', name: 'Invoice · Atlas Co.', category: 'Income', bank: 'Transfer', currency: 'USD', type: 'income', kind: 'invoice', amountNum: 622500, usd: 500, rate: 1245 },
  { id: fid(2), dispDate: 'Jun 11', month: 'June', name: 'Coto supermarket', category: 'Food', bank: 'Galicia · Visa', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 38400 },
  { id: fid(3), dispDate: 'Jun 10', month: 'June', name: 'Netflix · Spotify', category: 'Subscriptions', bank: 'Galicia · Visa', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 14200, recurring: true },
  { id: fid(4), dispDate: 'Jun 09', month: 'June', name: 'Apartment rent', category: 'Rent', bank: 'Transfer', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 720000, recurring: true },
  { id: fid(5), dispDate: 'Jun 08', month: 'June', name: 'Uber', category: 'Transport', bank: 'Brubank', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 6800 },
  { id: fid(6), dispDate: 'Jun 07', month: 'June', name: 'Refund · MercadoLibre', category: 'Income', bank: 'Mercado Pago', currency: 'ARS', type: 'income', kind: 'income', amountNum: 18500 },
  { id: fid(7), dispDate: 'Jun 06', month: 'June', name: 'Farmacity', category: 'Health', bank: 'Galicia · Visa', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 22300 },
  { id: fid(8), dispDate: 'Jun 05', month: 'June', name: 'Mercado Libre', category: 'Shopping', bank: 'Mercado Pago', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 48900 },
  { id: fid(9), dispDate: 'Jun 03', month: 'June', name: 'AWS', category: 'Subscriptions', bank: 'Galicia · Visa', currency: 'USD', type: 'expense', kind: 'expense', amountNum: 39616, usd: 32, rate: 1238, recurring: true },
  { id: fid(10), dispDate: 'May 28', month: 'May', name: 'Invoice · Beta Studio', category: 'Income', bank: 'Transfer', currency: 'ARS', type: 'income', kind: 'invoice', amountNum: 1480000 },
  { id: fid(11), dispDate: 'May 24', month: 'May', name: 'Carrefour', category: 'Food', bank: 'Santander · Mastercard', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 41200 },
  { id: fid(12), dispDate: 'May 20', month: 'May', name: 'Edenor (electricity)', category: 'Services', bank: 'Galicia · Visa', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 33500, recurring: true },
  { id: fid(13), dispDate: 'May 15', month: 'May', name: 'YPF fuel', category: 'Transport', bank: 'Santander · Mastercard', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 28000 },
  { id: fid(14), dispDate: 'May 12', month: 'May', name: 'Invoice · Atlas Co.', category: 'Income', bank: 'Transfer', currency: 'USD', type: 'income', kind: 'invoice', amountNum: 605000, usd: 500, rate: 1210 },
  { id: fid(15), dispDate: 'May 09', month: 'May', name: 'Apartment rent', category: 'Rent', bank: 'Transfer', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 700000, recurring: true },
  { id: fid(16), dispDate: 'May 05', month: 'May', name: 'Spotify · Netflix', category: 'Subscriptions', bank: 'Galicia · Visa', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 13900, recurring: true },
  { id: fid(17), dispDate: 'Apr 27', month: 'April', name: 'Invoice · Gamma SA', category: 'Income', bank: 'Transfer', currency: 'ARS', type: 'income', kind: 'invoice', amountNum: 980000 },
  { id: fid(18), dispDate: 'Apr 18', month: 'April', name: 'Coto', category: 'Food', bank: 'Galicia · Visa', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 37800 },
  { id: fid(19), dispDate: 'Apr 10', month: 'April', name: 'Apartment rent', category: 'Rent', bank: 'Transfer', currency: 'ARS', type: 'expense', kind: 'expense', amountNum: 700000, recurring: true },
] as const
