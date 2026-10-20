import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { cardDetails, digLink, readRetained, savedResearchNextStep, webLink } from '../src/frontend/card/model.ts';

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
  insights: [{
    title: 'Answer the cancellation question',
    statement: 'The competing page answers fees and timing; the owned page does not.',
    details: [{ label: 'Query → AI answer', value: 'Answer points to a competitor.', url: 'https://example.org/refunds' }, { label: 'Owned page', value: 'Terms do not answer the cancellation case.' }],
    evidence: [{ file: raw, path: '/library/raw.json', label: 'Retained AI answer', link: null }],
    limits: ['One answer does not establish a stable ranking.'],
    nextStep: { label: 'Draft a cancellation section', prompt: 'Help draft the cancellation section using this retained report.' },
  }], ...overrides,
});
function fakeHost(overrides = {}) {
  const calls = [], drafts = [], links = [], files = [];
  let subscriber;
  const host = {
    preview: false, calls, drafts, links, files,
    start: async () => {}, dispose() {}, getContext: () => ({}), readDeepLink: () => null,
    canOpenFile: () => true, canDraft: () => true,
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
async function inspectEvidence() { await click('Findings & evidence'); await click('Read evidence'); }

test('inline card keeps action and separate costs visible without a provider call or automatic draft', async () => {
  const host = fakeHost();
  await render(host);
  assert.match(body(), /Answer the cancellation question/);
  assert.match(body(), /Draft a cancellation section/);
  assert.match(body(), /Known provider subtotal/);
  assert.match(body(), /\$0\.0300/);
  assert.match(body(), /2 ScrapeCreators credits/);
  assert.match(body(), /4 Scrape\.do credits/);
  assert.match(body(), /Presented limitationOne answer does not establish/);
  assert.deepEqual(host.calls, []); assert.deepEqual(host.drafts, []);
  await click('Usage details');
  assert.match(body(), /total unknown/);
  assert.match(body(), /1 of 3 tool calls incompletely priced/);
  assert.match(body(), /Includes only calls attributed to this report/);
});

test('the save card reads existing research only and labels saved author assessments', async () => {
  const host = fakeHost({ call: async (name, args) => {
    host.calls.push({ name, args });
    return { structuredContent: card({ insights: [], findings: ['A reported finding.'], confidence: 'high', evidenceGrade: 'direct', followUps: ['Verify the page.'] }) };
  } });
  await render(host, { structuredContent: { file, path: '/library/report.md' } });
  assert.deepEqual(host.calls, [{ name: 'saved_research', args: { file: '/library/report.md' } }]);
  assert.match(body(), /A saved summary/);
  await click('Findings & evidence');
  assert.match(body(), /A reported finding/);
  await click('Report author’s assessment');
  assert.match(body(), /Author-reported confidence: high/);
  assert.match(body(), /Verify the page/);
  assert.equal(host.drafts.length, 0);
});

test('insight details use fixed text rendering and refuse unsafe external navigation', async () => {
  const host = fakeHost();
  const data = card();
  data.insights[0].statement = '<img src=x onerror="globalThis.pwned=true"> & <script>bad()</script>';
  data.insights[0].details.push({ label: 'Untrusted URL', value: '<b>literal</b>', url: 'javascript:alert(1)' });
  await render(host, { file, card: data });
  assert.equal(document.querySelector('img,script'), null);
  assert.match(body(), /<script>bad\(\)<\/script>/);
  await click('Findings & evidence');
  assert.match(body(), /<b>literal<\/b>/);
  assert.equal(buttons().filter(element => element.textContent === 'Open page').length, 1);
  await click('Open page');
  assert.deepEqual(host.links, ['https://example.org/refunds']);
});

test('new tool results supersede late saved-research reads and dismiss old evidence', async () => {
  const pending = new Map();
  const host = fakeHost({ call: (name, args) => new Promise(resolve => { pending.set(args.file, resolve); }) });
  await render(host, { file });
  const next = 'project/digs/next/youtube.md';
  await act(async () => host.emit({ structuredContent: { file: next, card: card({ file: next, title: 'New report', insights: [], findings: ['Newest finding.'] }) } }));
  await act(async () => pending.get(file)(card()));
  assert.match(body(), /New report/);
  await click('Findings & evidence');
  assert.match(body(), /Newest finding/);
  assert.doesNotMatch(body(), /Answer the cancellation question/);
});

test('selected retained evidence reads all pages and remains plain text', async () => {
  const first = '{"first":"<b>literal</b>",';
  const last = '"last":1}';
  const host = fakeHost({ call: async (name, args) => {
    host.calls.push({ name, args });
    return { structuredContent: { file: raw, path: '/library/raw.json', offset: args.offset, totalCharacters: first.length + last.length,
      text: args.offset === 0 ? first : last, nextOffset: args.offset === 0 ? first.length : null } };
  } });
  await render(host);
  await inspectEvidence();
  assert.deepEqual(host.calls, [
    { name: 'library_read', args: { file: '/library/raw.json', offset: 0, limit: 60000 } },
    { name: 'library_read', args: { file: '/library/raw.json', offset: first.length, limit: 60000 } },
  ]);
  assert.match(document.querySelector('pre').textContent, /\{"first":"<b>literal<\/b>","last":1\}/);
  assert.equal(document.querySelector('pre b'), null);
  assert.match(body(), /Complete retained file/);
  await click('Open file');
  assert.deepEqual(host.files, ['/library/raw.json']);
});

test('closing evidence prevents a delayed page from appearing or fetching another page', async () => {
  let finish;
  const host = fakeHost({ call: (name, args) => { host.calls.push({ name, args }); return new Promise(resolve => { finish = resolve; }); } });
  await render(host);
  await inspectEvidence();
  await click('Close dialog');
  await act(async () => finish({ file: raw, text: 'STALE ORIGINAL', offset: 0, nextOffset: 60, totalCharacters: 100 }));
  assert.doesNotMatch(body(), /STALE ORIGINAL/);
  assert.equal(host.calls.length, 1);
});

test('missing raw text is an explicit read failure and not an empty finding', async () => {
  const host = fakeHost({ call: async () => { throw new Error('Retained original was not found.'); } });
  await render(host);
  await inspectEvidence();
  assert.match(body(), /could not be read completely/);
  assert.match(body(), /Retained original was not found/);
  assert.doesNotMatch(body(), /Complete retained file|No matches/);
});

test('draft preview is inert; an explicit action requests an unsent draft and reports failure honestly', async () => {
  const host = fakeHost({ draft: async prompt => { host.drafts.push(prompt); throw new Error('Host refused.'); } });
  await render(host);
  await click('Review next step');
  assert.equal(host.drafts.length, 0); assert.equal(host.calls.length, 0);
  assert.match(body(), /does not send a message or start research/);
  await click('Draft in composer');
  assert.deepEqual(host.drafts, ['Help draft the cancellation section using this retained report.']);
  assert.match(body(), /composer draft was not confirmed/);
  assert.doesNotMatch(body(), /Draft placed in the composer/);
});

test('preview and missing host capabilities offer copy rather than pretending to draft', async () => {
  const host = fakeHost({ preview: true, canDraft: () => false, canOpenFile: () => false });
  await render(host);
  await click('Review next step');
  assert.equal(buttons().some(element => element.textContent === 'Draft in composer'), false);
  assert.match(body(), /Composer drafts are unavailable here/);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  await click('Copy draft');
  assert.match(body(), /selected for manual copying/);
  const field = document.querySelector('textarea');
  assert.equal(field.selectionStart, 0); assert.equal(field.selectionEnd, field.value.length);
  assert.equal(host.drafts.length, 0);
});

test('unknown costs and an empty finding do not become zero or invented conclusions', async () => {
  const host = fakeHost();
  await render(host, { file, card: card({ insights: [], findings: [], cost: { byUnit: {}, unknownCalls: 3, freeCalls: 0, totalCalls: 3, scope: 'report' } }) });
  assert.match(body(), /Cost not reported/);
  await click('Findings & evidence');
  assert.match(body(), /No finding was supplied/);
  assert.doesNotMatch(body(), /\$0|No charge recorded/);
  await click('Inspect research');
  assert.match(body(), /could not be read completely/);
});

test('a failed save without a file does not claim that research was saved', async () => {
  const host = fakeHost();
  await render(host, { isError: true, content: [{ type: 'text', text: 'The save did not complete.' }] });
  assert.match(body(), /The save did not complete/);
  assert.doesNotMatch(body(), /Saved report|Saved answer|Full report/);
  assert.deepEqual(host.calls, []);
});

test('additional insights and report contradictions remain available without crowding the first finding', async () => {
  const data = card({ contradictions: ['A source disagrees with this interpretation.'] });
  data.insights.push({ title: 'Second finding', statement: 'Another bounded result.', details: [], evidence: [{ file, label: 'Saved report' }], limits: [] });
  await render(fakeHost(), { file, card: data });
  assert.doesNotMatch(body(), /Another bounded result/);
  await click('Findings & evidence');
  assert.match(body(), /Another bounded result/);
  await click('Report author’s assessment');
  assert.match(body(), /A source disagrees with this interpretation/);
});

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
    if (args.file === '/library/raw.json') throw new Error('This file is outside the selected library.');
    return { file: raw, path: `/library-B/${raw}`, text: 'FOREIGN EVIDENCE', offset: 0, nextOffset: null, totalCharacters: 16 };
  } });
  await render(host);
  await inspectEvidence();
  assert.deepEqual(host.calls, [{ name: 'library_read', args: { file: '/library/raw.json', offset: 0, limit: 60000 } }]);
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

