/** Guarded child-only closed-call consumer. Hashes establish integrity, never
 * native authentication. Automatic admission requires a separately provisioned
 * reviewed policy; this module cannot issue one or infer a human name. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { durableAtomicWriteFileSync } from './atomic-fs.js';
import { isMacSpeakerHumanProtected } from './mac-speaker-protection.js';
import { bindMacSpeakerShadowRepair } from './mac-speaker-shadow-repair.js';
import { reconcileMacSpeaker256Snapshot, validateMacSpeaker256State, type MacSpeaker256SnapshotInput, type MacSpeaker256State } from './mac-speaker-live-memory.js';
import { prepareMacSpeakerCallPacket } from './mac-speaker-call-view.js';
import { executeMacSpeakerCallPublication, prepareMacSpeakerCallPublication, hashMacSpeakerCallFileInventory, type MacSpeakerCallFrozenFile, type MacSpeakerCallQualification } from './mac-speaker-call-store.js';
import { readPcm16Wav, shadowEntries, type ShadowTimelineRow } from './speaker-shadow-timeline.js';
import { SHADOW_MODEL_FILES, SHADOW_MODEL_REPO, SHADOW_MODEL_REVISION, SHADOW_REVISION_MARKER } from './speaker-shadow-models.js';
const SHA = /^[a-f0-9]{64}$/;
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const seal = (v: unknown) => hash(JSON.stringify(v));
const fail = (message: string): never => { throw Error(`mac_call_producer_${message}`); };
export const MAC_CALL_PRODUCER_RUNTIME_FILES = [
    'mac-speaker-call-producer.ts', 'mac-speaker-call-producer-worker.ts', 'mac-speaker-call-store.ts', 'mac-speaker-call-view.ts',
    'mac-speaker-live-memory.ts', 'mac-speaker-shadow-repair.ts', 'mac-speaker-protection.ts', 'speaker-shadow.ts', 'speaker-shadow-worker.ts',
    'speaker-shadow-models.ts', 'speaker-shadow-decide.ts', 'speaker-shadow-timeline.ts', 'speaker-shadow-numeric.ts',
] as const;
export interface MacSpeakerCallPolicyAdmission {
    version: 1;
    kind: 'mac-speaker-call-policy-admission';
    admission: 'qualified';
    scope: 'AUTOMATIC_CLOSED_CALL_ANONYMOUS_ESTIMATE';
    policy: 'fluid256-call-view-v1';
    projectionPolicy: 'anonymous-estimate';
    review: {
        path: string;
        sha256: string;
        reviewer: string;
    };
    runtimeFiles: Record<string, string>;
    cliSHA256: string;
    modelSHA256: string;
    modelManifestPath: string;
}
export interface MacSpeakerCallProducerRequest {
    captureId: string;
    sidecarPath: string;
    ledgerPath: string;
    root: string;
    policyPath: string;
    policySHA256: string;
    humanJournalPath: string;
}
export interface MacSpeakerCallNativeRef {
    path: string;
    sha256: string;
    captureId: string;
}
type Pin = {
    path: string;
    sha256: string | null;
    stamp: string | null;
};
interface NativeContext {
    request: MacSpeakerCallProducerRequest;
    policy: MacSpeakerCallPolicyAdmission;
    generation: string;
    originalPath: string;
    pins: Pin[];
    rawAudio: MacSpeaker256SnapshotInput['rawAudio'];
    timeline: MacSpeaker256SnapshotInput['timeline'];
    cliPath: string;
    rawManifest: any;
    modelManifest: any;
    sourceJSON: string;
    ledgerJSONL: string;
}
interface NativeArtifact extends Omit<NativeContext, 'policy' | 'sourceJSON' | 'ledgerJSONL'> {
    version: 1;
    kind: 'mac-speaker-call-native-export';
    nativePath: string;
    embeddingPath: string;
    nativeSHA256: string;
    embeddingSHA256: string;
    execution: {
        exitCode: 0;
        closed: true;
        networkDenied: true;
        nativeAuthenticated: false;
    };
    artifactSHA256: string;
}
function canonical(path: string) { if (resolve(path) !== path)
    fail('canonical_path'); let parent = dirname(path); while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent)
        fail('canonical_path');
    parent = next;
} if (realpathSync(parent) !== parent)
    fail('canonical_path'); return path; }
function stamp(path: string) { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink())
    fail('regular_file'); return JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]); }
function bounded(path: string, max: number, absent = false): Buffer | null {
    canonical(path);
    let fd: number;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    catch (e) {
        if (absent && (e as NodeJS.ErrnoException).code === 'ENOENT')
            return null;
        throw e;
    }
    try {
        const s = fstatSync(fd), atStart = lstatSync(path), identity = (v: typeof s) => JSON.stringify([v.dev, v.ino, v.size, v.mtimeMs, v.ctimeMs]);
        if (!s.isFile() || s.size > max || !atStart.isFile() || atStart.isSymbolicLink() || identity(s) !== identity(atStart) || realpathSync(path) !== path)
            fail('fd_path_drift');
        const bytes = readFileSync(fd), after = fstatSync(fd), atEnd = lstatSync(path);
        if (bytes.length !== s.size || !atEnd.isFile() || atEnd.isSymbolicLink() || identity(after) !== identity(s) || identity(atEnd) !== identity(after) || realpathSync(path) !== path)
            fail('read_drift');
        return bytes;
    }
    finally {
        closeSync(fd);
    }
}
/** Bounded integrity read exposed for deterministic fd/path race regressions. */
export const readMacSpeakerCallProducerFile = bounded;
/** Pending work is scoped to one exact representation, never just a capture. */
export function validateMacSpeakerCallPending(p: any, r: MacSpeakerCallProducerRequest, ref: MacSpeakerCallNativeRef, cursorSHA256: string) {
    const stem = r.sidecarPath.replace(/\.g2-chunks\.json$/, ''), root = join(r.root, r.captureId, 'transactions');
    if (stem === r.sidecarPath || p.captureId !== r.captureId || p.sidecarPath !== r.sidecarPath || p.nativeRefSHA256 !== ref.sha256 || p.policySHA256 !== r.policySHA256 || p.cursorSHA256 !== cursorSHA256 || p.packetPath !== `${stem}.speaker-call.json` || p.statePath !== `${stem}.speaker-call-state.json` || typeof p.directory !== 'string' || dirname(p.directory) !== root || !SHA.test(p.intentSHA256) || !SHA.test(p.publication?.packetSHA256) || !SHA.test(p.publication?.stateFileSHA256))
        fail('pending_publication_target_or_source_drift');
}
function pin(path: string, max: number, absent = false): Pin { const before = existsSync(path) ? stamp(path) : null, b = bounded(path, max, absent), after = existsSync(path) ? stamp(path) : null; if (before !== after || (b === null) !== (after === null))
    fail('pin_drift'); return { path, sha256: b === null ? null : hash(b), stamp: after }; }
