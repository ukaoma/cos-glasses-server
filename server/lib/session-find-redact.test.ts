import { describe, expect, it } from 'vitest'
import {
  PATH_PLACEHOLDER, UPSTREAM_PROMPT_CUT, stripLeadingAttachments, FIND_PROMPT_CHARS, FIND_QUERY_CHARS, FIND_SCAN_CHARS, FIND_TITLE_CHARS, HIDDEN, candidateTexts, credentialKey, cutAtCodePoints, maskKeyShapes, maskMore, redactForModel, redactQuery,
} from './session-find-redact.js'
import { FIND_PROMPT_KEEP_CHARS } from './session-find-collect.js'

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

describe('what an agent app puts in front of the words', () => {
  // Fake paths throughout. The shapes are the ones measured on the owner's newest 508 first prompts: 33 start with @", 19 with [Image, 3 with a path.
  it.each([
    ['a quoted path with spaces and a .heic', '@"/Users/jane doe/Photos Library.photoslibrary/IMG 1.heic" I need to resolve an issue', 'I need to resolve an issue'],
    ['a single-quoted path', "@'/home/jane/My Files/a.b.png' what is this", 'what is this'],
    ['a bare @ path', '@/Users/jane/proj/src/x.ts fix the overlay', 'fix the overlay'],
    ['an @ home path', '@~/notes/today.md summarize it', 'summarize it'],
    ['an @ file name with an extension', '@report.pdf summarize it', 'summarize it'],
    ['an image with a source path', '[Image: source: /Users/jane/Desktop/shot 1.png] describe this', 'describe this'],
    ['an image number', '[Image #1] words here', 'words here'],
    ['a pasted text marker', '[Pasted text #1 +20 lines] why does this fail', 'why does this fail'],
    ['a chain of all of them', `@"/Users/a/b.png" @'/home/x/y z.txt' [Image #2] @/Users/a/c.ts real words`, 'real words'],
    ['a bare path first', '/Users/jane/proj/file.ts is broken', 'is broken'],
    ['a bare ~ path first', '~/Documents/my.notes.md is the file', 'is the file'],
    ['a file URL first', 'file:///Users/jane/a.png ok then', 'ok then'],
  ])('drops %s from the front', (_name, text, words) => {
    expect(stripLeadingAttachments(text)).toBe(words)
    const { option, prompt } = candidateTexts('A title', text)
    expect(prompt).toBe(words)
    expect(option).toBe(`A title: ${words}`)
  })

  it('keeps a mention, and attachments that are not at the front', () => {
    expect(stripLeadingAttachments('@john can you look at this')).toBe('@john can you look at this')
    expect(stripLeadingAttachments('look at @"/Users/jane/a.png" please')).toBe('look at @"/Users/jane/a.png" please')
    expect(candidateTexts('t', 'look at @"/Users/jane/a.png" please').prompt).toBe(`look at @${PATH_PLACEHOLDER} please`)
  })

  it('gives the 150 characters to the words, not the path', () => {
    const words = 'I need to resolve an issue with the importer that drops the second page of every scan '.repeat(3)
    const { prompt } = candidateTexts('t', `@"/Users/jane doe/Photos Library.photoslibrary/IMG 1.heic" ${words}`)
    expect(prompt.startsWith('I need to resolve')).toBe(true)
    expect(points(prompt)).toBeGreaterThan(130)
  })

  it('strips the title too, and leaves nothing when a title is only an attachment', () => {
    expect(candidateTexts('@"/Users/jane/My Pic.png" Fix the crop', 'the crop is off by a few pixels today please').option.startsWith('Fix the crop: ')).toBe(true)
    expect(candidateTexts('@/Users/jane/a.png', 'the crop is off by a few pixels today please')).toEqual({ option: 'the crop is off by a few pixels today please', prompt: 'the crop is off by a few pixels today please' })
  })

  it('returns an empty prompt when the prompt was only attachments', () => {
    expect(candidateTexts('Short title here', '@"/Users/jane/a.png" [Image #2]')).toEqual({ option: 'Short title here', prompt: '' })
  })
})

