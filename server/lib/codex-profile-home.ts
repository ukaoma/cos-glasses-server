// Key lanes K1 P4 (plan v4 8.1, D9): the generated Codex home a keyed (Lane B) Codex turn runs in.
//
// A keyed Codex turn never runs in the user's `~/.codex`. Canary C2d (2026-10-19): even with
// `-c` overrides on the real home, Codex rewrote `auth.json` (a ChatGPT token refresh) during a
// key run. So each profile gets `data/codex-homes/<id>/` (0700), regenerated before every turn:
//
//   config.toml  the loopback relay as the ONLY provider (`wire_api = "responses"`, C2a/C2b; the
//                chat wire is refused at config load), retries 2, plus these tables copied
//                read-only from the server home's config: `[mcp_servers.*]` (D9), `[projects.*]`
//                (folder trust, so project hooks and config load as they do on Lane A),
//                `[shell_environment_policy*]`, `[sandbox_workspace_write]`, and the hook trust
//                entries that still describe the hooks written here.
//   hooks.json   the COS hook blocks, from the installer's own writer, for exactly the events the
//                user's `~/.codex/hooks.json` carries ours for (mirror, never more).
//   auth.json    NEVER. One found there is removed before the turn: the key reaches Codex only as
//                a turn nonce in `COS_RELAY_TOKEN`, and the real key only ever lives in the relay.
//
// The user's `~/.codex` is read, never written. HARD RULE: nothing here runs unless a caller has
// a key profile in hand; importing this module reads no file, opens no socket and starts no timer.
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from './atomic-fs.js'
import { currentHookPaths, type HookPaths } from './claude-hooks-installer.js'
import { codexSubscribedEvents, mergeCodexHooks, stableCodexHookScriptPath } from './codex-hooks-installer.js'
import { codexProfileHome, codexProfileHomesRoot, serverCodexHome } from './codex-homes.js'
import { CODEX_KEYED_STEER_NOTICE } from './codex-live-queue.js'
import { keyLanesActive } from './key-lanes.js'
import { KEY_LANE_REFUSAL_COPY } from './key-notices.js'
import { isLaneBStrippedName, LANE_B_STRIPPED_NAMES } from './lane-b-env.js'
import { engineModelProblem } from './key-profiles.js'
import { KEY_LANE_CHILD_ENV, RELAY_BASE_PATHS } from './key-relay-contract.js'
import type { KeyKind, KeyProfile, KeyRelay } from './key-relay-contract.js'
import { getPublicKey } from './key-store.js'

/** The provider id the generated config defines and argv selects. */
export const CODEX_RELAY_PROVIDER_ID = 'cos-relay'
/** Plan 4.6: the child retries a 429 or 5xx twice; the relay never retries itself. R15 checks the names. */
export const CODEX_RELAY_RETRIES = 2
/** Top-level config tables copied from the server home (first key segment). */
export const CODEX_COPIED_TABLES: readonly string[] = ['mcp_servers', 'projects', 'shell_environment_policy', 'sandbox_workspace_write']

/** Call options a keyed Codex turn adds. Same field name and type P3 adds to CallOptions. */
export interface CodexKeyLaneCallOptions {
  keyProfile?: KeyProfile
}

// ── Child environment (plan 7.2 base, 8.1 additions) ────────────────────────

/**
 * Provider-credential names a Lane B child never inherits: P3's one list (lane-b-env.ts, deduped by
 * P11), plus `CODEX_HOME`, which the profile home replaces. Every other name is kept.
 */
export const CODEX_LANE_B_STRIPPED_NAMES: readonly string[] = [...LANE_B_STRIPPED_NAMES, 'CODEX_HOME']

export function isCodexLaneBStrippedName(name: string): boolean {
  return name === 'CODEX_HOME' || isLaneBStrippedName(name)
}

