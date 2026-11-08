// Native transcript output previews. A transcript reference is evidence of selection, not
// permission to read arbitrary files: only the session's exact recorded workspace is eligible.
// The public id is process-scoped (reload the session after a server restart). Raw sources
// stay in this module. Normalized media is a bounded, staged cache, never a fake COS message.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { constants, realpathSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { agentSessionRoots, findAgentSessionFile, isWrapperPrompt, latestAssistantReply, LATEST_REPLY_MAX, type AgentProvider } from './agent-session-store.js'
import { realAttachedWorkspaceDeps, resolveAttachedWorkspace } from './attached-workspace.js'
import { readComposerFacts } from './cursor-session-model.js'
import { MAX_OUTPUT_ARTIFACT_BYTES } from './image-safety.js'
import { getMediaStore, STAGED_TTL_MS, type MediaStore } from './media-store.js'
import { readRecentSessionTurns, SESSION_TURNS_MAX, type SessionTurn, type SessionTurnProjection } from './agent-session-turns.js'
import {
  decodeToolImage, estimateBytes, MAX_TOOL_IMAGE_BYTES, promptImages, SESSION_TOOL_IMAGE_ID, TOOL_IMAGES_PER_TURN, toolResultImages, toolUsesOf,
  type FoundToolImage, type SessionToolImage, type ToolUseMeta,
} from './agent-session-tool-images.js'

export interface SessionOutputImage {
  id: string
  label: string
  state: 'available' | 'unavailable'
  /**
   * `outside_workspace`: permanent (the path leaves the workspace, or the workspace is a broad
   * root that is never eligible). `unavailable`: the workspace lookup failed this time; the
   * content route re-resolves it, so a retry can succeed.
   */
  reason?: 'outside_workspace' | 'unavailable' | 'missing'
}
/**
 * A file a Claude session sent to the person with its SendUserFile tool (6.99.35), when it is not
 * an image the preview pipeline normalizes. Only the base name travels; never a Mac path.
 * `missing`: the path is inside the workspace but nothing is there now.
 */
