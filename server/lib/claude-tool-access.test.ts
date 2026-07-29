import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildClaudeToolList,
  claudeMcpConfigArgs,
  claudeToolCapabilityPrompt,
  readOnlyCapabilityPrompt,
  TOOL_HONESTY_CLAUSE,
  configuredClaudeExtraTools,
  parseClaudeExtraToolConfiguration,
  reportClaudeExtraToolConfiguration,
} from './claude-tool-access.js'

describe('Claude MCP tool access', () => {
  it('accepts only explicit MCP selectors and de-duplicates them', () => {
    const env = {
      COS_EXTRA_TOOLS: 'mcp__calendar__list,mcp__calendar__*, Bash,Write,mcp__calendar__list, bad value',
    }
    expect(configuredClaudeExtraTools(env)).toEqual([
      'mcp__calendar__list',
      'mcp__calendar__*',
    ])
    expect(buildClaudeToolList({ includeRead: true, env })).toEqual([
      'WebSearch',
      'WebFetch',
      'Read',
      'mcp__calendar__list',
      'mcp__calendar__*',
    ])
  })

  it('tells the model not to fabricate unavailable connector machinery', () => {
    // The anti-fabrication guarantee is unconditional and must hold in BOTH
    // modes. Only the capability wording is mode-dependent. The old assertion
    // pinned 'only these tool selectors' — the exact misleading string that
    // caused the 2026-07-28 G2 false-refusal incident.
    for (const mode of ['trusted', 'allowlist'] as const) {
      const prompt = claudeToolCapabilityPrompt(['WebSearch', 'mcp__calendar__*'], mode)
      expect(prompt).toContain('Never invent connector health')
    }
  })

  it('describes a restriction ONLY in allowlist mode, where it is actually true', () => {
    const restricted = claudeToolCapabilityPrompt(['WebSearch'], 'allowlist')
    expect(restricted).toContain('genuinely limited to these tool selectors')

    // Trusted runs --dangerously-skip-permissions, so the list is an
    // auto-approve hint. Calling it a restriction made sessions refuse work
    // they could do and then invent downstream outages to explain the refusal.
    const trusted = claudeToolCapabilityPrompt(['WebSearch'], 'trusted')
    expect(trusted).not.toContain('genuinely limited')
    expect(trusted).toContain('NOT an inventory')
    expect(trusted).toContain('PROBE first')
    expect(trusted).toContain('load LAZILY')
  })

  it('claims the COS Python pipeline only when it is actually configured', () => {
    // COS_SCRIPTS_DIR is optional and unset on standalone installs, which is
    // most public users. Promising scripts that are absent is the same defect
    // inverted — the session trusts the header and over-claims instead of
    // over-refusing.
    const prior = process.env.COS_SCRIPTS_DIR
    try {
      delete process.env.COS_SCRIPTS_DIR
      expect(claudeToolCapabilityPrompt(['WebSearch'], 'trusted'))
        .not.toContain('COS Python scripts')

      // A real directory — the gate stats the path rather than trusting the
      // variable, so a stale/typo'd value must not license the claim.
      process.env.COS_SCRIPTS_DIR = '/tmp'
      expect(claudeToolCapabilityPrompt(['WebSearch'], 'trusted'))
        .toContain('COS Python scripts')

      process.env.COS_SCRIPTS_DIR = '/nonexistent/cos-scripts'
      expect(claudeToolCapabilityPrompt(['WebSearch'], 'trusted'))
        .not.toContain('COS Python scripts')
    } finally {
      if (prior === undefined) delete process.env.COS_SCRIPTS_DIR
      else process.env.COS_SCRIPTS_DIR = prior
    }
  })

  it('fails closed when an explicit MCP config file is missing', () => {
    expect(() => claudeMcpConfigArgs({ COS_CLAUDE_MCP_CONFIG: '/missing/cos-mcp.json' }))
      .toThrow(/not a readable file/i)
  })

  it('migrates legacy MCP server scopes, rejects local tools, and warns once', () => {
    const env = {
      COS_EXTRA_TOOLS: 'mcp__google-workspace,mcp__pubmed-server,Read,Glob,Grep',
    }
    expect(parseClaudeExtraToolConfiguration(env)).toEqual({
      accepted: ['mcp__google-workspace__*', 'mcp__pubmed-server__*'],
      rejected: ['Read', 'Glob', 'Grep'],
      migrated: [
        { from: 'mcp__google-workspace', to: 'mcp__google-workspace__*' },
        { from: 'mcp__pubmed-server', to: 'mcp__pubmed-server__*' },
      ],
    })

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reportClaudeExtraToolConfiguration(env)
    reportClaudeExtraToolConfiguration(env)
    expect(warning).toHaveBeenCalledTimes(2)
    expect(warning.mock.calls[0]?.join(' ')).toMatch(/Migrated legacy/i)
    expect(warning.mock.calls[1]?.join(' ')).toMatch(/Ignored unsafe or invalid/i)
    expect(warning.mock.calls[1]?.join(' ')).toMatch(/Read.*Glob.*Grep/i)
    warning.mockRestore()
  })

  it('does not warn for an empty or fully valid selector configuration', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reportClaudeExtraToolConfiguration({})
    reportClaudeExtraToolConfiguration({ COS_EXTRA_TOOLS: 'mcp__calendar__list,mcp__calendar__*' })
    expect(warning).not.toHaveBeenCalled()
    warning.mockRestore()
  })

  // ── read-only contract (Cursor ask-mode, Codex read-only) ──────────────────
  // Every defect the 6.18.3 QA pass found lived on these paths, which had ZERO
  // assertions. One test per invariant they violated.
  describe('read-only capability contract', () => {
    const prior = process.env.COS_SCRIPTS_DIR
    afterEach(() => {
      if (prior === undefined) delete process.env.COS_SCRIPTS_DIR
      else process.env.COS_SCRIPTS_DIR = prior
    })

    it('never denies script runs and promises COS scripts in the same breath', () => {
      // Cursor ask-mode exposes no shell. The shared body used to claim
      // "read-only COS scripts are still reachable here" right after the detail
      // line said script runs cannot happen — two contradictory sentences.
      delete process.env.COS_SCRIPTS_DIR
      const prompt = readOnlyCapabilityPrompt(
        'Cursor ask-mode',
        'Cursor ask-mode does not expose file-write or shell tools, so edits, commits, deploys, and script runs genuinely cannot happen here.',
      )
      expect(prompt).toContain('script runs genuinely cannot happen here')
      expect(prompt).not.toContain('COS scripts are still reachable')
      expect(prompt).toContain('Connected MCP servers are still reachable here')
    })

    it('names the COS pipeline only when COS_SCRIPTS_DIR is a real directory', () => {
      process.env.COS_SCRIPTS_DIR = '/nonexistent/path/for/test'
      expect(readOnlyCapabilityPrompt('X', 'detail')).not.toContain('COS scripts')
      // A stale or typo'd path must not license the claim — the header is
      // something the session trusts, so env-set is not the same as installed.
      process.env.COS_SCRIPTS_DIR = '/tmp'
      expect(readOnlyCapabilityPrompt('X', 'detail')).toContain('read-only COS scripts are still reachable')
    })

    it('never offers the surface it is running on as the escalation target', () => {
      // A Codex read-only session used to be told to "re-run on ... Codex/GPT",
      // i.e. itself — and Codex is read-only BY DEFAULT.
      const codex = readOnlyCapabilityPrompt(
        'Codex/GPT',
        'detail',
        'Opus (switch the model to Opus and ask again)',
      )
      const offer = codex.slice(codex.indexOf('offer to re-run it on'))
      expect(offer).toContain('Opus')
      expect(offer.slice(0, offer.indexOf('instead of attempting'))).not.toContain('Codex/GPT')
    })

    it('carries the unconditional honesty clause and the lazy-MCP clause', () => {
      const prompt = readOnlyCapabilityPrompt('Cursor ask-mode', 'detail')
      expect(prompt).toContain(TOOL_HONESTY_CLAUSE)
      expect(prompt).toContain('not fetched yet')
      expect(prompt).toContain('READ-ONLY Cursor ask-mode path')
    })
  })
})