/** The names applyCodexLaneBEnv sets. With the stripped names this is the whole A-vs-B difference. */
export const CODEX_LANE_B_ADDED_NAMES: readonly string[] = [
  'CODEX_HOME',
  KEY_LANE_CHILD_ENV.codexToken,
  KEY_LANE_CHILD_ENV.profileMarker,
]

/** Point a child env copy (never process.env) at the profile home and the relay nonce. */
export function applyCodexLaneBEnv(env: NodeJS.ProcessEnv, spec: { home: string; nonce: string; profileId: string }): void {
  if (env === process.env) throw new Error('codex-profile-home: refusing to write process.env')
  if (!spec.home || !spec.nonce || !spec.profileId) throw new Error('codex-profile-home: incomplete spec')
  for (const name of Object.keys(env)) {
    if (isCodexLaneBStrippedName(name)) delete env[name]
  }
  env.CODEX_HOME = spec.home
  env[KEY_LANE_CHILD_ENV.codexToken] = spec.nonce
  env[KEY_LANE_CHILD_ENV.profileMarker] = spec.profileId
}

// ── Seams (P2 relay, P3 keyed-session record). P11 wires both. ───────────────

type RelayResolver = () => KeyRelay | Promise<KeyRelay>
let relayResolver: RelayResolver | null = null

export function registerCodexKeyRelay(resolver: RelayResolver | null): void {
  relayResolver = resolver
}
export function codexKeyRelayRegistered(): boolean {
  return relayResolver !== null
}
export async function codexKeyRelay(): Promise<KeyRelay> {
  if (!relayResolver) throw new Error('codex-profile-home: no key relay registered')
  return await relayResolver()
}

export interface KeyedCodexThread {
  id: string
  engine: 'codex'
  profileId: string
  cosSessionId: string
}
type KeyedThreadRecorder = (thread: KeyedCodexThread) => void
let keyedThreadRecorder: KeyedThreadRecorder | null = null

/** Plan 7.3: P11 points this at P3's `recordKeyedSession`. */
export function registerCodexKeyedThreadRecorder(recorder: KeyedThreadRecorder | null): void {
  keyedThreadRecorder = recorder
}
export function recordKeyedCodexThread(thread: KeyedCodexThread): void {
  try { keyedThreadRecorder?.(thread) } catch (err) {
    console.error(`[codex-profile-home] keyed thread record failed: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`)
  }
}

/** Tests only. */
export function __resetCodexProfileSeamsForTests(): void {
  relayResolver = null
  keyedThreadRecorder = null
}

// ── Lens copy (plan 11.3). P8's key-notices.ts is the single source once merged. ─────────────

export const CODEX_LANE_B_COPY = {
  lanesOff: KEY_LANE_REFUSAL_COPY.lanesOff,
  profileOff: KEY_LANE_REFUSAL_COPY.profileOff,
  wrongEngine: KEY_LANE_REFUSAL_COPY.wrongEngineCodex,
  keyMissing: KEY_LANE_REFUSAL_COPY.keyMissing,
  modelNotAllowed: KEY_LANE_REFUSAL_COPY.codexModelNotAllowed,
  scheduled: KEY_LANE_REFUSAL_COPY.scheduled,
  relayUnavailable: KEY_LANE_REFUSAL_COPY.relayUnavailable,
  /** Plan 8.1: a keyed Codex session never joins the Codex app queue. */
  steerAfterTurn: CODEX_KEYED_STEER_NOTICE,
} as const

export type CodexProfilePreflight = { ok: true; keyKind: KeyKind } | { ok: false; message: string }