describe('a home path anywhere', () => {
  const account = /jane|doe|ukaoma|Photos|IMG|\.heic|Desktop|Documents/
  it.each([
    ['a quoted path with spaces and dots', 'open "/Users/jane doe/Photos Library.photoslibrary/IMG 1.heic" please', 'open [path] please'],
    ['a single-quoted home path', "see '/home/jane/My Notes/a.b.c.txt' now", 'see [path] now'],
    ['a backtick-quoted ~ path', 'run `~/Documents/my project/run.sh` first', 'run [path] first'],
    ['a bare /Users path', 'the file /Users/jane/Desktop/a.png is huge', 'the file [path] is huge'],
    ['a bare /home path', 'in /home/jane/proj/src it fails', 'in [path] it fails'],
    ['a bare ~ path', 'edit ~/Documents/notes.md today', 'edit [path] today'],
    ['a file URL', 'open file:///Users/jane/a.png now', 'open [path] now'],
    ['a quoted file URL with spaces', 'open "file:///Users/jane doe/a b.png" now', 'open [path] now'],
    ['a Windows path', 'it is C:\\Users\\jane\\Desktop\\a.png here', 'it is [path] here'],
    ['an upper-case root', 'at /USERS/Jane/Desktop/a.png today', 'at [path] today'],
    ['a lower-case Windows drive', 'at c:\\users\\jane\\Desktop\\a.png now', 'at [path] now'],
    ['escaped backslashes', 'at C:\\\\Users\\\\jane\\\\Desktop\\\\a.png now', 'at [path] now'],
    ['WSL', 'at /mnt/c/Users/jane/Desktop/a.png now', 'at [path] now'],
    ['an external volume', 'at /Volumes/Backup/Users/jane/a.png now', 'at [path] now'],
    ['the data volume', 'at /System/Volumes/Data/Users/jane/a.png now', 'at [path] now'],
    ['another account', 'see ~jane/notes.md now', 'see [path] now'],
    ['escaped spaces', 'open /Users/jane/My\\ Clients/Acme\\ Corp/a.txt now', 'open [path] now'],
    ['an apostrophe in the name', "open /Users/o'brien/Desktop/a.png now", 'open [path] now'],
    ['a double-quoted path with an apostrophe', 'open "/Users/o\'brien/My Files/a.png" now', 'open [path] now'],
    ['a quoted Windows path with spaces', 'open "C:\\Users\\jane doe\\My Files\\a.png" now', 'open [path] now'],
  ])('replaces %s', (_name, text, expected) => {
    expect(redactForModel(text, 150)).toBe(expected)
    expect(redactForModel(text, 150)).not.toMatch(account)
  })

  it.each([
    ['/home/dashboard', 'check the /home/dashboard page'],
    ['/Users/list', 'open the /Users/list screen'],
    ['~/month', 'due ~/month end'],
    ['a lone tilde in quotes', 'the "~" key'],
    ['a bare account folder', 'cd /Users/jane then ls'],
    ['a bracketed word', '[File upload bug] happens again'],
    ['a quoted name', '@"Jane Doe" can you look'],
  ])('leaves %s alone, it is a word', (_name, text) => {
    expect(redactForModel(text, 150)).toBe(text)
  })

  it.each([
    ['a host and port', 'curl 192.168.1.20:8080/admin?x=1 now', 'curl [link] now'],
    ['an address with a path', 'open 10.0.0.5/status now', 'open [link] now'],
    ['localhost', 'hit localhost:3141/api/keys now', 'hit [link] now'],
  ])('masks a link: %s', (_name, text, expected) => {
    expect(redactForModel(text, 150)).toBe(expected)
  })

  it.each([
    'ping 10.0.0.5 now',
    'ping localhost now',
    'version 1.2.3.4 shipped',
    'see meeting.ts:2452 for the bug',
    'at server/routes/meeting.ts:2452:7 it throws',
    'open example.com:8443/x now',
  ])('leaves %s, it is not a link', (text) => {
    expect(redactForModel(text, 150)).toBe(text)
  })

  it('leaves a bare domain, a brand name people search for', () => {
    expect(redactForModel('the quilt.com redesign', 150)).toBe('the quilt.com redesign')
  })

  it('does the same to the search words and to a title', () => {
    expect(redactQuery('where did I put /Users/jane/Desktop/a.png')).toBe('where did I put [path]')
    expect(candidateTexts('Fix ~/Documents/x.md', 'a prompt about something else entirely here').option).toBe('Fix [path]: a prompt about something else entirely here')
  })

  it('leaves ordinary paths and words alone', () => {
    const text = 'edit server/lib/session-find.ts and the ~ key, not /usr/local/bin or http://example.com/x'
    expect(redactForModel(text, 150)).not.toContain(PATH_PLACEHOLDER)
  })
})

describe('an attachment that was cut upstream', () => {
  it('knows the length the collector cuts a typed prompt at', () => {
    expect(UPSTREAM_PROMPT_CUT).toBe(FIND_PROMPT_KEEP_CHARS)
  })

  it('drops a title cut inside an attachment, it never closes', () => {
    const cut = ('@"/Users/jane/Photos Library/' + 'x'.repeat(60)).slice(0, 80)
    expect(cut.length).toBe(80)
    expect(candidateTexts(cut, 'the crop is off by a few pixels today please').option).toBe('the crop is off by a few pixels today please')
  })

  it('drops an unclosed image bracket and a single-quote form when cut', () => {
    expect(stripLeadingAttachments('[Image: source: /Users/jane/a b', true)).toBe('')
    expect(stripLeadingAttachments("@'/Users/jane/a b", true)).toBe('')
  })

  it('keeps an unclosed form when it was not cut, it is the words', () => {
    expect(stripLeadingAttachments('@"quote me', false)).toBe('@"quote me')
  })

  it('drops a typed prompt cut at the upstream limit inside an attachment', () => {
    const typed = ('@"/Users/jane/' + 'My Folder '.repeat(300)).slice(0, UPSTREAM_PROMPT_CUT)
    expect(candidateTexts('Short title here', typed).prompt).toBe('')
  })
})

describe('what is not an attachment', () => {
  it.each([
    '[File upload bug] happens',
    '[Attachment list] is wrong',
    '@"Jane Doe" can you look',
    '@jane can you look',
  ])('keeps %s', (text) => {
    expect(stripLeadingAttachments(text)).toBe(text)
  })

  it.each([
    ['@"/Users/jane/a b.png" fix it', 'fix it'],
    ['@"notes.md" fix it', 'fix it'],
    ["@'a/b' fix it", 'fix it'],
    ['[Image #1] fix it', 'fix it'],
    ['[Image: source: /Users/jane/a.png] fix it', 'fix it'],
    ['[Pasted text #1 +20 lines] fix it', 'fix it'],
  ])('drops %s', (text, rest) => {
    expect(stripLeadingAttachments(text)).toBe(rest)
  })
})

describe('a half of a surrogate pair', () => {
  it('is removed from the search words, where work-search cuts at 300 UTF-16 units inside a pair', () => {
    const q = redactQuery('a' + '\u{1F600}'.repeat(160))
    expect(q).not.toMatch(loneSurrogate)
    expect(points(q)).toBe(150)
  })
})
