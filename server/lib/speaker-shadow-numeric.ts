// Python-compatible numerics for the speaker shadow port (6.95.0).
//
// The shadow gates are a byte-for-byte port of the research tool
// (community-1-fluidaudio-v1/scripts/hybrid.py and round3/propose.py), which ran on
// CPython 3.15. Four Python behaviours differ from the obvious JavaScript and each one
// changes a gate or a reason string on real meetings, so each is replicated here:
//
//   1. `round(x)` and `round(x, n)` round half to EVEN on the exact binary value.
//      Math.round and toFixed round half up, and `coveredFraction`, `majority` and
//      `seconds` are compared AFTER rounding (0.7996 rounds to 0.8 and passes 0.8).
//   2. `'%.2f' % x` is correctly rounded half to even as well: 0.125 formats as 0.12,
//      where (0.125).toFixed(2) is 0.13.
//   3. `sum()` of floats is Neumaier-compensated since CPython 3.12, so a plain loop
//      drifts in the last bits of every cosine distance and norm.
//   4. String order is by code point, not UTF-16 unit.
//
// No I/O and no clock. Verified against CPython 3.15 vectors in speaker-shadow-numeric.test.ts.

const view = new DataView(new ArrayBuffer(8))

/** x = (neg ? -1 : 1) * mant * 2^exp, exactly. Finite x only. */
function decompose(x: number): { neg: boolean; mant: bigint; exp: number } {
  view.setFloat64(0, x)
  const hi = view.getUint32(0), lo = view.getUint32(4)
  const neg = hi >>> 31 === 1
  const biased = (hi >>> 20) & 0x7ff
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo)
  let exp: number
  if (biased === 0) exp = -1074
  else { mant |= 1n << 52n; exp = biased - 1075 }
  return { neg, mant, exp }
}

/** |x| * 10^digits rounded half to even, as an exact integer. */
function scaledHalfEven(x: number, digits: number): { neg: boolean; q: bigint } {
  const { neg, mant, exp } = decompose(x)
  let num = mant * 10n ** BigInt(digits)
  let den = 1n
  if (exp >= 0) num <<= BigInt(exp)
  else den <<= BigInt(-exp)
  let q = num / den
  const twice = (num % den) * 2n
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n
  return { neg, q }
}

function decimalString(neg: boolean, q: bigint, digits: number): string {
  let text = q.toString()
  if (digits > 0) {
    text = text.padStart(digits + 1, '0')
    text = `${text.slice(0, -digits)}.${text.slice(-digits)}`
  }
  return neg ? `-${text}` : text
}

/** Python `'%.{digits}f' % x`. */
export function pyFixed(x: number, digits: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf'
  const { neg, q } = scaledHalfEven(x, digits)
  return decimalString(neg, q, digits)
}

/** Python `round(x, digits)` for digits >= 1 (a float). */
export function pyRound(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x
  const { neg, q } = scaledHalfEven(x, digits)
  return Number.parseFloat(decimalString(neg, q, digits))
}

/** Python `round(x)` with no digits (an int, half to even). */
export function pyRoundInt(x: number): number {
  const floor = Math.floor(x)
  const fraction = x - floor
  if (fraction > 0.5) return floor + 1
  if (fraction < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/**
 * CPython (>= 3.12) `sum()` of floats from the int start 0: the first item is added to
 * 0 exactly, then Neumaier's improved Kahan-Babuska compensation, and the compensation is
 * added once at the end only when it is finite and non-zero (Python/bltinmodule.c).
 * Integral JSON values (only exact zeros occur in FluidAudio output) contribute nothing
 * under either of CPython's int and float paths, so treating them as floats is exact.
 */
export function pySum(values: ArrayLike<number>): number {
  const n = values.length
  if (n === 0) return 0
  let total = 0 + values[0]
  let compensation = 0
  for (let i = 1; i < n; i++) {
    const x = values[i]
    const t = total + x
    if (Math.abs(total) >= Math.abs(x)) compensation += (total - t) + x
    else compensation += (x - t) + total
    total = t
  }
  if (compensation !== 0 && Number.isFinite(compensation)) total += compensation
  return total
}

/** Python str ordering (by code point). */
export function codePointCompare(a: string, b: string): number {
  if (a === b) return 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n;) {
    const ca = a.codePointAt(i)!, cb = b.codePointAt(i)!
    if (ca !== cb) return ca < cb ? -1 : 1
    i += ca > 0xffff ? 2 : 1
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}

/** Python `str.isspace()` characters, which is what `\s` matches in a str pattern. */
export const PY_SPACE_CLASS = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
/** Python `re.compile(r'Voice\s*\d+').fullmatch` (Unicode `\s` and `\d`). */
export const PY_VOICE_LABEL = new RegExp(`^Voice${PY_SPACE_CLASS}*\\p{Nd}+$`, 'u')

const ND = /^\p{Nd}$/u
/** Python `int(re.findall(r'\d+', label)[0])`, or null when the label has no digit. */
export function pyFirstInt(label: string): number | null {
  const run = /\p{Nd}+/u.exec(label)
  if (!run) return null
  let value = 0
  for (const ch of run[0]) {
    const cp = ch.codePointAt(0)!
    // Unicode keeps every decimal digit set as ten contiguous code points from its zero,
    // and adjacent sets (mathematical digits) are whole multiples of ten.
    let zero = cp
    while (zero > 0 && ND.test(String.fromCodePoint(zero - 1))) zero--
    value = value * 10 + ((cp - zero) % 10)
  }
  return value
}

/** Python `'%d:%02d:%02d' % (h, m, s) if h else '%d:%02d' % (m, s)` after `int(round(sec))`. */
export function pyClock(seconds: number): string {
  const sec = pyRoundInt(seconds)
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}
