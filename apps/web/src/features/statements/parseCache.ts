/**
 * Client-side parse-result cache for the statement import flow (ADR-070/078).
 *
 * The parse endpoint is stateless by design (ADR-070/078) and re-running it is
 * slow (PDF text extraction). If the user mis-clicks and re-picks the SAME file,
 * we should not pay that cost again — so this module memoizes parse results by a
 * stable file identity for the duration of the session.
 *
 * Scope + lifetime: a module-level {@link Map}, scoped to the import flow/session.
 * It deliberately does NOT persist across reloads — the cached value holds the
 * parse RESULT in memory only (which includes the base64 PDF echo, sensitive PII
 * per ADR-073/081), so it must never reach storage. A reload clears it.
 *
 * Key: `${file.name}:${file.size}:${file.lastModified}`. Re-picking the very same
 * file via the OS picker yields identical values for all three, so this is a
 * pragmatic, synchronous content-stable key (no hashing needed — ADR-016).
 */

import { parseStatement, type StatementParse } from '../../api/statementsClient'

/** The in-flight or settled parse keyed by file identity (session-scoped). */
const cache = new Map<string, Promise<StatementParse>>()

/** Build the stable cache key from the picked file (name + size + lastModified). */
export function parseCacheKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}

/**
 * Parse a picked statement, returning the cached result when the SAME file is
 * re-uploaded (skips the slow `POST /statements/parse` round-trip — ADR-078).
 *
 * The Promise itself is cached so two rapid re-picks of the same file share a
 * single in-flight parse rather than racing two requests. A rejected parse is
 * evicted so a later retry of the same file can try again (a transient 5xx/network
 * failure should not be sticky).
 */
export function parseStatementCached(file: File): Promise<StatementParse> {
  const key = parseCacheKey(file)
  const cached = cache.get(key)
  if (cached) return cached

  const pending = parseStatement(file).catch((error: unknown) => {
    cache.delete(key)
    throw error
  })
  cache.set(key, pending)
  return pending
}

/** Drop every cached parse (e.g. on Cancel / leaving the flow). */
export function clearParseCache(): void {
  cache.clear()
}
