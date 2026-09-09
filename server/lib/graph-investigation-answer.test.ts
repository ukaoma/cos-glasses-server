import { expect, it } from 'vitest'
import { normalizeGraphAnswer } from './cos-context-browser.js'
it('retains the bounded read-only plan across the server response boundary', () => {
 const investigation = { status:'ready', nodes:[{id:'Orion'}], links:[], anchors:['Orion'], waypoints:[], filters:{hops:3}, generation:{base:'fixture'}, paths:[], action:'save_assertion' }
 const out=normalizeGraphAnswer({answer:'Synthetic [S1]',investigation})!
 expect(out.investigation?.anchors).toEqual(['Orion']);expect(out.investigation?.generation).toEqual({base:'fixture'});expect(out.investigation).not.toHaveProperty('action')
})
it('preserves unavailable explanations and refuses oversized canvases', () => {
 expect(normalizeGraphAnswer({answer:'a',investigation:{status:'unavailable',message:'Ambiguous'}})?.investigation?.message).toBe('Ambiguous')
 expect(normalizeGraphAnswer({answer:'a',investigation:{status:'ready',nodes:Array(201).fill({id:'x'}),links:[]}})?.investigation).toBeUndefined()
 expect(normalizeGraphAnswer({answer:'old server'})).not.toHaveProperty('investigation')
})
