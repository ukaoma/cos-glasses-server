/**
 * Link cards (preview engine phase 1, PLAN_preview_engine_2026-11-08 4f). A Markdown link in a reply to a local file
 * becomes a card where it sits. 40% of sessions link a local file; 3,389 links in 14 days, none of which worked.
 *
 * This module is pure apart from filesystem reads in `resolveLinkTarget`:
 *   - `linkTokens`: the same bounded scanner as the inline-image tokens, for `[label](target)`. Code fences, inline
 *     code, indented blocks and comments stay inert. Web URLs and #anchors are not local and stay as written.
 *   - `splitLineAnchor`: `file.ts:42`, `:42:7`, `:42-50` and `#L42` become `line`, never part of the name.
 *   - `resolveLinkTarget`: the row's cwd first, then the workspace root (21% of relative links need the root), then
 *     authorized only inside the workspace or a Settings extra folder, and never a denied secret name.
 *   - `previewKind`: what the viewer does with a name.
 *
 * Paths never leave the server: a card carries a base name, the link's words and an opaque id.
 */
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeniedSecretPath } from './secret-path-guard.js'

export const LINK_CARDS_PER_TURN = 20
export const SESSION_OUTPUT_LINK_ID = /^al_[a-f0-9]{64}$/
/** The marker a card leaves in the projected text: `[label](cos-file:N)`, N the index into the turn's outputLinks. */
export const LINK_MARKER = /\[([^\]\n]*)\]\(cos-file:(\d{1,2})\)/g

export type PreviewKind = 'image' | 'pdf' | 'html' | 'markdown' | 'text' | 'code' | 'table' | 'document' | 'slides' | 'sheet'
  | 'audio' | 'video' | 'archive' | 'folder' | 'file'
/** `secret_file`: the 7.0.4 shared deny list (secret-path-guard.ts) refused the name, as written or canonically. */
export type LinkReason = 'outside_workspace' | 'missing' | 'unavailable' | 'secret_file'

/** A link card. Only a base name, the link's words and an opaque id travel; never a Mac path. */
export interface SessionOutputLink {
  id: string
  label: string
  name: string
  kind: PreviewKind
  type: string
  size?: number
  line?: number
  state: 'available' | 'unavailable'
  reason?: LinkReason
  /** The words the card shows instead (SECRET_FILE_NOTICE), set only with `secret_file`. */
  notice?: string
}

export interface LinkToken { label: string; target: string; start: number; end: number }

const KINDS: Array<[RegExp, PreviewKind, string]> = [
  [/\.(png|jpe?g|webp|hei[cf]|avif)$/i, 'image', 'Image'],
  [/\.gif$/i, 'image', 'GIF image'],
  [/\.pdf$/i, 'pdf', 'PDF'],
  [/\.html?$/i, 'html', 'HTML page'],
  [/\.(md|markdown|mdx)$/i, 'markdown', 'Markdown'],
  [/\.csv$/i, 'table', 'CSV'],
  [/\.tsv$/i, 'table', 'TSV'],
  [/\.(txt|log|text)$/i, 'text', 'Text'],
  [/\.json$/i, 'code', 'JSON'],
  [/\.jsonl$/i, 'code', 'JSON lines'],
  [/\.ya?ml$/i, 'code', 'YAML'],
  [/\.toml$/i, 'code', 'TOML'],
  [/\.xml$/i, 'code', 'XML'],
  // An SVG can carry script, so it is shown as its source, never as a picture.
  [/\.svg$/i, 'code', 'SVG source'],
  [/\.(ts|tsx|mts|cts)$/i, 'code', 'TypeScript'],
  [/\.(js|jsx|mjs|cjs)$/i, 'code', 'JavaScript'],
  [/\.py$/i, 'code', 'Python'],
  [/\.swift$/i, 'code', 'Swift'],
  [/\.(sh|zsh|bash)$/i, 'code', 'Shell script'],
  [/\.(css|scss)$/i, 'code', 'CSS'],
  [/\.(rb|go|rs|java|kt|c|h|cc|cpp|hpp|m|mm|sql|lua|php)$/i, 'code', 'Source code'],
  [/\.(plist|ini|conf|cfg|properties)$/i, 'code', 'Settings file'],
  [/\.docx?$/i, 'document', 'Word document'],
  [/\.(pages|rtf)$/i, 'document', 'Document'],
  [/\.xlsx?$/i, 'sheet', 'Excel workbook'],
  [/\.numbers$/i, 'sheet', 'Spreadsheet'],
  [/\.pptx?$/i, 'slides', 'PowerPoint deck'],
  [/\.key$/i, 'slides', 'Keynote deck'],
  [/\.(wav|mp3|m4a|aac|flac|aiff?)$/i, 'audio', 'Audio'],
  [/\.(mp4|mov|webm|m4v)$/i, 'video', 'Video'],
  [/\.(zip|tar|gz|tgz|bz2|xz|7z)$/i, 'archive', 'Archive'],
  [/\.ehpk$/i, 'archive', 'EHPK package'],
]
export function previewKind(name: string): { kind: PreviewKind; type: string } {
  for (const [re, kind, type] of KINDS) if (re.test(name)) return { kind, type }
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)
  return { kind: 'file', type: ext ? ext[1].toUpperCase() + ' file' : 'File' }
}

