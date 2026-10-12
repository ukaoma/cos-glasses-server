// Replay-only prototype. No production imports, endpoints, state or flags.
const STOP = new Set('i we our my you your the a an of and or to in at is are was were it this that these those what why how did do does can could would should be for from with on me tell please summarize search web without any public information just use account accounts anchor based off conversation having actually true after company employer sponsored name problem leave them fact check'.split(' '));
export function repair(text) {
 return text.toLowerCase().replace(/401\s*\(?k\)?/g,'401k').replace(/4013403b|4013b|four\s+(?:or\s+)?3b|four\s+oh\s+three\s+b|403\s*\(?b\)?/g,'403b').replace(/park apart from|depart from/g,'leave');
}
export function terms(text) {return [...new Set((repair(text).match(/[a-z0-9]{3,}/g)||[]).filter(w=>!STOP.has(w)))];}
export function isFollowup(q) {return /^(?:do|run|search|look|check)\b/i.test(q.trim()) && (!terms(q).length || /\b(?:it|that|anchor)\b/i.test(q));}
export function resolvedQuestion(q, history=[]) {
 if(isFollowup(q)) return [...history.slice(-3).map(h=>h.question),q].join('\n');
 if(/\b(?:person on the phone|caller|still unverified|exact annual admin fee|plan.s exact)\b/i.test(q) && history.length) return history.at(-1).question+'\n'+q;
 return q;
}
function grams(s) {s=repair(s).replace(/[^a-z0-9]/g,'');return new Set(Array.from({length:Math.max(0,s.length-2)},(_,i)=>s.slice(i,i+3)));}
function dice(a,b) {const x=grams(a),y=grams(b); if(!x.size||!y.size)return 0;let n=0;for(const v of x)if(y.has(v))n++;return 2*n/(x.size+y.size);}
export function fuzzyRetrieve(input,{history=[],query,budget=8000}={}) {
 const rows=input.turns.filter(t=>t.elapsedMs<=input.elapsedMs).sort((a,b)=>a.elapsedMs-b.elapsedMs);
 const summary=input.action==='summary'; const q=query||resolvedQuestion(input.question,history); let kws=terms(q);
 if(kws.some(w=>/^(?:401k|403b|retirement|rollover)$/.test(w)))kws=[...new Set([...kws,'401k','403b','retirement','provider','plan','caller','leave','leaving'])];
 const docs=rows.map(t=>terms(t.text));const df=new Map();for(const words of docs)for(const w of words)df.set(w,(df.get(w)||0)+1);
 const avg=docs.reduce((n,d)=>n+d.length,0)/Math.max(rows.length,1); const scores=docs.map((words,i)=>kws.reduce((n,w)=>{
  const match=words.some(v=>v===w);const approximate=!match&&w.length>=5&&words.some(v=>v.length>=5&&dice(w,v)>=.65);
  if(!match&&!approximate)return n;return n+Math.log(1+(rows.length-(df.get(w)||0)+.5)/((df.get(w)||0)+.5))*(match?1:.35)/(1+.3*words.length/Math.max(avg,1));
 },0)+(rows[i].elapsedMs>=input.elapsedMs-180000 ? 1 : 0));
 const selected=new Set();let used=0;const cost=t=>t.text.length+t.speaker.length+90;
 const add=(i)=>{if(i<0)return; const hood=rows.map((t,j)=>({t,j})).filter(({t,j})=>Math.abs(j-i)<=4&&Math.abs(t.elapsedMs-rows[i].elapsedMs)<=30000).map(({j})=>j).filter(j=>!selected.has(j));const size=hood.reduce((n,j)=>n+cost(rows[j]),0);if(used+size>budget)return;for(const j of hood)selected.add(j);used+=size;};
 if(summary){ // explicit broad summary gets temporal coverage, never a recent-only substitution.
  for(let b=0;b<8;b++){const indices=rows.map((_,i)=>i).filter(i=>Math.min(7,Math.floor(rows[i].elapsedMs*8/Math.max(1,input.elapsedMs)))===b); if(indices.length)add(indices[Math.floor(indices.length/2)]);}
  for(let i=rows.length-1;i>=0;i--)add(i);
 }else{
  const ranked=rows.map((_,i)=>i).sort((a,b)=>scores[b]-scores[a]||rows[b].elapsedMs-rows[a].elapsedMs);
  for(const i of ranked)if(scores[i]>1)add(i);
  if(!selected.size)for(let i=rows.length-1;i>=0;i--)add(i);
 }
 return rows.filter((_,i)=>selected.has(i));
}
const SENSITIVE=/\b(?:salary|password|token|address|diagnosis|medical|email|phone number|balance|confidential)\b|\$\s*\d/i;
export function publicQuery(question,history=[],planner=null) {
 // Public-topic allowlist proof for this bounded retirement canary only, NOT general production policy.
 if(SENSITIVE.test(question))return null;
 const resolved=resolvedQuestion(question,history);
 if(!/\b(?:search|fact.check|verify|is it.*true)\b/i.test(resolved))return null;
 if(!/401k|403b|retirement/.test(repair(resolved)))return null;
 // A model can suggest intent; it cannot choose a public payload or silently promote a private topic.
 if(planner && planner.publicTopic!== 'retirement_plan_options')return null;
 return '401(k) 403(b) leaving employer keep money in old retirement plan IRS Department of Labor';
}
export function sources(rows) {return rows.map(t=>({id:`T${t.id}`,kind:'transcript',turnId:t.id,elapsedMs:t.elapsedMs,title:`${t.speaker} at ${Math.floor(t.elapsedMs/60000)} minutes`,text:t.text}));}
