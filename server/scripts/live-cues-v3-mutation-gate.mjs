#!/usr/bin/env node
// Live cues v3 mutation gate: grounded retrieval and judge B, the sources contract and the cue log schema, settings v3 (cue mode,
// grounding, general limits) and the public https validator. Mutations run only in a disposable copy of the checkout; the live
// checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/live-cues-v3-mutation-gate.mjs [--list] [--check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const GROUNDED_T = ['server/lib/live-cues-v2-grounded.test.ts']
const GROUNDING_T = ['server/lib/live-cues-v2-grounding.test.ts']
const PIN_T = ['server/lib/live-cues-v2-classic-pin.test.ts']
const ROUTE_T = ['server/routes/live-cues-v3-settings-route.test.ts']
const SETTINGS_T = ['server/lib/live-cues-v2-settings.test.ts']
const VERDICT_T = ['server/lib/live-cue-verdicts.test.ts']
const KINDS_T = ['server/lib/live-cues-v2-kinds.test.ts']
const URL_T = ['server/lib/public-https-url.test.ts']
const ALL = [...GROUNDED_T, ...GROUNDING_T, ...PIN_T, ...ROUTE_T, ...SETTINGS_T, ...VERDICT_T, ...KINDS_T, ...URL_T,
  'server/lib/live-cues-v2.test.ts', 'server/lib/live-cues-v2-notes.test.ts', 'server/routes/live-cues-v2-limits-route.test.ts', 'server/routes/live-cues-v2-settings-route.test.ts',
  'server/routes/live-cue-verdicts-route.test.ts']
