/**
 * 6.79.1 offline eval: dictation polish prompts, through the real polish caller (the subscription
 * `claude -p` CLI). Synthetic dictation only; nothing here was spoken by a real person. Not
 * shipped in the npm package. 6.91.0: every call goes through the route's own pipeline
 * (lib/dictation-polish-pipeline.ts cleanOutboundDictation), so the filler pass, the prompt and
 * the guards are the shipped ones; `output` is the model's own answer, `final` what would go out.
 *
 *   COS_DATA_DIR=<scratch> COS_PROFILE_PATH=<scratch>/p.json COS_SCRIPTS_DIR=<scratch> \
 *   npx tsx server/scripts/dictation-polish-eval.ts [--models haiku,sonnet] [--prompts v3,v4]
 *     [--runs 1 | 2,3] [--ids repeat | b01,b02] [--warm] [--stacked] [--max-calls 200]
 *     [--concurrency 2] [--out results.json] [--resume results.json] [--score-only results.json] [--dry]
 *
 * Scoring is deterministic (no judge model):
 * - fillers left: filler tokens (um, uh, ...) plus each case's listed filler phrases still present.
 * - backtrack correct: every corrected value kept and every abandoned value gone.
 * - content recall: share of the reference's content words present in the output.
 * - added words: output content words found in neither the input nor the reference.
 *   Number formatting is normalized first ("ten thirty" = "10:30", "two hundred dollars" = "$200").
 * - preserved: "must not change" cases whose words match the reference exactly.
 */
import { writeFileSync, readFileSync } from 'node:fs'
import type { DictationPolishPromptVersion } from '../lib/dictation-clean.js'
import { stripDisfluencies } from '../lib/dictation-fillers.js'

export type EvalCategory = 'filler' | 'backtrack' | 'format' | 'names' | 'preserve'
export interface EvalCase {
  id: string
  category: EvalCategory
  input: string
  /** A reference cleaned text. Only its words are scored, not its punctuation. */
  expected: string
  /** Phrases that must be gone (fillers, abandoned values). */
  drop?: string[]
  /** Phrases that must be present (corrected values, meaningful "like"). */
  keep?: string[]
}

export const VOCABULARY = ['Quilt', 'HubSpot', 'Bottle POS', 'Priya', 'Okonkwo', 'Tableau', 'Jewel360']

