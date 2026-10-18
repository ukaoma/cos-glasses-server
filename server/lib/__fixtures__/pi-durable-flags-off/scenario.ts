// The 6.78.0 flags-off scenario (plan v3.1 G-off): every persisted byte and every route body
// P3 touches, captured as text, so the SAME scenario can be run against 6.77.0 (aa87c9d) to
// produce `golden-6.77.0.json` and against this tree to prove byte identity.
//
// IT IMPORTS NO SERVER MODULE. Every module arrives in `mods`, so the 6.77 run hands it the
// 6.77 modules and this tree's test hands it its own. The deps passed to each router are the
// 6.78 production wiring's (receipts, steer, evidence, attempts): a 6.77 router ignores the
// ones it does not know, and a 6.78 router with every flag off must not let them change a byte.
//
// Everything is deterministic: injected clocks and ids, fixed thread ids, fixed boot ids.
// Paths never reach the output.
import type { Server } from 'node:http'

export interface ScenarioMods {
  express: any
  createThreadTurnQueueRouter: (deps: any) => any
  drainThread: (provider: string, threadId: string, deps: any) => Promise<unknown>
  readQueue: (provider: string, threadId: string, now: number) => unknown[]
  writeQueue: (provider: string, threadId: string, queue: any[]) => void
  queuePath: (provider: string, threadId: string) => string
  createAgentSessionBindingsRouter: (deps: any) => any
  AgentSessionBindingRegistry: { open: (options: any) => any }
  targetKey: (provider: string, threadId: string) => string
  providerActs: (input: any) => unknown
  readFileSync: (path: string, enc: 'utf8') => string
}

const T1 = '11111111-1111-4111-8111-111111111111'
const T2 = '22222222-2222-4222-8222-222222222222'
const T3 = '33333333-3333-4333-8333-333333333333'
const T0 = 1_790_000_000_000
const FENCE = 21 * 60_000

type Reply = { status: number; text: string }

async function listen(app: any): Promise<{ server: Server; port: number }> {
  const server: Server = app.listen(0, '127.0.0.1')
  await new Promise<void>(r => server.once('listening', () => r()))
  return { server, port: (server.address() as { port: number }).port }
}

async function call(port: number, method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  // The Express error page embeds nothing variable but the path, which is fixed here.
  return { status: res.status, text: await res.text() }
}

