/**
 * 6.83.1 canary: spoken links, slugs, emails, ordinary "slash" speech and formatting
 * instructions, through the real polish caller (autoCleanDictation, the subscription
 * `claude -p` CLI) and the same steps, in the same order, as the outbound dictation pass in
 * routes/prompt-drafts.ts. Synthetic dictation only; nothing here was spoken by a real person.
 * Not shipped in the npm package.
 *
 *   COS_DATA_DIR=$(mktemp -d) COS_PROFILE_PATH=<scratch>/p.json npx tsx server/scripts/dictation-format-eval.ts \
 *     --arm before|after [--set canary|regression|preserve] [--max-calls 60] [--out results.json]
 *
 * Arms:
 * - before: 6.83.0 behaviour. corrections, filler pass, prompt v2 (byte-identical to 6.83.0,
 *   pinned by hash in dictation-clean.test.ts), no spoken-path rule, no link guard, and no
 *   dictionary entry for "/pricing" (6.83.0 refused it).
 * - after: 6.83.1. the dictionary holds "forward slash pricing" written "/pricing" (for the
 *   case that says so), spoken-path rule, prompt v3, link guard.
 * Order omissions: the route also runs negative rules and the fuzzy name pass before the filler
 * pass; this script does not (no vocabulary targets in these cases). The after arm's link guard
 * gets the vocabulary as known spellings, as the route does.
 * Every model call spends the polish budget's "message" bucket in this scratch data dir
 * (recordPolishCall), is capped by --max-calls, and the run stops after 3 consecutive failures.
 */
import { writeFileSync } from 'node:fs'
import { autoCleanDictation, type DictationPolishPromptVersion } from '../lib/dictation-clean.js'
import { stripDisfluencies } from '../lib/dictation-fillers.js'
import { renderSpokenPaths, polishLinkProblem, linkTokens } from '../lib/dictation-format.js'
import { polishBudgetExhausted, recordPolishCall } from '../lib/dictation-polish-budget.js'
import { correctionOnlyForms } from '../lib/glossary-learn.js'
import { CASES as REGRESSION, VOCABULARY, scoreCase, summarize, type RunRow } from './dictation-polish-eval.js'

export interface FormatCase {
  id: string
  category: 'slug' | 'multi_slug' | 'url' | 'email' | 'ordinary' | 'instruction' | 'dictionary' | 'list_time'
  input: string
  /** Every one must be present (exact, case-sensitive). A RegExp for case-insensitive checks. */
  must?: Array<string | RegExp>
  mustNot?: Array<string | RegExp>
  /** Link tokens allowed in the answer; anything else is an invented link. Omitted: none allowed. */
  links?: string[]
  /** The person taught the dictionary these (after arm only; 6.83.0 refused them). */
  dictionary?: Record<string, string>
  /** Input words the answer may drop or rewrite (an instruction, a number written as digits). */
  optional?: string[]
}