const GR = 'server/lib/live-cues-v2-grounded.ts', JB = 'server/lib/live-cues-v2-judge-b.ts', EN = 'server/lib/live-cues-v2.ts', ST = 'server/lib/live-cues-v2-settings.ts'
const RT = 'server/routes/live-cues.ts', VD = 'server/lib/live-cue-verdicts.ts', SH = 'shared/live-cues-v2.ts', UR = 'server/lib/public-https-url.ts', NT = 'server/lib/live-cues-v2-notes.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── Judge B ──
  m('judgeb-yes-inclusive', JB, ['.filter(x => x.p >= threshold)', '.filter(x => x.p > threshold)'], GROUNDED_T),
  m('judgeb-cap', JB, ['    .slice(0, max)\n', ''], GROUNDED_T),
  m('judgeb-best-first', JB, ['b.p - a.p || a.order - b.order', 'a.p - b.p || a.order - b.order'], GROUNDED_T),
  m('judgeb-ties-keep-order', JB, ['b.p - a.p || a.order - b.order', 'b.p - a.p || b.order - a.order'], GROUNDED_T),
  m('judgeb-probability-range', JB, ['Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0', 'Number.isFinite(v) ? v : 0'], GROUNDED_T),
  m('judgeb-probability-number', JB, ["(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0)", '(Number(v) >= 0 && Number(v) <= 1 ? Number(v) : 0)'], GROUNDED_T),
  m('judgeb-note-300', JB, ['c.notes.slice(0, JUDGE_B_NOTE_CHARS)', 'c.notes'], GROUNDED_T),
  m('judgeb-one-question-per-candidate', JB, ["questions['rel_' + c.id] = {", "questions['rel' + c.id] = {"], GROUNDED_T),
  m('judgeb-reads-own-yes', JB, ["answers?.['rel_' + id]?.probabilities?.yes", "answers?.same?.probabilities?.yes"], GROUNDED_T),
  m('judgeb-same-diagnostic', JB, ['same[id] = prob(answers?.same?.probabilities?.[id])', 'same[id] = 0'], GROUNDED_T),
  m('judgeb-none-criterion', JB, ['criteria.none = CUE_JUDGE_NONE\n', ''], GROUNDED_T),
  // ── Grounded retrieval ──
  m('self-overlap-threshold', GR, ['sixGramOverlap(c.notes, transcript) >= GROUNDED_LIMITS.selfOverlap', 'sixGramOverlap(c.notes, transcript) > GROUNDED_LIMITS.selfOverlap'], GROUNDED_T),
  m('self-overlap-share-of-candidate', GR, ['return shared / own.size', 'return shared / Math.max(own.size, 40)'], GROUNDED_T),
  m('self-record-id', GR, ['if ((c.recordId && selfIds.has(c.recordId)) || (c.sessionId && selfIds.has(c.sessionId))) return true', 'if (c.sessionId && selfIds.has(c.sessionId)) return true'], GROUNDED_T),
  m('self-session-id', GR, ['if ((c.recordId && selfIds.has(c.recordId)) || (c.sessionId && selfIds.has(c.sessionId))) return true', 'if (c.recordId && selfIds.has(c.recordId)) return true'], GROUNDED_T),
  m('self-standalone-form', GR, ['out.add(id); out.add(`standalone:${id}`)', 'out.add(id)'], GROUNDED_T),
  m('self-exclusion-applied', GR, ['if (isSelfCopy(note, transcript, i.selfIds)) {', 'if (false) {'], GROUNDED_T),
  m('self-exclusion-counted', GR, ['{ excludedSelf += 1; continue }', '{ continue }'], GROUNDED_T),
  m('domain-personal-only', GR, ["return norm(noteDomain) === 'personal' && norm(meetingDomain) !== 'personal'", "return norm(noteDomain) === 'personal'"], GROUNDED_T),
  m('domain-personal-meeting-only', GR, ["return norm(noteDomain) === 'personal' && norm(meetingDomain) !== 'personal'", "return norm(meetingDomain) !== 'personal'"], GROUNDED_T),
  m('domain-filter-applied', GR, ['if (isForeignPersonal(note.domain, i.meetingDomain)) continue', 'if (false) continue'], GROUNDED_T),
  m('dedupe-applied', GR, ['if (identities.some(id => seen.has(id))) continue', 'if (false) continue'], GROUNDED_T),
  m('dedupe-remembers', GR, ['for (const id of identities) seen.add(id)\n', ''], GROUNDED_T),
  m('dedupe-normalised-title', GR, ['ids.push(`meeting:${c.date}|${normalizeMeetingTitle(c.title)}`)', 'ids.push(`meeting:${c.date}|${c.title}`)'], GROUNDED_T),
  m('file-identity-is-not-a-meeting', GR, ['if (c.date && c.title && !c.fileId) ids.push(', 'if (c.date && c.title) ids.push('], GROUNDED_T),
  m('dedupe-record-id', GR, ["if (c.recordId) ids.push(`record:${c.recordId}`)", ''], GROUNDED_T),
  m('dedupe-memory-id', GR, ["if (c.memoryId) ids.push(`memory:${c.memoryId}`)", ''], GROUNDED_T),
  m('title-punctuation', GR, ["title.toLowerCase().replace(/[!-/:-@[-`{-~]/g, ' ')", "title.toLowerCase().replace(/[!-/]/g, ' ')"], GROUNDED_T),
  m('cue-memory-four', GR, ["take(i.cueMemory, 'cue_memory', GROUNDED_LIMITS.cueMemoryTop, 'M')", "take(i.cueMemory, 'cue_memory', GROUNDED_LIMITS.cueMemoryRaw, 'M')"], GROUNDED_T),
  m('notes-one', GR, ["take(i.notes, 'notes', GROUNDED_LIMITS.notesTop, 'N')", "take(i.notes, 'notes', GROUNDED_LIMITS.cueMemoryTop, 'N')"], GROUNDED_T),
  m('candidates-six', GR, ['maxCandidates: 6,', 'maxCandidates: 5,'], GROUNDED_T),
  m('file-ready-only', GR, ["if (file.status !== 'ready' || typeof file.text", 'if (typeof file.text'], GROUNDED_T),
  m('file-needs-two-terms', GR, ['score >= GROUNDED_LIMITS.fileMinTerms', 'score >= 1'], GROUNDED_T),
  m('file-first-best-wins', GR, ['(!best || score > best.score)', '(!best || score >= best.score)'], GROUNDED_T),
  m('file-dated-with-the-meeting', GR, ["const file: GroundedNote = { id: 'F1', date: i.today,", "const file: GroundedNote = { id: 'F1', date: '',"], GROUNDED_T),
  m('file-not-self-checked', GR, ["      const file: GroundedNote = { id: 'F1'", "      if (isSelfCopy({ notes: hit.passage }, transcript, i.selfIds)) return { candidates: out, excludedSelf: excludedSelf + 1 }\n      const file: GroundedNote = { id: 'F1'"], GROUNDED_T),
  m('file-passage-cap', GR, ['fileChars: 300,', 'fileChars: 600,'], GROUNDED_T),
  m('file-window-terms', GR, ['fileWindowTerms: 12,', 'fileWindowTerms: 1,'], GROUNDED_T),
  m('kind-from-memory-key', GR, ["return { ...note, arm, kind: 'memory', memoryId: key.slice('memory:'.length) }", "return { ...note, arm, kind: 'meeting', memoryId: key.slice('memory:'.length) }"], GROUNDED_T),
  m('kind-from-meeting-key', GR, ["return { ...note, arm, kind: 'meeting', recordId: key.slice('meeting:'.length) }", "return { ...note, arm, kind: 'meeting' }"], GROUNDED_T),
  m('source-memory-locator', GR, ["if (note.kind === 'memory' && note.memoryId) return { ...base, memoryId: note.memoryId }\n", ''], GROUNDED_T),
  m('source-file-locator', GR, ["if (note.kind === 'file' && note.fileId) return { ...base, fileId: note.fileId }\n", ''], GROUNDED_T),
  m('source-record-locator', GR, ["if (note.kind === 'meeting' && note.recordId) return { ...base, recordId: note.recordId }\n", ''], GROUNDED_T),
  m('source-kind', GR, ['const base: CueSourceRef = { id, date: note.date, title: note.title, kind: note.kind }', 'const base: CueSourceRef = { id, date: note.date, title: note.title }'], GROUNDED_T),
  // ── Engine: grounded evaluation ──
  m('grounding-reads-setting', EN, ["return resolveLiveCuesGrounding(this.deps.env, this.deps.settings).value === 'grounded'", "return resolveLiveCuesGrounding(this.deps.env, null).value === 'grounded'"], GROUNDING_T),
  m('grounding-off-is-classic', EN, ["return resolveLiveCuesGrounding(this.deps.env, this.deps.settings).value === 'grounded'", 'return true'], [...GROUNDING_T, ...PIN_T]),
  m('grounded-skips-classic-memory', EN, ['let mem: MemoryResult = grounded ? { notes: [] } : await this.deps.memory(', 'let mem: MemoryResult = await this.deps.memory('], GROUNDING_T),
  m('grounded-skips-classic-judge', EN, ['if (!grounded && mem.notes.length && !abort.signal.aborted) {', 'if (mem.notes.length && !abort.signal.aborted) {'], GROUNDING_T),
  m('grounded-arms-in-parallel', EN, [
    ["    const [cm, nt] = await Promise.all([\n      timed(() => this.deps.memory(window, before, signal, GROUNDED_LIMITS.cueMemoryRaw), 'memory_threw'),\n      timed(() => this.deps.notes(window, before, signal, s.sessionId), 'notes_threw'),\n    ])",
      "    const cm = await timed(() => this.deps.memory(window, before, signal, GROUNDED_LIMITS.cueMemoryRaw), 'memory_threw')\n    const nt = await timed(() => this.deps.notes(window, before, signal, s.sessionId), 'notes_threw')"]], GROUNDING_T),
  m('grounded-asks-for-eight', EN, ["this.deps.memory(window, before, signal, GROUNDED_LIMITS.cueMemoryRaw), 'memory_threw')", "this.deps.memory(window, before, signal, 4), 'memory_threw')"], GROUNDING_T),
  m('grounded-notes-always', EN, ["timed(() => this.deps.notes(window, before, signal, s.sessionId), 'notes_threw'),", "timed(async () => ({ notes: [] }), 'notes_threw'),"], GROUNDING_T),
  m('grounded-twins', EN, ['const twins = [...this.sessions.keys()].filter(id => id !== s.sessionId)', 'const twins: string[] = []'], GROUNDING_T),
  m('grounded-orientation-caught', EN, ['catch (e) { trace.orientationError = codeOf(e) }', 'catch (e) { throw e }'], GROUNDING_T),
  m('grounded-files-caught', EN, ['catch (e) { trace.filesError = codeOf(e) }', 'catch (e) { throw e }'], GROUNDING_T),
  m('grounded-error-code-reason', EN, ["typeof r?.reason === 'string' ? r.reason : typeof r?.code === 'string' ? r.code : 'threw'", "typeof r?.code === 'string' ? r.code : 'threw'"], GROUNDING_T),
  m('grounded-arm-failure-traced', EN, ['catch { return { res: { notes: [], denseError: threw }, ms: null } }', 'catch { return { res: { notes: [] }, ms: null } }'], GROUNDING_T),
  m('grounded-arm-failure-null-ms', EN, ['catch { return { res: { notes: [], denseError: threw }, ms: null } }', 'catch { return { res: { notes: [], denseError: threw }, ms: 0 } }'], GROUNDING_T),
  m('grounded-trace-flag', EN, ["    trace.grounding = 'grounded'\n", ''], GROUNDING_T),
  m('grounded-trace-ready-files', EN, ["files: files.filter(f => f.status === 'ready').length }, excludedSelf })", 'files: files.length }, excludedSelf })'], GROUNDING_T),
  m('grounded-trace-excluded-self', EN, ["files: files.filter(f => f.status === 'ready').length }, excludedSelf })", "files: files.filter(f => f.status === 'ready').length } })"], GROUNDING_T),
  m('grounded-trace-judge', EN, ['yes: round(judged.yes[c.id] ?? 0), same: round(judged.same[c.id] ?? 0) })) })', 'yes: 0, same: 0 })) })'], GROUNDING_T),
  m('grounded-trace-kept-ids', EN, ['trace.kept = run ? kept.map(m => m.id) : kept.length', 'trace.kept = kept.length'], GROUNDING_T),
  m('classic-trace-kept-count', EN, ['trace.kept = run ? kept.map(m => m.id) : kept.length', 'trace.kept = kept.map(m => m.id)'], PIN_T),
  m('grounded-source-arm', EN, ["const source: LiveCuesV2MemorySource = candidates.some(c => c.arm === 'cue_memory') ? 'cue_memory' : candidates.some(c => c.arm === 'notes') ? 'notes' : 'none'", "const source: LiveCuesV2MemorySource = 'cue_memory'"], GROUNDING_T),
  m('grounded-arms-contributed', EN, ["(['cue_memory', 'notes', 'files'] as const).filter(a => candidates.some(c => c.arm === a))", "(['cue_memory', 'notes', 'files'] as const)"], GROUNDING_T),
  m('grounded-arms-logged', EN, ['...(run ? { arms: run.arms } : {}) })', '...({}) })'], GROUNDING_T),
  m('classic-log-has-no-arms', EN, ['...(run ? { arms: run.arms } : {}) })', '...({ arms: run?.arms ?? [] }) })'], PIN_T),
  m('grounded-sources-carry-kind', EN, ['.map(m => (run ? groundedSource(m as GroundedNote, sourceId(m)) : { id: sourceId(m), date: m.date, title: m.title }))', '.map(m => ({ id: sourceId(m), date: m.date, title: m.title }))'], GROUNDING_T),
  m('grounded-no-candidates-no-judge', EN, ['if (candidates.length && !signal.aborted) {', 'if (!signal.aborted) {'], GROUNDING_T),
  m('grounded-cancelled-no-judge', EN, ['if (candidates.length && !signal.aborted) {', 'if (candidates.length) {'], GROUNDING_T),
  m('grounded-judge-title', EN, ['await this.deps.judgeB(s.title, window, candidates, signal, provider)', 'await this.deps.judgeB(writerTitle, window, candidates, signal, provider)'], GROUNDING_T),
  m('grounded-writer-title', EN, ['meetingTitle: run?.writerTitle ?? s.title', 'meetingTitle: s.title'], GROUNDING_T),
  m('grounded-writer-title-120', EN, ["const title = (calendarTitle ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120)", "const title = (calendarTitle ?? '').replace(/\\s+/g, ' ').trim().slice(0, 300)"], GROUNDING_T),
  m('grounded-writer-title-trimmed', EN, ["const title = (calendarTitle ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120)", "const title = (calendarTitle ?? '').slice(0, 120)"], GROUNDING_T),
  m('grounded-keep-bar', EN, ['kept = selectJudgeB(candidates, judged.yes, liveCuesV2JudgeYes(this.deps.env), LIVE_CUES_V2_LIMITS.judgeMaxNotes)', 'kept = selectJudgeB(candidates, judged.yes, LIVE_CUES_V2_LIMITS.judgeKeep, LIVE_CUES_V2_LIMITS.judgeMaxNotes)'], GROUNDING_T),
  m('grounded-keep-env-bar', EN, ['kept = selectJudgeB(candidates, judged.yes, liveCuesV2JudgeYes(this.deps.env), LIVE_CUES_V2_LIMITS.judgeMaxNotes)', 'kept = selectJudgeB(candidates, judged.yes, LIVE_CUES_V2_LIMITS.judgeYes, LIVE_CUES_V2_LIMITS.judgeMaxNotes)'], GROUNDING_T),
  m('grounded-keep-two', EN, ['kept = selectJudgeB(candidates, judged.yes, liveCuesV2JudgeYes(this.deps.env), LIVE_CUES_V2_LIMITS.judgeMaxNotes)', 'kept = selectJudgeB(candidates, judged.yes, liveCuesV2JudgeYes(this.deps.env), 4)'], GROUNDING_T),
  m('judge-yes-default', EN, ['judgeYes: 0.65,', 'judgeYes: 0.7,'], GROUNDING_T),
  m('judge-yes-min-inclusive', EN, ['return yes >= 0.5 && yes <= 0.95 ? yes : knobFallback(', 'return yes > 0.5 && yes <= 0.95 ? yes : knobFallback('], GROUNDING_T),
  m('judge-yes-max-inclusive', EN, ['return yes >= 0.5 && yes <= 0.95 ? yes : knobFallback(', 'return yes >= 0.5 && yes < 0.95 ? yes : knobFallback('], GROUNDING_T),
  m('judge-yes-empty-is-default', EN, ["if (raw === undefined || raw.trim() === '') return LIVE_CUES_V2_LIMITS.judgeYes", 'if (raw === undefined) return LIVE_CUES_V2_LIMITS.judgeYes'], GROUNDING_T),
  m('memory-top-on-the-wire', EN, ['keywordText: window, before, top }))', 'keywordText: window, before, top: 4 }))'], GROUNDING_T),
  m('memory-top-kept', EN, ["typeof n.notes === 'string').slice(0, top)", "typeof n.notes === 'string').slice(0, 4)"], GROUNDING_T),
  m('end-no-insight-twin', EN, ['cues.flatMap(c => (isCueKind(c.kind) ? [{', 'cues.flatMap(c => (true ? [{'], KINDS_T),
  // ── Engine: settings view and apply ──
  m('view-v3-version', EN, ['return { ...v2, v: 3, cueMode:', 'return { ...v2, v: 2 as never, cueMode:'], ROUTE_T),
  m('view-v3-cue-mode', EN, ['cueMode: resolveLiveCuesCueMode(env, settings), grounding:', 'cueMode: resolveLiveCuesCueMode(env, null), grounding:'], ROUTE_T),
  m('view-v3-grounding', EN, ['grounding: resolveLiveCuesGrounding(env, settings),\n', 'grounding: resolveLiveCuesGrounding(env, null),\n'], ROUTE_T),
  m('view-v3-public-topics', EN, ['publicTopics = new MeetingAskStore().publicTopics()', 'publicTopics = false'], ROUTE_T),
  m('view-v3-home-area', EN, ['homeArea = getOwnerHomeArea()', 'homeArea = null'], ROUTE_T),
  m('view-v3-today-provider', EN, ['today = generalTodayProvider ? generalTodayProvider() : {', 'today = {'], ROUTE_T),
  m('view-v3-today-provider-throws', EN, ['} catch { today = { day: v2.today.day, topicCalls: 0, webSearches: 0, breakerOpenUntil: null } }', "} catch { throw new Error('provider') }"], ROUTE_T),
  m('apply-env-forced-mode', EN, ["resolveLiveCuesCueMode(env, liveCuesV2Settings()).locked) forced.push('cueMode')", "false) forced.push('cueMode')"], ROUTE_T),
  m('apply-env-forced-mode-allows-focused', EN, ["patch.cueMode !== undefined && patch.cueMode !== 'focused' && resolveLiveCuesCueMode", 'patch.cueMode !== undefined && resolveLiveCuesCueMode'], ROUTE_T),
  m('apply-env-forced-grounding', EN, ["resolveLiveCuesGrounding(env, liveCuesV2Settings()).locked) forced.push('grounding')", "false) forced.push('grounding')"], ROUTE_T),
  m('apply-env-forced-grounding-allows-classic', EN, ["patch.grounding !== undefined && patch.grounding !== 'classic' && resolveLiveCuesGrounding", 'patch.grounding !== undefined && resolveLiveCuesGrounding'], ROUTE_T),
  m('apply-env-locked-general', EN, ['...(Object.keys(patch.general ?? {}) as LiveCuesGeneralLimitName[]).filter(name => generalNow[name].locked).map(name => LIVE_CUES_GENERAL_LIMIT_BOUNDS[name].field),', ''], ROUTE_T),
  m('apply-env-locked-wire-name', EN, ['.filter(name => generalNow[name].locked).map(name => LIVE_CUES_GENERAL_LIMIT_BOUNDS[name].field)', '.filter(name => generalNow[name].locked)'], ROUTE_T),
  m('general-env-integers', EN, ['if (b.integer) e = envWhole(env, b.env, b.min, b.max)', 'if (b.integer) e = null'], ROUTE_T),
  m('general-env-trigger-range', EN, ['e = n === null ? null : n >= b.min && n <= b.max ? n : knobFallback', 'e = n === null ? null : n >= b.min ? n : knobFallback'], ROUTE_T),
  m('general-env-locks', EN, ["out[name] = e !== null ? { value: e, source: 'env', locked: true, min: b.min, max: b.max, default: b.default }\n      : v !== undefined ? { value: v, source: 'setting', locked: false, min: b.min, max: b.max, default: b.default }\n        : { value: b.default, source: 'default', locked: false, min: b.min, max: b.max, default: b.default }\n  }\n  return out\n}\nexport function liveCuesV2JudgeKeep", "out[name] = e !== null ? { value: e, source: 'env', locked: false, min: b.min, max: b.max, default: b.default }\n      : v !== undefined ? { value: v, source: 'setting', locked: false, min: b.min, max: b.max, default: b.default }\n        : { value: b.default, source: 'default', locked: false, min: b.min, max: b.max, default: b.default }\n  }\n  return out\n}\nexport function liveCuesV2JudgeKeep"], ROUTE_T),
  // ── Settings store and resolution ──
  m('store-schema-3', ST, ['hasV3 ? 3 : hasLimits ? 2 : 1', 'hasLimits ? 2 : 1'], SETTINGS_T),
  m('store-keeps-cue-mode', ST, ['const cueMode = patch.cueMode ?? current.cueMode', 'const cueMode = patch.cueMode ?? null'], SETTINGS_T),
  m('store-keeps-grounding', ST, ['const grounding = patch.grounding ?? current.grounding', 'const grounding = patch.grounding ?? null'], SETTINGS_T),
  m('store-merges-general', ST, ['const general = { ...current.general, ...patch.general }', 'const general = { ...patch.general }'], SETTINGS_T),
  m('store-writes-wire-names', ST, ['[LIVE_CUES_GENERAL_LIMIT_BOUNDS[n].field, general[n]]', '[n, general[n]]'], SETTINGS_T),
  m('store-reads-wire-names', ST, ['const field = LIVE_CUES_GENERAL_LIMIT_BOUNDS[name].field\n            if (generalLimitInBounds(name, r[field]))', 'const field = name\n            if (generalLimitInBounds(name, r[field]))'], SETTINGS_T),
  m('store-validates-cue-mode', ST, ['if (isCueMode(r.cueMode)) cueMode = r.cueMode', 'if (r.cueMode !== undefined) cueMode = r.cueMode as LiveCuesCueMode'], SETTINGS_T),
  m('store-validates-grounding', ST, ['if (isGrounding(r.grounding)) grounding = r.grounding', 'if (r.grounding !== undefined) grounding = r.grounding as LiveCuesGrounding'], SETTINGS_T),
  m('store-validates-general-bounds', ST, ['if (generalLimitInBounds(name, r[field])) general[name] = r[field] as number', 'general[name] = r[field] as number'], SETTINGS_T),
  m('resolve-mode-env-only-focused', ST, ["if (env.COS_LIVE_CUES_MODE === 'focused')", 'if (env.COS_LIVE_CUES_MODE)'], SETTINGS_T),
  m('resolve-grounding-env-only-classic', ST, ["if (env.COS_LIVE_CUES_GROUNDING === 'classic')", 'if (env.COS_LIVE_CUES_GROUNDING)'], SETTINGS_T),
  m('resolve-mode-validated', ST, ['try { const v = settings?.cueMode?.(); stored = isCueMode(v) ? v : null } catch { stored = null }', 'try { const v = settings?.cueMode?.(); stored = (v ?? null) as LiveCuesCueMode | null } catch { stored = null }'], SETTINGS_T),
  m('resolve-grounding-validated', ST, ['try { const v = settings?.grounding?.(); stored = isGrounding(v) ? v : null } catch { stored = null }', 'try { const v = settings?.grounding?.(); stored = (v ?? null) as LiveCuesGrounding | null } catch { stored = null }'], [...SETTINGS_T, ...PIN_T]),
  m('resolve-mode-reader-throws', ST, ['try { const v = settings?.cueMode?.(); stored = isCueMode(v) ? v : null } catch { stored = null }', '{ const v = settings?.cueMode?.(); stored = isCueMode(v) ? v : null }'], SETTINGS_T),
  m('resolve-grounding-reader-throws', ST, ['try { const v = settings?.grounding?.(); stored = isGrounding(v) ? v : null } catch { stored = null }', '{ const v = settings?.grounding?.(); stored = isGrounding(v) ? v : null }'], [...SETTINGS_T, ...PIN_T]),
  m('general-limit-default-interval', ST, ["intervalSeconds: { field: 'generalIntervalSeconds', min: 120, max: 1800, default: 300,", "intervalSeconds: { field: 'generalIntervalSeconds', min: 120, max: 1800, default: 360,"], SETTINGS_T),
  m('general-limit-bound-trigger', ST, ["trigger: { field: 'generalTrigger', min: 0.4, max: 0.9,", "trigger: { field: 'generalTrigger', min: 0.4, max: 0.95,"], SETTINGS_T),
  // ── Route ──
  m('route-get-v3', RT, ["v === '3' ? liveCuesV2SettingsViewV3() : v === '2'", "v === '3' ? liveCuesV2SettingsViewV2() : v === '2'"], ROUTE_T),
  m('route-v2-refuses-v3-fields', RT, ['!(v3 ? V3_SETTINGS_KEYS : V2_SETTINGS_KEYS).has(k)', '!V3_SETTINGS_KEYS.has(k)'], ROUTE_T),
  m('route-v3-takes-v3-fields', RT, ['!(v3 ? V3_SETTINGS_KEYS : V2_SETTINGS_KEYS).has(k)', '!V2_SETTINGS_KEYS.has(k)'], ROUTE_T),
  m('route-cue-mode-enum', RT, ['if (v3 && body.cueMode !== undefined && !isCueMode(body.cueMode))', 'if (false)'], ROUTE_T),
  m('route-grounding-enum', RT, ['if (v3 && body.grounding !== undefined && !isGrounding(body.grounding))', 'if (false)'], ROUTE_T),
  m('route-general-bounds', RT, ['if (!generalLimitInBounds(name, body[b.field])) return res.status(400)', 'if (false) return res.status(400)'], ROUTE_T),
  m('route-general-bounds-wire-field', RT, ["reason: 'out_of_bounds', field: b.field, min: b.min", "reason: 'out_of_bounds', field: name, min: b.min"], ROUTE_T),
  m('route-env-forced-fields', RT, ["result.fields ? { error: 'env_forced', fields: result.fields } : { error: result.error }", '{ error: result.error }'], ROUTE_T),
  m('route-answers-v3', RT, ['return res.json(v3 ? liveCuesV2SettingsViewV3() : liveCuesV2SettingsViewV2())', 'return res.json(liveCuesV2SettingsViewV2())'], ROUTE_T),
  m('route-passes-cue-mode', RT, ['...(isCueMode(body.cueMode) ? { cueMode: body.cueMode } : {}),', ''], ROUTE_T),
  m('route-passes-general', RT, ['...(Object.keys(general).length ? { general } : {}) })', '})'], ROUTE_T),
  // ── Cue log schema ──
  m('log-source-extras', VD, ['if (!isCueSourceExtras(s)) return false', ''], VERDICT_T),
  m('log-source-url-public', VD, ['return s.url === undefined || publicHttpsUrl(s.url) !== null', 'return true'], VERDICT_T),
  m('log-source-base-strings', VD, ['if (!(str(s.id) && str(s.date) && str(s.title))) return false', ''], VERDICT_T),
  m('log-arms-enum', VD, ['a.every(x => (LIVE_CUE_ARMS as readonly unknown[]).includes(x))', 'true'], VERDICT_T),
  m('log-arms-unique', VD, ['new Set(a).size === a.length && ', ''], VERDICT_T),
  m('log-arms-array', VD, ["optional(r.arms, a => Array.isArray(a) && ", "optional(r.arms, a => "], VERDICT_T),
  m('log-general-category', VD, ['(LIVE_CUE_GENERAL_CATEGORIES as readonly unknown[]).includes(g.category) && ', ''], VERDICT_T),
  m('log-general-query-not-empty', VD, ['str(g.query) && g.query.length > 0 && ', 'str(g.query) && '], VERDICT_T),
  m('log-general-query-length', VD, [' && g.query.length <= LIVE_CUE_GENERAL_QUERY_MAX', ''], VERDICT_T),
  m('log-general-checked', VD, ['&& optional(r.general, isGeneral)', ''], VERDICT_T),
  m('log-arms-checked', VD, ['&& optional(r.arms, a =>', '&& optional(r.arms, a => true || '], VERDICT_T),
  // ── Shared contract ──
  m('contract-one-locator', SH, ['if (locators.length > 1) return false\n', ''], KINDS_T),
  m('contract-locator-matches-kind', SH, ['if (locators.length === 1 && locators[0] !== CUE_SOURCE_LOCATOR[source.kind]) return false\n', ''], KINDS_T),
  m('contract-no-kind-no-locator', SH, ['if (source.kind === undefined) return locators.length === 0', 'if (source.kind === undefined) return true'], KINDS_T),
  m('contract-known-kind', SH, ['if (!(CUE_SOURCE_KINDS as readonly string[]).includes(source.kind)) return false\n', ''], KINDS_T),
  m('contract-url-https', SH, ["return source.url === undefined || source.url.startsWith('https://')", 'return true'], KINDS_T),
  m('contract-locator-nonempty', SH, ["if (value !== undefined && (typeof value !== 'string' || value.length === 0 || value.length > 2048)) return false", ''], KINDS_T),
  m('contract-insight-is-a-log-kind', SH, ['(GENERAL_CUE_KINDS as readonly string[]).includes(value))', 'false)'], KINDS_T),
  m('contract-live-cue-checks-extras', SH, ["typeof (s as CueSourceRef).title === 'string'\n      && isCueSourceExtras(s as CueSourceRef))", "typeof (s as CueSourceRef).title === 'string')"], KINDS_T),
  m('contract-live-cue-takes-insight', SH, ['    && isLogCueKind(v.kind)\n', '    && isCueKind(v.kind)\n'], KINDS_T),
  // ── Public https validator ──
  m('url-https-only', UR, ["u.protocol !== 'https:' ||", "(u.protocol !== 'https:' && u.protocol !== 'http:') ||"], URL_T),
  m('url-no-credentials', UR, ['|| u.username || u.password ||', '||'], URL_T),
  m('url-public-host', UR, ['!publicAddress(u.hostname) ||', ''], URL_T),
  m('url-port', UR, ["u.port && !['80', '443'].includes(u.port)", 'false'], URL_T),
  m('url-length', UR, ["value.length > 2048", 'false'], URL_T),
  // ── Notes arm: domain and session ride along ──
  m('notes-carry-meeting-domain', NT, ['...domainOf(hit.domain), ...(hit.sessionId ? { sessionId: hit.sessionId } : {}) }', '...(hit.sessionId ? { sessionId: hit.sessionId } : {}) }'], [...GROUNDED_T, ...GROUNDING_T, 'server/lib/live-cues-v2-notes.test.ts']),
  m('notes-carry-bridge-domain', NT, ['key: `memory:${row.id}`, ...domainOf(row.domain) }', 'key: `memory:${row.id}` }'], [...GROUNDED_T, ...GROUNDING_T, 'server/lib/live-cues-v2-notes.test.ts']),
  m('notes-domain-trimmed', NT, ['{ domain: v.trim() }', '{ domain: v }'], [...GROUNDED_T, ...GROUNDING_T, 'server/lib/live-cues-v2-notes.test.ts']),
  m('notes-blank-domain-is-none', NT, ["typeof v === 'string' && v.trim() ? { domain: v.trim() } : {}", "typeof v === 'string' ? { domain: v.trim() } : {}"], [...GROUNDED_T, ...GROUNDING_T, 'server/lib/live-cues-v2-notes.test.ts']),
  m('notes-carry-domain', NT, ['key: `memory:${hit.id}`, ...domainOf(hit.domain) }', 'key: `memory:${hit.id}` }'], [...GROUNDED_T, ...GROUNDING_T, 'server/lib/live-cues-v2-notes.test.ts']),
  m('notes-carry-session', NT, ["...(hit.sessionId ? { sessionId: hit.sessionId } : {}) }", '}'], [...GROUNDED_T, ...GROUNDING_T, 'server/lib/live-cues-v2-notes.test.ts']),
]

