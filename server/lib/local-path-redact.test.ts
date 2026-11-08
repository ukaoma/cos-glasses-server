/**
 * 7.0.4 S1: absolute local paths in a session's words become base names before they leave the Mac. Web URLs and
 * relative paths are untouched. Fixture strings are hand-written in the shapes Claude and Codex replies use.
 */
import { describe, expect, it } from 'vitest'
import { redactLocalPaths, redactLocalPathsDeep } from './local-path-redact.js'

/** An independent detector, not the module's own: any absolute local path, a home shorthand or a file URL. */
const ABSOLUTE = /(?:^|[^A-Za-z0-9.:/-])\/(?:Users|Volumes|private|var|tmp|opt|Applications|Library|System|usr|etc|home)(?:\/|\b)|~[A-Za-z0-9._-]*\/|\$\{?HOME\}?\/|\bfile:\/\/|\bvscode:\/\//

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
    ['an inline code span', 'Run `/private/tmp/build/out.log` now', 'Run `out.log` now'],
    ['a code span with a command', '`cat /Users/jane/.zshrc`', '`cat .zshrc`'],
    ['a home shorthand', 'Saved to ~/Documents/plan.md', 'Saved to plan.md'],
    ['$HOME and ${HOME}', 'in $HOME/.config/a.json or ${HOME}/b.txt', 'in a.json or b.txt'],
    ['another user home', 'see ~bob/notes.txt', 'see notes.txt'],
    ['folder names with spaces', 'Open /Users/jane/Documents/GitHub/Acme Chief Of Staff/Repo-One/CLAUDE.md now', 'Open CLAUDE.md now'],
    ['a file URL', 'file:///Users/jane/a%20b.png', 'a b.png'],
    ['an editor URL', 'vscode://file/Users/jane/x.ts:3', 'x.ts:3'],
    ['a directory', 'cd /Users/jane/repo/ && ls /tmp', 'cd repo && ls tmp'],
    ['a directory at the end of a sentence', 'Everything is in /Users/jane/repo/.', 'Everything is in repo.'],
    ['a path in quotes and parentheses', '("/Volumes/Backup/a.zip") and \'/opt/homebrew/bin/node\'', '("a.zip") and \'node\''],
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
    ]) expect(redactLocalPaths(text)).toBe(text)
  })
  it('relative paths and site paths stay as written', () => {
    for (const text of ['See [guide](docs/guide.md) and server/lib/x.ts:12', 'GET /api/agent-sessions/:provider/:sessionId', 'and/or 1/2', './run.sh ../up.md', 'GET /variables/list and /usrx/a and /Users-guide/x']) {
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

describe('redactLocalPathsDeep', () => {
  it('every string in a JSON value, at any depth; keys, numbers, booleans and null are left alone', () => {
    const value = { latest_reply: 'At /Users/jane/a.ts', n: 3, ok: true, none: null, turns: [{ text: '~/x/y.md', outputFiles: [{ name: 'r.pdf' }] }], '/Users/key': 'k' }
    expect(redactLocalPathsDeep(value)).toEqual({ latest_reply: 'At a.ts', n: 3, ok: true, none: null, turns: [{ text: 'y.md', outputFiles: [{ name: 'r.pdf' }] }], '/Users/key': 'k' })
  })
})
