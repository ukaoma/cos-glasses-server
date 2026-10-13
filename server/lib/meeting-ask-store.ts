import { mkdirSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { durableAtomicWriteFileSync } from './atomic-fs.js';
import { dataPath } from './data-dir.js';
import type { MeetingAskExchange, MeetingAskFile, MeetingAskSubmit, MeetingAskModel, MeetingAskCosSearch } from '../../shared/meeting-ask.js';
import { emptyOrientation } from './meeting-ask-orientation.js';
import type { MeetingAskOrientation } from '../../shared/meeting-ask.js';
import { AskError } from './live-cos-ask.js';
export const ASK_ID = /^[A-Za-z0-9_-]{8,100}$/;
export const ASK_SESSION = /^meeting_[A-Za-z0-9_-]{1,89}$/;
export interface AskRecord {
    version: 2;
    fingerprint: string;
    input: MeetingAskSubmit;
    exchange: MeetingAskExchange;
    orientation?: MeetingAskOrientation;
    publicTopics?: boolean;
    finalizedEvidence?: import('./meeting-ask-transcript.js').FinalizedAskEvidence;
}
export function askFingerprint(input: MeetingAskSubmit): string { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }
/** Synchronous fsync/rename transitions serialize inside the one server process. No await inside a write. */
export class MeetingAskStore {
    readonly root: string;
    constructor(root = dataPath('meeting-ask-v2')) { this.root = resolve(root); }
    private dir(name: string): string {
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
        if (lstatSync(this.root).isSymbolicLink())
            throw new AskError('unsafe_store', 503);
        const p = join(this.root, name);
        mkdirSync(p, { recursive: true, mode: 0o700 });
        if (lstatSync(p).isSymbolicLink())
            throw new AskError('unsafe_store', 503);
        return p;
    }
    private read<T>(path: string): T | null {
        try {
            const st = lstatSync(path);
            if (!st.isFile() || st.isSymbolicLink() || st.size > 3000000)
                throw new Error('unsafe');
            return JSON.parse(readFileSync(path, 'utf8')) as T;
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT')
                return null;
            throw new AskError('journal_unreadable', 503);
        }
    }
    private requestPath(id: string): string { if (!ASK_ID.test(id))
        throw new AskError('invalid_request_id'); return join(this.dir('requests'), id + '.json'); }
    get(id: string): AskRecord | null {
        const record = this.read<AskRecord>(this.requestPath(id));
        if (record && (record.version !== 2 || record.exchange?.requestId !== id || !record.input || typeof record.fingerprint !== 'string'))
            throw new AskError('journal_unreadable', 503);
        return record;
    }
    list(): AskRecord[] { return readdirSync(this.dir('requests')).filter(n => n.endsWith('.json')).map(n => this.get(n.slice(0, -5))!).filter(Boolean); }
    write(record: AskRecord): void {
        try {
            durableAtomicWriteFileSync(this.requestPath(record.exchange.requestId), JSON.stringify(record), { mode: 0o600 });
        }
        catch (e) {
            if (e instanceof AskError)
                throw e;
            throw new AskError('journal_write_failed', 507);
        }
    }
    /** Never silently evict user history. 2000 exchanges is a visible admission ceiling. */
    checkCapacity(): void { const names = readdirSync(this.dir('requests')).filter(n => n.endsWith('.json')); if (names.length >= 2000 || names.reduce((n, f) => n + lstatSync(join(this.dir('requests'), f)).size, 0) > 200000000)
        throw new AskError('history_storage_limit', 507); }
    transition(id: string, status: MeetingAskExchange['status'], patch: Partial<MeetingAskExchange> = {}): AskRecord {
        const record = this.get(id);
        if (!record)
            throw new AskError('request_not_found', 404);
        if (!['pending', 'running'].includes(record.exchange.status))
            return record;
        const at = new Date().toISOString();
        record.exchange = { ...record.exchange, ...patch, status, updatedAt: at, ...(!['pending', 'running'].includes(status) ? { completedAt: at } : {}) };
        this.write(record);
        return record;
    }
    recover(): void { for (const row of this.list())
        if (['pending', 'running'].includes(row.exchange.status))
            this.transition(row.exchange.requestId, 'interrupted', { error: 'server_restarted' }); }
    files(sessionId: string): MeetingAskFile[] {
        if (!ASK_SESSION.test(sessionId))
            throw new AskError('invalid_session_id');
        const files = this.read<MeetingAskFile[]>(join(this.dir('files'), sessionId + '.json')) ?? [];
        if (!Array.isArray(files))
            throw new AskError('journal_unreadable', 503);
        return files;
    }
    putFiles(sessionId: string, files: MeetingAskFile[]): MeetingAskFile[] {
        const merged = new Map(this.files(sessionId).map(f => [f.id, f]));
        for (const file of files)
            merged.set(file.id, file);
        if (merged.size > 100 || [...merged.values()].reduce((n, f) => n + Buffer.byteLength(f.text, 'utf8'), 0) > 500000)
            throw new AskError('file_context_limit', 413);
        const directory = this.dir('files'), name = sessionId + '.json', encoded = JSON.stringify([...merged.values()]);
        const entries = readdirSync(directory).filter(n => n.endsWith('.json'));
        let total = 0, previous = 0;
        for (const entry of entries) {
            const stat = lstatSync(join(directory, entry));
            if (!stat.isFile() || stat.isSymbolicLink())
                throw new AskError('journal_unreadable', 503);
            total += stat.size;
            if (entry === name) previous = stat.size;
        }
        const projected = total - previous + Buffer.byteLength(encoded, 'utf8');
        // Bound the whole file-context store, including meetings with no Ask history.
        // If an older store is already over budget, allow updates that reduce its size.
        if ((!entries.includes(name) && entries.length >= 2000) || (projected > 100000000 && projected > total))
            throw new AskError('file_context_storage_limit', 507);
        try {
            durableAtomicWriteFileSync(join(directory, name), encoded, { mode: 0o600 });
        }
        catch {
            throw new AskError('journal_write_failed', 507);
        }
        return [...merged.values()];
    }
    orientation(sessionId: string): MeetingAskOrientation {
        if (!ASK_SESSION.test(sessionId)) throw new AskError('invalid_session_id');
        const result = this.read<MeetingAskOrientation>(join(this.dir('orientation'), sessionId + '.json'));
        if (result && (!Number.isSafeInteger(result.revision) || result.revision < 0)) throw new AskError('journal_unreadable', 503);
        return result ?? emptyOrientation();
    }
    putOrientation(sessionId: string, orientation: MeetingAskOrientation): MeetingAskOrientation {
        this.orientation(sessionId);
        const dir = this.dir('orientation');
        if (readdirSync(dir).length >= 2000 && !this.read(join(dir, sessionId + '.json'))) throw new AskError('history_storage_limit', 507);
        try { durableAtomicWriteFileSync(join(dir, sessionId + '.json'), JSON.stringify(orientation), { mode: 0o600 }); }
        catch { throw new AskError('journal_write_failed', 507); }
        return orientation;
    }
    publicTopics(): boolean { return this.read<{enabled?:unknown}>(join(this.dir('config'),'public-topics.json'))?.enabled === true; }
    setPublicTopics(enabled:boolean): void { durableAtomicWriteFileSync(join(this.dir('config'),'public-topics.json'),JSON.stringify({enabled}),{mode:0o600}); }
    config(): MeetingAskModel { return this.read<MeetingAskModel>(join(this.dir('config'), 'model.json')) ?? { engine: 'claude', model: 'sonnet' }; }
    setConfig(model: MeetingAskModel): void { durableAtomicWriteFileSync(join(this.dir('config'), 'model.json'), JSON.stringify(model), { mode: 0o600 }); }
    /** 6.71.1. Anything but an explicit 'keyword' reads as the default, 'meaning'. */
    cosSearch(): MeetingAskCosSearch { return this.read<{ cosSearch?: unknown }>(join(this.dir('config'), 'search.json'))?.cosSearch === 'keyword' ? 'keyword' : 'meaning'; }
    setCosSearch(mode: MeetingAskCosSearch): void { try {
        durableAtomicWriteFileSync(join(this.dir('config'), 'search.json'), JSON.stringify({ cosSearch: mode }), { mode: 0o600 });
    }
    catch (e) {
        if (e instanceof AskError)
            throw e;
        throw new AskError('journal_write_failed', 507);
    } }
}
