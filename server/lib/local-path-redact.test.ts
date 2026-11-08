/**
 * 7.0.4 S1: absolute local paths in a session's words become base names before they leave the Mac. Web URLs and
 * relative paths are untouched. Fixture strings are hand-written in the shapes Claude and Codex replies use.
 */
import { describe, expect, it } from 'vitest'
import { hideHomeFolder, redactLocalPaths, redactLocalPathsDeep } from './local-path-redact.js'

/** An independent detector, not the module's own: a private Mac path in prose, a home shorthand or a file URL. */
const ABSOLUTE = /(?:^|[^A-Za-z0-9.:/-])\/+(?:Users|Volumes|private)\/|\/var\/folders\/|~[A-Za-z][A-Za-z0-9._-]*\/|~\/|\$\{?HOME\}?\/|\bfile:\/\/|\bvscode:\/\//i
/** A person's home folder anywhere, prose or code. */
const HOME = /\/users\/(?!shared\b)[^/\s]+/i

describe('redactLocalPaths', () => {
  const cases: Array<[string, string, string]> = [
    ['a Claude link with an #L anchor', 'See [app.ts](/Users/jane/repo/server/app.ts#L42).', 'See app.ts:42.'],
    ['a Codex link with a :line href', 'Fixed in [server/app.ts](/Users/jane/repo/server/app.ts:42)', 'Fixed in server/app.ts:42'],
    ['a link whose words already carry the line', '[app.ts:9](/Users/jane/repo/app.ts:9)', 'app.ts:9'],
    ['a link with other words', '[the route](/Users/jane/repo/server/routes/x.ts#L5)', 'the route'],
    ['a link with no words', '[](/Users/jane/repo/y.ts)', 'y.ts'],
    ['a link whose words are the path', '[/Users/jane/repo/z.md](/Users/jane/repo/z.md)', 'z.md'],
    ['an angle-wrapped destination with spaces', '[](</Users/jane/My Dir/c d.md>)', 'c d.md'],
    ['an image link', '![shot](/private/var/folders/ab/T/shot.png)', 'shot'],
    ['a bare path, keeping the sentence', 'Wrote /Users/jane/repo/notes.md.', 'Wrote notes.md.'],
    ['a bare path with a line', 'at /Users/jane/repo/b.ts:7:3 here', 'at b.ts:7:3 here'],

    ['a home shorthand', 'Saved to ~/Documents/plan.md', 'Saved to plan.md'],
    ['$HOME and ${HOME}', 'in $HOME/.config/a.json or ${HOME}/b.txt', 'in a.json or b.txt'],
    ['another user home', 'see ~bob/notes.txt', 'see notes.txt'],
    ['folder names with spaces', 'Open /Users/jane/Documents/GitHub/Acme Chief Of Staff/Repo-One/CLAUDE.md now', 'Open CLAUDE.md now'],
    ['a file URL', 'file:///Users/jane/a%20b.png', 'a b.png'],
    ['an editor URL', 'vscode://file/Users/jane/x.ts:3', 'x.ts:3'],
    ['a directory', 'cd /Users/jane/repo/ && ls /tmp', 'cd repo && ls /tmp'],
    ['a directory at the end of a sentence', 'Everything is in /Users/jane/repo/.', 'Everything is in repo.'],
    ['a path in quotes and parentheses', '("/Volumes/Backup/a.zip") and \'/opt/homebrew/bin/node\'', '("a.zip") and \'/opt/homebrew/bin/node\''],
    ['smart double quotes', 'Saved to “/Users/jane/private/report.pdf”.', 'Saved to “report.pdf”.'],
    ['smart single quotes', 'Saved to ‘/Users/jane/private/report.pdf’.', 'Saved to ‘report.pdf’.'],
    ['an arrow before a path', 'Open →/Users/jane/private/report.pdf', 'Open →report.pdf'],
    ['an em dash before a path', 'Result—/Users/jane/private/report.pdf!', 'Result—report.pdf!'],
    ['closing punctuation before a path', 'See )/Users/jane/private/report.pdf', 'See )report.pdf'],
    ['symbol punctuation before a home path', 'Saved +~/Documents/report.pdf', 'Saved +report.pdf'],
  ]
  for (const [label, input, output] of cases) {
    it(label, () => {
      const out = redactLocalPaths(input)
      expect(out).toBe(output)
      expect(out).not.toMatch(ABSOLUTE)
    })
  }
  it('web URLs are untouched, Markdown links to the web included', () => {
    for (const text of [
      'https://github.com/example/repo/blob/main/server/app.ts#L42',
      '[the PR](https://github.com/example/repo/pull/12) and <https://example.com/docs?a=1>',
      'http://localhost:3141/api/health and https://example.com/var/tmp/page',
      'https://example.com/view?path=/var/reports/result.html&mode=preview',
      'https://example.com/view?first=/var/a&second=~/Documents/b&third=$HOME/c',
      'https://example.com/Users/jane/profile and [docs](https://example.com/Users/guide)',
    ]) expect(redactLocalPaths(text)).toBe(text)
  })
  it('a home folder in a web URL query or fragment reads ~, and the rest of the URL is kept byte for byte (7.0.4 B1)', () => {
    const cases: Array<[string, string]> = [
      ['<https://example.com/view?path=/Users/jane/report.pdf&mode=preview>', '<https://example.com/view?path=~/report.pdf&mode=preview>'],
      ['[view](https://example.com/view?path=/Users/jane/repo/report.pdf&mode=preview)', '[view](https://example.com/view?path=~/repo/report.pdf&mode=preview)'],
      ['[view](<https://example.com/view?path=/Users/jane/report.pdf&mode=preview>)', '[view](<https://example.com/view?path=~/report.pdf&mode=preview>)'],
      ['https://example.com/view?file=file:///Users/jane/report.pdf#tab=/Users/jane/notes', 'https://example.com/view?file=file:~/report.pdf#tab=~/notes'],
      ['https://example.com/docs/a_(b)?path=/var/c#tab=/Users/jane/d', 'https://example.com/docs/a_(b)?path=/var/c#tab=~/d'],
      ['https://example.com/v?f=%2FUsers%2Fjane%2Fa.pdf&x=1', 'https://example.com/v?f=~%2Fa.pdf&x=1'],
      ['https://example.com/v?p=/Users/jane&x=1', 'https://example.com/v?p=~&x=1'],
    ]
    for (const [input, output] of cases) {
      expect(redactLocalPaths(input), input).toBe(output)
      expect(redactLocalPaths(input)).not.toMatch(HOME)
    }
  })
  it('URL preservation does not hide local prose paths or path-bearing link words beside it', () => {
    const url = 'https://example.com/view?path=/var/reports/result.html&mode=preview'
    expect(redactLocalPaths(`See ${url}; wrote /Users/jane/private/report.pdf.`)).toBe(`See ${url}; wrote report.pdf.`)
    expect(redactLocalPaths(`[open /Users/jane/private/report.pdf](${url})`)).toBe(`[open report.pdf](${url})`)
    expect(redactLocalPaths(`“${url}” →/Users/jane/private/report.pdf`)).toBe(`“${url}” →report.pdf`)
    expect(redactLocalPaths(`[view](${url})/Users/jane/private/report.pdf`)).toBe(`[view](${url})report.pdf`)
    expect(redactLocalPaths(`(https://example.com/a_(b)?path=/var/c)/Users/jane/private/report.pdf`)).toBe('(https://example.com/a_(b)?path=/var/c)report.pdf')
    expect(redactLocalPaths('[https://example.com/docs](/Users/jane/private/report.pdf)')).toBe('https://example.com/docs')
  })
  it('relative paths and site paths stay as written', () => {
    for (const text of ['See [guide](docs/guide.md) and server/lib/x.ts:12', 'GET /api/agent-sessions/:provider/:sessionId', 'and/or 1/2', './run.sh ../up.md', '../Users/jane/report.pdf and ./Users/jane/report.pdf and docs/Users/jane/report.pdf', 'GET /variables/list and /usrx/a and /Users-guide/x']) {
      expect(redactLocalPaths(text)).toBe(text)
    }
  })
  it('the link words keep any path inside them redacted too', () => {
    expect(redactLocalPaths('[open /Users/jane/a.md](https://example.com/x)')).toBe('[open a.md](https://example.com/x)')
  })
  it('non-strings pass through', () => {
    expect(redactLocalPaths('')).toBe('')
    expect(redactLocalPaths(undefined as unknown as string)).toBe(undefined)
  })
})

