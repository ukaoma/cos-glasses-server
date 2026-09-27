#!/usr/bin/env node
// Run mutations only in a disposable source copy. Never rewrite a running candidate's modules.
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const scratch = mkdtempSync(join(tmpdir(), 'work-review-mutations-'))
const files = ['work-review-store.ts','work-review-runtime.ts','work-review-runtime.test.ts','atomic-fs.ts','server-instance-lock.ts']
const mutations = [
  ['same-revision-dedup', 'if (existing) {', 'if (false) {'],
  ['terminal-receipt-recovery', "if (row.status === 'source_unavailable' && row.suspendedTerminal)", 'if (false)'],
  ['optional-backend-failure', 'try { return create() }', 'return create(); try { return create() }'],
  ['provider-readonly-gate', "if (!model?.available || !['claude', 'ollama'].includes(model.provider))", 'if (!model)'],
  ['source-precheck', 'if (sourceRevision(current) !== row.source.revision) {', 'if (false) {'],
  ['terminal-revision-fence', "if (sourceRevision(final) !== row.source.revision) { updated.status = 'superseded'; delete updated.markdown }", 'if (false) { updated.status = \'superseded\'; delete updated.markdown }'],
]
try {
  mkdirSync(join(scratch,'server/lib'), { recursive:true })
  for (const file of files) cpSync(join(root,'server/lib',file),join(scratch,'server/lib',file))
  symlinkSync(join(root,'node_modules'),join(scratch,'node_modules'),'dir')
  writeFileSync(join(scratch,'package.json'),'{"type":"module"}\n')
  const target=join(scratch,'server/lib/work-review-runtime.ts');const original=readFileSync(target,'utf8')
  const run=()=>spawnSync(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--maxWorkers=1','server/lib/work-review-runtime.test.ts'],{
    cwd:scratch,env:{PATH:process.env.PATH,HOME:scratch,COS_DATA_DIR:join(scratch,'data'),COS_AGENT_SESSIONS_HOME:join(scratch,'agents')},encoding:'utf8',timeout:90000,
  })
  const baseline=run();if(baseline.status!==0)throw new Error('Baseline failed: '+baseline.stdout+'\n'+baseline.stderr)
  console.log('baseline PASS')
  for(const[name,find,replacement]of mutations){
    if(original.split(find).length!==2)throw new Error('Ambiguous mutation '+name)
    writeFileSync(target,original.replace(find,replacement))
    const result=run();const output=result.stdout+'\n'+result.stderr
    if(result.status===0||result.error||!(/AssertionError|expected .*to|promise resolved/i.test(output)))throw new Error('Mutation survived or harness failed '+name+'\n'+output)
    console.log(name+' KILLED')
    writeFileSync(target,original)
  }
} finally {rmSync(scratch,{recursive:true,force:true})}
