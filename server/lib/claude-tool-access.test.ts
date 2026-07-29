import { describe, expect, it, vi } from 'vitest'
import {
  buildClaudeToolList,
  claudeMcpConfigArgs,
  claudeToolCapabilityPrompt,
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

      process.env.COS_SCRIPTS_DIR = '/tmp/cos-scripts'
      expect(claudeToolCapabilityPrompt(['WebSearch'], 'trusted'))
        .toContain('COS Python scripts')
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
})
