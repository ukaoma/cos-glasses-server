// A fake provider CLI for attached-provider-adapter.process-tree.e2e.test.ts (6.53.3).
//
// argv: <variant> <token> <sessionId>. It reads the prompt from stdin, echoes the session
// id the way `claude -p --output-format stream-json` does, then builds the process tree
// the variant names. Every long-lived process carries <token> in its argv, so the test can
// list survivors with `ps` and always clean up with `pkill -9 -f <token>`.
//
// The shapes are the ones review A (2026-09-22) ran against 6.52.3, 6.53.1 and 6.53.2.
'use strict'

const { spawn } = require('node:child_process')

const [variant, token, sessionId] = process.argv.slice(2)
const sh = (script, options) => spawn('/bin/sh', ['-c', script, token], options)

process.stdin.on('data', () => {})
process.stdin.on('end', () => {
  process.stdout.write(`${JSON.stringify({ type: 'system', session_id: sessionId })}\n`)
  switch (variant) {
    case 'churn':
      // A Claude Bash tool churning short-lived subprocesses in the CLI's own group.
      sh('while :; do /bin/sleep 0.01; done', { stdio: 'ignore' })
      process.on('SIGTERM', () => setTimeout(() => process.exit(143), 300))
      break
    case 'idle':
      // Long-lived children only, all in the CLI's group.
      for (let i = 0; i < 3; i++) {
        spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', token], { stdio: 'ignore' })
      }
      process.on('SIGTERM', () => setTimeout(() => process.exit(143), 300))
      break
    case 'stubborn':
      // A Codex tool in its OWN process group that ignores SIGTERM.
      sh("trap '' TERM; while :; do /bin/sleep 0.03; done", { detached: true, stdio: 'ignore' })
      process.on('SIGTERM', () => setTimeout(() => process.exit(143), 100))
      break
    case 'graceful':
      // A tool in its own group that takes one second to stop after SIGTERM.
      spawn(process.execPath, [
        '-e',
        "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1000)); setInterval(() => {}, 1000)",
        token,
      ], { detached: true, stdio: 'ignore' })
      process.on('SIGTERM', () => setTimeout(() => process.exit(143), 100))
      break
    case 'orphan-stdout':
    case 'orphan-stdout-exit1':
      // The CLI exits at once while a same-group child still holds its stdout, so `close`
      // waits on a process whose parent link is already gone. Exit 0 (with our id) is a
      // delivered turn; exit 1 is not, so a cancel then ends `cancelled`.
      sh('while :; do /bin/sleep 1; done', { stdio: ['ignore', 'inherit', 'ignore'] })
      setTimeout(() => process.exit(variant === 'orphan-stdout' ? 0 : 1), 50)
      return
    case 'group-orphan':
      // A tool group whose TERM-ignoring background job was re-parented to launchd BEFORE
      // the cancel: it keeps the group id but has no ppid path back to the CLI.
      sh(
        `( /bin/sh -c "trap '' TERM; while :; do /bin/sleep 1; done" ${token} & ) ; `
          + `exec /bin/sh -c 'while :; do /bin/sleep 1; done' ${token}`,
        { detached: true, stdio: 'ignore' },
      )
      process.on('SIGTERM', () => setTimeout(() => process.exit(143), 100))
      break
    case 'setsid-escape':
      // A same-group helper that ignores SIGTERM, waits for the CLI to die, then moves to a
      // session of its own. Neither its ppid nor its group leads back to us any more; only
      // the (pid, start) identity remembered while it was still in the tree does.
      sh(
        "trap '' TERM; while kill -0 $PPID 2>/dev/null; do /bin/sleep 0.05; done; "
          + `exec /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); sleep 1000' ${token}`,
        { stdio: 'ignore' },
      )
      process.on('SIGTERM', () => setTimeout(() => process.exit(143), 100))
      break
    default:
      process.exit(2)
  }
  setInterval(() => {}, 1000)
})