export const CASES: EvalCase[] = [
  // Fillers and tics.
  { id: 'f01', category: 'filler', input: 'um so can you uh check the build status', expected: 'Can you check the build status?', drop: ['um', 'uh'] },
  { id: 'f02', category: 'filler', input: 'I think we should, um, move the launch to Thursday', expected: 'I think we should move the launch to Thursday.', drop: ['um'] },
  { id: 'f03', category: 'filler', input: 'uh hmm let me think the deck needs like three more slides', expected: 'Let me think. The deck needs three more slides.', drop: ['uh', 'hmm', 'like'] },
  { id: 'f04', category: 'filler', input: 'you know the report is basically done I just need to like add the chart', expected: 'The report is done. I just need to add the chart.', drop: ['you know', 'basically', 'like'] },
  { id: 'f05', category: 'filler', input: 'er can we um meet at three instead', expected: 'Can we meet at three instead?', drop: ['er', 'um'] },
  { id: 'f06', category: 'filler', input: 'the the pricing page is is broken on mobile', expected: 'The pricing page is broken on mobile.', drop: ['the the', 'is is'] },
  { id: 'f07', category: 'filler', input: 'I I I wanted to ask about the budget', expected: 'I wanted to ask about the budget.', drop: ['i i'] },
  { id: 'f08', category: 'filler', input: 'so um I mean the numbers look kind of off this week', expected: 'The numbers look off this week.', drop: ['um', 'i mean', 'kind of'] },
  { id: 'f09', category: 'filler', input: 'ahh okay uh send it to the whole team', expected: 'Okay, send it to the whole team.', drop: ['ahh', 'uh'] },
  { id: 'f10', category: 'filler', input: 'mm I think uh the first option is better', expected: 'I think the first option is better.', drop: ['mm', 'uh'] },
  { id: 'f11', category: 'filler', input: 'we should, we need to finalize the agenda today', expected: 'We need to finalize the agenda today.', drop: ['we should'] },
  { id: 'f12', category: 'filler', input: 'umm can you sort of summarize the thread for me', expected: 'Can you summarize the thread for me?', drop: ['umm', 'sort of'] },
  // Backtracking and self-corrections.
  { id: 'b01', category: 'backtrack', input: 'order five actually six cases of the red', expected: 'Order six cases of the red.', keep: ['six'], drop: ['five', 'actually'] },
  { id: 'b02', category: 'backtrack', input: 'schedule it for Tuesday no wait Wednesday at ten', expected: 'Schedule it for Wednesday at ten.', keep: ['wednesday'], drop: ['tuesday', 'no wait'] },
  { id: 'b03', category: 'backtrack', input: 'send the draft to Sam I mean Sara before lunch', expected: 'Send the draft to Sara before lunch.', keep: ['sara'], drop: ['sam', 'i mean'] },
  { id: 'b04', category: 'backtrack', input: 'the budget is forty thousand sorry fifty thousand for Q4', expected: 'The budget is fifty thousand for Q4.', keep: ['fifty'], drop: ['forty', 'sorry'] },
  { id: 'b05', category: 'backtrack', input: 'tell the team the meeting moved to two scratch that three', expected: 'Tell the team the meeting moved to three.', keep: ['three'], drop: ['two', 'scratch that'] },
  { id: 'b06', category: 'backtrack', input: 'book the room for eight people or rather ten people', expected: 'Book the room for ten people.', keep: ['ten'], drop: ['eight', 'or rather'] },
  { id: 'b07', category: 'backtrack', input: 'use the blue logo, no, the green logo on the banner', expected: 'Use the green logo on the banner.', keep: ['green'], drop: ['blue'] },
  { id: 'b08', category: 'backtrack', input: 'remind me on Monday wait no Friday to follow up', expected: 'Remind me on Friday to follow up.', keep: ['friday'], drop: ['monday', 'wait no'] },
  { id: 'b09', category: 'backtrack', input: 'the call is at nine thirty I mean ten thirty Central', expected: 'The call is at ten thirty Central.', keep: ['ten thirty'], drop: ['nine', 'i mean'] },
  { id: 'b10', category: 'backtrack', input: 'add Priya to the invite actually add Dana instead', expected: 'Add Dana to the invite.', keep: ['dana'], drop: ['priya', 'actually'] },
  // Spoken formatting.
  { id: 'l01', category: 'format', input: 'groceries new line milk new line eggs new line bread', expected: 'Groceries\nMilk\nEggs\nBread', drop: ['new line'] },
  { id: 'l02', category: 'format', input: 'agenda bullet point budget review bullet point hiring plan bullet point launch date', expected: 'Agenda\n- Budget review\n- Hiring plan\n- Launch date', drop: ['bullet point'] },
  { id: 'l03', category: 'format', input: 'numbered list number one draft the brief number two get approval number three ship it', expected: '1. Draft the brief\n2. Get approval\n3. Ship it', drop: ['numbered list', 'number one', 'number two', 'number three'] },
  { id: 'l04', category: 'format', input: 'hi Dana comma thanks for the notes period can we talk tomorrow question mark', expected: 'Hi Dana, thanks for the notes. Can we talk tomorrow?', drop: ['comma', 'period', 'question mark'] },
  { id: 'l05', category: 'format', input: 'thanks for the update new paragraph next steps are on me', expected: 'Thanks for the update.\n\nNext steps are on me.', drop: ['new paragraph'] },
  { id: 'l06', category: 'format', input: 'um two things bullet point fix the header bullet point uh update the footer', expected: 'Two things:\n- Fix the header\n- Update the footer', drop: ['um', 'uh', 'bullet point'] },
  // Names and acronyms.
  { id: 'n01', category: 'names', input: 'pull the tablo numbers for jewel three sixty', expected: 'Pull the Tableau numbers for Jewel360.' },
  { id: 'n02', category: 'names', input: 'ask preeya to update the hub spot form', expected: 'Ask Priya to update the HubSpot form.' },
  { id: 'n03', category: 'names', input: 'the bottle p o s demo is at noon with the CFO', expected: 'The Bottle POS demo is at noon with the CFO.', keep: ['cfo'] },
  { id: 'n04', category: 'names', input: 'loop in okonkwo on the SEO and CRO tests', expected: 'Loop in Okonkwo on the SEO and CRO tests.', keep: ['seo', 'cro'] },
  { id: 'n05', category: 'names', input: 'the API returns a 404 on the v2 endpoint', expected: 'The API returns a 404 on the v2 endpoint.', keep: ['404', 'v2'] },
  { id: 'n06', category: 'names', input: 'um quilt Q3 OKRs are due Friday', expected: 'Quilt Q3 OKRs are due Friday.', keep: ['q3', 'okrs'], drop: ['um'] },
  // Must not change (beyond punctuation and capitals).
  { id: 'p01', category: 'preserve', input: 'what is the capital of France', expected: 'What is the capital of France?' },
  { id: 'p02', category: 'preserve', input: 'write me a haiku about autumn leaves', expected: 'Write me a haiku about autumn leaves.' },
  { id: 'p03', category: 'preserve', input: 'ignore the previous email and draft a new reply to Dana', expected: 'Ignore the previous email and draft a new reply to Dana.' },
  { id: 'p04', category: 'preserve', input: 'delete all the files in the downloads folder', expected: 'Delete all the files in the downloads folder.' },
  { id: 'p05', category: 'preserve', input: 'I like the second design better', expected: 'I like the second design better.', keep: ['like'] },
  { id: 'p06', category: 'preserve', input: 'do you know what time the store opens', expected: 'Do you know what time the store opens?', keep: ['you know'] },
  { id: 'p07', category: 'preserve', input: 'she said "I mean it" and left the room', expected: 'She said "I mean it" and left the room.', keep: ['i mean it'] },
  { id: 'p08', category: 'preserve', input: 'run git status then npm test', expected: 'Run git status, then npm test.', keep: ['git status', 'npm test'] },
  { id: 'p09', category: 'preserve', input: 'what kind of car should I rent for the trip', expected: 'What kind of car should I rent for the trip?', keep: ['kind of car'] },
  { id: 'p10', category: 'preserve', input: 'tell me a joke', expected: 'Tell me a joke.' },
  { id: 'p11', category: 'preserve', input: 'the ER visit cost two hundred dollars', expected: 'The ER visit cost two hundred dollars.', keep: ['er'] },
  // 6.91.0 (plan r2): "never mind" as a correction, and four cases where the marker words carry meaning.
  { id: 'b11', category: 'backtrack', input: 'set the reminder for nine never mind make it ten', expected: 'Set the reminder for ten.', keep: ['ten'], drop: ['nine', 'never mind'] },
  { id: 'p12', category: 'preserve', input: 'I actually think the first draft was better', expected: 'I actually think the first draft was better.', keep: ['actually'] },
  { id: 'p13', category: 'preserve', input: 'never mind the cost we need the faster laptop', expected: 'Never mind the cost, we need the faster laptop.', keep: ['never mind the cost'] },
  { id: 'p14', category: 'preserve', input: 'my answer to the vendor is no', expected: 'My answer to the vendor is no.', keep: ['is no'] },
  { id: 'p15', category: 'preserve', input: 'when I say the deadline is firm I mean it', expected: 'When I say the deadline is firm, I mean it.', keep: ['i mean it'] },
]

