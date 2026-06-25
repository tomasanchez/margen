/**
 * i18n catalog parity tests (ADR-101, ADR-103, ADR-105).
 *
 * Data-driven guards over the statically-imported catalogs (`resources`) that
 * catch the silent failure modes i18n is prone to:
 *
 *  1. CATEGORY / BANK COVERAGE — every `Category` / `Bank` union value (via the
 *     authoritative runtime arrays in `mock/seed.ts`) must have a LITERAL key
 *     under `common:categories.*` / `common:banks.*` in BOTH locales. Without
 *     this, `categoryLabel` / `bankLabel` (presentation.ts) silently fall back
 *     to the raw enum value, so a missing translation looks like English.
 *
 *  2. KEY PARITY — for every namespace, the `en` and `es` catalogs must have the
 *     EXACT same set of (flattened) keys. Catches a key added to one locale but
 *     not the other (missing or orphaned translations).
 *
 *  3. PLACEHOLDER PARITY — for every shared key, the `{{...}}` interpolation
 *     placeholders must match between `en` and `es`. Catches placeholder drift
 *     (e.g. a Spanish string that forgot `{{amount}}` or renamed `{{category}}`),
 *     which would render a literal `{{token}}` or drop a value at runtime.
 *
 * These run against the same `resources` the app and the en-pinned suite use, so
 * the catalogs can never drift unnoticed.
 */

import { describe, expect, test } from 'vitest'
import { NAMESPACES, resources } from './resources'
import { BANKS, CATEGORIES } from '../mock/seed'

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/**
 * Flatten a nested catalog object to dotted leaf keys → string values, e.g.
 * `{ a: { b: "x" } }` → `{ "a.b": "x" }`. Only string leaves are kept (the
 * translatable values); arrays/objects are descended, primitives ignored.
 */
function flatten(
  obj: Record<string, JsonValue>,
  prefix = '',
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') {
      out[path] = value
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flatten(value as Record<string, JsonValue>, path))
    }
  }
  return out
}

/** Distinct `{{token}}` placeholders in a translation string, sorted. */
function placeholders(value: string): string[] {
  const tokens = new Set<string>()
  for (const match of value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    tokens.add(match[1])
  }
  return [...tokens].sort()
}

describe('Category / Bank label coverage (ADR-103)', () => {
  const common = resources.en.common as Record<string, JsonValue>
  const esCommon = resources.es.common as Record<string, JsonValue>

  test.each(CATEGORIES)('category "%s" has a literal key in en + es', (category) => {
    const en = (common.categories as Record<string, JsonValue>)[category]
    const es = (esCommon.categories as Record<string, JsonValue>)[category]
    expect(typeof en).toBe('string')
    expect((en as string).length).toBeGreaterThan(0)
    expect(typeof es).toBe('string')
    expect((es as string).length).toBeGreaterThan(0)
  })

  test.each(BANKS)('bank "%s" has a literal key in en + es', (bank) => {
    const en = (common.banks as Record<string, JsonValue>)[bank]
    const es = (esCommon.banks as Record<string, JsonValue>)[bank]
    expect(typeof en).toBe('string')
    expect((en as string).length).toBeGreaterThan(0)
    expect(typeof es).toBe('string')
    expect((es as string).length).toBeGreaterThan(0)
  })
})

describe('en / es catalog parity', () => {
  test.each(NAMESPACES)('namespace "%s" has identical key sets', (ns) => {
    const en = flatten(resources.en[ns] as Record<string, JsonValue>)
    const es = flatten(resources.es[ns] as Record<string, JsonValue>)
    const enKeys = Object.keys(en).sort()
    const esKeys = Object.keys(es).sort()
    expect(esKeys).toEqual(enKeys)
  })

  test.each(NAMESPACES)(
    'namespace "%s" has matching {{placeholders}} per key',
    (ns) => {
      const en = flatten(resources.en[ns] as Record<string, JsonValue>)
      const es = flatten(resources.es[ns] as Record<string, JsonValue>)
      for (const key of Object.keys(en)) {
        if (!(key in es)) continue // key-set parity is asserted separately.
        expect(
          placeholders(es[key]),
          `placeholder drift in ${ns}:${key}`,
        ).toEqual(placeholders(en[key]))
      }
    },
  )
})