function checkPins(pins: Pin[]) { for (const p of pins) {
    const q = pin(p.path, 1024 * 1024 * 1024, p.sha256 === null);
    if (q.sha256 !== p.sha256 || q.stamp !== p.stamp)
        fail('source_drift');
} }
function put(path: string, bytes: string | Buffer) { canonical(path); const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o400); try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
}
finally {
    closeSync(fd);
} const d = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK); try {
    fsyncSync(d);
}
finally {
    closeSync(d);
} }
function captureDir(r: MacSpeakerCallProducerRequest) { if (!/^mac_[A-Za-z0-9_-]{1,100}$/.test(r.captureId) || realpathSync(r.root) !== r.root)
    fail('capture_path'); const dir = join(r.root, r.captureId); mkdirSync(dir, { recursive: true, mode: 0o700 }); if (realpathSync(dir) !== dir)
    fail('capture_symlink'); return dir; }
function producerLock(r: MacSpeakerCallProducerRequest) {
    const path = join(captureDir(r), 'producer.lock'), old = bounded(path, 4096, true);
    if (old) {
        const value = JSON.parse(old.toString());
        if (value.kind !== 'mac-speaker-call-producer' || value.captureId !== r.captureId || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.token !== 'string')
            fail('producer_lock_foreign');
        try {
            process.kill(value.pid, 0);
            fail('producer_lock_alive');
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
                throw e;
        }
        if (hash(bounded(path, 4096)!) !== hash(old))
            fail('producer_lock_drift');
        unlinkSync(path);
    }
    const bytes = JSON.stringify({ kind: 'mac-speaker-call-producer', captureId: r.captureId, pid: process.pid, token: randomUUID() });
    put(path, bytes);
    return () => { if (hash(bounded(path, 4096)!) !== hash(bytes))
        fail('producer_lock_owner_drift'); unlinkSync(path); };
}
function guardHuman(r: MacSpeakerCallProducerRequest, ownTransaction?: string) {
    const lock = join(dirname(r.sidecarPath), `.${r.captureId}.speaker-call.lock`);
    if (existsSync(lock) && (!ownTransaction || JSON.parse(bounded(lock, 4096)!.toString()).directory !== ownTransaction))
        fail('capture_locked');
    const j = bounded(r.humanJournalPath, 1024 * 1024, true);
    if (j && JSON.parse(j.toString()).phase !== 'complete')
        fail('human_transaction_pending');
}
function human(value: unknown): boolean { return !!value && typeof value === 'object' && (isMacSpeakerHumanProtected(value) || Object.values(value).some(v => human(v))); }
/** This is an independently supplied admission decision, NOT a self-hash grant. */
export function readMacSpeakerCallPolicy(r: MacSpeakerCallProducerRequest): MacSpeakerCallPolicyAdmission {
    const b = bounded(r.policyPath, 256 * 1024)!, p = JSON.parse(b.toString()) as MacSpeakerCallPolicyAdmission;
    if (hash(b) !== r.policySHA256 || p.version !== 1 || p.kind !== 'mac-speaker-call-policy-admission' || p.admission !== 'qualified' || p.scope !== 'AUTOMATIC_CLOSED_CALL_ANONYMOUS_ESTIMATE' || p.policy !== 'fluid256-call-view-v1' || p.projectionPolicy !== 'anonymous-estimate' || !SHA.test(p.cliSHA256) || !SHA.test(p.modelSHA256) || typeof p.review?.reviewer !== 'string' || !p.review.reviewer.trim() || p.review.reviewer.length > 200 || !SHA.test(p.review.sha256) || hash(bounded(p.review.path, 16 * 1024 * 1024)!) !== p.review.sha256)
        fail('independent_policy_required');
    if (Object.keys(p.runtimeFiles ?? {}).sort().join() !== [...MAC_CALL_PRODUCER_RUNTIME_FILES].sort().join())
        fail('policy_code_inventory');
    for (const name of MAC_CALL_PRODUCER_RUNTIME_FILES)
        if (hash(bounded(fileURLToPath(new URL(name, import.meta.url)), 2 * 1024 * 1024)!) !== p.runtimeFiles[name])
            fail('policy_code_drift');
    const modelBytes = bounded(p.modelManifestPath, 256 * 1024)!, model = JSON.parse(modelBytes.toString()), expected = Object.fromEntries([{ path: SHADOW_REVISION_MARKER.path, sha256: SHADOW_REVISION_MARKER.sha256 }, ...SHADOW_MODEL_FILES].map(m => [`speaker-diarization/${m.path}`, m.sha256]));
    if (hash(modelBytes) !== p.modelSHA256 || model.repository !== SHADOW_MODEL_REPO || model.revision !== SHADOW_MODEL_REVISION || seal(Object.entries(model.files ?? {}).sort()) !== seal(Object.entries(expected).sort()))
        fail('model_policy_identity');
    return p;
}
/** Read-only route admission check. This proves retained receipt integrity and
 * reviewed policy conformance, never independent authentication of native IO. */
