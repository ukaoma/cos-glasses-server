// No absolute Mac path reaches the browser through a session's words (7.0.4 S1).
//
// WHY. A reply is sent as the agent wrote it, and agents link the files they touched with full
// paths: `[app.ts](/Users/<name>/repo/server/app.ts#L42)`, Codex's `[app.ts](/abs/app.ts:42)`, a
// bare `~/Documents/...`, a path in backticks. A read-only scan of 14 days of transcripts found 111
// Claude links and 826 Codex links carrying `/Users/...` into Control Web. The path names the
// person, their folders and their projects, and the browser has no use for it: it cannot open it.
//
// WHAT. Every absolute local path in a string becomes its base name, keeping a line anchor
// (`app.ts:42`, from `:42` or `#L42`). A Markdown link to a local file becomes its words (or the
// base name when it has none). Web URLs are untouched; relative paths stay as written; a site path
// such as `/api/x` is not a Mac path and stays too. `redactLocalPathsDeep` applies this to every
// string in a JSON value, so a field added to the session detail later is covered without a list.
//
// WHAT COUNTS AS LOCAL. A path starting at a macOS/Unix top-level directory (`/Users`, `/Volumes`,
// `/private`, `/var`, `/tmp`, ...), a home shorthand (`~/`, `~name/`, `$HOME/`, `${HOME}/`), a
// `file://` URL, or an editor URL that opens a file (`vscode://file/...`). Folder names with
// spaces are followed while the next words are capitalised and reach another `/`
// (`/Users/x/Ukaoma Chief Of Staff/MU-Chief-Staff/CLAUDE.md` is one path).

/** Top-level directories that begin an absolute local path. Case-sensitive, as written by tools. */
const ROOTS = ['Users', 'Volumes', 'private', 'var', 'tmp', 'opt', 'Applications', 'Library', 'System', 'usr', 'etc', 'home', 'bin', 'sbin', 'dev', 'cores', 'Network', 'nix', 'mnt', 'root', 'srv', 'proc', 'run', 'snap']
/** Editor and file URL schemes whose target is a file on this Mac. */
const LOCAL_SCHEMES = ['file', 'vscode', 'vscode-insiders', 'cursor', 'windsurf', 'zed', 'idea', 'subl', 'txmt', 'mvim']

/** Delimiters a path never runs through (besides whitespace) in prose, Markdown and code. */
const DELIMS = `<>"'\`“”‘’|)\\]}*,;`
const STOP = `\\s${DELIMS}`
const HEAD = `(?:~[A-Za-z0-9._-]*|\\$HOME|\\$\\{HOME\\})(?=/)|/(?:${ROOTS.join('|')})(?![A-Za-z0-9_.-])`
/** A bare path follows prose punctuation, never a path segment (including ./ or ../). Web spans are handled separately. */
const BARE = new RegExp(`(^|[^\\p{L}\\p{N}_./-])(${HEAD})([^${STOP}]*)`, 'gu')
const SCHEME_URL = new RegExp(`\\b(?:${LOCAL_SCHEMES.join('|')}):\\/\\/[^${STOP}]*`, 'gi')
/** Complete HTTP(S) tokens, including query/fragment paths. Keep their original bytes rather than reserializing a URL. */
const WEB_URL = /\bhttps?:\/\/[^\s<>"'`“”‘’]+/gi
/** `[words](destination)` and `![words](destination)`, the destination angle-wrapped or not (spaces allowed). */
const LINK = /(!?)\[([^\]\n]{0,500})\]\(\s*(<[^>\n]{1,4096}>|[^\s()<>\n][^)\n]{0,4096}?)\s*\)/g
const LOCAL_DEST = new RegExp(`^(?:${HEAD})`)
const LOCAL_SCHEME_DEST = new RegExp(`^(?:${LOCAL_SCHEMES.join('|')}):\\/\\/`, 'i')
/** One more space-separated folder name, while the words are capitalised and lead to another `/`. */
const SPACED_TAIL = new RegExp(`^( (?:[A-Z0-9][^\\s/${DELIMS}]* ){0,4}[A-Z0-9][^\\s/${DELIMS}]*/[^${STOP}]*)`)
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,10}(?::\d+)*$/
const TRAILING_PUNCTUATION = /[.:!?]+$/

