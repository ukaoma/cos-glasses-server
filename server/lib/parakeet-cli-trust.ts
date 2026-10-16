// 6.74.0: trust for a fluidaudiocli that COS Control ships signed (its Contents/Helpers).
//
// FluidAudio publishes no binary for v0.17.4, so COS Control builds it from the pinned
// source tag and signs it with the COS Developer ID. That build cannot match the SHA-256
// pin (parakeet-manifest.ts) because the signature is part of the bytes, so it is trusted
// on three proofs instead, all required:
//
//   1. `codesign --verify --strict` passes, against the requirement that the leaf
//      certificate chains to Apple and names the COS team (a self-signed certificate
//      can claim any team name; `anchor apple generic` is what rules that out).
//   2. The TeamIdentifier codesign reports is COS_TEAM_ID.
//   3. Its version is 0.17.4: from an Info.plist embedded in the binary and bound by the
//      signature (`Info.plist entries=` in codesign's display), or from `--version`
//      output. The upstream 0.17.4 CLI has no version command, so the embedded
//      Info.plist is the expected source.
//
// The hand-placed SHA-256 pinned copy (parakeet.ts isPinnedCli) is unchanged.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants, createReadStream, fstatSync, mkdtempSync, openSync, readSync, closeSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { PARAKEET_CLI } from './parakeet-manifest.js'

/** The COS Developer ID team (read from /Applications/COS Control.app with codesign -dv, 2026-10-16). */
export const COS_TEAM_ID = 'NV3X46LLCR'
export const CODESIGN = '/usr/bin/codesign'
export const TRUST_REQUIREMENT = `=anchor apple generic and certificate leaf[subject.OU] = "${COS_TEAM_ID}"`

export type CliTrustReason = 'missing' | 'unsigned' | 'signature_invalid' | 'wrong_team' | 'wrong_version'

export type CliTrust =
  | { trusted: true; trust: 'developer-id'; path: string; teamId: string; version: string; versionSource: 'info-plist' | 'version-output'; sha256: string; size: number }
  | { trusted: false; path: string; reason: CliTrustReason; detail: string }

export interface CliTrustDeps {
  /** codesign -dv: what it prints (stderr), and its exit code. */
  display: (path: string) => Promise<{ code: number; output: string }>
  /** codesign --verify --strict [-R requirement]. */
  verify: (path: string, requirement?: string) => Promise<{ code: number; output: string }>
  /** `<cli> --version`, network denied, bounded. Output text, or '' on any failure. */
  versionOutput: (path: string) => Promise<string>
  /** The Info.plist embedded in the Mach-O, or null. */
  embeddedPlist: (path: string) => string | null
  sha256: (path: string) => Promise<string>
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 256 * 1024, env: { PATH: '/usr/bin:/bin' } }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
      resolve({ code, output: `${stdout ?? ''}${stderr ?? ''}` })
    })
  })
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb(null) } }))
  return hash.digest('hex')
}

const VERSION_PROFILE = (work: string) =>
  `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath "${work.replace(/"/g, '\\"')}") (literal "/dev/null"))`

export const defaultCliTrustDeps: CliTrustDeps = {
  display: path => run(CODESIGN, ['-dv', path], 10_000),
  verify: (path, requirement) => run(CODESIGN, ['--verify', '--strict', ...(requirement ? ['-R', requirement] : []), path], 15_000),
  versionOutput: async path => {
    // Only reached after the signature and team checks pass. Still sandboxed: no
    // network, writes only to a scratch directory, its own HOME, 5 s.
    const work = mkdtempSync(join(tmpdir(), 'cos-cli-version-'))
    try {
      const out = await new Promise<string>(resolve => {
        execFile('/usr/bin/sandbox-exec', ['-p', VERSION_PROFILE(work), path, '--version'],
          { timeout: 5_000, maxBuffer: 64 * 1024, cwd: work, env: { HOME: work, TMPDIR: work, PATH: '/usr/bin:/bin' } },
          (_error, stdout, stderr) => resolve(`${stdout ?? ''}${stderr ?? ''}`))
      })
      return out
    } finally { rmSync(work, { recursive: true, force: true }) }
  },
  embeddedPlist: path => readEmbeddedInfoPlist(path),
  sha256: sha256File,
}

// ── Mach-O __TEXT,__info_plist ────────────────────────────────────────────────

const MH_MAGIC_64 = 0xfeedfacf
const FAT_MAGIC = 0xcafebabe
const LC_SEGMENT_64 = 0x19
const CPU_TYPE_ARM64 = 0x0100000c

function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length)
  const n = readSync(fd, buf, 0, length, offset)
  return buf.subarray(0, n)
}

