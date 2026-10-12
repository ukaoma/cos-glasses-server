import test from 'node:test';import assert from 'node:assert/strict';
import {fetchedPages,pageGroundedCitation} from './research-gate.mjs';
const summary={id:'W0',kind:'web',text:'Search summary says the rule is true.'};
const title={id:'W1',kind:'web',url:'https://example.org/rules',text:'Search result title and URL only; page not fetched.'};
const page={...title,text:'Retrieved page excerpt: '+ 'Supported general plan rules. '.repeat(12)};
test('summary plus links does not pass a page-read gate',()=>{assert.equal(fetchedPages([summary,title]).length,0);assert.equal(pageGroundedCitation({answer:'True [W0]'},[summary,title]),false);});
test('page fetched but uncited does not ground the answer',()=>{assert.equal(pageGroundedCitation({answer:'True [W0]'},[summary,page]),false);});
test('fetched page citation passes provenance only',()=>{assert.equal(pageGroundedCitation({answer:'General rule [W1]'},[summary,page]),true);});
