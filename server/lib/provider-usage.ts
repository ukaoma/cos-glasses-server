// 6.97.0: real token usage, read from what a provider CLI already prints.
//
// Nothing in this file may reach an answer. Every reader takes data the caller already has, works on
// its own copy, and never throws: a bad or missing number leaves the audit row estimated and changes
// nothing else. Answers keep their own parsers, so a change here cannot change an answer.
//
// WHAT THE CLIS REPORT (probed 2026-10-31 on claude 2.1.316 and codex-cli 0.166.0-alpha.5.1; the
// numbers are pinned in provider-usage.test.ts). Two of these are running totals that a naive reader
// would count again on every turn of a resumed session, which is most G2 turns:
//
//   Claude result event
//     usage                          this turn, main loop only. No subagents, no helper calls.
//     modelUsage, total_cost_usd     RUNNING TOTALS, across results in one process AND across
//                                    --resume (a resumed session's first result carries earlier turns).
//     model_usage_since_last_result  per model, since this process's previous result. The right field.
//                                    Printed only with stream-json, not with `--output-format json`.
//   Codex turn.completed.usage       RUNNING TOTAL for the thread, across `exec resume`.
//                                    `input_tokens` includes `cached_input_tokens`.
//
// WHAT A ROW'S NUMBERS MEAN, PER PROVIDER. They are not the same everywhere, and a reader pricing them
// should know why. inputTokens never includes cache reads. Cache writes are another matter:
//   Claude  inputTokens excludes reads and writes. cacheWriteTokens is what the CLI reports.
//   Codex   inputTokens is input_tokens minus cached. cacheWriteTokens is absent: its own field read 0
//           on all 31,670 rollout rows checked on 2026-10-31, and nothing shows whether a nonzero one
//           would sit inside input_tokens, so any write stays in inputTokens.
//   Direct  inputTokens is prompt_tokens minus cached_tokens, when the provider states those. No cache
//           write is read, so any write stays in inputTokens.
//   Ollama  no cache at all.
// resolvedModel is what the provider says ran only on Claude. On Codex, direct and Ollama it is the id
// COS asked for (`--model`, or the request): Codex's stream names no model.

/** Measured usage of one run. Only `normalizeRealUsage` decides whether it counts as measured. */
export interface RealUsage {
  /** Never includes cache reads. Excludes cache writes only where they are reported: see the header. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** Of cacheWriteTokens, the part cached for an hour, which Claude bills higher. Only when stated. */
  cacheWrite1hTokens?: number
  /** Only when the provider stated it. Never computed here. */
  costUsd?: number
  /** Claude: the id the CLI says it ran. Codex, direct, Ollama: the id COS asked for. See the header. */
  resolvedModel?: string
}

/** What a reader found in one run's output, ready to spread onto a token-audit entry. */
export interface EngineUsage {
  realUsage?: RealUsage
  cliSessionId?: string
}

