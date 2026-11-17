// 7.0.53: one cleaner for session-written text shown outside the session (moved from web-push-sender.ts lockScreenTitle, 7.0.52 C).
// Used for the lock-screen title, the Reply ready link label and the reply excerpt on the feed item.

/**
 * Session-written text (a first prompt, a title a session set, a reply) as plain text: C0 and C1 controls, line and paragraph
 * separators become spaces; bidi controls (with U+061C), zero-width and other invisible characters (soft hyphen, U+180E, U+2060 to
 * U+2064, U+FFF9 to U+FFFB, the tag block U+E0000 to U+E007F) are removed (they can reorder or hide text; X1 16:4x); ** and
 * backticks are dropped; whitespace collapses; then at most `maxPoints` code points, the last one an ellipsis when cut, so no
 * surrogate pair is split. Empty means none.
 */
export function plainText(raw: unknown, maxPoints: number): string {
  if (typeof raw !== 'string') return ''
  const clean = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu, '')
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ').trim()
  const points = Array.from(clean)
  return points.length > maxPoints ? points.slice(0, maxPoints - 1).join('') + '\u2026' : clean
}
