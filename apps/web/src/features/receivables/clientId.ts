/**
 * Client-generated ids for idempotent receivable creates (ADR-204).
 *
 * The item form generates ONE id when it opens and sends it on every save
 * attempt, so a create whose response was lost can be retried without ever
 * creating the item twice (the API replays the same id + terms).
 */

/** Format 16 random bytes as an RFC 4122 version-4 UUID string. */
function uuidFromBytes(bytes: Uint8Array): string {
  const copy = Uint8Array.from(bytes)
  copy[6] = (copy[6] & 0x0f) | 0x40 // version 4
  copy[8] = (copy[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = Array.from(copy, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * A fresh v4 UUID. Uses `crypto.randomUUID()` when available; it requires a
 * secure context (HTTPS or localhost), so it falls back to `getRandomValues`.
 */
export function newClientId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  return uuidFromBytes(cryptoApi.getRandomValues(new Uint8Array(16)))
}