function decoded(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

/** The base name of a path, with any line anchor it carries (`:42`, or `#L42` turned into `:42`). */
function baseName(path: string): string {
  let value = path
  let anchor = ''
  const hash = value.indexOf('#')
  if (hash >= 0) {
    const line = /^L(\d+)/i.exec(value.slice(hash + 1))
    if (line) anchor = ':' + line[1]
    value = value.slice(0, hash)
  }
  const query = value.indexOf('?')
  if (query >= 0) value = value.slice(0, query)
  const parts = decoded(value).split('/').filter(Boolean)
  const last = parts.pop() || '~'
  return /:\d+$/.test(last) ? last : last + anchor
}

function redactBare(text: string): string {
  // Find the matches and their spaced tails first, then rebuild the string once.
  const pieces: string[] = []
  let cursor = 0
  BARE.lastIndex = 0
  for (let m = BARE.exec(text); m; m = BARE.exec(text)) {
    const [match, before, head, body] = m
    const start = m.index
    if (start < cursor) continue
    let path = head + body
    let end = start + match.length
    for (let guard = 0; guard < 8 && !HAS_EXTENSION.test(path); guard++) {
      const tail = SPACED_TAIL.exec(text.slice(end))
      if (!tail) break
      path += tail[1]
      end += tail[1].length
    }
    const punctuation = TRAILING_PUNCTUATION.exec(path)?.[0] ?? ''
    const core = punctuation ? path.slice(0, -punctuation.length) : path
    pieces.push(text.slice(cursor, start), before, baseName(core), punctuation)
    cursor = end
    BARE.lastIndex = Math.max(end, start + 1)
  }
  pieces.push(text.slice(cursor))
  return pieces.join('')
}

/** URL query values can look exactly like local paths; redact only the text between whole web tokens. */
function redactOutsideWebURLs(text: string): string {
  const redact = (part: string) => redactBare(part.replace(SCHEME_URL,
    url => baseName(url.replace(LOCAL_SCHEME_DEST, '').replace(/^[^/]*\//, '/'))))
  const pieces: string[] = []
  let cursor = 0
  WEB_URL.lastIndex = 0
  for (let match = WEB_URL.exec(text); match; match = WEB_URL.exec(text)) {
    let token = match[0]
    // A prose/Markdown closing parenthesis ends the token; balanced URL path
    // parentheses remain part of it. Explicit angle/quote wrapping supplies its own end.
    if (!/[<"'`“‘]/.test(text[match.index - 1] ?? '')) {
      let depth = 0
      for (let i = 0; i < token.length; i++) {
        if (token[i] === '(') depth++
        else if (token[i] === ')' && depth-- === 0) { token = token.slice(0, i); break }
      }
    }
    try { new URL(token) } catch { continue }
    pieces.push(redact(text.slice(cursor, match.index)), token)
    cursor = match.index + token.length
    WEB_URL.lastIndex = cursor
  }
  pieces.push(redact(text.slice(cursor)))
  return pieces.join('')
}

/** Every absolute local path in this text, as its base name. Web URLs and relative paths are untouched. */
export function redactLocalPaths(text: string): string {
  if (typeof text !== 'string' || !text) return text
  let out = text.replace(LINK, (match, _bang: string, words: string, rawDest: string) => {
    const dest = rawDest.startsWith('<') ? rawDest.slice(1, -1).trim() : rawDest.trim()
    let target: string | null = null
    if (LOCAL_SCHEME_DEST.test(dest)) target = dest.replace(LOCAL_SCHEME_DEST, '').replace(/^[^/]*\//, '/')
    else if (LOCAL_DEST.test(dest)) target = dest
    if (target === null) return match // a web URL, a relative path or a site path: left exactly as written
    const name = baseName(target)
    const label = words.trim()
    if (!label) return name
    // `[app.ts](/abs/app.ts#L42)` keeps its line: the words named the file, the anchor was in the link.
    const anchor = /:\d+$/.exec(name)?.[0] ?? ''
    return anchor && !/:\d+$/.test(label) && label.split('/').pop() === name.slice(0, -anchor.length) ? label + anchor : label
  })
  return redactOutsideWebURLs(out)
}

/** A copy of this JSON value with every string redacted (keys are left alone). */
export function redactLocalPathsDeep<T>(value: T): T {
  if (typeof value === 'string') return redactLocalPaths(value) as T
  if (Array.isArray(value)) return value.map(item => redactLocalPathsDeep(item)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = redactLocalPathsDeep(item)
    return out as T
  }
  return value
}