export function checkMacSpeakerCallCachedNative(r: MacSpeakerCallProducerRequest, ref: MacSpeakerCallNativeRef): void {
    readMacSpeakerCallPolicy(r);
    const dir = join(r.root, r.captureId), exportDir = dirname(ref.path);
    if (ref.captureId !== r.captureId || dirname(exportDir) !== dir || !/^native-[a-f0-9-]{36}$/.test(exportDir.split('/').at(-1) ?? '') || ref.path !== join(exportDir, 'receipt.json') || !SHA.test(ref.sha256))
        fail('cached_native_path');
    const bytes = bounded(ref.path, 16 * 1024 * 1024)!, a = JSON.parse(bytes.toString()), { artifactSHA256, ...body } = a;
    if (hash(bytes) !== ref.sha256 || a.version !== 1 || a.kind !== 'mac-speaker-call-native-export' || artifactSHA256 !== seal(body) || a.request?.captureId !== r.captureId || a.request?.root !== r.root || a.request?.policyPath !== r.policyPath || a.request?.policySHA256 !== r.policySHA256 || a.execution?.closed !== true || a.execution?.exitCode !== 0 || a.execution?.networkDenied !== true || a.execution?.nativeAuthenticated !== false || a.nativePath !== join(exportDir, 'native.json') || a.embeddingPath !== join(exportDir, 'embeddings.json') || hash(bounded(a.nativePath, 64 * 1024 * 1024)!) !== a.nativeSHA256 || hash(bounded(a.embeddingPath, 96 * 1024 * 1024)!) !== a.embeddingSHA256)
        fail('cached_native_integrity');
}
/** Called in a short child before the finalization job is released. Never seeds
 * from corrected history, and never edits BASE/ledger or reclaims a human lock. */
