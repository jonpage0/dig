import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionItems } from '../src/surfaces.mjs';
const item = (overrides = {}) => ({title:'A matching research question',startedAt:'2026-01-01T00:00:00Z',reportDetails:[],...overrides});
const report = (n,at) => ({file:`p/digs/d/hackernews-${n}.md`,source:'hackernews',method:'hackernews',summary:'matching evidence',at});
test('composer mentions sort document timestamps before limiting, including answers and reports in the same dig', () => {
  const reportDetails=Array.from({length:21},(_,i)=>report(i+1,`2026-01-${String(i+1).padStart(2,'0')}T00:00:00Z`));
  const result=mentionItems({items:[item({reportDetails,answer:'p/digs/d/answer.md',finishedAt:'2026-01-22T00:00:00Z'})]},'matching');
  assert.equal(result.length,20);
  assert.equal(result[0].name,'answer.md');
  assert.equal(result[1].name,'hackernews-21.md');
  assert.ok(!result.some(x=>x.name==='hackernews-1.md'));
  assert.ok(!result.some(x=>x.name==='hackernews-2.md'));
});
test('composer mentions use dig start for legacy timestamps and a deterministic file fallback', () => {
  const legacy=item({startedAt:'2026-02-01T00:00:00Z',reportDetails:[report(2,null),report(1,'invalid')]});
  const old=item({reportDetails:[report(3,'2026-01-15T00:00:00Z')]});
  const result=mentionItems({items:[old,legacy]},'matching');
  assert.deepEqual(result.map(x=>x.name),['hackernews-1.md','hackernews-2.md','hackernews-3.md']);
});

test('composer mentions distinguish documents from one question and show bounded saved summaries', () => {
  const title = 'What current plugin developments should guide the next native research interface? '.repeat(4);
  const data = item({title, answer:'p/digs/d/answer.md', finishedAt:'2026-01-04T00:00:00Z', reportDetails:[
    {file:'p/digs/d/x-judge.md',source:'x',method:'x-judge',summary:'A verified original\n supports the claim.',at:'2026-01-03T00:00:00Z'},
    {file:'p/digs/d/x-breadth-2.md',source:'x',method:'x-breadth',summary:'More source context. '.repeat(25),at:'2026-01-02T00:00:00Z'},
  ]});
  const result = mentionItems({items:[data]}, 'plugin');
  assert.deepEqual(result.map(value=>value.title.split(' · ').at(-1)), ['Answer','X judge report','X breadth report 2']);
  assert.ok(result.every(value=>value.title.length<=120));
  assert.match(result[0].description,/2026/);
  assert.match(result[1].description,/A verified original supports the claim\./);
  assert.ok(result[2].description.length<180);
  assert.deepEqual(result.map(value=>decodeURIComponent(value.uri.replace('dig://library/',''))),
    ['p/digs/d/answer.md','p/digs/d/x-judge.md','p/digs/d/x-breadth-2.md']);
  assert.equal(mentionItems({items:[data]},'verified original')[0].name,'x-judge.md');
});
