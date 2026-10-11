import { Router, type Response } from 'express';
import { AskError } from '../lib/live-cos-ask.js';
import { meetingAskRuntime, type MeetingAskRuntime } from '../lib/meeting-ask-runtime.js';
import { refineActiveMeetingAsk } from '../lib/meeting-ask-refinement.js';
import { getSessionChunkEntries, getSessionStartTime, getMeetingSessionStatus } from './transcribe-stream.js';
import { resolveAskTranscript, readBoundedFile, type AskTranscriptSources } from '../lib/meeting-ask-transcript.js';
import { getMeetingStore } from '../lib/meeting-store.js';
import { dataPath } from '../lib/data-dir.js';
import { join } from 'node:path';
import { ASK_SESSION } from '../lib/meeting-ask-store.js';
import type { MeetingAskExchange, MeetingAskFile } from '../../shared/meeting-ask.js';
function failure(res: Response, error: unknown) { res.status(error instanceof AskError ? error.status : 503).json({ error: error instanceof AskError ? error.reason : 'meeting_assistant_unavailable' }); }
/** Safe Markdown export. Citations are namespaced to the request because T1 is answer-local. */
export function exportMeetingAsk(exchanges: MeetingAskExchange[], files: MeetingAskFile[]): string {
    const parts = ['## Meeting assistant history'];
    for (const e of exchanges) {
        parts.push(`### ${e.createdAt} · ${e.action}\n\nQuestion: ${e.question || e.action}\n\nStatus: ${e.status}\nModel: ${e.model ?? `${e.selectedModel.engine}:${e.selectedModel.model}`}\nTranscript through: ${e.throughMs} ms`);
        if (e.answer)
            parts.push(e.answer.replace(/\[([THFW]\d+)\]/g, (_, id) => `[${e.requestId}:${id}]`));
        for (const s of e.sources)
            parts.push(`[${e.requestId}:${s.id}] ${s.title}${s.url ? ` — ${s.url}` : ''}\n${s.text}`);
        if (e.notices.length)
            parts.push('Coverage: ' + e.notices.join(' '));
        if (e.error)
            parts.push('Outcome: ' + e.error);
    }
    parts.push('## Meeting files');
    const revisions = new Map<string, MeetingAskFile>();
    for (const e of exchanges)
        for (const f of e.files)
            if (!revisions.has(`${f.id}@${f.revision}`) || f.status === 'ready')
                revisions.set(`${f.id}@${f.revision}`, f);
    // Current removal/failure is lifecycle metadata, never a replacement for admitted evidence.
    for (const f of files) {
        const key = `${f.id}@${f.revision}`, admitted = revisions.get(key);
        if (!admitted)
            revisions.set(key, f);
        else if (admitted.status !== f.status)
            parts.push(`Current file status: ${f.name} (${f.status}) · ${key}\nHistorical admitted context is retained below.`);
    }
    for (const f of revisions.values())
        parts.push(`### ${f.name} (${f.status})\nReference: ${f.id}@${f.revision}\n${f.text || 'No extracted text available.'}`);
    const text = parts.join('\n\n');
    if (Buffer.byteLength(text, 'utf8') > 850000)
        throw new AskError('export_too_large', 413);
    return text;
}
const transcriptSources: AskTranscriptSources = {
    live: id => { const entries = getSessionChunkEntries(id), startTime = getSessionStartTime(id); return entries && startTime !== null ? { entries, startTime } : null; },
    status: id => getMeetingSessionStatus(id),
    activeFile: id => readBoundedFile(join(dataPath('active-sessions'), `${id}.json`)),
    saved: id => getMeetingStore().findBySessionId(id),
    read: readBoundedFile,
    now: Date.now,
};
export function createMeetingAskRouter(runtime: MeetingAskRuntime = meetingAskRuntime, transcripts: AskTranscriptSources = transcriptSources) {
    const router = Router();
    router.use((_q, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.get('/meeting-ask/config', async (_q, res) => { try {
        res.json(await runtime.config());
    }
    catch (e) {
        failure(res, e);
    } });
    router.put('/meeting-ask/config', async (req, res) => { try {
        res.json(await runtime.setConfig(req.body));
    }
    catch (e) {
        failure(res, e);
    } });
    router.get('/meeting-ask/context', async (req, res) => { try {
        const sessionId = String(req.query.sessionId ?? '');
        res.json(await runtime.context(sessionId, req.query.serverInstanceId, transcripts.live(sessionId)?.startTime ?? null));
    } catch (e) { failure(res, e); } });
    router.put('/meeting-ask/context', async (req, res) => { try {
        const sessionId = String(req.body?.sessionId ?? '');
        res.json({ orientation: await runtime.setContext(sessionId, req.body?.serverInstanceId, transcripts.live(sessionId)?.startTime ?? null, req.body) });
    } catch (e) { failure(res, e); } });
    router.post('/meeting-ask/requests', async (req, res) => { try {
        res.status(202).json({ exchange: await runtime.submit(req.body) });
    }
    catch (e) {
        failure(res, e);
    } });
    router.get('/meeting-ask/requests/:id', (req, res) => { try {
        res.json({ exchange: runtime.get(String(req.params.id)) });
    }
    catch (e) {
        failure(res, e);
    } });
    router.post('/meeting-ask/requests/:id/cancel', (req, res) => { try {
        res.json({ exchange: runtime.cancel(String(req.params.id), req.body?.serverInstanceId) });
    }
    catch (e) {
        failure(res, e);
    } });
    router.get('/meeting-ask/history', (req, res) => { try {
        const offset = Number(req.query.offset ?? 0), limit = Number(req.query.limit ?? 50);
        const order = req.query.order ?? 'asc';
        if (!Number.isFinite(offset) || !Number.isFinite(limit) || !['asc', 'desc'].includes(String(order)))
            throw new AskError('invalid_page');
        res.json(runtime.history(String(req.query.sessionId ?? ''), req.query.serverInstanceId, offset, limit, order as 'asc' | 'desc'));
    }
    catch (e) {
        failure(res, e);
    } });
    router.put('/meeting-ask/files', (req, res) => { try {
        res.json({ files: runtime.putFiles(req.body?.sessionId, req.body?.serverInstanceId, req.body?.files) });
    }
    catch (e) {
        failure(res, e);
    } });
    router.post('/meeting-ask/files/media', (req, res) => { try {
        res.json({ files: runtime.attachMedia(String(req.body?.sessionId ?? ''), req.body?.serverInstanceId, req.body?.media) });
    }
    catch (e) {
        failure(res, e);
    } });
    router.get('/meeting-ask/export', (req, res) => {
        try {
            const exchanges: MeetingAskExchange[] = [];
            let offset: number | null = 0;
            let files: MeetingAskFile[] = [];
            do {
                const page = runtime.history(String(req.query.sessionId ?? ''), req.query.serverInstanceId, offset, 100);
                exchanges.push(...page.exchanges);
                files = page.files;
                offset = page.nextOffset;
            } while (offset !== null);
            res.json({ text: exportMeetingAsk(exchanges, files) });
        }
        catch (e) {
            failure(res, e);
        }
    });
    router.get('/meeting-ask/transcript', (req, res) => {
        try {
            runtime.identity(req.query.serverInstanceId);
            const sessionId = String(req.query.sessionId ?? '');
            if (!ASK_SESSION.test(sessionId))
                throw new AskError('invalid_session_id');
            const snapshot = resolveAskTranscript(sessionId, transcripts);
            // Ended/saved transcripts keep the released resolver and source metadata.
            // Only a live snapshot may use the default-off HQ cache overlay.
            if (snapshot.source === 'live' && process.env.COS_MEETING_ASK_HQ_EVIDENCE === '1') {
                const refined = refineActiveMeetingAsk({ sessionId, action: 'catch_up', question: '',
                    elapsedMs: snapshot.elapsedMs, turns: snapshot.turns, history: [] });
                res.json({ ...snapshot, turns: refined.input.turns, notices: [...snapshot.notices, ...refined.notices] });
            } else res.json(snapshot);
        }
        catch (e) {
            failure(res, e);
        }
    });
    return router;
}
export const meetingAskRouter = createMeetingAskRouter();