export function freezeMacSpeakerCallSeed(r: MacSpeakerCallProducerRequest): {
    seedPath: string;
    generation: string;
} {
    readMacSpeakerCallPolicy(r);
    guardHuman(r);
    const dir = captureDir(r), seedPath = join(dir, 'original.json'), metaPath = join(dir, 'seed.json');
    if (existsSync(metaPath)) {
        const meta = JSON.parse(bounded(metaPath, 4096)!.toString());
        if (meta.captureId !== r.captureId || hash(bounded(seedPath, 32 * 1024 * 1024)!) !== meta.originalSHA256 || typeof meta.generation !== 'string')
            fail('seed_integrity');
        return { seedPath, generation: meta.generation };
    }
    const source = bounded(r.sidecarPath, 32 * 1024 * 1024)!, ledger = bounded(r.ledgerPath, 8 * 1024 * 1024, true), doc = JSON.parse(source.toString());
    if (doc.sessionId !== r.captureId || doc.finalizationState !== 'complete' || doc.sourceType !== 'mac_system_audio' || doc.active || doc.isActive || doc.claimPending)
        fail('closed_source_required');
    if (ledger?.toString().trim() || human(doc) || existsSync(r.humanJournalPath) || existsSync(r.sidecarPath.replace(/\.g2-chunks\.json$/, '.speaker-call-human.json')))
        fail('human_history_without_seed');
    const orphanSeed = bounded(seedPath, 32 * 1024 * 1024, true);
    if (orphanSeed && (hash(orphanSeed) !== hash(source) || existsSync(join(dir, 'cursor.json')) || existsSync(r.sidecarPath.replace(/\.g2-chunks\.json$/, '.speaker-call-state.json'))))
        fail('orphan_seed_requires_recovery');
    const lock = join(dirname(r.sidecarPath), `.${r.captureId}.speaker-call.lock`), token = JSON.stringify({ pid: process.pid, token: randomUUID(), kind: 'producer_seed' });
    const sourcePin = pin(r.sidecarPath, 32 * 1024 * 1024), ledgerPin = pin(r.ledgerPath, 8 * 1024 * 1024, true);
    put(lock, token);
    try {
        checkPins([sourcePin, ledgerPin]);
        if (sourcePin.sha256 !== hash(source))
            fail('seed_source_drift');
        const generation = randomUUID();
        if (!orphanSeed)
            put(seedPath, source);
        put(metaPath, JSON.stringify({ version: 1, captureId: r.captureId, generation, originalSHA256: hash(source) }) + '\n');
        return { seedPath, generation };
    }
    finally {
        if (hash(bounded(lock, 4096)!) !== hash(token))
            fail('seed_lock_drift');
        unlinkSync(lock);
    }
}
/** Before the shared shadow native run. Raw/model/tool stamps remain immutable
 * through child close; ABA replacement also invalidates this attempt. */
export function beginMacSpeakerCallNative(r: MacSpeakerCallProducerRequest, input: {
    sourceJSON: string;
    audioDir: string;
    cliPath: string;
    modelsDir: string;
    timeline: {
        rows: ShadowTimelineRow[];
        total: number;
        pcmSHA256: string;
    };
}): NativeContext {
    const policy = readMacSpeakerCallPolicy(r), seed = freezeMacSpeakerCallSeed(r);
    guardHuman(r);
    if (hash(bounded(r.sidecarPath, 32 * 1024 * 1024)!) !== hash(input.sourceJSON))
        fail('native_base_drift');
    const pins = [pin(r.sidecarPath, 32 * 1024 * 1024), pin(r.ledgerPath, 8 * 1024 * 1024, true), pin(input.cliPath, 256 * 1024 * 1024)];
    if (pins[2].sha256 !== policy.cliSHA256)
        fail('cli_drift');
    const rawAudio = shadowEntries(JSON.parse(input.sourceJSON)).map(e => { const path = realpathSync(join(input.audioDir, `chunk_${String(e.chunkIndex).padStart(4, '0')}.wav`)), b = bounded(path, 1024 * 1024)!, pcm = readPcm16Wav(b); pins.push(pin(path, 1024 * 1024)); return { rawChunkIndex: e.chunkIndex, wavSHA256: hash(b), pcmSHA256: hash(pcm.pcm), sampleCount: pcm.sampleCount }; });
    const rawManifest = { version: 1, captureId: r.captureId, rows: rawAudio.map((a, i) => ({ ...a, path: pins[i + 3].path, wavSHA256: a.wavSHA256 })) };
    const modelRows = [{ path: SHADOW_REVISION_MARKER.path, sha256: SHADOW_REVISION_MARKER.sha256 }, ...SHADOW_MODEL_FILES];
    const modelManifest = { version: 1, modelSHA256: policy.modelSHA256, files: modelRows.map(m => { const p = pin(realpathSync(join(input.modelsDir, m.path)), 1024 * 1024 * 1024); if (p.sha256 !== m.sha256)
            fail('model_drift'); pins.push(p); return { path: p.path, sha256: p.sha256 }; }) };
    pins.push(pin(seed.seedPath, 32 * 1024 * 1024), pin(join(dirname(seed.seedPath), 'seed.json'), 4096));
    const ledgerJSONL = bounded(r.ledgerPath, 8 * 1024 * 1024, true)?.toString() ?? '';
    if (hash(ledgerJSONL) !== (pins[1].sha256 ?? hash('')))
        fail('native_ledger_drift');
    return { request: r, policy, generation: seed.generation, originalPath: seed.seedPath, pins, rawAudio, timeline: input.timeline, cliPath: input.cliPath, rawManifest, modelManifest, sourceJSON: input.sourceJSON, ledgerJSONL };
}
/** Only called after the actual shared CLI emits close(exit0). Retains exports
 * once for a separate consumer; no second inference and no meeting mutation. */
