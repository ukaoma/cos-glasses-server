/**
 * The preview contract's routes (preview engine phase 1, PLAN 4c), mounted inside agentSessionsRouter, so behind the
 * shared /api gate. Neither a request nor a response carries a filesystem path: a card or file is named by an opaque
 * id that the resolver re-authorizes on every call (agent-session-output-images.ts `previewFile`).
 *
 *   GET /api/preview/agent-sessions/:provider/:sessionId/:id/meta
 *   GET /api/preview/agent-sessions/:provider/:sessionId/:id/content?part=raw|inline|text|table|html|html-run|thumb
 *   GET|POST /api/preview-folders/settings   the Settings extra folders (lib/preview-folders-setting.ts)
 *
 * "Show session files, screenshots and images" (7.0.4 name) off answers 403 previews_off before any transcript or file is read.
 * A denied secret name answers 403 secret_file_denied (as the 7.0.4 output routes do). A folder card has no content (phase 2 lists folders).
 * Every refusal or failure but a missing id logs one line (`logPreviewRefusal`): reason code, provider, part, kind.
 */
import { Router, type Request, type Response } from 'express'
import { agentSessionOutputImages } from '../lib/agent-session-output-images.js'
import { sessionFilesSetting } from '../lib/session-files-setting.js'
import { previewFoldersSetting, folderDisplay, type PreviewFoldersStore } from '../lib/preview-folders-setting.js'
import { previewThumbnailer } from '../lib/preview-thumbs.js'
import {
  HTML_PREVIEW_MAX, looksBinary, PREVIEW_PARTS, previewHeaders, tablePage, TEXT_WINDOW_MAX, textWindow, withCspMeta, type PreviewPart,
} from '../lib/preview-content.js'
import type { PreviewKind } from '../lib/session-links.js'
import { previewErrorCode } from '../lib/preview-error-code.js'
/** The 7.0.4 code (routes/agent-sessions.ts PREVIEWS_BUSY), repeated here so this router needs nothing from that one. */
const PREVIEWS_BUSY = 'previews_busy'

type Previews = Pick<typeof agentSessionOutputImages, 'previewFile' | 'previewImage'>
type Thumbs = Pick<typeof previewThumbnailer, 'thumbnail'>
export interface SessionPreviewDeps {
  previews?: Previews
  enabled?: () => boolean
  thumbs?: Thumbs
  folders?: PreviewFoldersStore
  home?: () => string
}

const PROVIDERS = new Set(['claude', 'codex', 'cursor'])
const TEXT_KINDS = new Set<PreviewKind>(['markdown', 'text', 'code', 'html', 'table'])
const THUMB_KINDS = new Set<PreviewKind>(['pdf', 'document', 'slides', 'sheet', 'html'])
const NORMALIZED = /\.(png|jpe?g|webp|hei[cf]|avif)$/i

/** Which parts a kind has. The web reads this from `meta` and never asks for another. */
export function partsFor(kind: PreviewKind, name: string): PreviewPart[] {
  const parts: PreviewPart[] = []
  if (kind === 'folder') return parts
  parts.push('raw')
  if (kind === 'pdf') parts.push('inline')
  if (kind === 'image' && NORMALIZED.test(name)) parts.push('inline')
  if (TEXT_KINDS.has(kind)) parts.push('text')
  if (kind === 'table') parts.push('table')
  if (kind === 'html') parts.push('html', 'html-run')
  if (THUMB_KINDS.has(kind)) parts.push('thumb')
  if (kind === 'image' && NORMALIZED.test(name)) parts.push('thumb')
  return parts
}

/** What a refusal or failure is logged with. Only fixed words: never a path, a file name, an id, a token or content. */
interface LogAt { route: 'meta' | 'content'; provider: string; part?: string; kind?: PreviewKind; detail?: string }
const SAFE_WORD = /^[a-z0-9_-]{1,40}$/i
/**
 * QA 7.0.5 (the 7.0.4 promise, for the preview engine's routes): one line per refusal or failure, with a stable reason
 * code and the provider, part and file kind. A missing id (404 preview_not_found) is ordinary and is not logged, as in
 * the 7.0.4 output routes.
 */
