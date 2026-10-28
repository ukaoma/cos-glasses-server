/** Isolated, killable read-only extraction. Native model work never runs on the
 * server event loop and never reaches recognition/enrollment/calibration APIs. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const worker = `
const fs = require('node:fs');
const sherpa = require(process.argv[1]);
const model = process.argv[2];
const extractor = new sherpa.SpeakerEmbeddingExtractor({model, numThreads:1, provider:'cpu'});
let size=0, parts=[];
process.stdin.on('data', b=>{size+=b.length;if(size>960000)process.exit(2);parts.push(b)});
process.stdin.on('end',()=>{
 const pcm=Buffer.concat(parts); if(pcm.length<896000||pcm.length%2)process.exit(3);
 const embed=(b)=>{const samples=new Float32Array(b.length/2);for(let i=0;i<samples.length;i++)samples[i]=b.readInt16LE(i*2)/32768;
 const stream=extractor.createStream();stream.acceptWaveform({samples,sampleRate:16000});stream.inputFinished();
 if(!extractor.isReady(stream))throw Error('not ready');return Array.from(extractor.compute(stream));};
 const half=Math.floor(pcm.length/4)*2; process.stdout.write(JSON.stringify([embed(pcm),embed(pcm.subarray(0,half)),embed(pcm.subarray(half))]));
});`
export async function extractQualifiedMacWindow(pcm: Buffer, modelPath: string, timeoutMs: number, deps: { spawn?: typeof spawn; modulePath?: string } = {}): Promise<readonly number[][] | null> {
  if (pcm.length < 896000 || pcm.length > 960000 || pcm.length % 2 || timeoutMs <= 0) return null
  let modulePath: string
  try { modulePath = deps.modulePath ?? require.resolve('sherpa-onnx-node') } catch { return null }
  return new Promise(resolve => {
    const child = (deps.spawn ?? spawn)(process.execPath, ['-e', worker, modulePath, modelPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    const output: Buffer[] = []; let size = 0, settled = false, aborted = false
    const finish = (result: readonly number[][] | null) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result) }
    const abort = () => { aborted = true; child.kill('SIGKILL') }
    // Keep ownership until close confirms native termination. Releasing on
    // kill() alone permits a second native job while the first still exits.
    const timer = setTimeout(abort, timeoutMs)
    child.stdout.on('data', b => { size += b.length; if (size > 131072) abort(); else if (!aborted) output.push(Buffer.from(b)) })
    // Drain diagnostics without retaining native stderr or logging private input.
    child.stderr.on('data', () => {})
    child.on('error', () => { aborted = true; if (!child.pid) finish(null); else child.kill('SIGKILL') }); child.stdin.on('error', () => {})
    child.on('close', code => {
      try { const rows = JSON.parse(Buffer.concat(output).toString()); finish(!aborted && code === 0 && Array.isArray(rows) && rows.length === 3 ? rows : null) } catch { finish(null) }
    })
    child.stdin.end(pcm)
  })
}
