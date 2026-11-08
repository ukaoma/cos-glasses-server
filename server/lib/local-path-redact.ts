// No absolute Mac path reaches the browser through a session's words (7.0.4 S1).
//
// WHY. A reply is sent as the agent wrote it, and agents link the files they touched with full
// paths: `[app.ts](/Users/<name>/repo/server/app.ts#L42)`, Codex's `[app.ts](/abs/app.ts:42)`, a
// bare `~/Documents/...`, a path in backticks. A read-only scan of 14 days of transcripts found 111
// Claude links and 826 Codex links carrying `/Users/...` into Control Web. The path names the
// person, their folders and their projects, and the browser has no use for it: it cannot open it.
//
// WHAT. Every private local path in a string becomes its base name, keeping a line anchor
// (`app.ts:42`, from `:42` or `#L42`). A Markdown link to a local file becomes its words (or the
// base name when it has none). Web URLs are untouched; relative paths stay as written; a site path
// such as `/api/x` is not a Mac path and stays too. `redactLocalPathsDeep` applies this to every
// string in a JSON value, so a field added to the session detail later is covered without a list.
//
// WHAT COUNTS AS LOCAL (narrowed in 7.0.4 B1). Only places that name this Mac's people and data:
// a path under `/Users/<name>`, `/Volumes/<name>`, `/private/...` (where /var and /tmp really
// live) or `/var/folders/...` (per-user temp), a home shorthand (`~/`, `~name/` with a letter
// first, `$HOME/`, `${HOME}/`), a `file://` URL, or an editor URL that opens a file
// (`vscode://file/...`). The `.cos-glasses` data folder lives under the home folder, so it is
// covered. Everything else is ordinary text and stays exactly as written: `/dev/null`,
// `/usr/bin/env`, `/tmp/out`, `/opt/homebrew`, `/home`, `/run/start`, `~80/100`, `~1/3`, `A/B`,
// dates and fractions. The first cut treated every Unix top-level folder as private and `~<digit>`
// as home, and rewrote prose: "Pacing ~80/100 leads" read "Pacing 100 leads", "#!/usr/bin/env
// node" read "#!env node".
//
// SPACES. A folder name with spaces (`/Users/x/Ukaoma Chief Of Staff/MU-Chief-Staff/CLAUDE.md`)
// is followed across capitalised words, but only when the continuation ends at a real file
// extension or a `/`. A continuation that ends anywhere else ("/Users/x/out Next Steps: Review
// A/B results") is not taken, so the words after a path are never eaten. Either way the private
// head (`/Users/<name>`) is removed.

/** Editor and file URL schemes whose target is a file on this Mac. */
const LOCAL_SCHEMES = ['file', 'vscode', 'vscode-insiders', 'cursor', 'windsurf', 'zed', 'idea', 'subl', 'txmt', 'mvim']

