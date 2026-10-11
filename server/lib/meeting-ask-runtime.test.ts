import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingAskRuntime, normalizeAskFiles } from './meeting-ask-runtime.js';
import { MeetingAskStore } from './meeting-ask-store.js';
import { exportMeetingAsk } from '../routes/meeting-ask.js';
const base = { requestId: 'request_12345678', sessionId: 'meeting_test', serverInstanceId: 'server-one', action: 'ask' as const, question: 'What was decided?', elapsedMs: 1000, turns: [{ id: 0, elapsedMs: 0, speaker: 'Person', text: 'We will review Friday.' }] };
function fixture(overrides: Record<string, unknown> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'ask-test-')), store = new MeetingAskStore(dir), release = vi.fn(), run = vi.fn(async (_model: unknown, _prompt: string) => ({ text: JSON.stringify({ answer: 'Review Friday [T1]', searchQuery: null }), model: 'claude-haiku-5-5' }));
    const runtime = new MeetingAskRuntime({ store, identity: () => 'server-one', admissions: () => true, lease: () => ({ release, id: 'lease', kind: 'meeting_ask' } as any), catalog: async () => [{ engine: 'claude', available: true, defaultModel: 'haiku', models: ['haiku', 'sonnet'] }], run, search: async () => ({ sources: [], notices: [] }), ...overrides });
    return { runtime, store, run, release, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
async function terminal(f: ReturnType<typeof fixture>, id = base.requestId) { for (let i = 0; i < 100; i++) {
    const e = f.runtime.get(id);
    if (!['pending', 'running'].includes(e.status))
        return e;
    await new Promise(r => setTimeout(r, 2));
} throw Error('never terminal'); }
describe('meeting Ask durable ownership', () => {
    it('admits all 100 registered references from two valid 50-file batches and rejects 101', async () => {
        const f = fixture();
        try {
            const files = Array.from({ length: 100 }, (_, i) => ({ id: `file_${String(i).padStart(8, '0')}`, revision: 'r1', name: `Context ${i}`, status: 'ready', text: `Evidence ${i}` }));
            f.runtime.putFiles(base.sessionId, 'server-one', files.slice(0, 50));
            f.runtime.putFiles(base.sessionId, 'server-one', files.slice(50));
            const refs = files.map(({ id, revision }) => ({ id, revision }));
            await expect(f.runtime.submit({ ...base, files: [...refs, { id: 'file_00000100', revision: 'r1' }] })).rejects.toThrow('invalid_files');
            expect(f.run).not.toHaveBeenCalled();
            await f.runtime.submit({ ...base, files: refs });
            expect((await terminal(f)).files).toHaveLength(100);
            expect(f.run).toHaveBeenCalledTimes(1);
            expect(f.store.get(base.requestId)?.input.files).toHaveLength(100);
        } finally { f.cleanup(); }
    });
    it('persists before inference and reuses accepted request across navigation/restart without another call', async () => { const f = fixture(); try {
        await f.runtime.submit(base);
        expect(f.store.get(base.requestId)?.exchange.question).toBe(base.question);
        expect((await terminal(f)).status).toBe('completed');
        expect((await f.runtime.submit(base)).status).toBe('completed');
        expect(f.run).toHaveBeenCalledTimes(1);
        expect(f.release).toHaveBeenCalledTimes(1);
        const reload = new MeetingAskRuntime({ store: f.store, identity: () => 'server-one' });
        expect(reload.history(base.sessionId, 'server-one').exchanges).toHaveLength(1);
    }
    finally {
        f.cleanup();
    } });
    it('same ID changed question conflicts; default model change does not rerun old admission', async () => { const f = fixture(); try {
        await f.runtime.submit(base);
        await terminal(f);
        await f.runtime.setConfig({ engine: 'claude', model: 'sonnet' });
        expect((await f.runtime.submit(base)).selectedModel.model).toBe('haiku');
        await expect(f.runtime.submit({ ...base, question: 'Different' })).rejects.toThrow('request_id_conflict');
    }
    finally {
        f.cleanup();
    } });
    it('cancel is durable and late answer cannot overwrite it; no lease release before provider exits', async () => { let resolve!: (v: any) => void; const run = vi.fn(() => new Promise<any>(r => { resolve = r; })); const f = fixture({ run }); try {
        await f.runtime.submit(base);
        await new Promise(r => setTimeout(r, 0));
        expect(f.runtime.cancel(base.requestId, 'server-one').status).toBe('cancelled');
        expect(f.release).not.toHaveBeenCalled();
        resolve({ text: '{"answer":"late [T1]"}', model: 'haiku' });
        await new Promise(r => setTimeout(r, 10));
        expect(f.runtime.get(base.requestId).status).toBe('cancelled');
        expect(f.release).toHaveBeenCalledTimes(1);
    }
    finally {
        f.cleanup();
    } });
    it('legacy and v2 share single flight', async () => { let resolve!: (v: any) => void; const f = fixture({ run: () => new Promise(r => { resolve = r; }) }); try {
        await f.runtime.submit(base);
        await expect(f.runtime.legacy({ ...base, history: [] }, new AbortController().signal)).rejects.toThrow('busy');
        await expect(f.runtime.submit({ ...base, requestId: 'request_98765432' })).rejects.toThrow('busy');
        resolve({ text: '{"answer":"yes [T1]"}', model: 'haiku' });
        await terminal(f);
    }
    finally {
        f.cleanup();
    } });
    it('pins attachment bytes and revision at admission; later changes cannot modify answer context', async () => { const f = fixture(); try {
        f.runtime.putFiles(base.sessionId, 'server-one', [{ id: 'file_12345678', revision: '1', name: 'Plan', status: 'ready', text: 'Owner is Nina' }]);
        await f.runtime.submit(base);
        f.runtime.putFiles(base.sessionId, 'server-one', [{ id: 'file_12345678', revision: '2', name: 'Plan', status: 'ready', text: 'Owner is Mira' }]);
        const e = await terminal(f);
        expect(e.files[0].text).toBe('Owner is Nina');
        expect(f.run.mock.calls[0][1]).toContain('Owner is Nina');
        expect(f.runtime.history(base.sessionId, 'server-one').files[0].revision).toBe('2');
    }
    finally {
        f.cleanup();
    } });
    it('rejects wrong server, unavailable provider and unknown file revision before any inference', async () => { const f = fixture(); try {
        await expect(f.runtime.submit({ ...base, serverInstanceId: 'other' })).rejects.toThrow('server_instance_mismatch');
        await expect(f.runtime.submit({ ...base, model: { engine: 'cursor', model: 'x' } })).rejects.toThrow('model_unavailable');
        await expect(f.runtime.submit({ ...base, files: [{ id: 'file_12345678', revision: 'no' }] })).rejects.toThrow('file_revision_changed');
        expect(f.run).not.toHaveBeenCalled();
    }
    finally {
        f.cleanup();
    } });
    it('recover marks unfinished record interrupted and never invokes model', async () => { const f = fixture(); try {
        await f.runtime.submit(base);
        await terminal(f);
        const row = f.store.get(base.requestId)!;
        row.exchange.status = 'running';
        f.store.write(row);
        const next = new MeetingAskRuntime({ store: f.store, identity: () => 'server-one', run: f.run });
        expect(next.get(base.requestId).status).toBe('interrupted');
        expect(f.run).toHaveBeenCalledTimes(1);
    }
    finally {
        f.cleanup();
    } });
    it('disk failure before journal admission blocks inference', async () => { const f = fixture(); try {
        vi.spyOn(f.store, 'write').mockImplementation(() => { throw Error('disk full'); });
        await expect(f.runtime.submit(base)).rejects.toThrow();
        expect(f.run).not.toHaveBeenCalled();
        expect(f.release).toHaveBeenCalledTimes(1);
    }
    finally {
        f.cleanup();
    } });
    it('terminal disk failure keeps bounded unsaved answer and does not rerun to repair storage', async () => { const f = fixture(); try {
        const write = f.store.write.bind(f.store);
        vi.spyOn(f.store, 'write').mockImplementation(row => { if (row.exchange.status === 'completed' || row.exchange.status === 'failed')
            throw Error('disk full'); write(row); });
        await f.runtime.submit(base);
        const e = await terminal(f);
        expect(e.error).toBe('journal_write_failed');
        expect(e.answer).toContain('Review Friday');
        expect(f.run).toHaveBeenCalledTimes(1);
        expect(f.release).not.toHaveBeenCalled();
    }
    finally {
        f.cleanup();
    } });
    it('full export namespaces citations and includes file text without mutating transcript', async () => { const f = fixture(); try {
        await f.runtime.submit(base);
        const e = await terminal(f);
        const text = exportMeetingAsk([e], [{ id: 'file_12345678', revision: '1', name: 'Doc', status: 'ready', text: 'context' }]);
        expect(text).toContain(`[${base.requestId}:T1]`);
        expect(text).toContain('context');
        expect(text).toContain(base.question);
    }
    finally {
        f.cleanup();
    } });
    it('file screening holds secrets and refuses traversal identifiers', () => { expect(normalizeAskFiles([{ id: 'file_12345678', revision: '1', name: 'x', status: 'ready', text: 'sk-secretprivate12345' }])[0].status).toBe('secret-held'); expect(() => normalizeAskFiles([{ id: '../../xxx', revision: '1', name: 'x', status: 'ready', text: 'ok' }])).toThrow(); });
});
