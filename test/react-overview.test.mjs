import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://dig.test/' });
globalThis.self = window;
for (const name of ['window', 'document', 'location', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'DocumentFragment', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'PointerEvent', 'MutationObserver', 'ResizeObserver', 'getComputedStyle']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : name === 'getComputedStyle' ? window[name].bind(window) : window[name] });
}
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { ResearchOverview, ConversationOverview } = await import('../src/frontend/library/research-overview.tsx');
const { createCatalog } = await import('../src/ui/catalog.mjs');
const { MODULES } = await import('../src/providers/modules.ts');
const $ = id => document.getElementById(id);
const keyed = key => [...document.querySelectorAll('[data-key]')].find(node => node.dataset.key === key);
const settle = async () => React.act(async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
const click = async element => { assert.ok(element); await React.act(async () => element.click()); await settle(); };
const fill = async (element, value) => {
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};
const at = new Date(Date.now() - 60_000).toISOString();
const startedAt = new Date(Date.now() - 120_000).toISOString();
const file = 'p/digs/a/exa.md';
const call = (id, overrides = {}) => ({ id, at, ms: 400, session: 'worker', source: 'exa', tool: 'exa_search', status: 'success', cost: [], claimedBy: file, rawFile: `p/sessions/worker/raw/${id}.json`, ...overrides });
const question = (overrides = {}) => ({ id: 'a', title: 'Which page should we improve?', displayTitle: 'Search visibility opportunities', project: '/projects/site', session: 'current-chat', status: 'report saved', startedAt, planned: ['exa', 'youtube-video'], methods: ['exa'], sources: ['exa'], reports: [file], reportDetails: [{ file, source: 'exa', method: 'exa', status: 'partial', at }], files: ['p/digs/a/dig.md', file], answer: null, calls: [call('one')], snippet: 'Retained evidence suggests a page comparison.', ...overrides });
function fixture(items = [question()], live = []) {
  const actions = [];
  const app = {
    snapshot: { library: '/library', items, live }, snapshotLoaded: true, usageDays: 30, thread: 'current-chat', catalog: createCatalog(MODULES),
    update: patch => actions.push(['update', patch]), showDig: (...args) => actions.push(['showDig', ...args]), notify: (...args) => actions.push(['notice', ...args]),
  };
  const host = { preview: false, canDraft: () => false, canOpenFile: () => true, openFile: async path => actions.push(['openFile', path]), draft: async value => actions.push(['draft', value]), openLink: async value => actions.push(['openLink', value]), call: async () => { throw new Error('Overview must not call providers'); } };
  return { app, host, actions };
}
async function mount(t, Component, props) {
  document.body.replaceChildren();
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  const render = async next => { await React.act(async () => root.render(React.createElement(Component, next))); await settle(); };
  await render(props);
  t.after(async () => { await React.act(async () => root.unmount()); });
  return { render, element };
}

test('provider usage retains every unit, unknown costs, SVG activity and stable pricing details', async t => {
  const calls = [call('usd', { cost: [{ unit: 'USD', amount: .2 }] }), call('partial', { status: 'partial', cost: null, knownCost: [{ unit: 'USD', amount: .1 }] }), call('credits', { cost: [{ unit: 'ScrapeCreators credits', amount: 4 }] }), call('other', { source: 'commerce', cost: [{ unit: 'Scrape.do credits', amount: 9 }] }), call('failed', { status: 'failed', cost: null })];
  // Credits arrived first, but the prominent amount must remain USD rather than receipt insertion order.
  const data = fixture([question({ calls: [calls[2], calls[3], calls[0], calls[1], calls[4]] })]);
  const props = { ...data, hidden: false };
  const ui = await mount(t, ResearchOverview, props);
  const usage = $('usage');
  assert.match(usage.textContent, /Known provider subtotal/);
  assert.match(usage.textContent, /\$0\.3000/);
  assert.match(usage.textContent, /4 ScrapeCreators credits/);
  assert.match(usage.textContent, /9 Scrape\.do credits/);
  assert.deepEqual([...usage.querySelectorAll('.research-overview-amounts > span')].map(node => node.textContent), ['$0.3000', '4 ScrapeCreators credits', '9 Scrape.do credits']);
  assert.match(usage.textContent, /2 of 5 retrievals incompletely priced/);
  assert.match(usage.textContent, /Success \/ partial/);
  assert.match(usage.textContent, /Other outcomes/);
  assert.doesNotMatch(usage.textContent, /with results|returned results|completion/i);
  assert.ok(usage.querySelector('svg[role="img"][aria-label*="retained retrievals"]'));
  assert.ok(usage.querySelector('.research-overview-source-row svg[role="img"]'));
  const details = usage.querySelector('.research-overview-pricing');
  assert.equal(details.open, false); details.open = true; details.querySelector('summary').focus();
  await ui.render({ ...props, app: { ...data.app, snapshot: { ...data.app.snapshot, items: [question({ calls: [...calls, call('new')] })] } } });
  assert.equal($('usage').querySelector('.research-overview-pricing'), details);
  assert.equal(details.open, true); assert.equal(document.activeElement, details.querySelector('summary'));
  await click(keyed('usage-window:7'));
  assert.deepEqual(data.actions, [['update', { usageDays: 7 }]]);
});

test('state rows distinguish saved work, absent reports and author assessments without inventing execution state', async t => {
  const data = fixture();
  await mount(t, ResearchOverview, { ...data, hidden: false });
  const rows = $('list');
  assert.match(rows.textContent, /Source reports saved/);
  assert.match(rows.textContent, /YouTube video: No report saved/);
  assert.match(rows.textContent, /No answer saved yet/);
  assert.match(rows.textContent, /latest report marked partial by its author/);
  assert.doesNotMatch(rows.textContent, /\b(running|stalled|paused)\b|\d+%/i);
  assert.match(rows.textContent, /Latest recorded:/);
  await click(keyed('dig:/projects/site:a'));
  assert.equal(data.actions.length, 1);
  assert.equal(data.actions[0][0], 'showDig');
  assert.equal(data.actions[0].length, 2, 'primary action opens the research state, not an implicit file');
  assert.equal(data.actions[0][1], data.app.snapshot.items[0]);
  assert.equal(document.querySelectorAll('input[type="search"]').length, 1);
  assert.equal(document.querySelectorAll('textarea').length, 0);
  assert.match(rows.querySelector('.research-overview-summary').textContent, /Retained evidence suggests a page comparison/);
});

test('saved document actions open the answer or latest report without changing retained data', async t => {
  const newer = 'p/digs/b/exa-2.md';
  const answered = question({ answer: 'p/digs/a/answer.md', status: 'answered' });
  const sourceOnly = question({ id: 'b', title: 'A source-only question', answer: null, reportDetails: [{ file, source: 'exa', method: 'exa', at: startedAt }, { file: newer, source: 'exa', method: 'exa', at }], reports: [file, newer] });
  const data = fixture([answered, sourceOnly]);
  await mount(t, ConversationOverview, { ...data, hidden: false });
  const rows = [...$('panel-digs').querySelectorAll('article')];
  assert.equal(rows[0].querySelector('.research-overview-question-details').open, false);
  assert.equal(document.querySelector('.research-overview-conversation-usage').open, false);
  await click(rows[0].querySelector('.research-overview-primary-action'));
  await click(rows[1].querySelector('.research-overview-primary-action'));
  assert.deepEqual(data.actions, [['showDig', answered, answered.answer], ['showDig', sourceOnly, newer]]);
  assert.equal(sourceOnly.reports.length, 2);
});

test('library filter uses saved titles and summaries locally and clears when the library changes', async t => {
  const first = question();
  const second = question({ id: 'b', title: 'A second question', displayTitle: 'Another topic', snippet: 'A telescope comparison.', project: '/projects/sky' });
  const data = fixture([first, second]);
  const props = { ...data, hidden: false };
  const ui = await mount(t, ResearchOverview, props);
  await fill($('research-filter'), 'telescope sky');
  assert.equal($('list').querySelectorAll('article').length, 1);
  assert.match($('list').textContent, /Another topic/);
  await fill($('research-filter'), 'not-found-anywhere');
  assert.match($('list').textContent, /No saved questions match/);
  assert.deepEqual(data.actions, [], 'filtering makes no host or provider calls');
  await ui.render({ ...props, app: { ...data.app, snapshot: { ...data.app.snapshot, library: '/another-library' } } });
  assert.equal($('research-filter').value, '');
  assert.equal($('list').querySelectorAll('article').length, 2);
});

test('conversation totals include its attributed question and own unassigned calls, excluding other workers', async t => {
  const mine = question({ calls: [call('mine', { cost: [{ unit: 'USD', amount: .4 }] })] });
  const other = question({ id: 'other', title: 'Other conversation question', displayTitle: null, session: 'other-chat', calls: [call('foreign', { cost: [{ unit: 'USD', amount: 500 }] })] });
  const ownUnassigned = call('own-unassigned', { session: 'current-chat', claimedBy: null, cost: [{ unit: 'USD', amount: .2 }] });
  const foreignUnassigned = call('foreign-unassigned', { session: 'other-worker', claimedBy: null, cost: [{ unit: 'USD', amount: 999 }] });
  const data = fixture([mine, other], [ownUnassigned, foreignUnassigned]);
  await mount(t, ConversationOverview, { ...data, hidden: false });
  assert.match($('panel-figures').textContent, /\$0\.6000/);
  assert.doesNotMatch($('panel-figures').textContent, /500|999/);
  assert.match($('panel-figures').textContent, /Not included: 1 retrieval/);
  assert.doesNotMatch($('panel-digs').textContent, /Other conversation question/);
  assert.match($('panel-live').textContent, /This conversationIncluded/);
  assert.match($('panel-live').textContent, /Other conversations or workersExcluded/);
  const open = [...$('panel-live').querySelectorAll('button')].find(button => button.textContent === 'Open original response');
  await click(open);
  assert.deepEqual(data.actions, [['openFile', `/library/${ownUnassigned.rawFile}`]]);
});

test('unknown conversation scope claims no attribution or costs and retains an honest fallback', async t => {
  const data = fixture([question()], [call('foreign')]);
  data.app.thread = null;
  await mount(t, ConversationOverview, { ...data, hidden: false });
  assert.match($('panel-scope').textContent, /Conversation not identified/);
  assert.match($('panel-digs').textContent, /cannot pick out its research/);
  assert.ok($('panel-figures').closest('[hidden]'));
  assert.match($('panel-live').textContent, /Other conversations or workers/);
  assert.deepEqual(data.actions, []);
});

test('recorded milestones use real dates and reports, and refreshes preserve expanded row details', async t => {
  const secondFile = 'p/digs/a/exa-2.md';
  const finishedAt = new Date(Date.now() - 10_000).toISOString();
  const item = question({ answer: 'p/digs/a/answer.md', finishedAt, status: 'partly answered', reports: [file, secondFile], reportDetails: [{ file, source: 'exa', method: 'exa', status: 'partial', at }, { file: secondFile, source: 'exa', method: 'exa', status: 'complete', at: finishedAt }] });
  const data = fixture([item]);
  const props = { ...data, hidden: false };
  const ui = await mount(t, ConversationOverview, props);
  const row = $('panel-digs').querySelector('article');
  assert.match(row.textContent, /Answer has gaps/);
  assert.match(row.textContent, /Latest author assessment: complete/);
  assert.equal(row.querySelectorAll('[data-slot="timeline-item"]').length, 3);
  const expand = [...row.querySelectorAll('button')].find(button => button.textContent.includes('Show all 4 saved milestones'));
  await click(expand);
  assert.equal(row.querySelectorAll('[data-slot="timeline-item"]').length, 4);
  const times = [...row.querySelectorAll('[data-slot="timeline-date"]')].map(node => node.getAttribute('datetime'));
  assert.ok(times.includes(startedAt)); assert.ok(times.includes(finishedAt));
  const details = row.querySelector('.research-overview-question-details'); details.open = true; details.querySelector('summary').focus();
  await ui.render({ ...props, app: { ...data.app, snapshot: { ...data.app.snapshot, items: [{ ...item, calls: [...item.calls, call('late')] }] } } });
  assert.equal($('panel-digs').querySelector('.research-overview-question-details'), details);
  assert.equal(details.open, true); assert.equal(document.activeElement, details.querySelector('summary'));
  assert.equal(row.querySelectorAll('[data-slot="timeline-item"]').length, 4);
});

test('an empty or undated library never describes missing pricing as free', async t => {
  const data = fixture([question({ calls: [], reports: [], reportDetails: [], methods: [], sources: [], planned: [] })]);
  await mount(t, ResearchOverview, { ...data, hidden: false });
  assert.match($('usage').textContent, /No calls recorded/);
  assert.doesNotMatch($('list').textContent, /no charge recorded|\$0\.00|free/i);
  assert.match($('list').textContent, /Question recorded/);
});
