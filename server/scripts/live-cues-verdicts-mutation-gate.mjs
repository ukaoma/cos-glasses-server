#!/usr/bin/env node
// Live cue verdicts 6.79.0 mutation gate: the cue log, the verdict store, the history and verdict routes, and the engine's
// emit point. Mutations run only in a disposable copy of the checkout; the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/live-cues-verdicts-mutation-gate.mjs [--list] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LIB_T = ['server/lib/live-cue-verdicts.test.ts']
const ROUTE_T = ['server/routes/live-cue-verdicts-route.test.ts']
const ENGINE_T = ['server/lib/live-cues-v2.test.ts']
const ALL = [...LIB_T, ...ROUTE_T, ...ENGINE_T, 'server/routes/live-cues-v2-route.test.ts', 'server/routes/live-cues-v2-settings-route.test.ts']
const LIB = 'server/lib/live-cue-verdicts.ts', ROUTE = 'server/routes/live-cues.ts', ENGINE = 'server/lib/live-cues-v2.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── Cue log ──
  m('torn-line-fresh-line', LIB, ["const lead = this.endsMidLine() ? '\\n' : ''", "const lead = ''"], LIB_T),
  m('append-refuses-non-file', LIB, ["      if (!st.isFile()) throw new Error('the cue log is not a regular file')\n", ''], LIB_T),
  m('read-refuses-non-file', LIB, ['      if (!st.isFile()) return { rows: [], skipped: 0 }', '      if (false) return { rows: [], skipped: 0 }'], LIB_T),
  m('store-refuses-non-file', LIB, ["      if (!statSync(this.file).isFile()) throw new Error('not a regular file')\n", ''], LIB_T),
  m('reader-schema-gate', LIB, ['if (isLogRow(value)) rows.push(value); else skipped += 1', 'rows.push(value as LiveCueLogRow)'], LIB_T),
  m('reader-counts-unparseable', LIB, ['try { value = JSON.parse(line) } catch { skipped += 1; continue }', 'try { value = JSON.parse(line) } catch { continue }'], LIB_T),
  m('schema-kind', LIB, ["&& (r.kind === 'reinforce' || r.kind === 'challenge')", ''], LIB_T),
  m('schema-sources', LIB, ['r.sources.every(s => !!s && typeof s === \'object\' && str((s as CueSourceRef).id) && str((s as CueSourceRef).date) && str((s as CueSourceRef).title))', 'true'], LIB_T),
  m('schema-before', LIB, ['&& str(r.model) && str(r.before)', '&& str(r.model)'], LIB_T),
  m('schema-finite-numbers', LIB, ["typeof v === 'number' && Number.isFinite(v)", "typeof v === 'number'"], LIB_T),
  m('schema-armedAt-optional', LIB, ['optional(r.armedAt, num)', 'num(r.armedAt)'], LIB_T),
  m('schema-prompt', LIB, ["optional(r.prompt, p => typeof p === 'string' && /^v\\d{1,2}$/.test(p))", 'true'], LIB_T),
  m('schema-prompt-forward', LIB, ["optional(r.prompt, p => typeof p === 'string' && /^v\\d{1,2}$/.test(p))", "optional(r.prompt, p => p === 'v2' || p === 'v3')"], LIB_T),
  m('schema-memory-source', LIB, ["optional(r.memorySource, m => m === 'cue_memory' || m === 'notes' || m === 'none')", 'true'], LIB_T),
  m('schema-kept', LIB, ['optional(r.kept, num)', 'true'], LIB_T),
  m('read-cache-used', LIB, ['if (this.cache?.key === key) return', 'if (false) return'], LIB_T),
  m('read-cache-follows-file', LIB, ['key = `${st.ino}:${st.size}:${st.mtimeMs}`', "key = 'fixed'"], LIB_T),
  m('before-code-points', LIB, ["Array.from(said.replace(/\\s+/g, ' ').trim()).slice(-CUE_BEFORE_MAX).join('')", "said.replace(/\\s+/g, ' ').trim().slice(-CUE_BEFORE_MAX)"], LIB_T),
  m('note-truncated', LIB, ['.trim().slice(0, CUE_FEEDBACK_REASON_MAX)', '.trim()'], LIB_T),
  // ── Retention ──
  m('prune-30-day-boundary', LIB, ['filter(r => r.createdAt >= cutoff)', 'filter(r => r.createdAt > cutoff)'], LIB_T),
  m('prune-blanks-before', LIB, ["if (r.createdAt >= textCutoff || r.before === '') return r", 'return r'], LIB_T),
  m('prune-7-day-boundary', LIB, ["if (r.createdAt >= textCutoff || r.before === '')", "if (r.createdAt > textCutoff || r.before === '')"], LIB_T),
  m('prune-no-op-no-rewrite', LIB, ['if (dropped || blanked) durableAtomicWriteFileSync', 'durableAtomicWriteFileSync'], LIB_T),
  m('prune-daily-cadence', LIB, ['if (this.deps.now() - this.lastPruneAt < LIVE_CUE_VERDICT_LIMITS.pruneEveryMs) return', 'if (this.deps.now() - this.lastPruneAt < 0) return'], LIB_T),
  m('history-prunes-first', LIB, ['    this.maybePrune()\n    const cutoff', '    const cutoff'], LIB_T),
  m('rating-prunes-first', LIB, ['    this.maybePrune()\n    const owner', '    const owner'], LIB_T),
  m('verdicts-follow-cues', LIB, ['const gone = log ? this.deps.store.prune(log.kept) : 0', 'const gone = 0'], LIB_T),
  m('no-log-keeps-verdicts', LIB, ['const gone = log ? this.deps.store.prune(log.kept) : 0', 'const gone = this.deps.store.prune(log?.kept ?? new Set())'], LIB_T),
  // ── Verdict store ──
  m('fail-closed-unparseable', LIB, ['throw new VerdictsUnreadableError(errMsg(error))', 'return {}'], [...LIB_T, ...ROUTE_T]),
  m('fail-closed-shape', LIB, ["throw new VerdictsUnreadableError('not a verdicts file')", 'return {}'], LIB_T),
  m('unknown-cue', LIB, ["    if (!owner) return { ok: false, error: 'unknown_cue' }\n", ''], LIB_T),
  m('session-mismatch', LIB, ["    if (owner !== input.sessionId) return { ok: false, error: 'cue_session_mismatch' }\n", ''], LIB_T),
  m('live-owner-counts', LIB, ['return liveOwner ?? this.deps.log.find(cueId)?.sessionId ?? null', 'return this.deps.log.find(cueId)?.sessionId ?? null'], LIB_T),
  m('rate-keeps-vote', LIB, ['...(prev?.vote ? { vote: prev.vote } : {})', ''], LIB_T),
  m('clear-sets-no-verdict', LIB, ["if (input.verdict !== 'clear') {", 'if (true) {'], LIB_T),
  m('empty-record-deleted', LIB, ['if (next.verdict || next.vote) all[input.cueId] = next; else delete all[input.cueId]', 'all[input.cueId] = next'], LIB_T),
  m('trace-never-note', LIB, ["...(note && input.verdict !== 'clear' ? { noted: true } : {})", "...(note && input.verdict !== 'clear' ? { reason: note } : {})"], LIB_T),
  m('vote-own-meeting-only', LIB, ['    if (this.owner(cueId, liveOwner) !== sessionId) return\n', ''], LIB_T),
  m('vote-keeps-verdict', LIB, ['all[cueId] = { ...all[cueId], vote, at: this.deps.now() }', 'all[cueId] = { vote, at: this.deps.now() }'], LIB_T),
  // ── History ──
  m('history-window', LIB, ['.filter(r => r.createdAt >= cutoff && (!sessions || sessions.has(r.sessionId)))', '.filter(r => (!sessions || sessions.has(r.sessionId)))'], LIB_T),
  m('history-session-filter', LIB, ['.filter(r => r.createdAt >= cutoff && (!sessions || sessions.has(r.sessionId)))', '.filter(r => r.createdAt >= cutoff)'], LIB_T),
  m('history-dedupe', LIB, ['if (seen.has(r.cueId)) return false; ', ''], LIB_T),
  m('history-oldest-first', LIB, ['      .sort((a, b) => a.createdAt - b.createdAt)\n', ''], LIB_T),
  m('rated-means-verdict', LIB, ['if (v) { byVerdict[v] += 1; rated += 1 }', 'if (verdicts[r.cueId]) { if (v) byVerdict[v] += 1; rated += 1 }'], LIB_T),
  m('unrated-filter', LIB, ['const wanted = rows.filter(r => !q.unrated || !verdicts[r.cueId]?.verdict)', 'const wanted = rows'], LIB_T),
  m('unrated-includes-vote-only', LIB, ['!q.unrated || !verdicts[r.cueId]?.verdict', '!q.unrated || !verdicts[r.cueId]'], LIB_T),
  m('limit-applied', LIB, ['const page = wanted.slice(-q.limit)', 'const page = wanted'], LIB_T),
  m('limit-keeps-newest', LIB, ['const page = wanted.slice(-q.limit)', 'const page = wanted.slice(0, q.limit)'], LIB_T),
  m('truncated-flag', LIB, ['truncated: wanted.length > q.limit', 'truncated: false'], LIB_T),
  m('title-resolved', LIB, ['title: saved?.title ?? r.meetingTitle', 'title: r.meetingTitle'], LIB_T),
  m('title-source', LIB, ["titleSource: saved?.source ?? 'capture'", "titleSource: 'capture'"], LIB_T),
  m('title-cached', LIB, ['if (hit && nowMs - hit.at < LIVE_CUE_VERDICT_LIMITS.titleCacheMs) return hit.value', ''], LIB_T),
  m('title-cache-expires', LIB, ['nowMs - hit.at < LIVE_CUE_VERDICT_LIMITS.titleCacheMs', 'nowMs - hit.at < Infinity'], LIB_T),
  m('title-saved-first', LIB, ["if (m?.title) return { title: m.title, source: 'saved' }", "if (m?.title) return { title: m.title, source: 'library' }"], ROUTE_T),
  m('logged-cues-once-each', LIB, ['new Set(this.deps.log.read().rows.filter(r => r.sessionId === sessionId).map(r => r.cueId)).size', 'this.deps.log.read().rows.filter(r => r.sessionId === sessionId).length'], LIB_T),
  // ── Routes ──
  m('route-one-of-vote-verdict', ROUTE, ['if (body.vote !== undefined || !SESSION_ID.test(sessionId) || !CUE_ID.test(cueId)', 'if (!SESSION_ID.test(sessionId) || !CUE_ID.test(cueId)'], ROUTE_T),
  m('route-verdict-enum', ROUTE, ["|| !(isCueVerdict(body.verdict) || body.verdict === 'clear')", ''], ROUTE_T),
  m('route-note-string', ROUTE, ["|| (body.note !== undefined && typeof body.note !== 'string')) {", ') {'], ROUTE_T),
  m('route-verdict-cue-id', ROUTE, ['if (body.vote !== undefined || !SESSION_ID.test(sessionId) || !CUE_ID.test(cueId)', 'if (body.vote !== undefined || !SESSION_ID.test(sessionId)'], ROUTE_T),
  m('route-verdict-session-id', ROUTE, ['if (body.vote !== undefined || !SESSION_ID.test(sessionId) || !CUE_ID.test(cueId)', 'if (body.vote !== undefined || !CUE_ID.test(cueId)'], ROUTE_T),
  m('route-unknown-404', ROUTE, ["if (!result.ok && result.error === 'unknown_cue') return res.status(404)", "if (!result.ok && result.error === 'unknown_cue') return res.status(409)"], ROUTE_T),
  m('route-mismatch-409', ROUTE, ["if (!result.ok) return res.status(409).json({ error: 'this cue belongs to another meeting'", "if (!result.ok) return res.status(404).json({ error: 'this cue belongs to another meeting'"], ROUTE_T),
  m('route-rating-503', ROUTE, ['      return res.json(result.response)\n    } catch (error) {\n      if (error instanceof VerdictsUnreadableError) return res.status(503)', '      return res.json(result.response)\n    } catch (error) {\n      if (error instanceof VerdictsUnreadableError) return res.status(500)'], ROUTE_T),
  m('route-history-503', ROUTE, ['...(meetings ? { meetings } : {}) })\n  } catch (error) {\n    if (error instanceof VerdictsUnreadableError) return res.status(503)', '...(meetings ? { meetings } : {}) })\n  } catch (error) {\n    if (error instanceof VerdictsUnreadableError) return res.status(500)'], ROUTE_T),
  m('route-never-builds-engine', ROUTE, ['return peekLiveCuesV2()?.findCue(cueId)?.sessionId ?? null', 'return liveCuesV2().findCue(cueId)?.sessionId ?? null'], ROUTE_T),
  m('route-lens-vote-stored', ROUTE, ["  try { liveCueVerdicts().vote(sessionId, cueId, body.vote, liveCueOwner(cueId)) } catch (error) { console.warn(`[live-cues] lens vote not stored: ${errMsg(error)}`) }\n", ''], ROUTE_T),
  m('route-history-int-range', ROUTE, ['return n >= min && n <= max ? n : null', 'return n'], ROUTE_T),
  m('route-history-int-digits', ROUTE, ["!/^\\d{1,4}$/.test(raw)", 'Number.isNaN(Number(raw))'], ROUTE_T),
  m('route-history-unrated-values', ROUTE, ["|| (unrated !== undefined && unrated !== '1' && unrated !== '0')", ''], ROUTE_T),
  m('route-history-unrated-param', ROUTE, ["unrated: unrated === '1'", 'unrated: false'], ROUTE_T),
  m('route-session-ids-cap', ROUTE, ['ids.length <= LIVE_CUE_VERDICT_LIMITS.maxSessionIds && ', ''], ROUTE_T),
  m('route-session-ids-shape', ROUTE, ['ids.every(id => SESSION_ID.test(id))', 'true'], ROUTE_T),
  m('route-session-ids-list', ROUTE, ["const ids = [...new Set(raw.split(',').map(x => x.trim()))]", 'const ids = [raw.trim()]'], ROUTE_T),
  m('route-history-no-store', ROUTE, ["liveCuesRouter.get('/live-cues/history', (req, res) => {\n  res.set('Cache-Control', 'private, no-store')\n", "liveCuesRouter.get('/live-cues/history', (req, res) => {\n"], ROUTE_T),
  m('route-meeting-counters', ROUTE, ['const counters = liveCuesV2MeetingCounters(id)', 'const counters = null as { cues: number; writerCalls: number } | null'], ROUTE_T),
  m('route-meeting-log-fallback', ROUTE, ['cues: counters?.cues ?? verdicts.loggedCues(id)', 'cues: counters?.cues ?? 0'], ROUTE_T),
  m('route-max-cues', ROUTE, ['return res.json({ ...history, maxCuesPerMeeting: C.maxCuesPerMeeting,', 'return res.json({ ...history,'], ROUTE_T),
  m('route-status-capability', ROUTE, ['    verdicts: { protocol: LIVE_CUE_VERDICTS_PROTOCOL },\n', ''], ROUTE_T),
  m('store-meeting-counters', ENGINE, ['return m ? { cues: m.cues, writerCalls: m.writerCalls } : null', 'return null'], ROUTE_T),
  // ── Engine ──
  m('engine-logs-cue', ENGINE, ['this.deps.cueLog?.({', 'void ({'], ENGINE_T),
  m('engine-logs-before-hold', ENGINE, [
    ['      s.cues.push(cue)\n      s.lastCueAt', '      s.lastCueAt'],
    ['      // 6.79.0: logged before it is held or emitted', '      s.cues.push(cue)\n      // 6.79.0: logged before it is held or emitted']], ENGINE_T),
  m('engine-log-failure-contained', ENGINE, [
    ['      try {\n        this.deps.cueLog?.(', '      {\n        this.deps.cueLog?.('],
    ["      } catch (error) {\n        trace.cueLogError = (error as NodeJS.ErrnoException)?.code ?? 'append_failed'\n        console.warn(`[live-cues-v2] cue log append failed: ${errMsg(error)}`)\n      }\n", '      }\n']], ENGINE_T),
  m('engine-log-error-traced', ENGINE, ["trace.cueLogError = (error as NodeJS.ErrnoException)?.code ?? 'append_failed'", 'void error'], ENGINE_T),
  m('engine-before-keeps-labels', ENGINE, ['before: cueBefore(said)', 'before: cueBefore(window)'], ENGINE_T),
  m('engine-before-strips-index', ENGINE, ["const said = s.chunks.join('\\n').replace(/^\\[\\d+\\]\\s*/gm, '')", "const said = s.chunks.join('\\n')"], ENGINE_T),
  m('engine-logs-armedAt', ENGINE, ['armedAt: s.armedAt, ', ''], ENGINE_T),
  m('engine-logs-prompt', ENGINE, ['model: cue.model, prompt: version,', "model: cue.model, prompt: 'v3',"], ENGINE_T),
  m('engine-logs-memory-source', ENGINE, ["memorySource: mem.notes.length ? source : 'none'", 'memorySource: source'], ENGINE_T),
  m('engine-logs-kept', ENGINE, ['kept: kept.length,', 'kept: 0,'], ENGINE_T),
  m('cooldown-knob-used', ENGINE, ['nowMs - s.lastCueAt < liveCuesV2CooldownMs(this.deps.env)', 'nowMs - s.lastCueAt < L.cooldownAfterCueMs'], ENGINE_T),
  m('cooldown-knob-floor', ENGINE, ['raw >= 20 && raw <= 900 ? Math.round(raw * 1000)', 'raw >= 0 && raw <= 900 ? Math.round(raw * 1000)'], ENGINE_T),
  m('cooldown-knob-ceiling', ENGINE, ['raw >= 20 && raw <= 900 ? Math.round(raw * 1000)', 'raw >= 20 ? Math.round(raw * 1000)'], ENGINE_T),
  m('judge-knob-used', ENGINE, ['(judged.probs[m.id] ?? 0) >= liveCuesV2JudgeKeep(this.deps.env)', '(judged.probs[m.id] ?? 0) >= L.judgeKeep'], ENGINE_T),
  m('judge-knob-floor', ENGINE, ['raw >= 0.3 && raw <= 0.99 ? raw : LIVE_CUES_V2_LIMITS.judgeKeep', 'raw >= 0 && raw <= 0.99 ? raw : LIVE_CUES_V2_LIMITS.judgeKeep'], ENGINE_T),
  m('judge-knob-ceiling', ENGINE, ['raw >= 0.3 && raw <= 0.99 ? raw : LIVE_CUES_V2_LIMITS.judgeKeep', 'raw >= 0.3 ? raw : LIVE_CUES_V2_LIMITS.judgeKeep'], ENGINE_T),
  m('contract-cooldown', 'managed-runtime-contract.json', ['    "COS_LIVE_CUES_V2_COOLDOWN_S",\n', ''], ENGINE_T),
  m('contract-judge-keep', 'managed-runtime-contract.json', ['    "COS_LIVE_CUES_V2_JUDGE_KEEP",\n', ''], ENGINE_T),
  m('engine-find-cue', ENGINE, ['const cue = s.cues.find(c => c.cueId === cueId); if (cue) return cue', ''], ENGINE_T),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')