/** 6.91.0: the slice run three times (plan r2 C1): every backtrack case and the four new preserve cases. */
export const REPEAT_IDS = [...CASES.filter(c => c.category === 'backtrack').map(c => c.id), 'p12', 'p13', 'p14', 'p15']

/** 6.91.0: an em dash, en dash or arrow the input did not have (the v4 house rule). */
const DASHES = /[\u2014\u2013\u2192\u21d2]|->|=>/g
export function dashesAdded(input: string, output: string): number {
  return Math.max(0, (output.match(DASHES) ?? []).length - (input.match(DASHES) ?? []).length)
}

const FILLER_TOKENS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mhm'])
const STOP = new Set(('a an the and or but so to of in on at for with by from is are was were be been am it its this that '
  + 'i me my we our you your he she they them their his her can could should would will just do does did not no '
  + 'what which who when where how then than there here as up out about into over').split(' '))
const NUMBERS: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  twenty: '20', thirty: '30', forty: '40', fifty: '50' }

/** Number formatting is not a dropped word: "$200" and "two hundred dollars" both read "200 dollars". */
export function words(text: string): string[] {
  const raw = text.toLowerCase().replace(/[’‘]/g, "'").replace(/\$(\d+)/g, '$1 dollars').replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/)
    .map(w => w.replace(/^'+|'+$/g, '')).filter(Boolean).map(w => NUMBERS[w] ?? w)
  const out: string[] = []
  for (const w of raw) {
    if (w === 'hundred' && /^\d+$/.test(out[out.length - 1] ?? '')) out.push(String(Number(out.pop()) * 100))
    else out.push(w)
  }
  return out
}
const content = (text: string) => words(text).filter(w => !STOP.has(w) && !FILLER_TOKENS.has(w))
function has(output: string, phrase: string): boolean {
  const hay = ` ${words(output).join(' ')} `
  return hay.includes(` ${words(phrase).join(' ')} `)
}