function cstr(buf: Buffer, start: number): string {
  const raw = buf.subarray(start, start + 16)
  const end = raw.indexOf(0)
  return raw.subarray(0, end < 0 ? 16 : end).toString('ascii')
}

/** The __TEXT,__info_plist section of a thin 64-bit or fat Mach-O (arm64 slice), or null. */
export function readEmbeddedInfoPlist(path: string): string | null {
  let fd: number
  // Non-blocking and no-follow: the path can come from a client, and a FIFO would
  // block this synchronous open, and with it the whole server (hazard-invariants.test.ts).
  try { fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW) } catch { return null }
  try { if (!fstatSync(fd).isFile()) { closeSync(fd); return null } } catch { closeSync(fd); return null }
  try {
    let base = 0
    const head = readAt(fd, 0, 8)
    if (head.length < 8) return null
    if (head.readUInt32BE(0) === FAT_MAGIC) {
      const count = head.readUInt32BE(4)
      if (count > 16) return null
      const arches = readAt(fd, 8, count * 20)
      base = -1
      for (let i = 0; i < count; i++) {
        if (arches.readUInt32BE(i * 20) === CPU_TYPE_ARM64) { base = arches.readUInt32BE(i * 20 + 8); break }
      }
      if (base < 0) return null
    }
    const header = readAt(fd, base, 32)
    if (header.length < 32 || header.readUInt32LE(0) !== MH_MAGIC_64) return null
    const ncmds = header.readUInt32LE(16)
    const sizeofcmds = header.readUInt32LE(20)
    if (sizeofcmds > 4 * 1024 * 1024) return null
    const cmds = readAt(fd, base + 32, sizeofcmds)
    let off = 0
    for (let i = 0; i < ncmds && off + 8 <= cmds.length; i++) {
      const cmd = cmds.readUInt32LE(off)
      const cmdsize = cmds.readUInt32LE(off + 4)
      if (cmdsize < 8) return null
      if (cmd === LC_SEGMENT_64 && cstr(cmds, off + 8) === '__TEXT') {
        const nsects = cmds.readUInt32LE(off + 64)
        for (let s = 0; s < nsects; s++) {
          const sec = off + 72 + s * 80
          if (sec + 80 > cmds.length) return null
          if (cstr(cmds, sec) !== '__info_plist') continue
          const size = Number(cmds.readBigUInt64LE(sec + 40))
          const offset = cmds.readUInt32LE(sec + 48)
          if (size <= 0 || size > 64 * 1024) return null
          return readAt(fd, base + offset, size).toString('utf8').replace(/\0+$/, '')
        }
      }
      off += cmdsize
    }
    return null
  } catch { return null } finally { closeSync(fd) }
}

