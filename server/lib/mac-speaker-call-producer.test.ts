import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, existsSync, renameSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { dataPath } from './data-dir.js';
import { maintenanceLifecycle } from './maintenance-lifecycle.js';
import { MacSpeakerCallProducer, macSpeakerCallProducerEnabled, runMacSpeakerCallProducerChild } from './mac-speaker-call-producer.js';
import { MAC_CALL_PRODUCER_RUNTIME_FILES, freezeMacSpeakerCallSeed, readMacSpeakerCallPolicy, readMacSpeakerCallProducerFile, retainMacSpeakerCallNative, validateMacSpeakerCallPending, type MacSpeakerCallPolicyAdmission, type MacSpeakerCallProducerRequest } from './mac-speaker-call-producer-worker.js';
import { SHADOW_MODEL_FILES, SHADOW_MODEL_REPO, SHADOW_MODEL_REVISION, SHADOW_REVISION_MARKER } from './speaker-shadow-models.js';
const roots: string[] = [], sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const r of roots.splice(0))
    rmSync(r, { recursive: true, force: true }); });
function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'call-producer-')));
    roots.push(root);
    const captureId = `mac_synthetic_${root.split('/').at(-1)}`, dir = join(root, captureId);
    mkdirSync(dir);
    const sidecarPath = join(root, 'meeting.g2-chunks.json'), ledgerPath = join(root, 'ledger.jsonl'), policyPath = join(root, 'admission.json');
    const doc = { sessionId: captureId, sourceType: 'mac_system_audio', finalizationState: 'complete', chunks: [], chunkEntries: [] };
    writeFileSync(sidecarPath, JSON.stringify(doc));
    const modelManifestPath = join(root, 'models.json'), model = { repository: SHADOW_MODEL_REPO, revision: SHADOW_MODEL_REVISION, files: Object.fromEntries([{ path: SHADOW_REVISION_MARKER.path, sha256: SHADOW_REVISION_MARKER.sha256 }, ...SHADOW_MODEL_FILES].map(m => [`speaker-diarization/${m.path}`, m.sha256])) };
    writeFileSync(modelManifestPath, JSON.stringify(model));
    const review = join(root, 'review.json');
    writeFileSync(review, 'SYNTHETIC UNIT TEST ONLY; no real admission, native execution, model files or human truth');
    const policy: MacSpeakerCallPolicyAdmission = { version: 1, kind: 'mac-speaker-call-policy-admission', admission: 'qualified', scope: 'AUTOMATIC_CLOSED_CALL_ANONYMOUS_ESTIMATE', policy: 'fluid256-call-view-v1', projectionPolicy: 'anonymous-estimate', review: { path: review, sha256: sha(readFileSync(review)), reviewer: 'SYNTHETIC UNIT TEST ONLY' }, runtimeFiles: Object.fromEntries(MAC_CALL_PRODUCER_RUNTIME_FILES.map(name => [name, sha(readFileSync(new URL(name, import.meta.url)))])), cliSHA256: 'c'.repeat(64), modelSHA256: sha(readFileSync(modelManifestPath)), modelManifestPath };
    const request: MacSpeakerCallProducerRequest = { root, captureId, sidecarPath, ledgerPath, policyPath, policySHA256: '', humanJournalPath: join(root, 'meeting.speaker-call-human-transaction.json') };
    function savePolicy() { writeFileSync(policyPath, JSON.stringify(policy)); request.policySHA256 = sha(readFileSync(policyPath)); }
    savePolicy();
    return { root, dir, captureId, sidecarPath, ledgerPath, doc, policy, request, savePolicy };
}
async function flush() { for (let i = 0; i < 8; i++)
    await Promise.resolve(); }