export interface CaseScore {
  fillersLeft: number
  backtrackCorrect: boolean | null
  contentRecall: number
  addedWords: string[]
  preserved: boolean | null
  keepOk: boolean
}

export function scoreCase(c: EvalCase, output: string): CaseScore {
  const outWords = words(output)
  const outSet = new Set(outWords)
  const tokenFillers = outWords.filter(w => FILLER_TOKENS.has(w) && !(c.keep ?? []).some(k => words(k).includes(w))).length
  const phraseFillers = c.category === 'backtrack' ? 0 : (c.drop ?? []).filter(p => !words(p).every(w => FILLER_TOKENS.has(w)) && has(output, p)).length
  const expectedContent = content(c.expected)
  const recall = expectedContent.length ? expectedContent.filter(w => outSet.has(w)).length / expectedContent.length : 1
  const known = new Set([...words(c.input), ...words(c.expected), ...VOCABULARY.flatMap(v => words(v))])
  const added = content(output).filter(w => !known.has(w))
  const keepOk = (c.keep ?? []).every(k => has(output, k))
  return {
    fillersLeft: tokenFillers + phraseFillers,
    backtrackCorrect: c.category === 'backtrack' ? keepOk && (c.drop ?? []).every(d => !has(output, d)) : null,
    contentRecall: recall,
    addedWords: added,
    preserved: c.category === 'preserve' ? words(output).join(' ') === words(c.expected).join(' ') : null,
    keepOk,
  }
}

export interface RunRow {
  id: string; arm: string; output: string | null; error?: string; ms: number
  /** 6.91.0: the pipeline's final text (after the guards) and the guard that refused, if any. */
  final?: string; guard?: string; outcome?: string; run?: number; prewarm?: string
}

export function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]
}

export function summarize(rows: RunRow[]) {
  const byArm = new Map<string, RunRow[]>()
  for (const row of rows) byArm.set(row.arm, [...(byArm.get(row.arm) ?? []), row])
  const out: Record<string, Record<string, number | string>> = {}
  for (const [arm, armRows] of byArm) {
    const scored = armRows.map(r => ({ c: CASES.find(c => c.id === r.id)!, r, s: r.output === null ? null : scoreCase(CASES.find(c => c.id === r.id)!, r.output) }))
    const ok = scored.filter(x => x.s)
    const back = ok.filter(x => x.c.category === 'backtrack')
    const pres = ok.filter(x => x.c.category === 'preserve')
    const fillerCases = ok.filter(x => x.c.category !== 'preserve')
    out[arm] = {
      calls: armRows.length,
      errors: armRows.length - ok.length,
      fillersLeft: fillerCases.reduce((n, x) => n + x.s!.fillersLeft, 0),
      casesWithFillers: fillerCases.filter(x => x.s!.fillersLeft > 0).length,
      backtrackCorrect: `${back.filter(x => x.s!.backtrackCorrect).length}/${back.length}`,
      contentRecall: Number((ok.reduce((n, x) => n + x.s!.contentRecall, 0) / Math.max(1, ok.length)).toFixed(3)),
      casesDroppingContent: ok.filter(x => x.s!.contentRecall < 1).length,
      addedWords: ok.reduce((n, x) => n + x.s!.addedWords.length, 0),
      keepFailures: ok.filter(x => !x.s!.keepOk).length,
      preserved: `${pres.filter(x => x.s!.preserved).length}/${pres.length}`,
      dashesAdded: ok.reduce((n, x) => n + dashesAdded(x.c.input, x.r.output!), 0),
      guarded: armRows.filter(r => r.outcome === 'guarded').length,
      medianMs: percentile(ok.map(r => r.r.ms), 0.5),
      p90Ms: percentile(ok.map(r => r.r.ms), 0.9),
    }
  }
  return out
}

