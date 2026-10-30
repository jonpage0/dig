import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { cardDetails, compactTitle, digLink, readRetained, webLink } from '../src/frontend/card/model.ts';

const window = new Window({ url: 'http://localhost/?preview=1' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  const value = name === 'window' ? window : name === 'getComputedStyle' || name.endsWith('AnimationFrame') ? window[name].bind(window) : window[name];
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { CardApp } = await import('../src/frontend/card/App.tsx');
const { act } = React;

let root;
afterEach(async () => { if (root) { await act(async () => root.unmount()); root = null; } document.body.replaceChildren(); });
after(() => { window.happyDOM.abort(); });
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); });
const file = 'project/digs/question/dataforseo.md';
const raw = 'project/sessions/thread/raw/result.json';
const card = overrides => ({
  file, path: '/library/report.md', kind: 'report', title: 'Make the cancellation policy clear', question: 'How can this site answer the customer question?',
  label: 'DataForSEO', status: 'partial', savedAt: '2026-10-20T12:00:00.000Z',
  summary: 'A saved summary.', retrievals: 3, glyph: 'search', link: null,
  cost: { byUnit: { USD: 0.03, credits: 2, 'Scrape.do credits': 4 }, unknownCalls: 1, freeCalls: 0, totalCalls: 3, scope: 'report' },
  findings: [], contradictions: [], followUps: [], schemaWarnings: [],
  insights: [], ...overrides,
});
function fakeHost(overrides = {}) {
  const calls = [], drafts = [], links = [], files = [];
  let subscriber;
  const host = {
    preview: false, calls, drafts, links, files,
    start: async () => {}, dispose() {}, getContext: () => ({}), readDeepLink: () => null,
    canOpenFile: () => true, canDraft: () => true, requestDisplayMode: async () => null,
    subscribeResult(callback) { subscriber = callback; return () => { subscriber = null; }; },
    subscribeActivation: () => () => {},
    emit: value => subscriber?.(value),
    call: async (name, args) => { calls.push({ name, args }); if (name === 'saved_research') return card({ file: args.file }); throw new Error(`Unexpected read ${name}`); },
    openLink: async url => { links.push(url); }, openFile: async path => { files.push(path); },
    draft: async prompt => { drafts.push(prompt); },
    ...overrides,
  };
  return host;
}
async function render(host, initialResult = { file, path: '/library/report.md', card: card() }) {
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(React.createElement(CardApp, { host, initialResult })));
  await settle();
  return container;
}
const buttons = () => [...document.querySelectorAll('button')];
const buttonName = element => { const clone = element.cloneNode(true); for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove(); return element.getAttribute('aria-label') || clone.textContent; };
const button = label => { const found = buttons().find(element => buttonName(element) === label); assert.ok(found, `Missing button ${label}`); return found; };
async function click(label) { await act(async () => { const target = button(label); target.focus(); target.click(); }); await settle(); }
const body = () => document.body.textContent;

test('bounded evidence reading rejects inconsistent pagination and mismatched files', async () => {
  await assert.rejects(() => readRetained(async () => ({ file: 'wrong.md', text: 'wrong', offset: 0, nextOffset: null }), raw, () => true, () => {}), /unexpected evidence page/);
  await assert.rejects(() => readRetained(async () => ({ file: raw, text: 'loop', offset: 0, nextOffset: 0 }), raw, () => true, () => {}), /unexpected evidence page/);
  await assert.rejects(() => readRetained(async () => ({ file: raw, text: 'skip', offset: 0, nextOffset: 10, totalCharacters: 20 }), raw, () => true, () => {}), /unexpected evidence page/);
  await assert.rejects(() => readRetained(async () => ({ file: raw, text: 'partial', offset: 0, nextOffset: null, totalCharacters: 20 }), raw, () => true, () => {}), /unexpected evidence page/);
  assert.throws(() => cardDetails(card(), 'different.md'), /different or unreadable/);
  assert.equal(webLink('https://user:secret@example.com'), null);
  assert.equal(webLink('data:text/html,test'), null);
  assert.equal(digLink('codex://plugins/other@app/app/open_library?path=%2Fread%3Ffile%3Dx'), null);
  assert.match(digLink('codex://plugins/dig@dig/app/open_library?path=%2Fread%3Ffile%3Dx'), /^codex:/);
});

test('legacy relative evidence pins its first canonical path before requesting later pages', async () => {
  const calls = [], pages = [];
  const result = await readRetained(async (_name, args) => {
    calls.push(args);
    return { file: raw, path: `/library-A/${raw}`, offset: args.offset, text: args.offset ? 'AAA' : 'FIRST', nextOffset: args.offset ? null : 5, totalCharacters: 8 };
  }, raw, () => true, page => pages.push(page.text));
  assert.deepEqual(calls, [
    { file: raw, offset: 0, limit: 60000 },
    { file: `/library-A/${raw}`, offset: 5, limit: 60000 },
  ]);
  assert.deepEqual(pages, ['FIRST', 'FIRSTAAA']);
  assert.equal(result.text, 'FIRSTAAA');
});

