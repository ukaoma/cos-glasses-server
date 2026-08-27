export type ClaudeTrustMode = 'trusted' | 'allowlist'

/**
 * Claude Code historically ran COS in trusted mode so headless sessions could
 * use the operator's existing tools without stopping for an interactive
 * permission prompt. Keep that behavior for compatibility, while allowing
 * security-conscious installs to opt into a strict, non-interactive allowlist.
 */
let warnedUnknownTrustMode = false

export function getClaudeTrustMode(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeTrustMode {
  const raw = env.COS_CLAUDE_TRUST_MODE?.trim().toLowerCase()
  if (raw === 'allowlist') return 'allowlist'
  // Fails OPEN by design (an unset value must keep the established trusted
  // behavior), but silence is indefensible for the one security setting the
  // README offers: a typo like 'allow-list' or 'restricted' hands back the FULL
  // permission bypass. Warn once per process rather than failing closed, which
  // would break existing installs.
  if (raw && raw !== 'trusted' && !warnedUnknownTrustMode) {
    warnedUnknownTrustMode = true
    console.warn(
      `[claude-permissions] Unrecognized COS_CLAUDE_TRUST_MODE="${raw}" — falling back to trusted `
      + '(full permission bypass). Use exactly "allowlist" to restrict tools.',
    )
  }
  return 'trusted'
}

/**
 * Build only Claude's permission-related CLI arguments.
 *
 * - trusted: preserves the established COS behavior.
 * - allowlist: denies undeclared tools without prompting and restricts the
 *   available built-ins to the explicit per-query list.
 */
export function claudePermissionArgs(
  mode: ClaudeTrustMode,
  allowedTools: string | null,
): string[] {
  if (mode === 'trusted') {
    return allowedTools === null
      ? ['--dangerously-skip-permissions']
      : ['--dangerously-skip-permissions', '--allowedTools', allowedTools]
  }

  // No per-query list (the prewarm spawn): deny everything via dontAsk plus an
  // empty allowedTools, but never pass an empty --tools — on the current CLI
  // an empty --tools triggers a spurious context compaction and a synthetic
  // 400 (single-flag bisection 2026-08-26, documented in fork-thread.ts).
  if (allowedTools === null) {
    return ['--permission-mode', 'dontAsk', '--allowedTools', '']
  }
  return [
    '--permission-mode', 'dontAsk',
    '--tools', allowedTools,
    '--allowedTools', allowedTools,
  ]
}
