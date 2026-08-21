/**
 * Where a provider's executable actually is.
 *
 * Extracted from `attached-provider-adapter.ts` 2026-08-19, unchanged. It moved because
 * three other modules spawn providers by BARE NAME and need this resolution, and importing
 * the adapter to get it closes a cycle: adapter -> codex-run-ledger -> codex-model-catalog
 * -> adapter. This module imports nothing from the repo, so it can never be in one.
 *
 * Bare `'codex'` in argv resolves through PATH, and a Finder- or launchd-spawned process
 * gets a minimal one. On this machine the bare sites work ONLY because COS Control injects
 * ChatGPT.app onto the managed plist PATH -- they are broken for every public npx user.
 */

import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

export type BinaryResolutionFailure = 'env_override_unusable' | 'not_found' | 'unknown_provider'

export type BinaryResolution =
  | { ok: true; path: string; source: 'env' | 'absolute' | 'path' }
  | { ok: false; binary: string; detail: BinaryResolutionFailure }

/**
 * Path prefixes that can never be a usable provider binary.
 *
 * `codex` resolved through PATH (or a shell alias) points at
 * `/Applications/Codex.app/Contents/Resources/codex` on this machine, and that
 * app no longer exists. Today the shim is dangling, so an existence check
 * already rejects it — but a reinstalled or partially-removed Codex.app puts a
 * real, executable file back on that path, and then only this list stands
 * between an attached turn and a binary that cannot serve it.
 */
export const STALE_SHIM_PREFIXES: readonly string[] = ['/Applications/Codex.app/']

export function isKnownStaleShimPath(
  candidate: string,
  prefixes: readonly string[] = STALE_SHIM_PREFIXES,
): boolean {
  // A non-array argument falls back to the known list rather than to "exclude
  // nothing" — the classic version of this bug is `list.some(isKnownStaleShimPath)`,
  // where `.some` passes the INDEX as the second argument and every exclusion
  // silently disappears.
  const list = Array.isArray(prefixes) ? prefixes : STALE_SHIM_PREFIXES
  return list.some(prefix => typeof prefix === 'string' && prefix.length > 0 && candidate.startsWith(prefix))
}

