// Constant-time API-token comparison for the public server.

import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Compare a client-supplied API token against the expected token without
 * leaking token bytes through response timing.
 *
 * A plain `provided !== expected` string compare short-circuits at the first
 * differing byte, so an attacker measuring response latency can recover the
 * token one byte at a time. Hashing both sides to a fixed 32-byte SHA-256
 * digest before `timingSafeEqual` keeps the comparison constant time
 * regardless of input length, and avoids `timingSafeEqual` throwing on
 * length-mismatched buffers.
 *
 * Non-string input (missing header, duplicated header parsed as an array) and
 * an empty expected token never match.
 */
export function timingSafeTokenEqual(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) {
    return false
  }
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}