// Provider ids and model slugs have no spaces, so text from a prompt or an answer cannot pass here
// even if a provider ever put it in one of these fields. Two more shapes are refused because the audit
// file outlives everything that wrote it: anything shaped like a credential (the prefixes
// lens-gist-engines.ts redacts, and any long unbroken run, which no session id or model slug has:
// a UUID's longest is 12), and anything shaped like a path (one slash at most, as in vendor/model).
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]{0,127}$/
const KEY_SHAPED_RE = /(?:^|[^A-Za-z0-9])(?:sk|pk|rk|ak|pat)-[A-Za-z0-9_-]{3,}|(?:^|[^A-Za-z0-9])(?:gh[pousr]_|github_pat_|xox[abposr]-|eyJ[A-Za-z0-9_-]{4,}\.)|(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{8,}|[A-Za-z0-9]{32,}/i
const SLASH_RE = /\//g

export function cleanProviderId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !PROVIDER_ID_RE.test(value)) return undefined
  if (KEY_SHAPED_RE.test(value)) return undefined
  if (value.includes('..') || (value.match(SLASH_RE)?.length ?? 0) > 1) return undefined
  return value
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function dollars(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * The one gate for `usage_kind: provider_final`. Null unless input and output are both real counts
 * and something was actually used: a missing field, a negative, a float or an all-zero reading is an
 * estimate, not a measurement. Never throws.
 */
export function normalizeRealUsage(raw: RealUsage | null | undefined): RealUsage | null {
  try {
    if (!raw || typeof raw !== 'object') return null
    const input = count(raw.inputTokens)
    const output = count(raw.outputTokens)
    const read = raw.cacheReadTokens === undefined ? 0 : count(raw.cacheReadTokens)
    const write = raw.cacheWriteTokens === undefined ? 0 : count(raw.cacheWriteTokens)
    if (input === undefined || output === undefined || read === undefined || write === undefined) return null
    if (input + output + read + write <= 0) return null
    const cost = dollars(raw.costUsd)
    const model = cleanProviderId(raw.resolvedModel)
    // A part larger than its whole is not a reading; the four main counts stand without it.
    const write1h = count(raw.cacheWrite1hTokens)
    const hour = write1h !== undefined && write1h <= write ? write1h : undefined
    return {
      inputTokens: input,
      outputTokens: output,
      ...(raw.cacheReadTokens !== undefined ? { cacheReadTokens: read } : {}),
      ...(raw.cacheWriteTokens !== undefined ? { cacheWriteTokens: write } : {}),
      ...(hour !== undefined ? { cacheWrite1hTokens: hour } : {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
      ...(model ? { resolvedModel: model } : {}),
    }
  } catch {
    return null
  }
}

// --- Claude ---------------------------------------------------------------------------

interface ClaudeTally {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Undefined once any part of the tally did not state it, like cost. */
  cacheWrite1h: number | undefined
  /** Undefined once any part of the tally had no stated cost: a partial sum is not a cost. */
  cost: number | undefined
  byModel: Map<string, number>
}

function emptyTally(): ClaudeTally {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0, byModel: new Map() }
}

function addTally(into: ClaudeTally, more: ClaudeTally): void {
  into.input += more.input
  into.output += more.output
  into.cacheRead += more.cacheRead
  into.cacheWrite += more.cacheWrite
  into.cacheWrite1h = into.cacheWrite1h === undefined || more.cacheWrite1h === undefined ? undefined : into.cacheWrite1h + more.cacheWrite1h
  into.cost = into.cost === undefined || more.cost === undefined ? undefined : into.cost + more.cost
  for (const [model, weight] of more.byModel) into.byModel.set(model, (into.byModel.get(model) ?? 0) + weight)
}

/**
 * A modelUsage-shaped map. One malformed row makes the whole map unusable, never half a reading.
 * An empty map is a real answer, not a missing one: the CLI counted nothing, so it is an empty tally.
 */
function tallyFromModelMap(map: unknown): ClaudeTally | null {
  const rows = record(map)
  if (!rows) return null
  const tally = emptyTally()
  for (const [model, row] of Object.entries(rows)) {
    const r = record(row)
    if (!r) return null
    const input = count(r.inputTokens)
    const output = count(r.outputTokens)
    const read = r.cacheReadInputTokens === undefined ? 0 : count(r.cacheReadInputTokens)
    const write = r.cacheCreationInputTokens === undefined ? 0 : count(r.cacheCreationInputTokens)
    if (input === undefined || output === undefined || read === undefined || write === undefined) return null
    const cost = dollars(r.costUSD)
    const id = cleanProviderId(model)
    addTally(tally, {
      input, output, cacheRead: read, cacheWrite: write, cacheWrite1h: count(r.cacheCreationEphemeral1hInputTokens), cost,
      byModel: new Map(id ? [[id, input + output + read + write]] : []),
    })
  }
  return tally
}

function hasTokens(tally: ClaudeTally): boolean {
  return tally.input + tally.output + tally.cacheRead + tally.cacheWrite > 0
}

/** The `usage` of a result: one turn, main loop only. It states no cost. */
function tallyFromTurnUsage(usage: unknown): ClaudeTally | null {
  const u = record(usage)
  if (!u) return null
  const input = count(u.input_tokens)
  const output = count(u.output_tokens)
  const read = u.cache_read_input_tokens === undefined ? 0 : count(u.cache_read_input_tokens)
  const write = u.cache_creation_input_tokens === undefined ? 0 : count(u.cache_creation_input_tokens)
  if (input === undefined || output === undefined || read === undefined || write === undefined) return null
  const creation = record(u.cache_creation)
  return { input, output, cacheRead: read, cacheWrite: write, cacheWrite1h: count(creation?.ephemeral_1h_input_tokens), cost: undefined, byModel: new Map() }
}

/**
 * The usage of one Claude process, whatever number of results it wrote. Feed it every parsed event
 * and `take()` when a row is written; each result counts once, across any number of takes.
 *
 * `resumed` must be true when the process was started with --resume, because the running totals then
 * begin with earlier turns. Without the per-result field (an older CLI), a resumed run reports its
 * main-loop tokens and no cost, since no number it printed says what this run alone cost.
 */
export class ClaudeRunUsage {
  private readonly seen = new Set<string>()
  private results = 0
  /** Sticky for the run: once the CLI states per-result usage, its running totals are never read. */
  private sawSince = false
  private since = emptyTally()
  private turnCount = 0
  private turns = emptyTally()
  private cumulative: ClaudeTally | null = null
  private cumulativeCost: number | undefined
  private initModel: string | undefined
  /** A running total can be read once; a second read would count the first again. */
  private totalsTaken = false
  /** Set by the first event that names a session; a result's own id wins over an earlier one. */
  cliSessionId: string | undefined

  constructor(private readonly resumed: boolean) {}

  /** Never throws: this runs inside the bridges' stdout handlers. */
  observe(event: unknown): void {
    try {
      const e = record(event)
      if (!e) return
      if (e.type === 'system' && e.subtype === 'init') {
        this.initModel = cleanProviderId(e.model) ?? this.initModel
        this.cliSessionId = cleanProviderId(e.session_id) ?? this.cliSessionId
        return
      }
      if (e.type !== 'result') return
      this.cliSessionId = cleanProviderId(e.session_id) ?? this.cliSessionId
      if (typeof e.uuid === 'string') {
        if (this.seen.has(e.uuid)) return
        this.seen.add(e.uuid)
      }
      this.results++
      const since = tallyFromModelMap(e.model_usage_since_last_result)
      if (since) { addTally(this.since, since); this.sawSince = true }
      const turn = tallyFromTurnUsage(e.usage)
      if (turn) { addTally(this.turns, turn); this.turnCount++ }
      const cumulative = tallyFromModelMap(e.modelUsage)
      if (cumulative && hasTokens(cumulative)) this.cumulative = cumulative
      this.cumulativeCost = dollars(e.total_cost_usd) ?? this.cumulativeCost
    } catch {
      /* best effort: the row stays estimated */
    }
  }

  /** The results seen since the last take, once. Null when there is nothing real to report. */
  take(): RealUsage | null {
    try {
      const out = this.compute()
      this.results = 0
      this.since = emptyTally()
      this.turnCount = 0
      this.turns = emptyTally()
      return out
    } catch {
      return null
    }
  }

  private compute(): RealUsage | null {
    if (this.results === 0) return null
    if (this.sawSince) return this.toUsage(this.since, this.since.cost)
    // Below this line the running totals or per-turn usage are all there is. They cover a whole run,
    // so they are read at most once; a late result on such a CLI is not counted rather than doubled.
    if (this.totalsTaken) return null
    this.totalsTaken = true
    if (!this.resumed && this.cumulative) return this.toUsage(this.cumulative, this.cumulativeCost ?? this.cumulative.cost)
    if (this.turnCount !== this.results) return null
    return this.toUsage(this.turns, this.resumed ? undefined : this.cumulativeCost)
  }

  private toUsage(tally: ClaudeTally, cost: number | undefined): RealUsage | null {
    // A zero cost beside real tokens means the CLI could not price them, not that they were free.
    const stated = cost !== undefined && cost > 0 ? cost : undefined
    return normalizeRealUsage({
      inputTokens: tally.input,
      outputTokens: tally.output,
      cacheReadTokens: tally.cacheRead,
      cacheWriteTokens: tally.cacheWrite,
      ...(tally.cacheWrite1h !== undefined ? { cacheWrite1hTokens: tally.cacheWrite1h } : {}),
      ...(stated !== undefined ? { costUsd: stated } : {}),
      ...(this.modelOf(tally) ? { resolvedModel: this.modelOf(tally) } : {}),
    })
  }

  private modelOf(tally: ClaudeTally): string | undefined {
    if (this.initModel) return this.initModel
    // Per-turn usage names no model; the running totals still say which ones ran.
    const rows = tally.byModel.size > 0 ? tally.byModel : this.cumulative?.byModel ?? tally.byModel
    let best: string | undefined
    let weight = -1
    for (const [model, w] of rows) if (w > weight) { best = model; weight = w }
    return best
  }
}

// --- Codex ----------------------------------------------------------------------------

interface CodexTotals { input: number; cached: number; output: number }

function codexTotals(event: Record<string, unknown>): CodexTotals | null {
  const u = record(event.usage)
  if (!u) return null
  const input = count(u.input_tokens)
  const output = count(u.output_tokens)
  const cached = u.cached_input_tokens === undefined ? 0 : count(u.cached_input_tokens)
  if (input === undefined || output === undefined || cached === undefined) return null
  return { input, cached, output }
}

/** No cost: Codex does not state one. On `cache_write_input_tokens`, see the header. */
function codexRealUsage(totals: CodexTotals, model: string | undefined): RealUsage | null {
  return normalizeRealUsage({
    inputTokens: Math.max(0, totals.input - totals.cached),
    outputTokens: totals.output,
    cacheReadTokens: totals.cached,
    ...(model ? { resolvedModel: model } : {}),
  })
}

/** Where a thread's rollout had got to, in bytes, or null when that cannot be read. */
export type CodexRolloutProbe = (threadId: string) => number | null

/**
 * Registered at boot (codex-rollout-watermark.ts), so this file and the bridge do not load the session
 * stores. With none registered, a resumed turn can prove nothing and stays estimated. Not per-run: the
 * seam is the whole point of `registerCodexRolloutProbe`, and tests set it the same way.
 */
let registeredCodexRolloutProbe: CodexRolloutProbe | null = null
export function registerCodexRolloutProbe(probe: CodexRolloutProbe | null): void {
  registeredCodexRolloutProbe = probe
}

interface CodexBaseline {
  totals: CodexTotals
  /** The rollout's size once this bridge's turn had closed. Unset until then; null when unreadable. */
  watermark?: number | null
}

/** The last running total this bridge saw per thread, for its next turn. Lost on restart, on purpose. */
const codexThreadTotals = new Map<string, CodexBaseline>()
const CODEX_THREAD_TOTALS_MAX = 512

function rememberCodexTotals(threadId: string, totals: CodexTotals): void {
  codexThreadTotals.delete(threadId)
  codexThreadTotals.set(threadId, { totals })
  if (codexThreadTotals.size > CODEX_THREAD_TOTALS_MAX) codexThreadTotals.delete(codexThreadTotals.keys().next().value!)
}

/** Something other than this bridge is about to run on the thread: its next difference would be wrong. */
export function forgetCodexThreadTotals(threadId: string): void {
  codexThreadTotals.delete(threadId)
}

export function _resetCodexThreadTotalsForTest(): void {
  codexThreadTotals.clear()
}

/**
 * One Codex process's usage. A fresh thread's running total IS its first turn. A resumed turn is the
 * difference from the last total, but only when this bridge can show nothing else ran on the thread
 * since. A wrong real number is worse than an estimate, so each of these stays estimated:
 *   - no earlier total: the first resume after a restart, or a thread started elsewhere;
 *   - an earlier turn that never reported one (wall timeout, failure): `begin` consumes the baseline,
 *     so a turn that does not end with a total leaves none behind;
 *   - an attached run (`forgetCodexThreadTotals`);
 *   - the rollout grew between turns: the desktop app or the CLI, which COS cannot see any other way.
 * The total is kept each time, so the turn after is real again.
 */
export class CodexRunUsage {
  private last: CodexTotals | null = null
  private prior: CodexTotals | null = null
  private closed = false
  private finishedThread: string | undefined

  /**
   * `model` is the id COS passed on `--model`: Codex's stream never names the model it ran. `probe`
   * reads the rollout, defaulting to the one registered at boot.
   */
  constructor(private readonly model?: string, private readonly probe: CodexRolloutProbe | null = registeredCodexRolloutProbe) {}

  /** Before the process starts, when resuming: it writes to the rollout from its first moment. */
  begin(resumedFrom: string | undefined): void {
    try {
      const thread = cleanProviderId(resumedFrom)
      if (!thread) return
      const baseline = codexThreadTotals.get(thread)
      codexThreadTotals.delete(thread)
      if (!baseline || baseline.watermark === undefined || baseline.watermark === null) return
      if (this.probe?.(thread) === baseline.watermark) this.prior = baseline.totals
    } catch {
      this.prior = null
    }
  }

  /** Never throws: this runs inside the bridge's event handler. */
  observe(event: unknown): void {
    try {
      const e = record(event)
      if (e?.type !== 'turn.completed') return
      this.last = codexTotals(e) ?? this.last
    } catch {
      /* best effort: the row stays estimated */
    }
  }

  /** Call once, when the row is written. `resumedFrom` is the thread id passed to `exec resume`. */
  finish(threadId: string | undefined, resumedFrom: string | undefined): RealUsage | null {
    try {
      const totals = this.last
      if (!totals) return null
      const thread = cleanProviderId(threadId)
      if (thread) {
        rememberCodexTotals(thread, totals)
        this.finishedThread = thread
        if (this.closed) this.stampWatermark()
      }
      if (!resumedFrom) return codexRealUsage(totals, this.model)
      const prior = this.prior
      if (!prior || thread !== resumedFrom) return null
      const delta = { input: totals.input - prior.input, cached: totals.cached - prior.cached, output: totals.output - prior.output }
      if (delta.input < 0 || delta.cached < 0 || delta.output < 0) return null
      return codexRealUsage(delta, this.model)
    } catch {
      return null
    }
  }

  /** When the process has closed, so everything it wrote is on disk. Row and close can land in either order. */
  settle(): void {
    this.closed = true
    this.stampWatermark()
  }

  private stampWatermark(): void {
    try {
      const baseline = this.finishedThread ? codexThreadTotals.get(this.finishedThread) : undefined
      if (baseline && baseline.watermark === undefined) baseline.watermark = this.probe?.(this.finishedThread!) ?? null
    } catch {
      /* no watermark: the next turn stays estimated */
    }
  }
}

// --- One-shot calls: read the output once, after the process is done ---------------------

function jsonLines(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const event = record(JSON.parse(trimmed))
      if (event) events.push(event)
    } catch {
      /* not a JSON line */
    }
  }
  return events
}

