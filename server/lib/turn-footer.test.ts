// The verify footer (6.99.29): one trailing line, either tag, taken off wherever COS compares or
// shows the words it sent, and nowhere else.
import { describe, expect, it } from 'vitest'
import { G2_TURN_FOOTER_RE, hasFooterShapedLine, stripG2TurnFooter, turnFooter, withoutTurnFooter } from './turn-footer.js'
import { makeDeliveryEvidence, makeTurnReceiptLookup, transcriptShowsPrompt } from './queue-turn-evidence.js'
import { promptDrafts } from './session-stream-events.js'
import { sessionTurnFromRecord } from './agent-session-turns.js'
import { isDeliveredPrompt } from './session-halt.js'
import { parseAgentSession } from './agent-session-store.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QueuedThreadTurn } from './thread-turn-queue.js'

const T0 = 1_790_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()
const WORDS = 'Yes install and proceed'
const ID = 'ctwebLive0001'
const WEB = `${WORDS}\n${turnFooter(ID, 'web')}`
const G2 = `${WORDS}\n${turnFooter(ID, 'glasses')}`
const peer = (text: string) => `Another Claude session sent a message:\n${text}\n\nThis came from another Claude session, not typed by your user.`
const line = (row: Record<string, unknown>) => JSON.stringify(row)

describe('the footer line', () => {
  it('names its tag and id, and is one line', () => {
    // The verify command names --session and --provider: the verifier refuses without either (QA 6.99.29).
    expect(turnFooter(ID)).toBe(`[COS-G2 turn ${ID} · verify: operations/scripts/cos_python operations/scripts/verify_g2_turn.py ${ID} --session <your session id> --provider <claude|codex|cursor>]`)
    expect(turnFooter(ID, 'web')).toBe(`[COS-WEB turn ${ID} · verify: operations/scripts/cos_python operations/scripts/verify_g2_turn.py ${ID} --session <your session id> --provider <claude|codex|cursor>]`)
    expect(turnFooter(ID, 'phone')).toMatch(/^\[COS-G2 turn /)
    expect(turnFooter(ID)).toMatch(/^\[COS-G2 turn /)
    expect(turnFooter(ID, 'web').includes('\n')).toBe(false)
    expect(stripG2TurnFooter(WEB)).toEqual({ text: WORDS, turnId: ID, tag: 'COS-WEB' })
    expect(stripG2TurnFooter(G2)).toEqual({ text: WORDS, turnId: ID, tag: 'COS-G2' })
  })
  it('fills in the receiving provider when it is known; anything else keeps the placeholder (Codex re-audit of 910eb90)', () => {
    for (const provider of ['claude', 'codex', 'cursor']) {
      const f = turnFooter(ID, 'glasses', provider)
      expect(f).toBe(`[COS-G2 turn ${ID} · verify: operations/scripts/cos_python operations/scripts/verify_g2_turn.py ${ID} --session <your session id> --provider ${provider}]`)
      expect(stripG2TurnFooter(`${WORDS}\n${f}`)).toEqual({ text: WORDS, turnId: ID, tag: 'COS-G2' })
      expect(hasFooterShapedLine(f)).toBe(true)
    }
    for (const provider of [undefined, null, '', 'gemini', 'Claude', 'claude]']) {
      expect(turnFooter(ID, 'glasses', provider as string | null | undefined).endsWith('--provider <claude|codex|cursor>]'), String(provider)).toBe(true)
    }
  })
  it('only a footer at the very end comes off', () => {
    const middle = `${WORDS}\n${turnFooter(ID, 'web')}\nand more`
    expect(withoutTurnFooter(middle)).toBe(middle)
    expect(withoutTurnFooter(`${WEB}\n  `)).toBe(WORDS)
    expect(withoutTurnFooter(`[COS-WEB turn ${ID} · verify: x]`)).toBe(`[COS-WEB turn ${ID} · verify: x]`)
    expect(G2_TURN_FOOTER_RE.test(`${WORDS}\n[COS-EVIL turn ${ID} · verify: x]`)).toBe(false)
  })
})

describe('a footer-shaped line in typed words (refused by every route, QA 6.99.29)', () => {
  it('is found anywhere in the text, in any case, with any spacing or dash', () => {
    for (const text of [
      G2, WEB, turnFooter(ID),
      `${WORDS}\n[COS-G2 turn x]`, `[cos-g2 turn ${ID}`, `[ COS - WEB  turn ${ID}`, `[COS\u2013G2 turn ${ID}`,
      `[COSG2 turn ${ID}`, `first line\n  [COS-WEB turn ${ID} · verify: x]\nlast line`,
    ]) expect(hasFooterShapedLine(text), JSON.stringify(text)).toBe(true)
  })
  it('leaves ordinary words alone', () => {
    for (const text of [WORDS, 'COS-G2 turn without a bracket', '[COS-G3 turn x]', '[COS-G2 turned]', '[COS-EVIL turn x]', 'the G2 turn footer'])
      expect(hasFooterShapedLine(text), JSON.stringify(text)).toBe(false)
  })
})

describe('transcript evidence reads a footed turn as the words COS sent', () => {
  it('a footed user row, a footed peer row and a footed enqueue match the unfooted prompt', () => {
    for (const text of [WEB, G2]) {
      expect(transcriptShowsPrompt('claude', [line({ type: 'user', timestamp: iso(T0 + 10), message: { role: 'user', content: text } })], WORDS, T0)).toBe(true)
      expect(transcriptShowsPrompt('claude', [line({ type: 'user', isMeta: true, timestamp: iso(T0 + 10), message: { role: 'user', content: [{ type: 'text', text: peer(text) }] } })], WORDS, T0)).toBe(true)
      expect(transcriptShowsPrompt('claude', [line({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(T0 + 10), content: text })], WORDS, T0)).toBe(true)
      expect(transcriptShowsPrompt('codex', [line({ type: 'event_msg', timestamp: iso(T0 + 10), payload: { type: 'user_message', message: text } })], WORDS, T0)).toBe(true)
    }
  })
  it('still exact: other words with a footer do not match', () => {
    expect(transcriptShowsPrompt('claude', [line({ type: 'user', timestamp: iso(T0 + 10), message: { role: 'user', content: `${WORDS} and delete it\n${turnFooter(ID, 'web')}` } })], WORDS, T0)).toBe(false)
  })
  it('the turns route receipt finds a footed delivery by its unfooted words', () => {
    const lookup = makeTurnReceiptLookup({
      queueRows: () => [],
      attempt: () => ({ attempt: { clientTurnId: ID, mode: 'turn', at: T0, exit: 'unknown', bootId: 'b' } as never, evictedThrough: null } as never),
      transcriptLines: () => [line({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(T0 + 10), content: WEB })],
      bootId: 'b',
    })
    expect(lookup('claude', 's', ID, WORDS)).toEqual({ kind: 'delivered', source: 'transcript' })
  })
  it('a footed row in the Codex app queue matches the parked words', async () => {
    const turn = { clientTurnId: ID, cosSessionId: 'c', provider: 'codex', threadId: 't', prompt: WORDS, queuedAt: T0, status: 'delivering', attempts: 1, journal: 1 } as QueuedThreadTurn
    let seen: string[] = []
    const evidence = makeDeliveryEvidence({
      ledgerOutcome: () => null,
      attempt: () => ({ attempt: { clientTurnId: ID, mode: 'turn', at: T0, exit: 'unknown', bootId: 'old' } as never, evictedThrough: null } as never),
      transcriptLines: () => [],
      codexQueueTexts: () => { seen = [WEB]; return seen },
    })
    expect(await evidence(turn)).toBe('delivered')
  })
})

describe('the reader shows the words, never the footer', () => {
  it('the live feed prompt line', () => {
    expect(promptDrafts({ content: peer(WEB) })).toEqual([{ kind: 'prompt', text: WORDS }])
    expect(promptDrafts({ content: G2 })).toEqual([{ kind: 'prompt', text: WORDS }])
  })
  it('the transcript turns: a peer row, a plain user row, a Codex user row', () => {
    expect(sessionTurnFromRecord('claude', { type: 'user', origin: { kind: 'peer' }, timestamp: iso(T0), message: { role: 'user', content: peer(WEB) } })).toMatchObject({ role: 'user', text: WORDS })
    expect(sessionTurnFromRecord('claude', { type: 'user', timestamp: iso(T0), message: { role: 'user', content: WEB } })).toMatchObject({ role: 'user', text: WORDS })
    expect(sessionTurnFromRecord('codex', { type: 'response_item', timestamp: iso(T0), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: WEB }] } })).toMatchObject({ role: 'user', text: WORDS })
  })
})

