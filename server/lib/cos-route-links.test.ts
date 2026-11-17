/**
 * 7.0.55 COS route links (lib/cos-route-links.ts; Miles 2026-11-17 08:29; X1's scope, the lead's 08:3x). The pure
 * projection, the COS thread store projecting at READ time (the ledger keeps the stored words), the entry route over
 * real HTTP, and the prompt line. Placeholder words and ids only; the meeting id below is a made-up one.
 */
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  COS_ROUTE_LABEL, COS_ROUTE_PROMPT_LINE, COS_ROUTE_RE, cosRoutePromptLine, cosRouteToken, parseCosRoute, projectCosRouteLinks,
  type SelfHosts,
} from './cos-route-links.js'
import { CosThread, lazyCosThread } from './cos-thread.js'
import { createCosThreadRouter } from '../routes/cos-thread.js'

const ID = 'meeting_1700000000000_abc123'
const TOKEN = `[${COS_ROUTE_LABEL}](cos-route:meetings/live/${ID})`
const SELF: SelfHosts = {
  hosts: new Set(['127.0.0.1', 'localhost', '[::1]', '100.64.0.7', '192.168.1.20', 'example-mac.tail00000a.ts.net']),
  ports: new Set(['3141', '3143']),
}
const p = (text: string) => projectCosRouteLinks(text, SELF)

describe('the route grammar', () => {
  it('one route, the server meeting id form, anchored', () => {
    expect(parseCosRoute(`meetings/live/${ID}`)).toEqual({ kind: 'live-meeting', id: ID })
    for (const bad of [`meetings/live/${ID}/`, `meetings/live/${ID}?x=1`, `/meetings/live/${ID}`, 'meetings/live/', 'meetings/live/meeting_',
      `meetings/live/meeting_${'a'.repeat(90)}`, 'meetings/live/session_abc', 'meetings/live/meeting_a.b', 'meetings/live/meeting_a%2Fb',
      `meetings/detail/${ID}`, `sessions/claude/${ID}`, `settings`, `Meetings/live/${ID}`]) {
      expect(parseCosRoute(bad), bad).toBeNull()
    }
    expect(parseCosRoute(`meetings/live/meeting_${'a'.repeat(89)}`)).not.toBeNull()
    expect(cosRouteToken(ID)).toBe(TOKEN)
    expect(cosRouteToken('not a meeting')).toBeNull()
    expect(COS_ROUTE_RE.source).toBe('^meetings\\/live\\/(meeting_[A-Za-z0-9_-]{1,89})$')
  })
})

