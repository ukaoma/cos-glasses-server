// 6.86.0: no server log line carries what someone said. 6.85.0 took the transcript out of the
// per-chunk [perf] TOTAL line (transcribe-stream-log-privacy.test.ts); five more lines still
// printed it: three [hallucination] drops, the dictation tail_drop and the fuzzy-correct pairs.
// They now log a reason and a count.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyFuzzyCorrections } from '../lib/fuzzy-correct.js'

const ROOT = join(import.meta.dirname, '..', '..')

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(path)
  }
  return out
}

/** A console call whose template interpolates a slice of a text-like value: the shape all five lines had. */
const TEXT_IN_LOG = /console\.(log|info|warn|error|debug)\(.*\$\{[\w.?]*(text|Text|transcript|Transcript)[\w.?]*\.slice\(/

afterEach(() => vi.restoreAllMocks())

describe('transcript text stays out of the server log (6.86.0)', () => {
  it('no console call in server/ or shared/ prints a slice of transcript or dictation text', () => {
    const hits: string[] = []
    for (const dir of ['server', 'shared']) {
      for (const file of sources(join(ROOT, dir))) {
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (TEXT_IN_LOG.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}`)
        })
      }
    }
    expect(hits).toEqual([])
  })

  it('the scan sees a line of the old shape (it can fail)', () => {
    expect(TEXT_IN_LOG.test('console.log(`[hallucination] Dropped (x): "${trimmedText.slice(0, 60)}"`)')).toBe(true)
    expect(TEXT_IN_LOG.test("console.warn(`[prompt-draft] tail_drop (r): \"${drop.text.slice(0, 100)}\"`)")).toBe(true)
    expect(TEXT_IN_LOG.test('console.log(`[hallucination] Dropped (x): chars=${trimmedText.length}`)')).toBe(false)
  })

  it('the five lines log a character count instead', () => {
    const stream = readFileSync(join(ROOT, 'server/routes/transcribe-stream.ts'), 'utf8')
    expect(stream.match(/\[hallucination\] (Dropped|Filtered)[^\n]*chars=\$\{(trimmedText|rawText)\.length\}/g)).toHaveLength(3)
    const drafts = readFileSync(join(ROOT, 'server/routes/prompt-drafts.ts'), 'utf8')
    expect(drafts).toMatch(/\[prompt-draft\] tail_drop[^\n]*chars=\$\{drop\.text\.length\}/)
  })

  it('fuzzy-correct logs how many words it fixed, never which', () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
    const out = applyFuzzyCorrections('We met with the Brightwatr team about the renewal', ['Brightwater'])
    expect(out.replacements).toBe(1)
    expect(out.text).toContain('Brightwater')
    const fuzzy = lines.filter(line => line.startsWith('[fuzzy-correct]'))
    expect(fuzzy).toEqual(['[fuzzy-correct] Applied 1 correction(s)'])
    expect(lines.join('\n')).not.toMatch(/Brightwat|renewal/)
  })
})
