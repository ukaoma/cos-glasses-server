export type ClaudeTrustMode = 'trusted' | 'allowlist'

/**
 * Claude Code historically ran COS in trusted mode so headless sessions could
 * use the operator's existing tools without stopping for an interactive
 * permission prompt. Keep that behavior for compatibility, while allowing
 * security-conscious installs to opt into a strict, non-interactive allowlist.
 */
export function getClaudeTrustMode(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeTrustMode {
  return env.COS_CLAUDE_TRUST_MODE?.trim().toLowerCase() === 'allowlist'
    ? 'allowlist'
    : 'trusted'
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

  const tools = allowedTools ?? ''
  return [
    '--permission-mode', 'dontAsk',
    '--tools', tools,
    '--allowedTools', tools,
  ]
}
