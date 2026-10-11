import { describe, expect, it, vi } from 'vitest';
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => { throw new Error('unexpected process spawn'); }) }));
vi.mock('./provider-binary.js', () => ({ resolveProviderBinary: vi.fn(() => { throw new Error('unexpected binary lookup'); }) }));
vi.mock('./lens-gist-engines.js', () => ({ buildClaudeGistArgs: vi.fn(), buildCodexGistArgs: vi.fn(), parseClaudeGistOutput: vi.fn(), parseCodexGistOutput: vi.fn(), lensGistChildEnv: vi.fn() }));
import { spawn } from 'node:child_process';
import { resolveProviderBinary } from './provider-binary.js';
import { runMeetingAskModel } from './meeting-ask-runner.js';

describe('Meeting Ask provider census exemption', () => {
    it.each(['cursor', 'ollama'] as const)('rejects %s before binary resolution or any process spawn', async engine => {
        await expect(runMeetingAskModel({ engine, model: 'synthetic' }, 'question', 'system')).rejects.toThrow('provider_not_qualified');
        expect(resolveProviderBinary).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
    });
});
