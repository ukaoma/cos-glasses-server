// 6.62.0 (plan 3.11): the per-provider action contract. Pure: every branch from its input.

import { describe, expect, it } from 'vitest'
import { mergeProviderSections, providerActSections, providerActs, type ProviderActInput } from './provider-actions'

const base: ProviderActInput = {
  attachEnabled: true,
  forkProviders: ['claude', 'codex', 'cursor'],
  sessionCancel: { cosTurn: true, deskClaude: true },
  brokerEnabled: true,
  continueLive: true,
  codexLiveQueue: true,
  env: {},
}

describe('providerActs', () => {
  it('carries a reason on every false entry, for every input combination', () => {
    for (const attachEnabled of [true, false]) {
      for (const brokerEnabled of [true, false]) {
        for (const codexLiveQueue of [true, false]) {
          for (const env of [{}, { COS_CONTINUE_FULL_PERMISSIONS: '0' }]) {
            const acts = providerActs({ ...base, attachEnabled, brokerEnabled, codexLiveQueue, env, sessionCancel: null, forkProviders: [] })
            for (const [provider, act] of Object.entries(acts)) {
              for (const [name, entry] of Object.entries(act)) {
                if (entry.supported) expect(entry.reason, `${provider}.${name}`).toBeUndefined()
                else expect(entry.reason, `${provider}.${name}`).toMatch(/^[a-z_]+$/)
              }
            }
          }
        }
      }
    }
  })

  it('states the 6.62 contract: Run Everything and session posture on, new-session fork for Cursor', () => {
    const acts = providerActs(base)
    expect(acts.cursor.permissions).toEqual({ supported: true, mode: 'run_everything' })
    expect(acts.codex.permissions).toEqual({ supported: true, mode: 'session_posture' })
    expect(acts.cursor.fork).toEqual({ supported: true, mode: 'new_session' })
    expect(acts.codex.continueBusy).toEqual({ supported: true, mode: 'app_queue' })
    expect(acts.cursor.approvals).toEqual({ supported: false, reason: 'engine_limit' })
    expect(acts.claude.cancelDesk).toEqual({ supported: true, mode: 'next_command' })
    // Desk cancel for Codex and Cursor follows whatever the cancel feature publishes.
    expect(acts.codex.cancelDesk).toEqual({ supported: false, reason: 'hooks_not_ready' })
    expect(providerActs({ ...base, sessionCancel: { deskCodex: true, deskCursor: true } }).cursor.cancelDesk.supported).toBe(true)
  })

  it('the kill switch turns keepModel and permissions off for Codex and Cursor, never for Claude', () => {
    const acts = providerActs({ ...base, env: { COS_CONTINUE_FULL_PERMISSIONS: '0' } })
    for (const provider of ['codex', 'cursor'] as const) {
      expect(acts[provider].permissions).toEqual({ supported: false, reason: 'full_permissions_off' })
      expect(acts[provider].keepModel).toEqual({ supported: false, reason: 'full_permissions_off' })
    }
    expect(acts.claude.permissions.supported).toBe(true)
  })
})

describe('mergeProviderSections', () => {
  it('joins act and observe under one provider without either overwriting the other', () => {
    const observe = { claude: { observe: { hooks: true } }, codex: { observe: { hooks: false } } }
    const merged = mergeProviderSections(providerActSections(base), observe, null)
    expect(Object.keys(merged.claude!)).toEqual(['act', 'observe'])
    expect(merged.codex!.observe).toEqual({ hooks: false })
    expect(merged.cursor!.act).toBeTruthy()
  })
})