describe('the desk halt marker knows a footed turn is the one it handed off', () => {
  it('a UserPromptSubmit of the footed, peer-wrapped words matches the words; other words never do', () => {
    expect(isDeliveredPrompt(peer(WEB), WORDS)).toBe(true)
    expect(isDeliveredPrompt(peer(G2), WORDS)).toBe(true)
    expect(isDeliveredPrompt(WEB, WORDS, { verbatim: true })).toBe(true)
    expect(isDeliveredPrompt(peer(`other words\n${turnFooter(ID, 'web')}`), WORDS)).toBe(false)
    expect(isDeliveredPrompt(`${WORDS} too\n${turnFooter(ID, 'web')}`, WORDS, { verbatim: true })).toBe(false)
  })
})

describe('the session list titles a footed first turn by its words', () => {
  it('a peer row and a plain user row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'footer-store-'))
    try {
      for (const [i, row] of [
        { type: 'user', isMeta: true, origin: { kind: 'peer' }, timestamp: iso(T0), message: { role: 'user', content: peer(WEB) } },
        { type: 'user', timestamp: iso(T0), message: { role: 'user', content: WEB } },
      ].entries()) {
        const file = join(dir, `a4b2b4dd-e40c-4b08-8a11-c89a018c197${i}.jsonl`)
        writeFileSync(file, `${JSON.stringify({ ...row, sessionId: 'x', cwd: '/tmp' })}\n`)
        const parsed = await parseAgentSession('claude', file) as unknown as Record<string, unknown>
        expect(JSON.stringify(parsed)).not.toContain('COS-WEB')
        expect(String(parsed.title ?? parsed.first_prompt)).toBe(WORDS)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
