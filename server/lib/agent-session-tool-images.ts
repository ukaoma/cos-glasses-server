// Images a session LOOKED AT: the pictures that came back inside tool results (a Read of a PNG,
// a browser or computer-use screenshot) and the pictures a person attached to a prompt.
//
// WHY. Miles, 11/08: the Claude app shows a thumbnail under a step like "Ran 2 commands, read 2
// files", labelled "Read" and "1 of 2". Control Web showed only words for that turn. 6.99.28
// covered images written into reply text and 6.99.35 covered SendUserFile; neither covered tool
// results or prompt attachments.
//
// RECORD SHAPES (read from real transcripts on this Mac, 11/08, shapes only):
// - Claude, a Read of an image: a `user` row with `toolUseResult: { type: 'image', file: { base64,
//   type, originalSize, dimensions } }` and `message.content: [{ type: 'tool_result', tool_use_id,
//   content: [{ type: 'image', source: { type: 'base64', media_type, data } }] }]`.
// - Claude, a screenshot (Claude_Browser / claude-in-chrome / computer-use / Claude_Preview): the
//   same tool_result block, its `content` a mix of text blocks and image blocks of base64 source.
// - Claude, a prompt attachment: a plain `user` row (no toolUseResult) whose `message.content`
//   holds `{ type: 'image', source: { type: 'base64', ... } }` beside the text block. A few rows
//   (sent through the SDK) carry the image and no words at all.
// - Codex: `response_item` rows. A tool output is `function_call_output` or
//   `custom_tool_call_output` with `output: [{ type: 'input_text' }, { type: 'input_image',
//   image_url: 'data:image/png;base64,...', detail }]`; a prompt attachment is a user `message`
//   whose `content` holds `input_image` blocks. The calls were `exec`, `wait` and `js`.
// - Every image seen was embedded base64 (png, jpeg, webp). None referenced a path only. The
//   path-only Read is still handled, under the workspace rules output images use.
//
// This module is pure: it finds the images and names them. Ids, the workspace check and the
// bytes live in agent-session-output-images.ts, beside the other previews.
import type { AgentProvider } from './agent-session-store.js'

export type ToolImageLabel = 'Read' | 'Screenshot' | 'Image' | 'Attached'
export interface SessionToolImage {
  /** Opaque, process-scoped: `ti_` and 64 hex characters. */
  id: string
  /** What the step was, as the Claude app labels it: "Read", "Screenshot", or "Attached" for a prompt image. */
  tool: ToolImageLabel
  /** Its place in the step, 1-based: "1 of 2". */
  index: number
  total: number
  state: 'available' | 'unavailable'
  /**
   * `too_large`: the embedded image is over MAX_TOOL_IMAGE_BYTES. `outside_workspace` and
   * `unavailable`: a path-only Read, under the output-image rules. `missing`: no bytes and no path.
   * `secret_file` (7.0.4): a path-only Read of a file whose name says it may hold secrets (lib/secret-path-guard.ts).
   */
  reason?: 'outside_workspace' | 'unavailable' | 'too_large' | 'missing' | 'secret_file'
  /** 7.0.4: the words the card shows instead, set only with `secret_file`. */
  notice?: string
  /** The step came before the turn's words (a reply that opened with tool calls). */
  before?: true
}

export const SESSION_TOOL_IMAGE_ID = /^ti_[a-f0-9]{64}$/
/** Thumbnails one turn may show. The rest are counted ("+N more") and never get an id. */
export const TOOL_IMAGES_PER_TURN = 6
/** The largest decoded image served. The biggest seen on this Mac was about 510 KB. */
export const MAX_TOOL_IMAGE_BYTES = 8 * 1024 * 1024
export const TOOL_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const IMAGE_PATH = /\.(png|jpe?g|webp|gif)$/i

export type ToolImageRef =
  | { kind: 'embedded'; mediaType: string; data: string }
  | { kind: 'path'; path: string }
  | { kind: 'missing' }
export interface ToolUseMeta { name: string; path?: string }
export interface FoundToolImage { tool: ToolImageLabel; ref: ToolImageRef }

/** The Claude app's label for a tool. Pure. */
export function toolLabel(name: string | undefined): ToolImageLabel {
  if (name === 'Read') return 'Read'
  if (name && /screenshot|computer|zoom|browser_batch|app_batch|snapshot/i.test(name)) return 'Screenshot'
  return 'Image'
}

/** Decoded size of a base64 string, without decoding it. */
export function estimateBytes(b64: string): number {
  let pad = 0
  if (b64.endsWith('==')) pad = 2; else if (b64.endsWith('=')) pad = 1
  return Math.max(0, Math.floor(b64.length * 3 / 4) - pad)
}

/** The image type the bytes ARE, from their magic numbers, or null. Never the declared type. */
export function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

/** Decode an embedded image: refused over the cap (checked before decoding) or when the bytes are not a safe image type. */
export function decodeToolImage(ref: { mediaType: string; data: string }): { status: 'ok'; bytes: Buffer; type: string } | { status: 'too_large' | 'unavailable' } {
  if (estimateBytes(ref.data) > MAX_TOOL_IMAGE_BYTES) return { status: 'too_large' }
  const bytes = Buffer.from(ref.data, 'base64')
  if (!bytes.length || bytes.length > MAX_TOOL_IMAGE_BYTES) return { status: bytes.length ? 'too_large' : 'unavailable' }
  const type = sniffImageType(bytes)
  return type ? { status: 'ok', bytes, type } : { status: 'unavailable' }
}

function obj(v: unknown): Record<string, unknown> | null { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null }

