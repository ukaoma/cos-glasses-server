// GET /api/skills — slash commands the glasses agent can run from this Mac.
// Workspace `.agents/skills` (canonical) + `.claude/skills` + `~/.claude/skills`.
// Authenticated by the /api token middleware. Paths never leave the box.

import { Router } from 'express'
import { workspaceSkillsCatalog } from '../lib/workspace-skills.js'

export const skillsRouter = Router()

skillsRouter.get('/skills', (_req, res) => {
  res.set('Cache-Control', 'private, no-store')
  res.json(workspaceSkillsCatalog())
})