const scratch = mkdtempSync(join(tmpdir(), 'cue-verdicts-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  for (const dir of ['shared', 'work-task-runtime', 'bin', 'docs', 'memory-runtime']) cpSync(join(root, dir), join(scratch, dir), { recursive: true })
  for (const file of ['vitest.config.ts', 'package.json', 'managed-runtime-contract.json']) cpSync(join(root, file), join(scratch, file))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: process.env.TMPDIR, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json') },
    encoding: 'utf8', timeout: 300000,
  })
  const baseline = run(ALL)
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
  const totals = /Tests\s+(\d+) passed/.exec(baseline.stdout)
  console.log(`baseline PASS (${totals ? totals[1] : '?'} tests in ${ALL.length} files)`)
  let killed = 0
  for (const { name, file, edits, tests } of selected) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    let mutated = original
    for (const [find, replacement] of edits) {
      if (mutated.split(find).length !== 2) throw new Error(`Mutation ${name} does not match exactly once in ${file}: ${find.slice(0, 80)}`)
      mutated = mutated.replace(find, () => replacement)
    }
    if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
    writeFileSync(target, mutated)
    let result
    try { result = run(tests) } finally { writeFileSync(target, original) }
    if (readFileSync(target, 'utf8') !== original) throw new Error(`Restore failed for ${file} after ${name}`)
    const output = result.stdout + '\n' + result.stderr
    const killers = [...new Set([...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(x => x[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) { console.log(`${name} SURVIVED or harness failed\n${output.slice(-3000)}`); process.exitCode = 1; continue }
    killed += 1
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  console.log(`${killed} of ${selected.length} live cue verdict 6.79.0 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
