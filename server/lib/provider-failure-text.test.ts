import { describe, expect, it } from 'vitest'
import { PROVIDER_AUTH_RE, PROVIDER_OVERFLOW_RE, PROVIDER_QUOTA_RE, providerFailureCode } from './provider-failure-text'

// The four sign-in failures Claude Code documents for `claude -p` (errors.md, read 2026-11-12;
// operations/personal/wk46_2026/claude_signin_without_terminal_research_2026-11-12.md). The first one
// matched nothing before 7.0.30, so the reason read "provider process exited N".
const DOCUMENTED_AUTH = [
  'Failed to authenticate: OAuth session expired and could not be refreshed',
  'Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.',
  'Failed to authenticate. API Error: 401 OAuth token has expired',
  'Not logged in · Please run /login',
]

describe('provider sign-in failures', () => {
  it.each(DOCUMENTED_AUTH)('names %j as a sign-in failure', (text) => {
    expect(PROVIDER_AUTH_RE.test(text)).toBe(true)
    expect(providerFailureCode('query_job_failed', text)).toBe('provider_auth')
    expect(providerFailureCode('claude.error', `claude exited 1: ${text}`)).toBe('provider_auth')
  })

  it('does not read any of them as a usage limit or an overlong prompt', () => {
    for (const text of DOCUMENTED_AUTH) {
      expect(PROVIDER_QUOTA_RE.test(text)).toBe(false)
      expect(PROVIDER_OVERFLOW_RE.test(text)).toBe(false)
    }
  })

  it('leaves an ordinary failure and a specific code alone', () => {
    expect(providerFailureCode('query_job_failed', 'provider process exited 1')).toBe('query_job_failed')
    expect(providerFailureCode('fork_failed', DOCUMENTED_AUTH[0])).toBe('fork_failed')
  })
})