export const CANARY: FormatCase[] = [
  // One-word slugs.
  { id: 's01', category: 'slug', input: 'go to forward slash pricing to compare plans', must: ['/pricing'], mustNot: [/forward slash/i], links: ['/pricing'] },
  { id: 's02', category: 'slug', input: 'the form lives on forward slash demo', must: ['/demo'], mustNot: [/forward slash/i], links: ['/demo'] },
  { id: 's03', category: 'slug', input: 'send them to forward slash contact, then follow up', must: ['/contact'], mustNot: [/forward slash/i], links: ['/contact'] },
  { id: 's04', category: 'slug', input: 'Forward slash careers is where the jobs are', must: ['/careers'], mustNot: [/forward slash/i], links: ['/careers'] },
  { id: 's05', category: 'slug', input: 'check forward slash blog for the new post', must: ['/blog'], mustNot: [/forward slash/i], links: ['/blog'] },
  // Multi-word slugs.
  { id: 'm01', category: 'multi_slug', input: 'There are a few key conversion points that we have in our funnel, demo, forward slash pricing, forward slash build and price, all of which result in a lead or a contact that exists inside of our CRM.', must: ['/pricing', '/build-and-price', 'CRM'], mustNot: [/forward slash/i], links: ['/pricing', '/build-and-price', '/demo'] },
  { id: 'm02', category: 'multi_slug', input: 'point the ad at forward slash free trial', must: ['/free-trial'], mustNot: [/forward slash/i], links: ['/free-trial'] },
  { id: 'm03', category: 'multi_slug', input: 'link to forward slash case studies and forward slash customer stories', must: ['/case-studies', '/customer-stories'], mustNot: [/forward slash/i], links: ['/case-studies', '/customer-stories'] },
  { id: 'm04', category: 'multi_slug', input: 'update forward slash schedule a demo, it has a typo', must: ['/schedule-a-demo', 'typo'], mustNot: [/forward slash/i], links: ['/schedule-a-demo'] },
  { id: 'm05', category: 'multi_slug', input: 'move forward slash help slash billing to the footer', must: ['/help/billing', 'footer'], mustNot: [/forward slash/i], links: ['/help/billing'] },
  { id: 'm06', category: 'multi_slug', input: 'redirect forward slash old pricing to forward slash pricing', must: ['/old-pricing', '/pricing'], mustNot: [/forward slash/i], links: ['/old-pricing', '/pricing'] },
  // URLs and domains.
  { id: 'u01', category: 'url', input: 'the site is bottle pos dot com slash pricing', must: ['bottlepos.com/pricing'], links: ['bottlepos.com/pricing'] },
  { id: 'u02', category: 'url', input: 'go to w w w dot example dot com', must: ['www.example.com'], links: ['www.example.com'] },
  { id: 'u03', category: 'url', input: 'our docs live at docs dot example dot io', must: ['docs.example.io'], links: ['docs.example.io'] },
  { id: 'u04', category: 'url', input: 'use https colon slash slash example dot com slash signup', must: ['https://example.com/signup'], links: ['https://example.com/signup'] },
  { id: 'u05', category: 'url', input: 'the staging site is staging dash shop dot example dot com', must: ['staging-shop.example.com'], links: ['staging-shop.example.com'] },
  // Emails and file names.
  { id: 'e01', category: 'email', input: 'email me at sam at example dot com', must: ['sam@example.com'], links: ['sam@example.com'] },
  { id: 'e02', category: 'email', input: 'cc jordan dot lee at example dot org on it', must: ['jordan.lee@example.org'], links: ['jordan.lee@example.org'] },
  { id: 'e03', category: 'email', input: 'the reply address is support at sign example dot com', must: ['support@example.com'], links: ['support@example.com'] },
  { id: 'e04', category: 'email', input: 'name the file q3 underscore report dot pdf', must: ['q3_report.pdf'], links: [] },
  // Ordinary speech: no links, nothing invented.
  { id: 'o01', category: 'ordinary', input: 'we need to slash prices before the holiday', must: [/slash prices/i], mustNot: ['/'] },
  { id: 'o02', category: 'ordinary', input: 'bring red and slash or blue samples', must: [/red/i, /blue/i] },
  { id: 'o03', category: 'ordinary', input: 'meet me at the office at noon', must: [/at the office at noon/i], mustNot: ['@'] },
  { id: 'o04', category: 'ordinary', input: 'add a dash of salt to the sauce', must: [/a dash of salt/i] },
  { id: 'o05', category: 'ordinary', input: 'she ran the hundred meter dash in record time', must: [/dash in record time/i], optional: ['hundred', 'meter'] },
  { id: 'o06', category: 'ordinary', input: 'check our website for the pricing', must: [/website/i, /pricing/i], mustNot: ['/', '.com', 'www'] },
  { id: 'o07', category: 'ordinary', input: 'ask Priya to update the pricing page', must: [/pricing page/i], mustNot: ['/pricing'] },
  { id: 'o08', category: 'ordinary', input: 'press the forward slash key to search', must: [/forward slash key|\/ key|"\/" key/i] , links: [] },
  // 6.83.1 QA W1: "forward slash" said about the character, not a page.
  { id: 'w01', category: 'ordinary', input: 'separate them with forward slash instead of commas', must: [/instead of commas/i], mustNot: ['/instead'] },
  { id: 'w02', category: 'ordinary', input: 'type forward slash twice to open the menu', must: [/twice/i], mustNot: ['/twice'] },
  { id: 'w03', category: 'ordinary', input: 'the old paths need forward slash everywhere', must: [/everywhere/i], mustNot: ['/everywhere'] },
  { id: 'w04', category: 'ordinary', input: 'press forward slash once and wait', must: [/once/i], mustNot: ['/once'] },
  { id: 'w05', category: 'ordinary', input: 'you will see two forward slash marks in the url', must: [/marks/i], mustNot: ['/marks'] },
  { id: 'w06', category: 'ordinary', input: 'use forward slash too, not just dashes', must: [/too/i], mustNot: ['/too'] },
  { id: 'w07', category: 'ordinary', input: 'the critical path is the pricing page', must: [/critical path/i, /pricing page/i], mustNot: ['/pricing'] },
  // Formatting instructions inside the dictation.
  { id: 'i01', category: 'instruction', input: 'format these as slugs: pricing, build and price, schedule demo', must: ['build-and-price', 'schedule-demo'], mustNot: [/format these/i], links: ['/pricing', '/build-and-price', '/schedule-demo'], optional: ['format', 'these', 'as', 'slugs'] },
  { id: 'i02', category: 'instruction', input: 'put this next part in all caps: do not ship on Friday', must: ['DO NOT SHIP ON FRIDAY'], mustNot: [/all caps/i], optional: ['put', 'this', 'next', 'part', 'in', 'all', 'caps'] },
  { id: 'i03', category: 'instruction', input: 'write a reply to Dana in all caps saying thanks', must: [/all caps/i, /Dana/] },
  { id: 'i04', category: 'instruction', input: 'the heading should read launch week, in quotes', must: [/["“]launch week[.,]?["”]/i], mustNot: [/in quotes/i], optional: ['in', 'quotes'] },
  // The dictionary entry Miles tried to teach (6.83.0 refused it).
  { id: 'd01', category: 'dictionary', input: 'we track demo, forward slash pricing, and the cart', dictionary: { 'forward slash pricing': '/pricing' }, must: ['/pricing', 'cart'], mustNot: [/forward slash/i, 'demo/pricing'], links: ['/pricing'] },
  // 6.91.0 S9 (added, not yet run): lists and spoken times the prompt asks for, which the meaning
  // guard must let through on Sonnet v4 (dictation-meaning-guard.test.ts pins the guard side).
  { id: 'l01', category: 'list_time', input: 'numbered list draft the brief new line get approval new line ship it', must: [/^1[.)] /m, /^2[.)] /m, /^3[.)] /m], mustNot: [/numbered list/i, /new line/i], optional: ['numbered', 'list', 'new', 'line'] },
  { id: 'l02', category: 'list_time', input: 'number one draft the brief number two get approval', must: [/^1[.)] /m, /^2[.)] /m], mustNot: [/number one/i, /number two/i], optional: ['number', 'one', 'two'] },
  { id: 'l03', category: 'list_time', input: 'bullet points draft the brief new line get approval', must: [/^[-•*] /m], mustNot: [/bullet points/i, /new line/i], optional: ['bullet', 'points', 'new', 'line'] },
  { id: 't01', category: 'list_time', input: 'meet Dana at half past ten in the lobby', must: [/10:30|half past ten/i, 'Dana', /lobby/i], optional: ['half', 'past', 'ten'] },
  { id: 't02', category: 'list_time', input: 'call Marco at quarter to five', must: [/4:45|quarter to five/i, 'Marco'], optional: ['quarter', 'to', 'five'] },
]

