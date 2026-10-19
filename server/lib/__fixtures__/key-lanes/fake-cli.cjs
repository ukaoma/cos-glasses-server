#!/usr/bin/env node
// K0-G fake provider CLI: stands in for `claude`, `codex` and `agent` (Cursor) while the
// key-lanes-off scenario drives a scratch server. Invoked as `fake-cli.cjs <name> ...argv`
// through a per-name wrapper the scenario writes on PATH and in COS_*_BIN.
//
// It records, per spawn: argv, cwd, the env NAMES (never values), a SHA-256 of every
// credential-shaped value (so a K1 change that hands a child a different credential shows
// up without the value ever being written), and a SHA-256 of what arrived on stdin. Then it
// answers with the smallest stream each bridge accepts, so the turn completes.
//
// Never makes a network call. Never reads a file outside its own record directory.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const [, , name, ...argv] = process.argv  // name is spliced in by the per-name wrapper
const logDir = process.env.KL_FAKE_CLI_LOG
const sha = s => crypto.createHash('sha256').update(s).digest('hex')
const CREDENTIAL_NAME = /(KEY|TOKEN|SECRET|AUTH|PASSWORD|CREDENTIAL)/i

function nextSeq() {
  const dir = path.join(logDir, 'seq')
  fs.mkdirSync(dir, { recursive: true })
  for (let n = 1; n < 100000; n++) {
    try { fs.closeSync(fs.openSync(path.join(dir, String(n)), 'wx')); return n } catch { /* taken */ }
  }
  return 0
}

const seq = logDir ? nextSeq() : 0
const id12 = String(seq).padStart(12, '0')
const sessionId = `00000000-0000-4000-8000-${id12}`

function record(stdinText, mode) {
  if (!logDir) return
  const envNames = Object.keys(process.env).filter(k => k !== 'KL_FAKE_CLI_LOG').sort()
  const credentialHashes = {}
  for (const k of envNames) if (CREDENTIAL_NAME.test(k)) credentialHashes[k] = sha(String(process.env[k]))
  const rec = {
    name,
    argv,
    cwd: process.cwd(),
    envNames,
    credentialHashes,
    stdinSha256: stdinText === null ? null : sha(stdinText),
    stdinBytes: stdinText === null ? null : Buffer.byteLength(stdinText),
    // QA G1: the text itself, so the scenario can hash it AFTER normalizing run-time values.
    stdinText,
    stdinMode: mode,
  }
  fs.writeFileSync(path.join(logDir, `spawn-${String(seq).padStart(6, '0')}.json`), JSON.stringify(rec))
}

const has = flag => argv.includes(flag)
const valueOf = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
const out = obj => process.stdout.write(`${JSON.stringify(obj)}\n`)

const CLAUDE_HELP = [
  'Usage: claude [options] [command] [prompt]',
  'Options:',
  '  -p, --print', '  --model <model>', '  --effort <level>', '  --output-format <format>',
  '  --input-format <format>', '  --replay-user-messages', '  --include-partial-messages',
  '  --verbose', '  --resume <id>', '  --session-id <uuid>', '  --name <name>',
  '  --system-prompt <prompt>', '  --append-system-prompt <prompt>', '  --permission-mode <mode>',
  '  --allowedTools <tools...>', '  --disallowedTools <tools...>', '  --tools <tools...>',
  '  --add-dir <directories...>', '  --mcp-config <configs...>', '  --strict-mcp-config',
  '  --settings <file-or-json>', '  --setting-sources <sources>', '  --fork-session',
  '  --dangerously-skip-permissions', '  --max-turns <n>', '  -v, --version', '  -h, --help',
].join('\n')
const CODEX_EXEC_HELP = 'Usage: codex exec [OPTIONS] [PROMPT]\n  --json\n  -m, --model <MODEL>\n  -c, --config <key=value>\n  --add-dir <DIR>\n  --skip-git-repo-check\n  -s, --sandbox <MODE>\n  -C, --cd <DIR>\n  --output-last-message <FILE>\n'

function readStdin(streamJson, done) {
  if (process.stdin.isTTY) { done(null, 'tty'); return }
  let data = ''
  let finished = false
  const finish = mode => { if (finished) return; finished = true; done(data, mode) }
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    data += chunk
    if (streamJson) {
      const nl = data.indexOf('\n')
      if (nl >= 0) { data = data.slice(0, nl + 1); finish('first_line') }
    }
  })
  process.stdin.on('end', () => finish('eof'))
  process.stdin.on('error', () => finish('error'))
  // A caller that leaves stdin open and sends nothing: answer anyway.
  setTimeout(() => finish(data.length ? 'idle_partial' : 'idle_empty'), 800)
}

function claudeAnswer() {
  const model = valueOf('--model') ?? 'default'
  out({ type: 'system', subtype: 'init', session_id: sessionId, model, tools: [], mcp_servers: [], cwd: process.cwd() })
  out({ type: 'assistant', session_id: sessionId, message: { id: `msg_${id12}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'Golden answer.' }] } })
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: 'Golden answer.', num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
}

function codexAnswer() {
  const threadId = `00000000-0000-7000-8000-${id12}`
  out({ type: 'thread.started', thread_id: threadId })
  out({ type: 'turn.started' })
  out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Golden answer.' } })
  out({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } })
}

function main() {
  if (name === 'claude') {
    if (has('--version') || has('-v')) { record(null, 'none'); process.stdout.write('2.1.999 (Claude Code)\n'); return }
    if (has('--help') || has('-h')) { record(null, 'none'); process.stdout.write(`${CLAUDE_HELP}\n`); return }
    if (has('-p') || has('--print')) {
      const textOut = valueOf('--output-format') === 'text'
      readStdin(valueOf('--input-format') === 'stream-json', (text, mode) => {
        record(text, mode)
        if (textOut) process.stdout.write('Golden answer.\n')
        else claudeAnswer()
        setTimeout(() => process.exit(0), 20)
      })
      return
    }
    record(null, 'none'); process.exit(0)
  }
  if (name === 'codex') {
    if (has('--version')) { record(null, 'none'); process.stdout.write('codex-cli 0.163.0\n'); return }
    if (argv[0] === 'exec' && has('--help')) { record(null, 'none'); process.stdout.write(CODEX_EXEC_HELP); return }
    if (argv[0] === 'exec') {
      readStdin(false, (text, mode) => { record(text, mode); codexAnswer(); setTimeout(() => process.exit(0), 20) })
      return
    }
    // app-server and anything else: no JSON-RPC peer here, so the caller falls back.
    record(null, 'none'); process.exit(0)
  }
  if (name === 'agent') {
    if (has('--version')) { record(null, 'none'); process.stdout.write('2026.10.01-golden\n'); return }
    if (argv[0] === 'models') { record(null, 'none'); process.stdout.write('Available models\n\ngrok-4.7-high-fast - Grok Fast\ncomposer-2.5-fast - Composer 2.5 Fast\n'); return }
    if (has('-p') || has('--print')) {
      readStdin(false, (text, mode) => { record(text, mode); claudeAnswer(); setTimeout(() => process.exit(0), 20) })
      return
    }
    record(null, 'none'); process.exit(0)
  }
  record(null, 'none'); process.exit(0)
}

main()
