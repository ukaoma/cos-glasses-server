/**
 * 7.0.55 COS route links (Miles 2026-11-17 08:29, "When I ask for link to the live call ... give the direct link";
 * X1's scope, the lead's 08:3x). A COS answer points at a COS page with a NAMED route, never a URL:
 *
 *   [Open the live meeting](cos-route:meetings/live/<meeting id>)
 *
 * The COS thread is one thread read on the Mac, the Duo and the phone, so no typed URL is right for every reader:
 * 127.0.0.1 is the phone itself, and another origin needs another sign-in. Each surface turns the route into its own
 * navigation (Control Web: `#/meetings/live/<id>` in the same tab; the Mac: its own live view). Pure; no I/O.
 *
 * `projectCosRouteLinks` is applied when the thread is READ, so a reply stored with a raw self-URL renders right too:
 *   - a link or bare URL that is this server's own `/control#/<allowlisted route>` becomes the route token;
 *   - any other link to this server (another page, a query, a credential) loses its address: only its words stay;
 *   - any link whose address carries something credential-shaped loses its address too, whatever the host;
 *   - a `cos-route:` token with a route outside the allowlist becomes its words; a valid one gets the fixed label;
 *   - code spans and fences are never touched, and nothing else in the text changes.
 * The allowlist holds VIEW routes only. A route never acts (send, approve, delete, settings) and never opens by itself.
 */

/** The one route in v1 and its id: the server's own meeting id form (ask-session-id.ts ASK_SESSION, meeting_). */
export const COS_ROUTE_RE = /^meetings\/live\/(meeting_[A-Za-z0-9_-]{1,89})$/
/** The fixed words of a route link. The model's own label is never shown, so a link cannot say one thing and go to another. */
export const COS_ROUTE_LABEL = 'Open the live meeting'
export const COS_ROUTE_SCHEME = 'cos-route:'

export interface CosRoute { kind: 'live-meeting'; id: string }

/** The route a `cos-route:` target names, or null when it is not on the allowlist. */
export function parseCosRoute(route: string): CosRoute | null {
  const m = COS_ROUTE_RE.exec(route)
  return m ? { kind: 'live-meeting', id: m[1]! } : null
}

/** The token for a live meeting, or null for an id that is not a meeting id. */
export function cosRouteToken(meetingId: string): string | null {
  const route = `meetings/live/${meetingId}`
  return parseCosRoute(route) ? `[${COS_ROUTE_LABEL}](${COS_ROUTE_SCHEME}${route})` : null
}

/** This server, as a reader could have reached it: host names and IPs (lower case, IPv6 bracketed) and ports. */
export interface SelfHosts { hosts: ReadonlySet<string>; ports: ReadonlySet<string> }

/** Query or fragment parameter names that carry a credential, as a whole name, any case. */
const CREDENTIAL_NAME = /^(?:token|access[_-]?token|id[_-]?token|auth|authorization|code|pair|pairing|pairing[_-]?code|key|api[_-]?key|secret|password|passwd|pass|sig|signature|session|sid|cookie|otp|pin)$/i
/** How many rounds of percent-decoding a name may need (double-encoded is two). More than this is refused. */
const NAME_DECODE_ROUNDS = 4

/**
 * A parameter name as a reader's browser or server would finally read it: percent-decoded until it stops changing
 * (`%74oken` and `%2574oken` are both `token`), `+` as a space. Null when it cannot be decoded, or is still changing
 * after NAME_DECODE_ROUNDS: such a name counts as credential-shaped (Codex's review of 97df1489, the lead's 11:4x).
 */
function decodedName(raw: string): string | null {
  let name = raw.replace(/\+/g, ' ')
  for (let i = 0; i < NAME_DECODE_ROUNDS; i++) {
    let next: string
    try { next = decodeURIComponent(name) } catch { return null }
    if (next === name) return name.trim()
    name = next
  }
  return null
}

/**
 * Does the query or the fragment name a credential? Every `name=` segment, split at ? & ; # and /, is decoded before
 * it is compared, so an encoded or mixed-case name cannot slip past. User info in the address counts too.
 */
