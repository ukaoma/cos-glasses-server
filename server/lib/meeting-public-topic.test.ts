import {describe,it,expect} from 'vitest';
import {admitPublicTopic,publicTopicContext} from './meeting-public-topic.js';
const input={history:[],sessionId:'meeting_test',question:'Can you fact check this',elapsedMs:400000,turns:[{id:1,elapsedMs:100,speaker:'Alex Rivera',text:'Private old family information'},{id:2,elapsedMs:350000,speaker:'Blair Cooper',text:'New York firehouse roof repair on City Island cost $750,000.'}],action:'ask' as const};
const candidate={publicTopic:true,category:'public_project',evidenceTurnIds:[2],query:'New York firehouse roof repair City Island 750000'};
describe('local public-topic admission',()=>{
 it('admits observed public subject words and joined numeric punctuation',()=>{expect(admitPublicTopic(candidate,input)).toBe(candidate.query.toLowerCase())});
 it('contains no speaker identities, earlier history, files or future transcript in the selector input',()=>{
 const context=publicTopicContext({...input,turns:[...input.turns,{id:3,elapsedMs:500000,speaker:'Someone',text:'Future confidential fact'}]});
 expect(context.transcript).not.toMatch(/Alex|Blair|Private old|Future/);expect(Object.keys(context)).toEqual(['question','transcript','previousPublicQuery']);
 });
 it.each([{...candidate,publicTopic:false},{...candidate,category:'private_business'},{...candidate,query:'Blair Cooper firehouse roof repair'}, {...candidate,query:'New York private client roof repair'},{...candidate,query:'New York roof repair 97000'}])('rejects private, identity, invented name or invented price %#',v=>expect(admitPublicTopic(v,input)).toBeNull());
 it('refuses non fact-check requests and private questions even with a public plan',()=>{
 expect(admitPublicTopic(candidate,{...input,question:'Catch me up'})).toBeNull();expect(admitPublicTopic(candidate,{...input,question:'Fact check my employee salary'})).toBeNull();
 });
 it('retains a prior admitted public topic for a comparison without borrowing private later words',()=>{
 const next={...input,question:'Compare cost to other similar fixes in that area',turns:[{id:3,elapsedMs:390000,speaker:'MU',text:'Private client contract is 25000.'}]};
 expect(admitPublicTopic({...candidate,evidenceTurnIds:[]},next,candidate.query)).toBe(candidate.query.toLowerCase());expect(admitPublicTopic({...candidate,query:'Private client contract 25000'},next,candidate.query)).toBeNull();
 });
 it('filters invented names and refuses fabricated or private supporting quotes',()=>{expect(admitPublicTopic({...candidate,query:'New York Mamdani roof repair'},input)).toBe('new york roof repair');expect(admitPublicTopic({...candidate,evidenceTurnIds:[900]},input)).toBeNull();expect(admitPublicTopic({...candidate,evidenceTurnIds:[1]},input)).toBeNull()});
});