export interface SessionOutputFile {
  id: string
  name: string
  /** How the web may open it: `pdf` inline, `text` as words, `html` sandboxed or downloaded, `image` (GIF) as a picture, `file` downloaded. */
  kind: SharedFileKind
  /** A short type for people: "PDF", "HTML page", "Markdown", "Word document". */
  type: string
  size?: number
  state: 'available' | 'unavailable'
  reason?: 'outside_workspace' | 'unavailable' | 'missing'
}
export type SharedFileKind = 'pdf' | 'text' | 'html' | 'image' | 'file'
export const SESSION_OUTPUT_FILE_ID = /^af_[a-f0-9]{64}$/
/** Files one SendUserFile row may show (images and other files together). The rest are counted in words. */
export const SHARED_FILES_PER_TURN = 10
/** The largest sent file the web may fetch. Bigger files stay listed as "Too large to open here". */
export const MAX_SHARED_FILE_BYTES = 32 * 1024 * 1024
export const SESSION_OUTPUT_IMAGE_ID = /^ai_[a-f0-9]{64}$/
export const OUTPUT_IMAGES_PER_TURN = 5
export const OUTPUT_IMAGE_SCAN_CHARS = 128 * 1024
export const OUTPUT_IMAGE_CACHE_MAX = 128
export const OUTPUT_IMAGE_CONCURRENCY = 2
const CACHE_TTL = Math.min(30 * 60_000, STAGED_TTL_MS)
/** Sources kept per read: every preview the newest turns can name, a sent-files turn being the widest. */
const SOURCES_MAX = (SESSION_TURNS_MAX + 1) * Math.max(OUTPUT_IMAGES_PER_TURN, SHARED_FILES_PER_TURN)
interface Candidate { source: string; label: string }
interface Source { candidate: Candidate; root: string | null; descriptor: SessionOutputImage }
interface FileSource { path: string | null; root: string | null; file: SessionOutputFile }
/** Where a tool-result image's bytes are. Embedded bytes are kept only for the one id a content request names. */
type ToolSource = { kind: 'embedded'; mediaType: string; data: string } | { kind: 'path'; source: string; root: string; label: string }
interface PreviewContext { project: SessionTurnProjection; sources: Map<string, Source>; files: Map<string, FileSource>; toolSources: Map<string, ToolSource> }
/** Tool calls remembered per read, so a result row can be labelled by the call that asked for it. */
const TOOL_USES_MAX = 4096
interface MediaCache { id: string; at: number }
type PreviewStore = Pick<MediaStore, 'ingestOutputImage' | 'getContent'>
export interface OutputImageDeps {
  findSession(provider: AgentProvider, id: string): Promise<string | null>
  workspace(provider: AgentProvider, id: string, transcript: string): Promise<string | null>
  store(): PreviewStore
  secret: Buffer
  now(): number
  /** The home directory the broad-root denylist is built from (tests inject a scratch home). */
  home?(): string
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
/**
 * Exact roots that are never a session workspace, however a session recorded them. EXACT
 * match only: `~/Documents/GitHub/x` stays eligible while `~/Documents` itself is not. Each
 * entry is compared both as written and canonicalized, since the workspace is realpath'd.
 */
export function broadWorkspaceRoots(home = homedir()): Set<string> {
  const raw = ['/', '/Users', '/tmp', '/private/tmp', '/var', '/private/var', '/Volumes', home,
    join(home, 'Documents'), join(home, 'Library'), join(home, '.cos-glasses')]
  const out = new Set<string>()
  for (const entry of raw) {
    out.add(entry)
    try { out.add(realpathSync(entry)) } catch { /* absent on this Mac: the literal still counts */ }
  }
  return out
}
/** A canonical workspace root, `'broad'` for a denied exact root, or null when the lookup failed. */
function canonicalRoot(path: string | null, home: string): string | 'broad' | null {
  if (!path || !isAbsolute(path)) return null
  try {
    const root = realpathSync(path)
    if (broadWorkspaceRoots(home).has(root)) return 'broad'
    if (!statSync(root).isDirectory()) return null
    return root
  } catch { return null }
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

// ── Files a Claude session sent with SendUserFile (6.99.35) ──────────────────────────────
// Its input is { files: [paths], caption?, status, display? }; paths are absolute or relative to the
// session's working directory at that moment (the row's `cwd`). The row is evidence of what was
// shared, not permission to read: a file is served only when its canonical path is inside the
// session's exact workspace, as for images. Codex and Cursor transcripts have no such record.
const NORMALIZED_IMAGE = /\.(png|jpe?g|webp|hei[cf]|avif)$/i
const SHARED_KINDS: Array<[RegExp, SharedFileKind, string]> = [
  [/\.pdf$/i, 'pdf', 'PDF'],
  [/\.html?$/i, 'html', 'HTML page'],
  [/\.(md|markdown)$/i, 'text', 'Markdown'],
  [/\.csv$/i, 'text', 'CSV'],
  [/\.tsv$/i, 'text', 'TSV'],
  [/\.json$/i, 'text', 'JSON'],
  [/\.ya?ml$/i, 'text', 'YAML'],
  [/\.(txt|log)$/i, 'text', 'Text'],
  // An SVG can carry script, so it is shown as its source, never as a picture from a same-origin URL.
  [/\.svg$/i, 'text', 'SVG source'],
  [/\.xml$/i, 'text', 'XML'],
  [/\.gif$/i, 'image', 'GIF image'],
  [/\.docx?$/i, 'file', 'Word document'],
  [/\.xlsx?$/i, 'file', 'Excel workbook'],
  [/\.pptx?$/i, 'file', 'PowerPoint deck'],
  [/\.(wav|mp3|m4a|aac|flac)$/i, 'file', 'Audio'],
  [/\.(mp4|mov|webm)$/i, 'file', 'Video'],
  [/\.zip$/i, 'file', 'ZIP archive'],
  [/\.ehpk$/i, 'file', 'EHPK package'],
]
export function sharedFileKind(name: string): { kind: SharedFileKind; type: string } {
  for (const [re, kind, type] of SHARED_KINDS) if (re.test(name)) return { kind, type }
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)
  return { kind: 'file', type: ext ? ext[1].toUpperCase() + ' file' : 'File' }
}
/** The base name a person sees: no directories, no control characters, at most 120 characters. */
function displayName(source: string): string {
  const base = source.split(/[\\/]/).filter(Boolean).pop() || ''
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (clean || 'File').slice(0, 120)
}
interface SentFiles { caption: string; files: string[] }
/** The SendUserFile tool uses in one Claude assistant row, or null. Pure. */
export function sentUserFiles(provider: AgentProvider, row: Record<string, unknown>): SentFiles | null {
  if (provider !== 'claude' || row.type !== 'assistant') return null
  // A sub-agent's share went to its parent, not to the person; an injected row is no one's.
  if (row.isSidechain === true || row.isMeta === true || row.isCompactSummary === true) return null
  const message = row.message as Record<string, unknown> | null
  const content = message && typeof message === 'object' ? message.content : null
  if (!Array.isArray(content)) return null
  const files: string[] = [], captions: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type !== 'tool_use' || b.name !== 'SendUserFile' || !b.input || typeof b.input !== 'object') continue
    const input = b.input as Record<string, unknown>
    if (!Array.isArray(input.files)) continue
    let any = false
    for (const f of input.files) {
      if (typeof f !== 'string' || !f || f.length > 4096 || /[\u0000-\u001f\u007f]/.test(f)) continue
      files.push(f); any = true
    }
    if (any && typeof input.caption === 'string' && input.caption.trim()) captions.push(input.caption.trim().slice(0, 4000))
  }
  return files.length ? { caption: captions.join('\n\n'), files } : null
}

