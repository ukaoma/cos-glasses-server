/** Per-feature tools-off process runner. Does not change lens-gist defaults. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProviderBinary } from './provider-binary.js';
import { buildClaudeGistArgs, buildCodexGistArgs, parseClaudeGistOutput, parseCodexGistOutput, lensGistChildEnv, type ClaudeGistEffort } from './lens-gist-engines.js';
import { logTokenAudit } from './token-audit.js';
import type { MeetingAskModel } from '../../shared/meeting-ask.js';
/** 6.73.12: how one caller's run is bounded. Omitted fields keep Meeting Ask's budget, unchanged since before 6.73.12. */
export interface MeetingAskRunBudget {
    /** Claude `--effort`. Omitted keeps the builder's low. */
    effort?: ClaudeGistEffort;
    /** Answer tokens, excluding thinking. The child's CLAUDE_CODE_MAX_OUTPUT_TOKENS is this plus maxThinkingTokens,
     *  because the model's max_tokens counts thinking too. */
    maxOutputTokens?: number;
    /** MAX_THINKING_TOKENS for the child. 0 turns thinking off. */
    maxThinkingTokens?: number;
    /** Wall-clock limit before the child is stopped with provider_timeout. */
    deadlineMs?: number;
}
export const MEETING_ASK_DEFAULT_BUDGET = { maxOutputTokens: 1400, maxThinkingTokens: 0, deadlineMs: 45000 } as const;
/** The child environment's token limits for a budget; the default is exactly '1400' and '0'. */
export function meetingAskTokenEnv(budget?: MeetingAskRunBudget): { CLAUDE_CODE_MAX_OUTPUT_TOKENS: string; MAX_THINKING_TOKENS: string } {
    const output = budget?.maxOutputTokens ?? MEETING_ASK_DEFAULT_BUDGET.maxOutputTokens;
    const thinking = budget?.maxThinkingTokens ?? MEETING_ASK_DEFAULT_BUDGET.maxThinkingTokens;
    return { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(output + thinking), MAX_THINKING_TOKENS: String(thinking) };
}
export class AskProcessError extends Error {
    constructor(message: string, readonly terminationUnconfirmed = false) { super(message); }
}
export function runMeetingAskModel(model: MeetingAskModel, prompt: string, system: string, signal?: AbortSignal, adapter?: {
    workspace: string;
    args: string[];
    stdin: string;
}, audit?: {
    /** Token-audit caller label (6.71.13), e.g. meeting_fact_check_planner_hedge. A failed call appends ":<reason>". */
    caller: string;
},
/** 6.73.12: effort, token budget and deadline. Omitted keeps Meeting Ask's, so every older caller is unchanged. */
budget?: MeetingAskRunBudget): Promise<{
    text: string;
    model?: string;
}> {
    if (model.engine !== 'claude' && model.engine !== 'codex')
        return Promise.reject(new AskProcessError('provider_not_qualified'));
    if (signal?.aborted)
        return Promise.reject(new AskProcessError('cancelled'));
    const provider = model.engine;
    const binary = resolveProviderBinary(provider);
    if (!binary.ok)
        return Promise.reject(new AskProcessError('provider_unavailable'));
    const workspace = adapter?.workspace ?? mkdtempSync(join(tmpdir(), 'cos-meeting-ask-'));
    const args = adapter?.args ?? (provider === 'claude' ? buildClaudeGistArgs(model.model, system, budget?.effort) : buildCodexGistArgs(model.model, workspace));
    // Codex has no system-prompt flag here: trusted instruction is separate, then JSON evidence.
    const stdin = adapter?.stdin ?? (provider === 'claude' ? prompt : `${system}\n\n${prompt}`);
    return new Promise((resolve, reject) => {
        const child = spawn(binary.path, args, { cwd: workspace, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...lensGistChildEnv(binary.path), ...meetingAskTokenEnv(budget) } });
        let stdout = '', failure: string | null = null, done = false, closeSeen = false, code: number | null = null;
        let killTimer: NodeJS.Timeout | undefined, proofTimer: NodeJS.Timeout | undefined;
        const kill = (sig: NodeJS.Signals) => { if (child.pid)
            try {
                process.kill(-child.pid, sig);
            }
            catch { } };
        const alive = () => { if (!child.pid)
            return false; try {
            process.kill(-child.pid, 0);
            return true;
        }
        catch (e) {
            return (e as NodeJS.ErrnoException).code !== 'ESRCH';
        } };
        // One token-audit row per spawned call, whatever its outcome. 6.68.0 logged Live Ask through
        // runLensGistEngine; this runner replaced that path. The web search is the adapter caller.
        const started = Date.now();
        const auditSource = adapter ? 'meeting-ask-web' : 'meeting-ask';
        let answerChars = 0, answerModel = `${provider}:${model.model}`;
        const finish = (unconfirmed = false) => {
            if (done)
                return;
            done = true;
            try {
                settle(unconfirmed);
            }
            finally {
                logTokenAudit({ source: auditSource, caller: audit ? audit.caller + (unconfirmed ? ':child_exit_unconfirmed' : failure || code !== 0 ? ':' + (failure ?? 'provider_failed') : '') : auditSource.replace(/-/g, '_'), model: answerModel,
                    inputChars: stdin.length + (adapter ? args.join(' ').length : provider === 'claude' ? system.length : 0),
                    outputChars: answerChars, durationMs: Date.now() - started });
            }
        };
        const settle = (unconfirmed: boolean) => {
            clearTimeout(deadline);
            clearTimeout(killTimer);
            clearInterval(proofTimer);
            signal?.removeEventListener('abort', abort);
            if (!unconfirmed && !adapter)
                rmSync(workspace, { recursive: true, force: true });
            if (unconfirmed)
                return reject(new AskProcessError('child_exit_unconfirmed', true));
            if (failure || code !== 0)
                return reject(new AskProcessError(failure ?? 'provider_failed'));
            try {
                if (!adapter && provider === 'codex')
                    for (const line of stdout.split('\n')) {
                        let event: any;
                        try {
                            event = JSON.parse(line);
                        }
                        catch {
                            continue;
                        }
                        if (event.item?.type && !['agent_message', 'reasoning'].includes(event.item.type))
                            throw new Error('unexpected tool activity');
                    }
                const parsed = provider === 'claude' ? parseClaudeGistOutput(stdout) : parseCodexGistOutput(stdout);
                answerChars = parsed.text.length;
                if (parsed.model)
                    answerModel = `${provider}:${parsed.model}`;
                resolve({ ...parsed, model: parsed.model ?? `${provider}:${model.model} (requested)` });
            }
            catch {
                reject(new AskProcessError('invalid_provider_answer'));
            }
        };
        const stop = (reason: string) => {
            if (failure || done)
                return;
            failure = reason;
            kill('SIGTERM');
            killTimer = setTimeout(() => kill('SIGKILL'), 1000);
            const start = Date.now();
            proofTimer = setInterval(() => { if (closeSeen && !alive())
                finish();
            else if (Date.now() - start > 4500)
                finish(true); }, 50);
        };
        const abort = () => stop('cancelled');
        const deadline = setTimeout(() => stop('provider_timeout'), budget?.deadlineMs ?? MEETING_ASK_DEFAULT_BUDGET.deadlineMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted)
            abort();
        child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); if (stdout.length > 1000000)
            stop('output_limit'); });
        child.stderr.on('data', () => { }); // Never surface provider credentials/raw errors.
        child.stdin.on('error', () => stop('provider_input_failed'));
        child.on('error', () => { failure = 'provider_unavailable'; closeSeen = true; finish(); });
        child.on('close', exit => { closeSeen = true; code = exit; if (failure) {
            if (!alive())
                finish();
        }
        else if (alive())
            stop('orphan_provider_child');
        else
            finish(); });
        child.stdin.end(stdin);
    });
}
