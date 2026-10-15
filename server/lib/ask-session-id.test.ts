import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ASK_SESSION, MAC_ASK_SESSION } from './ask-session-id.js'
import { MAC_CAPTURE_ID } from './mac-recording.js'
import { normalizeAsk } from './live-cos-ask.js'
import { MeetingAskStore } from './meeting-ask-store.js'

// 6.73.8: every Ask request on a Mac recording failed with invalid_session_id (2026-10-15, live meeting).
const mac = 'mac_43879e59-3039-4f2c-9cd2-4fcc59486d71'
const ask = (sessionId: string) => normalizeAsk({ sessionId, action: 'catch_up', question: '', elapsedMs: 60000, turns: [{ id: 1, speaker: 'Ext', elapsedMs: 5000, text: 'Hello.' }] })

describe('Ask session ids', () => {
  it('accepts G2 meetings and Mac captures', () => {
    expect(ASK_SESSION.test('meeting_1792090907279_ho864j')).toBe(true)
    expect(ASK_SESSION.test(mac)).toBe(true)
    expect(ask(mac).sessionId).toBe(mac)
    expect(ask('meeting_1792090907279_ho864j').sessionId).toBe('meeting_1792090907279_ho864j')
  })
  it('matches the capture id the recording route issues, and nothing looser', () => {
    expect(MAC_CAPTURE_ID.test(mac) && MAC_ASK_SESSION.test(mac)).toBe(true)
    for (const bad of ['mac_43879E59-3039-4f2c-9cd2-4fcc59486d71', 'mac_43879e59', 'mac_../../etc', `${mac}/x`, `${mac}.json`, 'g2_123', 'mac_', 'meeting_'])
      expect([bad, ASK_SESSION.test(bad), MAC_ASK_SESSION.test(bad)]).toEqual([bad, false, false])
    expect(() => ask('mac_../../etc')).toThrow()
    expect(() => ask('g2_1792090907279')).toThrow()
  })
  it('stores and reads Mac meeting files under the capture id', () => {
    const root = mkdtempSync(join(tmpdir(), 'ask-mac-session-'))
    try {
      const store = new MeetingAskStore(root)
      expect(store.files(mac)).toEqual([])
      expect(() => store.files('mac_../x')).toThrow()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
