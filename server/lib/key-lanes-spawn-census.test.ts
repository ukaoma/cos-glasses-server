// Key lanes K1, QA C7: the K0 spawn census (server/lib/__fixtures__/key-lanes/census.json,
// generated at 6237057) read back against this tree. Every provider spawn the census found still
// exists, carries the class the census gave it, and the seven spawns the plan's 6.1 table missed
// are classified here with the reason each one is safe. Every Claude spawn that can use tools
// carries the key-secrets deny layer (QA B1); every other one has no tools. A NEW provider spawn
// anywhere in server/lib or server/routes fails this test until it is classified. Source shape on
// purpose: a spawn site is a fact about the source, and each guard's behaviour has its own test.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SERVER = join(import.meta.dirname, '..')
const REPO = join(SERVER, '..')
const census = JSON.parse(readFileSync(join(SERVER, 'lib', '__fixtures__', 'key-lanes', 'census.json'), 'utf8')) as {
  serverSpawn: { spawnCallLines: Array<{ file: string; line: number; text: string; class: string; binary?: string; note?: string }>; providerSpawnLinesNotInPlanTable: string[] }
}
const provider = census.serverSpawn.spawnCallLines.filter(l => l.class !== 'non_provider')
const src = (file: string) => readFileSync(join(REPO, file), 'utf8')
/** P11 inserted the guard into one spawn line; the census text is matched without it. */
const unguard = (s: string) => s.split('...claudeKeySecretsGuardArgs(), ').join('')

/** QA C7: the seven provider spawns not in plan 6.1, each with why it is safe under key lanes. */
const NOT_IN_PLAN: Record<string, string> = {
  'server/lib/claude-cli-support.ts:17': 'claude --help capability probe: no prompt, no tools, no credential use',
  'server/lib/claude-cli-support.ts:48': 'claude --help capability probe: no prompt, no tools, no credential use',
  'server/lib/cursor-bridge.ts:368': 'Cursor turn: Cursor has no key lane; the server env never holds a key',
  'server/lib/live-cues-cursor.ts:78': 'Cursor live cues: Lane A only; the server env never holds a key',
  'server/lib/meeting-summary.ts:371': 'injected spawnClaudeText (prompt-edit.ts), which carries the deny layer',
  'server/lib/provider-proof.ts:62': 'provider proof: --tools "" and --allowedTools "" (no tool can read a file)',
  'server/lib/session-halt.ts:136': 'pass-through wrapper: attach and fork pass their own argv, both carry the deny layer',
}

/** Claude spawns whose argv can use tools: each must carry claudeKeySecretsGuardArgs(). */
const TOOL_CAPABLE_CLAUDE = [
  'server/lib/claude-bridge.ts',          // turn and prewarm
  'server/lib/archive.ts',
  'server/lib/prompt-edit.ts',
  'server/lib/attached-provider-adapter.ts',
  'server/lib/fork-thread.ts',
]
/** Claude spawns with no tools at all (the argv builder sets --tools ''), or only WebSearch. */
const TOOL_LESS_CLAUDE: Record<string, RegExp> = {
  'server/lib/lens-gist-engines.ts': /'--tools', ''/,
  'server/lib/dictation-clean.ts': /'--tools', ''/,
  'server/lib/control2-draft.ts': /'--tools', ''/,
  'server/lib/provider-proof.ts': /'--tools', ''/,
  'server/lib/meeting-ask-web.ts': /'--tools', 'WebSearch'/,
}

describe('key lanes spawn census (QA C7)', () => {
  it('every provider spawn the K0 census found still exists in its file', () => {
    expect(provider.length).toBe(23)
    // The call itself is matched (P4 wrapped the Codex turn spawn in a revoke-on-throw helper).
    const call = (t: string) => t.replace(/^(?:const |let )?\w+ = /, '')
    for (const l of provider) expect(unguard(src(l.file)), `${l.file}:${l.line} ${l.text.slice(0, 60)}`).toContain(call(l.text))
  })

  it('the seven spawns the plan table missed are each classified with a reason', () => {
    expect(new Set(census.serverSpawn.providerSpawnLinesNotInPlanTable)).toEqual(new Set(Object.keys(NOT_IN_PLAN)))
    for (const reason of Object.values(NOT_IN_PLAN)) expect(reason.length).toBeGreaterThan(20)
  })

  it('every tool-capable Claude spawn carries the key-secrets deny layer; the others have no tools', () => {
    for (const f of TOOL_CAPABLE_CLAUDE) expect(src(f), f).toMatch(/\.\.\.claudeKeySecretsGuardArgs\(\)/)
    // claude-bridge: the turn and the prewarm both.
    expect(src('server/lib/claude-bridge.ts').split('claudeKeySecretsGuardArgs()').length - 1).toBe(2)
    for (const [f, re] of Object.entries(TOOL_LESS_CLAUDE)) expect(src(f), f).toMatch(re)
  })

  it('no Claude spawn exists outside the census and the two lists above (a new one fails here)', () => {
    const known = new Set([...provider.map(l => l.file), ...TOOL_CAPABLE_CLAUDE, ...Object.keys(TOOL_LESS_CLAUDE)])
    const hits: string[] = []
    for (const dir of ['server/lib', 'server/routes']) {
      for (const name of readdirSync(join(REPO, dir))) {
        if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
        // Code only: a comment that quotes a spawn is not one.
        const text = src(`${dir}/${name}`).split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')
        if (/(?:spawn|execFile|spawnSync)\(\s*'claude'/.test(text) || /buildClaude\w*Args\(/.test(text) && /spawn\(/.test(text)) hits.push(`${dir}/${name}`)
      }
    }
    for (const h of hits) expect(known.has(h), `${h} spawns Claude and is not classified`).toBe(true)
  })
})
