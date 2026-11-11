/**
 * Session organizer routes (Sessions chat-style layout, step 2a; S1_CONTRACT_step2a.md, A1).
 *
 *   GET    /api/session-folders
 *   POST   /api/session-folders                              { name }
 *   PATCH  /api/session-folders/:id                          { name }
 *   DELETE /api/session-folders/:id                          (its sessions leave it; no session is deleted)
 *   PATCH  /api/agent-sessions/:provider/:sessionId/organizer { folder_id?, cos_pinned?, title? }
 *
 * Behind index.ts's /api gate (API token, or a browser cookie with `x-cos-web: 1` and a same-origin Origin).
 * The session route canonicalizes the id from the transcript it finds, so a Claude Desktop id and its CLI id are
 * one key, and a session the server cannot find is refused (404) instead of stored.
 * Logs carry reason codes only: never a folder name or a title.
 */
import { Router, type Request, type Response } from 'express'
import {
  agentSessionRoots,
  findAgentSessionFile,
  idFromCodexFilename,
  isSafeSessionId,
  loadClaudeDesktopAliases,
  normalizeClaudeSessionId,
  type AgentProvider,
  type AgentSessionRoots,
} from '../lib/agent-session-store.js'
import { OrganizerError, organizerKey, sessionOrganizer, type SessionOrganizer } from '../lib/session-organizer.js'

const PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex', 'cursor'])

export interface SessionOrganizerRouteDeps {
  organizer: () => SessionOrganizer
  roots: () => AgentSessionRoots
  /** The canonical id of a session the server can find on disk, or null. */
  canonicalId: (provider: AgentProvider, sessionId: string, roots: AgentSessionRoots) => Promise<SessionIdentity | null>
}

/** Where a session's organizer entry lives: its canonical id, and for Claude the Desktop id it was named by when one is
 *  known. `null`: the server cannot find the session. Throws 409 alias_conflict while Claude Desktop's records disagree
 *  about the session's CLI id (Q1 FIX 2): an entry written then could be orphaned when they settle. */
export interface SessionIdentity { id: string; desktopId?: string }

/** The id a found transcript names: Claude's CLI uuid (a Desktop id resolves to it), Codex's rollout id, Cursor's composer. */
export async function canonicalSessionId(provider: AgentProvider, sessionId: string, roots: AgentSessionRoots): Promise<SessionIdentity | null> {
  if (!isSafeSessionId(sessionId)) return null
  if (provider === 'claude') {
    // A Desktop id may arrive as `local_<uuid>`; the alias table and transcripts use the bare uuid.
    sessionId = normalizeClaudeSessionId(sessionId)
    const aliases = await loadClaudeDesktopAliases(roots.claudeCodeSessions)
    if (aliases.has(sessionId) && aliases.get(sessionId) === null) throw new OrganizerError(409, 'alias_conflict')
    const head = aliases.get(sessionId)
    const file = await findAgentSessionFile('claude', sessionId, roots, new Date(), aliases)
    if (file) {
      const id = (file.split('/').pop() || '').replace(/\.jsonl$/, '').toLowerCase()
      if (!id) return null
      // The Desktop id: the one asked for when it is an alias, else the single Desktop record that names this CLI id.
      let desktopId: string | undefined = head ? sessionId : undefined
      if (!desktopId) {
        const named = [...aliases].filter(([, h]) => h?.cliSessionId === id).map(([d]) => d)
        if (named.length === 1) desktopId = named[0]
      }
      return { id, ...(desktopId && desktopId !== id ? { desktopId } : {}) }
    }
    // A Desktop-only session (no CLI transcript yet): keyed by its Desktop id, which the list also shows.
    if (head) return { id: sessionId, desktopId: sessionId }
    return null
  }
  const file = await findAgentSessionFile(provider, sessionId, roots)
  if (!file) return null
  const parts = file.split('/')
  const id = provider === 'codex'
    ? idFromCodexFilename(parts[parts.length - 1] || '')
    : (parts[parts.length - 2] || '').toLowerCase() || null
  return id ? { id } : null
}

function fail(res: Response, error: unknown): void {
  if (error instanceof OrganizerError) {
    res.status(error.status).json({ error: error.reason, reason: error.reason })
    return
  }
  console.error(`[session-organizer] write failed (reason=${(error as NodeJS.ErrnoException)?.code ?? 'error'})`)
  res.status(500).json({ error: 'organizer_write_failed', reason: 'organizer_write_failed' })
}

export function createSessionOrganizerRouter(deps: SessionOrganizerRouteDeps = {
  organizer: sessionOrganizer,
  roots: () => agentSessionRoots(),
  canonicalId: canonicalSessionId,
}): Router {
  const router = Router()
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store')

  router.get('/session-folders', (_req: Request, res: Response) => {
    noStore(res)
    const o = deps.organizer()
    if (!o.isAvailable()) return void res.status(503).json({ error: 'organizer_unavailable', reason: 'organizer_unavailable' })
    res.json({ rev: o.rev(), folders: o.listFolders() })
  })

  router.post('/session-folders', (req: Request, res: Response) => {
    noStore(res)
    try {
      const o = deps.organizer()
      const folder = o.createFolder((req.body as { name?: unknown } | undefined)?.name)
      res.status(201).json({ rev: o.rev(), folder })
    } catch (error) { fail(res, error) }
  })

  router.patch('/session-folders/:id', (req: Request, res: Response) => {
    noStore(res)
    try {
      const o = deps.organizer()
      const folder = o.renameFolder(String(req.params.id), (req.body as { name?: unknown } | undefined)?.name)
      res.json({ rev: o.rev(), folder })
    } catch (error) { fail(res, error) }
  })

  router.delete('/session-folders/:id', (req: Request, res: Response) => {
    noStore(res)
    try {
      const o = deps.organizer()
      const released = o.deleteFolder(String(req.params.id))
      res.json({ rev: o.rev(), released })
    } catch (error) { fail(res, error) }
  })

  router.patch('/agent-sessions/:provider/:sessionId/organizer', async (req: Request, res: Response) => {
    noStore(res)
    const provider = String(req.params.provider)
    if (!PROVIDERS.has(provider)) return void res.status(400).json({ error: 'invalid_provider', reason: 'invalid_provider' })
    // A Claude Desktop id arrives as `local_<uuid>`; the bare uuid is the id everywhere else.
    const sessionId = provider === 'claude' ? normalizeClaudeSessionId(String(req.params.sessionId)) : String(req.params.sessionId)
    if (!isSafeSessionId(sessionId)) return void res.status(400).json({ error: 'invalid_session_id', reason: 'invalid_session_id' })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {}
    const change: { folder_id?: unknown; cos_pinned?: unknown; title?: unknown } = {}
    for (const key of ['folder_id', 'cos_pinned', 'title'] as const) if (Object.prototype.hasOwnProperty.call(body, key)) change[key] = body[key]
    try {
      const o = deps.organizer()
      if (!o.isAvailable()) throw new OrganizerError(503, 'organizer_unavailable')
      if (Object.keys(change).length === 0) throw new OrganizerError(400, 'empty_change')
      const identity = await deps.canonicalId(provider as AgentProvider, sessionId, deps.roots())
      if (!identity) throw new OrganizerError(404, 'session_not_found')
      const fields = o.updateSession(organizerKey(provider, identity.id), change, { desktopId: identity.desktopId })
      res.json({ rev: o.rev(), session: { provider, session_id: identity.id, ...fields } })
    } catch (error) { fail(res, error) }
  })

  return router
}