describe('projectCosRouteLinks', () => {
  it("this morning's reply: both raw self-URLs become the route, the words around them stay byte for byte", () => {
    const reply = `The live Tuesday Tune-Up is still recording. Open it here:\n\nhttp://127.0.0.1:3141/control#/meetings/live/${ID}\n\n` +
      `From your phone, same page:\n\nhttp://100.64.0.7:3141/control#/meetings/live/${ID}\n\nThat link is this recording.`
    expect(p(reply)).toBe(`The live Tuesday Tune-Up is still recording. Open it here:\n\n${TOKEN}\n\nFrom your phone, same page:\n\n${TOKEN}\n\nThat link is this recording.`)
  })

  it('every self host and port, http or https, with or without the trailing slash on /control; trailing punctuation goes back to the sentence', () => {
    for (const host of ['127.0.0.1:3141', 'localhost:3141', '[::1]:3141', '192.168.1.20:3141', 'example-mac.tail00000a.ts.net:3143', 'EXAMPLE-MAC.tail00000a.ts.net.:3143']) {
      for (const scheme of ['http', 'https']) {
        expect(p(`see ${scheme}://${host}/control#/meetings/live/${ID}.`), host).toBe(`see ${TOKEN}.`)
        expect(p(`see ${scheme}://${host}/control/#/meetings/live/${ID}`), host).toBe(`see ${TOKEN}`)
      }
    }
  })

  it('a Markdown link to the page gets the fixed words, never the model\'s', () => {
    expect(p(`[Click here for the Acme board meeting](http://127.0.0.1:3141/control#/meetings/live/${ID})`)).toBe(TOKEN)
  })

  it('lookalike hosts, other ports and user info are not this server', () => {
    for (const url of [
      `http://127.0.0.1.evil.example:3141/control#/meetings/live/${ID}`,
      `http://evil.example/127.0.0.1:3141/control#/meetings/live/${ID}`,
      `http://127.0.0.2:3141/control#/meetings/live/${ID}`,
      `http://127.0.0.1:8080/control#/meetings/live/${ID}`,
      `http://127.0.0.1/control#/meetings/live/${ID}`,
      `http://example-mac.tail00000a.ts.net.evil.example:3143/control#/meetings/live/${ID}`,
    ]) expect(p(`go ${url} now`), url).toBe(`go ${url} now`)
    // User info on a self URL: never a link, never a route.
    expect(p(`[x](http://user:pw@127.0.0.1:3141/control#/meetings/live/${ID})`)).toBe('x')
    expect(p(`http://user@127.0.0.1:3141/control#/meetings/live/${ID}`)).toBe(`http://user@127.0.0.1:3141/control#/meetings/live/${ID}`)
  })

  it('anything credential-shaped never keeps a link, on this server or any other', () => {
    for (const q of ['?token=abc', '?pair=K7P3', '?code=1234', '?access_token=x', '?api_key=y', '?sig=z', '?t=0&auth=1']) {
      const self = `http://127.0.0.1:3141/control${q}#/meetings/live/${ID}`
      expect(p(self), q).toBe(self)
      expect(p(`[open](${self})`), q).toBe('open')
      expect(p(`[report](https://example.com/r${q})`), q).toBe('report')
    }
    expect(p(`[x](http://127.0.0.1:3141/control#/meetings/live/${ID}&token=abc)`)).toBe('x')
  })

  it('any other page of this server loses its address in a link and stays text when bare', () => {
    expect(p('[Settings](http://127.0.0.1:3141/control#/settings)')).toBe('Settings')
    expect(p('[the API](http://127.0.0.1:3141/api/health)')).toBe('the API')
    expect(p('see http://127.0.0.1:3141/control#/settings')).toBe('see http://127.0.0.1:3141/control#/settings')
    expect(p(`see http://127.0.0.1:3141/control?x=1#/meetings/live/${ID}`)).toBe(`see http://127.0.0.1:3141/control?x=1#/meetings/live/${ID}`)
  })

  it('links to other sites are left exactly as written', () => {
    for (const text of ['[docs](https://example.com/a)', 'see https://example.com/a?b=c.', 'mailto:x@example.com', '[x](javascript:alert(1))', '[x](data:text/html,hi)']) {
      expect(p(text), text).toBe(text)
    }
  })

  it('a route token: allowlisted gets the fixed words, anything else is its words', () => {
    expect(p(`[go](cos-route:meetings/live/${ID})`)).toBe(TOKEN)
    expect(p('[Open settings](cos-route:settings)')).toBe('Open settings')
    expect(p(`[x](cos-route:meetings/live/${ID}/../../settings)`)).toBe('x')
  })

  it('code spans and fences are never touched', () => {
    const inline = `use \`http://127.0.0.1:3141/control#/meetings/live/${ID}\` or \`[x](cos-route:settings)\``
    expect(p(inline)).toBe(inline)
    const fence = `before\n\`\`\`\nhttp://127.0.0.1:3141/control#/meetings/live/${ID}\n[x](cos-route:settings)\n\`\`\`\nafter http://127.0.0.1:3141/control#/meetings/live/${ID}`
    expect(p(fence)).toBe(`before\n\`\`\`\nhttp://127.0.0.1:3141/control#/meetings/live/${ID}\n[x](cos-route:settings)\n\`\`\`\nafter ${TOKEN}`)
    const tilde = `~~~\nhttp://127.0.0.1:3141/control#/meetings/live/${ID}\n~~~`
    expect(p(tilde)).toBe(tilde)
  })

  it('text with no address is returned as it is, and empty or odd input is safe', () => {
    for (const text of ['', 'plain words', 'a [b](c) d']) expect(p(text)).toBe(text)
    expect(projectCosRouteLinks(undefined as unknown as string, SELF)).toBeUndefined()
  })
})

describe('the prompt line', () => {
  it('a COS thread conversation only, and it names the token exactly, outside code', () => {
    expect(cosRoutePromptLine({ cosThread: true })).toBe(`\n\n${COS_ROUTE_PROMPT_LINE}`)
    expect(cosRoutePromptLine({})).toBe('')
    expect(cosRoutePromptLine(undefined)).toBe('')
    expect(cosRoutePromptLine({ cosThread: 'yes' } as unknown as { cosThread: true })).toBe('')
    expect(COS_ROUTE_PROMPT_LINE).toContain(`[${COS_ROUTE_LABEL}](cos-route:meetings/live/<meeting id>)`)
    expect(COS_ROUTE_PROMPT_LINE).not.toContain('`')
    expect(COS_ROUTE_PROMPT_LINE).toMatch(/Never write a 127\.0\.0\.1, localhost, IP address or ts\.net address/)
  })
})

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true }))
})
const RAW = `Open it here: http://127.0.0.1:3141/control#/meetings/live/${ID}`