function isUsableExecutable(
  candidate: string,
  excludePrefixes: readonly string[] = STALE_SHIM_PREFIXES,
): boolean {
  try {
    if (!isAbsolute(candidate) || candidate.includes('\0')) return false
    if (isKnownStaleShimPath(candidate, excludePrefixes)) return false
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface BinarySpec {
  name: string
  envKeys: readonly string[]
  /** Tried in order, BEFORE any PATH scan. */
  absolutes: readonly string[]
  /**
   * Paths that must never be selected, from any source. Defaults to
   * `STALE_SHIM_PREFIXES`.
   *
   * On the spec rather than hardcoded because the exclusion is the only guard
   * standing between resolution and a known-bad binary, and a guard whose input
   * cannot be constructed is a guard nobody can prove works: the real prefix
   * lives under `/Applications`, which no fixture can write to.
   */
  excludePrefixes?: readonly string[]
}

/**
 * Where each provider's binary is looked for, in precedence order.
 *
 * Exported as data rather than kept private so the precedence itself is
 * testable: on a machine where a stale shim sits on PATH, "ChatGPT.app is tried
 * before PATH" is the property that decides whether an attached Codex turn
 * launches the real binary or a dangling one.
 */
/**
 * Takes a plain string, not `AttachedProvider`, deliberately. That type is declared in
 * `attached-provider-adapter.ts`, and importing it back would recreate exactly the cycle
 * this extraction exists to break. Callers pass a string-union value, which is assignable.
 */
export function providerBinarySpec(provider: string): BinarySpec | null {
  const home = (() => {
    try {
      return homedir()
    } catch {
      return ''
    }
  })()
  if (provider === 'claude') {
    return {
      name: 'claude',
      envKeys: ['COS_ATTACHED_CLAUDE_BIN', 'COS_CLAUDE_BIN'],
      absolutes: [
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        home ? join(home, '.local', 'bin', 'claude') : '',
      ].filter(Boolean),
    }
  }
  if (provider === 'codex') {
    return {
      name: 'codex',
      envKeys: ['COS_ATTACHED_CODEX_BIN', 'COS_CODEX_BIN'],
      absolutes: [
        // Verified 2026-08-15: codex-cli 0.148.0-alpha.9 lives here, and there is
        // no `codex` on PATH at all on this machine.
        '/Applications/ChatGPT.app/Contents/Resources/codex',
        home ? join(home, '.codex', 'bin', 'codex') : '',
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
      ].filter(Boolean),
    }
  }
  if (provider === 'cursor') {
    return {
      name: 'agent',
      envKeys: ['COS_ATTACHED_CURSOR_AGENT_BIN', 'COS_CURSOR_AGENT_BIN'],
      absolutes: [
        home ? join(home, '.local', 'bin', 'agent') : '',
      ].filter(Boolean),
    }
  }
  return null
}

/**
 * Resolve a provider binary to a verified absolute path, or refuse.
 *
 * Never returns a bare name. A bare name is a silent PATH lookup, and the two
 * environments this server runs in disagree about PATH: a login shell finds the
 * CLI, a Finder- or launchd-spawned process gets a minimal PATH and does not
 * (hit twice in COS Control). The PATH scan below is done by us, entry by
 * entry, and still yields an absolute path we have stat'ed — so a failure names
 * the missing binary instead of surfacing as ENOENT from inside a spawn.
 *
 * An unusable env override REFUSES rather than falling through to the
 * candidates: an operator who set it wrongly needs to be told, not overridden.
 */
export function resolveProviderBinary(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): BinaryResolution {
  const spec = providerBinarySpec(provider)
  if (!spec) return { ok: false, binary: provider, detail: 'unknown_provider' }
  return resolveBinaryFromSpec(spec, env)
}

/**
 * The resolution algorithm itself, separated from the provider tables.
 *
 * Not a testing seam bolted on: on any developer machine at least one real
 * absolute candidate exists, so the PATH-scan and not-found branches of
 * `resolveProviderBinary` are unreachable from a test and would ship
 * unexercised — which is exactly how a launchd-only failure hides. Driving the
 * REAL algorithm with a fixture spec exercises them for real.
 */
export function resolveBinaryFromSpec(spec: BinarySpec, env: NodeJS.ProcessEnv): BinaryResolution {
  const excluded = spec.excludePrefixes ?? STALE_SHIM_PREFIXES

  for (const key of spec.envKeys) {
    const raw = env[key]
    if (typeof raw !== 'string' || raw.trim().length === 0) continue
    const candidate = raw.trim()
    if (!isUsableExecutable(candidate, excluded)) {
      return { ok: false, binary: spec.name, detail: 'env_override_unusable' }
    }
    return { ok: true, path: candidate, source: 'env' }
  }

  for (const candidate of spec.absolutes) {
    if (isUsableExecutable(candidate, excluded)) return { ok: true, path: candidate, source: 'absolute' }
  }

  const pathValue = typeof env.PATH === 'string' ? env.PATH : ''
  for (const dir of pathValue.split(delimiter)) {
    // A relative PATH entry resolves against the server's cwd, which is not a
    // location we control. Skipped rather than resolved.
    //
    // Redundant with the `isAbsolute` inside `isUsableExecutable` — verified by
    // mutation: removing EITHER one alone changes no outcome, and only removing
    // BOTH lets a relative entry through. Kept because two independent guards
    // on "never resolve against the server cwd" is the correct amount for a
    // path that ends up as a spawned executable.
    if (!dir || !isAbsolute(dir)) continue
    const candidate = join(dir, spec.name)
    if (isUsableExecutable(candidate, excluded)) return { ok: true, path: candidate, source: 'path' }
  }

  return { ok: false, binary: spec.name, detail: 'not_found' }
}