export async function runFlagsOffScenario(mods: ScenarioMods, registryFile: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const file = (provider: string, thread: string) => { try { return mods.readFileSync(mods.queuePath(provider, thread), 'utf8') } catch { return null } }
  const registryText = () => { try { return mods.readFileSync(registryFile, 'utf8') } catch { return null } }

  // ---------------------------------------------------------------- queue router
  let clock = T0
  let gate: { attachable: boolean; reason: string | null } = { attachable: false, reason: 'native_thread_working' }
  const sends: string[] = []
  let outcome: (id: string) => any = () => ({ ok: true })
  const queueDeps = {
    occupancy: () => gate,
    turnEnded: () => true,
    activity: () => 'idle',
    deliver: async (t: { clientTurnId: string }) => { sends.push(t.clientTurnId); return outcome(t.clientTurnId) },
    now: () => clock,
    // 6.78 production wiring, inert with every flag off.
    bootId: 'boot-golden',
    deliveryEvidence: () => 'not_delivered',
    deliverLiveTurn: async () => ({ ok: true, reason: 'delivered' }),
    steerProbe: () => ({ peerInbox: true, waitingOnPrompt: false }),
    continueLive: () => true,
    attempts: { begin: () => true, settle: () => true },
  }
  const qapp = mods.express()
  qapp.use(mods.express.json())
  qapp.use('/api', mods.createThreadTurnQueueRouter(queueDeps))
  const q = await listen(qapp)
  const Q = (thread: string, provider = 'claude') => `/api/agent-sessions/${provider}/${thread}/queued-turns`
  try {
    out.q01_park = await call(q.port, 'POST', Q(T1), { clientTurnId: 'ct-golden-0001', cosSessionId: 'cos-1', prompt: 'first' })
    out.q02_duplicate = await call(q.port, 'POST', Q(T1), { clientTurnId: 'ct-golden-0001', cosSessionId: 'cos-1', prompt: 'first' })
    out.q03_steer_mode_ignored = await call(q.port, 'POST', Q(T1), { clientTurnId: 'ct-golden-0002', cosSessionId: 'cos-1', prompt: 'second', mode: 'steer', fallback: 'none' })
    out.q04_codex_steer_mode_ignored = await call(q.port, 'POST', Q(T1, 'codex'), { clientTurnId: 'ct-golden-0003', cosSessionId: 'cos-1', prompt: 'third', mode: 'steer' })
    out.q05_cursor_423 = await call(q.port, 'POST', Q(T1, 'cursor'), { clientTurnId: 'ct-golden-0004', cosSessionId: 'cos-1', prompt: 'x' })
    out.q06_invalid = await call(q.port, 'POST', Q(T1), { clientTurnId: 'ct-golden-0005', cosSessionId: 'bad id', prompt: 'x' })
    out.q07_list = await call(q.port, 'GET', Q(T1))
    out.q08_patch = await call(q.port, 'PATCH', `${Q(T1)}/ct-golden-0002`, { prompt: 'second edited' })
    out.q09_file_after_park = file('claude', T1)
    gate = { attachable: true, reason: null }
    out.q10_duplicate_when_free = await call(q.port, 'POST', Q(T1), { clientTurnId: 'ct-golden-0001', cosSessionId: 'cos-1', prompt: 'first' })
    out.q11_resend = await call(q.port, 'POST', `${Q(T1)}/ct-golden-0001/resend`, { clientTurnId: 'ct-golden-0099', cosSessionId: 'cos-1', acknowledge: 'may_duplicate' })
    // Drain: one delivered, one replayed-unknown answer, one retryable refusal.
    outcome = id => (id === 'ct-golden-0001' ? { ok: true }
      : id === 'ct-golden-0002' ? { ok: false, reason: 'delivery_ambiguous', serverRetryable: false, replayed: true, deliveryState: 'unknown' }
      : { ok: false, reason: 'native_thread_working' })
    clock += 60_000
    out.q12_drain = await mods.drainThread('claude', T1, queueDeps)
    out.q13_file_after_drain = file('claude', T1)
    out.q14_list_after_drain = await call(q.port, 'GET', Q(T1))
    out.q15_delete_settled = await call(q.port, 'DELETE', `${Q(T1)}/ct-golden-0002`)
    out.q16_delete_unknown = await call(q.port, 'DELETE', `${Q(T1)}/ct-golden-nope`)
    // A row a dead boot left delivering, with no stamp: 6.77 holds it forever.
    mods.writeQueue('claude', T2, [{ clientTurnId: 'ct-golden-0100', cosSessionId: 'cos-1', provider: 'claude', threadId: T2, prompt: 'stranded', queuedAt: T0, status: 'delivering', attempts: 1 }])
    out.q17_drain_stranded = await mods.drainThread('claude', T2, queueDeps)
    out.q18_file_stranded = file('claude', T2)
    out.q19_cancel_stranded = await call(q.port, 'DELETE', `${Q(T2)}/ct-golden-0100`)
    // Settled rows age out at 30 minutes whatever their reason.
    clock += 31 * 60_000
    out.q20_read_after_30min = JSON.stringify(mods.readQueue('claude', T1, clock))
    out.q21_sends = [...sends]
  } finally {
    q.server.close()
  }

  // ------------------------------------------------------------- bindings router
  let now = T0
  let live: () => Promise<{ ok: boolean; reason: string }> = async () => ({ ok: true, reason: 'delivered' })
  let adapter: () => Promise<unknown> = async () => ({ status: 'completed', nativeRevisionAfter: 'head-1' })
  let seq = 0
  let busy = false
  const registry = mods.AgentSessionBindingRegistry.open({ filePath: registryFile, now: T0, onWarn: () => {}, bootId: 'boot-golden-1' })
  const bindingDeps = (r: any) => ({
    probes: {
      isAlive: () => true, processStartMs: () => T0, fileExists: () => true, dirExists: () => true, readDir: () => [], readFile: () => '{}',
      lockHolders: () => [], cosSpawnedPids: () => new Map(), cursorAgentSession: () => null,
    },
    dirs: { claudeSessionsDir: '/x/.claude/sessions', codexLocksDir: '/x/.codex', cursorChatsDir: '/x/.cursor' },
    now: () => now,
    bindings: r,
    attachEnabled: true,
    occupancy: () => (busy ? { attachable: false, owners: [], reason: 'native_thread_working' } : { attachable: true, owners: [], reason: null }),
    resolveTarget: () => ({ workspaceFingerprint: 'w', sourceFingerprint: 's' }),
    nativeHead: () => 'head-1',
    deliverLiveTurn: async () => live(),
    deliverAttachedTurn: async () => adapter(),
    ownership: { record: () => 'recorded', release: () => true },
    newId: () => `g${++seq}`,
    // 6.78 production wiring, inert with every flag off.
    turnReceipt: () => ({ kind: 'unknown', source: 'attempt' }),
    sessionSteer: () => ({ available: true, mode: 'peer_inbox' }),
  })
  const bapp = mods.express()
  bapp.use(mods.express.json())
  bapp.use('/api', mods.createAgentSessionBindingsRouter(bindingDeps(registry)))
  const b = await listen(bapp)
  const settle = () => new Promise(r => setTimeout(r, 40))
  const attach = (thread: string) => call(b.port, 'POST', `/api/agent-sessions/claude/${thread}/attach`, { cosSessionId: 'cos-1' })
  const send = (binding: any, clientTurnId: string, thread = T1) =>
    call(b.port, 'POST', `/api/agent-sessions/bindings/${binding.bindingId}/turns`, { clientTurnId, prompt: 'golden prompt', epoch: binding.epoch, targetKey: mods.targetKey('claude', thread) })
  try {
    const a1 = await attach(T1)
    out.b01_attach = a1
    out.b02_attach_young_lease = await attach(T1)
    const bind1 = JSON.parse(a1.text)
    out.b03_turn_live = await send(bind1, 'ct-golden-b001')
    out.b04_turn_replay = await send(bind1, 'ct-golden-b001')
    live = async () => ({ ok: false, reason: 'unverified' })
    out.b05_turn_live_unverified = await send(bind1, 'ct-golden-b002')
    out.b06_turn_live_unverified_retry = await send(bind1, 'ct-golden-b002')
    live = async () => ({ ok: false, reason: 'no_record' })
    out.b07_turn_spawn = await send(bind1, 'ct-golden-b003')
    await settle()
    out.b08_turn_status = await call(b.port, 'GET', `/api/agent-sessions/bindings/${bind1.bindingId}/turns/ct-golden-b003`)
    adapter = async () => ({ status: 'aborted' })
    out.b09_turn_never_opened = await send(bind1, 'ct-golden-b004')
    await settle()
    out.b10_registry_after_turns = registryText()
    busy = true
    out.b11_attach_working = await attach(T3)
    busy = false
    // A turn whose process dies inside the provider run: the pin stays on disk.
    adapter = () => new Promise(() => { /* never returns */ })
    now += 91_000
    const a3 = await attach(T3)
    out.b12_attach_t3 = a3
    out.b13_turn_hangs = await send(JSON.parse(a3.text), 'ct-golden-b005', T3)
    await settle()
    out.b14_registry_with_live_pin = registryText()
  } finally {
    b.server.closeAllConnections()
    b.server.close()
  }

  // A restart: a new registry instance over the same file, 22 minutes after the pin.
  const after = T0 + 91_000 + FENCE + 60_000
  const reopened = mods.AgentSessionBindingRegistry.open({ filePath: registryFile, now: after, onWarn: () => {}, bootId: 'boot-golden-2' })
  out.r01_blocked_after_22min = reopened.attachBlocked('claude', T3, after)
  out.r02_reap_after_22min = reopened.reap(after)
  out.r03_registry_after_reap = registryText()
  now = after
  const rapp = mods.express()
  rapp.use(mods.express.json())
  rapp.use('/api', mods.createAgentSessionBindingsRouter(bindingDeps(reopened)))
  const r = await listen(rapp)
  try {
    out.r04_attach_after_restart = await call(r.port, 'POST', `/api/agent-sessions/claude/${T3}/attach`, { cosSessionId: 'cos-1' })
  } finally {
    r.server.closeAllConnections()
    r.server.close()
  }
  out.r05_registry_final = registryText()

  // -------------------------------------------------------------------- act
  out.a01_acts = mods.providerActs({ attachEnabled: true, forkProviders: ['claude', 'codex', 'cursor'], sessionCancel: { deskClaude: true }, brokerEnabled: true, continueLive: true, codexLiveQueue: true })
  return out
}