/** Delimiters a path never runs through (besides whitespace) in prose, Markdown and code. */
const DELIMS = `<>"'\`“”‘’|)\\]}*,;`
const STOP = `\\s${DELIMS}`
/** A root name in any letter case: APFS is case-insensitive, so `/USERS/jane` is the same folder as `/Users/jane`. */
function anyCase(word: string): string {
  return [...word].map(c => /[a-z]/i.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : c).join('')
}
const USERS = anyCase('Users')
/** A private root, followed by at least one more name: `/Users` alone, or "the /Users folder", is not a path. `//Users` counts. */
const PRIVATE_ROOT = `/+(?:${USERS}|${anyCase('Volumes')}|${anyCase('private')})(?=/[^${STOP}/])|/+${anyCase('var')}/${anyCase('folders')}(?=/)`
/** A home shorthand: `~/`, `~name/` (a letter first, so `~80/100` and `~1/3` stay numbers), `$HOME/`, `${HOME}/`. */
const HOME_SHORTHAND = `(?:~(?:[A-Za-z][A-Za-z0-9._-]*)?|\\$HOME|\\$\\{HOME\\})(?=/)`
const HEAD = `(?:${HOME_SHORTHAND}|${PRIVATE_ROOT})`
/** A bare path follows prose punctuation, never a path segment (including ./ or ../). Web spans are handled separately. */
const BARE = new RegExp(`(^|[^\\p{L}\\p{N}_./-])(${HEAD})([^${STOP}]*)`, 'gu')
const SCHEME_URL = new RegExp(`\\b(?:${LOCAL_SCHEMES.join('|')}):\\/\\/[^${STOP}]*`, 'gi')
/** Complete HTTP(S) tokens, including query/fragment paths. Keep their original bytes rather than reserializing a URL. */
const WEB_URL = /\bhttps?:\/\/[^\s<>"'`“”‘’]+/gi
/** `[words](destination)` and `![words](destination)`, the destination angle-wrapped or not (spaces allowed). */
const LINK = /(!?)\[([^\]\n]{0,500})\]\(\s*(<[^>\n]{1,4096}>|[^\s()<>\n][^)\n]{0,4096}?)\s*\)/g
const LOCAL_DEST = new RegExp(`^(?:${HEAD})`)
const LOCAL_SCHEME_DEST = new RegExp(`^(?:${LOCAL_SCHEMES.join('|')}):\\/\\/`, 'i')
/** One word of a folder name with spaces: capitalised or a number, no colon, and not ending a sentence. */
const SPACED_WORD = `[A-Z0-9](?:[^\\s/:${DELIMS}]*[^\\s/:.!?${DELIMS}])?`
/** One more space-separated folder name, while the words are capitalised and lead to another `/`. */
const SPACED_TAIL = new RegExp(`^( (?:${SPACED_WORD} ){0,4}${SPACED_WORD}/[^${STOP}]*)`)
/** A real file extension (with a letter in it, so `v1.2` and `10.15` are not), plus any `:line` anchors. */
const HAS_EXTENSION = /\.(?=[A-Za-z0-9]{0,9}[A-Za-z])[A-Za-z0-9]{1,10}(?::\d+)*$/
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
  const plain = decoded(value)
  // The home folder itself names the person: it reads `~`, never its base name.
  if (/^\/+users\/[^/]+\/?$/i.test(plain)) return '~' + anchor
  const parts = plain.split('/').filter(Boolean)
  const last = parts.pop() || '~'
  return /:\d+$/.test(last) ? last : last + anchor
}

/** A path that may be carried across spaces: it ends at a real file extension or at a folder separator. */
function endsAtFileOrFolder(path: string): boolean {
  const core = path.replace(TRAILING_PUNCTUATION, '')
  return core.endsWith('/') || HAS_EXTENSION.test(core)
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
    // A folder name with spaces is followed only when the continuation ends at a file extension or a `/`.
    // A path that already ends that way, or that ends a sentence, is never extended.
    if (!endsAtFileOrFolder(path) && !TRAILING_PUNCTUATION.test(path)) {
      let probe = path
      let probeEnd = end
      for (let guard = 0; guard < 8; guard++) {
        const tail = SPACED_TAIL.exec(text.slice(probeEnd))
        if (!tail) break
        probe += tail[1]
        probeEnd += tail[1].length
        if (endsAtFileOrFolder(probe)) { path = probe; end = probeEnd; break }
        if (TRAILING_PUNCTUATION.test(probe)) break
      }
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
    pieces.push(redact(text.slice(cursor, match.index)), hideHomeInUrl(token))
    cursor = match.index + token.length
    WEB_URL.lastIndex = cursor
  }
  pieces.push(redact(text.slice(cursor)))
  return pieces.join('')
}

/**
 * `/Users/<name>` (any letter case, any number of leading slashes). In code spans, code blocks and command fields it
 * reads as the visible marker `[home]`, keeping the rest of the path, so a reader sees where the path was and that it
 * was changed. The result is a display, not a runnable command: `~` was not used because a quoted `'~/x'` does not
 * expand, so it would read as exact while meaning something else. In a web URL's query it reads `~`, which keeps the
 * URL well formed. `/Users/Shared` is not a person's home and stays.
 */
