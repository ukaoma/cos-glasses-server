import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
vi.mock('./transcribe-stream.js', () => ({ getSessionChunkEntries: () => [{ chunkIndex: 2, chunk: { elapsed: 100, text: 'Review on Friday', speaker: 'Nina' } }], getSessionStartTime: () => Date.now() - 1000 }));
import { createMeetingAskRouter } from './meeting-ask.js';
import { MeetingAskRuntime } from '../lib/meeting-ask-runtime.js';
import { MeetingAskStore } from '../lib/meeting-ask-store.js';
import { requireApiToken } from '../lib/api-auth.js';
const input = { requestId: 'request_abcdefgh', sessionId: 'meeting_test', serverInstanceId: 'test-server', action: 'ask', question: 'Who reviews?', elapsedMs: 1000, turns: [{ id: 2, elapsedMs: 100, text: 'Review on Friday', speaker: 'Nina' }] };
async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'ask-http-')), run = vi.fn(async () => ({ text: '{"answer":"Nina [T1]"}', model: 'haiku' })), runtime = new MeetingAskRuntime({ store: new MeetingAskStore(dir), identity: () => 'test-server', catalog: async () => [{ engine: 'claude', available: true, defaultModel: 'haiku', models: ['haiku'] }], run, search: async () => ({ sources: [], notices: [] }), admissions: () => true, lease: () => ({ id: 'x', kind: 'meeting_ask', setPhase() { }, release() { } }) });
    const app = express();
    app.use('/api', requireApiToken('test-token'));
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', createMeetingAskRouter(runtime));
    let server: Server;
    await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()); });
    const address = server!.address() as any;
    const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', authenticated = true) => fetch(`http://127.0.0.1:${address.port}/api/meeting-ask${path}`, { method, headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-cos-token': 'test-token' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { request, run, runtime, async close() { await runtime.shutdown(); await new Promise<void>(r => server!.close(() => r())); rmSync(dir, { recursive: true, force: true }); } };
}
describe('Meeting Ask v2 HTTP contract', () => {
    it('requires pairing on reads/writes and returns no-store config with model/catalog', async () => { const f = await fixture(); try {
        expect((await f.request('/config', undefined, 'GET', false)).status).toBe(401);
        expect((await f.request('/requests', input, 'POST', false)).status).toBe(401);
        const c = await f.request('/config');
        expect(c.headers.get('cache-control')).toBe('no-store');
        expect((await c.json()).selected).toEqual({ engine: 'claude', model: 'haiku' });
        expect(f.run).not.toHaveBeenCalled();
    }
    finally {
        await f.close();
    } });
    it('durably admits once, rehydrates history and export after navigation, rejects cross-server', async () => { const f = await fixture(); try {
        expect((await f.request('/requests', input)).status).toBe(202);
        await new Promise(r => setTimeout(r, 10));
        const path = '?sessionId=meeting_test&serverInstanceId=test-server';
        const h = await (await f.request('/history' + path)).json();
        expect(h.exchanges[0].answer).toBe('Nina [T1]');
        expect((await f.request('/requests', input)).status).toBe(202);
        expect(f.run).toHaveBeenCalledTimes(1);
        const exported = await (await f.request('/export' + path)).json();
        expect(exported.text).toContain('[request_abcdefgh:T1]');
        expect((await f.request('/history?sessionId=meeting_test&serverInstanceId=wrong')).status).toBe(409);
        expect((await f.request('/requests', { ...input, question: 'Changed' })).status).toBe(409);
    }
    finally {
        await f.close();
    } });
    it('returns canonical active transcript and persists attachment changes without invoking AI', async () => { const f = await fixture(); try {
        const t = await (await f.request('/transcript?sessionId=meeting_test&serverInstanceId=test-server')).json();
        expect(t.turns[0].id).toBe(2);
        expect(t.turns[0].elapsedMs).toBe(100);
        const body = { sessionId: 'meeting_test', serverInstanceId: 'test-server', files: [{ id: 'file_abcdefgh', revision: 'r1', name: 'Doc', status: 'ready', text: 'Context' }] };
        expect((await f.request('/files', body, 'PUT')).status).toBe(200);
        const h = await (await f.request('/history?sessionId=meeting_test&serverInstanceId=test-server')).json();
        expect(h.files[0].text).toBe('Context');
        expect(f.run).not.toHaveBeenCalled();
    }
    finally {
        await f.close();
    } });
    it('exports admitted file bytes after a same-revision removal and includes later revisions', async () => {
        const f = await fixture();
        try {
            const file = { id: 'file_abcdefgh', revision: 'r1', name: 'Agenda', status: 'ready', text: 'Nina reviews the budget on Friday.' };
            const update = (files: unknown[]) => f.request('/files', { sessionId: input.sessionId, serverInstanceId: input.serverInstanceId, files }, 'PUT');
            expect((await update([file])).status).toBe(200);
            expect((await f.request('/requests', { ...input, files: [{ id: file.id, revision: 'r1' }] })).status).toBe(202);
            await new Promise(r => setTimeout(r, 10));
            expect((await update([{ ...file, status: 'removed', text: '' }])).status).toBe(200);
            const path = '/export?sessionId=meeting_test&serverInstanceId=test-server';
            const removed = (await (await f.request(path)).json()).text;
            expect(removed).toContain('Current file status: Agenda (removed)');
            expect(removed).toContain('Reference: file_abcdefgh@r1\nNina reviews the budget on Friday.');
            expect((await update([{ ...file, revision: 'r2', text: 'Budget review moved to Monday.' }])).status).toBe(200);
            const revised = (await (await f.request(path)).json()).text;
            expect(revised).toContain('Reference: file_abcdefgh@r1\nNina reviews the budget on Friday.');
            expect(revised).toContain('Reference: file_abcdefgh@r2\nBudget review moved to Monday.');
            expect(f.run).toHaveBeenCalledTimes(1);
        } finally { await f.close(); }
    });
});