/**
 * Usage of a one-shot, never-resumed call: the lens gist, cues, transcript cleanup and Meeting Ask.
 * Cursor's usage is not trusted (its cache parser has never produced a real row), so Cursor reports
 * its session id only. `model` is the id passed on `--model`, used only for Codex, which names none.
 * Never throws.
 */
export function readOneShotUsage(provider: 'claude' | 'codex' | 'cursor', stdout: string, model?: string): EngineUsage {
  try {
    const events = jsonLines(stdout)
    if (provider === 'claude') {
      const run = new ClaudeRunUsage(false)
      for (const event of events) run.observe(event)
      const realUsage = run.take()
      return { ...(realUsage ? { realUsage } : {}), ...(run.cliSessionId ? { cliSessionId: run.cliSessionId } : {}) }
    }
    if (provider === 'codex') {
      const run = new CodexRunUsage(model)
      let thread: string | undefined
      for (const event of events) {
        if (event.type === 'thread.started') thread = cleanProviderId(event.thread_id) ?? thread
        run.observe(event)
      }
      // `--ephemeral`: no resume, and no thread total worth keeping.
      const realUsage = run.finish(undefined, undefined)
      return { ...(realUsage ? { realUsage } : {}), ...(thread ? { cliSessionId: thread } : {}) }
    }
    const session = events.map(event => cleanProviderId(event.session_id)).find(Boolean)
    return session ? { cliSessionId: session } : {}
  } catch {
    return {}
  }
}

