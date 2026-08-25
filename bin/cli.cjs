#!/usr/bin/env node

// COS Glasses Server launcher.
// Runs the bundled server for Even G2 smart glasses. The server ships INSIDE this
// package — there is no clone. Config persists at ~/.cos-glasses/.

const { execFileSync, execSync, spawn } = require('child_process')
const {
  existsSync,
  mkdirSync,
  statSync,
  lstatSync,
  readFileSync,
  copyFileSync,
  unlinkSync,
  renameSync,
  chmodSync,
  writeFileSync,
  statfsSync,
} = require('fs')
const { delimiter, join, resolve } = require('path')
const { homedir } = require('os')

// bin/cli.cjs -> package root is one level up. The server lives at <root>/server.
const PKG_ROOT = resolve(__dirname, '..')
const CONFIG_DIR = join(homedir(), '.cos-glasses')
const PREPARE_ONLY = process.argv.includes('--prepare-only')
const SETUP_TRANSCRIPTION = process.argv.includes('--setup-transcription')
const SETUP_SPEAKER_MODEL = process.argv.includes('--setup-speaker-model')
function optionValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const TRANSCRIPTION_TIER_RAW = optionValue('--transcription-tier')
const TRANSCRIPTION_TIER = TRANSCRIPTION_TIER_RAW?.trim().toLowerCase() || 'balanced'
if (process.argv.includes('--transcription-tier') && !TRANSCRIPTION_TIER_RAW) {
  console.error('Missing value for --transcription-tier. Use balanced or max.')
  process.exit(64)
}
if (TRANSCRIPTION_TIER_RAW && !['balanced', 'max'].includes(TRANSCRIPTION_TIER)) {
  console.error(`Invalid --transcription-tier "${TRANSCRIPTION_TIER_RAW}". Use balanced or max.`)
  process.exit(64)
}

