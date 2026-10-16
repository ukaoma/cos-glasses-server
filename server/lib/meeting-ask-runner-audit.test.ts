import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// A real process (/bin/sh) stands in for the provider CLI, so the spawn and finish paths execute.
vi.mock('./provider-binary.js', () => ({ resolveProviderBinary: vi.fn(() => ({ ok: true, path: '/bin/sh' })) }));
vi.mock('./token-audit.js', () => ({ logTokenAudit: vi.fn() }));
vi.mock('./lens-gist-engines.js', () => ({
    buildClaudeGistArgs: vi.fn(() => ['-c', 'cat >/dev/null; exit 3']),
    buildCodexGistArgs: vi.fn(),
    parseClaudeGistOutput: vi.fn((out: string) => ({ text: out.trim(), model: 'claude-haiku-5-5' })),
    parseCodexGistOutput: vi.fn(),
    lensGistChildEnv: vi.fn(() => ({ PATH: '/usr/bin:/bin' })),
}));
import { logTokenAudit } from './token-audit.js';
import { runMeetingAskModel } from './meeting-ask-runner.js';

const roots: string[] = [];
afterEach(() => { vi.mocked(logTokenAudit).mockClear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Meeting Ask token audit', () => {
    it('logs one meeting-ask-web row with the answer size and resolved model for a web search call', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'cos-ask-audit-'));
        roots.push(workspace);
        const run = await runMeetingAskModel({ engine: 'claude', model: 'haiku' }, '', '', undefined, { workspace, args: ['-c', 'cat >/dev/null; printf "answer text"'], stdin: '{"query":"x"}' });
        expect(run.text).toBe('answer text');
        expect(logTokenAudit).toHaveBeenCalledTimes(1);
        expect(vi.mocked(logTokenAudit).mock.calls[0][0]).toMatchObject({ source: 'meeting-ask-web', caller: 'meeting_ask_web', model: 'claude:claude-haiku-5-5', outputChars: 11 });
    });
    it('6.73.12: Meeting Ask builds its argv with no effort, so the builder keeps low', async () => {
        const { buildClaudeGistArgs } = await import('./lens-gist-engines.js');
        vi.mocked(buildClaudeGistArgs).mockClear();
        await expect(runMeetingAskModel({ engine: 'claude', model: 'haiku' }, 'question', 'system', undefined, undefined, { caller: 'meeting_ask' })).rejects.toThrow('provider_failed');
        expect(vi.mocked(buildClaudeGistArgs).mock.calls).toEqual([['haiku', 'system', undefined]]);
        vi.mocked(buildClaudeGistArgs).mockClear();
        await expect(runMeetingAskModel({ engine: 'claude', model: 'opus' }, 'question', 'system', undefined, undefined, undefined, { effort: 'high' })).rejects.toThrow('provider_failed');
        expect(vi.mocked(buildClaudeGistArgs).mock.calls).toEqual([['opus', 'system', 'high']]);
    });
    it('6.73.12: the child keeps 1400 output and 0 thinking tokens by default; a caller budget adds thinking to max_tokens', async () => {
        const { meetingAskTokenEnv, MEETING_ASK_DEFAULT_BUDGET } = await import('./meeting-ask-runner.js');
        expect(meetingAskTokenEnv()).toEqual({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1400', MAX_THINKING_TOKENS: '0' });
        expect(MEETING_ASK_DEFAULT_BUDGET).toEqual({ maxOutputTokens: 1400, maxThinkingTokens: 0, deadlineMs: 45000 });
        const workspace = mkdtempSync(join(tmpdir(), 'cos-ask-audit-'));
        roots.push(workspace);
        const env = { workspace, args: ['-c', 'cat >/dev/null; printf "%s %s" "$CLAUDE_CODE_MAX_OUTPUT_TOKENS" "$MAX_THINKING_TOKENS"'], stdin: '{}' };
        expect((await runMeetingAskModel({ engine: 'claude', model: 'haiku' }, '', '', undefined, env)).text).toBe('1400 0');
        expect((await runMeetingAskModel({ engine: 'claude', model: 'opus' }, '', '', undefined, env, undefined, { effort: 'high', maxOutputTokens: 4086, maxThinkingTokens: 16000 })).text).toBe('20086 16000');
    });
    it('6.73.12: a caller deadline stops the child; the default stays 45 s', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'cos-ask-audit-'));
        roots.push(workspace);
        const slow = { workspace, args: ['-c', 'cat >/dev/null; sleep 5; printf late'], stdin: '{}' };
        const started = Date.now();
        await expect(runMeetingAskModel({ engine: 'claude', model: 'opus' }, '', '', undefined, slow, undefined, { deadlineMs: 150 })).rejects.toThrow('provider_timeout');
        expect(Date.now() - started).toBeLessThan(4000);
    });
    it('logs one meeting-ask row for a spawned call that fails', async () => {
        await expect(runMeetingAskModel({ engine: 'claude', model: 'haiku' }, 'question', 'system')).rejects.toThrow('provider_failed');
        expect(logTokenAudit).toHaveBeenCalledTimes(1);
        expect(vi.mocked(logTokenAudit).mock.calls[0][0]).toMatchObject({ source: 'meeting-ask', caller: 'meeting_ask', model: 'claude:haiku', outputChars: 0, inputChars: 'question'.length + 'system'.length });
    });
    it('labels a fact-check call by its caller, with the failure reason, so hedges and stalls can be counted (6.71.13)', async () => {
        await expect(runMeetingAskModel({ engine: 'claude', model: 'haiku' }, 'question', 'system', undefined, undefined, { caller: 'meeting_fact_check_planner_hedge' })).rejects.toThrow('provider_failed');
        expect(vi.mocked(logTokenAudit).mock.calls[0][0]).toMatchObject({ source: 'meeting-ask', caller: 'meeting_fact_check_planner_hedge:provider_failed' });
        const workspace = mkdtempSync(join(tmpdir(), 'cos-ask-audit-'));
        roots.push(workspace);
        await runMeetingAskModel({ engine: 'claude', model: 'haiku' }, '', '', undefined, { workspace, args: ['-c', 'cat >/dev/null; printf ok'], stdin: '{}' }, { caller: 'meeting_fact_check_answer' });
        expect(vi.mocked(logTokenAudit).mock.calls[1][0]).toMatchObject({ caller: 'meeting_fact_check_answer' });
    });
    it('logs nothing when no process was spawned', async () => {
        await expect(runMeetingAskModel({ engine: 'cursor', model: 'x' }, 'question', 'system')).rejects.toThrow('provider_not_qualified');
        expect(logTokenAudit).not.toHaveBeenCalled();
    });
});
