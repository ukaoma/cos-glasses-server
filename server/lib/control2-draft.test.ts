import { describe, expect, it, vi } from 'vitest'
import { control2DraftArgs, parseControl2DraftText, prepareControl2Draft, renderControl2Draft } from './control2-draft.js'

describe('Control 2 no-tool draft boundary', () => {
  it.each(['null', '[]', '{"title":"x","body":"y","path":"/tmp/evil"}', '{"title":"x","body":5}', '{"title":"","body":"y"}', '```json\n{}\n```'])('rejects noncontract model output', raw => expect(() => parseControl2DraftText(raw)).toThrow())
  it('rejects excessive content and control characters', () => {
    expect(() => parseControl2DraftText(JSON.stringify({ title: 'x', body: 'a'.repeat(8001) }))).toThrow()
    expect(() => parseControl2DraftText(JSON.stringify({ title: 'x', body: 'a\u0000b' }))).toThrow()
  })
  it('renders path/command/script requests as inert escaped text with restrictive CSP', () => {
    const html = renderControl2Draft({ title: '<script>evil()</script>', body: '$(touch /tmp/evil)\n<img src="https://evil.invalid" onerror="evil()">' })
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('$(touch /tmp/evil)')
    expect(html).toContain("default-src 'none'; base-uri 'none'; form-action 'none'")
  })
  it('pins no tools, safe mode, no MCP, no persistence, one turn and a budget', () => {
    const args = control2DraftArgs('opus')
    for (const flag of ['--safe-mode', '--strict-mcp-config', '--no-session-persistence']) expect(args).toContain(flag)
    for (const [flag, value] of [['--tools', ''], ['--allowedTools', ''], ['--permission-mode', 'dontAsk'], ['--max-turns', '1'], ['--max-budget-usd', '1.00'], ['--model', 'opus[1m]']]) expect(args[args.indexOf(flag) + 1]).toBe(value)
  })
  it('is disabled unless explicitly enabled', async () => {
    vi.stubEnv('COS_CONTROL2_DRAFT_ENABLED', '0')
    await expect(prepareControl2Draft({ instruction: 'draft' })).rejects.toThrow('draft_disabled')
    vi.unstubAllEnvs()
  })
})