export function retainMacSpeakerCallNative(ctx: NativeContext, outputs: {
    nativePath: string;
    embeddingPath: string;
    exitCode: number | null;
    closed: boolean;
    networkDenied: boolean;
}): MacSpeakerCallNativeRef {
    if (outputs.exitCode !== 0 || !outputs.closed || !outputs.networkDenied)
        fail('native_not_closed_offline');
    readMacSpeakerCallPolicy(ctx.request);
    guardHuman(ctx.request);
    checkPins(ctx.pins);
    const native = bounded(outputs.nativePath, 64 * 1024 * 1024)!, emb = bounded(outputs.embeddingPath, 96 * 1024 * 1024)!, dir = join(captureDir(ctx.request), `native-${randomUUID()}`);
    mkdirSync(dir, { mode: 0o700 });
    put(join(dir, 'native.json'), native);
    put(join(dir, 'embeddings.json'), emb);
    put(join(dir, 'raw-manifest.json'), JSON.stringify(ctx.rawManifest) + '\n');
    put(join(dir, 'model-manifest.json'), JSON.stringify(ctx.modelManifest) + '\n');
    put(join(dir, 'native-source.json'), ctx.sourceJSON);
    put(join(dir, 'native-ledger.jsonl'), ctx.ledgerJSONL);
    const { policy: _, sourceJSON: __, ledgerJSONL: ___, ...base } = ctx;
    const body = { ...base, version: 1 as const, kind: 'mac-speaker-call-native-export' as const, nativePath: join(dir, 'native.json'), embeddingPath: join(dir, 'embeddings.json'), nativeSHA256: hash(native), embeddingSHA256: hash(emb), execution: { exitCode: 0 as const, closed: true as const, networkDenied: true as const, nativeAuthenticated: false as const } };
    const artifact = { ...body, artifactSHA256: seal(body) }, path = join(dir, 'receipt.json');
    checkPins(ctx.pins);
    put(path, JSON.stringify(artifact) + '\n');
    return { path, sha256: hash(bounded(path, 16 * 1024 * 1024)!), captureId: ctx.request.captureId };
}
/** Worker-only publication. Requires reviewed policy + retained execution receipt
 * and freshly verifies every native/raw/model/current/ledger source again. */
