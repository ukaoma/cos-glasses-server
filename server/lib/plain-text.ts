// 7.0.53: one cleaner for session-written text shown outside the session (moved from web-push-sender.ts lockScreenTitle, 7.0.52 C).
// plainText: the lock-screen title and the Reply ready link label (one line). excerptText: the reply excerpt on the feed item, which
// keeps paragraph breaks (W1, 21:1x); the page renders it as escaped text with pre-line.

/** Characters that can reorder or hide text, removed everywhere (X1 16:4x): soft hyphen, U+061C, U+180E, zero-width and bidi
 * controls (U+200B to U+200F, U+202A to U+202E, U+2066 to U+2069), U+2060 to U+2064, the BOM, U+FFF9 to U+FFFB and the tag block. */
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu

/** At most `maxPoints` code points, the last one an ellipsis when cut, so no surrogate pair is split. `trimCut` (the excerpt only)
 * trims the kept part's end first, so a cut never leaves a space or a line break before the ellipsis; plainText keeps 7.0.52's cut. */
function cutPoints(clean: string, maxPoints: number, trimCut = false): string {
  const points = Array.from(clean)
  if (points.length <= maxPoints) return clean
  const kept = points.slice(0, maxPoints - 1).join('')
  return (trimCut ? kept.trimEnd() : kept) + '\u2026'
}

/**
 * Session-written text (a first prompt, a title a session set) as one line of plain text: C0 and C1 controls, line and paragraph
 * separators become spaces; the INVISIBLE set is removed; ** and backticks are dropped; whitespace collapses; then cutPoints.
 * Empty means none.
 */
export function plainText(raw: unknown, maxPoints: number): string {
  if (typeof raw !== 'string') return ''
  const clean = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(INVISIBLE, '')
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ').trim()
  return cutPoints(clean, maxPoints)
}

/**
 * A session's reply as plain text that keeps its paragraphs (W1 21:1x): CR LF, a lone CR, U+2028 and U+2029 become a newline; every
 * other C0 and C1 control (tab included) becomes a space; the INVISIBLE set is removed; ** and backticks are dropped; whitespace
 * collapses inside each line and each line is trimmed; three or more newlines become one blank line; the whole is trimmed; then
 * cutPoints. Empty means none.
 */
export function excerptText(raw: unknown, maxPoints: number): string {
  if (typeof raw !== 'string') return ''
  const clean = raw
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')
    .replace(INVISIBLE, '')
    .replace(/\*\*|`/g, '')
    .split('\n').map(line => line.replace(/\s+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cutPoints(clean, maxPoints, true)
}