test('a saved failed report separates the save event from the author assessment and keeps scope visible', async () => {
  await render(fakeHost(), { file, card: card({ status: 'failed', insights: [], findings: [], followUps: ['Try the documented endpoint.'] }) });
  assert.match(document.querySelector('.insight-header').textContent, /Report saved/);
  assert.doesNotMatch(document.querySelector('.insight-header').textContent, /failed/);
  assert.match(document.querySelector('.insight-assessment-line').textContent, /Report author’s assessmentfailed/);
  assert.match(document.querySelector('.insight-usage').textContent, /This report3 retained calls/);
  assert.match(document.querySelector('.insight-usage').textContent, /1 of 3 calls unpriced/);
  assert.match(body(), /Follow-up recordedTry the documented endpoint/);
  assert.equal(buttons().some(element => /pause|cancel|resume|start research/i.test(buttonName(element))), false);
});

test('saved answers use dig costs and answer status without claiming full completion', async () => {
  await render(fakeHost(), { file, card: card({ kind: 'answer', label: 'Answer', status: 'partly answered', insights: [], reports: ['Exa', 'DataForSEO'],
    cost: { byUnit: {}, unknownCalls: 2, freeCalls: 1, totalCalls: 3, scope: 'dig' } }) });
  assert.match(document.querySelector('.insight-header').textContent, /Answer saved/);
  assert.match(document.querySelector('.insight-assessment-line').textContent, /Answer statuspartly answered/);
  assert.match(document.querySelector('.insight-usage').textContent, /This dig3 retained calls/);
  assert.match(body(), /From the saved answer/);
  await click('Findings & evidence');
  assert.match(body(), /Reports cited by this answerExaDataForSEO/);
});

