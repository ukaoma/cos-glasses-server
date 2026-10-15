/** SubQ credentials stay private. Saved validated key wins over SUBQ_API_KEY; no scripts-file probing. */
import { lstatSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dataPath } from './data-dir.js'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { secureExistingPrivateFile, securePrivateDirectory } from './secure-user-config.js'
export const SUBQ_MODEL = 'subq-snap-preview'
export const SUBQ_KEY_FILE = dataPath('subq-key.json')
export interface SubqKey { key: string; source: 'config' | 'env'; savedAt?: string; validatedAt?: string }
export function resolveSubqKey(file = SUBQ_KEY_FILE, env: NodeJS.ProcessEnv = process.env): SubqKey | null {
  let present = false
  try { lstatSync(file); present = true } catch (e) { if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT')) return null }
  if (present) {
    try {
      secureExistingPrivateFile(file)
      const raw = JSON.parse(readFileSync(file,'utf8'))
      if (typeof raw?.key === 'string' && raw.key.trim()) return { key: raw.key.trim(), source: 'config', savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : undefined, validatedAt: typeof raw.validatedAt === 'string' ? raw.validatedAt : undefined }
    } catch { /* Unreadable saved key fails closed; do not silently change account. */ }
    return null
  }
  const key = env.SUBQ_API_KEY?.trim().replace(/^["']|["']$/g,'')
  return key ? { key, source: 'env' } : null
}
export function subqKeyStatus(key = resolveSubqKey()) { return { configured: !!key, source: key?.source ?? 'none', ...(key?.savedAt ? { savedAt:key.savedAt } : {}), ...(key?.validatedAt ? {validatedAt:key.validatedAt} : {}) } }
export function saveSubqKey(key: string, file = SUBQ_KEY_FILE, now = new Date()): void {
  securePrivateDirectory(dirname(file));secureExistingPrivateFile(file)
  const at=now.toISOString();durableAtomicWriteFileSync(file,JSON.stringify({key,savedAt:at,validatedAt:at})+'\n',{mode:0o600})
}
/** The official free model listing validates the key and Snap access without sending user context. */
export async function validateSubqKey(key: string, fetchImpl: typeof fetch = fetch): Promise<{ok:true}|{ok:false;status:number;reason:string}> {
  try {
    const response=await fetchImpl('https://api.subq.ai/v1/models',{redirect:'error',headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(8000)})
    if (!response.ok) return {ok:false,status:response.status,reason:response.status===401||response.status===403?'SubQ did not accept this key.':`SubQ returned ${response.status}.`}
    const body=await response.json()
    if (!Array.isArray(body?.data)||!body.data.some((m:unknown)=>m&&typeof m==='object'&&'id' in m&&m.id===SUBQ_MODEL)) return {ok:false,status:200,reason:'This key does not list SubQ Snap Preview.'}
    return {ok:true}
  } catch { return {ok:false,status:0,reason:'SubQ could not be reached or returned an unreadable model list.'} }
}
