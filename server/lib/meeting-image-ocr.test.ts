import {describe,it,expect} from 'vitest';
import {imageRows,imageTextHasSecrets,readMeetingImage} from './meeting-image-ocr.js';
describe('Local image text safety and table grounding',()=>{
 it('reconstructs rows from column-first OCR without attaching a stat to the wrong character',()=>{
  const line=(text:string,x:number,y:number)=>({text,x,y,height:0.02,confidence:1});
  expect(imageRows([line('Mavuika',0.1,0.8),line('Wanderer',0.1,0.7),line('232.4',0.5,0.8),line('222.3',0.5,0.7)]).text).toBe('Mavuika | 232.4\nWanderer | 222.3');
 });
 it('detects screen credential labels, split lines, gutters and token shapes',()=>{
  for(const text of ['PASSWORD=longprivateword','API Key: abc12345678','API Key | abc12345678','Client Secret\nabc12345678','12 | API_TOKEN=abc12345678','-----BEGIN PRIVATE KEY-----','sk-ant-abcdefghijklmnopqrstuvwxyz'])expect(imageTextHasSecrets(text),text).toBe(true);
  for(const text of ['Secret: Sauce','Token: ERC-20','TOKEN_COUNT=12345678','API Key: YOUR_API_KEY','Rank | Mavuika | 232.4'])expect(imageTextHasSecrets(text),text).toBe(false);
 });
 it('refuses malformed OCR, links and pre-cancelled work',async()=>{
  expect(()=>imageRows([{text:'x',x:NaN,y:0,height:0.1,confidence:1}])).toThrow('invalid_ocr');
  const c=new AbortController();c.abort();await expect(readMeetingImage('/nonexistent',c.signal)).rejects.toThrow();
 });
});

describe('Full-image credential checks',()=>{
 it('never treats a secret beyond the admitted excerpt as safe',()=>{
  expect(imageTextHasSecrets('Public text\n'.repeat(20000)+'\nClient Secret | abcdefgh123456')).toBe(true);
 });
 it('notes uncertainty and refuses unbounded native results',()=>{
  expect(imageRows([{text:'name',x:0,y:0.5,height:0.1,confidence:0.5}]).lowConfidence).toBe(true);
  expect(()=>imageRows(Array.from({length:10001},()=>({text:'a',x:0,y:0,height:0.1,confidence:1})))).toThrow();
 });
});