test('same relative file and length from another library never append foreign evidence', async () => {
  const pages = [], calls = [];
  await assert.rejects(() => readRetained(async (_name, args) => {
    calls.push(args);
    return { file: raw, path: `/${args.offset ? 'library-B' : 'library-A'}/${raw}`, offset: args.offset, text: args.offset ? 'BBB' : 'AAA', nextOffset: args.offset ? null : 3, totalCharacters: 6 };
  }, raw, () => true, page => pages.push(page.text)), /different retained file/);
  assert.equal(calls[1].file, `/library-A/${raw}`);
  assert.deepEqual(pages, ['AAA']);
});

test('a known card path refuses details from the same relative file in another library', async () => {
  const host = fakeHost({ call: async (name, args) => {
    host.calls.push({ name, args });
    return card({ path: '/library-B/report.md', title: 'Foreign report' });
  } });
  await render(host, { file, path: '/library-A/report.md' });
  assert.deepEqual(host.calls, [{ name: 'saved_research', args: { file: '/library-A/report.md' } }]);
  assert.match(body(), /different or unreadable research file/);
  assert.doesNotMatch(body(), /Foreign report|Answer the cancellation question/);
});

test('an old card requests its absolute evidence path after an active-library switch', async () => {
  const host = fakeHost({ call: async (name, args) => {
    host.calls.push({ name, args });
    if (args.file === '/library/report.md') throw new Error('This file is outside the selected library.');
    return { file: raw, path: `/library-B/${raw}`, text: 'FOREIGN EVIDENCE', offset: 0, nextOffset: null, totalCharacters: 16 };
  } });
  await render(host);
  await click('Open');
  assert.deepEqual(host.calls, [{ name: 'library_read', args: { file: '/library/report.md', offset: 0, limit: 60000 } }]);
  assert.match(body(), /outside the selected library/);
  assert.doesNotMatch(body(), /FOREIGN EVIDENCE|Complete retained file/);
});

test('retained read refuses a changed total even when file and canonical path match', async () => {
  const pages = [];
  await assert.rejects(() => readRetained(async (_name, args) =>
    ({ file: raw, path: `/library-A/${raw}`, offset: args.offset, text: args.offset ? 'BBBB' : 'AAA', nextOffset: args.offset ? null : 3, totalCharacters: args.offset ? 7 : 6 }),
  raw, () => true, page => pages.push(page.text)), /unexpected evidence page/);
  assert.deepEqual(pages, ['AAA']);
});


test('result cards show compact identity, sources, time and separate provider costs with one Open button', async () => {
  const host = fakeHost(); await render(host);
  assert.match(body(), /Make the cancellation policy clear/);
  assert.match(body(), /DataForSEO/); assert.match(body(), /Oct 20/);
  assert.match(body(), /\$0\.0300/); assert.match(body(), /2 ScrapeCreators credits/); assert.match(body(), /4 Scrape\.do credits/); assert.match(body(), /unpriced/);
  assert.match(document.querySelector('.insight-cost').title, /This report.*subtotal.*total unknown/);
  assert.deepEqual(buttons().map(buttonName), ['Open']);
  assert.doesNotMatch(body(), /A saved summary|cancellation section|What came back|Findings|next step|One answer does not establish/);
  assert.deepEqual(host.calls, []); assert.deepEqual(host.drafts, []);
});

test('save cards read existing metadata only; answers show cited sources and dig-scoped costs', async () => {
  const host = fakeHost({call: async (name,args) => {host.calls.push({name,args});return card({kind:'answer',label:'Answer',reports:['GitHub','Exa','GitHub'],insights:[],cost:{byUnit:{USD:.03},unknownCalls:0,freeCalls:0,totalCalls:3,scope:'dig'}});}});
  await render(host,{structuredContent:{file,path:'/library/report.md'}});
  assert.deepEqual(host.calls,[{name:'saved_research',args:{file:'/library/report.md'}}]);
  assert.match(body(),/Answer savedGitHub \+ Exa/);
  assert.match(document.querySelector('.insight-cost').title,/This dig/);
  assert.deepEqual(buttons().map(buttonName),['Open']);
});

test('titles are bounded for older servers without exposing summaries or executing markup', async () => {
  const title='A very long research question about indoor maps, video capture, radio tags and independent positioning. '.repeat(8);
  await render(fakeHost(),{file,card:card({title})});
  assert(document.querySelector('h2').textContent.length<=96);
  assert(document.querySelector('h2').textContent.endsWith('…'));
  assert.equal(compactTitle('Short title'),'Short title');
  await act(async()=>root.render(React.createElement(CardApp,{host:fakeHost(),initialResult:{file,card:card({title:'<img src=x onerror=bad()> <script>bad()</script>'})}})));await settle();
  assert.equal(document.querySelector('img,script'),null);
  assert.match(body(),/<script>bad\(\)<\/script>/);
});