/**
 * 7.0.4 B1: ordinary text must not change. Every string here was rewritten by the first cut (or is the same shape):
 * `~<digit>` read as a home folder, every Unix top-level folder read as private, and a path carried across
 * capitalised words that never reached a file.
 */
describe('must not change: prose, code, numbers and system paths', () => {
  const unchanged = [
    // The verified failures.
    'Pacing ~80/100 leads; SQL ~12/day',
    '~280/mo, ~15/day and ~48K/day',
    'Reduced to ~1/3 the size',
    'Saved to /tmp/out Next Steps: Review A/B results today',
    'npm test >/dev/null 2>&1',
    '#!/usr/bin/env node',
    'Open /home and then /run/start to begin.',
    // System paths in prose.
    'Use /opt/homebrew/bin/node and /usr/local/bin/python3.',
    'The regex /etc/ matches /etc/hosts.',
    'cp -r /tmp/build ./out',
    'Logs are in /var/log/system.log and /Library/Logs/x.log',
    'the /Users folder and /Volumes on this Mac',
    // Code snippets and shell lines.
    'const ratio = a/b; if (x > 1/2) return y',
    "import x from '../lib/a.js'; import y from './b.js'",
    '`ls /tmp && cat /etc/hosts`',
    '```sh\nnpm test >/dev/null 2>&1\n#!/usr/bin/env node\ncp -r /tmp/build ./out\n```',
    'export PATH=/opt/homebrew/bin:/usr/bin',
    'rm -rf ./build/ && mkdir -p dist/assets',
    // Ratios, fractions, approximations.
    '3/4 done, 50/50 split, ~3 days, ~ 5 minutes, ~12/day, ~half the time',
    'A/B testing over TCP/IP, and/or 1/2',
    // Dates and versions.
    'Due 11/08, shipped 11/08/2026, logged 2026/11/08',
    'v7.0.4 and 7.0.4/7.0.5, node 22.11.0, macOS 15.1',
    // Site paths and relative paths.
    'GET /api/agent-sessions/:provider/:sessionId',
    'See [guide](docs/guide.md) and server/lib/x.ts:12',
    // Markdown links to https URLs.
    '[docs](https://example.com/Users/guide) and [blob](https://github.com/a/b/blob/main/README.md#L4)',
    '<https://example.com/tmp/x> and https://example.com/home',
  ]
  for (const text of unchanged) it(JSON.stringify(text).slice(0, 70), () => expect(redactLocalPaths(text)).toBe(text))
})

