import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCosOperationsDir } from './cos-operations-meetings.js'

/** Hold the SAME kernel flock as sync_meetings.py. Child stdin lifetime owns it. */
export async function acquireMeetingSyncLock(): Promise<{mode:'sync'|'standalone';release:()=>void}> {
  const operations = resolveCosOperationsDir()
  if (!operations) return {mode:'standalone',release:()=>{}}
  const scripts = process.env.COS_SCRIPTS_DIR?.trim() || join(operations,'scripts')
  const python = join(scripts,'cos_python')
  if (!existsSync(python)) throw new Error('sync lock holder unavailable: cos_python missing')
  const code = `import fcntl,sys,time\nf=open(sys.argv[1], 'a+')\nfor i in range(4):\n try:\n  fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)\n  print('LOCKED',flush=True)\n  sys.stdin.read()\n  sys.exit(0)\n except BlockingIOError:\n  time.sleep(0.15*(i+1))\nsys.exit(73)\n`
  const child = spawn(python,['-c',code,join(scripts,'.sync_meetings.lock')],{stdio:['pipe','pipe','pipe']})
  return await new Promise((resolve,reject) => {
    let settled = false, output = '', error = ''
    const timer = setTimeout(()=>{if(!settled){settled=true;child.kill();reject(new Error('sync running, retry'))}},5000)
    child.stderr.on('data',d=>{error+=String(d)})
    child.stdout.on('data',d=>{
      output += String(d)
      if (!settled && output.includes('LOCKED')) {settled=true;clearTimeout(timer);resolve({mode:'sync',release:()=>child.stdin.end()})}
    })
    child.on('error',err=>{if(!settled){settled=true;clearTimeout(timer);reject(err)}})
    child.on('exit',()=>{if(!settled){settled=true;clearTimeout(timer);reject(new Error(error.trim() || 'sync running, retry'))}})
  })
}
