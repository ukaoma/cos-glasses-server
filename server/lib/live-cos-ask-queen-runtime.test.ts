// 6.76.2: a person question on a Mac set up like Queen's. The REAL public memory runtime this package ships
// (memory-runtime/cos-memory-runtime-0.1.0.tar.gz) is installed in a scratch dir with one accepted note, and the Live COS
// Ask runs its default COS search against it. Before 6.76.2 searchMemories found nothing there: the runtime's
// bot_memory.py has no `search` command (meaning: memory_parse_error) and the note is not a markdown file (keyword: none).
// COS_SCRIPTS_DIR is read when python-bridge.ts loads, so the runtime is installed before any import.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const root = mkdtempSync(join(tmpdir(), 'ask-queen-'))
const home = join(root, 'home'), notes = join(root, 'notes'), data = join(root, 'data')
for (const d of [home, data]) mkdirSync(d, { recursive: true })
const tarball = new URL('../../memory-runtime/cos-memory-runtime-0.1.0.tar.gz', import.meta.url).pathname
const runtime = join(root, 'cos-memory-runtime-0.1.0')
const env = { ...process.env, HOME: home }
function sh(cmd: string, args: string[], input?: string): string {
  const r = spawnSync(cmd, args, { cwd: runtime, env, input, encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed (${r.status}): ${r.stderr || r.stdout}`)
  return r.stdout
}
{
  const x = spawnSync('tar', ['xzf', tarball, '-C', root], { encoding: 'utf8' })
  if (x.status !== 0) throw new Error('could not extract the memory runtime: ' + x.stderr)
}
sh('python3', [join(runtime, 'install.py'), '--data-root', notes])
const py = join(runtime, 'venv', 'bin', 'python3')
const captured = JSON.parse(sh(py, ['cos_api_bridge.py', 'memory-capture'], JSON.stringify({ id: 'mem_delgado', idempotency_key: 'k1', source_refs: [],
  content: 'Delgado is the pool contractor for the backyard. He quoted 18500 for the resurfacing and wants a deposit by Friday.' }))) as { revision?: number; error?: string }
if (captured.error) throw new Error('capture refused: ' + captured.error)
const accepted = JSON.parse(sh(py, ['cos_api_bridge.py', 'memory-workspace'], JSON.stringify({ action: 'review_memory', id: 'mem_delgado', decision: 'accept', expected_revision: captured.revision ?? 1, idempotency_key: 'r1' }))) as { error?: string }
if (accepted.error) throw new Error('accept refused: ' + accepted.error)
const saved = { ...process.env }
Object.assign(process.env, { COS_SCRIPTS_DIR: runtime, HOME: home, COS_DATA_DIR: data, COS_PROFILE_PATH: join(data, '.cos-profile.json') })
delete process.env.COS_CONTEXT_DIR

const { createLiveAsk, normalizeAsk, searchAskHistory } = await import('./live-cos-ask.js')
const { searchMemories } = await import('./context-library-search.js')
afterAll(() => { process.env = saved; rmSync(root, { recursive: true, force: true }) })

describe('Live COS Ask on the public memory runtime', () => {
  it('searchMemories alone still finds nothing there (the gap 6.76.2 closes)', async () => {
    const meaning = await searchMemories({ query: 'Delgado', limit: 3 })
    expect(meaning).toMatchObject({ hits: [], semanticAvailable: false, semanticReason: 'memory_parse_error' })
    expect((await searchMemories({ query: 'Delgado', limit: 3, semantic: false })).hits).toEqual([])
  })

  it('a person question is answered from the owner\'s note, cited as COS memory, timed and disclosed', async () => {
    const prompts: Array<Record<string, any>> = []
    const run = async (prompt: string) => {
      prompts.push(JSON.parse(prompt))
      return { text: JSON.stringify({ sections: [{ label: 'So what', text: 'Delgado is your pool contractor; he quoted 18500 for the resurfacing and wants a deposit by Friday [H1].' }],
        confidence: { level: 'supported', reason: 'From your COS memory note.' } }), model: 'claude-haiku' }
    }
    const phases: Array<{ phase: string; ms: number; results?: number; forced?: true }> = []
    const ask = createLiveAsk({ run, now: () => 5000, phases: phases as never })
    const result = await ask(normalizeAsk({ sessionId: 'meeting_queen_1', action: 'ask', question: 'Who is Delgado?', elapsedMs: 60_000,
      turns: [{ id: 1, speaker: 'Person A', elapsedMs: 30_000, text: 'Delgado is coming by Friday about the deposit.' }] }))
    const evidence = prompts[0].evidence as Array<{ id: string; kind: string; text: string; memoryId?: string }>
    expect(evidence.find(s => s.id === 'H1')).toMatchObject({ kind: 'memory', memoryId: 'mem_delgado', text: expect.stringContaining('pool contractor') })
    expect(prompts[0].cosLookups).toEqual([{ query: 'Delgado', searched: 'COS memories and earlier meetings', results: 1 }])
    expect(result.answer).toContain('pool contractor')
    expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'H1', kind: 'memory', memoryId: 'mem_delgado' })]))
    expect(result.notices).toContain('COS also searched the notes in its memory list by keyword.')
    expect(phases.find(p => p.phase === 'cos_search')).toMatchObject({ forced: true, results: 1 })
  })

  it('a question the note does not match still gets the existing empty wording', async () => {
    expect(await searchAskHistory('Patel', undefined, new AbortController().signal)).toEqual({ sources: [],
      notices: ['COS memory semantic search is unavailable; local keyword results are shown.', 'Earlier meeting semantic search is unavailable; local keyword results are shown.', 'No relevant COS history was found.'] })
  })
})