test('new tool results supersede delayed card metadata and close old reads', async () => {
  let finish; const host=fakeHost({call:()=>new Promise(resolve=>{finish=resolve;})});
  await render(host,{file});
  const next='project/digs/next/youtube.md';
  await act(async()=>host.emit({file:next,path:'/library/next.md',card:card({file:next,path:'/library/next.md',title:'New report'})}));
  await act(async()=>finish(card()));
  assert.match(body(),/New report/);assert.doesNotMatch(body(),/Make the cancellation policy clear/);
});

test('Open follows the exact native Dig link without a provider call', async () => {
  const link='codex://plugins/dig@dig/app/open_library?path=%2Fread%3Ffile%3Dreport';
  const host=fakeHost();await render(host,{file,path:'/library/report.md',card:card({link})});await click('Open');
  assert.deepEqual(host.links,[link]);assert.deepEqual(host.calls,[]);assert.equal(document.querySelector('[role="dialog"]'),null);
});

test('a rejected Dig link opens the same canonical report completely and asks for fullscreen', async () => {
  const first='# Report\n',last='Original <b>literal</b> research.';const modes=[];
  const host=fakeHost({openLink:async url=>{host.links.push(url);throw Error('Unsupported link');},requestDisplayMode:async mode=>{modes.push(mode);return null;},call:async(name,args)=>{host.calls.push({name,args});return{file,path:'/library/report.md',offset:args.offset,text:args.offset?last:first,nextOffset:args.offset?null:first.length,totalCharacters:first.length+last.length};}});
  await render(host,{file,path:'/library/report.md',card:card({link:'codex://plugins/dig@dig/app/open_library?path=%2Fread%3Ffile%3Dreport'})});await click('Open');
  assert.deepEqual(modes,['fullscreen']);assert.deepEqual(host.calls.map(x=>x.args.file),['/library/report.md','/library/report.md']);
  assert.equal(document.querySelector('pre').textContent,first+last);assert.equal(document.querySelector('pre b'),null);assert.match(body(),/Complete retained file/);
});

test('closing the fallback reader ignores a delayed page and stops pagination', async () => {
  let finish;const host=fakeHost({call:async(name,args)=>{host.calls.push({name,args});return new Promise(resolve=>{finish=resolve;});}});
  await render(host);await click('Open');await click('Close dialog');
  await act(async()=>finish({file,path:'/library/report.md',offset:0,text:'stale',nextOffset:5,totalCharacters:10}));
  assert.doesNotMatch(body(),/stale/);assert.equal(host.calls.length,1);
});

test('a late navigation failure cannot open a replaced card or displace a newer reader', async () => {
  const rejected=[];const host=fakeHost({openLink:()=>new Promise((_resolve,reject)=>rejected.push(reject))});
  const link='codex://plugins/dig@dig/app/open_library?path=%2Fread%3Ffile%3Dreport';
  await render(host,{file,path:'/library/report.md',card:card({link})});await click('Open');
  const next='project/digs/next/youtube.md';await act(async()=>host.emit({file:next,path:'/library/next.md',card:card({file:next,path:'/library/next.md',title:'New research',link})}));
  await act(async()=>rejected[0](Error('Old navigation rejected')));
  assert.match(body(),/New research/);assert.equal(document.querySelector('[role="dialog"]'),null);assert.deepEqual(host.calls,[]);
});

test('a failed save is a small explicit error, with no saved claim or Open action', async () => {
  const host=fakeHost();await render(host,{isError:true,content:[{type:'text',text:'Invalid report reference'}]});
  assert.match(body(),/Save failed/);assert.match(body(),/Invalid report reference/);
  assert.doesNotMatch(body(),/Answer saved|Report saved|Research details are unavailable/);assert.deepEqual(buttons(),[]);assert.deepEqual(host.calls,[]);
});

test('unpriced calls stay unknown and no calls make no zero-cost claim', async () => {
  const host=fakeHost();await render(host,{file,card:card({cost:{byUnit:{},unknownCalls:3,totalCalls:3,freeCalls:0,scope:'report'}})});
  assert.match(body(),/cost unknown/);assert.doesNotMatch(body(),/\$0|no charge/);
  await act(async()=>host.emit({file,card:card({cost:{byUnit:{},unknownCalls:0,totalCalls:0,freeCalls:0,scope:'report'}})}));
  assert.equal(document.querySelector('.insight-cost'),null);assert.doesNotMatch(body(),/\$0|no charge/);
});

test('a failed refresh retains identity only for the same canonical saved file', async () => {
  let fail;const host=fakeHost({call:()=>new Promise((_resolve,reject)=>{fail=reject;})});await render(host);
  await act(async()=>host.emit({file,path:'/library/report.md'}));await act(async()=>fail(Error('Library unavailable')));
  assert.match(body(),/Make the cancellation policy clear/);assert.match(body(),/Library unavailable/);assert.match(body(),/\$0\.0300/);assert.ok(button('Open'));
});
