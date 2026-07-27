// Dedicated Composer spawn for Live Cues.
//
// callCursorStreaming is deliberately NOT used: per call it writes conversation
// history (getOrCreateSession/addExchange), logs token audit as 'g2-query'
// (the ledger that measures the user's own usage), registers a run in the
// Cursor run ledger, fires a Telegram push via notifyExchange, and resolves
// with the session id instead of the answer. A cue loop must perturb none of
// that. This module reuses only the pure exported helpers.

import { spawn, type ChildProcess } from 'node:child_process'
import {
  buildCursorAgentArgs,
  extractCursorResponseText,
} from './cursor-bridge.js'
import { resolveAgentBinary } from './cursor-model-catalog.js'
import { classifyCursorError, getCursorExecutionCwd } from './cursor-run-ledger.js'
import { terminalProviderAuthFailure } from './provider-terminal-error.js'
import { terminateProviderProcess } from './provider-process-lifecycle.js'
import { logTokenAudit } from './token-audit.js'

export type LiveCuesCaller = 'live-cues-planner' | 'live-cues-insight'

export interface ComposerAskSuccess {
  ok: true
  text: string
  durationMs: number
}

export interface ComposerAskFailure {
  ok: false
  reason: string
  authFailure: boolean
  /** False means the process tree could not be proven dead. The caller must
   *  RETAIN its maintenance lease in that case (provider-process-lifecycle
   *  contract) — releasing early could let Control restart the server while a
   *  Cursor subprocess is still alive. */
  treeClosed: boolean
  durationMs: number
}

export type ComposerAskResult = ComposerAskSuccess | ComposerAskFailure

/** One stateless Composer ask. Fresh spawn, no session, no resume, no history. */
export async function composerAsk(input: {
  prompt: string
  modelId: string
  caller: LiveCuesCaller
  timeoutMs: number
  /** Lets the engine track the live tree so gracefulShutdown can kill it. */
  onProcess?: (proc: ChildProcess) => void
}): Promise<ComposerAskResult> {
  const startedAt = Date.now()
  const agentBinary = resolveAgentBinary()
  if (!agentBinary) {
    return { ok: false, reason: 'cursor.cli_unavailable', authFailure: false, treeClosed: true, durationMs: 0 }
  }

  const workspace = getCursorExecutionCwd()
  const args = buildCursorAgentArgs({ workspace, modelId: input.modelId, executionMode: 'ask' })
  const env = { ...process.env }
  delete env.CLAUDECODE

  return new Promise<ComposerAskResult>(resolve => {
    let settled = false
    let fullText = ''
    let stderr = ''
    let lineBuffer = ''
    let timedOut = false

    // detached: the CLI gets its own process group so a timeout kill reaches
    // tool grandchildren. This is NEW relative to cursor-bridge (which spawns
    // attached) — the shutdown path in the engine must also kill this tree.
    const proc = spawn(agentBinary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: workspace,
      detached: true,
    })
    input.onProcess?.(proc)

    const finish = (result: ComposerAskResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      timedOut = true
      void terminateProviderProcess(proc).then(termination => {
        finish({
          ok: false,
          reason: 'cursor.timeout',
          authFailure: false,
          treeClosed: termination.closed,
          durationMs: Date.now() - startedAt,
        })
      })
    }, Math.max(1_000, input.timeoutMs))

    proc.on('error', () => {
      finish({
        ok: false,
        reason: 'cursor.cli_unavailable',
        authFailure: false,
        treeClosed: !proc.pid,
        durationMs: Date.now() - startedAt,
      })
    })

    proc.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2_000) })
    proc.stdout?.on('data', chunk => {
      lineBuffer += String(chunk)
      let newlineIndex = lineBuffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = lineBuffer.slice(0, newlineIndex).trim()
        lineBuffer = lineBuffer.slice(newlineIndex + 1)
        if (line) {
          try {
            fullText += extractCursorResponseText(JSON.parse(line))
          } catch { /* non-JSON noise on stdout is ignored */ }
        }
        newlineIndex = lineBuffer.indexOf('\n')
      }
    })

    proc.on('close', code => {
      if (timedOut) return // the timeout branch owns the result
      const durationMs = Date.now() - startedAt
      const text = fullText.trim()
      // Cursor can report auth failures as successful output with exit 0
      // (provider-terminal-error.ts) — exit code alone cannot catch it, and a
      // missed check would render "authentication required" as a coaching cue.
      const authError = terminalProviderAuthFailure('cursor', text, stderr)
      if (authError) {
        finish({ ok: false, reason: 'cursor.auth_error', authFailure: true, treeClosed: true, durationMs })
        return
      }
      if (code !== 0) {
        finish({
          ok: false,
          reason: classifyCursorError(stderr || text || `exit ${code}`),
          authFailure: false,
          treeClosed: true,
          durationMs,
        })
        return
      }
      if (!text) {
        finish({ ok: false, reason: 'cursor.empty_response', authFailure: false, treeClosed: true, durationMs })
        return
      }
      logTokenAudit({
        source: 'live-cues',
        model: 'cursor-composer',
        inputChars: input.prompt.length,
        outputChars: text.length,
        durationMs,
        caller: input.caller,
      })
      finish({ ok: true, text, durationMs })
    })

    proc.stdin?.write(input.prompt)
    proc.stdin?.end()
  })
}