/** The base name a person sees: no directories, no control characters, at most 120 characters. */
export function baseName(source: string): string {
  const base = source.split(/[\\/]/).filter(Boolean).pop() || ''
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (clean || 'File').slice(0, 120)
}

/**
 * A link's words, made safe to show: a label that is itself an absolute or home path becomes its base name, so
 * `[/Users/x/plan.md](/Users/x/plan.md)` never puts the path in front of anyone. Anything else is kept (120 chars).
 */
export function linkLabel(label: string, name: string): string {
  const clean = label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (!clean) return name
  if (/^(?:file:\/\/|~\/|\/)/.test(clean) || /(?:^|[\s(`'"])(?:\/Users\/|\/private\/|\/Volumes\/|\/var\/folders\/)/.test(clean)) return baseName(clean.replace(/^file:\/\//, ''))
  return clean.slice(0, 120)
}

export const LINK_SCAN_CHARS = 128 * 1024

/**
 * `[label](target)` tokens in reply text, never `![..](..)` (images have their own scanner). Bounded like the image
 * scanner: inert inside fences, inline code, indented blocks and comments; the label has no brackets or newline; the
 * target is angle-wrapped (spaces allowed) or balanced parentheses on one line. A trailing ` "title"` is dropped.
 */
export function linkTokens(raw: string, scanChars = LINK_SCAN_CHARS): LinkToken[] {
  const text = raw.slice(0, scanChars)
  const out: LinkToken[] = []
  let fence = '', inline = 0
  for (let i = 0; i < text.length; i++) {
    if (i === 0 || text[i - 1] === '\n') {
      if (!fence && /^(?: {4}| {0,3}\t)/.test(text.slice(i, i + 4))) { i = text.indexOf('\n', i); if (i < 0) break; continue }
      const m = /^( {0,3})(`{3,}|~{3,})/.exec(text.slice(i, i + 80))
      if (m) { if (!fence) fence = m[2]; else if (m[2][0] === fence[0] && m[2].length >= fence.length) fence = ''; i = text.indexOf('\n', i); if (i < 0) break; continue }
    }
    if (fence) continue
    if (text[i] === '\\') { i++; continue }
    if (text[i] === '`') { let n = 1; while (text[i + n] === '`') n++; if (!inline) inline = n; else if (inline === n) inline = 0; i += n - 1; continue }
    if (inline) continue
    if (text.startsWith('<!--', i)) { const end = text.indexOf('-->', i + 4); if (end < 0) break; i = end + 2; continue }
    if (text[i] !== '[' || text[i - 1] === '!') continue
    const close = text.indexOf(']', i + 1)
    if (close < 0 || close - i > 250 || text[close + 1] !== '(') continue
    const label = text.slice(i + 1, close)
    if (label.includes('[') || label.includes('\n')) continue
    let j = close + 2, target = '', valid = false
    if (text[j] === '<') {
      const end = text.indexOf('>', j + 1)
      if (end >= 0 && text[end + 1] === ')' && !text.slice(j + 1, end).includes('\n')) { target = text.slice(j + 1, end); j = end + 2; valid = true }
    } else {
      const start = j; let depth = 1
      while (j < text.length && j - start <= 4096) {
        if (text[j] === '\n') break
        if (text[j] === '(') depth++
        if (text[j] === ')' && --depth === 0) { target = text.slice(start, j); j++; valid = true; break }
        j++
      }
    }
    if (!valid || !target || target.length > 4096 || /[\u0000-\u001f\u007f]/.test(target)) continue
    const titled = /^(\S+)\s+"[^"]*"$/.exec(target)
    if (titled) target = titled[1]
    out.push({ label, target, start: i, end: j }); i = j - 1
  }
  return out
}