test('plain saved cards propose a review draft anchored to the question and canonical file without executing it', async () => {
  const host = fakeHost();
  await render(host, { file, card: card({ insights: [], findings: [] }) });
  assert.match(body(), /Review coverage and choose what to do next/);
  assert.deepEqual(host.calls, []); assert.deepEqual(host.drafts, []);
  await click('Review next step');
  const prompt = document.querySelector('textarea').value;
  assert.match(prompt, /How can this site answer the customer question\?/);
  assert.match(prompt, /Retained file: \/library\/report\.md/);
  assert.match(prompt, /Use retained research first/);
  assert.deepEqual(host.drafts, []);
  await click('Draft in composer');
  assert.deepEqual(host.drafts, [prompt]);
  assert.match(body(), /Nothing was sent/);
});

test('explicit insights without a next step do not acquire a fabricated proposed action', async () => {
  const data = card(); delete data.insights[0].nextStep;
  await render(fakeHost(), { file, card: data });
  assert.equal(buttons().some(element => buttonName(element) === 'Review next step'), false);
  assert.doesNotMatch(body(), /Review coverage and choose/);
  assert.ok(button('Inspect research'));
  assert.equal(savedResearchNextStep(card({ path: undefined })), null);
});

test('a failed refresh of the same saved file preserves known state and localizes the error', async () => {
  let fail;
  const host = fakeHost({ call: () => new Promise((_resolve, reject) => { fail = reject; }) });
  await render(host);
  await act(async () => host.emit({ structuredContent: { file, path: '/library/report.md' } }));
  assert.match(body(), /Reading saved research/);
  assert.match(document.querySelector('.insight-header').textContent, /Report saved/);
  assert.match(document.querySelector('.insight-usage').textContent, /3 retained calls/);
  await act(async () => fail(new Error('The selected library is unavailable.')));
  assert.match(body(), /Previously loaded research remains visible/);
  assert.match(body(), /The selected library is unavailable/);
  assert.match(body(), /The competing page answers fees and timing/);
  assert.match(document.querySelector('.insight-usage').textContent, /\$0\.0300/);
});