const HOME_FOLDER = new RegExp(`(^|[^\\p{L}\\p{N}_.-])/+${USERS}/(?!Shared(?:/|$|[${STOP}]))[^${STOP}/&?#=]+`, 'gu')
/** The same inside a URL query, percent-encoded: `%2FUsers%2Fjane` is `~`. */
const ENCODED_HOME_FOLDER = /(?:%2F)+users%2F(?!shared(?:%2F|[&#\s]|$))[^%&?#=\s/]+/gi
/** What a hidden home folder reads as in code and commands. */
export const HOME_MARKER = '[home]'

/** Every `/Users/<name>` in this text as the visible `[home]` marker; nothing else changes. */
export function markHomeFolder(text: string): string {
  if (typeof text !== 'string' || !text) return text
  return text.replace(HOME_FOLDER, (_match, before: string) => before + HOME_MARKER)
}

/** A web URL exactly as written, except a home folder in its query or fragment (`?path=/Users/jane/a.pdf`). */
function hideHomeInUrl(url: string): string {
  const at = url.search(/[?#]/)
  if (at < 0) return url
  return url.slice(0, at) + url.slice(at).replace(HOME_FOLDER, (_match, before: string) => before + '~').replace(ENCODED_HOME_FOLDER, '~')
}

/**
 * Code in Markdown: fenced blocks (``` or ~~~, closed by a fence of the same kind at least as long, or by the end of the
 * text) and inline code spans (a run of backticks closed by a run of the same length, within one paragraph).
 */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let open: { start: number; mark: string; length: number } | null = null
  for (let pos = 0; pos <= text.length;) {
    const newline = text.indexOf('\n', pos)
    const end = newline < 0 ? text.length : newline
    const line = text.slice(pos, end)
    if (!open) {
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (fence && !(fence[1][0] === '`' && line.slice(fence[0].length).includes('`'))) open = { start: pos, mark: fence[1][0]!, length: fence[1].length }
    } else {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (close && close[1][0] === open.mark && close[1].length >= open.length) { ranges.push([open.start, end]); open = null }
    }
    if (newline < 0) break
    pos = newline + 1
  }
  if (open) ranges.push([open.start, text.length])
  const inFence = (at: number) => ranges.some(([s, e]) => at >= s && at < e)
  const INLINE = /(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g
  const spans: Array<[number, number]> = []
  for (let m = INLINE.exec(text); m; m = INLINE.exec(text)) {
    if (inFence(m.index)) { INLINE.lastIndex = m.index + 1; continue }
    if (/\n[ \t]*\n/.test(m[2]!)) { INLINE.lastIndex = m.index + m[1]!.length; continue }
    spans.push([m.index, m.index + m[0].length])
  }
  return [...ranges, ...spans].sort((x, y) => x[0] - y[0])
}

/**
 * Every private local path in this text. In prose a path becomes its base name (Markdown links to a local file become
 * their words). In code spans and code blocks the path is kept and only the home folder is replaced, by the visible
 * `[home]` marker: the code is then a display of the command, not the command. Web URLs are untouched except a home folder in their query; relative paths, site
 * paths and system paths (`/dev/null`, `/usr/bin/env`, `/tmp/x`) stay as written.
 */
export function redactLocalPaths(text: string): string {
  if (typeof text !== 'string' || !text) return text
  const before = codeRanges(text)
  const inCode = (at: number) => before.some(([s, e]) => at >= s && at < e)
  const linked = text.replace(LINK, (match: string, _bang: string, words: string, rawDest: string, offset: number) => {
    if (inCode(offset)) return match // a link written inside code is code
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
  const pieces: string[] = []
  let cursor = 0
  for (const [start, end] of codeRanges(linked)) {
    if (start < cursor) continue
    pieces.push(redactOutsideWebURLs(linked.slice(cursor, start)), markHomeFolder(linked.slice(start, end)))
    cursor = end
  }
  pieces.push(redactOutsideWebURLs(linked.slice(cursor)))
  return pieces.join('')
}

/**
 * Fields whose words are a command or a reason (a waiting permission's command, a failure): the path is kept and only
 * the home folder reads `[home]`, so `rm -rf /Users/<name>/Documents` reads `rm -rf [home]/Documents`, never the
 * harmless-looking `rm -rf Documents`. Control Web labels that line as a display. The exact command is on the approval
 * card (`/api/session-questions`), which is not redacted.
 */
export const COMMAND_KEYS: ReadonlySet<string> = new Set(['waiting_detail', 'failure'])

/** A copy of this JSON value with every string redacted (keys are left alone). Command fields keep their paths. */
export function redactLocalPathsDeep<T>(value: T): T {
  const walk = (item: unknown, command: boolean): unknown => {
    if (typeof item === 'string') return command ? markHomeFolder(item) : redactLocalPaths(item)
    if (Array.isArray(item)) return item.map(entry => walk(entry, command))
    if (item && typeof item === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(item as Record<string, unknown>)) out[key] = walk(entry, command || COMMAND_KEYS.has(key))
      return out
    }
    return item
  }
  return walk(value, false) as T
}