// --- Attached and fork runs: a passive reader on a live stdout ---------------------------

const SIDE_RUN_LINE_MAX = 2_000_000
// Cheap on every chunk; only lines that can carry usage or a final answer are parsed.
const SIDE_RUN_LINE_RE = /"type":"result"|"subtype":"init"|"agent_message"/

/**
 * Reads one attached or fork run's stdout. Both run on the user's own thread (resumed or copied), and
 * the user can also run that thread from the desktop. So Claude reports only the per-result field or
 * main-loop tokens, and Codex stays estimated: it has no baseline it could trust here.
 */
export class SideRunTap {
  private tail = ''
  private readonly claude: ClaudeRunUsage | null
  outputChars = 0
  sawEnd = false

  constructor(private readonly provider: 'claude' | 'codex' | 'cursor') {
    this.claude = provider === 'claude' ? new ClaudeRunUsage(true) : null
  }

  /** A second `data` listener that can cost only itself, like the job trail's tee. */
  attach(stdout: { on?: (event: string, listener: (chunk: unknown) => void) => unknown } | null | undefined): void {
    try {
      stdout?.on?.('data', chunk => this.feed(chunk))
    } catch {
      /* the run proceeds with an estimated row */
    }
  }

  feed(chunk: unknown): void {
    try {
      this.tail += typeof chunk === 'string' ? chunk : String(chunk)
      const lines = this.tail.split('\n')
      this.tail = lines.pop() ?? ''
      if (this.tail.length > SIDE_RUN_LINE_MAX) this.tail = ''
      for (const line of lines) this.readLine(line)
    } catch {
      /* the run proceeds with an estimated row */
    }
  }

  private readLine(line: string): void {
    if (!SIDE_RUN_LINE_RE.test(line)) return
    let event: Record<string, unknown> | null
    try {
      event = record(JSON.parse(line))
    } catch {
      return
    }
    if (!event) return
    this.claude?.observe(event)
    if (event.type === 'result') {
      this.sawEnd = true
      if (typeof event.result === 'string') this.outputChars = event.result.length
    }
    const item = record(event.item)
    if (this.provider === 'codex' && event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
      this.sawEnd = true
      this.outputChars += item.text.length
    }
  }

  /** The stream may end without a newline. Call once, when the run is over. */
  finish(): RealUsage | null {
    if (this.tail) {
      const last = this.tail
      this.tail = ''
      try { this.readLine(last) } catch { /* estimated */ }
    }
    return this.claude ? this.claude.take() : null
  }
}
