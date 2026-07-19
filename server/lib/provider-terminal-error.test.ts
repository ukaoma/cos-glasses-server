import { describe, expect, it } from 'vitest'
import { terminalProviderAuthFailure } from './provider-terminal-error.js'
import { classifyClaudeError } from './claude-run-ledger.js'
import { classifyCodexError } from './codex-run-ledger.js'

describe('terminal provider authentication errors', () => {
  it.each([
    'API Error: 401 Unauthorized',
    'API Error: 401 Unauthorized Bearer sk-supersecret must never escape',
    'API Error: 403 Forbidden',
    'Authentication required. Please run claude login.',
    'Login required: run codex login',
    'You are not logged in. Please sign in.',
    '{"error":{"type":"authentication_error","message":"invalid credentials"}}',
    '\u001b[31mUnauthorized\u001b[0m',
  ])('classifies machine-shaped exit-zero output without echoing it: %s', value => {
    expect(terminalProviderAuthFailure('claude', value)).toBe('claude-bridge: authentication required.')
    expect(terminalProviderAuthFailure('codex', value)).toBe('codex-bridge: authentication required.')
  })

  it.each([
    'A 401 Unauthorized response means the credentials were rejected.',
    'Here is how to run codex login safely.',
    'The user asked why authentication failed yesterday.',
    'Please sign in.',
    'Please sign in to the customer portal, then choose Billing.',
    'Authentication required for the customer portal can be configured in Settings.',
    'Unauthorized access is what the server rejected; here is why.',
    '{"example":{"status":401},"description":"documentation fixture"}',
    'Normal assistant answer.',
  ])('does not reinterpret ordinary assistant content: %s', value => {
    expect(terminalProviderAuthFailure('claude', value)).toBeNull()
    expect(terminalProviderAuthFailure('codex', value)).toBeNull()
  })

  it('maps the canonical terminal failures to provider auth_error ledger codes', () => {
    expect(classifyClaudeError(terminalProviderAuthFailure('claude', '401 Unauthorized')!)).toBe('claude.auth_error')
    expect(classifyCodexError(terminalProviderAuthFailure('codex', '401 Unauthorized')!)).toBe('codex.auth_error')
  })

  it('accepts authoritative structured auth errors without stringifying them first', () => {
    expect(terminalProviderAuthFailure('claude', { status: 403, message: 'secret' }))
      .toBe('claude-bridge: authentication required.')
    expect(terminalProviderAuthFailure('codex', { error: { statusCode: 401 } }))
      .toBe('codex-bridge: authentication required.')
  })
})