/** 7.0.4 B1: every shape a private Mac path reaches the browser in. Prose reads base names; code keeps the path with `~`. */
describe('must redact: private Mac paths in every shape', () => {
  const cases: Array<[string, string, string]> = [
    ['a Mac path with spaces', 'Open /Users/ukaoma/Documents/GitHub/Ukaoma Chief Of Staff/MU-Chief-Staff/x.md now', 'Open x.md now'],
    ['spaces, ending at a folder', 'Look in /Users/jane/Documents/My Projects/Repo/ today', 'Look in Repo today'],
    ['spaces that never reach a file are not followed', 'Saved to /Users/jane/out Next Steps: Review A/B results today', 'Saved to out Next Steps: Review A/B results today'],
    ['a sentence end stops the spaces', 'Wrote /Users/jane/out. Then Read Docs/plan.md', 'Wrote out. Then Read Docs/plan.md'],
    ['a sentence end inside the spaces stops them', 'Saved /Users/jane/out Final/draft. Then Read Docs/plan.md', 'Saved out Final/draft. Then Read Docs/plan.md'],
    ['a word with a colon is not a folder name', 'Saved /Users/jane/out Next Steps: Review/plan.md', 'Saved out Next Steps: Review/plan.md'],
    ['a number is not a file extension', 'Saved /Users/jane/out Build 10/10.15 later', 'Saved out Build 10/10.15 later'],
    ['a dot folder', 'Read /Users/jane/.config/gh/hosts.yml', 'Read hosts.yml'],
    ['the cos-glasses data folder', 'Wrote /Users/jane/.cos-glasses/data/archive.json and ~/.cos-glasses/data/x.json', 'Wrote archive.json and x.json'],
    ['a path in double quotes', 'Saved "/Users/jane/Desktop/report.pdf".', 'Saved "report.pdf".'],
    ['a path in single quotes', "open '/Volumes/Backup/a.zip'", "open 'a.zip'"],
    ['a file URL', 'file:///Users/jane/a%20b.png and file:///private/var/folders/x/T/c.png', 'a b.png and c.png'],
    ['a path followed by :42', 'at /Users/jane/repo/b.ts:42 here', 'at b.ts:42 here'],
    ['a path followed by :42:7 and a period', 'See /Users/jane/repo/b.ts:42:7.', 'See b.ts:42:7.'],
    ['per-user temp', 'Shot at /var/folders/ab/xyz/T/shot.png and /private/var/folders/ab/T/s2.png', 'Shot at shot.png and s2.png'],
    ['a home shorthand', 'Saved to ~/Documents/plan.md and ~bob/notes.txt', 'Saved to plan.md and notes.txt'],
    ['a doubled slash', 'see //Users/jane/a.md', 'see a.md'],
    ['any letter case (APFS)', 'see /USERS/jane/b.md and /users/jane/c.md', 'see b.md and c.md'],
    ['the home folder alone reads ~', '/Users/jane is home', '~ is home'],
    ['after Markdown bold', 'Wrote **/Users/jane/repo/a.md** today', 'Wrote **a.md** today'],
    ['after Markdown italic', 'Wrote */Users/jane/repo/a.md* today', 'Wrote *a.md* today'],
    ['after a redirect', 'echo hi >/Users/jane/out.log', 'echo hi >out.log'],
    ['after a blockquote marker', '> /Users/jane/repo/a.md was changed', '> a.md was changed'],
    ['after a blockquote marker with no space', '>/Users/jane/repo/a.md', '>a.md'],
  ]
  for (const [label, input, output] of cases) {
    it(label, () => {
      const out = redactLocalPaths(input)
      expect(out).toBe(output)
      expect(out).not.toMatch(ABSOLUTE)
      expect(out).not.toMatch(HOME)
    })
  }
  it('a path in backticks keeps its path, with the home folder as ~ (a copied command still runs)', () => {
    expect(redactLocalPaths('Run `cat /Users/jane/.zshrc` now')).toBe('Run `cat ~/.zshrc` now')
    expect(redactLocalPaths('Logs in `/Users/jane/My Repo/out.log`.')).toBe('Logs in `~/My Repo/out.log`.')
    expect(redactLocalPaths('Run `/private/tmp/build/out.log` now')).toBe('Run `/private/tmp/build/out.log` now')
    expect(redactLocalPaths('``a `x` /Users/jane/b``')).toBe('``a `x` ~/b``')
  })
})