// Record where the user ran `npx @gotcos/glasses-server` from. The server spawns
// with cwd = PKG_ROOT (the npx cache), so without this the user's Starter-Kit COS
// (AGENTS.md / CLAUDE.md / .cos/) in their launch folder would never be seen.
// Chat spawns of claude/codex use this dir when it contains a COS brain.
if (!process.env.COS_LAUNCH_DIR) process.env.COS_LAUNCH_DIR = process.cwd()

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`

/**
 * The ~26 MB voiceprint model, fetched on request.
 *
 * WHY THIS EXISTS. Named per-speaker diarization needs this model, and it is
 * deliberately NOT in the npm tarball -- 26 MB on every install for a feature
 * most users never turn on. The README documented a manual bolt-on ("put the
 * .onnx there"), which left a managed install with no way to obtain it: the
 * server then degrades silently to amplitude fallback (wearer vs Ext), so voice
 * training appears to run and never learns anything. A beta user hit exactly
 * that on 2026-08-25 and reported it as "voice training didn't work".
 *
 * Installed to ~/.cos-glasses/models/ deliberately. Anything inside the package
 * is destroyed by the next update; the data home survives.
 *
 * The SHA-256 below was verified against the model on a working install and
 * matched byte for byte. A download that does not match is DELETED, not
 * installed -- this file is handed to a native loader.
 */
const SPEAKER_MODEL = {
  filename: '3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx',
  sha256: 'c59158379255ad66e161679cca6af8d52d51e389e3224ab7d7a7baae295c2db5',
  bytes: 26485263,
}

function sha256File(path) {
  const { createHash } = require('crypto')
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function setupSpeakerModel() {
  const modelsDir = join(CONFIG_DIR, 'models')
  const dest = join(modelsDir, SPEAKER_MODEL.filename)

  if (existsSync(dest)) {
    const have = sha256File(dest)
    if (have === SPEAKER_MODEL.sha256) {
      console.log('  Voiceprint model already installed and verified.')
      console.log(`  ${dest}`)
      return 0
    }
    console.log('  A file is present but does not match the expected checksum.')
    console.log(`  Replacing it. (found ${have.slice(0, 16)}...)`)
    try { unlinkSync(dest) } catch {}
  }

  mkdirSync(modelsDir, { recursive: true })
  const partial = `${dest}.partial`
  console.log('  Downloading the voiceprint model (~26 MB)...')

  // SYNCHRONOUS on purpose. bin/cli.cjs is CJS with no top-level await, so an
  // async download does not block the rest of this file -- the first version of
  // this command fell straight through into normal server startup and installed
  // nothing. Same curl idiom the whisper model download already uses.
  try {
    execFileSync('curl', [
      '-fL',
      '--retry', '5',
      '--retry-all-errors',
      '--retry-delay', '2',
      '--connect-timeout', '30',
      '--progress-bar',
      SPEAKER_MODEL.url,
      '-o', partial,
    ], { stdio: 'inherit', timeout: 10 * 60_000 })
  } catch (err) {
    try { if (existsSync(partial)) unlinkSync(partial) } catch {}
    console.error(`  Download failed: ${err && err.message ? err.message : err}`)
    return 1
  }

  // VERIFY BEFORE INSTALLING. Never rename unverified bytes into the path a
  // native model loader reads from.
  const got = sha256File(partial)
  if (got !== SPEAKER_MODEL.sha256) {
    try { unlinkSync(partial) } catch {}
    console.error('  Checksum mismatch - refusing to install.')
    console.error(`    expected ${SPEAKER_MODEL.sha256}`)
    console.error(`    got      ${got}`)
    return 1
  }

  renameSync(partial, dest)
  console.log('  Installed and verified:')
  console.log(`  ${dest}`)
  console.log('')
  console.log('  Restart the server for it to take effect.')
  console.log('  Then check /api/health -> speaker_id: it should read "active".')
  return 0
}

if (SETUP_SPEAKER_MODEL) {
  console.log('')
  console.log(bold('  COS Glasses - voiceprint model'))
  console.log('')
  process.exit(setupSpeakerModel())
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('')
  console.log(bold('  COS Glasses Server'))
  console.log('')
  console.log('  Usage:')
  console.log('    npx --yes @gotcos/glasses-server@latest')
  console.log('    npx --yes @gotcos/glasses-server@latest --setup-transcription')
  console.log('    npx --yes @gotcos/glasses-server@latest --setup-transcription --transcription-tier balanced|max')
  console.log('    npx --yes @gotcos/glasses-server@latest --setup-speaker-model')
  console.log('    npx --yes @gotcos/glasses-server@latest --prepare-only')
  console.log('')
  console.log('  Requirements:')
  console.log('    - Node.js 20.11+')
  console.log('    - Claude Code CLI, Codex CLI, or Cursor Agent CLI')
  console.log('    - Even G2 smart glasses + the COS Glasses app (Even Hub)')
  console.log('    - Optional local Kokoro voice: Apple silicon + Python 3.11 or 3.12')
  console.log('')
  console.log('  No API key is needed for chat — it runs through your installed CLI.')
  console.log('  Config persists at ~/.cos-glasses/.env')
  console.log('')
  console.log('  Setup guide: https://www.gotcos.com/wizard/')
  console.log('')
  process.exit(0)
}

console.log('')
console.log(bold('  COS Glasses Server'))
console.log(dim('  AI heads-up display for Even G2 smart glasses'))
console.log('')

// Step 1: Node version. The server uses import.meta.dirname (Node 20.11+ / 21.2+).
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map((n) => parseInt(n, 10))
if (nodeMajor < 20 || (nodeMajor === 20 && nodeMinor < 11)) {
  console.log(red('  ✗ Node.js 20.11+ required') + ` (you have ${process.versions.node})`)
  console.log('    Update: https://nodejs.org')
  process.exit(1)
}
console.log(green('  ✓') + ` Node.js ${process.versions.node}`)

// Step 2: agent CLI detection — at least one supported, signed-in CLI is required.
function getCliVersion(command, versionArg = '--version') {
  try {
    return execSync(`${command} ${versionArg} 2>&1`, { shell: '/bin/sh', stdio: 'pipe', timeout: 5000 }).toString().trim()
  } catch {
    return null
  }
}
function compatibleKokoroPython() {
  const configured = process.env.COS_TTS_BOOTSTRAP_PYTHON?.trim()
  const candidates = configured ? [configured] : ['python3.12', 'python3.11', 'python3']
  for (const command of candidates) {
    let version = null
    try {
      version = execFileSync(command, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim()
    } catch { /* try the next interpreter */ }
    const match = version?.match(/^Python\s+(\d+)\.(\d+)/i)
    if (match && Number(match[1]) === 3 && [11, 12].includes(Number(match[2]))) {
      return { command, version }
    }
  }
  return null
}
function normalizeCodexVersion(raw) {
  if (!raw) return 'available'
  const line = raw.split('\n').map((s) => s.trim()).find((s) => /^codex(?:-cli)?\s+/i.test(s)) || raw.split('\n')[0].trim()
  return line.replace(/^codex(?:-cli)?\s*/i, '') || line
}
function commandResult(command) {
  try {
    return {
      ok: true,
      output: execSync(`${command} 2>&1`, { shell: '/bin/sh', stdio: 'pipe', timeout: 5000 }).toString().trim(),
    }
  } catch (err) {
    return {
      ok: false,
      output: (err.stdout?.toString() || err.stderr?.toString() || '').trim(),
    }
  }
}
function claudeAuthState() {
  const result = commandResult('claude auth status --json')
  try {
    const parsed = JSON.parse(result.output)
    if (parsed.loggedIn === true) return 'ready'
    if (parsed.loggedIn === false) return 'signed-out'
  } catch { /* older CLIs may not support JSON status */ }
  if (/not logged in|logged out|sign[ -]?in required/i.test(result.output)) return 'signed-out'
  return 'unknown'
}
function codexAuthState() {
  const result = commandResult('codex login status')
  if (/logged in/i.test(result.output) && !/not logged in/i.test(result.output)) return 'ready'
  if (/not logged in|logged out|sign[ -]?in required/i.test(result.output)) return 'signed-out'
  return 'unknown'
}
function resolveCursorAgentBinary() {
  const configured = process.env.COS_CURSOR_AGENT_BIN?.trim()
  if (configured && existsSync(configured)) return configured
  for (const entry of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const candidate = resolve(entry, 'agent')
    if (existsSync(candidate)) return candidate
  }
  const homeLocal = resolve(homedir(), '.local', 'bin', 'agent')
  return existsSync(homeLocal) ? homeLocal : null
}
function cursorCliState() {
  const binary = resolveCursorAgentBinary()
  if (!binary) return { binary: null, version: null, auth: null }

  let version = 'available'
  try {
    const about = execFileSync(binary, ['about'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim()
    const versionLine = about.split('\n').map((line) => line.trim()).find((line) => /CLI Version|cursor|agent/i.test(line))
    if (versionLine) version = versionLine
  } catch { /* `agent models` below is the readiness proof */ }

  try {
    const models = execFileSync(binary, ['models'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 7000,
    })
    const grokHighFast = /cursor-grok-\d+(?:\.\d+)*-high-fast/.test(models)
    return {
      binary,
      version,
      auth: models.includes('composer-2.5-fast') && grokHighFast ? 'ready' : 'models-unresolved',
    }
  } catch (err) {
    const output = `${err.stdout?.toString() || ''}\n${err.stderr?.toString() || ''}`
    return {
      binary,
      version,
      auth: /not logged in|logged out|sign[ -]?in required|authenticate/i.test(output) ? 'signed-out' : 'unknown',
    }
  }
}
const claudeVersion = getCliVersion('claude')
const codexVersion = getCliVersion('codex')
const claudeAuth = claudeVersion ? claudeAuthState() : null
const codexAuth = codexVersion ? codexAuthState() : null
const cursor = cursorCliState()
if (claudeVersion) {
  if (claudeAuth === 'signed-out') {
    console.log(yellow('  ⚠') + ` Claude Code ${claudeVersion} installed — sign-in required`)
    console.log('    Run: ' + bold('claude auth login'))
  } else if (claudeAuth === 'unknown') {
    console.log(yellow('  ⚠') + ` Claude Code ${claudeVersion} installed — sign-in status unavailable`)
    console.log('    Verify: ' + bold('claude auth status'))
  } else {
    console.log(green('  ✓') + ` Claude Code ${claudeVersion} ` + dim('(Opus / Fable / Sonnet)'))
  }
} else {
  console.log(yellow('  ⚠') + ' Claude Code CLI not found ' + dim('— Opus/Fable/Sonnet unavailable'))
  console.log('    Claude Desktop does not install the terminal CLI.')
  console.log('    Install (no sudo): ' + bold('npm install -g @anthropic-ai/claude-code'))
  console.log('    Then run:          ' + bold('claude') + ' and finish sign-in')
}
if (codexVersion) {
  if (codexAuth === 'signed-out') {
    console.log(yellow('  ⚠') + ` Codex CLI ${normalizeCodexVersion(codexVersion)} installed — sign-in required`)
    console.log('    Run: ' + bold('codex login'))
  } else if (codexAuth === 'unknown') {
    console.log(yellow('  ⚠') + ` Codex CLI ${normalizeCodexVersion(codexVersion)} installed — sign-in status unavailable`)
    console.log('    Verify: ' + bold('codex login status'))
  } else {
    console.log(green('  ✓') + ` Codex CLI ${normalizeCodexVersion(codexVersion)} ` + dim('(GPT Frontier / Balanced)'))
  }
} else {
  console.log(yellow('  ⚠') + ' Codex CLI not found ' + dim('— GPT Frontier/Balanced unavailable'))
}
if (cursor.binary) {
  if (cursor.auth === 'ready') {
    console.log(green('  ✓') + ` Cursor Agent ${cursor.version} ` + dim('(Composer 2.5 / newest Grok high-fast)'))
  } else if (cursor.auth === 'signed-out') {
    console.log(yellow('  ⚠') + ` Cursor Agent ${cursor.version} installed — sign-in required`)
    console.log('    Run: ' + bold('agent login'))
  } else if (cursor.auth === 'models-unresolved') {
    console.log(yellow('  ⚠') + ` Cursor Agent ${cursor.version} installed — required models unresolved`)
    console.log('    Verify: ' + bold('agent models') + ' includes Composer 2.5 Fast and a cursor-grok-*-high-fast id')
  } else {
    console.log(yellow('  ⚠') + ` Cursor Agent ${cursor.version} installed — readiness unavailable`)
    console.log('    Verify: ' + bold('agent models'))
  }
} else {
  console.log(yellow('  ⚠') + ' Cursor Agent CLI not found ' + dim('— Composer/Grok unavailable'))
}
const hasUsableAgent = (claudeVersion && claudeAuth !== 'signed-out')
  || (codexVersion && codexAuth !== 'signed-out')
  || cursor.auth === 'ready'
if (!hasUsableAgent) {
  console.log('')
  console.log(red('  ✗ No signed-in agent CLI is ready'))
  console.log('    Claude Desktop alone is not enough; COS needs a signed-in terminal CLI.')
  console.log('    Install Claude Code (no sudo): ' + bold('npm install -g @anthropic-ai/claude-code'))
  console.log('    Then run:                       ' + bold('claude auth login'))
  console.log('    or Codex CLI:        ' + bold('https://developers.openai.com/codex/') + ' then ' + bold('codex login'))
  console.log('    or Cursor Agent CLI: run ' + bold('agent login') + ', then verify ' + bold('agent models'))
  console.log('    Setup help:          ' + bold('https://www.gotcos.com/wizard/'))
  console.log('')
  process.exit(1)
}

// Step 3: resolve the dependency npm already installed. With `npx`, dependency
// packages are siblings in npm's temporary node_modules tree rather than under
// PKG_ROOT/node_modules. Running a second `npm install` from inside that cache
// is both unnecessary and unsafe: a prior sudo-based npm install can make the
// shared cache root-owned and turn an otherwise valid first launch into EACCES.
let tsxImport
try {
  tsxImport = require.resolve('tsx/esm', { paths: [PKG_ROOT] })
} catch {
  console.log('')
  console.log(red('  ✗ COS package dependencies are incomplete'))
  console.log('    Do not use sudo. Retry with an isolated user-owned npm cache:')
  console.log('    ' + bold('npm_config_cache="$HOME/.cos-glasses/npm-cache" npx --yes @gotcos/glasses-server@latest'))
  console.log('    Source installs only: run ' + bold('npm install') + ' in the cloned repository.')
  process.exit(1)
}

// Controller probes do not mutate COS state. They verify Node, agent auth,
// and the packaged runtime without creating COS config, downloading Kokoro
// models, installing Kokoro packages, changing COS permissions, or starting a
// listener. An invoked agent CLI may still maintain its own user cache.
if (PREPARE_ONLY && !SETUP_TRANSCRIPTION) {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    const python = compatibleKokoroPython()
    if (python) {
      console.log(green('  ✓') + ` Local voice Python ${python.version.replace(/^Python\s+/i, '')}`)
    } else {
      console.log(yellow('  ⚠') + ' Local Kokoro voice needs Python 3.11 or 3.12')
      console.log('    Install: ' + bold('brew install python@3.12 ffmpeg espeak-ng'))
    }
  }
  console.log('')
  console.log(green('  ✓ Non-mutating readiness check complete'))
  console.log('    This checks prerequisites only; normal server start provisions optional models.')
  console.log('')
  process.exit(0)
}

// Step 4: persistent config at ~/.cos-glasses/ (survives npx cache churn)
function securePrivateDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stats = lstatSync(dir)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${dir} must be a private directory, not a symlink`)
  }
  chmodSync(dir, 0o700)
}