function credentialShaped(u: URL): boolean {
  if (u.username || u.password) return true
  for (const part of [u.search, u.hash]) {
    for (const segment of part.split(/[?&;#/]/)) {
      const eq = segment.indexOf('=')
      if (eq < 0) continue
      const name = decodedName(segment.slice(0, eq))
      if (name === null || CREDENTIAL_NAME.test(name)) return true
    }
  }
  return false
}

function isSelf(u: URL, self: SelfHosts): boolean {
  return self.hosts.has(u.hostname.toLowerCase().replace(/\.$/, '')) && self.ports.has(u.port)
}

/** The route a self-URL names: `/control` (or `/control/`), no query, and a `#/<route>` on the allowlist. */
function selfRoute(u: URL): CosRoute | null {
  if (u.pathname !== '/control' && u.pathname !== '/control/') return null
  if (u.search !== '' || !u.hash.startsWith('#/')) return null
  return parseCosRoute(u.hash.slice(2))
}

function parseHttp(raw: string): URL | null {
  if (!/^https?:\/\//i.test(raw)) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch { return null }
}

const tokenFor = (r: CosRoute) => `[${COS_ROUTE_LABEL}](${COS_ROUTE_SCHEME}meetings/live/${r.id})`

/**
 * A Markdown link, or a bare http(s) URL. A bare URL stops at whitespace, quotes, angle brackets, backticks and
 * brackets (a bracketed IPv6 host right after `//` is allowed); trailing sentence punctuation is given back to the sentence.
 */
const LINK_OR_URL = /\[([^\]\n]+)\]\(([^\s)]+)\)|(https?:\/\/(?:\[[0-9A-Fa-f:.]+\])?[^\s<>"'`[\]()]*)/g
const TRAILING_PUNCT = /[.,;:!?]+$/

function projectPlain(text: string, self: SelfHosts): string {
  return text.replace(LINK_OR_URL, (whole: string, label: string | undefined, target: string | undefined, bare: string | undefined) => {
    if (label !== undefined && target !== undefined) {
      if (target.startsWith(COS_ROUTE_SCHEME)) {
        const r = parseCosRoute(target.slice(COS_ROUTE_SCHEME.length))
        return r ? tokenFor(r) : label
      }
      const u = parseHttp(target)
      if (!u) return whole
      if (isSelf(u, self)) {
        const r = credentialShaped(u) ? null : selfRoute(u)
        return r ? tokenFor(r) : label
      }
      return credentialShaped(u) ? label : whole
    }
    const raw = bare!
    const tail = TRAILING_PUNCT.exec(raw)?.[0] ?? ''
    const url = tail ? raw.slice(0, raw.length - tail.length) : raw
    const u = parseHttp(url)
    if (!u || !isSelf(u, self) || credentialShaped(u)) return whole
    const r = selfRoute(u)
    return r ? tokenFor(r) + tail : whole
  })
}

/** Fences (``` or ~~~ on their own line, to the closing fence or the end) and inline code spans: kept verbatim. */
const CODE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)|`[^`\n]+`/g

/** The text with this server's own page links as route tokens, and addresses that should not be links taken out. */
export function projectCosRouteLinks(text: string, self: SelfHosts): string {
  if (typeof text !== 'string' || !text) return text
  if (!text.includes('http') && !text.includes(COS_ROUTE_SCHEME)) return text
  let out = ''
  let last = 0
  for (const m of text.matchAll(CODE)) {
    const at = m.index ?? 0
    out += projectPlain(text.slice(last, at), self) + m[0]
    last = at + m[0].length
  }
  return out + projectPlain(text.slice(last), self)
}

/**
 * The prompt line for a COS thread conversation (the Mac, Control Web): how to point at a COS page. Never on the
 * glasses (plain text, nothing to tap). Kept here so the token and the instruction cannot drift apart.
 */
export const COS_ROUTE_PROMPT_LINE = `COS PAGE LINKS: To point the user at a live meeting in COS, write exactly [${COS_ROUTE_LABEL}](${COS_ROUTE_SCHEME}meetings/live/<meeting id>) as plain text, never inside code, the meeting id being its meeting_... session id. Each COS app opens it in place. Never write a 127.0.0.1, localhost, IP address or ts.net address for a COS page, and never put a token or sign-in code in any link.`

/** The prompt line for this conversation: only a COS thread conversation gets it. */
export function cosRoutePromptLine(session: { cosThread?: true } | null | undefined): string {
  return session?.cosThread === true ? `\n\n${COS_ROUTE_PROMPT_LINE}` : ''
}
