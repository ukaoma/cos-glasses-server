// Catalog of skills the glasses agent can actually run: the selected COS
// workspace plus the user's global Claude skills. Labels only — never paths.
//
// Walk matches skill_sync.py: `.agents/skills` is canonical (nested folders
// flatten with `:`), `.claude/skills` is a one-level mirror, `source-command-*`
// is excluded as a generated duplicate. User skills live in `~/.claude/skills`.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { COS_SCRIPTS_DIR } from './python-bridge.js'
import { resolveProviderWorkDir } from './launch-dir.js'

export const SKILLS_CATALOG_SCHEMA = 1
export const SKILLS_CATALOG_MAX = 200
const SKILL_FILE_MAX_BYTES = 8_192
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/
const EXCLUDE_PREFIXES = ['source-command-']

export interface WorkspaceSkill {
  name: string
  slash: string
  description: string
  group: string
  where: 'workspace' | 'user'
}

export interface WorkspaceSkillsCatalog {
  schemaVersion: number
  skills: WorkspaceSkill[]
}

export function parseSkillFrontmatter(text: string): Record<string, string> {
  const src = text.replace(/^\uFEFF/, '')
  if (!src.startsWith('---')) return {}
  const end = src.indexOf('\n---', 3)
  if (end < 0) return {}
  const block = src.slice(3, end).replace(/^\r?\n/, '')
  const out: Record<string, string> = {}
  const lines = block.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!match) { i += 1; continue }
    const key = match[1]
    let raw = match[2].trim()
    if (raw === '>' || raw === '>-' || raw === '|' || raw === '|-') {
      const parts: string[] = []
      i += 1
      while (i < lines.length && /^\s+\S/.test(lines[i]) && !/^[A-Za-z_][\w-]*:/.test(lines[i])) {
        parts.push(lines[i].trim())
        i += 1
      }
      out[key] = unquote(parts.join(' '))
      continue
    }
    out[key] = unquote(raw)
    i += 1
  }
  return out
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'").trim()
  }
  return trimmed
}

function excludedName(name: string): boolean {
  return EXCLUDE_PREFIXES.some(prefix => name === prefix.slice(0, -1) || name.startsWith(prefix))
}

function skillNameFromRel(rel: string): string | null {
  const parts = rel.split(/[/\\]/).filter(part => part && part !== '.')
  if (parts.length === 0 || parts.some(part => part.startsWith('.') || excludedName(part))) return null
  const name = parts.join(':')
  return SKILL_NAME_RE.test(name) ? name : null
}

function readSkillFile(path: string): { name?: string; description: string } | null {
  let stat
  try { stat = statSync(path) } catch { return null }
  if (!stat.isFile() || stat.size <= 0) return null
  const bytes = Math.min(stat.size, SKILL_FILE_MAX_BYTES)
  let text: string
  try {
    text = readFileSync(path, { encoding: 'utf8' }).slice(0, bytes)
  } catch {
    return null
  }
  const meta = parseSkillFrontmatter(text)
  const description = (meta.description || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  const name = meta.name && SKILL_NAME_RE.test(meta.name) && !excludedName(meta.name) ? meta.name : undefined
  return { name, description }
}

function walkImmediateSkills(root: string): Array<{ rel: string; path: string }> {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const found: Array<{ rel: string; path: string }> = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const path = join(root, entry.name, 'SKILL.md')
    if (existsSync(path)) found.push({ rel: entry.name, path })
  }
  return found
}

function walkNestedSkills(root: string): Array<{ rel: string; path: string }> {
  const found: Array<{ rel: string; path: string }> = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (entry.isFile() && entry.name === 'SKILL.md') {
        const rel = relative(root, dir)
        if (rel && rel !== '.') found.push({ rel, path: full })
      }
    }
  }
  return found
}

function groupFor(name: string, where: WorkspaceSkill['where']): string {
  const colon = name.indexOf(':')
  if (colon > 0) return name.slice(0, colon).replace(/[-_]/g, ' ').toUpperCase()
  return where === 'user' ? 'USER' : 'WORKSPACE'
}

function addSkill(
  seen: Map<string, WorkspaceSkill>,
  rel: string,
  path: string,
  where: WorkspaceSkill['where'],
): void {
  if (seen.size >= SKILLS_CATALOG_MAX) return
  const fromDir = skillNameFromRel(rel)
  if (!fromDir) return
  const parsed = readSkillFile(path)
  if (!parsed) return
  // Directory name is the loader identity. Frontmatter `name` is a label; if it
  // disagrees with the folder (common on generated mirrors), keep the folder.
  const name = parsed.name && basename(rel) === parsed.name ? parsed.name : fromDir
  if (seen.has(name) || excludedName(name)) return
  seen.set(name, {
    name,
    slash: `/${name}`,
    description: parsed.description,
    group: groupFor(name, where),
    where,
  })
}

export function listWorkspaceSkills(options: {
  workDir?: string
  home?: string
} = {}): WorkspaceSkill[] {
  const workDir = options.workDir ?? resolveProviderWorkDir({ scriptsDir: COS_SCRIPTS_DIR })
  const home = options.home ?? homedir()
  const seen = new Map<string, WorkspaceSkill>()

  if (workDir) {
    const agents = join(workDir, '.agents', 'skills')
    if (existsSync(agents)) {
      for (const skill of walkNestedSkills(agents)) addSkill(seen, skill.rel, skill.path, 'workspace')
    }
    const claude = join(workDir, '.claude', 'skills')
    if (existsSync(claude)) {
      for (const skill of walkImmediateSkills(claude)) addSkill(seen, skill.rel, skill.path, 'workspace')
    }
  }

  const userClaude = join(home, '.claude', 'skills')
  if (existsSync(userClaude)) {
    for (const skill of walkImmediateSkills(userClaude)) addSkill(seen, skill.rel, skill.path, 'user')
  }

  return [...seen.values()].sort((a, b) => {
    if (a.group !== b.group) {
      if (a.group === 'WORKSPACE') return -1
      if (b.group === 'WORKSPACE') return 1
      if (a.group === 'USER') return 1
      if (b.group === 'USER') return -1
      return a.group.localeCompare(b.group)
    }
    return a.name.localeCompare(b.name)
  })
}

export function workspaceSkillsCatalog(options?: {
  workDir?: string
  home?: string
}): WorkspaceSkillsCatalog {
  return {
    schemaVersion: SKILLS_CATALOG_SCHEMA,
    skills: listWorkspaceSkills(options),
  }
}
