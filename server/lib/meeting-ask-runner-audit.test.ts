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
    it('logs one meeting-ask row for a spawned call that fails', async () => {
        await expect(runMeetingAskModel({ engine: 'claude', model: 'haiku' }, 'question', 'system')).rejects.toThrow('provider_failed');
        expect(logTokenAudit).toHaveBeenCalledTimes(1);
        expect(vi.mocked(logTokenAudit).mock.calls[0][0]).toMatchObject({ source: 'meeting-ask', caller: 'meeting_ask', model: 'claude:haiku', outputChars: 0, inputChars: 'question'.length + 'system'.length });
    });
    it('logs nothing when no process was spawned', async () => {
        await expect(runMeetingAskModel({ engine: 'cursor', model: 'x' }, 'question', 'system')).rejects.toThrow('provider_not_qualified');
        expect(logTokenAudit).not.toHaveBeenCalled();
    });
});
