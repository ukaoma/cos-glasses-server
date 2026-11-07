// Native transcript output previews. A transcript reference is evidence of selection, not
// permission to read arbitrary files: only the session's exact recorded workspace is eligible.
// The public id is process-scoped (reload the session after a server restart). Raw sources
// stay in this module. Normalized media is a bounded, staged cache, never a fake COS message.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { constants, realpathSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { agentSessionRoots, findAgentSessionFile, isWrapperPrompt, latestAssistantReply, type AgentProvider } from './agent-session-store.js'
import { realAttachedWorkspaceDeps, resolveAttachedWorkspace } from './attached-workspace.js'
import { readComposerFacts } from './cursor-session-model.js'
import { MAX_OUTPUT_ARTIFACT_BYTES } from './image-safety.js'
import { getMediaStore, STAGED_TTL_MS, type MediaStore } from './media-store.js'
import { readRecentSessionTurns, SESSION_TURNS_MAX, type SessionTurnProjection } from './agent-session-turns.js'

export interface SessionOutputImage {
  id: string
  label: string
  state: 'available' | 'unavailable'
  reason?: 'outside_workspace' | 'missing' | 'unsupported' | 'unavailable'
}
export const SESSION_OUTPUT_IMAGE_ID = /^ai_[a-f0-9]{64}$/
export const OUTPUT_IMAGES_PER_TURN = 5
export const OUTPUT_IMAGE_SCAN_CHARS = 128 * 1024
export const OUTPUT_IMAGE_CACHE_MAX = 128
export const OUTPUT_IMAGE_CONCURRENCY = 2
const CACHE_TTL = Math.min(30 * 60_000, STAGED_TTL_MS)
interface Candidate { source: string; label: string }
interface Source { candidate: Candidate; root: string | null; descriptor: SessionOutputImage }
interface PreviewContext { project: SessionTurnProjection; sources: Map<string, Source> }
interface MediaCache { id: string; at: number }
type PreviewStore = Pick<MediaStore, 'ingestOutputImage' | 'getContent'>
export interface OutputImageDeps {
  findSession(provider: AgentProvider, id: string): Promise<string | null>
  workspace(provider: AgentProvider, id: string, transcript: string): Promise<string | null>
  store(): PreviewStore
  secret: Buffer
  now(): number
}