function lifecycle() { const f = fixture(), child = Object.assign(new EventEmitter(), { pid: 123456, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() }) as unknown as ChildProcess; return { f, child, job: { action: 'freeze' as const, request: f.request }, resources: async () => ({ availableBytes: 20 * 1024 ** 3, swapBytes: 0, rssBytes: 1024 }), spawn: () => child }; }
describe('reviewed closed-call producer policy and immutable seed', () => {
    it('is independently default OFF and never follows live/shadow switches', () => { expect(macSpeakerCallProducerEnabled({ COS_SPEAKER_SHADOW: '1', COS_MAC_SPEAKER_LIVE: '1' })).toBe(false); expect(macSpeakerCallProducerEnabled({ COS_MAC_SPEAKER_CALL_PRODUCER: '1' })).toBe(true); });
    it('freezes exact completed BASE once and preserves generation after restart', () => { const f = fixture(), before = readFileSync(f.sidecarPath), first = freezeMacSpeakerCallSeed(f.request), second = freezeMacSpeakerCallSeed(f.request); expect(second).toEqual(first); expect(readFileSync(first.seedPath)).toEqual(before); expect(readFileSync(f.sidecarPath)).toEqual(before); expect(existsSync(f.ledgerPath)).toBe(false); });
    for (const kind of ['scope', 'review', 'code', 'model'] as const)
        it(`refuses unapproved or drifted ${kind}`, () => { const f = fixture(); if (kind === 'scope')
            f.policy.scope = 'PRIVATE_COPY_ROUNDTRIP_ONLY' as any; if (kind === 'review')
            f.policy.review.sha256 = 'f'.repeat(64); if (kind === 'code')
            f.policy.runtimeFiles['speaker-shadow.ts'] = 'e'.repeat(64); if (kind === 'model')
            f.policy.modelSHA256 = 'd'.repeat(64); f.savePolicy(); expect(() => freezeMacSpeakerCallSeed(f.request)).toThrow(); expect(existsSync(join(f.dir, 'original.json'))).toBe(false); });
    for (const surface of ['ledger', 'nested-marker', 'human-overlay', 'human-journal'] as const)
        it(`declines missing seed after ${surface} history`, () => { const f = fixture(); if (surface === 'ledger') {
            mkdirSync(dirname(f.ledgerPath), { recursive: true });
            writeFileSync(f.ledgerPath, '{"phase":"confirmed"}\n');
        } if (surface === 'nested-marker') {
            f.doc.chunks = [{ segments: [{ speakerOrigin: 'manual' }] }] as any;
            writeFileSync(f.sidecarPath, JSON.stringify(f.doc));
        } if (surface === 'human-overlay')
            writeFileSync(join(f.root, 'meeting.speaker-call-human.json'), '{}'); if (surface === 'human-journal')
            writeFileSync(f.request.humanJournalPath, '{"phase":"complete"}'); try {
            expect(() => freezeMacSpeakerCallSeed(f.request)).toThrow('human_history_without_seed');
        }
        finally {
            if (existsSync(f.ledgerPath))
                rmSync(f.ledgerPath);
        } expect(existsSync(join(f.dir, 'original.json'))).toBe(false); });
    it('never reclaims an existing human/capture lock or incomplete human transaction', () => { const f = fixture(), lock = join(f.root, `.${f.captureId}.speaker-call.lock`); writeFileSync(lock, '{"pid":2147483647,"kind":"human"}'); expect(() => freezeMacSpeakerCallSeed(f.request)).toThrow('capture_locked'); rmSync(lock); writeFileSync(f.request.humanJournalPath, '{"phase":"partial"}'); expect(() => freezeMacSpeakerCallSeed(f.request)).toThrow('human_transaction_pending'); });
    it('rejects seed tampering and safely completes an unpublished identical orphan seed', () => { const f = fixture(); writeFileSync(join(f.dir, 'original.json'), readFileSync(f.sidecarPath)); const first = freezeMacSpeakerCallSeed(f.request); chmodSync(first.seedPath, 0o600); writeFileSync(first.seedPath, 'changed'); expect(() => freezeMacSpeakerCallSeed(f.request)).toThrow('seed_integrity'); });
    it('rejects old fd bytes when the path is replaced immediately after open', () => { const f = fixture(), path = join(f.root, 'race.txt'); writeFileSync(path, 'before'); const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs'), realOpen = fs.openSync; let raced = false; fs.openSync = ((p: any, ...args: any[]) => { const fd = (realOpen as any)(p, ...args); if (p === path && !raced) {
        raced = true;
        renameSync(path, `${path}.old`);
        writeFileSync(path, 'after!');
    } return fd; }) as typeof fs.openSync; syncBuiltinESMExports(); try {
        expect(() => readMacSpeakerCallProducerFile(path, 100)).toThrow('fd_path_drift');
    }
    finally {
        fs.openSync = realOpen;
        syncBuiltinESMExports();
    } expect(readFileSync(path, 'utf8')).toBe('after!'); });
    it('binds resumed work to the exact target, native receipt, cursor and intent', () => { const f = fixture(), ref = { captureId: f.captureId, path: join(f.dir, 'native-example', 'receipt.json'), sha256: 'a'.repeat(64) }, pending = { captureId: f.captureId, sidecarPath: f.sidecarPath, policySHA256: f.request.policySHA256, nativeRefSHA256: ref.sha256, cursorSHA256: 'b'.repeat(64), intentSHA256: 'c'.repeat(64), directory: join(f.dir, 'transactions', 'tx'), packetPath: join(f.root, 'meeting.speaker-call.json'), statePath: join(f.root, 'meeting.speaker-call-state.json'), publication: { packetSHA256: 'd'.repeat(64), stateFileSHA256: 'e'.repeat(64) } }; expect(() => validateMacSpeakerCallPending(pending, f.request, ref, pending.cursorSHA256)).not.toThrow(); for (const change of [{ sidecarPath: join(f.root, 'other.g2-chunks.json') }, { packetPath: join(f.root, 'other.speaker-call.json') }, { statePath: join(f.root, 'other.speaker-call-state.json') }, { nativeRefSHA256: 'f'.repeat(64) }, { cursorSHA256: 'f'.repeat(64) }, { directory: join(f.root, 'unrelated') }, { intentSHA256: 'unsealed' }])
        expect(() => validateMacSpeakerCallPending({ ...pending, ...change }, f.request, ref, pending.cursorSHA256)).toThrow('pending_publication_target_or_source_drift'); });
    it('cannot retain an unclosed/offline-unproven native result', () => { expect(() => retainMacSpeakerCallNative({} as any, { nativePath: 'unused', embeddingPath: 'unused', exitCode: 0, closed: false, networkDenied: true })).toThrow('native_not_closed_offline'); });
});
describe('bounded child ownership and maintenance visibility without native', () => {
    it('does not spawn until resource and final admission both pass', async () => { const x = lifecycle(), spawn = vi.fn(x.spawn); expect((await runMacSpeakerCallProducerChild(x.job, { enabled: () => true, admit: () => true, resources: async () => null, spawn })).status).toBe('deferred'); expect(spawn).not.toHaveBeenCalled(); let open = true; await runMacSpeakerCallProducerChild(x.job, { enabled: () => true, admit: () => open, resources: async () => { open = false; return { availableBytes: 20 * 1024 ** 3, swapBytes: 0 }; }, spawn }); expect(spawn).not.toHaveBeenCalled(); });
    it('holds its maintenance lease until confirmed close after cancellation', async () => { vi.useFakeTimers(); const x = lifecycle(), kill = vi.fn(), before = maintenanceLifecycle.snapshot().activeByKind.mac_speaker_call ?? 0; let enabled = true, settled = false; const p = runMacSpeakerCallProducerChild(x.job, { enabled: () => enabled, admit: () => true, resources: x.resources, spawn: x.spawn, kill }); await flush(); expect(maintenanceLifecycle.snapshot().activeByKind.mac_speaker_call).toBe(before + 1); enabled = false; await vi.advanceTimersByTimeAsync(251); p.then(() => { settled = true; }); await Promise.resolve(); expect(kill).toHaveBeenCalledWith(x.child.pid); expect(settled).toBe(false); x.child.emit('close', null, 'SIGKILL'); expect((await p).status).toBe('deferred'); expect(maintenanceLifecycle.snapshot().activeByKind.mac_speaker_call ?? 0).toBe(before); });
    it('rejects an absolute late close even when timer callback has not run', async () => { const x = lifecycle(); let now = 0; const p = runMacSpeakerCallProducerChild(x.job, { enabled: () => true, admit: () => true, resources: x.resources, spawn: x.spawn, now: () => now, kill: vi.fn() }); await flush(); now = 10001; x.child.stdout!.emit('data', Buffer.from('{"status":"frozen"}')); x.child.emit('close', 0, null); expect((await p).reason).toBe('worker_deadline'); });
    it('accepts one bounded result only after close and permits the next child', async () => { const x = lifecycle(), p = runMacSpeakerCallProducerChild(x.job, { enabled: () => true, admit: () => true, resources: x.resources, spawn: x.spawn }); await flush(); x.child.stdout!.emit('data', Buffer.from('{"status":"frozen","result":{}}')); x.child.emit('close', 0, null); expect((await p).status).toBe('frozen'); expect((await runMacSpeakerCallProducerChild(x.job, { enabled: () => false })).status).toBe('deferred'); });
});
describe('durable notifications and untrusted queue paths', () => {
    function coordinator(f: ReturnType<typeof fixture>, extra: Record<string, any> = {}) { const requestNative = vi.fn(); return { requestNative, p: new MacSpeakerCallProducer({ root: f.root, enabled: () => true, admit: () => false, requestNative, run: async () => ({ status: 'frozen' }), ...extra }) }; }
    it('retains a deferred first seed notification durably for idle resume', async () => { const f = fixture(), { p } = coordinator(f, { run: async () => ({ status: 'deferred', reason: 'producer_child_busy' }) }); await expect(p.finalized({ sessionId: f.captureId, sidecarPath: f.sidecarPath })).resolves.toBeUndefined(); const q = JSON.parse(readFileSync(join(f.root, 'producer-queue.json'), 'utf8')); expect(q.queue[0].action).toBe('freeze'); expect(q.queue[0].attempts).toBe(0); });
    it('catches rejected shared-native requests and stores a bounded retry', async () => { const f = fixture(), { p } = coordinator(f, { requestNative: () => Promise.reject(Error('synthetic rejection')) }); await expect(p.finalized({ sessionId: f.captureId, sidecarPath: f.sidecarPath })).resolves.toBeUndefined(); expect(JSON.parse(readFileSync(join(f.root, 'producer-queue.json'), 'utf8')).queue[0].action).toBe('freeze'); });
    for (const contents of [null, 'not json', '{"sidecarPath":"/outside"}'])
        it(`never throws or adopts ${contents === null ? 'missing' : 'corrupt'} targets on native notification`, () => { const f = fixture(), { p } = coordinator(f), dir = join(f.dir, 'native-11111111-1111-4111-8111-111111111111'); mkdirSync(dir); const path = join(dir, 'receipt.json'); writeFileSync(path, '{}'); if (contents !== null)
            writeFileSync(join(f.dir, 'targets.json'), contents); expect(() => p.nativeExport({ captureId: f.captureId, path, sha256: sha('{}') })).not.toThrow(); expect(existsSync(join(f.root, 'producer-queue.json'))).toBe(false); if (contents !== null)
            expect(readFileSync(join(f.dir, 'targets.json'), 'utf8')).toBe(contents); });
    it('reports cached refresh unavailable without mutating files or requesting native', async () => { const f = fixture(), request = { ...f.request, ledgerPath: dataPath('meeting-corrections', `${f.captureId}.jsonl`) }, requestNative = vi.fn(), { p } = coordinator(f, { requestNative }); const before = readFileSync(f.sidecarPath); expect(await p.refreshAvailability(f.captureId, f.sidecarPath)).toMatchObject({ available: false, reason: 'copy_unregistered' }); writeFileSync(join(f.dir, 'targets.json'), JSON.stringify([request])); expect(await p.refreshAvailability(f.captureId, f.sidecarPath)).toMatchObject({ available: false, reason: 'cached_native_missing' }); expect(await p.refreshAvailability(f.captureId, join(f.root, 'unregistered.g2-chunks.json'))).toMatchObject({ available: false, reason: 'copy_unregistered' }); const dir = join(f.dir, 'native-11111111-1111-4111-8111-111111111111'); mkdirSync(dir); const nativePath = join(dir, 'native.json'), embeddingPath = join(dir, 'embeddings.json'); writeFileSync(nativePath, '{}'); writeFileSync(embeddingPath, '[]'); const body = { version: 1, kind: 'mac-speaker-call-native-export', request, nativePath, embeddingPath, nativeSHA256: sha('{}'), embeddingSHA256: sha('[]'), execution: { closed: true, exitCode: 0, networkDenied: true, nativeAuthenticated: false } }, bytes = JSON.stringify({ ...body, artifactSHA256: sha(JSON.stringify(body)) }), path = join(dir, 'receipt.json'); writeFileSync(path, bytes); writeFileSync(join(f.dir, 'native-latest.json'), JSON.stringify({ captureId: f.captureId, path, sha256: sha(bytes) })); expect(await p.refreshAvailability(f.captureId, f.sidecarPath)).toEqual({ available: true, reason: 'cached_refresh_available' }); writeFileSync(f.request.policyPath, 'changed policy'); expect((await p.refreshAvailability(f.captureId, f.sidecarPath)).available).toBe(false); expect(requestNative).not.toHaveBeenCalled(); expect(existsSync(join(f.root, 'producer-queue.json'))).toBe(false); expect(readFileSync(f.sidecarPath)).toEqual(before); });
    it('declines cached refresh when the independent producer switch is off', async () => { const f = fixture(), { p } = coordinator(f, { enabled: () => false }); expect(await p.refreshAvailability(f.captureId, f.sidecarPath)).toEqual({ available: false, reason: 'producer_disabled' }); });
    it('quarantines corrupt resume queue bytes without treating them as worker paths', () => { const f = fixture(), run = vi.fn(), { p } = coordinator(f, { run }); const path = join(f.root, 'producer-queue.json'), bytes = JSON.stringify({ version: 1, queue: [{ action: 'publish', request: { sidecarPath: '/outside/private.json' } }] }); writeFileSync(path, bytes); expect(() => p.resume()).not.toThrow(); expect(run).not.toHaveBeenCalled(); expect(readFileSync(path, 'utf8')).toBe(bytes); });
});