/**
 * A ~1,000-character instruction set and the largest learned style, for the C5 stacked arm. Synthetic.
 * 6.91.1: 985 characters. It was 1,033, over the 1,000 cap, so the reader refused it and the 6.91.0
 * Haiku stacked arm ran without instructions; main() now refuses a set the reader would refuse.
 * Since option C (6.91.0) the pipeline gives the learned style only to Sonnet with v4, so a Haiku
 * stacked arm now carries the instructions alone; the 6.91.0 CHANGELOG numbers predate that.
 */
export const STACKED_INSTRUCTIONS = [
  'Use Oxford commas in every list of three or more items.',
  'Write product names exactly as Bottle POS, IT Retail, HubSpot, Tableau and Jewel360.',
  'Write numbers of ten or more as digits, and spell out one through nine.',
  'Use sentence case for anything that looks like a heading.',
  'When I list three or more things in a row, format them as a dash list.',
  'Keep my sentences short and direct, and never add a greeting or a sign-off.',
  'Write times in the form 10:30 am, and dates in the form October 3.',
  'Spell the names of my teammates the way the known spellings show them.',
  'If I dictate a question, end it with a question mark and keep it a question.',
  'Never add exclamation marks I did not say, and keep my own word choice.',
  'Use a colon before a list that follows a short lead-in sentence.',
  'Write percentages with the percent sign, like 15%, rather than the word.',
  'Do not add bold, italics, headings or any markdown I did not ask for.',
  'Keep any acronym I say in capital letters, for example CRM, SEO and API.',
].join('\n')