function securePrivateFile(file) {
  if (!existsSync(file)) return
  const stats = lstatSync(file)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${file} must be a regular file, not a symlink`)
  }
  chmodSync(file, 0o600)
}

try {
  securePrivateDirectory(CONFIG_DIR)
} catch (err) {
  console.log('')
  console.log(red('  ✗ COS config directory is unsafe'))
  console.log(`    ${err.message}`)
  console.log('    Move it aside and rerun COS; do not use sudo or broad ownership changes.')
  process.exit(1)
}
const ENV_FILE = join(CONFIG_DIR, '.env')
const ENV_EXAMPLE = join(PKG_ROOT, '.env.example')
if (!existsSync(ENV_FILE) && existsSync(ENV_EXAMPLE)) {
  copyFileSync(ENV_EXAMPLE, ENV_FILE)
  chmodSync(ENV_FILE, 0o600)
  console.log(green('  ✓') + ` Created config at ${dim(ENV_FILE)}`)
}
if (existsSync(ENV_FILE)) {
  try {
    securePrivateFile(ENV_FILE)
  } catch (err) {
    console.log('')
    console.log(red('  ✗ COS config file is unsafe'))
    console.log(`    ${err.message}`)
    process.exit(1)
  }
  try {
    for (const line of readFileSync(ENV_FILE, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
  } catch { /* config is optional */ }
}

function upsertEnvValue(file, key, value) {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const lines = current.split(/\r?\n/)
  const prefix = `${key}=`
  let replaced = false
  const next = lines.map((line) => {
    if (line.trimStart().startsWith('#')) return line
    if (!line.startsWith(prefix)) return line
    replaced = true
    return `${prefix}${value}`
  })
  if (!replaced) {
    if (next.length && next.at(-1) !== '') next.push('')
    next.push(`${prefix}${value}`)
  }
  writeFileSync(file, next.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 })
  chmodSync(file, 0o600)
}

if (SETUP_TRANSCRIPTION) {
  const previewModel = TRANSCRIPTION_TIER === 'max' ? 'turbo' : 'small.en'
  const commitModel = TRANSCRIPTION_TIER === 'max' ? 'large-v3' : 'turbo'
  upsertEnvValue(ENV_FILE, 'COS_WHISPER_TRANSCRIPTION_TIER', TRANSCRIPTION_TIER)
  upsertEnvValue(ENV_FILE, 'COS_WHISPER_PREVIEW_MODEL', previewModel)
  upsertEnvValue(ENV_FILE, 'COS_WHISPER_COMMIT_MODEL', commitModel)
  process.env.COS_WHISPER_TRANSCRIPTION_TIER = TRANSCRIPTION_TIER
  process.env.COS_WHISPER_PREVIEW_MODEL = previewModel
  process.env.COS_WHISPER_COMMIT_MODEL = commitModel
  const laneSummary = TRANSCRIPTION_TIER === 'max'
    ? 'Turbo preview · Large-v3 commit · Large-v3 HQ'
    : 'Small.en preview · Turbo commit · Large-v3 HQ'
  console.log(green('  ✓') + ` ${TRANSCRIPTION_TIER === 'max' ? 'Max' : 'Balanced'} transcription selected ` + dim(`— ${laneSummary}`))
}
// Persistent profile (identity + transcription vocabulary)
const PROFILE_FILE = join(CONFIG_DIR, '.cos-profile.json')
const PROFILE_EXAMPLE = join(PKG_ROOT, '.cos-profile.example.json')
if (!existsSync(PROFILE_FILE) && existsSync(PROFILE_EXAMPLE)) {
  copyFileSync(PROFILE_EXAMPLE, PROFILE_FILE)
  chmodSync(PROFILE_FILE, 0o600)
}
try {
  securePrivateFile(PROFILE_FILE)
} catch (err) {
  console.log('')
  console.log(red('  ✗ COS profile is unsafe'))
  console.log(`    ${err.message}`)
  process.exit(1)
}
if (!process.env.COS_PROFILE_PATH) process.env.COS_PROFILE_PATH = PROFILE_FILE

// Step 5: local Whisper detection + model download. Voice stays local-only by
// default; cloud fallback requires an explicit flag plus a configured key.
const WHISPER_KNOWN_PATHS = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli']
const WHISPER_SERVER_KNOWN_PATHS = ['/opt/homebrew/bin/whisper-server', '/usr/local/bin/whisper-server']
const WHISPER_MODEL_DIR = join(homedir(), '.local/share/whisper-models')
const WHISPER_MODEL_PATH = join(WHISPER_MODEL_DIR, 'ggml-large-v3-turbo.bin')
const WHISPER_MODEL_PARTIAL = WHISPER_MODEL_PATH + '.partial'
const WHISPER_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin'
const WHISPER_MODEL_MIN_BYTES = 800_000_000
const WHISPER_SMALL_MODEL_PATH = join(WHISPER_MODEL_DIR, 'ggml-small.en.bin')
const WHISPER_SMALL_MODEL_PARTIAL = WHISPER_SMALL_MODEL_PATH + '.partial'
const WHISPER_SMALL_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin'
const WHISPER_SMALL_MODEL_MIN_BYTES = 400_000_000
const WHISPER_LARGE_MODEL_PATH = join(WHISPER_MODEL_DIR, 'ggml-large-v3.bin')
const WHISPER_LARGE_MODEL_PARTIAL = WHISPER_LARGE_MODEL_PATH + '.partial'
const WHISPER_LARGE_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin'
const WHISPER_LARGE_MODEL_MIN_BYTES = 2_800_000_000
const WHISPER_MODEL_EXPECTED_BYTES = 1_624_555_275
const WHISPER_SMALL_MODEL_EXPECTED_BYTES = 487_614_201
const WHISPER_LARGE_MODEL_EXPECTED_BYTES = 3_095_033_483
function findWhisperCli() {
  for (const p of WHISPER_KNOWN_PATHS) { if (existsSync(p)) return p }
  try {
    const found = execSync('command -v whisper-cli 2>/dev/null', { shell: '/bin/sh', stdio: 'pipe', timeout: 2000 }).toString().trim()
    return found || null
  } catch {
    return null
  }
}
function findWhisperServer() {
  for (const p of WHISPER_SERVER_KNOWN_PATHS) { if (existsSync(p)) return p }
  try {
    const found = execSync('command -v whisper-server 2>/dev/null', { shell: '/bin/sh', stdio: 'pipe', timeout: 2000 }).toString().trim()
    return found || null
  } catch {
    return null
  }
}
function isValidWhisperModel(p, minBytes = WHISPER_MODEL_MIN_BYTES) {
  if (!existsSync(p)) return false
  try { return statSync(p).size >= minBytes } catch { return false }
}
function downloadWhisperModel({ url, destination, partial, expectedBytes, timeoutMs }) {
  mkdirSync(WHISPER_MODEL_DIR, { recursive: true })
  const partialBytes = existsSync(partial) ? statSync(partial).size : 0
  execFileSync('curl', [
    '-fL',
    '--retry', '8',
    '--retry-all-errors',
    '--retry-delay', '2',
    '--connect-timeout', '30',
    '--continue-at', '-',
    '--progress-bar',
    url,
    '-o', partial,
  ], { stdio: 'inherit', timeout: timeoutMs })
  const stats = statSync(partial)
  if (stats.size !== expectedBytes) {
    throw new Error(`Downloaded file size mismatch: expected ${expectedBytes}, received ${stats.size} bytes`)
  }
  renameSync(partial, destination)
  return { resumed: partialBytes > 0 }
}
const whisperCliPath = findWhisperCli()
const whisperServerPath = findWhisperServer()
const hasValidModel = isValidWhisperModel(WHISPER_MODEL_PATH)
const transcriptionSetupFailures = []

if (SETUP_TRANSCRIPTION && (!whisperCliPath || !whisperServerPath)) {
  console.log('')
  console.log(red('  ✗ Transcription setup needs whisper.cpp'))
  console.log('    Install it first: ' + bold('brew install whisper-cpp'))
  console.log('    Then rerun this setup command. No model download was started.')
  console.log('')
  process.exit(1)
}

if (SETUP_TRANSCRIPTION && process.env.SKIP_WHISPER_DOWNLOAD !== '1') {
  mkdirSync(WHISPER_MODEL_DIR, { recursive: true })
  const targets = [
    [WHISPER_MODEL_PATH, WHISPER_MODEL_PARTIAL, WHISPER_MODEL_MIN_BYTES, WHISPER_MODEL_EXPECTED_BYTES],
    ...(TRANSCRIPTION_TIER === 'balanced'
      ? [[WHISPER_SMALL_MODEL_PATH, WHISPER_SMALL_MODEL_PARTIAL, WHISPER_SMALL_MODEL_MIN_BYTES, WHISPER_SMALL_MODEL_EXPECTED_BYTES]]
      : []),
    [WHISPER_LARGE_MODEL_PATH, WHISPER_LARGE_MODEL_PARTIAL, WHISPER_LARGE_MODEL_MIN_BYTES, WHISPER_LARGE_MODEL_EXPECTED_BYTES],
  ]
  const missingBytes = targets.reduce((sum, [path, , minimum, expected]) =>
    sum + (isValidWhisperModel(path, minimum) ? 0 : expected), 0)
  const reclaimableBytes = targets.reduce((sum, [, partial]) => {
    try { return sum + statSync(partial).size } catch { return sum }
  }, 0)
  const fsStats = statfsSync(WHISPER_MODEL_DIR)
  const availableBytes = (fsStats.bavail * fsStats.bsize) + reclaimableBytes
  const safetyMarginBytes = 750_000_000
  if (missingBytes > 0 && availableBytes < missingBytes + safetyMarginBytes) {
    const requiredGB = ((missingBytes + safetyMarginBytes) / 1_000_000_000).toFixed(1)
    const availableGB = (availableBytes / 1_000_000_000).toFixed(1)
    console.log('')
    console.log(red('  ✗ Not enough free disk space for transcription setup'))
    console.log(`    Need about ${requiredGB} GB; ${availableGB} GB is available after reusable partial downloads.`)
    console.log('    Free space, then rerun this setup command. Existing models were not removed.')
    console.log('')
    process.exit(1)
  }
}
let localVoiceReady = Boolean(whisperCliPath && hasValidModel)
if (whisperCliPath && hasValidModel) {
  console.log(green('  ✓') + ' whisper.cpp + model ready ' + dim('— voice = local (FREE)'))
} else if (whisperCliPath && !hasValidModel) {
  if (existsSync(WHISPER_MODEL_PATH)) { try { unlinkSync(WHISPER_MODEL_PATH) } catch {} }
  console.log(yellow('  ⚠') + ' whisper.cpp installed but model missing')
  console.log('    ' + dim('Downloading ggml-large-v3-turbo (~1.5 GB).'))
  console.log('    ' + dim('Skip: SKIP_WHISPER_DOWNLOAD=1 npx --yes @gotcos/glasses-server@latest'))
  if (process.env.SKIP_WHISPER_DOWNLOAD === '1') {
    console.log(yellow('  ⚠') + ' SKIP_WHISPER_DOWNLOAD=1 — local voice unavailable')
  } else {
    try {
      downloadWhisperModel({
        url: WHISPER_MODEL_URL,
        destination: WHISPER_MODEL_PATH,
        partial: WHISPER_MODEL_PARTIAL,
        expectedBytes: WHISPER_MODEL_EXPECTED_BYTES,
        timeoutMs: 3_600_000,
      })
      localVoiceReady = true
      console.log(green('  ✓') + ' Model downloaded ' + dim('— voice = local (FREE)'))
    } catch (err) {
      console.log(red('  ✗') + ' Model download failed ' + dim('— local voice unavailable'))
      console.log('    ' + dim('Error: ' + (err.message || err).toString().slice(0, 120)))
      console.log('    ' + dim('Partial download retained; rerun setup to resume it.'))
      if (SETUP_TRANSCRIPTION) transcriptionSetupFailures.push('Large-v3-Turbo commit model')
    }
  }
} else {
  console.log(yellow('  ⚠') + ' whisper.cpp not installed ' + dim('— local voice unavailable'))
  console.log('    Free local voice: ' + bold('brew install whisper-cpp') + dim('  (no Homebrew? https://brew.sh)'))
}
if (process.env.COS_OPENAI_WHISPER_FALLBACK === '1') {
  console.log(yellow('  ⚠') + ' Explicit OpenAI Whisper fallback requested ' + dim('— activates only if a key resolves; see /api/health'))
} else {
  console.log(green('  ✓') + ' Transcription policy: local-only ' + dim('— a key alone never uploads audio'))
}

const previewChoice = (process.env.COS_WHISPER_PREVIEW_MODEL || process.env.COS_WHISPER_REALTIME_MODEL || 'auto').trim().toLowerCase()
const wantsSmallPreview = ['small', 'small.en', 'ggml-small.en.bin'].includes(previewChoice)
if (whisperCliPath && wantsSmallPreview) {
  if (isValidWhisperModel(WHISPER_SMALL_MODEL_PATH, WHISPER_SMALL_MODEL_MIN_BYTES)) {
    console.log(green('  ✓') + ' Small.en preview model ready ' + dim('— Turbo remains authoritative'))
  } else {
    if (existsSync(WHISPER_SMALL_MODEL_PATH)) { try { unlinkSync(WHISPER_SMALL_MODEL_PATH) } catch {} }
    console.log(yellow('  ⚠') + ' Adaptive preview model missing')
    console.log('    ' + dim('Downloading ggml-small.en (~466 MB).'))
    if (process.env.SKIP_WHISPER_DOWNLOAD === '1') {
      console.log(yellow('  ⚠') + ' SKIP_WHISPER_DOWNLOAD=1 — previews use Turbo until Small.en is provisioned')
    } else {
      try {
        downloadWhisperModel({
          url: WHISPER_SMALL_MODEL_URL,
          destination: WHISPER_SMALL_MODEL_PATH,
          partial: WHISPER_SMALL_MODEL_PARTIAL,
          expectedBytes: WHISPER_SMALL_MODEL_EXPECTED_BYTES,
          timeoutMs: 3_600_000,
        })
        console.log(green('  ✓') + ' Small.en preview model downloaded ' + dim('— Turbo commit unchanged'))
      } catch (err) {
        console.log(red('  ✗') + ' Small.en download failed ' + dim('— previews safely fall back to Turbo'))
        console.log('    ' + dim('Error: ' + (err.message || err).toString().slice(0, 120)))
        console.log('    ' + dim('Partial download retained; rerun setup to resume it.'))
        transcriptionSetupFailures.push('Small.en preview model')
      }
    }
  }
}

if (whisperCliPath && SETUP_TRANSCRIPTION) {
  if (isValidWhisperModel(WHISPER_LARGE_MODEL_PATH, WHISPER_LARGE_MODEL_MIN_BYTES)) {
    const largeRole = TRANSCRIPTION_TIER === 'max'
      ? 'live preview + commit and saved-meeting polish'
      : 'saved meetings use full polish'
    console.log(green('  ✓') + ' Large-v3 model ready ' + dim(`— ${largeRole}`))
  } else {
    if (existsSync(WHISPER_LARGE_MODEL_PATH)) { try { unlinkSync(WHISPER_LARGE_MODEL_PATH) } catch {} }
    console.log(yellow('  ⚠') + ' Large-v3 model missing')
    console.log('    ' + dim('Downloading ggml-large-v3 (~3.1 GB).'))
    if (process.env.SKIP_WHISPER_DOWNLOAD === '1') {
      console.log(yellow('  ⚠') + ' SKIP_WHISPER_DOWNLOAD=1 — HQ safely reports unavailable and live Turbo continues')
    } else {
      try {
        downloadWhisperModel({
          url: WHISPER_LARGE_MODEL_URL,
          destination: WHISPER_LARGE_MODEL_PATH,
          partial: WHISPER_LARGE_MODEL_PARTIAL,
          expectedBytes: WHISPER_LARGE_MODEL_EXPECTED_BYTES,
          timeoutMs: 7_200_000,
        })
        console.log(green('  ✓') + ' Large-v3 model downloaded')
      } catch (err) {
        console.log(red('  ✗') + ' Large-v3 download failed ' + dim('— live Turbo remains available'))
        console.log('    ' + dim('Error: ' + (err.message || err).toString().slice(0, 120)))
        console.log('    ' + dim('Partial download retained; rerun setup to resume it.'))
        transcriptionSetupFailures.push(TRANSCRIPTION_TIER === 'max' ? 'Large-v3 Max/HQ model' : 'Large-v3 HQ model')
      }
    }
  }
}

if (PREPARE_ONLY && SETUP_TRANSCRIPTION) {
  console.log('')
  if (transcriptionSetupFailures.length > 0) {
    console.log(red('  ✗ Transcription setup incomplete'))
    console.log('    Missing: ' + transcriptionSetupFailures.join(', '))
    console.log('    Rerun this command; retained downloads resume from the last byte received.')
    console.log('')
    process.exit(1)
  }
  console.log(green('  ✓ Transcription setup complete'))
  console.log('    Return to COS Control and Restart, install, or update the managed server.')
  console.log('')
  process.exit(0)
}

// Step 6: image capability — ffmpeg validates, strips metadata, normalizes,
// and builds the exact 288x144 G2 variant. It is optional so text/voice remain
// useful on a minimal install, but the launcher should make the gap visible.
const ffmpegVersion = getCliVersion('ffmpeg', '-version')
if (ffmpegVersion) {
  const firstLine = ffmpegVersion.split('\n')[0].trim()
  console.log(green('  ✓') + ` ${firstLine} ` + dim('— phone + lens images ready'))
} else {
  console.log(yellow('  ⚠') + ' ffmpeg not installed ' + dim('— phone and answer images disabled'))
  console.log('    Enable photos: ' + bold('brew install ffmpeg') + dim('  (text + voice still work)'))
}

// Step 7: phone reachability — the glasses' phone app must reach this server.
if (!process.env.BIND_HOST) {
  process.env.BIND_HOST = '0.0.0.0'
  console.log(yellow('  ⚠') + ' BIND_HOST not set — defaulting to 0.0.0.0 so your phone can reach the server')
}

// Step 8: start the bundled server
try {
  const ld = process.env.COS_LAUNCH_DIR
  if (ld && (existsSync(join(ld, '.cos', 'manifest.json')) || existsSync(join(ld, 'AGENTS.md')) || existsSync(join(ld, 'CLAUDE.md')))) {
    console.log(green('  ✓') + ` COS detected in ${dim(ld)} — glasses chat will load its brain`)
  }
} catch { /* detection is best-effort */ }
if (!localVoiceReady) {
  console.log('')
  console.log(yellow('  ⚠ LOCAL VOICE NOT READY'))
  console.log('    Text chat can start. Under the default local-only policy, voice prompts remain unavailable.')
  console.log('    Install: ' + bold('brew install whisper-cpp'))
  console.log('    Then stop COS with Ctrl-C and rerun: ' + bold('npx --yes @gotcos/glasses-server@latest'))
}
console.log('')
console.log(dim('  Starting server...'))
console.log('')
const serverProc = spawn(
  process.execPath,
  ['--import', tsxImport, 'server/index.ts'],
  { cwd: PKG_ROOT, stdio: 'inherit', env: { ...process.env } }
)
serverProc.on('error', (err) => {
  console.error(red(`  Server failed to start: ${err.message}`))
  process.exit(1)
})
serverProc.on('exit', (code) => process.exit(code ?? 0))
process.on('SIGINT', () => serverProc.kill('SIGINT'))
process.on('SIGTERM', () => serverProc.kill('SIGTERM'))