/** Everything a keyed Codex turn passes before history, the run ledger or a process. Fails closed. */
export function codexProfilePreflight(input: { profile: KeyProfile; dispatch: boolean }): CodexProfilePreflight {
  const { profile } = input
  if (!keyLanesActive()) return { ok: false, message: CODEX_LANE_B_COPY.lanesOff }
  if (profile.engine !== 'codex') return { ok: false, message: CODEX_LANE_B_COPY.wrongEngine(profile.label) }
  if (!profile.enabled) return { ok: false, message: CODEX_LANE_B_COPY.profileOff(profile.label) }
  if (input.dispatch) return { ok: false, message: CODEX_LANE_B_COPY.scheduled }
  const key = getPublicKey(profile.keyRef)
  if (!key) return { ok: false, message: CODEX_LANE_B_COPY.keyMissing(profile.label) }
  if (engineModelProblem('codex', profile.model, key.kind)) return { ok: false, message: CODEX_LANE_B_COPY.modelNotAllowed(profile.label) }
  if (!codexKeyRelayRegistered()) return { ok: false, message: CODEX_LANE_B_COPY.relayUnavailable }
  return { ok: true, keyKind: key.kind }
}

// ── TOML, just enough (the server has no TOML dependency) ───────────────────

const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/

/** A dotted table key (`a."b c".d`) to its segments, or null when it is not a key. */
export function parseTomlKeyPath(inner: string): string[] | null {
  const segs: string[] = []
  let i = 0
  const s = inner.trim()
  const skipWs = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++ }
  while (i < s.length) {
    skipWs()
    if (s[i] === '"') {
      let out = ''
      i++
      for (;;) {
        if (i >= s.length) return null
        const ch = s[i]
        if (ch === '"') { i++; break }
        if (ch === '\\') {
          const nx = s[i + 1]
          const map: Record<string, string> = { '"': '"', '\\': '\\', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }
          if (nx && nx in map) { out += map[nx]; i += 2; continue }
          if (nx === 'u' || nx === 'U') {
            const len = nx === 'u' ? 4 : 8
            const hex = s.slice(i + 2, i + 2 + len)
            if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) return null
            out += String.fromCodePoint(parseInt(hex, 16))
            i += 2 + len
            continue
          }
          return null
        }
        out += ch
        i++
      }
      segs.push(out)
    } else if (s[i] === "'") {
      const end = s.indexOf("'", i + 1)
      if (end < 0) return null
      segs.push(s.slice(i + 1, end))
      i = end + 1
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i))
      if (!m) return null
      segs.push(m[0])
      i += m[0].length
    }
    skipWs()
    if (i >= s.length) break
    if (s[i] !== '.') return null
    i++
  }
  return segs.length ? segs : null
}

export function encodeTomlKeySegment(seg: string): string {
  return BARE_KEY_RE.test(seg) ? seg : tomlBasicString(seg)
}