async function main() {
  const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : fallback
  }
  const scoreOnly = arg('score-only', '')
  if (scoreOnly) {
    console.log(JSON.stringify(summarize(JSON.parse(readFileSync(scoreOnly, 'utf8'))), null, 2))
    return
  }
  // 6.91.0: every call goes through the route's own pipeline (lib/dictation-polish-pipeline.ts),
  // so the scratch data dir and profile are required: the pipeline reads both.
  if (!process.env.COS_DATA_DIR || !process.env.COS_PROFILE_PATH || !process.env.COS_SCRIPTS_DIR) {
    throw new Error('Set COS_DATA_DIR, COS_PROFILE_PATH and COS_SCRIPTS_DIR to scratch paths')
  }
  const models = arg('models', 'haiku,sonnet').split(',')
  const prompts = arg('prompts', 'v3,v4').split(',') as DictationPolishPromptVersion[]
  const maxCalls = Number(arg('max-calls', '200'))
  const concurrency = Number(arg('concurrency', '2'))
  const outFile = arg('out', 'dictation-polish-eval-results.json')
  const runs = (arg('runs', '1').split(',')).map(Number)
  const ids = arg('ids', '') === 'repeat' ? new Set(REPEAT_IDS) : arg('ids', '') ? new Set(arg('ids', '').split(',')) : null
  const stacked = process.argv.includes('--stacked')
  const warm = process.argv.includes('--warm')
  const warmWaitMs = Number(arg('warm-wait-ms', '3000'))
  process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE = String(maxCalls)
  writeFileSync(process.env.COS_PROFILE_PATH, JSON.stringify({ vocabulary: VOCABULARY }))
  const { clearProfileCache } = await import('../lib/profile.js')
  clearProfileCache()
  const pipeline = await import('../lib/dictation-polish-pipeline.js')
  const prewarm = await import('../lib/dictation-prewarm.js')
  const instructions = await import('../lib/dictation-polish-instructions.js')
  const style = await import('../lib/dictation-learned-style.js')
  if (stacked) {
    instructions.writeCustomInstructions(STACKED_INSTRUCTIONS)
    // The store writes anything; its reader refuses a set over the cap. Test what ships, or stop.
    if (instructions.readCustomInstructions().customInstructions !== STACKED_INSTRUCTIONS) {
      throw new Error(`STACKED_INSTRUCTIONS (${STACKED_INSTRUCTIONS.length} characters) would not reach the model`)
    }
    style.writeLearnedStyle(true, [
      ...style.LEARNED_STYLE_ALLOWLIST.map((param, i) => ({ id: `stack-${i}`, kind: 'drop_phrase' as const, register: 'all' as const, param, count: 2, lastSeen: null })),
      { id: 'stack-contractions', kind: 'contractions' as const, register: 'all' as const, param: 'use', count: 2, lastSeen: null },
    ])
  }
  // --resume keeps the answered rows of an earlier run and asks only for the rest.
  const resume = arg('resume', '')
  const kept: RunRow[] = resume ? (JSON.parse(readFileSync(resume, 'utf8')) as RunRow[]).filter(r => r.output !== null && r.arm !== 'deterministic') : []
  const done = new Set(kept.map(r => `${r.arm}:${r.run ?? 1}:${r.id}`))
  const armName = (model: string, prompt: string) => `${model}-${prompt}${stacked ? '-stacked' : ''}`
  // Cases outermost, arms inner: v3 and v4 alternate, so a slow minute hits both alike.
  const jobs = runs.flatMap(run => CASES.filter(c => !ids || ids.has(c.id)).flatMap(c => models.flatMap(model => prompts.map(prompt => ({ c, model, prompt, run })))))
    .filter(job => !done.has(`${armName(job.model, job.prompt)}:${job.run}:${job.c.id}`))
  if (jobs.length > maxCalls) throw new Error(`${jobs.length} calls exceeds --max-calls ${maxCalls}`)
  if (process.argv.includes('--dry')) { console.log(JSON.stringify({ calls: jobs.length })); return }
  const rows: RunRow[] = [...CASES.map(c => ({ id: c.id, arm: 'deterministic', output: stripDisfluencies(c.input), ms: 0 })), ...kept]
  let next = 0
  let consecutiveFailures = 0
  const worker = async () => {
    while (next < jobs.length) {
      const { c, model, prompt, run } = jobs[next++]
      const arm = armName(model, prompt)
      if (consecutiveFailures >= 3) { rows.push({ id: c.id, arm, run, output: null, error: 'stopped: 3 consecutive failures', ms: 0 }); continue }
      let prewarmToken: string | undefined
      if (warm && prewarm.isPrewarmModel(model)) {
        try { prewarmToken = prewarm.startPolishPrewarm(model, prompt).token } catch { prewarmToken = undefined }
        // A dictation lasts a few seconds: the process is warm by the time the text arrives.
        await new Promise(resolve => setTimeout(resolve, warmWaitMs))
      }
      const started = Date.now()
      const result = await pipeline.cleanOutboundDictation(c.input, {
        enabled: true, model: model as any, bucket: 'message', promptVersion: prompt, ...(prewarmToken ? { prewarmToken } : {}),
      })
      const ms = Date.now() - started
      if (result.modelText === undefined) {
        consecutiveFailures++
        rows.push({ id: c.id, arm, run, output: null, error: result.polishSkipped ?? 'no answer', ms })
      } else {
        consecutiveFailures = 0
        rows.push({ id: c.id, arm, run, output: result.modelText, final: result.text, outcome: result.polishOutcome, ...(result.guard ? { guard: result.guard } : {}), ...(result.prewarm ? { prewarm: result.prewarm } : {}), ms })
      }
      writeFileSync(outFile, JSON.stringify(rows, null, 2))
      process.stderr.write(`${rows.length - CASES.length - kept.length}/${jobs.length}\r`)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  writeFileSync(outFile, JSON.stringify(rows, null, 2))
  console.log(JSON.stringify(summarize(rows), null, 2))
  process.exit(0)
}

if (process.argv[1]?.endsWith('dictation-polish-eval.ts')) void main()
