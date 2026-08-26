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

/**
 * Is this argv free of every flag plan 4.7 bans?
 *
 * Flag-position tokens (start with `-`) are substring-matched so
 * `--permission-mode=bypassPermissions` still hits. Bare tokens
 * (`danger-full-access`) match only as their own argv slot. Values of
 * `--workspace` / `-C` are skipped: a cwd containing `--force` is a path,
 * not a permission flag.
 */
export function findBannedPermissionArg(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const value = String(args[i])
    const prev = i > 0 ? String(args[i - 1]) : ''
    if (PATH_VALUED_FLAGS.has(prev)) continue
    if (BARE_BANNED_PERMISSION_ARGS.has(value)) return value
    if (!value.startsWith('-')) continue
    for (const banned of BANNED_PERMISSION_ARGS) {
      if (value.includes(banned)) return banned
    }
  }
  return null
}