/** A TOML basic string, always quoted. */
export function tomlBasicString(seg: string): string {
  let out = '"'
  for (const ch of seg) {
    const cp = ch.codePointAt(0)!
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (cp < 0x20 || cp === 0x7f) out += `\\u${cp.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return out + '"'
}

export interface TomlSection {
  /** Null for the leading top-level keys, before any header. */
  path: string[] | null
  arrayTable: boolean
  header: string
  body: string[]
}

const HEADER_RE = /^\s*(\[\[?)\s*(.+?)\s*(\]\]?)\s*(#.*)?$/

/** Split TOML text into sections at table headers. Multi-line strings never split a section. */
export function splitTomlSections(text: string): TomlSection[] {
  const sections: TomlSection[] = [{ path: null, arrayTable: false, header: '', body: [] }]
  let inMulti: '"""' | "'''" | null = null
  for (const line of text.split(/\r?\n/)) {
    if (inMulti) {
      sections[sections.length - 1]!.body.push(line)
      if ((line.split(inMulti).length - 1) % 2 === 1) inMulti = null
      continue
    }
    const m = HEADER_RE.exec(line)
    const open = m?.[1], close = m?.[3]
    const path = m && ((open === '[' && close === ']') || (open === '[[' && close === ']]')) ? parseTomlKeyPath(m[2]!) : null
    if (m && path) {
      sections.push({ path, arrayTable: open === '[[', header: line, body: [] })
      continue
    }
    sections[sections.length - 1]!.body.push(line)
    for (const q of ['"""', "'''"] as const) {
      if ((line.split(q).length - 1) % 2 === 1) { inMulti = q; break }
    }
  }
  return sections
}

function headerFor(path: string[], arrayTable: boolean): string {
  const name = path.map(encodeTomlKeySegment).join('.')
  return arrayTable ? `[[${name}]]` : `[${name}]`
}

function camelToSnake(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

const HOOK_TRUST_KEY_RE = /^(.*):([a-z_]+):(\d+):(\d+)$/

// ── The generated home ───────────────────────────────────────────────────────

export interface CodexProfileHomeSources {
  /** The server's Codex home, read only. Default `CODEX_HOME` or `~/.codex`. */
  serverHome?: string
  scriptPath?: string
  hookPaths?: HookPaths
}

export interface RenderedCodexProfileHome {
  profileId: string
  home: string
  /** config.toml with the relay origin still a placeholder. */
  configTemplate: string
  hooksText: string
  /** Plan 8.1 resume binding: `profile:<id>:<sha>` over the template and hooks (never the port). */
  engineFingerprint: string
  copiedTables: string[]
  mirroredHookEvents: string[]
}

const ORIGIN_PLACEHOLDER = '__COS_RELAY_ORIGIN__'

function readTextOrNull(path: string): string | null {
  try {
    if (lstatSync(path).isSymbolicLink()) return null
    return readFileSync(path, 'utf8')
  } catch { return null }
}

/** Pure apart from READING the server home's config.toml and hooks.json. Writes nothing. */
export function renderCodexProfileHome(profile: KeyProfile, sources: CodexProfileHomeSources = {}): RenderedCodexProfileHome {
  const serverHome = sources.serverHome ?? serverCodexHome()
  const home = codexProfileHome(profile.id)
  const scriptPath = sources.scriptPath ?? stableCodexHookScriptPath()
  const hookPaths = sources.hookPaths ?? currentHookPaths()
  const serverHooksPath = join(serverHome, 'hooks.json')
  const profileHooksPath = join(home, 'hooks.json')

  // hooks.json: our canonical blocks, for exactly the events the user's file has ours for.
  let userHooks: unknown = {}
  const userHooksText = readTextOrNull(serverHooksPath)
  if (userHooksText !== null) { try { userHooks = JSON.parse(userHooksText) } catch { userHooks = {} } }
  const subscribed = codexSubscribedEvents(userHooks, scriptPath, hookPaths).subscribed
  const merged = mergeCodexHooks({}, scriptPath, hookPaths)
  const allBlocks = merged.ok ? (merged.settings.hooks as Record<string, unknown>) : {}
  const hooks: Record<string, unknown> = {}
  for (const event of subscribed) if (allBlocks[event] !== undefined) hooks[event] = allBlocks[event]
  const hooksText = JSON.stringify({ hooks }, null, 2) + '\n'

  // Where our block sits in the user's file, per event (snake name), for the trust remap.
  const userTable = userHooks && typeof userHooks === 'object' ? (userHooks as { hooks?: Record<string, unknown> }).hooks ?? {} : {}
  const ourIndex = new Map<string, number>()
  for (const event of subscribed) {
    const blocks = Array.isArray(userTable[event]) ? userTable[event] as unknown[] : []
    const canonical = JSON.stringify((allBlocks[event] as unknown[] | undefined)?.[0])
    const at = blocks.findIndex(b => JSON.stringify(b) === canonical)
    if (at >= 0) ourIndex.set(camelToSnake(event), at)
  }

  const copied: string[] = []
  const out: string[] = []
  const configText = readTextOrNull(join(serverHome, 'config.toml'))
  if (configText !== null) {
    for (const section of splitTomlSections(configText)) {
      const path = section.path
      if (!path) continue
      if (CODEX_COPIED_TABLES.includes(path[0]!)) {
        out.push(section.header, ...section.body)
        copied.push(path.join('.'))
        continue
      }
      // Hook trust: Codex keys each hook by `<file>:<event>:<block>:<hook>`. A project file's key
      // names the same file on both lanes and is copied as it stands. A key on the user's own
      // hooks.json is moved to this home's hooks.json, only where our block is the one trusted.
      if (path[0] === 'hooks' && path[1] === 'state' && path.length === 3) {
        const key = path[2]!
        const parsed = HOOK_TRUST_KEY_RE.exec(key)
        if (parsed && parsed[1] === serverHooksPath) {
          const at = ourIndex.get(parsed[2]!)
          if (at === undefined || Number(parsed[3]) !== at) continue
          const remapped = `${profileHooksPath}:${parsed[2]}:0:${parsed[4]}`
          out.push(headerFor(['hooks', 'state', remapped], false), ...section.body)
          copied.push(`hooks.state.${parsed[2]}`)
          continue
        }
        if (parsed && parsed[1]!.startsWith(home)) continue
        out.push(section.header, ...section.body)
        copied.push('hooks.state')
      }
    }
  }

  const head = [
    `# Generated by COS for key profile ${profile.id} before every keyed turn. COS rewrites it; do not edit.`,
    `model = ${tomlBasicString(profile.model)}`,
    `model_provider = "${CODEX_RELAY_PROVIDER_ID}"`,
    '',
    `[model_providers.${CODEX_RELAY_PROVIDER_ID}]`,
    'name = "COS key relay"',
    `base_url = "${ORIGIN_PLACEHOLDER}${RELAY_BASE_PATHS.codex}"`,
    `env_key = "${KEY_LANE_CHILD_ENV.codexToken}"`,
    'wire_api = "responses"',
    `request_max_retries = ${CODEX_RELAY_RETRIES}`,
    `stream_max_retries = ${CODEX_RELAY_RETRIES}`,
    '',
  ]
  const tail = out.length ? [`# Copied read-only from ${join(serverHome, 'config.toml')} (plan D9).`, ...out] : []
  const configTemplate = [...head, ...tail].join('\n').replace(/\n*$/, '\n')
  const sha = createHash('sha256').update(configTemplate).update('\0').update(hooksText).digest('hex').slice(0, 16)
  return {
    profileId: profile.id,
    home,
    configTemplate,
    hooksText,
    engineFingerprint: `profile:${profile.id}:${sha}`,
    copiedTables: [...new Set(copied)],
    mirroredHookEvents: Object.keys(hooks),
  }
}