const test = (text: string, p: string | RegExp) => typeof p === 'string' ? text.includes(p) : p.test(text)

/** Spoken formatting words: rendered as marks, so they may leave the text. */
const FORMAT_WORDS = new Set(['forward', 'slash', 'dot', 'at', 'sign', 'dash', 'underscore', 'colon', 'w', 'www', 'https', 'http', 'hyphen', 'backslash'])
const compactText = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

export function scoreFormat(c: FormatCase, output: string): { pass: boolean; formatOk: boolean; contentKept: boolean; misses: string[] } {
  const misses: string[] = []
  for (const p of c.must ?? []) if (!test(output, p)) misses.push(`missing ${p}`)
  for (const p of c.mustNot ?? []) if (test(output, p)) misses.push(`has ${p}`)
  const allowed = new Set((c.links ?? []).map(l => l.toLowerCase()))
  for (const token of linkTokens(output)) if (!allowed.has(token.toLowerCase())) misses.push(`invented ${token}`)
  const formatOk = misses.length === 0
  // Every other word the speaker said must survive (in a slug or email its letters still do).
  const kept = compactText(output)
  const optional = new Set((c.optional ?? []).map(w => w.toLowerCase()))
  const dropped = [...new Set(c.input.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))]
    .filter(w => !FORMAT_WORDS.has(w) && !optional.has(w) && !kept.includes(w))
  if (dropped.length) misses.push(`dropped ${dropped.join(' ')}`)
  return { pass: misses.length === 0, formatOk, contentKept: dropped.length === 0, misses }
}

