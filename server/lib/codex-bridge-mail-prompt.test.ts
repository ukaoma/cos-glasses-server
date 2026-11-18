import { afterEach, describe, expect, it } from 'vitest'
import { codexCapabilityPrompt } from './codex-bridge.js'

// 7.0.59 (the lead session 11/18): the Codex G2 prompt named retired mail paths (email_cache / email_gmail_api). On 11/18 a
// G2 session said a deadline could not be found without M365 while Spark had it. Mail goes through the connectors that
// load, else the read-only Spark CLI; mail is never sent.
const saved = process.env.COS_CODEX_SANDBOX
afterEach(() => { if (saved === undefined) delete process.env.COS_CODEX_SANDBOX; else process.env.COS_CODEX_SANDBOX = saved })

describe('the Codex capability prompt points mail at Spark, never the retired Gmail scripts', () => {
  it('workspace-write: names the Spark CLI commands and never sends mail', () => {
    process.env.COS_CODEX_SANDBOX = 'workspace-write'
    const p = codexCapabilityPrompt()
    expect(p).toContain('spark emails')
    expect(p).toContain('spark accounts')
    expect(p).toContain('spark thread')
    expect(p).toContain('Never send mail')
    expect(p).not.toMatch(/email_gmail_api|email_cache|confirm=True/)
  })
  it('read-only: no retired mail path either', () => {
    delete process.env.COS_CODEX_SANDBOX
    expect(codexCapabilityPrompt()).not.toMatch(/email_gmail_api|email_cache/)
  })
})
