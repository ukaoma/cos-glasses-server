import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { publicWebUrl, publicSearchQueryAllowed, parseWebEvidence, WEB_HOOK_SOURCE } from './meeting-ask-web.js';
import { runBoundedSearch } from './meeting-ask-search-process.js';
describe('bounded public meeting search', () => {
    it('only accepts public http links, no credentials/private addresses', () => { for (const u of ['file:///tmp/x', 'http://localhost', 'http://127.0.0.1', 'https://10.1.1.1', 'http://[::1]', 'https://user:pass@example.com', 'https://foo.local', 'http://192.168.0.1', 'http://example.com:8080'])
        expect(publicWebUrl(u)).toBeNull(); expect(publicWebUrl('https://developer.apple.com/documentation')).toBe('https://developer.apple.com/documentation'); });
    it('will not turn private names or evidence into public queries', () => { expect(publicSearchQueryAllowed("When is Queen birthday?", 'Queen birthday')).toBe(false); expect(publicSearchQueryAllowed('Search web for Apple documentation', 'Apple documentation')).toBe(true); expect(publicSearchQueryAllowed('Search web for Apple documentation', 'Queen salary Apple documentation')).toBe(false); expect(publicSearchQueryAllowed('What did we decide?', 'Apple documentation')).toBe(false); });
    it('keeps generated search summary separate from authoritative observed result links', () => { const sources = parseWebEvidence({ results: [{ content: [{ title: 'Apple doc', url: 'https://developer.apple.com/' }] }, 'Search summary mentions facts.'] }, 'Apple docs'); expect(sources).toHaveLength(2); expect(sources[0].url).toBeUndefined(); expect(sources[1].text).toContain('page not fetched'); expect(sources[1].retrievalId).toBe(sources[0].retrievalId); });
    it('enforces single WebSearch before tool execution and rejects every other tool', () => { const d = mkdtempSync(join(tmpdir(), 'web-hook-test-')); try {
        const p = join(d, 'hook.cjs');
        writeFileSync(p, WEB_HOOK_SOURCE);
        const run = (tool_name: string) => { const r = spawnSync(process.execPath, [p], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name }), encoding: 'utf8' }); expect(r.status).toBe(0); return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision; };
        expect(run('Bash')).toBe('deny');
        expect(run('WebSearch')).toBe('allow');
        expect(run('WebSearch')).toBe('deny');
        expect(readFileSync(join(d, 'events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
    }
    finally {
        rmSync(d, { recursive: true, force: true });
    } });
    it('cancels retrieval process and confirms its group exited promptly', async () => { const c = new AbortController(); const at = Date.now(); const p = runBoundedSearch(process.execPath, ['-e', 'setInterval(()=>{},10000)'], tmpdir(), c.signal); setTimeout(() => c.abort(), 30); await expect(p).rejects.toThrow('cancelled'); expect(Date.now() - at).toBeLessThan(1500); });
});