export function scoreCanary(rows: Array<{ id: string; output: string | null; deterministic: string; refused?: string }>) {
  const byCategory: Record<string, { pass: number; formatOk: number; of: number }> = {}
  let pass = 0, formatOk = 0, contentKept = 0, detFormatOk = 0, answered = 0
  const failures: string[] = []
  for (const row of rows) {
    const c = CANARY.find(x => x.id === row.id)!
    const cat = (byCategory[c.category] ??= { pass: 0, formatOk: 0, of: 0 })
    cat.of++
    if (scoreFormat(c, row.deterministic).formatOk) detFormatOk++
    if (row.output === null) continue
    answered++
    const s = scoreFormat(c, row.output)
    if (s.pass) { cat.pass++; pass++ }
    if (s.formatOk) { cat.formatOk++; formatOk++ }
    if (s.contentKept) contentKept++
    if (!s.pass) failures.push(`${row.id} ${s.misses.join('; ')}`)
  }
  return { answered, of: rows.length, pass, formatOk, contentKept, deterministicOnlyFormatOk: detFormatOk, refusedByGuard: rows.filter(r => r.refused).length, byCategory, failures }
}

/** The real correction pass (whisper-local applyCorrections) over a scratch profile holding only this case's dictionary. */
async function applyDictionary(text: string, dictionary: Record<string, string>): Promise<string> {
  const { applyCorrections, resetDecoderCaches } = await import('../lib/whisper-local.js')
  const { clearProfileCache } = await import('../lib/profile.js')
  const path = process.env.COS_PROFILE_PATH
  if (!path) throw new Error('Set COS_PROFILE_PATH to a scratch file')
  writeFileSync(path, JSON.stringify({ vocabulary: VOCABULARY, whisper_corrections: JSON.stringify(dictionary) }))
  clearProfileCache()
  resetDecoderCaches()
  return text ? applyCorrections(text) : text
}

/**
 * 6.92.0 (plan r3, A-W0c): the default --max-calls covers the largest set (regression, 50 cases), so
 * a default run never refuses itself (it was 40, under the canary's 45). Pinned by
 * dictation-eval-harness.test.ts.
 */
export const FORMAT_DEFAULT_MAX_CALLS = 50

