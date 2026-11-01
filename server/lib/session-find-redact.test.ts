import { describe, expect, it } from 'vitest'
import {
  FIND_PROMPT_CHARS, FIND_QUERY_CHARS, FIND_SCAN_CHARS, FIND_TITLE_CHARS, HIDDEN, candidateTexts, credentialKey, cutAtCodePoints, maskKeyShapes, maskMore, redactForModel, redactQuery,
} from './session-find-redact.js'

const points = (s: string) => Array.from(s).length
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
// Every secret below is made up. None is, or was, a working credential.
const gone = (input: string, ...fragments: string[]) => {
  const out = redactForModel(input, 150)
  for (const fragment of fragments) expect(out, `"${fragment}" must not survive in: ${out}`).not.toContain(fragment)
  return out
}

describe('keys and credentials (the port of SetupAssistant.mask)', () => {
  it.each([
    ['an OpenAI style key', 'use sk-abcdefghijklmnopqrstuvwxyz123456 for it', 'abcdefghijklmnop'],
    ['a GitHub token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here', 'abcdefghijklmnop'],
    ['an AWS key id', 'the id AKIAABCDEFGHIJKLMNOP is old', 'ABCDEFGHIJKLMNOP'],
    ['a JWT', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk end', 'eyJzdWIi'],
    ['a bearer header', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 ok', 'abcdefghijklmnop'],
    ['a URL with a password in it', 'clone https://deploy:hunter2pass@host.example/repo.git now', 'hunter2pass'],
    ['a password pair', 'my password: hunter2 was reset', 'hunter2'],
    ['an env assignment', 'export OPENAI_API_KEY=abc123def456 and run', 'abc123def456'],
    ['a quoted JSON pair', 'config {"api_key": "zxcvbnm123456"} saved', 'zxcvbnm123456'],
    ['a long opaque id', 'session 7f3a9c1e5b2d4a6f8e0c1b3d5f7a9c2e4b6d8f0a was it', '7f3a9c1e5b2d4a6f8e0c'],
    ['a private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY----- then', 'MIIEowIBAAKCAQEA'],
    ['a --password flag', 'run tool --password=Sup3rS3cret1 now', 'Sup3rS3cret1'],
  ])('hides %s', (_name, input, ...fragments) => { gone(input, ...fragments) })

  it('leaves ordinary names and words alone (the port itself; the server redaction after it is broader)', () => {
    const names = 'PLAN_cmdK_find_sessions_2026-10-31 and TOKEN_COUNT=500000 and First pass: reviewed'
    expect(maskKeyShapes(names)).toBe(names)
    expect(credentialKey('STRIPE_SECRET_KEY')).toBe(true)
    expect(credentialKey('apiKey')).toBe(true)
    expect(credentialKey('TOKEN_COUNT')).toBe(false)
    expect(credentialKey('secretName')).toBe(false)
    expect(maskKeyShapes('plain words only')).toBe('plain words only')
  })

  it('hides a bare "pass" only when its value has a digit', () => {
    expect(maskKeyShapes('pass: abcdefgh')).toBe('pass: abcdefgh')
    expect(maskKeyShapes('pass: abcd1234')).toBe(HIDDEN)
  })
})

// Each pair is a fake string and what the Swift SetupAssistant.mask answered for it (compiled and run on 2026-11-01 from
// Control's Sources/SetupAssistant.swift at ctl-361). The port is held to the real thing, not to a reading of it.
const SWIFT_MASK: Array<[string, string]> = [
  ["use sk-abcdefghijklmnopqrstuvwxyz123456 for it", "use [hidden] for it"],
  ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here", "token [hidden] here"],
  ["the id AKIAABCDEFGHIJKLMNOP is old", "the id [hidden] is old"],
  ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk end", "jwt [hidden] end"],
  ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 ok", "Authorization: [hidden] ok"],
  ["clone https://deploy:hunter2pass@host.example/repo.git now", "clone [hidden]host.example/repo.git now"],
  ["my password: hunter2 was reset", "my [hidden] was reset"],
  ["export OPENAI_API_KEY=abc123def456 and run", "export [hidden] and run"],
  ["config {\"api_key\": \"zxcvbnm123456\"} saved", "config {[hidden]} saved"],
  ["session 7f3a9c1e5b2d4a6f8e0c1b3d5f7a9c2e4b6d8f0a was it", "session [hidden] was it"],
  ["-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY----- then", "[hidden] then"],
  ["run tool --password=Sup3rS3cret1 now", "run tool [hidden] now"],
  ["PLAN_cmdK_find_sessions_2026-10-31 and TOKEN_COUNT=500000 and First pass: reviewed", "PLAN_cmdK_find_sessions_2026-10-31 and TOKEN_COUNT=500000 and First pass: reviewed"],
  ["pass: abcdefgh", "pass: abcdefgh"],
  ["pass: abcd1234", "[hidden]"],
  ["Note: password=x1y2z3w4 and url=https://h/p?secret=abcdef123456", "Note: [hidden] and url=https://h/p?[hidden]"],
  ["local_3f2a9c1e-5b2d-4a6f-8e0c-1b3d5f7a9c2e is a session", "local_3f2a9c1e-5b2d-4a6f-8e0c-1b3d5f7a9c2e is a session"],
  ["pQrStUv1wXyZ2aBcDeFgHiJkLmNoPqRs3tU is odd", "[hidden] is odd"],
  ["basic dXNlcjpwYXNzd29yZDEyMzQ1Njc4OQ== here", "[hidden] here"],
  ["STRIPE_SECRET_KEY=whsec_abcdefgh123 and apiKey: 'qwertyuiop1234'", "[hidden] and [hidden]"],
]

describe('the port answers what the Swift mask answers', () => {
  it.each(SWIFT_MASK)('%j', (input, expected) => { expect(maskKeyShapes(input)).toBe(expected) })
})

describe('what mask does not know', () => {
  it.each([
    ['a US phone with dashes', 'call 512-555-0199 tomorrow', '555-0199'],
    ['a US phone with parentheses', 'call (512) 555-0199 tomorrow', '555-0199'],
    ['a US phone with a country code', 'call +1 512 555 0199 tomorrow', '555 0199'],
    ['an international phone', 'ring +44 20 7946 0958 please', '7946'],
    ['a card number with spaces', 'card 4111 1111 1111 1111 expires', '4111 1111'],
    ['a card number with dashes', 'card 4111-1111-1111-1111 expires', '1111-1111'],
    ['a card number run', 'card 4111111111111111 expires', '4111111111111111'],
    ['a social security number', 'ssn 123-45-6789 on file', '6789'],
    ['a labelled bare social security number', 'my SSN is 123456789 ok', '123456789'],
    ['a short Stripe publishable key', 'use pk_live_abc12 in the page', 'abc12'],
    ['a short restricted key', 'use rk_test_a1 in the page', 'a1'],
    ['base64 with plus and slash', 'blob dGhpcyBpcyBhIHRlc3Qgb2YgYmFzZTY0K2VuY29kaW5n/Zm9v+YmFy== done', 'Zm9v+YmFy'],
    ['a Spanish password label', 'contraseña: Clave9876 para entrar', 'Clave9876'],
    ['a German password label', 'Passwort = Geheim1234 gilt', 'Geheim1234'],
    ['an email address', 'write to jane.doe@example.com about it', 'jane.doe'],
    ['a STRIPE_KEY pair', 'set STRIPE_KEY=sk9Zx81abc7 now', 'sk9Zx81abc7'],
    ['an OPENAI_KEY pair', 'export OPENAI_KEY=abc123def456 first', 'abc123def456'],
    ['a camel case AccountKey pair', 'AccountKey=Zm9vYmFyMTIzNDU2 in config', 'Zm9vYmFyMTIzNDU2'],
    ['a hyphenated license-key pair', 'license-key: ABCD-1234-EFGH ok', 'EFGH'],
    ['a quoted JSON my_key pair', 'cfg {"my_key": "abcdef ghijkl"} end', 'abcdef'],
    ['the spoken api key', 'the api key: hunter22xx was pasted', 'hunter22xx'],
    ['the spoken secret key with no digit in it', 'the secret key = correcthorsebattery ok', 'correcthorse'],
    ['the spoken API KEY in capitals', 'API KEY = hunter22xx here', 'hunter22xx'],
    ['a bare key with a digit in a long value', 'key: a1b2c3d4e5f6 was it', 'a1b2c3d4e5f6'],
    ['an address with an accented letter', 'write to josé@example.com about it', 'josé', 'example.com'],
    ['an address in Cyrillic letters', 'пиши иван@пример.рф сегодня', 'иван@'],
    ['a bare pass with a digit (only the port knows)', 'login pass: abcd1234 for the box', 'abcd1234'],
    ['a full-width email address', 'write to ｊａｎｅ＠ｅｘａｍｐｌｅ．ｃｏｍ about it', 'example.com', 'ｊａｎｅ', 'ｅｘａｍｐｌｅ'],
    ['a URL with a query token', 'open https://docs.example.com/page?token=abcdef123456 now', 'abcdef123456'],
  ])('hides %s', (_name, input, ...fragments) => { gone(input, ...fragments) })

  it('leaves a bare "key: value", "primary key" and words that merely end in key', () => {
    for (const text of ['key: value', 'the primary key: id is enough', 'monkey=bananas123 ok', 'a hotkey: ctrl+shift+k works']) expect(redactForModel(text, 150)).toBe(text)
  })

  it('strips a soft hyphen and a word joiner, so a pattern cannot be broken by them', () => {
    expect(redactForModel('soft\u00adhy\u2060phen and sk-abc\u00addefghijklmnopqrstuvwxyz123456', 150)).toBe('softhyphen and [hidden]')
  })

  it('does not hide a path, a date or a short number', () => {
    const text = 'edit server/lib/session-find-collect.ts on 2026-11-01 around 42 of 100 rows'
    expect(redactForModel(text, 150)).toBe(text)
    expect(maskMore('an ordinary sentence about Ahrefs and Tailscale')).toBe('an ordinary sentence about Ahrefs and Tailscale')
  })
})

describe('read, redact, then cut', () => {
  it('masks a key that straddles the cut, instead of leaving the half in front of it', () => {
    const lead = 'a '.repeat(66) // 132 characters
    const out = gone(`${lead}export OPENAI_API_KEY=abc123def456ghi789 trailing words`, 'OPENAI_API_KEY=abc', 'abc1', 'ghi789')
    expect(points(out)).toBeLessThanOrEqual(FIND_PROMPT_CHARS)
  })

  it('hides a phone number that the cut would otherwise split into a visible half', () => {
    const lead = 'ab '.repeat(47) + 'c' // 142 characters; the number starts at 143 and the cut falls after its second group
    const out = gone(`${lead} 512 555 0199 and then some words`, '512', '555', '0199')
    expect(out.startsWith('ab ab')).toBe(true)
    expect(points(out)).toBeLessThanOrEqual(FIND_PROMPT_CHARS)
  })

  it('hides a quoted secret with spaces in it whole, not the part in front of the cut', () => {
    const lead = 'a '.repeat(63) // 126 characters, so the cut falls right after "horse"
    const out = gone(`${lead}password: "correct horse battery staple" and more words`, 'horse', 'battery', 'staple', 'correct')
    expect(out.startsWith('a a')).toBe(true)
  })

  it('drops the token a 300 unit slice by the server redaction cut, when that leaves fewer than the limit', () => {
    const out = redactForModel('😀'.repeat(100) + ' ' + 'x'.repeat(150), 200)
    expect(out).not.toContain('x')
    expect(points(out)).toBe(100)
  })

  it('masks a pair whose value starts before the cut and ends after it', () => {
    const lead = 'x '.repeat(70) // 140 characters, the pair opens at 141
    const out = gone(`${lead}password: Sup3rSecretValueHere and more`, 'Sup3r', 'SecretValue')
    expect(out.startsWith('x x')).toBe(true)
  })

  it('cuts at the code point limit and drops the unbroken token the cut fell inside', () => {
    const text = 'alpha '.repeat(24) + 'supercalifragilisticexpialidocious' // the cut at 150 lands inside the long word
    const out = redactForModel(text, 150)
    expect(out.endsWith('alpha')).toBe(true)
    expect(out).not.toContain('super')
    expect(points(out)).toBeLessThanOrEqual(150)
  })

  it('keeps a token that ends exactly at the cut', () => {
    const text = 'a'.repeat(9) + ' ' + 'b'.repeat(9) + ' tail words after'
    expect(cutAtCodePoints(text, 19)).toBe('aaaaaaaaa bbbbbbbbb')
    expect(cutAtCodePoints(text, 15)).toBe('aaaaaaaaa')
  })

  it('never splits a surrogate pair and never returns a lone surrogate', () => {
    const out = redactForModel('😀'.repeat(400), 150)
    expect(points(out)).toBe(150)
    expect(loneSurrogate.test(out)).toBe(false)
    expect(loneSurrogate.test(redactForModel('ok \uD83D broken \uDE00 pair ' + 'z '.repeat(300), 150))).toBe(false)
    const mixed = redactForModel('a😀'.repeat(200), 150)
    expect(points(mixed)).toBeLessThanOrEqual(150)
    expect(loneSurrogate.test(mixed)).toBe(false)
    expect(() => JSON.parse(JSON.stringify({ q: mixed }))).not.toThrow()
  })

  it('cuts text in a script without spaces where it falls, not to nothing', () => {
    const out = redactForModel('日本語の長い質問です'.repeat(30), 150)
    expect(points(out)).toBe(150)
  })

  it('returns nothing for a single enormous token rather than half of it', () => {
    expect(redactForModel('x'.repeat(5_000), 150)).toBe('')
  })

  it('reads a bounded window: a huge input costs a bounded amount of work', () => {
    const started = performance.now()
    redactForModel('a-'.repeat(500_000), 150)
    redactForModel(('key=' + 'z'.repeat(40) + ' ').repeat(5_000), 150)
    redactForModel('@'.repeat(100_000) + ' 1'.repeat(100_000), 150)
    expect(performance.now() - started).toBeLessThan(3_000)
    expect(FIND_SCAN_CHARS).toBeGreaterThan(FIND_PROMPT_CHARS * 5)
  })

  it('puts the text on one line without control or direction characters', () => {
    expect(redactForModel('one\ntwo\u0000three‮four​five\r\nsix', 150)).toBe('one twothreefourfive six')
  })
})

describe('a title at the length it was cut upstream', () => {
  it('drops its last token, which can be half a key', () => {
    const eighty = ('word '.repeat(14) + 'ghp_abcdefghijklmnop').slice(0, 80) // the list cut the first line at 80, in the middle of a token
    expect(eighty).toHaveLength(80)
    const { option } = candidateTexts(eighty, 'a typed prompt that says something else entirely')
    expect(option).not.toContain('ghp_')
    expect(candidateTexts('x'.repeat(60) + ' tail', 'p').option.startsWith('xxxx')).toBe(true) // 65 characters: not cut upstream
    const hundredTwenty = 'word '.repeat(22) + 'sk-abcdefghij' // 123, cut by the 120 title rule
    expect(candidateTexts(hundredTwenty.slice(0, 120), 'prompt text here').option).not.toContain('sk-')
  })
})

describe('the search words', () => {
  it('are redacted like everything else and capped at 200 code points', () => {
    const out = redactQuery('draft a note to jane@example.com about password: hunter2 and the budget')
    expect(out).not.toContain('jane')
    expect(out).not.toContain('hunter2')
    expect(out).toContain('the budget')
    expect(points(redactQuery('word '.repeat(80)))).toBeLessThanOrEqual(FIND_QUERY_CHARS)
    expect(points(redactQuery('q'.repeat(10) + ' ' + 'w'.repeat(190)))).toBeLessThanOrEqual(FIND_QUERY_CHARS)
  })

  it('keeps a 200 character query of ordinary words whole', () => {
    const words = 'where did we land on the lens menu scrolling problem after the ring swipe change '.repeat(3).slice(0, 199).trim()
    expect(redactQuery(words)).toBe(words)
  })

  it('leaves nothing for a query that is only an address, so the route can refuse it', () => {
    expect(redactQuery('jane.doe@example.com')).toBe('')
  })
})

describe('what a session is asked as', () => {
  it('sends the title and the first prompt, and returns the prompt part as judged_text', () => {
    const { option, prompt } = candidateTexts('Vercel invite visibility', 'I never saw the email that lets me join the team on the deploy platform, can you check')
    expect(option).toBe(`Vercel invite visibility: ${prompt}`)
    expect(prompt.startsWith('I never saw the email')).toBe(true)
    expect(points(prompt)).toBeLessThanOrEqual(FIND_PROMPT_CHARS)
  })

  it('sends the prompt alone when the title is only its first line', () => {
    const typed = 'Fix the overlay that spills out of its column on every article page and check the mobile layout too'
    const { option, prompt } = candidateTexts(typed.slice(0, 80), typed)
    expect(option).toBe(prompt)
  })

  it('redacts the title and the prompt, and keeps the title short', () => {
    const { option } = candidateTexts('Email jane@example.com about it ' + 'long '.repeat(40), 'use sk-abcdefghijklmnopqrstuvwxyz123456 and call 512-555-0199')
    expect(option).not.toContain('jane')
    expect(option).not.toContain('abcdefghijklmnop')
    expect(option).not.toContain('555-0199')
    expect(points(option.split(': ')[0]!)).toBeLessThanOrEqual(FIND_TITLE_CHARS)
  })

  it('has a title alone when the prompt hides entirely', () => {
    expect(candidateTexts('Short title here', 'jane@example.com')).toEqual({ option: 'Short title here', prompt: '' })
  })
})
