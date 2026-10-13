// Install Parakeet through the SHIPPED installer into an isolated COS_DATA_DIR,
// using the bake-off copies as local sources (every byte is still hash-checked).
import { installParakeet, getInstallProgress, parakeetInstalled, parakeetRoot } from '../../server/lib/parakeet.js'
const t0 = Date.now()
const poll = setInterval(() => console.log(JSON.stringify(getInstallProgress())), 5000)
try {
  await installParakeet({ localSources: (process.env.SRC ?? '').split(':').filter(Boolean), cliCandidates: (process.env.CLI ?? '').split(':').filter(Boolean),
    fetchImpl: async (url: string) => { throw new Error(`network fetch attempted: ${url}`) } })
  console.log(JSON.stringify({ ok: true, root: parakeetRoot(), installed: parakeetInstalled(), seconds: (Date.now() - t0) / 1000, progress: getInstallProgress() }))
} catch (e) { console.log(JSON.stringify({ ok: false, error: String(e), progress: getInstallProgress() })); process.exitCode = 1 }
finally { clearInterval(poll) }
