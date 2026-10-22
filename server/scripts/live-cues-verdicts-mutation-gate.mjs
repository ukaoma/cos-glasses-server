#!/usr/bin/env node
// Live cues 6.79.x mutation gate: the cue log, the verdict store, the history and verdict routes, the engine's emit point,
// the repeat filter and shadow template rules, and (6.79.2) COS Control's spend limits. Mutations run only in a disposable copy of the checkout; the live checkout is never rewritten.
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
const FILTER_T = ['server/lib/live-cues-filter.test.ts']
const SETTINGS_T = ['server/lib/live-cues-v2-settings.test.ts']
const LIMITS_T = ['server/routes/live-cues-v2-limits-route.test.ts']
const ALL = [...LIB_T, ...ROUTE_T, ...ENGINE_T, ...FILTER_T, ...SETTINGS_T, ...LIMITS_T, 'server/routes/live-cues-v2-route.test.ts', 'server/routes/live-cues-v2-settings-route.test.ts']
const LIB = 'server/lib/live-cue-verdicts.ts', ROUTE = 'server/routes/live-cues.ts', ENGINE = 'server/lib/live-cues-v2.ts'
const FILTER = 'server/lib/live-cues-filter.ts', SETTINGS = 'server/lib/live-cues-v2-settings.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── Cue log ──
  m('torn-line-fresh-line', LIB, ["const lead = this.endsMidLine() ? '\\n' : ''", "const lead = ''"], LIB_T),
  m('append-refuses-non-file', LIB, ["      if (!st.isFile()) throw new Error('the cue log is not a regular file')\n", ''], LIB_T),
  m('read-refuses-non-file', LIB, ['      if (!st.isFile()) return { rows: [], skipped: 0 }', '      if (false) return { rows: [], skipped: 0 }'], LIB_T),
  m('store-refuses-non-file', LIB, ["      if (!statSync(this.file).isFile()) throw new Error('not a regular file')\n", ''], LIB_T),
  m('reader-schema-gate', LIB, ['if (isLogRow(value)) rows.push(value); else skipped += 1', 'rows.push(value as LiveCueLogRow)'], LIB_T),
  m('reader-counts-unparseable', LIB, ['try { value = JSON.parse(line) } catch { skipped += 1; continue }', 'try { value = JSON.parse(line) } catch { continue }'], LIB_T),
  m('schema-kind', LIB, ['&& isCueKind(r.kind)', ''], LIB_T),
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
  m('cooldown-knob-used', ENGINE, ['nowMs - s.lastCueAt < lim.cooldownMs', 'nowMs - s.lastCueAt < L.cooldownAfterCueMs'], ENGINE_T),
  m('cooldown-knob-floor', ENGINE, ['seconds >= 20 && seconds <= 900', 'seconds >= 0 && seconds <= 900'], ENGINE_T),
  m('cooldown-knob-ceiling', ENGINE, ['seconds >= 20 && seconds <= 900', 'seconds >= 20'], ENGINE_T),
  m('cooldown-knob-whole-seconds', ENGINE, ['/^\\d{1,3}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN', 'Number(raw.trim())'], ENGINE_T),
  m('cooldown-knob-unset-silent', ENGINE, ["const raw = env.COS_LIVE_CUES_V2_COOLDOWN_S\n  if (raw === undefined || raw.trim() === '') return null\n", "const raw = env.COS_LIVE_CUES_V2_COOLDOWN_S\n  if (raw === undefined) return null\n"], ENGINE_T),
  m('judge-knob-used', ENGINE, ['(judged.probs[m.id] ?? 0) >= liveCuesV2JudgeKeep(this.deps.env)', '(judged.probs[m.id] ?? 0) >= L.judgeKeep'], ENGINE_T),
  m('judge-knob-floor', ENGINE, ['keep >= 0.5 && keep <= 0.95', 'keep >= 0.3 && keep <= 0.95'], ENGINE_T),
  m('judge-knob-ceiling', ENGINE, ['keep >= 0.5 && keep <= 0.95', 'keep >= 0.5 && keep <= 0.99'], ENGINE_T),
  m('judge-knob-unset-silent', ENGINE, ["  if (raw === undefined || raw.trim() === '') return LIVE_CUES_V2_LIMITS.judgeKeep\n", "  if (raw === undefined) return LIVE_CUES_V2_LIMITS.judgeKeep\n"], ENGINE_T),
  m('knob-warns-once-per-value', ENGINE, ['  if (!knobWarned.has(`${name}=${raw}`)) {', '  if (true) {'], ENGINE_T),
  m('knob-warns-at-all', ENGINE, ["    console.warn(`[live-cues-v2] ${name}=${JSON.stringify(raw)} is not ${accepted}; using the default`)\n", ''], ENGINE_T),
  m('contract-cooldown', 'managed-runtime-contract.json', ['    "COS_LIVE_CUES_V2_COOLDOWN_S",\n', ''], ENGINE_T),
  m('contract-judge-keep', 'managed-runtime-contract.json', ['    "COS_LIVE_CUES_V2_JUDGE_KEEP",\n', ''], ENGINE_T),
  // ── Repeat filter (enforced only when set) and shadow template rules ──
  m('filter-lowercase', FILTER, ["(cue || '').toLowerCase().match(TOKEN_RE)", "(cue || '').match(TOKEN_RE)"], FILTER_T),
  m('filter-comma-drop', FILTER, ["const t = m.replace(/,/g, '')", 'const t = m'], FILTER_T),
  m('filter-digit-min-length', FILTER, ['if (t.length >= 2) out.add(t)', 'out.add(t)'], FILTER_T),
  m('filter-word-min-length', FILTER, ['t.length >= 3 && !CUE_FILTER_STOPWORDS.has(t)', 't.length >= 2 && !CUE_FILTER_STOPWORDS.has(t)'], FILTER_T),
  m('filter-stopwords', FILTER, ['t.length >= 3 && !CUE_FILTER_STOPWORDS.has(t)', 't.length >= 3'], FILTER_T),
  m('filter-overlap-min', FILTER, ['shared / Math.min(a.size, b.size)', 'shared / Math.max(a.size, b.size)'], FILTER_T),
  m('filter-overlap-empty', FILTER, ['  if (!a.size || !b.size) return 0\n', ''], FILTER_T),
  m('filter-repeat-inclusive', FILTER, ['if (o >= threshold) return', 'if (o > threshold) return'], FILTER_T),
  m('filter-repeat-rounding', FILTER, ['overlap: Math.round(o * 1000) / 1000', 'overlap: o'], FILTER_T),
  m('filter-template-gate', FILTER, ['  if (!isTemplateCue(detail)) return { perMeeting: false, perTopic: false }\n', ''], FILTER_T),
  m('filter-earlier-template-only', FILTER, ['const templates = shown.filter(s => isTemplateCue(s.detail))', 'const templates = shown'], FILTER_T),
  m('filter-topic-threshold', FILTER, ['export const CUE_TOPIC_OVERLAP = 0.25', 'export const CUE_TOPIC_OVERLAP = 0.5'], FILTER_T),
  m('filter-topic-inclusive', FILTER, ['cueOverlap(mine, cueTokens(s.detail)) >= CUE_TOPIC_OVERLAP', 'cueOverlap(mine, cueTokens(s.detail)) > CUE_TOPIC_OVERLAP'], FILTER_T),
  m('filter-blocker-topic-first', FILTER, ['const blocker = topic ?? templates[0]', 'const blocker = templates[0] ?? topic'], FILTER_T),
  m('filter-template-case', FILTER, ['is computing|does))\\b/i', 'is computing|does))\\b/'], FILTER_T),
  m('engine-repeat-enforced', ENGINE, ['      if (repeat) { Object.assign(trace,', '      if (false) { Object.assign(trace,'], ENGINE_T),
  m('engine-repeat-off-by-default', ENGINE, ['const repeat = repeatT === null ? null : repeatOf(cue.detail, s.cues, repeatT)', 'const repeat = repeatOf(cue.detail, s.cues, repeatT ?? 0.5)'], ENGINE_T),
  m('engine-repeat-threshold-used', ENGINE, ['repeatOf(cue.detail, s.cues, repeatT)', 'repeatOf(cue.detail, s.cues, 0.5)'], ENGINE_T),
  m('engine-repeat-trace-ids', ENGINE, ["Object.assign(trace, { outcome: 'withheld_repeat', repeatOf: repeat.blocker, repeatOverlap: repeat.overlap })", "Object.assign(trace, { outcome: 'withheld_repeat' })"], ENGINE_T),
  m('engine-repeat-floor', ENGINE, ['t >= 0.3 && t <= 0.9 ? t', 't >= 0 && t <= 0.9 ? t'], ENGINE_T),
  m('engine-repeat-ceiling', ENGINE, ['t >= 0.3 && t <= 0.9 ? t', 't >= 0.3 ? t'], ENGINE_T),
  m('engine-repeat-unset-silent', ENGINE, ["const raw = env.COS_LIVE_CUES_V2_REPEAT_OVERLAP\n  if (raw === undefined || raw.trim() === '') return null\n", 'const raw = env.COS_LIVE_CUES_V2_REPEAT_OVERLAP\n  if (raw === undefined) return null\n'], ENGINE_T),
  m('engine-shadow-logged', ENGINE, ['wouldWithhold: wouldWithhold(cue.detail, s.cues), ', ''], ENGINE_T),
  m('engine-shadow-against-shown', ENGINE, ['wouldWithhold: wouldWithhold(cue.detail, s.cues)', 'wouldWithhold: wouldWithhold(cue.detail, [])'], ENGINE_T),
  m('schema-would-withhold', LIB, ['\n    && optional(r.wouldWithhold, isWouldWithhold)', ''], LIB_T),
  m('schema-would-withhold-topic', LIB, ["typeof w.perMeeting === 'boolean' && typeof w.perTopic === 'boolean'", "typeof w.perMeeting === 'boolean'"], LIB_T),
  m('schema-would-withhold-blocker', LIB, ['optional(w.blockerCueId, str)', 'true'], LIB_T),
  m('contract-repeat-overlap', 'managed-runtime-contract.json', ['    "COS_LIVE_CUES_V2_REPEAT_OVERLAP",\n', ''], ENGINE_T),
  // ── 6.79.2 spend limits ──
  m('bounds-inclusive-min', SETTINGS, ['value >= b.min && value <= b.max', 'value > b.min && value <= b.max'], SETTINGS_T),
  m('bounds-inclusive-max', SETTINGS, ['value >= b.min && value <= b.max', 'value >= b.min && value < b.max'], SETTINGS_T),
  m('bounds-whole', SETTINGS, ['(!b.integer || Number.isInteger(value))', 'true'], SETTINGS_T),
  m('bounds-numbers-only', SETTINGS, ["typeof value === 'number' && Number.isFinite(value) && ", ''], SETTINGS_T),
  m('settings-read-validates', SETTINGS, ['if (limitInBounds(name, r[name])) limits[name] = r[name] as number', 'if (r[name] !== undefined) limits[name] = r[name] as number'], SETTINGS_T),
  m('settings-update-merges', SETTINGS, ['const limits = { ...current.limits, ...patch.limits }', 'const limits = { ...patch.limits }'], SETTINGS_T),
  m('settings-update-keeps-switch', SETTINGS, ['const value = patch.enabled ?? current.value', 'const value = patch.enabled ?? null'], SETTINGS_T),
  m('settings-schema-1-without-limits', SETTINGS, ['schema: hasLimits ? 2 : 1', 'schema: 2'], [...SETTINGS_T, ...LIMITS_T]),
  m('settings-no-enabled-when-unset', SETTINGS, ['...(value === null ? {} : { enabled: value })', 'enabled: value'], SETTINGS_T),
  m('limits-gate-used', ENGINE, ['if (pCue < this.limits().gate)', 'if (pCue < liveCuesV2Gate(this.deps.env))'], ENGINE_T),
  m('limits-cap-feed', ENGINE, ["if (counters.cues >= lim.maxCues || counters.writerCalls >= lim.writerCap) return this.traceSkip(s, 'meeting_cap', nowMs)", "if (counters.cues >= L.maxCuesPerMeeting || counters.writerCalls >= L.maxWriterCallsPerMeeting) return this.traceSkip(s, 'meeting_cap', nowMs)"], ENGINE_T),
  m('limits-writer-cap-twice', ENGINE, ['writerCap: 2 * r.maxCuesPerMeeting.value', 'writerCap: LIVE_CUES_V2_LIMITS.maxWriterCallsPerMeeting'], ENGINE_T),
  m('limits-cooldown-used', ENGINE, ['cooldownMs: r.cooldownSeconds.value * 1000', 'cooldownMs: LIVE_CUES_V2_LIMITS.cooldownAfterCueMs'], ENGINE_T),
  m('limits-daily-before-gate', ENGINE, ["    if (this.deps.store.dailyWriterCalls() >= lim.dailyWriterCalls) return this.traceSkip(s, 'daily_cap', nowMs)", ''], ENGINE_T),
  m('limits-daily-precharge', ENGINE, ["      if (this.deps.store.dailyWriterCalls() >= lim.dailyWriterCalls) { trace.outcome = 'daily_cap';", "      if (false) { trace.outcome = 'daily_cap';"], ENGINE_T),
  m('limits-cap-precharge', ENGINE, ["      if (counters.cues >= lim.maxCues || counters.writerCalls >= lim.writerCap) { trace.outcome = 'meeting_cap'; return }\n", ''], ENGINE_T),
  m('limits-status-cap', ENGINE, ["if (counters.cues >= lim.maxCues || counters.writerCalls >= lim.writerCap) return 'meeting_cap'", "if (false) return 'meeting_cap'"], ENGINE_T),
  m('limits-status-daily', ENGINE, [" || this.deps.store.dailyWriterCalls() >= lim.dailyWriterCalls) return 'budget_exhausted'", ") return 'budget_exhausted'"], ENGINE_T),
  m('resolver-env-wins', ENGINE, ['const e = fromEnv[name], v = saved[name]', 'const e = null as number | null, v = saved[name]'], [...ENGINE_T, ...LIMITS_T]),
  m('resolver-saved-used', ENGINE, ['const e = fromEnv[name], v = saved[name]', 'const e = fromEnv[name], v = undefined as number | undefined'], [...ENGINE_T, ...LIMITS_T]),
  m('env-whole-range', ENGINE, ['return n >= min && n <= max ? n', 'return n >= min ? n'], LIMITS_T),
  m('env-whole-digits', ENGINE, ["const n = /^\\d{1,4}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN", 'const n = Number(raw.trim())'], LIMITS_T),
  m('env-max-per-meeting-read', ENGINE, ['maxCuesPerMeeting: envWhole(env, LIVE_CUES_V2_LIMIT_BOUNDS.maxCuesPerMeeting.env, 1, 25)', 'maxCuesPerMeeting: null'], LIMITS_T),
  m('env-daily-read', ENGINE, ['dailyWriterCalls: envWhole(env, LIVE_CUES_V2_LIMIT_BOUNDS.dailyWriterCalls.env, 1, 500)', 'dailyWriterCalls: null'], LIMITS_T),
  m('env-cooldown-read', ENGINE, ['    cooldownSeconds: envCooldownSeconds(env),', '    cooldownSeconds: null,'], LIMITS_T),
  m('day-charge-counts', ENGINE, ['    s.writerCalls += 1\n    s.today.writerCalls += 1\n', '    s.writerCalls += 1\n'], ENGINE_T),
  m('day-cue-counts', ENGINE, ['    s.today.cues += 1\n', ''], ENGINE_T),
  m('day-usage-recorded', ENGINE, ['        this.deps.store.recordUsage({ writerTokensIn:', '        void ({ writerTokensIn:'], ENGINE_T),
  m('day-usage-whole', ENGINE, ['n > 0 ? Math.round(n) : 0', 'n > 0 ? n : 0'], ENGINE_T),
  m('day-usage-positive', ENGINE, ['Number.isFinite(n) && n > 0 ? Math.round(n)', 'Number.isFinite(n) ? Math.round(n)'], ENGINE_T),
  m('day-rollover', ENGINE, ["if (s.day === undefined || (typeof s.day === 'string' && s.day < day)) today = zeroDay()", 'if (s.day === undefined) today = zeroDay()'], ENGINE_T),
  m('day-future-saturated', ENGINE, ['else if (s.day !== day) today = spentDay()', 'else if (s.day !== day) today = zeroDay()'], ENGINE_T),
  m('day-malformed-saturated', ENGINE, ['DAY_FIELDS.every(f => t[f] === undefined || Number(t[f]) >= 0)', 'true'], ENGINE_T),
  m('day-unreadable-saturated', ENGINE, ['        day: localDay(this.now(), zone), today: spentDay() }', '        day: localDay(this.now(), zone), today: zeroDay() }'], ENGINE_T),
  m('day-is-local', ENGINE, ["new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)", 'now.toISOString().slice(0, 10)'], ENGINE_T),
  m('apply-env-locked', ENGINE, ["  if (locked.length) return { ok: false, error: 'env_locked', fields: locked }\n", ''], LIMITS_T),
  m('apply-env-forced', ENGINE, ["  if (patch.enabled === false && liveCuesV2EnvForced(env)) return { ok: false, error: 'env_forced' }\n", ''], LIMITS_T),
  m('view-writer-cap', ENGINE, ['writerCallsPerMeeting: 2 * limits.maxCuesPerMeeting.value', 'writerCallsPerMeeting: LIVE_CUES_V2_LIMITS.maxWriterCallsPerMeeting'], LIMITS_T),
  m('route-get-v1-unless-v2', ROUTE, ["res.json(v === '2' ? liveCuesV2SettingsViewV2() : liveCuesV2SettingsView())", 'res.json(liveCuesV2SettingsViewV2())'], LIMITS_T),
  m('route-get-version-checked', ROUTE, ["  if (v !== undefined && v !== '2') return res.status(400)", "  if (false) return res.status(400)"], LIMITS_T),
  m('route-post-v1-unless-versioned', ROUTE, ['body.v !== undefined) return postSettingsV2', 'body.v === 2) return postSettingsV2'], LIMITS_T),
  m('route-post-version-checked', ROUTE, ['  if (body.v !== 2) return res.status(400)', '  if (false) return res.status(400)'], LIMITS_T),
  m('route-unknown-field', ROUTE, ['  if (unknown) return res.status(400)', '  if (false) return res.status(400)'], LIMITS_T),
  m('route-enabled-boolean', ROUTE, ["  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return", '  if (false) return'], LIMITS_T),
  m('route-bounds', ROUTE, ['    if (!limitInBounds(name, body[name])) {', '    if (false) {'], LIMITS_T),
  m('route-empty', ROUTE, ['  if (body.enabled === undefined && Object.keys(limits).length === 0) return', '  if (false) return'], LIMITS_T),
  m('contract-max-per-meeting', 'managed-runtime-contract.json', ['    "COS_LIVE_CUES_V2_MAX_PER_MEETING",\n', ''], ENGINE_T),
  m('contract-daily-writer-calls', 'managed-runtime-contract.json', ['    "COS_LIVE_CUES_V2_DAILY_WRITER_CALLS",\n', ''], ENGINE_T),
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
  console.log(`${killed} of ${selected.length} live cues 6.79.x mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