/** A target that names a local file: a path, `~/...` or `file://`. Web URLs, mail, anchors and network paths are not. */
export function isLocalTarget(target: string): boolean {
  if (!target || target.startsWith('#') || target.startsWith('//') || target.includes('\\')) return false
  if (/^file:\/\//i.test(target)) return true
  // `server.ts:42` is a path with a line, not a scheme.
  return !/^[a-z][a-z0-9+.-]*:/i.test(splitLineAnchor(target).path)
}

/** `x.ts:42`, `x.ts:42:7`, `x.ts:42-50`, `x.ts#L42`, `x.ts#L42-L50` → the path and line 42. */
export function splitLineAnchor(target: string): { path: string; line?: number } {
  let m = /^(.*?)#L(\d{1,7})(?:C\d+)?(?:-L?\d{1,7})?$/.exec(target)
  if (m && m[1]) return { path: m[1], line: Number(m[2]) || undefined }
  m = /^(.*?):(\d{1,7})(?::\d{1,5}|-\d{1,7})?$/.exec(target)
  if (m && m[1] && !/:$/.test(m[1])) return { path: m[1], line: Number(m[2]) || undefined }
  const hash = target.indexOf('#')
  return { path: hash > 0 ? target.slice(0, hash) : target }
}

export interface LinkRoots {
  /** The session's canonical workspace, or null (broad or unknown). */
  workspace: string | null
  /** Canonical Settings extra folders. */
  extra: readonly string[]
  home: string
}
export type Resolved =
  | { state: 'available'; path: string; root: string; name: string; isDir: boolean; size?: number }
  | { state: 'unavailable'; reason: LinkReason; name: string }

export function insideRoot(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}
/** The allowed root holding a canonical path, or null. */
export function authorizedRoot(path: string, roots: LinkRoots): string | null {
  if (roots.workspace && insideRoot(roots.workspace, path)) return roots.workspace
  for (const r of roots.extra) if (insideRoot(r, path)) return r
  return null
}

function expandTarget(target: string, home: string): string | null {
  if (/^file:\/\//i.test(target)) { try { return fileURLToPath(target) } catch { return null } }
  if (target === '~') return home
  if (target.startsWith('~/')) return join(home, target.slice(2))
  return target
}

/**
 * Where a link points, and whether COS may show it. Bases: the row's cwd, then the workspace root. A relative link
 * that exists under neither is missing (when it would sit inside an allowed root) or outside. The canonical file
 * decides containment, so a link out of the root is outside. A denied secret name is refused before any read, by its
 * written name and by its canonical name.
 */
export function resolveLinkTarget(rawTarget: string, bases: readonly (string | null | undefined)[], roots: LinkRoots): Resolved {
  const { path: written } = splitLineAnchor(rawTarget)
  const variants = [written]
  if (/%[0-9a-f]{2}/i.test(written)) { try { const d = decodeURIComponent(written); if (d !== written) variants.push(d) } catch { /* keep as written */ } }
  // A percent-encoded name reads as its words ("Q3 plan.md", not "Q3%20plan.md").
  const name = baseName(variants[variants.length - 1])
  const lexicals: string[] = []
  for (const v of variants) {
    const expanded = expandTarget(v, roots.home)
    if (!expanded) continue
    if (isAbsolute(expanded)) lexicals.push(resolve(expanded))
    else for (const b of bases) if (b && isAbsolute(b)) lexicals.push(resolve(b, expanded))
  }
  if (!lexicals.length) return { state: 'unavailable', reason: 'outside_workspace', name }
  if (lexicals.some(p => isDeniedSecretPath(p))) return { state: 'unavailable', reason: 'secret_file', name }
  for (const lexical of lexicals) {
    let canonical: string
    try { canonical = realpathSync(lexical) } catch { continue }
    const root = authorizedRoot(canonical, roots)
    if (!root) return { state: 'unavailable', reason: 'outside_workspace', name }
    if (isDeniedSecretPath(canonical)) return { state: 'unavailable', reason: 'secret_file', name }
    try {
      const st = statSync(canonical)
      if (st.isDirectory()) return { state: 'available', path: canonical, root, name, isDir: true }
      if (!st.isFile()) return { state: 'unavailable', reason: 'missing', name }
      return { state: 'available', path: canonical, root, name, isDir: false, size: st.size }
    } catch { return { state: 'unavailable', reason: 'missing', name } }
  }
  // Nothing there. Say missing only for a path that would be inside an allowed root (by its real parent folder).
  const wouldBeInside = lexicals.some(p => {
    if (authorizedRoot(p, roots)) return true
    try { return authorizedRoot(join(realpathSync(resolve(p, '..')), baseName(p)), roots) !== null } catch { return false }
  })
  return { state: 'unavailable', reason: wouldBeInside ? 'missing' : 'outside_workspace', name }
}

/** Text with every card marker turned back into its words. Used when previews are off. Pure. */
export function withoutLinkMarkers(text: string): string {
  return text.replace(LINK_MARKER, '$1')
}
