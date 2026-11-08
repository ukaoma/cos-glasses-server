/**
 * Preview engine phase 1: the link-card tokenizer, line anchors, kinds and the resolver. The fixture root has a space
 * and a dot component, as the real repo path ("Ukaoma Chief Of Staff") and the data home (~/.cos-glasses) do.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { authorizedRoot, isLocalTarget, linkCardWords, linkLabel, linkTokens, previewKind, resolveLinkTarget, splitLineAnchor, withoutLinkMarkers } from './session-links.js'

const made: string[] = []
afterEach(() => { for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true }) })
function tree() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'cos links-'))); made.push(top)
  const home = join(top, 'home')
  const repo = join(home, 'Ukaoma Chief Of Staff', 'MU-Chief-Staff')
  const sub = join(repo, 'operations', 'personal')
  const extra = join(home, 'cos-worktrees')
  const dot = join(repo, '.cos-data')
  for (const d of [sub, join(sub, 'wk45_2026'), extra, dot, join(home, 'elsewhere')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(sub, 'wk45_2026', 'PLAN.md'), '# Plan')
  writeFileSync(join(repo, 'README.md'), '# Root readme')
  writeFileSync(join(sub, 'local.md'), '# Local')
  writeFileSync(join(extra, 'EVIDENCE.md'), '# Evidence')
  writeFileSync(join(dot, 'notes.txt'), 'dot folder')
  writeFileSync(join(home, 'elsewhere', 'private.md'), 'outside')
  writeFileSync(join(repo, '.env'), 'TOKEN=x')
  writeFileSync(join(repo, 'cos-key.json'), '{}')
  writeFileSync(join(repo, 'Q3 plan (draft).md'), '# spaces')
  symlinkSync(join(home, 'elsewhere', 'private.md'), join(repo, 'escape.md'))
  symlinkSync(join(repo, '.env'), join(repo, 'innocent.txt'))
  return { top, home, repo, sub, extra, dot }
}

describe('linkTokens: the bounded link scanner', () => {
  it('finds [label](target) and its span, never an image, and keeps code, fences, indented blocks and comments inert', () => {
    const text = [
      'See [the plan](operations/PLAN.md) and ![shot](out/a.png).',
      '`[code](x.md)` and ``[also](y.md)``',
      '```', '[fenced](z.md)', '```',
      '    [indented](w.md)',
      '<!-- [hidden](h.md) -->',
      '\\[escaped](e.md)',
      'Last [one](<a b/c (1).md>) and [titled](t.md "Title") and [paren](p (1).md).',
    ].join('\n')
    const got = linkTokens(text)
    expect(got.map(t => [t.label, t.target])).toEqual([
      ['the plan', 'operations/PLAN.md'], ['one', 'a b/c (1).md'], ['titled', 't.md'], ['paren', 'p (1).md'],
    ])
    expect(text.slice(got[0].start, got[0].end)).toBe('[the plan](operations/PLAN.md)')
  })
  it('a checkbox or bracketed word before a link does not swallow it', () => {
    expect(linkTokens('- [ ] do it [plan](p.md)').map(t => t.target)).toEqual(['p.md'])
    expect(linkTokens('[a] then [b](b.md)').map(t => t.label)).toEqual(['b'])
  })
  it('stops at the scan limit and refuses control characters and multi-line targets', () => {
    expect(linkTokens('[a](x\u0001.md)')).toEqual([])
    expect(linkTokens('[a](x\n.md)')).toEqual([])
    expect(linkTokens('x'.repeat(50) + '[late](l.md)', 40)).toEqual([])
  })
})

describe('targets, anchors, kinds and labels', () => {
  it('only local targets become cards', () => {
    for (const t of ['a.md', './a.md', '../a.md', '/abs/a.md', '~/a.md', 'file:///x/a.md']) expect(isLocalTarget(t), t).toBe(true)
    for (const t of ['https://x.com', 'http://x', 'mailto:a@b', '#anchor', '//host/a', 'C:\\x', 'claude://x', 'vscode://file/x']) expect(isLocalTarget(t), t).toBe(false)
  })
  it('line suffixes become line, never part of the name', () => {
    expect(splitLineAnchor('src/a.ts:42')).toEqual({ path: 'src/a.ts', line: 42 })
    expect(splitLineAnchor('src/a.ts:42:7')).toEqual({ path: 'src/a.ts', line: 42 })
    expect(splitLineAnchor('src/a.ts:42-50')).toEqual({ path: 'src/a.ts', line: 42 })
    expect(splitLineAnchor('src/a.ts#L9')).toEqual({ path: 'src/a.ts', line: 9 })
    expect(splitLineAnchor('src/a.ts#L9-L12')).toEqual({ path: 'src/a.ts', line: 9 })
    expect(splitLineAnchor('PLAN.md#section-2')).toEqual({ path: 'PLAN.md' })
    expect(splitLineAnchor('PLAN.md')).toEqual({ path: 'PLAN.md' })
  })
  it('kinds', () => {
    expect(previewKind('a.MD').kind).toBe('markdown')
    expect(previewKind('a.ts')).toEqual({ kind: 'code', type: 'TypeScript' })
    expect(previewKind('a.csv').kind).toBe('table')
    expect(previewKind('a.tsv').kind).toBe('table')
    expect(previewKind('a.html').kind).toBe('html')
    expect(previewKind('a.pdf').kind).toBe('pdf')
    expect(previewKind('a.png').kind).toBe('image')
    expect(previewKind('a.svg')).toEqual({ kind: 'code', type: 'SVG source' })
    expect(previewKind('a.xlsx').kind).toBe('sheet')
    expect(previewKind('a.docx').kind).toBe('document')
    expect(previewKind('a.pptx').kind).toBe('slides')
    expect(previewKind('a.ehpk').kind).toBe('archive')
    expect(previewKind('noext')).toEqual({ kind: 'file', type: 'File' })
  })
  it('a label that is itself a Mac path shows only its base name', () => {
    expect(linkLabel('/Users/ukaoma/x/plan.md', 'plan.md')).toBe('plan.md')
    expect(linkLabel('~/cos-worktrees/x/EVIDENCE.md', 'EVIDENCE.md')).toBe('EVIDENCE.md')
    expect(linkLabel('file:///Users/u/a.md', 'a.md')).toBe('a.md')
    expect(linkLabel('see /private/tmp/x.md', 'x.md')).toBe('x.md')
    expect(linkLabel('the plan', 'PLAN.md')).toBe('the plan')
    expect(linkLabel('operations/personal/PLAN.md', 'PLAN.md')).toBe('operations/personal/PLAN.md')
    expect(linkLabel('   ', 'PLAN.md')).toBe('PLAN.md')
  })

  it('linkCardWords keeps the line a link points at when the words are the file name (7.0.5 QA)', () => {
    expect(linkCardWords('app.ts', 'app.ts', '/Users/jane/repo/app.ts#L42')).toBe('app.ts:42')
    expect(linkCardWords('/Users/jane/repo/plan.md', 'plan.md', '/Users/jane/repo/plan.md:3')).toBe('plan.md:3')
    expect(linkCardWords('routes.ts:9', 'routes.ts', '/Users/jane/repo/routes.ts:9')).toBe('routes.ts:9')
    expect(linkCardWords('the plan', 'plan.md', '/Users/jane/plan.md#L3')).toBe('the plan')
    expect(linkCardWords('app.ts', 'app.ts', '/Users/jane/repo/app.ts')).toBe('app.ts')
    expect(linkCardWords('a.md', 'a.md', 'file:///Users/u/a.md#L7')).toBe('a.md:7')
  })
  it('markers turn back into words', () => {
    expect(withoutLinkMarkers('See [the plan](cos-file:0) and [b](cos-file:12).')).toBe('See the plan and b.')
  })
})

describe('resolveLinkTarget', () => {
  it('the row cwd first, then the workspace root (21% of real relative links need the root)', () => {
    const t = tree()
    const roots = { workspace: t.repo, extra: [], home: t.home }
    const fromCwd = resolveLinkTarget('local.md', [t.sub, t.repo], roots)
    expect(fromCwd).toMatchObject({ state: 'available', path: join(t.sub, 'local.md'), root: t.repo, name: 'local.md', isDir: false })
    const fromRoot = resolveLinkTarget('operations/personal/wk45_2026/PLAN.md', [t.sub, t.repo], roots)
    expect(fromRoot).toMatchObject({ state: 'available', path: join(t.sub, 'wk45_2026', 'PLAN.md') })
    expect(resolveLinkTarget('README.md:3', [t.sub, t.repo], roots)).toMatchObject({ state: 'available', name: 'README.md' })
  })
  it('absolute, home, file:// and percent-encoded targets with spaces resolve; a dot folder is fine', () => {
    const t = tree()
    const roots = { workspace: t.repo, extra: [], home: t.home }
    expect(resolveLinkTarget(join(t.repo, 'README.md'), [null, t.repo], roots).state).toBe('available')
    expect(resolveLinkTarget('~/Ukaoma Chief Of Staff/MU-Chief-Staff/README.md', [null], roots).state).toBe('available')
    expect(resolveLinkTarget(pathToFileURL(join(t.repo, 'README.md')).href, [null], roots).state).toBe('available')
    expect(resolveLinkTarget('Q3%20plan%20(draft).md', [t.repo], roots)).toMatchObject({ state: 'available', name: 'Q3 plan (draft).md' })
    expect(resolveLinkTarget('.cos-data/notes.txt', [t.repo], roots).state).toBe('available')
  })
  it('outside, missing, a symlink out, a broad or failed workspace', () => {
    const t = tree()
    const roots = { workspace: t.repo, extra: [], home: t.home }
    expect(resolveLinkTarget(join(t.home, 'elsewhere', 'private.md'), [t.repo], roots)).toMatchObject({ state: 'unavailable', reason: 'outside_workspace' })
    expect(resolveLinkTarget('../../elsewhere/private.md', [t.repo], roots)).toMatchObject({ state: 'unavailable', reason: 'outside_workspace' })
    expect(resolveLinkTarget('gone.md', [t.repo], roots)).toMatchObject({ state: 'unavailable', reason: 'missing' })
    expect(resolveLinkTarget(join(t.home, 'elsewhere', 'gone.md'), [t.repo], roots)).toMatchObject({ state: 'unavailable', reason: 'outside_workspace' })
    expect(resolveLinkTarget('escape.md', [t.repo], roots), 'the canonical file decides').toMatchObject({ state: 'unavailable', reason: 'outside_workspace' })
    expect(resolveLinkTarget('README.md', [t.repo], { workspace: null, extra: [], home: t.home })).toMatchObject({ state: 'unavailable', reason: 'outside_workspace' })
    expect(resolveLinkTarget('README.md', [null, null], roots)).toMatchObject({ state: 'unavailable', reason: 'outside_workspace' })
  })
  it('the shared deny list refuses by written name and by canonical name, before any read', () => {
    const t = tree()
    const roots = { workspace: t.repo, extra: [], home: t.home }
    expect(resolveLinkTarget('.env', [t.repo], roots)).toMatchObject({ state: 'unavailable', reason: 'secret_file' })
    expect(resolveLinkTarget('cos-key.json', [t.repo], roots)).toMatchObject({ state: 'unavailable', reason: 'secret_file' })
    expect(resolveLinkTarget('missing/.env.local', [t.repo], roots)).toMatchObject({ state: 'unavailable', reason: 'secret_file' })
    expect(resolveLinkTarget('innocent.txt', [t.repo], roots), 'a link to .env').toMatchObject({ state: 'unavailable', reason: 'secret_file' })
  })
  it('a Settings extra folder is an allowed root; nothing else is', () => {
    const t = tree()
    const target = join(t.extra, 'EVIDENCE.md')
    expect(resolveLinkTarget(target, [t.repo], { workspace: t.repo, extra: [], home: t.home })).toMatchObject({ state: 'unavailable', reason: 'outside_workspace' })
    expect(resolveLinkTarget(target, [t.repo], { workspace: t.repo, extra: [t.extra], home: t.home })).toMatchObject({ state: 'available', root: t.extra })
    expect(resolveLinkTarget('~/cos-worktrees/gone.md', [null], { workspace: null, extra: [t.extra], home: t.home })).toMatchObject({ state: 'unavailable', reason: 'missing' })
    expect(authorizedRoot(t.extra, { workspace: t.repo, extra: [t.extra], home: t.home }), 'a root itself is not inside it').toBeNull()
  })
  it('a folder link is a folder card', () => {
    const t = tree()
    expect(resolveLinkTarget('operations/personal/wk45_2026', [t.repo], { workspace: t.repo, extra: [], home: t.home })).toMatchObject({ state: 'available', isDir: true, name: 'wk45_2026' })
  })
})
