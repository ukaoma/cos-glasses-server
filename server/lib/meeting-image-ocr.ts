import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { redactSecrets } from './lens-gist-engines.js';

export interface ImageText { text: string; lowConfidence: boolean }
export interface ImageLine { text: string; confidence: number; x: number; y: number; height: number }
const script = fileURLToPath(new URL('./native/meeting-image-ocr.js', import.meta.url));
let active = 0;
/** Preserve table row association; Vision's default output may read whole columns first. */
export function imageRows(lines: ImageLine[]): ImageText {
    if (!Array.isArray(lines) || lines.length > 10000 || lines.some(l => typeof l.text !== 'string' || l.text.length > 100000 || ![l.confidence, l.x, l.y, l.height].every(Number.isFinite))) throw new Error('invalid_ocr');
    const rows: { y: number; height: number; lines: ImageLine[] }[] = [];
    for (const line of [...lines].sort((a, b) => b.y - a.y || a.x - b.x)) {
        const row = rows.find(r => Math.abs(r.y - line.y) <= Math.max(r.height, line.height) * 0.85);
        if (row) row.lines.push(line);
        else rows.push({ y: line.y, height: line.height, lines: [line] });
    }
    return { text: rows.map(r => r.lines.sort((a, b) => a.x - b.x).map(l => l.text).join(' | ')).join('\n'), lowConfidence: lines.some(l => l.confidence < 0.6) };
}
/** Check ALL recognized text before truncation, including screen labels and editor gutters. */
export function imageTextHasSecrets(text: string): boolean {
    if (redactSecrets(text) !== text) return true;
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}|\bAIza[0-9A-Za-z_-]{30,}|\b(?:sk|rk|pk)_live_[0-9A-Za-z]{16,}|\bsk-(?:ant-|proj-)?\s?[A-Za-z0-9_-]{20,}/.test(text)) return true;
    if (/\bbearer[ \t]+(?=[A-Za-z0-9._~+/-]*[0-9])[A-Za-z0-9._~+/-]{20,}/i.test(text)) return true;
    const key = (v: string) => {
        const k = v.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[ .-]+/g, '_').toUpperCase();
        return /PASSWORD|PASSWD|(?:^|_)(?:PASS|SECRET|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|ACCESS_KEY_ID|SECRET_KEY|AUTH_KEY|CREDENTIALS)$/.test(k);
    };
    const value = (v: string) => v.length >= 8 && !/\s/.test(v) && /[0-9!@#$%^&*_+=/~]/.test(v) && !/^(?:YOUR_|<|\$|process\.env|os\.environ|changeme|example|xxx)/i.test(v);
    // OCR table separators, two-line labels, JSON keys and KEY=value assignments.
    const lines = text.split(/\n|\s+\|\s+/).map(l => l.trim().replace(/^\d{1,5}\s*[|:]?\s+/, ''));
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(?:export |const |let |var )?["']?([A-Za-z][A-Za-z0-9 _.-]{1,40}?)["']?\s*[:=]\s*["']?(\S+?)["';,]?$/);
        if (m && key(m[1]) && (value(m[2]) || lines[i].includes('=') && m[2].length >= 4 && !/your|changeme|example|placeholder|redacted|xxx|process\.env|os\.environ|^\$|^<|^\d+$/i.test(m[2]))) return true;
        if (key(lines[i].replace(/[:=]$/, '')) && lines[i + 1] && value(lines[i + 1])) return true;
    }
    return false;
}
/** Built-in local macOS OCR only. Two children maximum, bounded time/output, no shell or network. */
export async function readMeetingImage(path: string, signal: AbortSignal, timeoutMs = 10000): Promise<ImageText> {
    if (process.platform !== 'darwin') throw new Error('ocr_unavailable');
    if (signal.aborted) throw new Error('ocr_cancelled');
    if (active >= 2) throw new Error('ocr_busy');
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024 || realpathSync(path) !== path) throw new Error('invalid_image');
    active++;
    try {
        const output = await new Promise<string>((resolve, reject) => {
            execFile('/usr/bin/osascript', ['-l', 'JavaScript', script, path], {
                signal, timeout: Math.max(1, Math.min(10000, timeoutMs)), maxBuffer: 2000000,
                env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
            }, (error, stdout) => error ? reject(new Error(signal.aborted ? 'ocr_cancelled' : 'ocr_failed')) : resolve(stdout));
        });
        return imageRows(JSON.parse(output).lines);
    } finally { active--; }
}