function store(projector: ((a: string) => string) | undefined, live: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cos-route-')); roots.push(root)
  const dir = join(root, 'cos-thread')
  const t = new CosThread({
    dir, capTokens: () => 150_000, context: () => ({ found: true, tokens: 1000 }),
    answerFor: (sessionId, clientId) => live[`${sessionId}:${clientId}`],
    ...(projector ? { projectAnswer: projector } : {}),
  })
  return { t, dir }
}
const ledgerText = (dir: string) => readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => readFileSync(join(dir, f), 'utf8')).join('')

describe('the COS thread store, at read time', () => {
  it('serves the route and keeps the stored words in the ledger', () => {
    const { t, dir } = store(a => projectCosRouteLinks(a, SELF))
    t.recordTurn({ clientId: 'web-000001', sessionId: 'sess0001', query: `question with http://127.0.0.1:3141/control#/meetings/live/${ID}`, answer: RAW, messageNo: 601 } as any)
    const entry = t.historyPage({ limit: 10 }).entries.at(-1)!
    expect(entry.answer).toBe(`Open it here: ${TOKEN}`)
    // His own words are never rewritten: only COS's answer is.
    expect(entry.question).toContain('http://127.0.0.1:3141/control#/meetings/live/')
    expect(ledgerText(dir)).toContain(`http://127.0.0.1:3141/control#/meetings/live/${ID}`)
    expect(ledgerText(dir)).not.toContain('cos-route:')
  })

  it('without a projector, or with one that throws or returns nonsense, the stored words are served', () => {
    for (const projector of [undefined, () => { throw new Error('boom') }, () => 42 as unknown as string]) {
      const { t } = store(projector)
      t.recordTurn({ clientId: 'web-000001', sessionId: 'sess0001', query: 'q', answer: RAW, messageNo: 601 } as any)
      expect(t.historyPage({ limit: 10 }).entries.at(-1)!.answer).toBe(RAW)
    }
  })
})

describe('GET /api/cos-thread/entry/:id', () => {
  it('a whole answer read from the live conversation is projected too', async () => {
    const long = 'x'.repeat(2500) + ' ' + RAW
    const root = mkdtempSync(join(tmpdir(), 'cos-route-http-')); roots.push(root)
    const thread = lazyCosThread(() => new CosThread({
      dir: join(root, 'cos-thread'), capTokens: () => 150_000, context: () => ({ found: true, tokens: 1000 }),
      answerFor: () => long, projectAnswer: a => projectCosRouteLinks(a, SELF),
    }))
    const app = express(); app.use(express.json({ limit: '1mb' }))
    app.use('/api', createCosThreadRouter({ enabled: () => true, thread }))
    const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
    await fetch(base + '/cos-thread/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'web-000001', sessionId: 'sess0001', query: 'q', answer: long, messageNo: 601 }) })
    const out = await (await fetch(base + '/cos-thread/entry/t:web-000001')).json() as any
    expect(out.source).toBe('live')
    expect(out.entry.answer.endsWith(`Open it here: ${TOKEN}`)).toBe(true)
    expect(out.entry.full).toBe(true)
  })
})

describe('the prompt line reaches each bridge (source pin: the bridges spawn a CLI, so this checks the one line that composes it)', () => {
  it('claude, codex and cursor append it to the conversation prompt, for the session they read', () => {
    const src = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8')
    expect(src('claude-bridge.ts')).toContain('  const contextPrompt = historyPrompt + cosRoutePromptLine(session)\n')
    expect(src('codex-bridge.ts')).toContain('  const contextPrompt = historyPrompt + cosRoutePromptLine(session)\n')
    expect(src('cursor-bridge.ts')).toContain('  const contextPrompt = `${historyPrompt}${handoffPrompt}${cosRoutePromptLine(session)}`\n')
    for (const f of ['claude-bridge.ts', 'codex-bridge.ts', 'cursor-bridge.ts']) {
      expect(src(f).match(/cosRoutePromptLine\(/g), f).toHaveLength(1)
      expect(src(f), f).toMatch(/const session = getSessionRaw\(sid\)\n/)
    }
  })
})
