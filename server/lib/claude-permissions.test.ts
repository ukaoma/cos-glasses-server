import { describe, expect, it } from 'vitest'
import { claudePermissionArgs, getClaudeTrustMode } from './claude-permissions.js'

describe('Claude permission policy', () => {
  it('preserves trusted mode unless allowlist is explicitly selected', () => {
    expect(getClaudeTrustMode({})).toBe('trusted')
    expect(getClaudeTrustMode({ COS_CLAUDE_TRUST_MODE: 'trusted' })).toBe('trusted')
    expect(getClaudeTrustMode({ COS_CLAUDE_TRUST_MODE: 'ALLOWLIST' })).toBe('allowlist')
  })

  it('removes the permission bypass and constrains tools in allowlist mode', () => {
    const args = claudePermissionArgs('allowlist', 'WebSearch,WebFetch')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).toEqual([
      '--permission-mode', 'dontAsk',
      '--tools', 'WebSearch,WebFetch',
      '--allowedTools', 'WebSearch,WebFetch',
    ])
  })

  it('never emits an empty --tools when allowlist mode has no per-query list', () => {
    // An empty --tools on the current CLI triggers a spurious context
    // compaction followed by a synthetic 400 (fork-thread.ts bisection,
    // 2026-08-26). The listless spawn (prewarm) must deny via dontAsk +
    // empty allowedTools without ever passing the poisoned flag.
    const args = claudePermissionArgs('allowlist', null)
    expect(args).not.toContain('--tools')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).toEqual(['--permission-mode', 'dontAsk', '--allowedTools', ''])
  })

  it('keeps the current trusted behavior explicit', () => {
    expect(claudePermissionArgs('trusted', 'Read')).toEqual([
      '--dangerously-skip-permissions', '--allowedTools', 'Read',
    ])
    expect(claudePermissionArgs('trusted', null)).toEqual([
      '--dangerously-skip-permissions',
    ])
  })
})
