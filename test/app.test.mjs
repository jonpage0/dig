import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import { initializeConfig, updateConfig, loadConfig } from '../src/config.mjs';
import { libraryFolder, listLibrary } from '../src/library.mjs';
import { settingsDocument, settingsValues } from '../src/catalog.mjs';
import { MODULES } from '../src/providers/modules.ts';
import { evidence, sentenceText } from '../src/ui/evidence/index.mjs';

// The real app bundle, with the two host SDK packages replaced by a scripted host (`globalThis.host`).
const HOST_STUB = `
const host = globalThis.host;
export class App {
  set ontoolresult(fn) { host.ontoolresult = fn; }
  addEventListener(name, fn) { host.listeners[name] = fn; }
  connect() { return Promise.resolve(); }
  getHostContext() { return host.context; }
  getHostCapabilities() { return host.capabilities; }
  callServerTool(request) { return host.provider(request); }
  openLink() { return Promise.resolve({}); }
}
export const applyDocumentTheme = () => {};
export const applyHostStyleVariables = () => {};
export class OpenAIExtensions {
  get deepLink() { return { getCurrent: () => host.deepLink }; }
  get files() { return host.files; }
}`;
let bundled;
const appCode = async () => (bundled ??= (await build({
  entryPoints: ['src/app.mjs'], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false,
  plugins: [{ name: 'host-stub', setup(b) {
    b.onResolve({ filter: /^(@modelcontextprotocol\/ext-apps|@openai\/mcp-extensions\/app)$/ }, args => ({ path: args.path, namespace: 'host-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'host-stub' }, () => ({ contents: HOST_STUB, loader: 'js' }));
  } }],
})).outputFiles[0].text);

// Just enough DOM for the app: elements are created on first lookup, text is real text nodes. As in a browser, adding
// a node moves it from its old parent, and taking the focused field off the page blurs it, which commits a value
// changed since it gained focus as a change event.
let activeDocument;
class Text { constructor(value) { this.textContent = String(value); this.parentNode = null; } }
function blurWithin(removed) {
  const focused = activeDocument?.activeElement;
  if (!(removed instanceof Element) || !focused || !removed.contains(focused)) return;
  activeDocument.activeElement = null;
  if (focused.value !== focused.valueAtFocus) focused.onchange?.();
}
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map(); this.parentNode = null;
    this.className = ''; this.hidden = false; this.disabled = false; this.value = ''; this.checked = false;
    const classes = new Set();
    this.classList = { toggle: (name, on = !classes.has(name)) => (on ? classes.add(name) : classes.delete(name)), contains: name => classes.has(name) };
  }
  append(...nodes) { for (const value of nodes) { const child = typeof value === 'string' ? new Text(value) : value; child.parentNode?.removeChild(child); child.parentNode = this; this.children.push(child); } }
  removeChild(child) { blurWithin(child); this.children = this.children.filter(other => other !== child); child.parentNode = null; }
  replaceChildren(...nodes) { for (const child of [...this.children]) this.removeChild(child); this.append(...nodes); }
  get textContent() { return this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(new Text(value)); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener() {}
  focus() { activeDocument.activeElement = this; this.valueAtFocus = this.value; }
  contains(target) { for (let at = target; at; at = at.parentNode) if (at === this) return true; return false; }
  *walk() { for (const child of this.children) if (child instanceof Element) { yield child; yield* child.walk(); } }
  querySelectorAll(selector) {
    const [, name, value] = /^\[([\w-]+)(?:=([\w-]+))?\]$/.exec(selector);
    return [...this.walk()].filter(e => e.getAttribute(name) !== null && (value === undefined || e.getAttribute(name) === value));
  }
}
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };
const byKey = (root, key) => [...root.walk()].find(e => e.getAttribute('data-key') === key);

async function loadApp(host) {
  const elements = new Map(); const listeners = {}; const intervals = [];
  const document = activeDocument = {
    activeElement: null, visibilityState: 'visible', body: new Element('body'),
    getElementById: id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement: tag => new Element(tag), createElementNS: (_namespace, tag) => new Element(tag), createTextNode: value => new Text(value), addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  Object.assign(host, { listeners: {}, context: host.context ?? {}, capabilities: host.capabilities ?? {} });
  const context = vm.createContext({ host, document, location: { search: '' }, URL, URLSearchParams, console, setInterval: fn => intervals.push(fn), setTimeout, clearTimeout, fetch: () => { throw new Error('No browser fetch expected'); } });
  vm.runInContext(await appCode(), context);
  await settle();
  return { $: id => document.getElementById(id), document, listeners, poll: async () => { intervals[0](); await settle(); } };
}

const report = id => `p/digs/${id}/hackernews.md`;
const item = (id, extra = {}) => ({ id, title: `Question ${id}`, project: `/project/${id}`, status: 'report saved', startedAt: '2026-10-04T12:00:00.000Z', snippet: `Summary of ${id}`, session: 'thread-1', files: [`p/digs/${id}/dig.md`, report(id)], reports: [report(id)], reportDetails: [{ file: report(id), source: 'hackernews', method: 'hackernews', status: 'complete' }], calls: [], answer: null, sources: ['hackernews'], methods: ['hackernews'], ...extra });
const snapshotOf = items => ({ items, live: [], library: '/library', configPath: '/state/config.toml', keepRaw: true, enabledSources: ['hackernews'], sources: [{ id: 'hackernews', label: 'Hacker News' }, { id: 'commerce', label: 'Commerce' }] });
const rawCall = { id: 'call-1', at: '2026-10-04T12:01:00.000Z', ms: 900, tool: 'hackernews', source: 'hackernews', status: 'success', args: { query: 'sqlite' }, cost: [], session: 't', rawFile: 'p/sessions/t/raw/call-1.json', claimedBy: report('A') };
// The open dig's Retrievals summary and its list of calls, one entry per call.
const panelOf = ui => ui.$('dig-retrievals');
const retrievalEntries = ui => [...panelOf(ui).walk()].filter(e => e.className === 'retrieval');
// A library whose reads stay pending until the test answers them, and a host that records what it receives.
function scriptedHost(snapshots, extra = {}) {
  const reads = new Map(); let revision = 0;
  const host = {
    reads,
    provider: async ({ name, arguments: args }) => {
      if (name === 'library_snapshot') return { structuredContent: snapshots[Math.min(revision, snapshots.length - 1)] };
      if (name === 'library_revision') return { structuredContent: { revision: String(++revision) } };
      if (name === 'library_read') return new Promise(resolve => reads.set(args.file, body => resolve({ structuredContent: { file: args.file, text: body, path: `/library/${args.file}`, nextOffset: null } })));
      throw new Error(`Unexpected tool: ${name}`);
    },
    ...extra,
  };
  return host;
}
async function openDig(ui, host, id, body) {
  byKey(ui.$('list'), `dig:/project/${id}:${id}`).onclick();
  await settle();
  if (body !== undefined) { host.reads.get(report(id))(body); await settle(); }
}

test('navigation cannot commit a stale response to a new dig or reopen an abandoned document', async () => {
  const host = scriptedHost([snapshotOf(['A', 'B', 'C', 'D'].map(id => item(id)))]);
  const ui = await loadApp(host);
  await openDig(ui, host, 'A', 'BODY_A');
  await openDig(ui, host, 'B');
  await openDig(ui, host, 'C', 'BODY_C');
  host.reads.get(report('B'))('BODY_B'); await settle();
  assert.match(ui.$('document').textContent, /BODY_C/);
  assert.equal(ui.$('dig-title').textContent, 'Question C');
  assert.doesNotMatch(ui.$('document').textContent, /BODY_A|BODY_B/);
  await openDig(ui, host, 'D');
  ui.$('back').onclick(); host.reads.get(report('D'))('BODY_D'); await settle();
  assert.equal(ui.$('browse').hidden, false);
  assert.equal(ui.$('detail').hidden, true);
  assert.doesNotMatch(ui.$('document').textContent, /BODY_D/);
});

test('a background update refreshes the open dig without replacing its document or focus', async () => {
  const before = item('A', { calls: [rawCall] });
  const after = item('A', { files: [...before.files, 'p/digs/A/answer.md'], answer: 'p/digs/A/answer.md', status: 'answer saved', calls: [rawCall, { ...rawCall, id: 'call-2', rawFile: 'p/sessions/t/raw/call-2.json' }] });
  const host = scriptedHost([snapshotOf([before]), snapshotOf([after, item('B')])]);
  const ui = await loadApp(host);
  await openDig(ui, host, 'A', 'BODY_A with a passage');
  const reading = ui.$('document').children[0];
  byKey(panelOf(ui), `raw:${rawCall.rawFile}`).focus();
  await ui.poll();
  assert.equal(ui.$('document').children[0], reading);
  assert.equal(ui.document.activeElement, byKey(panelOf(ui), `raw:${rawCall.rawFile}`));
  assert.equal(retrievalEntries(ui).length, 2); assert.equal(ui.$('files').children.length, 3);
  assert.match(ui.$('notice').textContent, /Saved to this dig: Answer/);
});

// Provider costs: receipts' own cost/knownCost only, per unit, with incompletely priced tool calls counted.
const { claimedBy: _claimed, ...unclaimedCall } = rawCall;
const priced = (id, cost, extra = {}) => ({ ...rawCall, id, rawFile: null, cost, ...extra });
const usd = amount => [{ amount, unit: 'USD' }];
const titled = (list, title) => list.children.find(card => card.children[1].textContent === title);

test('dig cards and the open dig total provider costs per unit, count incompletely priced calls and never read no calls as no charge', async () => {
  const calls = [
    priced('complete', usd(0.125)),
    priced('subtotal', null, { status: 'cancelled', knownCost: usd(0.25) }),
    priced('legacy', [{ amount: 2, unit: 'credits' }]),
    priced('scrape', [{ amount: 1, unit: 'Scrape.do credits' }]),
    priced('no-charge', []),
    priced('unknown', null, { status: 'failed' }),
  ];
  const host = scriptedHost([snapshotOf([item('A', { calls }), item('B'), item('C', { calls: [priced('c', [])] }), item('D', { calls: [priced('tick', usd(0.00004))] })])]);
  const ui = await loadApp(host);
  const list = ui.$('list');
  assert.match(titled(list, 'Question A').textContent, /Provider-reported subtotal: \$0\.3750 \+ 2 ScrapeCreators credits \+ 1 Scrape\.do credit; total unknown · 2 of 6 tool calls incompletely priced/);
  assert.doesNotMatch(titled(list, 'Question B').textContent, /provider|charge|free/i);
  assert.match(titled(list, 'Question C').textContent, /Recorded no provider charge/);
  assert.match(titled(list, 'Question D').textContent, /Provider-reported cost: <\$0\.0001/);
  // Cards show only their totals; Usage above them states the scope and caveat once.
  assert.match(ui.$('usage').textContent, /Provider costs · retained calls only · excludes Codex model costs.*not a reconciled invoice/);

  await openDig(ui, host, 'A', 'Report body');
  const panel = panelOf(ui);
  const cost = [...panel.walk()].find(e => e.className === 'metric' && /^Provider cost/.test(e.textContent));
  assert.equal(cost.textContent, 'Provider cost$0.37502 ScrapeCreators credits1 Scrape.do credit2 of 6 retrievals incompletely priced');
  assert.match(panel.textContent, /retained calls only · excludes Codex model costs.*not a reconciled invoice/);
  // Failed or stopped calls lead their group, each with its own cost.
  const rows = retrievalEntries(ui).map(row => row.textContent);
  assert.match(rows[0], /^stopped.*\$0\.2500 \+ unpriced/);
  assert.match(rows[1], /^failed.*cost unknown/);
  assert.match(rows[2], /^results.*\$0\.1250/);
  assert.match(rows[3], /2 ScrapeCreators credits/);
  assert.match(rows[5], /no charge recorded/);
  assert.doesNotMatch(panel.textContent, /\bFree\b/);

  ui.$('back').onclick();
  ui.$('search').value = 'question b'; ui.$('search').oninput();
  await openDig(ui, host, 'B', 'Report body');
  assert.equal(panelOf(ui).textContent, 'RetrievalsEvery provider call saved with this dig, from its reports and the conversations that worked on it.No provider call has been saved with this dig yet.', 'No calls make no cost claim');
});

test('the conversation total covers its digs and its own unclaimed calls, never other threads, and keeps focus through a live update', async () => {
  const other = item('B', { session: 'thread-2', calls: [priced('other-dig', usd(4))] });
  const own = { ...unclaimedCall, id: 'own-live', session: 'thread-1', cost: null, knownCost: usd(0.25) };
  const worker = { ...unclaimedCall, id: 'worker-live', session: 'worker-thread', cost: usd(9) };
  const before = { ...snapshotOf([item('A', { calls: [priced('mine', usd(0.5))] }), other]), live: [own, worker] };
  const after = { ...snapshotOf([item('A', { calls: [priced('mine', usd(0.5)), { ...worker, claimedBy: report('A') }] }), other]), live: [own] };
  const host = scriptedHost([before, after]);
  const ui = await loadApp(host);
  host.ontoolresult({ structuredContent: { view: 'panel', thread: 'thread-1' } });
  assert.match(ui.$('panel-cost').textContent, /Provider-reported subtotal: \$0\.7500; total unknown · 1 of 2 tool calls incompletely priced/);
  assert.equal(ui.$('live-caveat').hidden, false);
  byKey(ui.$('panel-digs'), 'trail:/project/A:A').focus();
  await ui.poll();
  assert.match(ui.$('panel-cost').textContent, /Provider-reported subtotal: \$9\.7500; total unknown · 1 of 3 tool calls incompletely priced/);
  assert.equal(ui.document.activeElement, byKey(ui.$('panel-digs'), 'trail:/project/A:A'));
  host.ontoolresult({ structuredContent: { view: 'panel', thread: null } });
  assert.equal(ui.$('panel-cost').hidden, true);
});

test('a live update refreshes the open dig’s provider costs without replacing its document or focus', async () => {
  const first = { ...rawCall, cost: usd(0.125) };
  const second = { ...rawCall, id: 'call-2', rawFile: 'p/sessions/t/raw/call-2.json', cost: null };
  const host = scriptedHost([snapshotOf([item('A', { calls: [first] })]), snapshotOf([item('A', { calls: [first, second] })])]);
  const ui = await loadApp(host);
  await openDig(ui, host, 'A', 'BODY_A');
  const costOf = () => [...panelOf(ui).walk()].find(e => e.className === 'metric' && /^Provider cost/.test(e.textContent)).textContent;
  assert.equal(costOf(), 'Provider cost$0.1250Every retrieval’s cost is known');
  const reading = ui.$('document').children[0];
  byKey(panelOf(ui), `raw:${first.rawFile}`).focus();
  await ui.poll();
  assert.equal(costOf(), 'Provider cost$0.12501 of 2 retrievals incompletely priced');
  assert.equal(ui.$('document').children[0], reading);
  assert.equal(ui.document.activeElement, byKey(panelOf(ui), `raw:${first.rawFile}`));
});

test('an open dig leads with its Retrievals summary, and its calls are grouped by what saved them, failed first', async () => {
  const judge = 'p/digs/A/x-judge.md';
  const x = (id, extra) => ({ ...rawCall, id, source: 'x', tool: 'xsearch', args: { query: 'ontology' }, rawFile: `p/sessions/w/raw/${id}.json`, ...extra });
  const calls = [
    { ...rawCall, id: 'hn-ok' },
    { ...rawCall, id: 'hn-failed', at: '2026-10-04T12:05:00.000Z', status: 'failed', error: 'HN API returned 503: Service Unavailable', rawFile: null, cost: [] },
    x('x-ok', { claimedBy: judge, cost: usd(1.5) }),
    { ...rawCall, id: 'inline', claimedBy: 'main', status: 'empty' },
    x('stopped-worker', { claimedBy: null, cost: usd(6.1381) }),
  ];
  const dig = item('A', { status: 'partly answered', files: ['p/digs/A/dig.md', report('A'), judge], reports: [report('A'), judge], calls,
    reportDetails: [{ file: report('A'), source: 'hackernews', status: 'complete' }, { file: judge, source: 'x', status: 'partial' }] });
  const snapshot = { ...snapshotOf([dig]), sources: [{ id: 'hackernews', label: 'Hacker News' }, { id: 'x', label: 'X' }] };
  const host = scriptedHost([snapshot, { ...snapshot, items: [{ ...dig, calls: [...calls, x('later', { claimedBy: judge })] }] }]);
  const ui = await loadApp(host);
  const tagOf = element => [...element.walk()].find(e => e.className === 'state');
  assert.deepEqual([tagOf(ui.$('list')).textContent, tagOf(ui.$('list')).getAttribute('data-pattern')], ['partly answered', 'stripes']);
  await openDig(ui, host, 'A', 'Report body');
  const panel = panelOf(ui);
  const figures = [...panel.walk()].filter(e => e.className === 'metric').map(e => e.textContent);
  assert.deepEqual(figures.slice(0, 3), ['Retrievals53 with results', 'Sources22 reports saved', 'Failed or stopped120% of retrievals']);
  assert.deepEqual([...panel.walk()].filter(e => e.className === 'who-name').map(e => e.textContent), ['Hacker News', 'X']);
  // The list is closed until opened, and says up front what no report saved.
  const list = byKey(panel, 'retrievals-all').parentNode;
  assert.equal(list.open, undefined);
  assert.equal(byKey(panel, 'retrievals-all').textContent, 'All 5 retrievals1 not in a saved report · grouped by report, failed first');
  const groups = [...panel.walk()].filter(e => e.className === 'retrieval-group');
  assert.deepEqual(groups.map(g => g.children[0].textContent), [
    'Hacker News reportcomplete2 retrievals · no charge recorded', 'X judge reportpartial1 retrieval · $1.5000',
    'The conversation that started this dig1 retrieval · no charge recorded', 'Not in a saved report or answer1 retrieval · $6.1381']);
  assert.match(groups[0].children[1].textContent, /^failed.*HN API returned 503: Service Unavailable.*Original response not retained/);
  assert.match(groups[2].textContent, /^.*no results/);
  assert.match(groups[3].textContent, /no report or answer saved them/);
  // A live update keeps the list open and counts the new call.
  list.open = true;
  await ui.poll();
  assert.equal(byKey(panel, 'retrievals-all').parentNode, list); assert.equal(list.open, true);
  assert.match(byKey(panel, 'retrievals-all').textContent, /^All 6 retrievals/);
});


test('reports render Markdown structure without executing or loading report HTML, and the source card stays source-reported', async () => {
  const host = scriptedHost([snapshotOf([item('A')])]);
  const ui = await loadApp(host);
  const body = ['---', 'title: "Hacker News research"', 'agent: hackernews', 'generated_at: "2026-10-04T12:02:00.000Z"', '---',
    '```yaml', 'source_card:', '  source: "hackernews"', '  status: "complete"', '  evidence_grade: "medium"', '  strongest_findings:', '    - "Three stories returned."', '  contradictions: []', '  confidence: "high"', '```',
    '## Summary', '', 'Some **bold** and `code` <script>alert(1)</script>', '', '| Title | Points |', '| --- | ---: |', '| WAL2 | 444 |', '',
    '[bad](javascript:alert(1)) [ok](https://example.com/a) ![pic](https://example.com/p.png) <img src=x onerror=alert(1)>'].join('\n');
  await openDig(ui, host, 'A', body);
  const doc = ui.$('document'); const elements = [...doc.walk()];
  assert.ok(!elements.some(e => ['SCRIPT', 'IMG', 'IFRAME'].includes(e.tagName)));
  assert.match(doc.textContent, /<script>alert\(1\)<\/script>/);
  assert.deepEqual(elements.filter(e => e.tagName === 'A').map(e => e.href), ['https://example.com/a', 'https://example.com/p.png']);
  assert.ok(elements.some(e => e.tagName === 'STRONG' && e.textContent === 'bold'));
  assert.deepEqual(elements.filter(e => e.tagName === 'TH').map(e => e.textContent), ['Title', 'Points']);
  assert.equal(elements.find(e => e.tagName === 'TD' && e.textContent === '444').getAttribute('data-align'), 'right');
  const card = elements.find(e => e.className === 'source-card');
  assert.match(card.textContent, /Three stories returned\./);
  assert.match(doc.textContent, /Method Hacker News/);
});

test('retained responses read as source evidence, keep their original JSON, and lead back to the report', async () => {
  const generic = { ...rawCall, id: 'call-2', tool: 'commerce_search', source: 'commerce', rawFile: 'p/sessions/t/raw/call-2.json' };
  const host = scriptedHost([snapshotOf([item('A', { calls: [rawCall, generic] })])]);
  const ui = await loadApp(host);
  await openDig(ui, host, 'A', 'Report body');
  byKey(panelOf(ui), `raw:${rawCall.rawFile}`).onclick(); await settle();
  host.reads.get(rawCall.rawFile)(JSON.stringify({ tool: 'hackernews', at: rawCall.at, responses: [{ label: 'search', status: 200, body: { nbHits: 108, hits: [{ objectID: '38988949', title: 'SQLite: Wal2 Mode', author: 'finallyy', points: 444, num_comments: 96, created_at: '2024-01-14T09:42:18Z' }] } }] }));
  await settle();
  const doc = ui.$('document');
  assert.match(doc.textContent, /Searched Hacker News for “sqlite” → 1 of 108 stories/);
  assert.ok([...doc.walk()].some(e => e.tagName === 'A' && e.href === 'https://news.ycombinator.com/item?id=38988949'));
  assert.ok([...doc.walk()].some(e => e.tagName === 'DETAILS' && /Original JSON/.test(e.textContent)));
  assert.equal(ui.$('back-to-report').hidden, false); assert.match(ui.$('back-to-report').textContent, /Back to Hacker News report/);
  byKey(panelOf(ui), `raw:${generic.rawFile}`).onclick(); await settle();
  host.reads.get(generic.rawFile)(JSON.stringify({ tool: 'commerce_search', at: generic.at, responses: [{ label: 'search', status: 200, body: { products: [] } }] })); await settle();
  assert.match(doc.textContent, /No source-specific view applies/);
  assert.equal([...doc.walk()].find(e => e.tagName === 'DETAILS' && /Original JSON/.test(e.textContent)).getAttribute('open'), '');
  host.reads.delete(report('A'));
  ui.$('back-to-report').onclick(); await settle();
  assert.ok(host.reads.has(report('A')));
});

test('a failed source preview keeps the complete retained JSON readable', async () => {
  const receipt = { ...rawCall, source: 'reddit', tool: 'reddit' };
  const host = scriptedHost([snapshotOf([item('A', { calls: [receipt] })])]);
  const ui = await loadApp(host);
  await openDig(ui, host, 'A', 'Report body');
  byKey(panelOf(ui), `raw:${receipt.rawFile}`).onclick(); await settle();
  const original = { tool: 'reddit', responses: [{ label: 'search', status: 200, body: { posts: [{ id: 'malformed-date', title: 'Retained record', created_utc: 1e20 }] } }] };
  host.reads.get(receipt.rawFile)(JSON.stringify(original)); await settle();
  const json = [...ui.$('document').walk()].find(e => e.className === 'raw-json');
  assert.equal(json?.getAttribute('open'), '');
  assert.deepEqual(JSON.parse(json.children.find(e => e.tagName === 'PRE').textContent), original);
  assert.equal(ui.$('back-to-report').hidden, false);
});

test('X API responses preview as posts with author, time, text and counts, and the original JSON stays reachable', async () => {
  const xCall = { ...rawCall, id: 'call-x', tool: 'x_post', source: 'x', args: { posts: ['https://x.com/jack/status/20'] }, rawFile: 'p/sessions/t/raw/call-x.json' };
  const host = scriptedHost([{ ...snapshotOf([item('A', { calls: [xCall] })]), sources: [{ id: 'hackernews', label: 'Hacker News' }, { id: 'x', label: 'X' }] }]);
  const ui = await loadApp(host);
  await openDig(ui, host, 'A', 'Report body');
  byKey(panelOf(ui), `raw:${xCall.rawFile}`).onclick(); await settle();
  host.reads.get(xCall.rawFile)(JSON.stringify({ tool: 'x_post', at: xCall.at, responses: [{ label: 'post lookup', status: 200, body: {
    data: [{ id: '20', text: 'just setting up my twttr', author_id: '12', created_at: '2006-03-21T20:50:14.000Z', public_metrics: { like_count: 290000, repost_count: 120000, reply_count: 18000, quote_count: 5000, bookmark_count: 900, impression_count: 0 } }],
    includes: { users: [{ id: '12', username: 'jack', name: 'jack' }] },
  } }] }));
  await settle();
  const doc = ui.$('document');
  assert.match(doc.textContent, /Read X post https:\/\/x\.com\/jack\/status\/20 → 1 post/);
  const entry = [...doc.walk()].find(e => e.className === 'evidence-item');
  assert.equal(entry.textContent, 'jack @jackMar 21, 2006 · 290K likes · 120K reposts · 18K replies · 5K quotes · 0 viewsjust setting up my twttr');
  assert.ok([...entry.walk()].some(e => e.tagName === 'A' && e.href === 'https://x.com/jack/status/20'));
  assert.equal([...doc.walk()].find(e => e.className === 'raw-json').getAttribute('open'), null);
});

test('X API accounts, counts, News stories, trends, Spaces, Communities and TikHub copies read as source evidence', () => {
  const read = (tool, args, body, status = 'success') => evidence({ tool, source: 'x', status, args }, [body], { label: id => id });
  const accounts = read('x_users', { handles: ['jack'] }, { data: [{ id: '12', username: 'jack', name: 'jack', description: 'Bio text', verified: true, verified_type: 'blue', public_metrics: { followers_count: 6500000, post_count: 29000 } }] });
  assert.equal(sentenceText(accounts), 'Looked up X accounts @jack → 1 account');
  assert.deepEqual([accounts.items[0].title, accounts.items[0].url, accounts.items[0].meta, accounts.items[0].excerpt], ['jack @jack', 'https://x.com/jack', ['6.5M followers', '29K posts', 'verified blue'], 'Bio text']);
  const counts = read('x_count_posts', { query: 'dig' }, { data: [{ start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z', post_count: 120 }, { start: '2026-10-02T00:00:00.000Z', end: '2026-10-03T00:00:00.000Z', post_count: 30 }], meta: { total_post_count: 150 } });
  assert.equal(sentenceText(counts), 'Counted X posts for “dig” (last 7 days, per day) → 150 posts counted in 2 time buckets');
  assert.deepEqual(counts.items.map(i => i.title), ['2026-10-01 00:00 UTC: 120 posts', '2026-10-02 00:00 UTC: 30 posts']);
  const stories = read('x_news', { query: 'nebius' }, { data: [{ id: '1', name: 'Nebius stock plunges', hook: 'A hook.', summary: 'Shares fell.', category: 'News', cluster_posts_results: [{ post_id: '9' }] }] });
  assert.equal(sentenceText(stories), 'Searched X News for “nebius” → 1 story');
  assert.deepEqual([stories.items[0].excerpt, stories.items[0].meta, stories.items[0].links], ['A hook.', ['News', '1 post'], [{ label: 'Post 1', url: 'https://x.com/i/status/9' }]]);
  const trends = read('x_explore', { kind: 'trends' }, { data: [{ trend_name: '#Dig', tweet_count: 12345 }] });
  assert.equal(sentenceText(trends), 'Read X trends worldwide → 1 trend');
  assert.deepEqual([trends.items[0].url, trends.items[0].meta], ['https://x.com/search?q=%23Dig', ['12.3K posts']]);
  const spaces = read('x_explore', { kind: 'spaces', query: 'ai', state: 'live' }, { data: [{ id: '1zqKVXPQhvZJB', title: 'AI talk', state: 'live', participant_count: 420, host_ids: ['12'] }], includes: { users: [{ id: '12', username: 'jack' }] } });
  assert.equal(sentenceText(spaces), 'Searched X Spaces for “ai” (live) → 1 Space');
  assert.deepEqual([spaces.items[0].url, spaces.items[0].meta], ['https://x.com/i/spaces/1zqKVXPQhvZJB', ['live', '420 participants', 'hosts @jack']]);
  const communities = read('x_explore', { kind: 'communities', query: 'anime' }, { data: [{ id: 'Q29tbXVuaXR5OjE=', name: 'Anime Community', member_count: 39915, access: 'Public', join_policy: 'Open', description: 'Welcome' }] });
  assert.equal(sentenceText(communities), 'Searched X Communities for “anime” → 1 Community');
  assert.deepEqual([communities.items[0].meta, communities.items[0].excerpt], [['Public', '39.9K members', 'Open'], 'Welcome']);
  const tikhub = read('x_post', { posts: ['20'] }, { code: 200, data: { id: '20', text: 'TikHub copy', author: { screen_name: 'jack', name: 'jack' }, likes: 5 } });
  assert.equal(sentenceText(tikhub), 'Read X post 20 → 1 post via TikHub');
  assert.deepEqual([tikhub.items[0].title, tikhub.items[0].excerpt], ['jack @jack', 'TikHub copy']);
  // Signed-in reads keep the account and folder lookups beside the posts; only the posts are preview items.
  const saved = evidence({ tool: 'x_bookmarks', source: 'x', status: 'success', args: { folder: 'Tools', match: 'shovel' } }, [{ data: { id: '99', username: 'me', name: 'Me' } }, { data: [{ id: '7', name: 'Tools' }] }, { data: [{ id: '31', text: 'A shovel', author_id: '12' }], includes: { users: [{ id: '12', username: 'jack', name: 'jack' }] } }], { label: id => id });
  assert.equal(sentenceText(saved), 'Read X bookmark folder “Tools” (matching “shovel”) → 1 post');
  const liked = read('x_likes', { limit: 50 }, { data: [{ id: '32', text: 'Liked', author_id: '12' }], includes: { users: [{ id: '12', username: 'jack', name: 'jack' }] } });
  assert.equal(sentenceText(liked), 'Read X liked posts (up to 50 posts) → 1 post');
  const found = read('x_explore', { kind: 'communities', query: 'shovels' }, { code: 200, data: { communities: [{ community_id: '18', name: 'Shovel Makers', member_count: 1200 }], next_cursor: '' } });
  assert.equal(sentenceText(found), 'Searched X Communities for “shovels” → 1 Community via TikHub');
  assert.deepEqual([found.items[0].url, found.items[0].meta], ['https://x.com/i/communities/18', ['via TikHub', '1.2K members']]);
  const signedSearch = read('x_explore', { kind: 'communities', query: 'shovels' }, { data: [{ id: '18', name: 'Shovel Makers' }] });
  assert.equal(sentenceText(signedSearch), 'Searched X Communities for “shovels” → 1 Community');
  const timeline = read('x_community', { community: '18' }, { code: 200, data: { timeline: [{ tweet_id: '33', text: 'Community post', author: { screen_name: 'jack', name: 'jack' }, favorites: 4 }], cursor: 'next' } });
  assert.equal(sentenceText(timeline), 'Read X Community 18 (25 posts) → 1 post via TikHub');
  assert.deepEqual([timeline.items[0].url, timeline.items[0].excerpt], ['https://x.com/jack/status/33', 'Community post']);
  const info = read('x_community', { community: '18', posts: 0 }, { code: 200, data: { id: '18', name: 'Shovel Makers', member_count: 1200, description: 'People who make shovels', status: 'failed' } });
  assert.equal(sentenceText(info), 'Read X Community 18 (details only) → 1 Community via TikHub');
  // An unreadable shape is not called empty: the reader says so and the view opens the original JSON.
  assert.equal(sentenceText(read('x_search_posts', { query: 'dig' }, { unexpected: true })), 'Searched X posts for “dig” (last 7 days) → no preview items recognized; inspect the original response');
});

// Sources and Settings render from settings.read and save through settings.update, here backed by a real config.toml.
const named = (root, name) => [...root.walk()].find(e => e.name === name);
const names = root => [...root.walk()].filter(e => e.name).map(e => e.name);
const updateResult = async (set, state) => { try { return { structuredContent: { values: settingsValues(await updateConfig(set, state)) } }; } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; } };

test('Sources gives each source a card holding its own settings, Settings holds the rest, and each switch saves only its field', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-sources-')); await initializeConfig(state);
  const updates = []; let revision = 0; let refusal = null;
  const host = {
    provider: async ({ name, arguments: args }) => {
      const c = await loadConfig(state);
      if (name === 'settings.read') return { structuredContent: settingsDocument(c) };
      // A copy, because the view's objects come from another realm and would fail deep equality.
      if (name === 'settings.update') { updates.push({ ...args.set }); return refusal ? { isError: true, content: [{ type: 'text', text: refusal }] } : updateResult(args.set, state); }
      if (name === 'source_info') return { structuredContent: { sources: MODULES.map(m => ({ id: m.id, label: m.label, readiness: { status: c.sources.enabled.includes(m.id) ? 'ready' : 'disabled', message: '' } })), keysPath: join(state, 'keys.env') } };
      if (name === 'library_revision') return { structuredContent: { revision: String(++revision) } };
      if (name === 'library_snapshot') return { structuredContent: { items: [], live: [], library: c.library, enabledSources: c.sources.enabled, sources: MODULES.map(m => ({ id: m.id, label: m.label })) } };
      throw new Error(`Unexpected tool: ${name}`);
    },
  };
  const ui = await loadApp(host);
  ui.$('nav-sources').onclick(); await settle();
  const list = ui.$('sources-list'); const toc = id => byKey(ui.$('sources-toc'), `toc:${id}`).textContent;
  const cards = [...list.walk()].filter(e => e.tagName === 'ARTICLE');
  assert.deepEqual(cards.map(card => card.getAttribute('id')).sort(), MODULES.map(m => `source-${m.id}`).sort());
  // The longest source id owns a key.
  const home = name => cards.find(card => named(card, name))?.getAttribute('id');
  assert.deepEqual(['x_model', 'x_depth', 'x_web_search', 'x_code_execution', 'tiktok_enabled', 'tiktok_ads_enabled', 'reddit_enabled', 'tikhub_reddit_enabled'].map(home),
    ['source-x', 'source-x', 'source-x', 'source-x', 'source-tiktok', 'source-tiktok-ads', 'source-reddit', 'source-tikhub-reddit']);
  // Each method's worker suggestion sits under its source's Research method, apart from the card's own settings.
  assert.deepEqual(['x_judge_worker_model', 'x_breadth_worker_effort', 'youtube_summarizer_worker_model', 'tiktok_ads_worker_effort', 'reddit_worker_model'].map(home),
    ['source-x', 'source-x', 'source-youtube', 'source-tiktok-ads', 'source-reddit']);
  const inOwnSettings = name => { let at = named(list, name); while (at && !String(at.className).includes('source-settings')) at = at.parentNode; return Boolean(at); };
  assert.deepEqual([inOwnSettings('x_judge_worker_model'), inOwnSettings('x_model')], [false, true]);
  const onSources = names(list);
  ui.$('nav-settings').onclick(); await settle();
  assert.deepEqual(names(ui.$('settings-fields')), ['library', 'keep_raw', 'worker_model', 'worker_effort']);
  // Between them the two pages show every setting exactly once.
  assert.deepEqual([...onSources, 'library', 'keep_raw', 'worker_model', 'worker_effort'].sort(), Object.keys(settingsDocument(await loadConfig(state)).schema.properties).sort());

  ui.$('nav-sources').onclick(); await settle();
  const exa = named(list, 'exa_enabled'); const [, exaWords, exaState] = exa.parentNode.children;
  assert.equal(toc('exa'), 'Exaoff');
  exa.checked = true; await exa.onchange(); await settle();
  assert.deepEqual(updates, [{ exa_enabled: true }]);
  assert.deepEqual((await loadConfig(state)).sources.enabled.toSorted(), ['exa', 'hackernews']);
  assert.equal(exaWords.textContent, 'On'); assert.equal(exaState.textContent, 'Saved');
  assert.equal(toc('exa'), 'Exa', 'The index names a state only when a source is not ready');
  assert.equal(ui.$('source-status').textContent, `2 of ${MODULES.length} sources on`);
  // A quick second flip waits for the first save and wins.
  exa.checked = false; const first = exa.onchange(); exa.checked = true; await Promise.all([first, exa.onchange()]); await settle();
  assert.deepEqual(updates.slice(1), [{ exa_enabled: false }, { exa_enabled: true }]);
  assert.ok((await loadConfig(state)).sources.enabled.includes('exa')); assert.equal(exa.checked, true); assert.equal(exaWords.textContent, 'On');
  // A refused save puts the switch back and says why.
  const papers = named(list, 'papers_enabled'); const [, papersWords, papersState] = papers.parentNode.children;
  refusal = 'The settings file could not be replaced'; papers.checked = true; await papers.onchange(); await settle(); refusal = null;
  assert.deepEqual(updates.at(-1), { papers_enabled: true });
  assert.equal(papers.checked, false); assert.equal(papersWords.textContent, 'Off');
  assert.match(papersState.textContent, /^Not saved: The settings file could not be replaced/);
  assert.equal((await loadConfig(state)).sources.enabled.includes('papers'), false);
  // Back from About returns to a page that still follows outside changes.
  ui.$('nav-about').onclick(); await settle(); ui.$('about-back').onclick();
  await updateConfig({ perplexity_enabled: true }, state); await ui.poll();
  assert.equal(named(list, 'perplexity_enabled').checked, true);
});

test('a method’s worker suggestion saves only where it differs from what it inherits, and follows the Dig-wide one until then', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-workers-')); await initializeConfig(state);
  const updates = []; let revision = 0;
  const host = {
    provider: async ({ name, arguments: args }) => {
      const c = await loadConfig(state);
      if (name === 'settings.read') return { structuredContent: settingsDocument(c) };
      if (name === 'settings.update') { updates.push({ ...args.set }); return updateResult(args.set, state); }
      if (name === 'source_info') return { structuredContent: { error: 'not needed here' } };
      if (name === 'library_revision') return { structuredContent: { revision: String(++revision) } };
      if (name === 'library_snapshot') return { structuredContent: { items: [], live: [], library: c.library } };
      throw new Error(`Unexpected tool: ${name}`);
    },
  };
  const ui = await loadApp(host);
  ui.$('nav-settings').onclick(); await settle();
  const wide = named(ui.$('settings-fields'), 'worker_model');
  assert.equal(wide.value, 'gpt-6.1-sol');
  wide.value = 'gpt-7-sol'; await wide.onchange(); await settle();
  assert.deepEqual((await loadConfig(state)).workers, { default: { model: 'gpt-7-sol' } });

  ui.$('nav-sources').onclick(); await settle();
  // Without source readiness the suggestions still show, from the catalog's methods.
  const list = ui.$('sources-list');
  assert.deepEqual([named(list, 'reddit_worker_model').value, named(list, 'reddit_worker_effort').value, named(list, 'x_judge_worker_model').value], ['gpt-7-sol', 'medium', 'gpt-6-astra']);
  const effort = named(list, 'x_judge_worker_effort'); effort.value = 'xhigh'; await effort.onchange(); await settle();
  const same = named(list, 'reddit_worker_model'); same.value = 'gpt-7-sol'; await same.onchange(); await settle();
  const pinned = named(list, 'hackernews_worker_model'); pinned.value = 'gpt-6.1-sol-mini'; await pinned.onchange(); await settle();
  assert.deepEqual(updates, [{ worker_model: 'gpt-7-sol' }, { x_judge_worker_effort: 'xhigh' }, { hackernews_worker_model: 'gpt-6.1-sol-mini' }], 'An unchanged value is not sent');
  await updateConfig({ reddit_worker_model: 'gpt-7-sol' }, state);
  assert.deepEqual((await loadConfig(state)).workers, { default: { model: 'gpt-7-sol' }, 'x-judge': { effort: 'xhigh' }, hackernews: { model: 'gpt-6.1-sol-mini' } }, 'Echoing an inherited value stores nothing');
  // A later Dig-wide change reaches every method without its own suggestion, and no other.
  await updateConfig({ worker_model: 'gpt-8-sol' }, state); await ui.poll();
  assert.deepEqual([named(list, 'reddit_worker_model').value, named(list, 'hackernews_worker_model').value, named(list, 'x_judge_worker_model').value], ['gpt-8-sol', 'gpt-6.1-sol-mini', 'gpt-6-astra']);
});

test('a refresh while a worker field is being typed in leaves the draft unsaved and focused until it is committed', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-worker-draft-')); await initializeConfig(state);
  const updates = []; let revision = 0;
  const host = {
    provider: async ({ name, arguments: args }) => {
      const c = await loadConfig(state);
      if (name === 'settings.read') return { structuredContent: settingsDocument(c) };
      if (name === 'settings.update') { updates.push({ ...args.set }); return updateResult(args.set, state); }
      if (name === 'source_info') return { structuredContent: { sources: MODULES.map(m => ({ id: m.id, label: m.label, readiness: { status: 'ready', message: '' }, credentials: [{ name: 'EXAMPLE_API_KEY', available: revision % 2 === 0, required: true }] })) } };
      if (name === 'library_revision') return { structuredContent: { revision: String(++revision) } };
      if (name === 'library_snapshot') return { structuredContent: { items: [], live: [], library: c.library } };
      throw new Error(`Unexpected tool: ${name}`);
    },
  };
  const ui = await loadApp(host);
  ui.$('nav-sources').onclick(); await settle();
  const draft = named(ui.$('sources-list'), 'x_breadth_worker_model');
  draft.focus(); draft.value = 'gpt-unfinished';
  await ui.poll(); await ui.poll();
  assert.deepEqual(updates, [], 'Refreshing a card’s readiness never commits a draft');
  assert.equal(ui.document.activeElement, draft); assert.equal(draft.value, 'gpt-unfinished');
  await draft.onchange(); await settle();
  assert.deepEqual(updates, [{ x_breadth_worker_model: 'gpt-unfinished' }]);
  assert.deepEqual((await loadConfig(state)).workers, { 'x-breadth': { model: 'gpt-unfinished' } });
});

test('a library path that is not a folder yet is named under its field, and reading the library never creates it', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-library-folder-')); await initializeConfig(state);
  let revision = 0;
  const host = {
    provider: async ({ name, arguments: args }) => {
      const c = await loadConfig(state);
      if (name === 'settings.read') return { structuredContent: settingsDocument(c) };
      if (name === 'settings.update') return updateResult(args.set, state);
      if (name === 'library_revision') return { structuredContent: { revision: String(++revision) } };
      if (name === 'library_snapshot') return { structuredContent: { ...(await listLibrary(c)), library: c.library, libraryFolder: await libraryFolder(c) } };
      throw new Error(`Unexpected tool: ${name}`);
    },
  };
  const ui = await loadApp(host);
  ui.$('nav-settings').onclick(); await settle();
  const fields = ui.$('settings-fields'); const field = named(fields, 'library');
  const note = [...fields.walk()].find(e => e.getAttribute('id') === 'setting-library-note');
  assert.equal(field.getAttribute('aria-describedby'), 'setting-library-help setting-library-note');
  const typo = join(state, 'Docu');
  field.value = typo; await field.onchange(); await settle();
  assert.equal((await loadConfig(state)).library, typo);
  assert.equal(note.hidden, false); assert.match(note.textContent, /^This folder does not exist yet\./);
  await assert.rejects(stat(typo), { code: 'ENOENT' }, 'Saving and reading leave a mistyped library uncreated');
  await mkdir(typo); await ui.poll();
  assert.equal(note.hidden, true);
  const file = join(state, 'notes.txt'); await writeFile(file, 'not a library');
  field.value = file; await field.onchange(); await settle();
  assert.equal(note.hidden, false); assert.match(note.textContent, /^This path is not a folder/);
});

test('keys.env buttons in a source card prepare and open the file, copy an environment key on request, and refresh readiness in place', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-keys-ui-')); await initializeConfig(state);
  const keysPath = join(state, 'keys.env');
  let available = false; let environment = 'unused'; let revision = 0; let gate = Promise.resolve(); const prepared = []; const opened = []; const copied = [];
  const exa = () => ({ id: 'exa', label: 'Exa', readiness: { status: available ? 'ready' : 'setup-required', message: available ? 'Ready.' : 'Missing EXA_API_KEY.' }, credentials: [{ name: 'EXA_API_KEY', available, required: true, environment }], prerequisites: [], methods: [] });
  const host = {
    files: { open: async path => { opened.push(path); return {}; } },
    provider: async ({ name, arguments: args }) => {
      if (name === 'settings.read') return { structuredContent: settingsDocument(await loadConfig(state)) };
      if (name === 'settings.update') { await gate; return updateResult(args.set, state); }
      if (name === 'source_info') return { structuredContent: { sources: [exa()], keysPath } };
      if (name === 'prepare_keys_file') { prepared.push(args); return { structuredContent: { path: keysPath, added: ['EXA_API_KEY'], created: true } }; }
      if (name === 'use_environment_keys') { copied.push(args); environment = 'same'; return { structuredContent: { path: keysPath, copied: ['EXA_API_KEY'] } }; }
      if (name === 'library_revision') return { structuredContent: { revision: String(revision) } };
      if (name === 'library_snapshot') return { structuredContent: { items: [], live: [], library: (await loadConfig(state)).library } };
      throw new Error(`Unexpected tool: ${name}`);
    },
  };
  const ui = await loadApp(host);
  ui.$('nav-sources').onclick(); await settle();
  const list = ui.$('sources-list'); const model = named(list, 'x_model');
  const keys = () => byKey(list, 'keys:exa'); const reuse = () => byKey(list, 'env:exa');
  const keyRow = name => [...list.walk()].find(e => e.className === 'key-row' && e.children[0].children[1]?.textContent === name)?.textContent;
  const setup = byKey(list, 'setup:exa').parentNode; const accounts = byKey(ui.$('accounts'), 'accounts').parentNode;
  assert.equal(setup.tagName, 'DETAILS'); assert.ok(setup.contains(keys()), 'Edit keys.env sits in the card’s Setup details');
  assert.equal(byKey(list, 'setup:exa').textContent, 'Setup detailsKeys and suggested worker');
  assert.match(byKey(ui.$('accounts'), 'accounts').textContent, /^Where to get each key0 of \d+ accounts set in keys\.env$/);
  setup.open = true; accounts.open = true;
  assert.equal(reuse().textContent, 'Use existing key');
  assert.equal(keyRow('EXA_API_KEY'), 'missingEXA_API_KEYCodex’s environment has one that Dig isn’t using.');
  keys().focus(); await keys().onclick(); await settle();
  assert.equal(JSON.stringify([prepared, opened]), JSON.stringify([[{ source: 'exa' }], [keysPath]]));
  assert.match(ui.$('notice').textContent, /Opened keys\.env\. Added empty lines for EXA_API_KEY\./);
  await ui.poll();
  assert.match(keyRow('EXA_API_KEY'), /^missingEXA_API_KEY/);
  available = true; environment = 'different'; revision++;
  await ui.poll();
  assert.equal(keyRow('EXA_API_KEY'), 'setEXA_API_KEYCodex’s environment has a different one.');
  assert.equal(byKey(ui.$('sources-toc'), 'toc:exa').textContent, 'Exa');
  assert.equal(ui.document.activeElement, keys());
  assert.equal(reuse().textContent, 'Update key from env');
  // Both folds are the same elements after the refresh, so a browser keeps them open; the accounts gist counts anew.
  assert.deepEqual([byKey(list, 'setup:exa').parentNode === setup, setup.open, byKey(ui.$('accounts'), 'accounts').parentNode === accounts, accounts.open], [true, true, true, true]);
  assert.match(byKey(ui.$('accounts'), 'accounts').textContent, /^Where to get each key1 of \d+ accounts set in keys\.env$/);
  byKey(list, 'setup:exa').focus(); revision++; await ui.poll();
  assert.equal(ui.document.activeElement, byKey(list, 'setup:exa'), 'Focus on Setup details’ summary stays through a refresh');
  byKey(list, 'note-keys:exa').focus(); revision++; await ui.poll();
  assert.equal(ui.document.activeElement, byKey(list, 'note-keys:exa'), 'Focus on a rebuilt section’s (i) stays on it');
  await reuse().onclick(); await settle();
  assert.equal(JSON.stringify(copied), JSON.stringify([{ source: 'exa' }]));
  assert.match(ui.$('notice').textContent, /Copied EXA_API_KEY from Codex’s environment into keys\.env\./);
  assert.equal(reuse(), undefined, 'Once keys.env matches the environment there is nothing to copy');
  // A setting changed elsewhere shows at once, except in a field that is being typed in.
  await updateConfig({ x_model: 'grok-hand-edit' }, state); revision++; await ui.poll();
  assert.equal(model.value, 'grok-hand-edit');
  model.focus(); model.value = 'grok-typing';
  await updateConfig({ x_depth: 'max' }, state); revision++; await ui.poll();
  assert.equal(model.value, 'grok-typing'); assert.equal(named(list, 'x_depth').value, 'max');
  // A save that settles after newer typing leaves the newer draft; a refresh during a save leaves the pending choice.
  let release; gate = new Promise(resolve => { release = resolve; });
  model.value = 'grok-committed'; const saving = model.onchange();
  model.value = 'grok-newer-draft'; release(); await saving; await settle();
  assert.equal((await loadConfig(state)).x.model, 'grok-committed'); assert.equal(model.value, 'grok-newer-draft');
  const depth = named(list, 'x_depth'); gate = new Promise(resolve => { release = resolve; });
  depth.value = 'ultra'; const choosing = depth.onchange();
  revision++; await ui.poll();
  assert.equal(depth.value, 'ultra');
  release(); await choosing; await settle();
  assert.equal((await loadConfig(state)).x.depth, 'ultra'); assert.equal(depth.value, 'ultra');
});

