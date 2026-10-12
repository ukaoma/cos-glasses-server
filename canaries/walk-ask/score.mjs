import fs from 'node:fs';import path from 'node:path';
import {fetchedPages,pageGroundedCitation} from './research-gate.mjs';
const out=process.argv[2];if(!out||!path.isAbsolute(out))throw Error('absolute private output required');
const rows=fs.readFileSync(path.join(out,'trials.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const median=a=>{const s=[...a].sort((x,y)=>x-y);return s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2;};
const groups={};
for(const r of rows){
 const hasWeb=r.sources.some(s=>s.kind==='web');
 r.audit={noFuture:r.checks.noFuture,under30:r.checks.under30,lengthPass:r.checks.wordCount<=(r.caseId==='actual-4'?120:80),existingIds:r.checks.citationsExist,fetchedPages:fetchedPages(r.sources).length,pageCited:hasWeb?pageGroundedCitation(r.answer,r.sources):null,manualGroundingRequired:true};
 const name=r.freshWeb?'fresh-'+(r.queryStrategy??(r.query?.startsWith('site:')?'irs-site':'generic')):r.variant;
 (groups[name]??=[]).push(r);
}
const summary=Object.fromEntries(Object.entries(groups).map(([name,rs])=>[name,{trials:rs.length,medianMs:median(rs.map(r=>r.totalMs)),maxMs:Math.max(...rs.map(r=>r.totalMs)),medianTranscriptChars:median(rs.map(r=>r.sourceChars)),wordBudgetFailures:rs.filter(r=>!r.audit.lengthPass).length,providerErrors:rs.filter(r=>r.error).length,pageReadFailures:rs.filter(r=>r.sources.some(s=>s.kind==='web')&&!r.audit.fetchedPages).length,pageCitationFailures:rs.filter(r=>r.audit.pageCited===false).length,retries:rs.filter(r=>r.rejectedDraft).length}]));
fs.writeFileSync(path.join(out,'AUTOMATED_AUDIT.json'),JSON.stringify({trials:rows.length,summary,notes:'Necessary automated checks only. A valid ID/page read does not prove claim support, relevance, authority or completeness. Manual audit remains required.',rows:rows.map(r=>({key:r.key,audit:r.audit}))},null,2));
console.log(JSON.stringify(summary,null,2));