export function logPreviewRefusal(at: LogAt, error: string): void {
  if (error === 'preview_not_found') return
  const words = [`reason=${error}`, `provider=${PROVIDERS.has(at.provider) ? at.provider : 'unknown'}`]
  if (at.part && SAFE_WORD.test(at.part)) words.push(`part=${at.part}`)
  if (at.kind && SAFE_WORD.test(at.kind)) words.push(`kind=${at.kind}`)
  if (at.detail && SAFE_WORD.test(at.detail)) words.push(`detail=${at.detail}`)
  console.warn(`[preview] ${at.route} refused ${words.join(' ')}`)
}

function refuse(res: Response, status: string, at: LogAt) {
  const map: Record<string, [number, string]> = {
    not_found: [404, 'preview_not_found'], unavailable: [503, 'preview_unavailable'], too_large: [413, 'preview_too_large'],
    secret: [403, 'secret_file_denied'], folder: [404, 'preview_folder'], busy: [503, PREVIEWS_BUSY],
  }
  const [code, error] = map[status] ?? [503, 'preview_unavailable']
  logPreviewRefusal(at, error)
  if (status === 'busy') res.set('Retry-After', '2')
  res.status(code).json({ error })
}
/** A refusal the route answers itself (not through `refuse`), logged the same way. */
function answer(res: Response, code: number, error: string, at: LogAt) {
  logPreviewRefusal(at, error)
  res.status(code).json({ error })
}