test('a card’s (i) note opens on hover or click, one at a time, and Escape closes it and returns focus', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-notes-')); await initializeConfig(state);
  const exa = { id: 'exa', label: 'Exa', readiness: { status: 'ready', message: '' }, credentials: [{ name: 'EXA_API_KEY', available: true, required: true, environment: 'absent' }], prerequisites: [] };
  const host = {
    provider: async ({ name }) => {
      if (name === 'settings.read') return { structuredContent: settingsDocument(await loadConfig(state)) };
      if (name === 'source_info') return { structuredContent: { sources: [exa], keysPath: join(state, 'keys.env') } };
      if (name === 'library_revision') return { structuredContent: { revision: '1' } };
      if (name === 'library_snapshot') return { structuredContent: { items: [], live: [], library: (await loadConfig(state)).library } };
      throw new Error(`Unexpected tool: ${name}`);
    },
  };
  const ui = await loadApp(host);
  ui.$('nav-sources').onclick(); await settle();
  const list = ui.$('sources-list');
  const keysInfo = byKey(list, 'note-keys:exa'); const workersInfo = byKey(list, 'note-workers:reddit');
  const noteOf = trigger => [...list.walk()].find(e => e.getAttribute('id') === trigger.getAttribute('aria-controls'));
  assert.deepEqual([noteOf(keysInfo).hidden, keysInfo.getAttribute('aria-expanded')], [true, 'false']);
  keysInfo.focus(); keysInfo.onclick();
  assert.deepEqual([noteOf(keysInfo).hidden, keysInfo.getAttribute('aria-expanded')], [false, 'true']);
  assert.match(noteOf(keysInfo).textContent, /Dig checks only that a key is there, not that the provider accepts it\./);
  workersInfo.onmouseenter();
  assert.deepEqual([noteOf(keysInfo).hidden, noteOf(workersInfo).hidden], [true, false], 'Opening one note closes the other');
  workersInfo.onclick();
  ui.listeners.keydown({ key: 'Escape' });
  assert.deepEqual([noteOf(workersInfo).hidden, workersInfo.getAttribute('aria-expanded')], [true, 'false']);
  assert.equal(ui.document.activeElement, workersInfo);
  keysInfo.onclick(); ui.listeners.pointerdown({ target: list });
  assert.equal(noteOf(keysInfo).hidden, true, 'A click elsewhere closes it');
});