const args = process.argv.slice(2)
const names = args.filter(a => !a.startsWith('--'))
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = names.length ? mutations.filter(({ name }) => names.includes(name)) : mutations
if (names.length && selected.length !== names.length) throw new Error('Unknown mutation name in: ' + names.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')

/** The edits applied to one file's text. Each target must match exactly once and the result must differ. */
function mutate(original, { name, file, edits }) {
  let mutated = original
  for (const [find, replacement] of edits) {
    if (mutated.split(find).length !== 2) throw new Error(`Mutation ${name} does not match exactly once in ${file}: ${find.slice(0, 80)}`)
    mutated = mutated.replace(find, () => replacement)
  }
  if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
  return mutated
}
// --check: prove every target matches exactly once in the live checkout, without running a test (the baseline is the slow part).
if (args.includes('--check')) {
  let bad = 0
  for (const mutation of selected) {
    try { mutate(readFileSync(join(root, mutation.file), 'utf8'), mutation) } catch (error) { bad += 1; console.log(error.message) }
  }
  console.log(`${selected.length - bad} of ${selected.length} mutation targets match exactly once`)
  process.exit(bad ? 1 : 0)
}

const scratch = mkdtempSync(join(tmpdir(), 'cue-v3-mutations-'))
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
    const mutated = mutate(original, { name, file, edits })
    writeFileSync(target, mutated)
    let result
    try { result = run(tests) } finally { writeFileSync(target, original) }
    if (readFileSync(target, 'utf8') !== original) throw new Error(`Restore failed for ${file} after ${name}`)
    const output = result.stdout + '\n' + result.stderr
    const killers = [...new Set([...output.matchAll(/FAIL\s+((?:server|shared)\/\S+\.test\.ts > [^\n]+)/g)].map(x => x[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) { console.log(`${name} SURVIVED or harness failed\n${output.slice(-3000)}`); process.exitCode = 1; continue }
    killed += 1
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  console.log(`${killed} of ${selected.length} live cues v3 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
