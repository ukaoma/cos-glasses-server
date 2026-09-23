import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, afterAll } from 'vitest'
import { listWorkspaceSkills, parseSkillFrontmatter } from './workspace-skills.js'

// Every temp root this file makes is removed when the file ends (6.53.3 /qa W3: the suites
// had left ~150,000 `cos-*` folders in $TMPDIR). Tracked at the mkdtemp call, so a new test
// cannot forget it.
const trackedTempRoots: string[] = []
function trackedTemp<T extends string>(root: T): T {
  trackedTempRoots.push(root)
  return root
}
afterAll(() => {
  for (const root of trackedTempRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* a chmod'ed tree: best effort */ }
  }
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function skillDir(root: string, rel: string, body: string) {
  const dir = join(root, ...rel.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), body)
}

describe('parseSkillFrontmatter', () => {
  it('reads a folded description and a quoted name', () => {
    const meta = parseSkillFrontmatter(`---
name: "morning"
description: >-
  Sync meetings, generate briefing
  and preview the day.
---
# body
`)
    expect(meta.name).toBe('morning')
    expect(meta.description).toBe('Sync meetings, generate briefing and preview the day.')
  })
})

describe('listWorkspaceSkills', () => {
  it('prefers canonical .agents skills, flattens nested names, and skips generated duplicates', () => {
    const work = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-skills-work-')))
    const home = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-skills-home-')))
    roots.push(work, home)

    skillDir(work, '.agents/skills/cos', `---
name: cos
description: Dashboard urgent tasks
---
`)
    skillDir(work, '.agents/skills/customer-marketing/intel', `---
name: customer-marketing:intel
description: Upsell intelligence
---
`)
    skillDir(work, '.agents/skills/source-command-cos', `---
name: source-command-cos
description: Generated duplicate
---
`)
    skillDir(work, '.claude/skills/cos', `---
description: Mirror of /cos
---
`)
    skillDir(work, '.claude/skills/health', `---
description: Oura Ring
---
`)
    skillDir(home, '.claude/skills/my-note', `---
name: my-note
description: Personal capture
---
`)

    const skills = listWorkspaceSkills({ workDir: work, home })
    expect(skills.map(s => s.slash)).toEqual([
      '/cos',
      '/health',
      '/customer-marketing:intel',
      '/my-note',
    ])
    expect(skills.find(s => s.name === 'cos')).toMatchObject({
      description: 'Dashboard urgent tasks',
      group: 'WORKSPACE',
      where: 'workspace',
    })
    expect(skills.find(s => s.name === 'customer-marketing:intel')).toMatchObject({
      group: 'CUSTOMER MARKETING',
      slash: '/customer-marketing:intel',
    })
    expect(skills.find(s => s.name === 'my-note')).toMatchObject({
      group: 'USER',
      where: 'user',
    })
    expect(JSON.stringify(skills)).not.toContain(work)
    expect(JSON.stringify(skills)).not.toContain(home)
  })

  it('returns an empty list when nothing is installed', () => {
    const work = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-skills-empty-')))
    const home = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-skills-empty-home-')))
    roots.push(work, home)
    expect(listWorkspaceSkills({ workDir: work, home })).toEqual([])
  })

  it('is mounted on the authenticated API', () => {
    const index = readFileSync(resolve(import.meta.dirname, '../index.ts'), 'utf8')
    expect(index).toContain("from './routes/skills.js'")
    expect(index).toContain("app.use('/api', skillsRouter)")
  })
})