const LOOPBACK_ORIGIN_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}$/

/**
 * Write the rendered home with the relay origin filled in: dirs 0700, files 0600, atomic. Refuses
 * a symlinked root or home. Any `auth.json` in the home is removed: a keyed home never holds one.
 */
export function writeCodexProfileHome(rendered: RenderedCodexProfileHome, relayOrigin: string): { configPath: string; hooksPath: string } {
  if (!LOOPBACK_ORIGIN_RE.test(relayOrigin)) throw new Error('codex-profile-home: the relay origin is not loopback')
  const root = codexProfileHomesRoot()
  for (const dir of [root, rendered.home]) {
    let st: ReturnType<typeof lstatSync> | null = null
    try { st = lstatSync(dir) } catch { /* created below */ }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error('codex-profile-home: refusing a symlinked or non-directory home')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  const auth = join(rendered.home, 'auth.json')
  try { lstatSync(auth); unlinkSync(auth) } catch { /* none, as it should be */ }
  const configPath = join(rendered.home, 'config.toml')
  const hooksPath = join(rendered.home, 'hooks.json')
  atomicWriteFileSync(configPath, rendered.configTemplate.split(ORIGIN_PLACEHOLDER).join(relayOrigin), { mode: 0o600 })
  atomicWriteFileSync(hooksPath, rendered.hooksText, { mode: 0o600 })
  return { configPath, hooksPath }
}