function assistantText(provider: AgentProvider, row: Record<string, unknown>): string | null {
  if (row.isSidechain === true || row.isMeta === true || row.isCompactSummary === true) return null
  let message: Record<string, unknown> | null = null
  if (provider === 'claude') {
    if (row.type !== 'assistant') return null
    message = row.message as Record<string, unknown> | null
  } else if (provider === 'codex') {
    if (row.type !== 'response_item') return null
    const p = row.payload as Record<string, unknown> | null
    if (!p || p.type !== 'message' || p.role !== 'assistant') return null
    message = p
  } else {
    if (row.role !== 'assistant') return null
    message = row.message as Record<string, unknown> | null
  }
  if (!message || typeof message !== 'object') return null
  // The generic prose extractor trims each block, which destroys Markdown indentation.
  // Preserve it here: an indented first line must not become an image selection.
  const content = message.content
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.flatMap(block => {
      if (!block || typeof block !== 'object') return []
      const b = block as Record<string, unknown>
      return ['text', 'input_text', 'output_text'].includes(String(b.type)) && typeof b.text === 'string' ? [b.text] : []
    }).join('\n\n') : ''
  return text.trim() && !isWrapperPrompt(text) ? text : null
}
// Deliberately bounded Markdown subset: inline image destinations, including angle-wrapped
// paths with spaces and balanced parentheses. No HTML, reference definitions, code or URLs.
function imageTokens(raw: string): Array<Candidate & { start: number; end: number }> {
  const text = raw.slice(0, OUTPUT_IMAGE_SCAN_CHARS)
  const out: Array<Candidate & { start: number; end: number }> = []
  let fence = '', inline = 0
  for (let i = 0; i < text.length; i++) {
    if (i === 0 || text[i - 1] === '\n') {
      // An indented example is literal text, never an output selection.
      if (!fence && /^(?: {4}| {0,3}\t)/.test(text.slice(i, i + 4))) {
        i = text.indexOf('\n', i); if (i < 0) break; continue
      }
      const m = /^( {0,3})(`{3,}|~{3,})/.exec(text.slice(i, i + 80))
      if (m) { if (!fence) fence = m[2]; else if (m[2][0] === fence[0] && m[2].length >= fence.length) fence = ''; i = text.indexOf('\n', i); if (i < 0) break; continue }
    }
    if (fence) continue
    if (text[i] === '\\') { i++; continue }
    if (text[i] === '`') { let n = 1; while (text[i + n] === '`') n++; if (!inline) inline = n; else if (inline === n) inline = 0; i += n - 1; continue }
    if (inline) continue
    // Comments may span lines; nothing inside them authorizes a file read.
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4); if (end < 0) break
      i = end + 2; continue
    }
    if (text.slice(i, i + 2) !== '![') continue
    const endLabel = text.indexOf('](', i + 2)
    if (endLabel < 0 || endLabel - i > 250 || text.slice(i, endLabel).includes('\n')) continue
    let j = endLabel + 2, source = '', valid = false
    if (text[j] === '<') {
      const end = text.indexOf('>', j + 1)
      if (end >= 0 && text[end + 1] === ')') { source = text.slice(j + 1, end); j = end + 2; valid = true }
    } else {
      const start = j; let depth = 1
      while (j < text.length && j - start <= 4096) {
        if (text[j] === '\n') break
        if (text[j] === '(') depth++
        if (text[j] === ')' && --depth === 0) { source = text.slice(start, j); j++; valid = true; break }
        j++
      }
    }
    if (!valid || !source || source.length > 4096 || /[\u0000-\u001f\u007f]/.test(source)) continue
    // Only local paths. Scheme-like strings, network paths and URI escaping stay inert.
    if (/^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith('//') || source.includes('\\')) { i = j - 1; continue }
    const alt = text.slice(i + 2, endLabel).trim()
    const label = alt && !/[\\/\u0000-\u001f]/.test(alt) ? alt.slice(0, 120) : 'Output image'
    out.push({ source, label, start: i, end: j }); i = j - 1
  }
  return out
}
export function assistantImageCandidates(provider: AgentProvider, row: Record<string, unknown>): Candidate[] {
  const raw = assistantText(provider, row)
  return raw ? imageTokens(raw).slice(0, OUTPUT_IMAGES_PER_TURN).map(({ source, label }) => ({ source, label })) : []
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}
function canonicalRoot(path: string | null): string | null {
  if (!path || !isAbsolute(path)) return null
  try {
    const root = realpathSync(path)
    const broad = ['/', '/Users', '/tmp', '/private/tmp', '/var', '/private/var', homedir()]
    if (broad.includes(root) || !statSync(root).isDirectory()) return null
    return root
  } catch { return null }
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

export class AgentSessionOutputImages {
  private cache = new Map<string, MediaCache>()
  private pending = new Map<string, Promise<string>>()
  private active = 0
  private readers = 0
  constructor(private readonly deps: OutputImageDeps) {}

  async context(provider: AgentProvider, sessionId: string, transcript: string): Promise<PreviewContext> {
    let workspace: string | null = null
    try { workspace = await this.deps.workspace(provider, sessionId, transcript) } catch { /* unavailable, words still load */ }
    const root = canonicalRoot(workspace)
    const sources = new Map<string, Source>()
    const transcriptKey = digest(resolve(transcript))
    const project: SessionTurnProjection = (p, row, turn) => {
      const raw = assistantText(p, row)
      if (!raw) return turn
      const candidates = imageTokens(raw)
      if (!candidates.length) return turn
      const recordKey = digest(JSON.stringify(row))
      const refs = candidates.slice(0, OUTPUT_IMAGES_PER_TURN).map((c, ordinal) => {
        const id = 'ai_' + createHmac('sha256', this.deps.secret).update(JSON.stringify([provider, sessionId, transcriptKey, recordKey, ordinal, c.source])).digest('hex')
        const allowed = root !== null && inside(root, resolve(root, c.source))
        const descriptor: SessionOutputImage = { id, label: c.label, state: allowed ? 'available' : 'unavailable', ...(!allowed ? { reason: 'outside_workspace' as const } : {}) }
        sources.delete(id); sources.set(id, { candidate: c, root, descriptor })
        while (sources.size > (SESSION_TURNS_MAX + 1) * OUTPUT_IMAGES_PER_TURN) sources.delete(sources.keys().next().value!)
        return descriptor
      })
      // Never turn an explicit local image into a browser-visible Mac path. Existing callers
      // without this opt-in projection retain their original text and contract.
      // The preview cap limits DTOs, not redaction: the sixth image is still private.
      const parts: string[] = []; let end = 0
      for (const token of candidates) { parts.push(raw.slice(end, token.start), '[Output image]'); end = token.end }
      parts.push(raw.slice(end))
      const text = latestAssistantReply(parts.join(''))
      const at = typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)) ? row.timestamp : undefined
      return { ...(turn ?? { role: 'assistant' as const, text: '', ...(at ? { at } : {}) }), text, outputImages: refs }
    }
    return { project, sources }
  }

  async content(provider: AgentProvider, sessionId: string, imageId: string, variant: 'thumb' | 'phone') {
    if (!SESSION_OUTPUT_IMAGE_ID.test(imageId)) return { status: 'not_found' as const }
    // Admission covers discovery, transcript parsing, authorization and image IO alike.
    if (this.readers >= OUTPUT_IMAGE_CONCURRENCY) return { status: 'unavailable' as const }
    this.readers++
    try {
      const transcript = await this.deps.findSession(provider, sessionId)
      if (!transcript) return { status: 'not_found' as const }
      const context = await this.context(provider, sessionId, transcript)
      const recent = await readRecentSessionTurns(provider, transcript, SESSION_TURNS_MAX, undefined, context.project)
      if (!recent.turns.some(t => t.outputImages?.some(i => i.id === imageId))) return { status: 'not_found' as const }
      const source = context.sources.get(imageId)
      if (!source?.root || source.descriptor.state !== 'available') return { status: 'unavailable' as const }
      const path = resolve(source.root, source.candidate.source)
      const canonical = realpathSync(path)
      if (!inside(source.root, canonical)) return { status: 'unavailable' as const }
      // Reject symlinks in any component and recheck path/fd identity after reading.
      // A changed path never becomes a published preview.
      if (canonical !== path) return { status: 'unavailable' as const }
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let bytes: Buffer, key: string
      try {
        const before = await file.stat()
        if (!before.isFile() || before.size <= 0 || before.size > MAX_OUTPUT_ARTIFACT_BYTES) return { status: 'unavailable' as const }
        key = digest(JSON.stringify([imageId, before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]))
        // Even a cache hit rechecks that the authorized source still exists within the root.
        const hit = this.cache.get(key)
        if (hit && this.deps.now() - hit.at < CACHE_TTL) {
          const current = statSync(path)
          if (realpathSync(path) !== canonical || current.dev !== before.dev || current.ino !== before.ino) return { status: 'unavailable' as const }
          const content = this.deps.store().getContent(hit.id, variant)
          if (content.status === 'ok') return content
        }
        // Bounded positional read, not readFile(): an append during read cannot allocate past the cap.
        bytes = Buffer.alloc(before.size)
        let offset = 0
        while (offset < bytes.length) { const got = await file.read(bytes, offset, bytes.length - offset, offset); if (!got.bytesRead) break; offset += got.bytesRead }
        const after = await file.stat(), current = statSync(path)
        if (offset !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.dev !== before.dev || current.ino !== before.ino || realpathSync(path) !== canonical) return { status: 'unavailable' as const }
      } finally { await file.close() }
      let job = this.pending.get(key!)
      if (!job) {
        if (this.active >= OUTPUT_IMAGE_CONCURRENCY) return { status: 'unavailable' as const }
        this.active++
        job = this.deps.store().ingestOutputImage({ bytes: bytes!, kind: 'generated_visual', label: source.candidate.label }).then(ref => {
          this.cache.set(key!, { id: ref.id, at: this.deps.now() })
          while (this.cache.size > OUTPUT_IMAGE_CACHE_MAX) this.cache.delete(this.cache.keys().next().value!)
          return ref.id
        }).finally(() => { this.active--; this.pending.delete(key!) })
        this.pending.set(key!, job)
      }
      return this.deps.store().getContent(await job, variant)
    } catch { return { status: 'unavailable' as const } }
    finally { this.readers-- }
  }
}

export const agentSessionOutputImages = new AgentSessionOutputImages({
  findSession: (p, id) => findAgentSessionFile(p, id, agentSessionRoots()),
  workspace: async (provider, id, transcript) => {
    const deps = realAttachedWorkspaceDeps()
    // Use the exact transcript already selected by the route, including keyed Codex roots.
    const workspace = resolveAttachedWorkspace(provider, id, { ...deps, transcriptPath: () => transcript })?.path
    if (workspace) return workspace
    if (provider === 'cursor') return (await readComposerFacts([id], agentSessionRoots().cursorComposerDb)).get(id.toLowerCase())?.workspace ?? null
    return null
  },
  store: getMediaStore,
  secret: randomBytes(32), now: Date.now,
})