async function main() {
  const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : fallback
  }
  const scoreOnly = arg('score-only', '')
  if (scoreOnly) {
    const { readFileSync } = await import('node:fs')
    console.log(JSON.stringify(scoreCanary(JSON.parse(readFileSync(scoreOnly, 'utf8'))), null, 2))
    return
  }
  const arm = arg('arm', 'after') as 'before' | 'after'
  const set = arg('set', 'canary')
  const maxCalls = Number(arg('max-calls', String(FORMAT_DEFAULT_MAX_CALLS)))
  const outFile = arg('out', `dictation-format-eval-${arm}-${set}.json`)
  const model = arg('model', 'haiku')
  // 6.91.0: --prompt v3|v4 picks the after arm's prompt (default v3, the 6.83.1 arm).
  const version: DictationPolishPromptVersion = arm === 'before' ? 'v2' : (arg('prompt', 'v3') as DictationPolishPromptVersion)
  process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE = String(maxCalls)
  if (!process.env.COS_DATA_DIR) throw new Error('Set COS_DATA_DIR to a scratch directory')

  const jobs: Array<{ id: string; input: string; dictionary?: Record<string, string> }> =
    set === 'canary' ? CANARY.map(c => ({ id: c.id, input: c.input, dictionary: arm === 'after' ? c.dictionary : undefined }))
      : set === 'preserve' ? REGRESSION.filter(c => c.category === 'preserve').map(c => ({ id: c.id, input: c.input }))
        : REGRESSION.map(c => ({ id: c.id, input: c.input }))
  const only = arg('only', '').split(',').filter(Boolean)
  if (only.length) jobs.splice(0, jobs.length, ...jobs.filter(j => only.includes(j.id)))
  if (jobs.length > maxCalls) throw new Error(`${jobs.length} calls exceeds --max-calls ${maxCalls}`)

  if (process.argv.includes('--dry')) {
    for (const job of jobs) {
      let pre = stripDisfluencies(await applyDictionary(job.input, job.dictionary ?? {}))
      if (arm === 'after') pre = renderSpokenPaths(pre)
      console.log(`${job.id}\t${pre}`)
    }
    return
  }
  const rows: Array<RunRow & { pre: string; deterministic: string; refused?: string; polished?: string }> = []
  let consecutiveFailures = 0
  if (arm === 'after') {
    // 6.91.0: the after arm runs the route's own pipeline (lib/dictation-polish-pipeline.ts): the
    // dictionary, filler pass, spoken paths, the model, then every guard. `output` is the model's
    // answer with only the link guard applied (the 6.83.1 scoring); `final` is what would go out.
    if (!process.env.COS_SCRIPTS_DIR) throw new Error('Set COS_SCRIPTS_DIR to a scratch directory (the token audit)')
    const pipeline = await import('../lib/dictation-polish-pipeline.js')
    for (const job of jobs) {
      await applyDictionary('', job.dictionary ?? {})
      const pre = pipeline.prepareOutboundDictation(job.input, 'message')
      if (consecutiveFailures >= 3) { rows.push({ id: job.id, arm, output: null, error: 'stopped: 3 consecutive failures', ms: 0, pre, deterministic: pre }); continue }
      const started = Date.now()
      const result = await pipeline.cleanOutboundDictation(job.input, { enabled: true, model: model as any, bucket: 'message', promptVersion: version })
      const ms = Date.now() - started
      if (result.modelText === undefined) {
        consecutiveFailures++
        rows.push({ id: job.id, arm, output: null, error: result.polishSkipped ?? 'no answer', ms, pre, deterministic: pre })
      } else {
        consecutiveFailures = 0
        const refused = result.guard === 'link' ? 'link_guard' : undefined
        rows.push({
          id: job.id, arm, output: refused ? pre : result.modelText, ms, pre, deterministic: pre, final: result.text,
          outcome: result.polishOutcome, ...(result.guard ? { guard: result.guard } : {}), ...(refused ? { refused, polished: result.modelText } : {}),
        })
      }
      writeFileSync(outFile, JSON.stringify(rows, null, 2))
      process.stderr.write(`${rows.length}/${jobs.length}\r`)
    }
    writeFileSync(outFile, JSON.stringify(rows, null, 2))
    if (set === 'canary') console.log(JSON.stringify({ arm, model, version, ...scoreCanary(rows) }, null, 2))
    else console.log(JSON.stringify(summarize(rows.map(r => ({ ...r, arm: `${model}-${version}` }))), null, 2))
    process.exit(0)
  }
  // The before arm (6.83.0 behaviour): no spoken paths and no link guard.
  for (const job of jobs) {
    const pre = stripDisfluencies(await applyDictionary(job.input, job.dictionary ?? {}))
    if (consecutiveFailures >= 3) { rows.push({ id: job.id, arm, output: null, error: 'stopped: 3 consecutive failures', ms: 0, pre, deterministic: pre }); continue }
    if (polishBudgetExhausted('message')) { rows.push({ id: job.id, arm, output: null, error: 'daily_cap', ms: 0, pre, deterministic: pre }); continue }
    recordPolishCall('message')
    const started = Date.now()
    try {
      const polished = (await autoCleanDictation(pre, VOCABULARY, { model, promptVersion: version })).trim()
      consecutiveFailures = 0
      const output = polished || pre
      const refused: string | undefined = undefined
      rows.push({ id: job.id, arm, output, ms: Date.now() - started, pre, deterministic: pre, ...(refused ? { refused, polished } : {}) })
    } catch (err: any) {
      consecutiveFailures++
      rows.push({ id: job.id, arm, output: null, error: String(err?.message ?? err), ms: Date.now() - started, pre, deterministic: pre })
    }
    writeFileSync(outFile, JSON.stringify(rows, null, 2))
    process.stderr.write(`${rows.length}/${jobs.length}\r`)
  }
  writeFileSync(outFile, JSON.stringify(rows, null, 2))
  if (set === 'canary') {
    console.log(JSON.stringify({ arm, model, version, ...scoreCanary(rows) }, null, 2))
  } else {
    console.log(JSON.stringify(summarize(rows.map(r => ({ ...r, arm: `${model}-${version}` }))), null, 2))
    for (const row of rows) {
      const c = REGRESSION.find(x => x.id === row.id)!
      if (row.output !== null && c.category === 'preserve' && !scoreCase(c, row.output).preserved) console.log(`${row.id} not preserved: ${JSON.stringify(row.output)}`)
    }
  }
}

if (process.argv[1]?.endsWith('dictation-format-eval.ts')) void main()