/** CFBundleShortVersionString (else CFBundleVersion) from an XML plist. */
export function plistVersion(xml: string): string | null {
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]{1,64})</string>`).exec(xml)
    if (m) return m[1].trim()
  }
  return null
}

/** 0.17.4 as a whole token, so 0.17.40 or 10.17.4 never pass. */
export function versionMatches(text: string, want: string = PARAKEET_CLI.version): boolean {
  const escaped = want.replace(/\./g, '\\.')
  return new RegExp(`(^|[^0-9.])v?${escaped}(?![0-9]|\\.[0-9])`).test(text)
}

export function parseCodesignDisplay(output: string): { teamId: string | null; adhoc: boolean; unsigned: boolean; plistBound: boolean } {
  const team = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim() ?? null
  return {
    teamId: team && team !== 'not set' ? team : null,
    adhoc: /^Signature=adhoc$/m.test(output) || /flags=0x[0-9a-f]*\([^)]*adhoc/.test(output),
    unsigned: /code object is not signed at all/i.test(output),
    plistBound: /^Info\.plist entries=\d+/m.test(output),
  }
}

/** Every proof, in order; the first that fails names the reason. Never throws. */
export async function checkDeveloperIdCli(path: string, deps: CliTrustDeps = defaultCliTrustDeps): Promise<CliTrust> {
  const no = (reason: CliTrustReason, detail: string): CliTrust => ({ trusted: false, path, reason, detail })
  let size: number
  try { const st = statSync(path); if (!st.isFile()) return no('missing', 'not a file'); size = st.size } catch { return no('missing', 'not found') }
  try {
    const shown = await deps.display(path)
    const d = parseCodesignDisplay(shown.output)
    if (d.unsigned || shown.code !== 0) return no('unsigned', 'the speech tool is not signed')
    if (d.adhoc || !d.teamId) return no('unsigned', 'the speech tool has no Developer ID signature')
    const strict = await deps.verify(path)
    if (strict.code !== 0) return no('signature_invalid', strict.output.trim().split('\n').slice(-1)[0]?.slice(0, 200) || 'the signature does not verify')
    if (d.teamId !== COS_TEAM_ID) return no('wrong_team', `signed by team ${d.teamId}`)
    const anchored = await deps.verify(path, TRUST_REQUIREMENT)
    if (anchored.code !== 0) return no('wrong_team', 'the signature does not chain to Apple for the COS team')
    let version: string | null = null
    let versionSource: 'info-plist' | 'version-output' = 'info-plist'
    let plistNamed: string | null = null
    if (d.plistBound) {
      const plist = deps.embeddedPlist(path)
      plistNamed = plist ? plistVersion(plist) : null
      if (plistNamed && versionMatches(plistNamed)) version = PARAKEET_CLI.version
    }
    // A bound Info.plist that names another version is the answer: never run that binary.
    if (!version && !plistNamed) {
      const out = await deps.versionOutput(path).catch(() => '')
      if (versionMatches(out)) { version = PARAKEET_CLI.version; versionSource = 'version-output' }
    }
    if (!version) return no('wrong_version', `not FluidAudio ${PARAKEET_CLI.version}`)
    const sha256 = await deps.sha256(path)
    // The bytes hashed must be the bytes checked.
    if (statSync(path).size !== size) return no('signature_invalid', 'the file changed while it was checked')
    return { trusted: true, trust: 'developer-id', path, teamId: COS_TEAM_ID, version, versionSource, sha256, size }
  } catch (error) {
    return no('signature_invalid', error instanceof Error ? error.message.slice(0, 200) : String(error))
  }
}

// ── Where COS Control's copy is, and a per-process cache for GET ──────────────

const HELPER_REL = join('COS Control.app', 'Contents', 'Helpers', 'fluidaudiocli')

/** COS Control in /Applications or ~/Applications, plus any path Control registered. */
export function controlCliCandidates(home: string = homedir()): string[] {
  return [...offered, join(applicationsRoot, HELPER_REL), join(home, 'Applications', HELPER_REL)]
}
let applicationsRoot = '/Applications'
/** Tests only: keep the real /Applications out of a test's view. */
export function __setApplicationsRootForTests(root: string | null): void { applicationsRoot = root ?? '/Applications' }

const offered: string[] = []
/** An absolute path whose file name is fluidaudiocli. Anything else is never checked or run. */
export function isCliPathShape(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && path.length <= 1024 && !path.includes('\0') && basename(path) === 'fluidaudiocli'
}
/** Control tells the server where its bundled CLI is (POST /api/stt-settings/parakeet/cli). */
export function offerControlCli(path: string): void {
  if (!isCliPathShape(path)) return
  if (!offered.includes(path)) offered.unshift(path)
  if (offered.length > 4) offered.length = 4
}

const cache = new Map<string, CliTrust>()
const pending = new Map<string, Promise<CliTrust>>()
function cacheKey(path: string): string | null {
  try { const st = statSync(path); return st.isFile() ? `${path}\0${st.size}\0${st.mtimeMs}\0${st.ino}` : null } catch { return null }
}

/** Check (once per path, size, mtime and inode) and remember. */
export function trustCli(path: string, deps: CliTrustDeps = defaultCliTrustDeps): Promise<CliTrust> {
  const key = cacheKey(path)
  if (!key) return Promise.resolve({ trusted: false, path, reason: 'missing', detail: 'not found' })
  const known = cache.get(key)
  if (known) return Promise.resolve(known)
  const running = pending.get(key)
  if (running) return running
  const job = checkDeveloperIdCli(path, deps).then(r => { cache.set(key, r); return r }).finally(() => pending.delete(key))
  pending.set(key, job)
  return job
}

/** Synchronous, for GET: the known result for this file, null while unchecked (a check starts). */
export function knownCliTrust(path: string): CliTrust | null {
  const key = cacheKey(path)
  if (!key) return { trusted: false, path, reason: 'missing', detail: 'not found' }
  const known = cache.get(key)
  if (known) return known
  void trustCli(path)
  return null
}

/** The first trusted candidate, or null. */
export async function findTrustedCli(candidates: string[] = controlCliCandidates(), deps?: CliTrustDeps): Promise<Extract<CliTrust, { trusted: true }> | null> {
  for (const c of candidates) {
    const r = await trustCli(c, deps)
    if (r.trusted) return r
  }
  return null
}

export function __resetCliTrustForTests(): void { cache.clear(); pending.clear(); offered.length = 0; applicationsRoot = '/Applications' }
