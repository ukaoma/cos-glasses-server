import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('./transcribe-stream.js', () => ({ getSessionChunkEntries: () => [{ chunkIndex: 2, chunk: { elapsed: 100, text: 'Review on Friday', speaker: 'Nina' } }], getSessionStartTime: () => Date.now() - 1000 }));
vi.mock('../lib/meeting-ask-refinement.js', () => ({ refineActiveMeetingAsk: vi.fn((input) => ({ input, notices: [] })) }));
import { refineActiveMeetingAsk } from '../lib/meeting-ask-refinement.js';
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(refineActiveMeetingAsk).mockReset().mockImplementation(input => ({ input, notices: [] })); });
import { createMeetingAskRouter } from './meeting-ask.js';
import { MeetingAskRuntime } from '../lib/meeting-ask-runtime.js';
import { MeetingAskStore } from '../lib/meeting-ask-store.js';
import { requireApiToken } from '../lib/api-auth.js';
import type { AskTranscriptSources } from '../lib/meeting-ask-transcript.js';
import { MediaStoreError } from '../lib/media-store.js';
const input = { requestId: 'request_abcdefgh', sessionId: 'meeting_test', serverInstanceId: 'test-server', action: 'ask', question: 'Who reviews?', elapsedMs: 1000, turns: [{ id: 2, elapsedMs: 100, text: 'Review on Friday', speaker: 'Nina' }] };
async function fixture(transcripts?: AskTranscriptSources, media?: () => any) {
    const dir = mkdtempSync(join(tmpdir(), 'ask-http-')), run = vi.fn(async () => ({ text: '{"sections":[{"label":"So what","text":"Nina [T1]"}]}', model: 'haiku' })), runtime = new MeetingAskRuntime({ domains:()=>[{id:'quilt',label:'Quilt'},{id:'personal',label:'Personal'}], store: new MeetingAskStore(dir), identity: () => 'test-server', catalog: async () => [{ engine: 'claude', available: true, defaultModel: 'haiku', models: ['haiku'] }], run, search: async () => ({ sources: [], notices: [] }), admissions: () => true, lease: () => ({ id: 'x', kind: 'meeting_ask', setPhase() { }, release() { } }), ...(media ? { media } : {}) });
    const app = express();
    app.use('/api', requireApiToken('test-token'));
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', createMeetingAskRouter(runtime, transcripts));
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
        expect(h.exchanges[0].answer).toMatch(/^\*\*So what:\*\* Nina \[T1\]\n\n\*\*Confidence:\*\*/);
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
    it('returns sections from the request, history and a restarted server; answer stays the composed markdown', async () => { const f = await fixture(); try {
        f.run.mockResolvedValueOnce({ text: JSON.stringify({ sections: [{ label: 'decided', text: 'Friday review [T1].' }, { label: 'So what', text: 'Nina reviews [T1].' }], searchQuery: null }), model: 'haiku' });
        expect((await f.request('/requests', { ...input, action: 'summary', question: '' })).status).toBe(202);
        await new Promise(r => setTimeout(r, 10));
        const expected = [{ label: 'So what', text: 'Nina reviews [T1].', sources: ['T1'] }, { label: 'Decided', text: 'Friday review [T1].', sources: ['T1'] }, {label:'Confidence',text:expect.stringMatching(/^Limited/),sources:[]}];
        const one = (await (await f.request('/requests/' + input.requestId)).json()).exchange;
        expect(one.status).toBe('completed');
        expect(one.sections).toEqual(expected);
        expect(one.answer).toMatch(/^\*\*So what:\*\* Nina reviews \[T1\].\n\n\*\*Decided:\*\* Friday review \[T1\].\n\n\*\*Confidence:\*\*/);
        const h = await (await f.request('/history?sessionId=meeting_test&serverInstanceId=test-server')).json();
        expect(h.exchanges[0].sections).toEqual(expected);
        const reload = new MeetingAskRuntime({ store: (f.runtime as any).deps.store, identity: () => 'test-server' });
        expect(reload.get(input.requestId).sections).toEqual(expected);
    }
    finally {
        await f.close();
    } });
    it('confirms one meeting domain without AI, rejects stale and cross-server changes', async () => {
        const f=await fixture(); try {
            const value={sessionId:'meeting_test',serverInstanceId:'test-server',expectedRevision:0,domain:'quilt',calendarId:null};
            const response=await f.request('/context',value,'PUT');
            expect(response.status).toBe(200);
            expect((await response.json()).orientation).toMatchObject({revision:1,domain:'quilt',calendar:null});
            expect((await f.request('/context',value,'PUT')).status).toBe(409);
            expect((await f.request('/context',{...value,expectedRevision:1,domain:'invented'},'PUT')).status).toBe(400);
            expect((await f.request('/context',{...value,serverInstanceId:'wrong'},'PUT')).status).toBe(409);
            expect(f.run).not.toHaveBeenCalled();
        } finally { await f.close(); }
    });
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
    it('with HQ disabled, returns the released live snapshot without consulting refinement', async () => {
        vi.stubEnv('COS_MEETING_ASK_HQ_EVIDENCE', '0');
        const sources: AskTranscriptSources = { live: () => ({ entries: [{ chunkIndex: 7, chunk: { text: 'Friday, not Monday', speaker: 'Nina', elapsed: 100 } }], startTime: 1000 }), now: () => 2000, status: () => ({ state: 'active' }), activeFile: () => null, saved: () => null, read: () => null };
        const f = await fixture(sources);
        try {
            const r = await f.request('/transcript?sessionId=meeting_test&serverInstanceId=test-server');
            expect(r.status).toBe(200);
            expect(await r.json()).toEqual({ turns: [{ id: 7, elapsedMs: 100, text: 'Friday, not Monday', speaker: 'Nina' }], elapsedMs: 1000, notices: [], source: 'live' });
            expect(refineActiveMeetingAsk).not.toHaveBeenCalled();
        } finally { await f.close(); }
    });
    it('an opted-in live overlay preserves the released source, cutoff and new live tail', async () => {
        vi.stubEnv('COS_MEETING_ASK_HQ_EVIDENCE', '1');
        const turns = [{ id: 7, elapsedMs: 100, speaker: 'Nina', text: 'Friday, not Monday' }, { id: 8, elapsedMs: 900, speaker: 'Nina', text: 'The budget is 59.' }];
        const sources: AskTranscriptSources = { live: () => ({ entries: turns.map(t => ({ chunkIndex: t.id, chunk: { text: t.text, speaker: t.speaker, elapsed: t.elapsedMs } })), startTime: 1000 }), now: () => 2000, status: () => ({ state: 'active' }), activeFile: () => null, saved: () => null, read: () => null };
        vi.mocked(refineActiveMeetingAsk).mockImplementationOnce(input => ({ input: { ...input, turns: [{ ...input.turns[0], text: 'Nina reviews Friday, not Monday.' }, input.turns[1]] }, notices: ['Earlier passage refined.'] }));
        const f = await fixture(sources);
        try {
            const r = await f.request('/transcript?sessionId=meeting_test&serverInstanceId=test-server');
            expect(r.status).toBe(200);
            expect(await r.json()).toEqual({ turns: [{ ...turns[0], text: 'Nina reviews Friday, not Monday.' }, turns[1]], elapsedMs: 1000, notices: ['Earlier passage refined.'], source: 'live' });
            expect(refineActiveMeetingAsk).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'meeting_test', elapsedMs: 1000, turns }));
        } finally { await f.close(); }
    });
    it('an ended meeting answers /transcript from its saved record; a gone one is 404 meeting_transcript_unavailable', async () => {
        vi.stubEnv('COS_MEETING_ASK_HQ_EVIDENCE', '1');
        const sidecar = JSON.stringify({ sessionId: 'meeting_test', startTime: 1000, durationMs: 60000, chunkEntries: [{ chunkIndex: 4, chunk: { text: 'Saved words', speaker: 'Nina', elapsed: 5000 } }] });
        const base = { live: () => null, status: () => ({ state: 'closed', lastActivityAt: '2026-10-11T15:42:00.000Z' }), activeFile: () => null, now: Date.now };
        const f = await fixture({ ...base, saved: () => ({ sidecarPath: 's.json', filepath: 'm.md' }), read: (p: string) => p === 's.json' ? sidecar : null });
        try {
            const r = await f.request('/transcript?sessionId=meeting_test&serverInstanceId=test-server');
            expect(r.status).toBe(200);
            expect(await r.json()).toMatchObject({ turns: [{ id: 4, elapsedMs: 5000, speaker: 'Nina', text: 'Saved words' }], elapsedMs: 60000, ended: true, endedAt: '2026-10-11T15:42:00.000Z', source: 'saved' });
            expect(refineActiveMeetingAsk).not.toHaveBeenCalled();
        }
        finally {
            await f.close();
        }
        const g = await fixture({ ...base, saved: () => null, read: () => null });
        try {
            const r = await g.request('/transcript?sessionId=meeting_test&serverInstanceId=test-server');
            expect(r.status).toBe(404);
            expect(await r.json()).toEqual({ error: 'meeting_transcript_unavailable' });
        }
        finally {
            await g.close();
        }
    });
    it('POST files/media adds a phone upload to the meeting file list and config advertises phoneFiles', async () => {
        const id = 'm_' + 'a'.repeat(24), record = { ref: { id, kind: 'user_document', category: 'document', mime: 'text/plain', width: 0, height: 0, createdAt: '2026-10-11T00:00:00Z', label: 'notes.txt' }, sha256: 'feedface00', createdAtMs: 1 };
        const media = () => ({ resolveUsable: (m: string) => { if (m !== id) throw new MediaStoreError('media_not_found', m); return { record, path: '/x' }; }, resolveModelDerivatives: () => ({ record, originalPath: '/x', text: 'Phone notes', imagePaths: [] }) });
        const f = await fixture(undefined, media);
        try {
            expect((await (await f.request('/config')).json()).capabilities.phoneFiles).toBe(true);
            const body = { sessionId: 'meeting_test', serverInstanceId: 'test-server', media: [{ id, name: 'Notes from phone' }] };
            const ok = await f.request('/files/media', body);
            expect(ok.status).toBe(200);
            expect(ok.headers.get('cache-control')).toBe('no-store');
            expect((await ok.json()).files).toEqual([{ id: 'phone_' + id, revision: 'feedface00', name: 'Notes from phone', status: 'ready', text: 'Phone notes', origin: 'phone' }]);
            const missing = await f.request('/files/media', { ...body, media: [{ id: 'm_' + 'b'.repeat(24) }] });
            expect(missing.status).toBe(404);
            expect(await missing.json()).toEqual({ error: 'media_not_found' });
            expect((await f.request('/files/media', { ...body, media: [] })).status).toBe(400);
            expect((await f.request('/files/media', body, 'POST', false)).status).toBe(401);
            expect(f.run).not.toHaveBeenCalled();
        }
        finally {
            await f.close();
        }
    });
    it('an unknown upload id is 404 media_not_found through the real media store, not a generic 503', async () => {
        const f = await fixture();
        try {
            const r = await f.request('/files/media', { sessionId: 'meeting_test', serverInstanceId: 'test-server', media: [{ id: 'm_000000000000000000000000' }] });
            expect(r.status).toBe(404);
            expect(await r.json()).toEqual({ error: 'media_not_found' });
        }
        finally {
            await f.close();
        }
    });
    it('PUT config {cosSearch} alone sets the COS search mode and GET config returns it', async () => {
        const f = await fixture();
        try {
            expect((await (await f.request('/config')).json())).toMatchObject({ cosSearch: 'meaning', capabilities: { cosSearchMode: true } });
            const put = await f.request('/config', { cosSearch: 'keyword' }, 'PUT');
            expect(put.status).toBe(200);
            expect(await put.json()).toMatchObject({ cosSearch: 'keyword', selected: { engine: 'claude', model: 'haiku' } });
            expect((await (await f.request('/config')).json()).cosSearch).toBe('keyword');
            const bad = await f.request('/config', { cosSearch: 'vector' }, 'PUT');
            expect(bad.status).toBe(400);
            expect(await bad.json()).toEqual({ error: 'invalid_cos_search' });
            expect((await f.request('/config', { cosSearch: 'meaning' }, 'PUT', false)).status).toBe(401);
        }
        finally {
            await f.close();
        }
    });
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