export function createSessionPreviewRouter(deps: SessionPreviewDeps = {}): Router {
  const router = Router()
  const previews = deps.previews ?? agentSessionOutputImages
  const enabled = deps.enabled ?? (() => sessionFilesSetting.read().enabled)
  const thumbs = deps.thumbs ?? previewThumbnailer
  const folders = deps.folders ?? previewFoldersSetting

  const gate = (req: Request, res: Response, route: LogAt['route']): { provider: 'claude' | 'codex' | 'cursor'; sessionId: string; id: string } | null => {
    res.set('Cache-Control', 'private, no-store')
    res.set('X-Content-Type-Options', 'nosniff')
    const provider = String(req.params.provider ?? '').toLowerCase()
    // The switch decides before anything is read (no transcript, no file, no stat).
    if (!enabled()) { answer(res, 403, 'previews_off', { route, provider }); return null }
    if (!PROVIDERS.has(provider)) { res.status(404).json({ error: 'preview_not_found' }); return null }
    return { provider: provider as 'claude' | 'codex' | 'cursor', sessionId: String(req.params.sessionId ?? ''), id: String(req.params.id ?? '') }
  }

  router.get('/preview/agent-sessions/:provider/:sessionId/:id/meta', async (req, res) => {
    const g = gate(req, res, 'meta'); if (!g) return
    const at: LogAt = { route: 'meta', provider: g.provider }
    try {
      const found = await previews.previewFile(g.provider, g.sessionId, g.id, true)
      if (found.status === 'folder') { res.json({ id: g.id, name: '', kind: 'folder', type: 'Folder', state: 'available', parts: [] }); return }
      if (found.status !== 'ok') { refuse(res, found.status, { ...at, detail: found.reason }); return }
      res.json({ id: g.id, name: found.name, kind: found.kind, type: found.type, size: found.identity.size, ...(found.line ? { line: found.line } : {}), state: 'available', parts: partsFor(found.kind, found.name) })
    } catch (error) { refuse(res, 'unavailable', { ...at, detail: 'error_' + previewErrorCode(error) }) }
  })

  router.get('/preview/agent-sessions/:provider/:sessionId/:id/content', async (req, res) => {
    const g = gate(req, res, 'content'); if (!g) return
    const part = String(req.query.part ?? 'raw') as PreviewPart
    const at: LogAt = { route: 'content', provider: g.provider }
    if (!PREVIEW_PARTS.includes(part)) { answer(res, 400, 'preview_part', at); return }
    at.part = part
    try {
      const found = await previews.previewFile(g.provider, g.sessionId, g.id)
      if (found.status !== 'ok') { refuse(res, found.status, { ...at, detail: found.reason }); return }
      at.kind = found.kind
      if (!partsFor(found.kind, found.name).includes(part)) { answer(res, 400, 'preview_part', at); return }
      // A picture goes through the output-image normalizer, as a JPEG, never as the bytes a file claims to be.
      if (found.kind === 'image' && part !== 'raw') {
        const img = await previews.previewImage(g.provider, g.sessionId, g.id, part === 'thumb' ? 'thumb' : 'phone')
        if (img.status !== 'ok') { refuse(res, img.status, { ...at, detail: 'reason' in img ? img.reason : undefined }); return }
        if (!('path' in img)) { refuse(res, 'unavailable', at); return }
        res.set({ 'Content-Type': 'image/jpeg', 'Content-Disposition': 'inline', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cross-Origin-Resource-Policy': 'same-origin' })
        res.sendFile(img.path, { dotfiles: 'allow', headers: { 'Content-Type': 'image/jpeg' } }, err => {
          if (!err) return
          if (!res.headersSent) refuse(res, 'unavailable', { ...at, detail: 'send_' + previewErrorCode(err) }); else { logPreviewRefusal({ ...at, detail: 'send_' + previewErrorCode(err) }, 'preview_cut'); res.destroy() }
        })
        return
      }
      const bytes = found.bytes
      if (part === 'raw' || part === 'inline') { res.set(previewHeaders(part, found.name)); res.status(200).end(bytes); return }
      if (part === 'thumb') {
        const t = await thumbs.thumbnail(bytes, found.name, found.identity)
        if (t.status !== 'ok') {
          if (t.status === 'busy') res.set('Retry-After', '2')
          answer(res, 503, t.status === 'busy' ? PREVIEWS_BUSY : 'thumb_unavailable', { ...at, detail: t.status === 'unavailable' ? t.reason : undefined })
          return
        }
        res.set(previewHeaders('thumb', found.name))
        res.sendFile(t.path, { dotfiles: 'allow', headers: { 'Content-Type': 'image/png' } }, err => {
          if (!err) return
          if (!res.headersSent) answer(res, 503, 'thumb_unavailable', { ...at, detail: 'send_' + previewErrorCode(err) }); else { logPreviewRefusal({ ...at, detail: 'send_' + previewErrorCode(err) }, 'preview_cut'); res.destroy() }
        })
        return
      }
      if (looksBinary(bytes)) { answer(res, 415, 'preview_binary', at); return }
      if (part === 'html' || part === 'html-run') {
        if (bytes.length > HTML_PREVIEW_MAX) { refuse(res, 'too_large', at); return }
        // PLAN 6: the policy is in the page itself too, before anything in it can load.
        res.set(previewHeaders(part, found.name)); res.status(200).end(withCspMeta(bytes, part)); return
      }
      if (part === 'table') {
        res.set(previewHeaders('table', found.name))
        res.json(tablePage(bytes, found.name, Number(req.query.offset ?? 0)))
        return
      }
      // Every text window, an HTML page's source included, is 512 KiB a call with "load more".
      res.set(previewHeaders('text', found.name))
      res.json({ ...textWindow(bytes, Number(req.query.offset ?? 0), Number(req.query.limit ?? TEXT_WINDOW_MAX), TEXT_WINDOW_MAX), ...(found.line ? { line: found.line } : {}) })
    } catch (error) {
      refuse(res, 'unavailable', { ...at, detail: 'error_' + previewErrorCode(error) })
    }
  })

  // Settings, Privacy: the named extra folders. Shown as ~/x inside home. A refusal names each folder's problem.
  router.get('/preview-folders/settings', (_req, res) => {
    res.set('Cache-Control', 'private, no-store')
    try {
      const s = folders.read()
      res.json({ folders: s.folders.map(f => folderDisplay(f, deps.home?.())), source: s.source })
    } catch { res.status(500).json({ error: 'preview_folders_unavailable' }) }
  })
  router.post('/preview-folders/settings', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const body = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'folders') || !Array.isArray(body.folders)) {
      res.status(400).json({ error: { code: 'invalid_preview_folders', message: 'Send { folders: ["~/cos-worktrees"] }.' } }); return
    }
    try {
      const r = folders.set(body.folders)
      if (!r.ok) { res.status(400).json({ error: { code: 'preview_folder_refused', message: r.errors[0]?.message ?? 'That folder cannot be used.' }, errors: r.errors }); return }
      res.json({ folders: r.setting.folders.map(f => folderDisplay(f, deps.home?.())), source: r.setting.source })
    } catch { res.status(500).json({ error: 'preview_folders_unavailable' }) }
  })
  return router
}