/** An Anthropic image block of base64 source with a safe declared type, or null. */
function base64Block(block: unknown): ToolImageRef | null {
  const b = obj(block); if (!b || b.type !== 'image') return null
  const s = obj(b.source)
  if (!s || s.type !== 'base64' || typeof s.data !== 'string' || !s.data || typeof s.media_type !== 'string') return null
  if (!TOOL_IMAGE_TYPES.includes(s.media_type)) return null
  return { kind: 'embedded', mediaType: s.media_type, data: s.data }
}
/** A Codex/OpenAI `input_image` block carrying a data URL of a safe type, or null. Remote URLs stay inert. */
function dataUrlBlock(block: unknown): ToolImageRef | null {
  const b = obj(block); if (!b || b.type !== 'input_image' || typeof b.image_url !== 'string') return null
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,/.exec(b.image_url.slice(0, 64))
  if (!m) return null
  return { kind: 'embedded', mediaType: m[1], data: b.image_url.slice(m[0].length) }
}

/** The tool calls a row makes, by call id: their names, and a Read's file path. Pure. */
export function toolUsesOf(provider: AgentProvider, row: Record<string, unknown>): Array<[string, ToolUseMeta]> {
  if (row.isSidechain === true) return []
  if (provider === 'claude') {
    if (row.type !== 'assistant') return []
    const content = obj(row.message)?.content
    if (!Array.isArray(content)) return []
    const out: Array<[string, ToolUseMeta]> = []
    for (const block of content) {
      const b = obj(block)
      if (!b || b.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue
      const input = obj(b.input)
      const path = typeof input?.file_path === 'string' ? input.file_path : undefined
      out.push([b.id, path ? { name: b.name, path } : { name: b.name }])
    }
    return out
  }
  if (provider === 'codex') {
    if (row.type !== 'response_item') return []
    const p = obj(row.payload)
    if (!p || (p.type !== 'function_call' && p.type !== 'custom_tool_call') || typeof p.call_id !== 'string' || typeof p.name !== 'string') return []
    return [[p.call_id, { name: p.name }]]
  }
  return []
}

/**
 * The images inside a row's tool results, in order, labelled by the tool that produced them.
 * A sub-agent's results went to its parent, not to the person, and stay out. Pure.
 */
export function toolResultImages(provider: AgentProvider, row: Record<string, unknown>, uses: ReadonlyMap<string, ToolUseMeta>): FoundToolImage[] {
  if (row.isSidechain === true) return []
  const out: FoundToolImage[] = []
  if (provider === 'claude') {
    if (row.type !== 'user') return []
    const content = obj(row.message)?.content
    if (!Array.isArray(content)) return []
    const results = content.filter(b => obj(b)?.type === 'tool_result')
    for (const block of results) {
      const b = obj(block)!
      const meta = typeof b.tool_use_id === 'string' ? uses.get(b.tool_use_id) : undefined
      const tool = toolLabel(meta?.name)
      const found = Array.isArray(b.content) ? b.content.map(base64Block).filter((x): x is ToolImageRef => x !== null) : []
      if (found.length) { for (const ref of found) out.push({ tool, ref }); continue }
      // A Read of an image whose message block was not written: the row's own record of the
      // result may still carry the bytes; else only the path the Read named; else nothing to show.
      const result = obj(row.toolUseResult)
      if (results.length !== 1 || b.is_error === true || result?.type !== 'image') continue
      const file = obj(result.file)
      if (file && typeof file.base64 === 'string' && file.base64 && typeof file.type === 'string' && TOOL_IMAGE_TYPES.includes(file.type)) {
        out.push({ tool, ref: { kind: 'embedded', mediaType: file.type, data: file.base64 } }); continue
      }
      if (meta?.name === 'Read' && meta.path && IMAGE_PATH.test(meta.path)) out.push({ tool, ref: { kind: 'path', path: meta.path } })
      else out.push({ tool, ref: { kind: 'missing' } })
    }
    return out
  }
  if (provider === 'codex') {
    if (row.type !== 'response_item') return []
    const p = obj(row.payload)
    if (!p || (p.type !== 'function_call_output' && p.type !== 'custom_tool_call_output') || !Array.isArray(p.output)) return []
    const meta = typeof p.call_id === 'string' ? uses.get(p.call_id) : undefined
    const tool = meta?.name === 'view_image' ? 'Read' : toolLabel(meta?.name)
    for (const block of p.output) { const ref = dataUrlBlock(block); if (ref) out.push({ tool, ref }) }
  }
  return out
}

/**
 * The images a person attached to a prompt row, or [] (a tool result, a sub-agent, an injected
 * row, an assistant row). Whether the row is a turn at all is the turn reader's call. Pure.
 */
export function promptImages(provider: AgentProvider, row: Record<string, unknown>): ToolImageRef[] {
  if (row.isSidechain === true || row.isMeta === true || row.isCompactSummary === true) return []
  if (provider === 'claude') {
    if (row.type !== 'user' || row.toolUseResult) return []
    const content = obj(row.message)?.content
    if (!Array.isArray(content) || content.some(b => obj(b)?.type === 'tool_result')) return []
    return content.map(base64Block).filter((x): x is ToolImageRef => x !== null)
  }
  if (provider === 'codex') {
    if (row.type !== 'response_item') return []
    const p = obj(row.payload)
    if (!p || p.type !== 'message' || p.role !== 'user' || !Array.isArray(p.content)) return []
    return p.content.map(dataUrlBlock).filter((x): x is ToolImageRef => x !== null)
  }
  return []
}