/** 7.0.4 W5: a command keeps its meaning. A base name would turn `rm -rf /Users/x/Documents` into `rm -rf Documents`. */
describe('commands keep their meaning', () => {
  it('rm -rf in a code span keeps the whole path, home as ~', () => {
    expect(redactLocalPaths('Wants `rm -rf /Users/ukaoma/Documents`')).toBe('Wants `rm -rf ~/Documents`')
  })
  it('cp -r /tmp/build is not touched anywhere', () => {
    expect(redactLocalPaths('cp -r /tmp/build ./out')).toBe('cp -r /tmp/build ./out')
    expect(redactLocalPaths('`cp -r /tmp/build ./out`')).toBe('`cp -r /tmp/build ./out`')
  })
  it('a fenced shell block keeps every path; only the home folder reads ~', () => {
    const block = '```sh\nrm -rf /Users/ukaoma/Documents/old\ncp -r /tmp/build /Users/ukaoma/out\nls /Volumes/Backup >/dev/null\n```'
    expect(redactLocalPaths(`Run this:\n${block}\nThen open /Users/ukaoma/out/index.html.`))
      .toBe('Run this:\n```sh\nrm -rf ~/Documents/old\ncp -r /tmp/build ~/out\nls /Volumes/Backup >/dev/null\n```\nThen open index.html.')
    expect(redactLocalPaths('~~~\ncat /Users/x/a.txt\n~~~')).toBe('~~~\ncat ~/a.txt\n~~~')
    // A fence closes only with its own kind of fence.
    expect(redactLocalPaths('```\n~~~\nrm /Users/x/a\n```')).toBe('```\n~~~\nrm ~/a\n```')
    // An inline span never crosses a blank line: that is two paragraphs, and the path is prose.
    expect(redactLocalPaths('Start `a\n\nrm /Users/x/b.md then `end')).toBe('Start `a\n\nrm b.md then `end')
    // An unclosed fence runs to the end of the text.
    expect(redactLocalPaths('```\nrm /Users/x/a')).toBe('```\nrm ~/a')
  })
  it('a Markdown link written inside code is code', () => {
    expect(redactLocalPaths('`[a](/Users/x/a.md)`')).toBe('`[a](~/a.md)`')
  })
  it('hideHomeFolder hides only the home folder; /Users/Shared is not a home', () => {
    expect(hideHomeFolder('rm -rf /Users/ukaoma/Documents')).toBe('rm -rf ~/Documents')
    expect(hideHomeFolder('open /Users/Shared/x.png and /tmp/y')).toBe('open /Users/Shared/x.png and /tmp/y')
    expect(hideHomeFolder('docs/Users/jane/x')).toBe('docs/Users/jane/x')
  })
})

