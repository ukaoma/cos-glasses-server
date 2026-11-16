// X1 (the one queue, 7.0.32 candidate): the last title COS showed for each session, so the questions route can name
// the asking session without reading a transcript on a 3 s poll. Filled by the session list route from the rows it
// already built; read by `lib/question-queue.ts`. Memory only, bounded; a session not listed yet reads null and a
// client falls back to its own list. The titles are the list's own (the same authenticated clients already get them).

/** At most this many sessions are remembered; past it the oldest noted go first. */
export const SESSION_TITLE_CACHE_MAX = 400
const TITLE_MAX = 120

const titles = new Map<string, string>()

/** Remember a session's title (lower-cased id). Blank titles are ignored. */
export function noteSessionTitle(sessionId: unknown, title: unknown): void {
  if (typeof sessionId !== 'string' || !sessionId || typeof title !== 'string') return
  const text = title.replace(/\s+/g, ' ').trim()
  if (!text) return
  const key = sessionId.toLowerCase()
  titles.delete(key)
  titles.set(key, text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1) + '…' : text)
  while (titles.size > SESSION_TITLE_CACHE_MAX) {
    const oldest = titles.keys().next().value
    if (oldest === undefined) break
    titles.delete(oldest)
  }
}

/** The last title COS listed for this session, or null. Takes a full id or the registry's eight-character form. */
export function sessionTitleFor(sessionId: string): string | null {
  const key = sessionId.toLowerCase()
  const exact = titles.get(key)
  if (exact !== undefined) return exact
  if (key.length >= 8 && key.length < 36) {
    for (const [id, title] of titles) if (id.startsWith(key)) return title
  }
  return null
}

/** 7.0.52 C (X1): the title for exactly this session id, or null. Never a prefix match, so it cannot name another session. */
export function sessionTitleExact(sessionId: string): string | null {
  return titles.get(sessionId.toLowerCase()) ?? null
}

export function __resetSessionTitlesForTests(): void {
  titles.clear()
}
