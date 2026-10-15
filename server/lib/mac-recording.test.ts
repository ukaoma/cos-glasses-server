import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wavOf } from './__fixtures__/nemotron-helpers.js'
const id = 'mac_abcdef01-2345-6789-abcd-0123456789ab'
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cos-mac-capture-')); process.env.COS_DATA_DIR = root; vi.resetModules() })
afterEach(() => { delete process.env.COS_DATA_DIR; vi.resetModules(); rmSync(root, { recursive:true, force:true }) })
describe('manual Mac capture durable contract', () => {
 it('commits strict policy before registration, survives module reload and preserves G2/FF context keys', async () => {
  const mac = await import('./mac-recording.js'); const startTime = Date.now()
  expect(mac.registerMacRecording({ captureId:id,startTime,sourceType:'mac_system_audio' }).replayed).toBe(false)
  const policy = await import('./meeting-speaker-policy.js'); expect(policy.readSpeakerPolicy(id).mode).toBe('high-confidence')
  expect(mac.registerMacRecording({ captureId:id,startTime,sourceType:'mac_system_audio' }).replayed).toBe(true)
  expect(() => mac.registerMacRecording({ captureId:id,startTime:startTime-1,sourceType:'mac_system_audio' })).toThrow('another start time')
  vi.resetModules(); const fresh = await import('./mac-recording.js'); expect(fresh.requireMacRecording(id).startTime).toBe(startTime)
  const keys = await import('./meeting-context-keys.js'); expect(keys.meetingContextKeys({g2SessionId:id})).toEqual(['mac:'+id]); expect(keys.meetingContextKeys({g2SessionId:'meeting_1',firefliesId:'ff_1'})).toEqual(['g2:meeting_1','ff:ff_1'])
  expect(keys.MEETING_CONTEXT_KEY.test('mac:'+id)).toBe(true)
 })
 it('fails closed on corrupted metadata, changed policy, unregistered IDs, and saved capture reuse', async () => {
  const mac = await import('./mac-recording.js'); const body={captureId:id,startTime:Date.now(),sourceType:'mac_system_audio'}
  expect(() => mac.requireMacRecording(id)).toThrow('before sending audio'); mac.registerMacRecording(body)
  const policy = await import('./meeting-speaker-policy.js'); policy.writeSpeakerPolicy(id,'standard',policy.readSpeakerPolicy(id).revision)
  expect(() => mac.requireMacRecording(id)).toThrow('high-confidence')
  policy.writeSpeakerPolicy(id,'high-confidence',policy.readSpeakerPolicy(id).revision)
  mac.closeMacRecording(id); expect(() => mac.registerMacRecording(body)).toThrow('already saved')
  writeFileSync(join(root,'mac-recordings',id+'.json'),'{bad')
  expect(() => mac.readMacRecording(id)).toThrow('unreadable')
 })
 it('accepts only bounded mono16k PCM16 WAV and rejects HAL Float32/stereo/wrong lengths', async () => {
  const {validateMacWav} = await import('./mac-recording.js')
  expect(validateMacWav(wavOf(6,()=>400))).toBe(6000); expect(validateMacWav(wavOf(30,()=>400))).toBe(30000)
  for (const offset of [0,4,8,16,20,22,24,28,32,34,36,40]) { const bad=wavOf(1,()=>400); bad[offset]^=1; expect(()=>validateMacWav(bad)).toThrow('canonical') }
  expect(()=>validateMacWav(wavOf(30.1,()=>400))).toThrow(); expect(()=>validateMacWav(Buffer.alloc(46))).toThrow()
 })
 it('saves honest Mac source, immutable source metadata, strict chunks and mac context on the ordinary store', async()=>{
  const mac=await import('./mac-recording.js'); const startTime=Date.now(); mac.registerMacRecording({captureId:id,startTime,sourceType:'mac_system_audio'})
  const {MeetingStore}=await import('./meeting-store.js'); const store=new MeetingStore(join(root,'recordings'))
  const chunk={text:'We reviewed the launch plan and agreed on a decision.',speaker:'Ext',similarity:0,elapsed:6000,speakerPolicy:'high-confidence' as const}
  const saved=store.save({sessionId:id,startTime,durationMs:6000,transcript:'[Ext]: '+chunk.text,chunks:[chunk]})
  expect(readFileSync(saved.filepath,'utf8')).toContain('| **Source** | Mac System Audio |'); expect(readFileSync(saved.filepath,'utf8')).not.toContain('g2-needs')
  const sidecar=JSON.parse(readFileSync(saved.sidecarPath,'utf8')); expect(sidecar.sourceType).toBe('mac_system_audio'); expect(sidecar.captureSource.captureId).toBe(id); expect(sidecar.chunks[0].speakerPolicy).toBe('high-confidence')
  expect(store.list({limit:20})[0]).toMatchObject({sourceType:'mac_system_audio',source:'Mac System Audio',sessionId:id})
  expect(()=>mac.requireMacRecording(id)).toThrow('already saved')
  unlinkSync(join(root,'mac-recordings',id+'.json')); const keys=await import('./meeting-context-keys.js'); expect(keys.meetingContextKeys({g2SessionId:id,sourceType:store.list({limit:20})[0].sourceType})).toEqual(['mac:'+id])
 })
})

it('persists precise chunk timing and refuses changing audio or timing on retry across module reload',async()=>{
 const mac=await import('./mac-recording.js'); const receipt={chunkIndex:0,endElapsed:7000,durationMs:6000,audioSha256:'a'.repeat(64)}
 mac.persistMacChunkReceipt(id,receipt); vi.resetModules(); const fresh=await import('./mac-recording.js'); expect(fresh.macChunkReceipt(id,0)).toEqual(receipt)
 expect(()=>fresh.persistMacChunkReceipt(id,{...receipt,endElapsed:7001})).toThrow('different audio or timing'); expect(()=>fresh.persistMacChunkReceipt(id,{...receipt,audioSha256:'b'.repeat(64)})).toThrow('different audio or timing')
})
