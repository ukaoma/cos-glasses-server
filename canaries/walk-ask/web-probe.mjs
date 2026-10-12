import fs from 'node:fs';import path from 'node:path';import {publicQuery} from './retrieval.mjs';
const out=process.argv[2];if(!out)throw Error('private output directory required');
process.env.COS_DATA_DIR=path.join(out,'isolated-data');
for(const f of ['COS_BATCH_HQ_TIMESTAMPS','COS_MEETING_ASK_HQ_EVIDENCE','COS_LIVE_CUES_FOUNDATION_DEV','COS_LIVE_CUES_GROUNDED_V2','COS_LIVE_CUES_RESEARCH'])process.env[f]='0';
const {searchMeetingWeb}=await import('../../server/lib/meeting-ask-web.ts');
const query=process.argv[3]==='official-title'?'IRS Retirement Topics Termination of Employment keep savings former employer retirement plan':publicQuery('Fact check whether leaving a 401(k) or 403(b) retirement plan with the old employer is allowed');if(!query)throw Error('no admitted query');
const start=Date.now();const result=await searchMeetingWeb(query,AbortSignal.timeout(30000));
fs.writeFileSync(path.join(out,process.argv[3]==='official-title'?'official-title-web-pack.json':'web-pack.json'),JSON.stringify({query,ms:Date.now()-start,at:new Date().toISOString(),...result},null,2));
console.log(JSON.stringify({query,ms:Date.now()-start,sources:result.sources.map(s=>({id:s.id,title:s.title,url:s.url,fetched:s.text?.startsWith('Retrieved page excerpt')})),notices:result.notices}));