test('a late draft confirmation from a closed insight cannot confirm or unlock a newer draft', async () => {
  const pending = [];
  const host = fakeHost({ draft: prompt => { host.drafts.push(prompt); return new Promise(resolve => pending.push(resolve)); } });
  const data = card();
  data.insights.push({ title: 'Second insight', statement: 'A separate finding.', details: [], evidence: [{ file, path: '/library/report.md', label: 'Report' }], limits: [],
    nextStep: { label: 'Compare the other page', prompt: 'A different draft for the second insight.' } });
  await render(host, { file, card: data });
  await click('Review next step');
  await click('Draft in composer');
  assert.equal(button('Creating draft…').disabled, true);
  await click('Close dialog');
  await click('Findings & evidence');
  const second = [...document.querySelectorAll('.insight-detail')].find(section => section.textContent.includes('Second insight'));
  await act(async () => [...second.querySelectorAll('button')].find(element => buttonName(element) === 'Discuss this finding').click());
  await settle();
  assert.equal(button('Draft in composer').disabled, false);
  assert.equal(document.querySelector('textarea').value, 'A different draft for the second insight.');
  await click('Draft in composer');
  await act(async () => pending[0]());
  assert.doesNotMatch(body(), /Draft placed in the composer|draft was not confirmed/);
  assert.equal(button('Creating draft…').disabled, true);
  await act(async () => pending[1]());
  assert.match(body(), /Draft placed in the composer/);
  assert.equal(button('Draft in composer').disabled, false);
});

test('a late draft failure cannot attach to a newer tool result or leave its draft busy', async () => {
  let rejectOld;
  const host = fakeHost({ draft: () => new Promise((_resolve, reject) => { rejectOld = reject; }) });
  await render(host);
  await click('Review next step');
  await click('Draft in composer');
  const next = 'project/digs/next/youtube.md';
  await act(async () => host.emit({ structuredContent: { file: next, path: '/library/next.md', card: card({ file: next, path: '/library/next.md', title: 'New research', insights: [] }) } }));
  await click('Review next step');
  assert.equal(button('Draft in composer').disabled, false);
  await act(async () => rejectOld(new Error('OLD DRAFT FAILURE')));
  assert.doesNotMatch(body(), /OLD DRAFT FAILURE|draft was not confirmed/);
  assert.equal(button('Draft in composer').disabled, false);
});

test('a late copy confirmation does not appear after closing the draft preview', async () => {
  let finishCopy;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise(resolve => { finishCopy = resolve; }) } });
  await render(fakeHost());
  await click('Review next step');
  await click('Copy draft');
  await click('Close dialog');
  await act(async () => finishCopy());
  assert.doesNotMatch(body(), /Draft copied|manual copying/);
  assert.equal(document.querySelector('textarea'), null);
});

test('a late copy failure cannot select or announce a draft for a newer research result', async () => {
  let failCopy;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise((_resolve, reject) => { failCopy = reject; }) } });
  const host = fakeHost();
  await render(host);
  await click('Review next step');
  await click('Copy draft');
  const next = 'project/digs/next/youtube.md';
  await act(async () => host.emit({ structuredContent: { file: next, path: '/library/next.md', card: card({ file: next, path: '/library/next.md', title: 'New research', insights: [] }) } }));
  await click('Review next step');
  const field = document.querySelector('textarea');
  field.setSelectionRange(2, 2);
  await act(async () => failCopy(new Error('Old clipboard failure')));
  assert.equal(field.selectionStart, 2); assert.equal(field.selectionEnd, 2);
  assert.doesNotMatch(body(), /Automatic copy is unavailable|Draft copied/);
});