export function publishMacSpeakerCallNative(ref: MacSpeakerCallNativeRef, target?: MacSpeakerCallProducerRequest): {
    status: 'applied';
    directory: string;
    packetPath: string;
    statePath: string;
} {
    const artifact = JSON.parse(bounded(ref.path, 16 * 1024 * 1024)!.toString()) as NativeArtifact, r = target ?? artifact.request;
    readMacSpeakerCallPolicy(r);
    const release = producerLock(r);
    try {
        return publishUnlocked(ref, target);
    }
    finally {
        release();
    }
}
function publishUnlocked(ref: MacSpeakerCallNativeRef, target?: MacSpeakerCallProducerRequest): {
    status: 'applied';
    directory: string;
    packetPath: string;
    statePath: string;
} {
    const bytes = bounded(ref.path, 16 * 1024 * 1024)!, a = JSON.parse(bytes.toString()) as NativeArtifact, { artifactSHA256, ...body } = a;
    if (hash(bytes) !== ref.sha256 || a.kind !== 'mac-speaker-call-native-export' || a.request.captureId !== ref.captureId || artifactSHA256 !== seal(body) || a.execution.exitCode !== 0 || a.execution.closed !== true || a.execution.networkDenied !== true || a.execution.nativeAuthenticated !== false)
        fail('native_receipt_integrity');
    const r = target ?? a.request;
    if (r.captureId !== a.request.captureId || r.root !== a.request.root || r.policyPath !== a.request.policyPath || r.policySHA256 !== a.request.policySHA256)
        fail('target_capture_or_policy');
    const p = readMacSpeakerCallPolicy(r), dir = captureDir(r), cursorPath = join(dir, 'cursor.json'), pendingPath = join(dir, 'pending-publication.json');
    const exportDir = dirname(ref.path), modelRows = [{ path: SHADOW_REVISION_MARKER.path, sha256: SHADOW_REVISION_MARKER.sha256 }, ...SHADOW_MODEL_FILES];
    if (dirname(exportDir) !== dir || !/^native-[a-f0-9-]{36}$/.test(exportDir.split('/').at(-1) ?? '') || a.originalPath !== join(dir, 'original.json') || a.nativePath !== join(exportDir, 'native.json') || a.embeddingPath !== join(exportDir, 'embeddings.json') || !Array.isArray(a.pins) || a.pins.length > 6500 || !Array.isArray(a.rawAudio) || !Array.isArray(a.rawManifest?.rows) || a.rawManifest.rows.length !== a.rawAudio.length || !Array.isArray(a.modelManifest?.files) || a.modelManifest.files.length !== modelRows.length)
        fail('native_inventory');
    for (const row of modelRows)
        if (a.modelManifest.files.filter((f: any) => f.path.endsWith(`/${row.path}`) && f.sha256 === row.sha256).length !== 1)
            fail('model_native_membership');
    const expectedPaths = [a.request.sidecarPath, a.request.ledgerPath, a.cliPath, a.originalPath, join(dir, 'seed.json'), ...a.rawManifest.rows.map((x: any) => x.path), ...a.modelManifest.files.map((x: any) => x.path)];
    if (new Set(expectedPaths).size !== expectedPaths.length || seal([...expectedPaths].sort()) !== seal(a.pins.map(x => x.path).sort()))
        fail('native_source_inventory');
    for (const [i, row] of a.rawManifest.rows.entries())
        if (row.rawChunkIndex !== i || seal(a.rawAudio[i]) !== seal({ rawChunkIndex: i, wavSHA256: row.wavSHA256, pcmSHA256: row.pcmSHA256, sampleCount: row.sampleCount }))
            fail('native_raw_join');
    const pendingBytes = bounded(pendingPath, 16384, true);
    if (pendingBytes) {
        const pending = JSON.parse(pendingBytes.toString());
        validateMacSpeakerCallPending(pending, r, ref, hash(bounded(cursorPath, 32768)!));
        guardHuman(r, pending.directory);
        const intentBytes = bounded(join(pending.directory, 'intent.json'), 4 * 1024 * 1024)!, intent = JSON.parse(intentBytes.toString());
        if (hash(intentBytes) !== pending.intentSHA256 || intent.captureId !== r.captureId || intent.directory !== pending.directory || intent.root !== join(dir, 'transactions') || intent.images?.length !== 2 || intent.images[0].path !== pending.packetPath || intent.images[1].path !== pending.statePath || intent.images[0].afterSHA256 !== pending.publication.packetSHA256 || intent.images[1].afterSHA256 !== pending.publication.stateFileSHA256)
            fail('pending_intent_drift');
        const fence = () => { readMacSpeakerCallPolicy(r); guardHuman(r, pending.directory); if (hash(bounded(pendingPath, 16384)!) !== hash(pendingBytes) || hash(bounded(cursorPath, 32768)!) !== pending.cursorSHA256 || hash(bounded(join(pending.directory, 'intent.json'), 4 * 1024 * 1024)!) !== pending.intentSHA256)
            fail('pending_publication_drift'); };
        executeMacSpeakerCallPublication(pending.directory, 'apply', { resume: true, beforeWrite: fence });
        fence();
        if (hash(bounded(pending.packetPath, 16 * 1024 * 1024)!) !== pending.publication.packetSHA256 || hash(bounded(pending.statePath, 16 * 1024 * 1024)!) !== pending.publication.stateFileSHA256)
            fail('pending_postimage_drift');
        const cursor = JSON.parse(bounded(cursorPath, 32768)!.toString());
        cursor.publications[pending.sidecarPath] = pending.publication;
        durableAtomicWriteFileSync(cursorPath, JSON.stringify(cursor) + '\n');
        unlinkSync(pendingPath);
        return { status: 'applied', directory: pending.directory, packetPath: pending.packetPath, statePath: pending.statePath };
    }
    guardHuman(r);
    // Current BASE/ledger may acquire protected human annotations after inference.
    // Raw/model/tool pins must never change; inspector validates all geometry.
    checkPins(a.pins.filter(x => x.path !== a.request.sidecarPath && x.path !== a.request.ledgerPath));
    if (hash(bounded(join(exportDir, 'native-source.json'), 32 * 1024 * 1024)!) !== a.pins.find(x => x.path === a.request.sidecarPath)?.sha256 || hash(bounded(join(exportDir, 'native-ledger.jsonl'), 8 * 1024 * 1024)!) !== (a.pins.find(x => x.path === a.request.ledgerPath)?.sha256 ?? hash('')))
        fail('native_snapshot_drift');
    const originalJSON = bounded(a.originalPath, 32 * 1024 * 1024)!.toString(), currentJSON = bounded(r.sidecarPath, 32 * 1024 * 1024)!.toString(), ledgerJSONL = bounded(r.ledgerPath, 8 * 1024 * 1024, true)?.toString() ?? '', nativeJSON = bounded(a.nativePath, 64 * 1024 * 1024)!.toString(), embeddingsJSON = bounded(a.embeddingPath, 96 * 1024 * 1024)!.toString();
    if (hash(nativeJSON) !== a.nativeSHA256 || hash(embeddingsJSON) !== a.embeddingSHA256)
        fail('native_export_drift');
    const source = { originalJSON, currentJSON, ledgerJSONL, rawAudio: a.rawAudio, timeline: a.timeline, cohort: { nativeJSON, embeddingsJSON, modelSHA256: p.modelSHA256, cliSHA256: p.cliSHA256 } }, input: MacSpeaker256SnapshotInput = { ...source, sourceBindingSHA256: bindMacSpeakerShadowRepair(source), generation: a.generation };
    const cursor = bounded(cursorPath, 32768, true), prior = cursor ? JSON.parse(cursor.toString()) : null;
    let previous: MacSpeaker256State | null = null;
    if (prior) {
        if (typeof prior.inputPath !== 'string' || !prior.inputPath.startsWith(`${dir}/candidate-`) || dirname(prior.inputPath) !== dirname(prior.statePath) || !prior.inputPath.endsWith('/input.json') || !prior.statePath.endsWith('/state.json') || !prior.publications || typeof prior.publications !== 'object')
            fail('cursor_path');
        const b = bounded(prior.inputPath, 256 * 1024 * 1024)!, s = bounded(prior.statePath, 16 * 1024 * 1024)!;
        if (hash(b) !== prior.inputSHA256 || hash(s) !== prior.stateFileSHA256)
            fail('cursor_drift');
        const recovered = JSON.parse(s.toString()) as MacSpeaker256State;
        validateMacSpeaker256State(recovered, JSON.parse(b.toString()));
        previous = recovered;
        input.expectedStateSHA256 = recovered.stateSHA256;
    }
    const state = reconcileMacSpeaker256Snapshot(previous, input), packet = prepareMacSpeakerCallPacket(input, state, { admission: 'qualified', projectionPolicy: 'anonymous-estimate' }), packetJSON = JSON.stringify(packet) + '\n', stateJSON = JSON.stringify(state) + '\n';
    const candidate = join(dir, `candidate-${randomUUID()}`);
    mkdirSync(candidate, { mode: 0o700 });
    put(join(candidate, 'input.json'), JSON.stringify(input) + '\n');
    put(join(candidate, 'state.json'), stateJSON);
    const nextCursor = { inputPath: join(candidate, 'input.json'), inputSHA256: hash(JSON.stringify(input) + '\n'), statePath: join(candidate, 'state.json'), stateFileSHA256: hash(stateJSON), publications: prior?.publications ?? {} };
    if ((bounded(cursorPath, 32768, true)?.toString() ?? null) !== (cursor?.toString() ?? null))
        fail('cursor_cas');
    // Reserve the opaque namespace before publication. Failure may leave unused
    // reservations, which are retained rather than recycling IDs on retry.
    durableAtomicWriteFileSync(cursorPath, JSON.stringify(nextCursor) + '\n');
    const artifactDir = dirname(ref.path), sources: MacSpeakerCallFrozenFile[] = [];
    const add = (role: MacSpeakerCallFrozenFile['role'], path: string, absent = false) => { const b = bounded(path, 1024 * 1024 * 1024, absent); sources.push({ role, path, sha256: b === null ? null : hash(b) }); };
    add('original', a.originalPath);
    add('current', r.sidecarPath);
    add('ledger', r.ledgerPath, true);
    add('raw-pcm-manifest', join(artifactDir, 'raw-manifest.json'));
    add('model-manifest', join(artifactDir, 'model-manifest.json'));
    add('cli', a.cliPath);
    add('native-export', a.nativePath);
    add('embedding-export', a.embeddingPath);
    for (const row of a.rawManifest.rows)
        add('raw-audio', row.path);
    for (const row of a.modelManifest.files)
        add('model-file', row.path);
    const q: MacSpeakerCallQualification = { version: 1, kind: 'mac-speaker-call-qualified', captureId: r.captureId, policy: p.policy, admissionPolicy: p.projectionPolicy, qualification: { status: 'qualified', reviewer: p.review.reviewer, reviewReceiptSHA256: p.review.sha256 }, sourceFilesSHA256: hashMacSpeakerCallFileInventory(sources), bindings: { originalSHA256: hash(originalJSON), currentSHA256: hash(currentJSON), ledgerSHA256: hash(ledgerJSONL), rawPCMManifestSHA256: sources.find(s => s.role === 'raw-pcm-manifest')!.sha256!, cliSHA256: p.cliSHA256, modelSHA256: p.modelSHA256, nativeExportSHA256: a.nativeSHA256, embeddingExportSHA256: a.embeddingSHA256, sourceBindingSHA256: input.sourceBindingSHA256, stateSHA256: state.stateSHA256, packetSHA256: packet.packetSHA256, stateFileSHA256: hash(stateJSON), packetFileSHA256: hash(packetJSON) } };
    const qualifiedPath = join(candidate, 'policy-conformance.json');
    put(qualifiedPath, JSON.stringify({ ...q, basis: 'independently-admitted-policy-conformance', policyAdmissionSHA256: r.policySHA256, nativeReceiptSHA256: ref.sha256, nativeAuthenticated: false }) + '\n');
    const stem = r.sidecarPath.replace(/\.g2-chunks\.json$/, '');
    if (stem === r.sidecarPath)
        fail('sidecar_suffix');
    const packetPath = `${stem}.speaker-call.json`, statePath = `${stem}.speaker-call-state.json`, root = join(dir, 'transactions');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const beforePacket = bounded(packetPath, 16 * 1024 * 1024, true), beforeState = bounded(statePath, 16 * 1024 * 1024, true);
    const known = nextCursor.publications[r.sidecarPath];
    if ((beforePacket ? hash(beforePacket) : null) !== (known?.packetSHA256 ?? null) || (beforeState ? hash(beforeState) : null) !== (known?.stateFileSHA256 ?? null))
        fail('published_artifact_drift');
    readMacSpeakerCallPolicy(r);
    guardHuman(r);
    const transaction = prepareMacSpeakerCallPublication({ captureId: r.captureId, transactionRoot: root, packetPath, statePath, packetJSON, stateJSON, expectedPacketSHA256: beforePacket ? hash(beforePacket) : null, expectedStateFileSHA256: beforeState ? hash(beforeState) : null, sources, qualificationReceipt: { path: qualifiedPath, expectedSHA256: hash(bounded(qualifiedPath, 1024 * 1024)!) } });
    put(join(candidate, 'transaction.json'), JSON.stringify({ directory: transaction }) + '\n');
    put(pendingPath, JSON.stringify({ captureId: r.captureId, policySHA256: r.policySHA256, nativeRefSHA256: ref.sha256, directory: transaction, intentSHA256: hash(bounded(join(transaction, 'intent.json'), 4 * 1024 * 1024)!), cursorSHA256: hash(bounded(cursorPath, 32768)!), sidecarPath: r.sidecarPath, packetPath, statePath, publication: { packetSHA256: hash(packetJSON), stateFileSHA256: hash(stateJSON) } }) + '\n');
    const pending = bounded(pendingPath, 16384)!, cursorHash = hash(bounded(cursorPath, 32768)!);
    const fence = () => { readMacSpeakerCallPolicy(r); guardHuman(r, transaction); if (hash(bounded(pendingPath, 16384)!) !== hash(pending) || hash(bounded(cursorPath, 32768)!) !== cursorHash)
        fail('publication_cursor_drift'); };
    executeMacSpeakerCallPublication(transaction, 'apply', { beforeWrite: fence });
    fence();
    nextCursor.publications[r.sidecarPath] = { packetSHA256: hash(packetJSON), stateFileSHA256: hash(stateJSON) };
    durableAtomicWriteFileSync(cursorPath, JSON.stringify(nextCursor) + '\n');
    unlinkSync(pendingPath);
    return { status: 'applied', directory: transaction, packetPath, statePath };
}
async function main() {
    let text = '';
    for await (const b of process.stdin) {
        text += b.toString();
        if (Buffer.byteLength(text) > 65536)
            fail('job_bound');
    }
    try {
        const job = JSON.parse(text);
        const { macSpeakerCallProducerRequestValid } = await import('./mac-speaker-call-producer.js');
        if (!macSpeakerCallProducerRequestValid(job.request))
            fail('job_request_invalid');
        const result = job.action === 'freeze' ? freezeMacSpeakerCallSeed(job.request) : job.action === 'publish' ? publishMacSpeakerCallNative(job.ref, job.request) : fail('unknown_job');
        process.stdout.write(JSON.stringify({ status: job.action === 'freeze' ? 'frozen' : 'applied', result }) + '\n');
    }
    catch (e) {
        process.stdout.write(JSON.stringify({ status: 'withheld', reason: e instanceof Error ? e.message.slice(0, 200) : 'worker_failure' }) + '\n');
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    void main().catch(() => { process.exitCode = 1; });