test('an account reads set when keys.env holds what its sources need; optional names are listed after it and never make it partly set', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-accounts-optional-')); await initializeConfig(state);
  const signIn = ['X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];
  const credential = (name, available, required) => ({ name, available, required, environment: 'absent' });
  const x = { id: 'x', label: 'X', readiness: { status: 'partial', message: 'Missing XAI_API_KEY.' }, credentials: [credential('XAI_API_KEY', false, true), credential('X_BEARER_TOKEN', true, true), ...signIn.map(name => credential(name, false, false))], prerequisites: [] };
  const host = {
    provider: async ({ name }) => {
      if (name === 'settings.read') return { structuredContent: settingsDocument(await loadConfig(state)) };
      if (name === 'source_info') return { structuredContent: { sources: [x], keysPath: join(state, 'keys.env') } };
      if (name === 'library_revision') return { structuredContent: { revision: '1' } };
      if (name === 'library_snapshot') return { structuredContent: { items: [], live: [], library: (await loadConfig(state)).library } };
      throw new Error(`Unexpected tool: ${name}`);
    },
  };
  const ui = await loadApp(host);
  ui.$('nav-sources').onclick(); await settle();
  const tile = byKey(ui.$('accounts'), 'account:x-api').parentNode.parentNode.parentNode;
  assert.equal(tile.tagName, 'LI');
  assert.match(tile.textContent, /^X APIsetX_BEARER_TOKEN; optional: X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRETNeeded by X\. /);
});

