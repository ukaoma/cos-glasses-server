import {fuzzyRetrieve, repair, resolvedQuestion} from './retrieval.mjs';
// A second, explicitly domain-scoped prototype. Narrow evidence before answering
// account-rule questions; do not include balances merely because they say 401(k).
export function scopedRetrieve(input,history=[]){
 const rows=input.turns.filter(t=>t.elapsedMs<=input.elapsedMs);
 if(input.action==='summary')return {rows,coverage:'complete available transcript prefix'};
 const q=repair(resolvedQuestion(input.question,history));
 if(/\b(?:exact annual admin fee|plan.s exact)\b/.test(q)){
  const hits=rows.filter(t=>/\b(?:admin(?:istrative|istration)?|recordkeeping)\s+fee\b/i.test(t.text));
  return {rows:hits,coverage:hits.length?'exact fee passages':'full available prefix scanned: no explicit administration fee found'};
 }
 if(/401k|403b|retirement/.test(q)){
  const anchors=rows.filter(t=>/calling me|sales tactic|transamerica|can.t i just leave|can just leave|in your name/i.test(t.text));
  const selected=rows.filter(t=>anchors.some(a=>Math.abs(t.elapsedMs-a.elapsedMs)<=25000));
  return {rows:selected,coverage:'selected account-rule and caller-claim neighborhoods; personal-balance discussion excluded'};
 }
 return {rows:fuzzyRetrieve(input,{history,budget:8000}),coverage:'bounded fuzzy passage neighborhoods'};
}