describe('redactLocalPathsDeep', () => {
  it('every string in a JSON value, at any depth; keys, numbers, booleans and null are left alone', () => {
    const value = { latest_reply: 'At /Users/jane/a.ts', n: 3, ok: true, none: null, turns: [{ text: '~/x/y.md', outputFiles: [{ name: 'r.pdf' }] }], '/Users/key': 'k' }
    expect(redactLocalPathsDeep(value)).toEqual({ latest_reply: 'At a.ts', n: 3, ok: true, none: null, turns: [{ text: 'y.md', outputFiles: [{ name: 'r.pdf' }] }], '/Users/key': 'k' })
  })
})

describe('redactLocalPathsDeep: command and verbatim keys (7.0.4 W5)', () => {
  it('waiting_detail and failure keep the command whole, with the home folder as ~', () => {
    const row = { waiting_detail: 'rm -rf /Users/ukaoma/Documents', failure: 'tool_error at /Users/ukaoma/x.ts', latest_reply: 'Edited /Users/ukaoma/x.ts' }
    expect(redactLocalPathsDeep(row)).toEqual({ waiting_detail: 'rm -rf ~/Documents', failure: 'tool_error at ~/x.ts', latest_reply: 'Edited x.ts' })
  })
  it('homeOnly with verbatim labels: an approval card keeps its paths, an option label is exact', () => {
    const items = [{ approval: { summary: 'rm -rf /Users/ukaoma/Documents', detail: 'cp /tmp/a /Users/ukaoma/b' }, questions: [{ question: 'Use /Users/ukaoma/a?', options: [{ label: '/Users/ukaoma/a', description: 'at /Users/ukaoma/a' }] }] }]
    expect(redactLocalPathsDeep(items, { homeOnly: true, verbatimKeys: new Set(['label']) })).toEqual([
      { approval: { summary: 'rm -rf ~/Documents', detail: 'cp /tmp/a ~/b' }, questions: [{ question: 'Use ~/a?', options: [{ label: '/Users/ukaoma/a', description: 'at ~/a' }] }] },
    ])
  })
})