/** A Claude row's content has typed words (a text block that is not blank). */
function hasWords(row: Record<string, unknown>): boolean {
  const content = (row.message as Record<string, unknown> | null | undefined)?.content
  if (typeof content === 'string') return content.trim().length > 0
  return Array.isArray(content) && content.some(b => !!b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text' && typeof (b as Record<string, unknown>).text === 'string' && ((b as Record<string, unknown>).text as string).trim().length > 0)
}

export class AgentSessionOutputImages {
  private cache = new Map<string, MediaCache>()
  private pending = new Map<string, Promise<string>>()
  private active = 0
  private readers = 0
  constructor(private readonly deps: OutputImageDeps) {}

  /**
   * `want`: the one tool-image id a content request is for. Only its embedded bytes are kept; a detail read
   * (no `want`) keeps none, so a long session never holds 50 base64 images past the line that parsed them.
   */
  async context(provider: AgentProvider, sessionId: string, transcript: string, want?: string): Promise<PreviewContext> {
    let workspace: string | null = null
    try { workspace = await this.deps.workspace(provider, sessionId, transcript) } catch { /* unavailable, words still load */ }
    const canonical = canonicalRoot(workspace, this.deps.home?.() ?? homedir())
    const root = canonical === 'broad' ? null : canonical
    // A failed lookup is temporary and the content route re-resolves it; a broad root is not.
    const lookupFailed = canonical === null
    const sources = new Map<string, Source>()
    const transcriptKey = digest(resolve(transcript))
    const files = new Map<string, FileSource>()
    const markdown: SessionTurnProjection = (p, row, turn) => {
      const raw = assistantText(p, row)
      if (!raw) return turn
      // Prose cleanup can collapse a huge whitespace/code prefix, bringing an unscanned
      // suffix into the visible reply. Never project that suffix. Drop the boundary line
      // too: it might end halfway through a Markdown destination (or an ordinary sentence).
      const shortened = raw.length > OUTPUT_IMAGE_SCAN_CHARS
      const scanned = shortened ? raw.slice(0, raw.lastIndexOf('\n', OUTPUT_IMAGE_SCAN_CHARS - 1) + 1) : raw
      const candidates = imageTokens(scanned)
      if (!candidates.length && !shortened) return turn
      const recordKey = digest(JSON.stringify(row))
      const refs = candidates.slice(0, OUTPUT_IMAGES_PER_TURN).map((c, ordinal) => {
        const id = 'ai_' + createHmac('sha256', this.deps.secret).update(JSON.stringify([provider, sessionId, transcriptKey, recordKey, ordinal, c.source])).digest('hex')
        const allowed = root !== null && inside(root, resolve(root, c.source))
        const descriptor: SessionOutputImage = { id, label: c.label, state: allowed ? 'available' : 'unavailable', ...(!allowed ? { reason: lookupFailed ? 'unavailable' as const : 'outside_workspace' as const } : {}) }
        sources.delete(id); sources.set(id, { candidate: c, root, descriptor })
        while (sources.size > SOURCES_MAX) sources.delete(sources.keys().next().value!)
        return descriptor
      })
      // Never turn an explicit local image into a browser-visible Mac path. Existing callers
      // without this opt-in projection retain their original text and contract.
      // The preview cap limits DTOs, not redaction: the sixth image is still private.
      const parts: string[] = []; let end = 0
      for (const token of candidates) { parts.push(scanned.slice(end, token.start), '[Output image]'); end = token.end }
      parts.push(scanned.slice(end))
      const omission = '[Reply shortened at the image preview scan limit.]'
      const text = shortened
        ? [latestAssistantReply(parts.join(''), LATEST_REPLY_MAX - omission.length - 1), omission].filter(Boolean).join('\n')
        : latestAssistantReply(parts.join(''))
      const at = typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)) ? row.timestamp : undefined
      return { ...(turn ?? { role: 'assistant' as const, text: '', ...(at ? { at } : {}) }), text, outputImages: refs }
    }
    const project: SessionTurnProjection = (p, row, turn) => {
      const shaped = markdown(p, row, turn)
      const sent = sentUserFiles(p, row)
      if (!sent) return shaped
      const recordKey = digest(JSON.stringify(row))
      // Relative paths are relative to where the session stood when it sent them, as the tool reads them.
      const cwd = typeof row.cwd === 'string' && isAbsolute(row.cwd) ? row.cwd : root
      const images: SessionOutputImage[] = [], out: SessionOutputFile[] = []
      sent.files.slice(0, SHARED_FILES_PER_TURN).forEach((written, ordinal) => {
        const name = displayName(written)
        // Never a URL, a network path or a home shorthand: only a local path is ever opened.
        const remote = /^[a-z][a-z0-9+.-]*:/i.test(written) || written.startsWith('//') || written.startsWith('~')
        const lexical = remote || !cwd ? null : resolve(cwd, written)
        let canonical: string | null = null
        if (lexical && root !== null) { try { canonical = realpathSync(lexical) } catch { canonical = null } }
        let reason: SessionOutputFile['reason'] | undefined
        let size: number | undefined
        if (root === null) reason = lookupFailed ? 'unavailable' : 'outside_workspace'
        else if (!lexical) reason = 'outside_workspace'
        // The canonical file decides: a link that leaves the workspace is outside it.
        else if (canonical !== null && !inside(root, canonical)) reason = 'outside_workspace'
        else if (canonical === null) reason = inside(root, lexical) ? 'missing' : 'outside_workspace'
        else {
          try {
            const st = statSync(canonical)
            if (!st.isFile()) reason = 'missing'
            else size = st.size
          } catch { reason = 'missing' }
        }
        const allowed = reason === undefined
        if (NORMALIZED_IMAGE.test(name)) {
          const id = 'ai_' + createHmac('sha256', this.deps.secret).update(JSON.stringify([provider, sessionId, transcriptKey, recordKey, 'sent', ordinal, written])).digest('hex')
          const descriptor: SessionOutputImage = { id, label: name, state: allowed ? 'available' : 'unavailable', ...(reason ? { reason } : {}) }
          // The canonical path is the source, so the content route's no-symlink check holds for it.
          sources.delete(id); sources.set(id, { candidate: { source: allowed ? canonical! : written, label: name }, root, descriptor })
          while (sources.size > SOURCES_MAX) sources.delete(sources.keys().next().value!)
          images.push(descriptor)
          return
        }
        const id = 'af_' + createHmac('sha256', this.deps.secret).update(JSON.stringify([provider, sessionId, transcriptKey, recordKey, 'file', ordinal, written])).digest('hex')
        const { kind, type } = sharedFileKind(name)
        const file: SessionOutputFile = { id, name, kind, type, ...(size !== undefined ? { size } : {}), state: allowed ? 'available' : 'unavailable', ...(reason ? { reason } : {}) }
        files.delete(id); files.set(id, { path: allowed ? canonical : null, root, file })
        while (files.size > SOURCES_MAX) files.delete(files.keys().next().value!)
        out.push(file)
      })
      // The caption is the session's own words; an inline image in it is never a way to show a path.
      const tokens = imageTokens(sent.caption)
      let caption = '', end = 0
      for (const token of tokens) { caption += sent.caption.slice(end, token.start) + '[Output image]'; end = token.end }
      caption += sent.caption.slice(end)
      const extra = sent.files.length - SHARED_FILES_PER_TURN
      const words = [caption && latestAssistantReply(caption), extra > 0 ? extra + (extra === 1 ? ' more file was sent and is not listed here.' : ' more files were sent and are not listed here.') : ''].filter(Boolean).join('\n\n')
      const at = typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)) ? row.timestamp : undefined
      const base = shaped ?? { role: 'assistant' as const, text: '', ...(at ? { at } : {}) }
      return {
        ...base,
        text: [base.text, words].filter(Boolean).join('\n\n'),
        ...(images.length || base.outputImages?.length ? { outputImages: [...(base.outputImages ?? []), ...images] } : {}),
        ...(out.length ? { outputFiles: out } : {}),
      }
    }
    // ── Images the session looked at: tool results, and images attached to prompts ──
    // The reader shows messages, not tool calls, so a step's images ride on the assistant turn the step followed
    // (the words before it, as the Claude app shows the step under them). A step that came before any words in this
    // window waits for the next assistant turn and is marked `before`. A user turn ends a step that never got words.
    const toolSources = new Map<string, ToolSource>()
    const uses = new Map<string, ToolUseMeta>()
    let groups = new WeakMap<SessionTurn, { before: number; after: number }>()
    let last: SessionTurn | null = null
    let pending: SessionToolImage[] = [], pendingExtra = 0
    const recordKeyOf = (row: Record<string, unknown>) => typeof row.uuid === 'string' && row.uuid ? 'u:' + row.uuid : digest(JSON.stringify(row))
    const describe = (recordKey: string, scope: 'tool' | 'prompt', ordinal: number, found: FoundToolImage): SessionToolImage => {
      const id = 'ti_' + createHmac('sha256', this.deps.secret).update(JSON.stringify([provider, sessionId, transcriptKey, recordKey, scope, ordinal])).digest('hex')
      const ref = found.ref
      let reason: SessionToolImage['reason'] | undefined
      if (ref.kind === 'embedded') {
        if (estimateBytes(ref.data) > MAX_TOOL_IMAGE_BYTES) reason = 'too_large'
        else if (id === want) toolSources.set(id, { kind: 'embedded', mediaType: ref.mediaType, data: ref.data })
      } else if (ref.kind === 'path') {
        // A Read that names a path and carries no bytes: the output-image rule, the session's exact workspace only.
        if (root === null) reason = lookupFailed ? 'unavailable' : 'outside_workspace'
        else if (!inside(root, resolve(root, ref.path))) reason = 'outside_workspace'
        else {
          // The canonical file decides, as for sent files: a link that leaves the workspace is outside it.
          let canonical: string | null = null
          try { canonical = realpathSync(resolve(root, ref.path)) } catch { canonical = null }
          if (canonical === null) reason = 'missing'
          else if (!inside(root, canonical)) reason = 'outside_workspace'
        }
        if (root !== null && !reason) {
          // The canonical path is the source, as for sent images, so the content read's no-link check holds for it.
          toolSources.delete(id); toolSources.set(id, { kind: 'path', source: realpathSync(resolve(root, ref.path)), root, label: found.tool })
          while (toolSources.size > SOURCES_MAX) toolSources.delete(toolSources.keys().next().value!)
        }
      } else reason = 'missing'
      return { id, tool: found.tool, index: 0, total: 0, state: reason ? 'unavailable' : 'available', ...(reason ? { reason } : {}) }
    }
    // The turn is already in the reader's list, so it is extended in place. Past the cap an image is counted, never listed.
    const attach = (turn: SessionTurn, images: SessionToolImage[], extra: number, before: boolean) => {
      const g = groups.get(turn) ?? { before: 0, after: 0 }; groups.set(turn, g)
      const key = before ? 'before' : 'after'
      const list = turn.toolImages ?? []
      for (const d of images) {
        g[key]++
        if (list.length < TOOL_IMAGES_PER_TURN) list.push({ ...d, index: g[key], ...(before ? { before: true as const } : {}) })
        else turn.toolImagesMore = (turn.toolImagesMore ?? 0) + 1
      }
      if (extra > 0) { g[key] += extra; turn.toolImagesMore = (turn.toolImagesMore ?? 0) + extra }
      for (const d of list) if ((d.before === true) === before) d.total = g[key]
      if (list.length) turn.toolImages = list
    }
    const withTools: SessionTurnProjection = (p, row, turn) => {
      for (const [id, meta] of toolUsesOf(p, row)) {
        uses.delete(id); uses.set(id, meta)
        while (uses.size > TOOL_USES_MAX) uses.delete(uses.keys().next().value!)
      }
      let result = project(p, row, turn)
      const found = toolResultImages(p, row, uses)
      if (found.length) {
        const key = recordKeyOf(row)
        const described = found.map((f, i) => describe(key, 'tool', i, f))
        if (last && last.role === 'assistant') attach(last, described, 0, false)
        else for (const d of described) { if (pending.length < TOOL_IMAGES_PER_TURN) pending.push(d); else pendingExtra++ }
      }
      const attached = promptImages(p, row)
      if (attached.length) {
        // A Claude prompt that is only an image (sent through the SDK) is still something the person said.
        if (!result && p === 'claude' && !hasWords(row)) {
          const at = typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)) ? row.timestamp : undefined
          result = { role: 'user', text: attached.length === 1 ? '[Image]' : `[${attached.length} images]`, ...(at ? { at } : {}) }
        }
        if (result && result.role === 'user') {
          const key = recordKeyOf(row)
          attach(result, attached.map((ref, i) => describe(key, 'prompt', i, { tool: 'Attached', ref })), 0, false)
        }
      }
      if (result) {
        if (result.role === 'assistant' && (pending.length || pendingExtra)) attach(result, pending, pendingExtra, true)
        pending = []; pendingExtra = 0
        last = result
      }
      return result
    }
    withTools.reset = () => {
      // readRecentSessionTurns may grow from 2 to 8 to 24 MiB. Each pass must project
      // only its own records, not attach early images to a turn discarded with the smaller window.
      sources.clear(); files.clear(); toolSources.clear(); uses.clear()
      groups = new WeakMap()
      last = null; pending = []; pendingExtra = 0
    }
    return { project: withTools, sources, files, toolSources }
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
      return await this.workspaceImage(imageId, source.root, source.candidate.source, source.candidate.label, variant)
    } catch { return { status: 'unavailable' as const } }
    finally { this.readers-- }
  }

  /**
   * A tool-result or prompt image (`ti_` id), re-authorized from the transcript: the id must name an image in the
   * session's newest turns. Embedded bytes are decoded here and typed by what they are; a path-only Read goes
   * through the same workspace read and normalizer as an output image.
   */
  async toolImageContent(provider: AgentProvider, sessionId: string, imageId: string): Promise<
    { status: 'ok'; bytes: Buffer; type: string } | { status: 'ok'; path: string; mime: string; bytes: number } | { status: 'not_found' | 'unavailable' | 'too_large' }> {
    if (!SESSION_TOOL_IMAGE_ID.test(imageId)) return { status: 'not_found' }
    if (this.readers >= OUTPUT_IMAGE_CONCURRENCY) return { status: 'unavailable' }
    this.readers++
    try {
      const transcript = await this.deps.findSession(provider, sessionId)
      if (!transcript) return { status: 'not_found' }
      const context = await this.context(provider, sessionId, transcript, imageId)
      const recent = await readRecentSessionTurns(provider, transcript, SESSION_TURNS_MAX, undefined, context.project)
      const descriptor = recent.turns.flatMap(t => t.toolImages ?? []).find(i => i.id === imageId)
      if (!descriptor) return { status: 'not_found' }
      if (descriptor.reason === 'too_large') return { status: 'too_large' }
      const source = context.toolSources.get(imageId)
      if (descriptor.state !== 'available' || !source) return { status: 'unavailable' }
      if (source.kind === 'embedded') return decodeToolImage(source)
      const normalized = await this.workspaceImage(imageId, source.root, source.source, source.label, 'phone')
      return normalized.status === 'ok' ? normalized : { status: 'unavailable' }
    } catch { return { status: 'unavailable' } }
    finally { this.readers-- }
  }

  /** The workspace read every path-based preview shares: exact containment, no links, the same file before and after. */
  private async workspaceImage(imageId: string, root: string, written: string, label: string, variant: 'thumb' | 'phone') {
    const source = { root, candidate: { source: written, label } }
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
  }

  /**
   * The bytes of a file a session sent (6.99.35), re-authorized like an image: the id must name a
   * file in the session's newest turns, its canonical path must still be inside the exact workspace,
   * no component may be a link, and the file must be the same one before and after the read.
   */
  async fileContent(provider: AgentProvider, sessionId: string, fileId: string): Promise<
    { status: 'ok'; bytes: Buffer; name: string; kind: SharedFileKind } | { status: 'not_found' | 'unavailable' | 'too_large' }> {
    if (!SESSION_OUTPUT_FILE_ID.test(fileId)) return { status: 'not_found' }
    if (this.readers >= OUTPUT_IMAGE_CONCURRENCY) return { status: 'unavailable' }
    this.readers++
    try {
      const transcript = await this.deps.findSession(provider, sessionId)
      if (!transcript) return { status: 'not_found' }
      const context = await this.context(provider, sessionId, transcript)
      const recent = await readRecentSessionTurns(provider, transcript, SESSION_TURNS_MAX, undefined, context.project)
      if (!recent.turns.some(t => t.outputFiles?.some(f => f.id === fileId))) return { status: 'not_found' }
      const source = context.files.get(fileId)
      if (!source?.root || !source.path || source.file.state !== 'available') return { status: 'unavailable' }
      const path = source.path
      if (!inside(source.root, path) || realpathSync(path) !== path) return { status: 'unavailable' }
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const before = await file.stat()
        if (!before.isFile()) return { status: 'unavailable' }
        if (before.size > MAX_SHARED_FILE_BYTES) return { status: 'too_large' }
        const bytes = Buffer.alloc(before.size)
        let offset = 0
        while (offset < bytes.length) { const got = await file.read(bytes, offset, bytes.length - offset, offset); if (!got.bytesRead) break; offset += got.bytesRead }
        const after = await file.stat(), current = statSync(path)
        if (offset !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || current.dev !== before.dev || current.ino !== before.ino || realpathSync(path) !== path) return { status: 'unavailable' }
        return { status: 'ok', bytes, name: source.file.name, kind: source.file.kind }
      } finally { await file.close() }
    } catch { return { status: 'unavailable' } }
    finally { this.readers-- }
  }
}

/** Content-Type, Content-Disposition and CSP for a sent file. HTML is never served as HTML. */
export function sharedFileHeaders(name: string, kind: SharedFileKind): Record<string, string> {
  const ascii = name.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^[ .]+/, '') || 'file'
  const inline = kind === 'pdf'
  const type = kind === 'pdf' ? 'application/pdf'
    : kind === 'text' ? 'text/plain; charset=utf-8'
    : kind === 'image' && /\.gif$/i.test(name) ? 'image/gif'
    : 'application/octet-stream'
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
  }
  // Opened directly, nothing in it runs and it cannot reach this origin. A PDF keeps the browser's viewer.
  if (!inline) headers['Content-Security-Policy'] = "sandbox; default-src 'none'"
  return headers
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