test('a newer installed Dig tells the reader once to refresh the view Codex cached', async () => {
  const host = scriptedHost([{ ...snapshotOf([]), version: '9.9.9' }]);
  const ui = await loadApp(host);
  assert.match(ui.$('notice').textContent, /Dig 9\.9\.9 is installed.*Refresh/);
  ui.$('dismiss').onclick();
  await ui.poll();
  assert.equal(ui.$('notice').textContent, '');
});

test('a server whose files a later install removed says once that only reopening Codex loads the new version', async () => {
  const host = scriptedHost([{ ...snapshotOf([]), version: '0.0.0', replaced: { version: '9.9.9' } }]);
  const ui = await loadApp(host);
  assert.match(ui.$('notice').textContent, /^Dig 9\.9\.9 was installed while Codex was running\. Quit and reopen Codex.*keeps running Dig 0\.0\.0/);
  assert.doesNotMatch(ui.$('notice').textContent, /Right-click/, 'The refresh notice would not help, so it is not shown');
  ui.$('dismiss').onclick();
  await ui.poll();
  assert.equal(ui.$('notice').textContent, '');
});

test('an exact-file deep link opens that retained file from the library', async () => {
  const host = scriptedHost([snapshotOf([item('A'), item('B')])], { deepLink: { url: `/read?file=${encodeURIComponent(`/library/${report('B')}`)}` } });
  const ui = await loadApp(host);
  assert.ok(host.reads.has(report('B')));
  host.reads.get(report('B'))('BODY_B'); await settle();
  assert.equal(ui.$('dig-title').textContent, 'Question B'); assert.match(ui.$('document').textContent, /BODY_B/);
});

test('a deep link refreshes a hidden views stale library before resolving a newly saved report', async () => {
  const snapshots = [snapshotOf([item('A')])];
  const host = scriptedHost(snapshots);
  const ui = await loadApp(host);
  ui.document.visibilityState = 'hidden';
  snapshots[0] = snapshotOf([item('A'), item('B')]);
  host.deepLink = { url: `/read?file=${encodeURIComponent(report('B'))}` };
  host.listeners.hostcontextchanged({}); await settle();
  assert.ok(host.reads.has(report('B')));
  host.reads.get(report('B'))('Newly saved evidence'); await settle();
  assert.equal(ui.$('dig-title').textContent, 'Question B');
  assert.match(ui.$('document').textContent, /Newly saved evidence/);
});
