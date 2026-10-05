/**
 * Shared permission-ban list for attached, fork, and G2 Codex extra-args.
 * Keep PATH_VALUED_FLAGS and the bare-token set private; they only exist to
 * make findBannedPermissionArg skip cwd-shaped values.
 */

export const BANNED_PERMISSION_ARGS: readonly string[] = [
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--full-auto',
  '--yolo',
  '--force',
  'danger-full-access',
  'bypassPermissions',
  'acceptEdits',
]

const PATH_VALUED_FLAGS = new Set(['--workspace', '-C', '--cd', '--add-dir'])
const BARE_BANNED_PERMISSION_ARGS = new Set(
  BANNED_PERMISSION_ARGS.filter(flag => !flag.startsWith('-')),
)

/** The two spellings of Codex's sandbox option. The allowed value must be the NEXT argv slot. */
const CODEX_SANDBOX_FLAGS = new Set(['--sandbox', '-s'])

/**
 * 6.62.0 (plan 3.1, D1): the one exception to the ban, for a Continue that carries the
 * session's OWN permissions. ONE object, built once per turn from the Continue plan and
 * handed to BOTH checks in `attached-provider-adapter.ts` (the builder and the spawn
 * boundary), so the two can never disagree about what was allowed.
 *
 * Narrow by construction:
 *   - `cursorForce` admits exactly the argv slot `--force` (Cursor's Run Everything). Not
 *     `--force=…`, not `-f`, and nothing else on the list.
 *   - `codexSandbox` admits the bare token `danger-full-access` only as the value right
 *     after `--sandbox` / `-s`. The `--flag=value` spelling and every other position stay
 *     banned.
 *
 * Fork (`fork-thread.ts`) and G2 extra-args (`codex-extra-args.ts`) never pass one, so the
 * full ban holds there. Anything that is not exactly this shape counts as no allowance.
 */
export interface PermissionAllowance {
  path: 'attached_continue'
  cursorForce?: true
  codexSandbox?: 'danger-full-access'
}

function readAllowance(allowance: unknown): { cursorForce: boolean; codexDanger: boolean } {
  if (!allowance || typeof allowance !== 'object') return { cursorForce: false, codexDanger: false }
  const row = allowance as Record<string, unknown>
  if (row.path !== 'attached_continue') return { cursorForce: false, codexDanger: false }
  return {
    cursorForce: row.cursorForce === true,
    codexDanger: row.codexSandbox === 'danger-full-access',
  }
}

/**
 * Is this argv free of every flag plan 4.7 bans?
 *
 * Flag-position tokens (start with `-`) are substring-matched so
 * `--permission-mode=bypassPermissions` still hits. Bare tokens
 * (`danger-full-access`) match only as their own argv slot. Values of
 * `--workspace` / `-C` are skipped: a cwd containing `--force` is a path,
 * not a permission flag.
 *
 * `allowance` (6.62.0) lifts exactly what `PermissionAllowance` names, and only for the
 * attached Continue path. Omitted, it is the full ban, byte for byte the 6.61 check.
 */
export function findBannedPermissionArg(args: readonly string[], allowance?: PermissionAllowance): string | null {
  const allowed = readAllowance(allowance)
  for (let i = 0; i < args.length; i++) {
    const value = String(args[i])
    const prev = i > 0 ? String(args[i - 1]) : ''
    if (PATH_VALUED_FLAGS.has(prev)) continue
    if (allowed.cursorForce && value === '--force') continue
    if (allowed.codexDanger && value === 'danger-full-access' && CODEX_SANDBOX_FLAGS.has(prev)) continue
    if (BARE_BANNED_PERMISSION_ARGS.has(value)) return value
    if (!value.startsWith('-')) continue
    for (const banned of BANNED_PERMISSION_ARGS) {
      if (value.includes(banned)) return banned
    }
  }
  return null
}
