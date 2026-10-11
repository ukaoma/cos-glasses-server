import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingAskRuntime, normalizeAskFiles, MEETING_ASK_WEB_SYSTEM } from './meeting-ask-runtime.js';
import { MeetingAskStore } from './meeting-ask-store.js';
import { exportMeetingAsk } from '../routes/meeting-ask.js';
const base = { requestId: 'request_12345678', sessionId: 'meeting_test', serverInstanceId: 'server-one', action: 'ask' as const, question: 'What was decided?', elapsedMs: 1000, turns: [{ id: 0, elapsedMs: 0, speaker: 'Person', text: 'We will review Friday.' }] };
function fixture(overrides: Record<string, unknown> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'ask-test-')), store = new MeetingAskStore(dir), release = vi.fn(), run = vi.fn(async (_model: unknown, _prompt: string) => ({ text: JSON.stringify({ sections: [{ label: 'So what', text: 'Review Friday [T1]' }], searchQuery: null }), model: 'claude-haiku-5-5' }));
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
    it('refines the direct Control payload once and freezes citations, files and retry identity', async () => {
        const refine = vi.fn(input => ({ input: { ...input, turns: [
            { id: 0, elapsedMs: 0, speaker: 'Unidentified', text: 'The budget is 14000. It has not been approved.' },
            { id: 6, elapsedMs: 36000, speaker: 'Person', text: 'Latest correction: review Monday.' },
        ] }, notices: ['Earlier passages were refined from recorded audio.'] }));
        const f = fixture({ refine });
        const submitted = { ...base, elapsedMs: 42000, turns: [
            { id: 0, elapsedMs: 0, speaker: 'Person', text: 'The budget is 14000.' },
            { id: 6, elapsedMs: 36000, speaker: 'Person', text: 'Latest correction: review Monday.' },
        ] };
        const original = JSON.stringify(submitted);
        try {
            f.runtime.putFiles(base.sessionId, 'server-one', [{ id: 'file_12345678', revision: '1', name: 'Plan', status: 'ready', text: 'Owner is Nina' }]);
            await f.runtime.submit(submitted);
            refine.mockImplementation(input => ({ input, notices: [] }));
            const e = await terminal(f);
            expect(f.run.mock.calls[0][1]).toContain('It has not been approved');
            expect(f.run.mock.calls[0][1]).toContain('review Monday');
            expect(f.run.mock.calls[0][1]).toContain('Owner is Nina');
            expect(e.sources.find(s => s.kind === 'transcript' && s.turnId === 0)?.text).toContain('not been approved');
            expect(e.notices).toContain('Earlier passages were refined from recorded audio.');
            expect(f.store.get(base.requestId)?.input.turns).toEqual(submitted.turns);
            expect((await f.runtime.submit(submitted)).sources).toEqual(e.sources);
            expect(refine).toHaveBeenCalledTimes(1);
            expect(f.run).toHaveBeenCalledTimes(1);
            expect(JSON.stringify(submitted)).toBe(original);
        } finally { f.cleanup(); }
    });
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
        resolve({ text: '{"sections":[{"label":"So what","text":"late [T1]"}]}', model: 'haiku' });
        await new Promise(r => setTimeout(r, 10));
        expect(f.runtime.get(base.requestId).status).toBe('cancelled');
        expect(f.release).toHaveBeenCalledTimes(1);
    }
    finally {
        f.cleanup();
    } });
    it('legacy Ask returns sections and passes the wearer to the model', async () => { const f = fixture({ wearer: () => 'Sam Rivera' }); try {
        const result = await f.runtime.legacy({ ...base, history: [] }, new AbortController().signal);
        expect(result.sections).toEqual([{ label: 'So what', text: 'Review Friday [T1]', sources: ['T1'] }]);
        expect(result.answer).toBe('**So what:** Review Friday [T1]');
        expect(JSON.parse(f.run.mock.calls[0][1]).wearer).toBe('Sam Rivera');
        await f.runtime.submit(base);
        expect(JSON.parse(f.run.mock.calls[1][1]).wearer).toBe('Sam Rivera');
        expect((await terminal(f)).sections).toEqual(result.sections);
    }
    finally {
        f.cleanup();
    } });
    it('a model answering in the old {"answer"} shape completes with one So what row and the skim notice', async () => { const f = fixture({ run: vi.fn(async () => ({ text: JSON.stringify({ answer: 'Review Friday [T1]' }), model: 'codex:gpt (requested)' })) }); try {
        await f.runtime.submit(base);
        const e = await terminal(f);
        expect(e.status).toBe('completed');
        expect(e.sections).toEqual([{ label: 'So what', text: 'Review Friday [T1]', sources: ['T1'] }]);
        expect(e.notices).toContain('This answer was not in the skim format.');
    }
    finally {
        f.cleanup();
    } });
    it('legacy and v2 share single flight', async () => { let resolve!: (v: any) => void; const f = fixture({ run: () => new Promise(r => { resolve = r; }) }); try {
        await f.runtime.submit(base);
        await expect(f.runtime.legacy({ ...base, history: [] }, new AbortController().signal)).rejects.toThrow('busy');
        await expect(f.runtime.submit({ ...base, requestId: 'request_98765432' })).rejects.toThrow('busy');
        resolve({ text: '{"sections":[{"label":"So what","text":"yes [T1]"}]}', model: 'haiku' });
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
        expect(e.sections).toEqual([{ label: 'So what', text: 'Review Friday [T1]', sources: ['T1'] }]);
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
// 6.70.0 public web gate, end to end through the runtime with a fake web adapter.
describe('meeting Ask public web lookups', () => {
    const webSources = (query: string) => ({ sources: [{ id: 'W0', kind: 'web' as const, title: `Web search summary: ${query}`, text: 'Altcoin Daily is a crypto news YouTube channel.', retrievedAt: '2026-10-10T00:00:00.000Z', retrievalId: 'r1' }, { id: 'W1', kind: 'web' as const, title: 'Altcoin Daily - YouTube', url: 'https://www.youtube.com/@AltcoinDaily', text: 'Crypto news channel.', retrievedAt: '2026-10-10T00:00:00.000Z', retrievalId: 'r1' }], notices: [] });
    function webFixture(replies: string[], extra: Record<string, unknown> = {}) {
        const run = vi.fn(async (_model: unknown, _prompt: string, _system?: string) => ({ text: replies.shift() ?? JSON.stringify({ sections: [{ label: 'So what', text: 'Done [T1]' }], searchQuery: null }), model: 'claude-sonnet-5-5' }));
        const webSearch = vi.fn(async (query: string) => webSources(query));
        const f = fixture({ run, webSearch, webCapability: () => ({ available: true, engine: 'claude:haiku' }), ...extra });
        return { ...f, run, webSearch };
    }
    let seq = 0;
    /** Journal rows written directly, as an earlier Ask in this or another meeting would have left them. */
    function seed(f: ReturnType<typeof fixture>, question: string, opts: { status?: string; action?: string; sessionId?: string; answer?: string } = {}) {
        const requestId = `request_seed${String(++seq).padStart(4, '0')}`, at = new Date(Date.UTC(2026, 9, 10, 1, 0, seq)).toISOString();
        const input = { ...base, requestId, sessionId: opts.sessionId ?? base.sessionId, action: (opts.action ?? 'ask') as any, question, model: { engine: 'claude' as const, model: 'haiku' }, files: [] };
        f.store.write({ version: 2, fingerprint: 'seed', input, exchange: { requestId, sessionId: input.sessionId, serverInstanceId: 'server-one', action: input.action, question, status: (opts.status ?? 'completed') as any, createdAt: at, updatedAt: at, selectedModel: input.model, sources: [], notices: [], throughMs: 0, files: [], ...(opts.answer ? { answer: opts.answer } : {}) } });
    }
    const ask = (question: string, extra: Record<string, unknown> = {}) => ({ ...base, requestId: `request_${Math.random().toString(36).slice(2, 12)}`, question, model: { engine: 'claude', model: 'sonnet' }, ...extra });
    const webAsk = (searchQuery: string) => JSON.stringify({ sections: [], searchQuery, searchScope: 'web' });
    async function settle(f: ReturnType<typeof fixture>, question: string, extra: Record<string, unknown> = {}) { const a = ask(question, extra); await f.runtime.submit(a); return terminal(f, a.requestId); }
    it('observed 1: "Let\'s try with sonnet. Who is alt coin daily?" reaches the web with the planner\'s query', async () => {
        const f = webFixture([webAsk('Altcoin Daily'), JSON.stringify({ sections: [{ label: 'So what', text: 'A crypto news channel. [W1]' }], searchQuery: null })]);
        try {
            const e = await settle(f, "Let's try with sonnet. Who is alt coin daily?");
            expect(e.status).toBe('completed');
            expect(f.webSearch.mock.calls.map(c => c[0])).toEqual(['Altcoin Daily']);
            expect(e.notices.join(' ')).not.toContain('withheld');
            expect(e.sources.some(s => s.url === 'https://www.youtube.com/@AltcoinDaily')).toBe(true);
            expect(f.run.mock.calls[0][2]).toContain(MEETING_ASK_WEB_SYSTEM);
        } finally { f.cleanup(); }
    });
    it('observed 2: "our competitor Acme" searches without the possessive', async () => {
        const f = webFixture([webAsk('our competitor Acme latest news'), JSON.stringify({ sections: [{ label: 'So what', text: 'News. [W1]' }], searchQuery: null })]);
        try {
            await settle(f, "What's the latest news on our competitor Acme?");
            expect(f.webSearch.mock.calls.map(c => c[0])).toEqual(['competitor Acme latest news']);
        } finally { f.cleanup(); }
    });
    it('observed 3: "Run the web search" borrows the user\'s earlier question from the journal', async () => {
        const f = webFixture([JSON.stringify({ sections: [{ label: 'So what', text: 'From the screenshot only. [T1]' }], searchQuery: null }), webAsk('Altcoin Daily'), JSON.stringify({ sections: [{ label: 'So what', text: 'A crypto news channel. [W1]' }], searchQuery: null })]);
        try {
            expect((await settle(f, 'Who is alt coin daily?')).status).toBe('completed');
            expect(f.webSearch).not.toHaveBeenCalled();
            const e = await settle(f, 'Run the web search');
            expect(f.webSearch.mock.calls.map(c => c[0])).toEqual(['Altcoin Daily']);
            expect(e.answer).toContain('[W1]');
        } finally { f.cleanup(); }
    });
    it('an explicit follow-up searches the user\'s own words when the planner answers without the web', async () => {
        const f = webFixture([JSON.stringify({ sections: [{ label: 'So what', text: 'I cannot search.' }], searchQuery: null }), JSON.stringify({ sections: [{ label: 'So what', text: 'A crypto news channel. [W1]' }], searchQuery: null })]);
        try {
            seed(f, "Let's try with sonnet. Who is alt coin daily?", { status: 'failed' });
            const e = await settle(f, 'Run the web search');
            expect(f.webSearch.mock.calls.map(c => c[0])).toEqual(['alt coin daily']);
            expect(f.run).toHaveBeenCalledTimes(2);
            expect(e.notices.join(' ')).toContain('You asked for the web');
        } finally { f.cleanup(); }
    });
    it('an explicit request whose query added screenshot words searches only the user\'s words', async () => {
        const f = webFixture([webAsk('Altcoin Daily crypto MASSIVE WARNING'), JSON.stringify({ sections: [{ label: 'So what', text: 'A channel. [W1]' }], searchQuery: null })]);
        try {
            f.runtime.putFiles(base.sessionId, 'server-one', [{ id: 'file_12345678', revision: '1', name: 'Screenshot', status: 'ready', text: 'Altcoin Daily MASSIVE WARNING 4.9K views crypto' }]);
            const e = await settle(f, 'Search the web for alt coin daily');
            expect(f.webSearch.mock.calls.map(c => c[0])).toEqual(['alt coin daily']);
            expect(e.notices.join(' ')).toContain('Searched the web for your words "alt coin daily"');
        } finally { f.cleanup(); }
    });
    it('never sends a transcript-only name, an OCR-only word, or a name from an earlier answer', async () => {
        const cases: Array<[string, string, (f: ReturnType<typeof webFixture>) => void, Record<string, unknown>]> = [
            ['Who are these people?', 'Joseph Wharton Charles Elliot', () => {}, { turns: [{ id: 0, elapsedMs: 0, speaker: 'Person', text: 'Joseph Wharton and Charles Elliot founded the school.' }] }],
            ['Who is alt coin daily?', 'Altcoin Daily MASSIVE WARNING', f => f.runtime.putFiles(base.sessionId, 'server-one', [{ id: 'file_12345678', revision: '1', name: 'Screenshot', status: 'ready', text: 'Altcoin Daily MASSIVE WARNING 4.9K views' }]), {}],
            ['Run the web search', 'Joseph Wharton', f => seed(f, 'Who are these people?', { answer: 'The transcript names Joseph Wharton [T1].' }), {}],
        ];
        for (const [question, query, prepare, extra] of cases) {
            const f = webFixture([webAsk(query), JSON.stringify({ sections: [{ label: 'So what', text: 'Not verified. [T1]' }], searchQuery: null })]);
            try {
                prepare(f);
                const e = await settle(f, question, extra);
                expect(f.webSearch, question).not.toHaveBeenCalled();
                expect(e.notices.join(' ')).toContain('words you did not type');
            } finally { f.cleanup(); }
        }
    });
    it('borrows only this meeting\'s last three completed or failed free-form questions', async () => {
        const cases: Array<[string, (f: ReturnType<typeof fixture>) => void, boolean]> = [
            ['failed question counts', f => seed(f, 'Who is Acme?', { status: 'failed' }), true],
            ['cancelled question does not', f => seed(f, 'Who is Acme?', { status: 'cancelled' }), false],
            ['interrupted question does not', f => seed(f, 'Who is Acme?', { status: 'interrupted' }), false],
            ['another meeting does not', f => seed(f, 'Who is Acme?', { sessionId: 'meeting_other' }), false],
            ['a preset row does not', f => seed(f, 'Who is Acme?', { action: 'summary' }), false],
            ['older than the last three does not', f => { seed(f, 'Who is Acme?'); seed(f, 'Who are they?'); seed(f, 'Who is that?'); seed(f, 'And them?'); }, false],
        ];
        for (const [name, prepare, searched] of cases) {
            const f = webFixture([webAsk('Acme'), JSON.stringify({ sections: [{ label: 'So what', text: 'Answer. [T1]' }], searchQuery: null })]);
            try {
                prepare(f);
                await settle(f, 'search that');
                expect(f.webSearch.mock.calls.length, name).toBe(searched ? 1 : 0);
            } finally { f.cleanup(); }
        }
    });
    it('an explicit web request that cannot be searched says why up front and searches nothing', async () => {
        for (const [question, phrase] of [['Search the web for sk-abcdefghijklmnop docs', 'key or token'], ["Search the web for my wife's birthday", 'personal detail'], ['Run the web search', 'nothing specific to search']]) {
            const f = webFixture([JSON.stringify({ sections: [{ label: 'So what', text: 'Answered without the web. [T1]' }], searchQuery: null })]);
            try {
                const e = await settle(f, question);
                expect(f.webSearch, question).not.toHaveBeenCalled();
                expect(f.run, question).toHaveBeenCalledTimes(1);
                expect(e.notices.join(' '), question).toContain(phrase);
                expect(e.notices.join(' '), question).not.toContain('You asked for the web');
            } finally { f.cleanup(); }
        }
    });
    it('still withholds secrets and personal categories, with the reason', async () => {
        for (const [question, query, phrase] of [['Search the web for sk-abcdefghijklmnop docs', 'docs', 'key or token'], ['What is the average salary at Apple?', 'Apple salary', 'personal detail'], ["Who is Sam's wife?", 'Sam wife', 'personal detail']]) {
            const f = webFixture([webAsk(query), JSON.stringify({ sections: [{ label: 'So what', text: 'No. [T1]' }], searchQuery: null })]);
            try {
                const e = await settle(f, question);
                expect(f.webSearch, question).not.toHaveBeenCalled();
                expect(e.notices.join(' ')).toContain(phrase);
            } finally { f.cleanup(); }
        }
    });
});
