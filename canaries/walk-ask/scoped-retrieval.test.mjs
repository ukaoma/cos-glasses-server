import test from 'node:test';import assert from 'node:assert/strict';
import {scopedRetrieve} from './scoped-retrieval.mjs';
const turns=[
 {id:0,elapsedMs:0,speaker:'A',text:'Marketing content was cut.'},
 {id:1,elapsedMs:100000,speaker:'B',text:'My 401(k) balance is $999,999.'},
 {id:2,elapsedMs:200000,speaker:'B',text:'The person calling me said I cannot just leave it there.'},
 {id:3,elapsedMs:205000,speaker:'A',text:'That may be a sales tactic; we have not verified it.'},
 {id:4,elapsedMs:250000,speaker:'B',text:'Future: new corrected terms.'}
];
test('generic plan rules exclude unrelated account-balance passage',()=>{
 const r=scopedRetrieve({turns,action:'ask',elapsedMs:210000,question:'Fact check leaving my 401(k) in place'});
 assert.deepEqual(r.rows.map(t=>t.id),[2,3]);
});
test('summary action wins over prior retirement question and preserves full prefix',()=>{
 const r=scopedRetrieve({turns,action:'summary',elapsedMs:210000,question:'Summarize'},[{question:'Do web search for 401(k) rules'}]);
 assert.deepEqual(r.rows.map(t=>t.id),[0,1,2,3]);assert.match(r.coverage,/complete/);
});
test('missing exact fee does not retrieve balances as fee evidence',()=>{
 const r=scopedRetrieve({turns,action:'ask',elapsedMs:210000,question:"What is the plan's exact annual admin fee?"});
 assert.equal(r.rows.length,0);assert.match(r.coverage,/no explicit/);
});
test('explicit fee evidence remains available without future correction',()=>{
 const r=scopedRetrieve({turns:[...turns,{id:5,elapsedMs:209000,speaker:'A',text:'The annual admin fee is $90.'}],action:'ask',elapsedMs:210000,question:"What is the plan's exact annual admin fee?"});
 assert.deepEqual(r.rows.map(t=>t.id),[5]);
});
