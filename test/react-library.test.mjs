import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

// A real DOM and the real React/Router/Query tree, with only the host transport replaced.
// These tests intentionally do not run the retired imperative app controller.
const window = new Window({ url: 'http://dig.test/' });
globalThis.self = window;
for (const name of ['window', 'document', 'location', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'ResizeObserver', 'getComputedStyle']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : typeof window[name] === 'function' && name === 'getComputedStyle' ? window[name].bind(window) : window[name] });
}
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.scrollTo = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { LibraryApp, createLibraryQueryClient } = await import('../src/frontend/library/app.tsx');
const { VERSION } = await import('../src/version.mjs');

const settle = async () => {
  await React.act(async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
};
const report = id => `p/digs/${id}/hackernews.md`;
const item = (id, extra = {}) => ({ id, title: `Question ${id}`, project: `/project/${id}`, status: 'report saved', startedAt: new Date().toISOString(), snippet: `Summary of ${id}`, session: 'thread-1', files: [`p/digs/${id}/dig.md`, report(id)], reports: [report(id)], reportDetails: [{ file: report(id), source: 'hackernews', method: 'hackernews', status: 'complete' }], calls: [], answer: null, sources: ['hackernews'], methods: ['hackernews'], ...extra });
const snapshotOf = items => ({ version: VERSION, items, live: [], library: '/library', configPath: '/state/config.toml', keepRaw: true, enabledSources: ['hackernews'], sources: [{ id: 'hackernews', label: 'Hacker News' }, { id: 'commerce', label: 'Commerce' }] });
const rawCall = { id: 'call-1', at: new Date().toISOString(), ms: 900, tool: 'hackernews', source: 'hackernews', status: 'success', args: { query: 'sqlite' }, cost: [], session: 't', rawFile: 'p/sessions/t/raw/call-1.json', claimedBy: report('A') };
const byKey = key => [...document.querySelectorAll('[data-key]')].find(node => node.dataset.key === key);
const $ = id => document.getElementById(id);
const click = async node => { assert.ok(node, 'click target exists'); await React.act(async () => node.click()); await settle(); };
const type = async (element, value) => {
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settings = () => ({
  schema: { type: 'object', properties: { library: { type: 'string', title: 'Library', minLength: 1 }, keep_raw: { type: 'boolean', title: 'Keep original responses' }, hackernews_enabled: { type: 'boolean', title: 'Enable Hacker News' } } },
  values: { library: '/library', keep_raw: true, hackernews_enabled: true },
  layout: [{ title: 'Library', items: [{ kind: 'property', property: 'library' }, { kind: 'property', property: 'keep_raw' }] }, { title: 'Hacker News', items: [{ kind: 'property', property: 'hackernews_enabled' }] }],
});
function scriptedHost(initial, extra = {}) {
  const reads = new Map(); const calls = [];
  const resultHandlers = new Set(); const activationHandlers = new Set();
  let value = initial; let revision = 0; let currentSettings = settings();
  const host = {
    preview: false, reads, calls, context: {}, link: null,
    start: async () => { assert.ok(resultHandlers.size); assert.ok(activationHandlers.size); },
    dispose() {}, getContext: () => host.context, readDeepLink: () => host.link,
    canOpenFile: () => true, canDraft: () => true, openFile: async () => {}, openLink: async () => {}, draft: async () => {},
    subscribeResult: callback => { resultHandlers.add(callback); return () => resultHandlers.delete(callback); },
    subscribeActivation: callback => { activationHandlers.add(callback); return () => activationHandlers.delete(callback); },
    emitResult: value => resultHandlers.forEach(callback => callback({ structuredContent: value })),
    activate: url => { host.link = url; activationHandlers.forEach(callback => callback({})); },
    setSnapshot: next => { value = next; revision++; },
    setSettings: next => { currentSettings = next; revision++; },
    async call(name, args = {}) {
      calls.push({ name, args });
      if (extra.call) { const response = extra.call(name, args); if (response !== undefined) return response; }
      if (name === 'library_snapshot') return value;
      if (name === 'library_revision') return { revision: String(revision) };
      if (name === 'library_read') {
        const prefix = `${value.library.replace(/\/+$/, '')}/`;
        const path = args.file.startsWith('/') ? args.file : `${prefix}${args.file}`;
        if (!path.startsWith(prefix)) throw new Error('The requested path is outside the active library.');
        const file = path.slice(prefix.length);
        return new Promise(resolve => {
          const respond = (text, nextOffset = null, overrides = {}) => resolve({
            file, path, text, offset: args.offset, nextOffset,
            totalCharacters: nextOffset === null ? args.offset + text.length : nextOffset + 1,
            ...overrides,
          });
          reads.set(`${path}:${args.offset}`, respond);
          reads.set(`${file}:${args.offset}`, respond);
        });
      }
      if (name === 'saved_research') { const file = args.file.slice((value.library + '/').length); return { file, path: args.file, kind: file.endsWith('/answer.md') ? 'answer' : 'report', title: 'Retained report', label: 'Hacker News report', findings: [], contradictions: [], followUps: [], schemaWarnings: [] }; }
      if (name === 'settings.read') return currentSettings;
      if (name === 'settings.update') { currentSettings = { ...currentSettings, values: { ...currentSettings.values, ...args.set } }; revision++; return { values: currentSettings.values }; }
      if (name === 'source_info') return { keysPath: '/state/keys.env', configPath: '/state/config.toml', sources: [{ id: 'hackernews', label: 'Hacker News', enabled: currentSettings.values.hackernews_enabled, readiness: { status: 'ready' }, credentials: [], prerequisites: [] }] };
      throw new Error(`Unexpected tool: ${name}`);
    },
    ...extra.host,
  };
  return host;
}
async function mount(t, host) {
  document.body.replaceChildren();
  const element = document.createElement('div'); document.body.append(element);
  const queryClient = createLibraryQueryClient();
  const originalInterval = globalThis.setInterval; const originalClear = globalThis.clearInterval;
  const intervals = new Map(); let sequence = 100;
  globalThis.setInterval = (callback, ms) => { const id = ++sequence; intervals.set(id, { callback, ms }); return id; };
  globalThis.clearInterval = id => { intervals.delete(id); };
  const root = createRoot(element);
  await React.act(async () => root.render(React.createElement(LibraryApp, { host, queryClient })));
  await settle();
  t.after(async () => {
    await React.act(async () => root.unmount()); queryClient.clear();
    globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });
  return { queryClient, poll: async () => { const task = [...intervals.values()].find(item => item.ms === 2000); assert.ok(task); await React.act(async () => { await task.callback(); }); await settle(); } };
}
async function openDig(host, id, body) {
  await click(byKey(`dig:/project/${id}:${id}`));
  if (body !== undefined) { await React.act(async () => host.reads.get(`${report(id)}:0`)(body)); await settle(); }
}

test('React navigation rejects late files, reads all pages, and retains the report while inspecting evidence', async t => {
  const a = item('A', { calls: [rawCall] });
  const host = scriptedHost(snapshotOf([a, item('B'), item('C')]));
  await mount(t, host);
  await openDig(host, 'A');
  const first = '# First\n\nBEGIN_'; const rest = 'END\n\n## Another\n\n<img src=x onerror=alert(1)>';
  await React.act(async () => host.reads.get(`${report('A')}:0`)(first, first.length, { totalCharacters: first.length + rest.length })); await settle();
  assert.match($('document').textContent, /Reading retained/);
  assert.equal(host.calls.filter(call => call.name === 'library_read').at(-1).args.file, `/library/${report('A')}`);
  await React.act(async () => host.reads.get(`${report('A')}:${first.length}`)(rest)); await settle();
  assert.match($('document').textContent, /BEGIN_END/);
  assert.equal($('document').querySelectorAll('img,script').length, 0);
  const reportDOM = $('document').firstElementChild;
  await click(byKey(`raw:${rawCall.rawFile}`));
  assert.equal($('document').firstElementChild, reportDOM);
  await React.act(async () => host.reads.get(`${rawCall.rawFile}:0`)('{"responses":[]}')); await settle();
  assert.equal($('document').firstElementChild, reportDOM);
  await React.act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await settle();
  assert.equal($('evidence-pane').hidden, true);
  assert.equal($('document').firstElementChild, reportDOM);
  await click($('back'));
  await openDig(host, 'B');
  await click($('back'));
  await openDig(host, 'C', 'BODY_C');
  await React.act(async () => host.reads.get(`${report('B')}:0`)('LATE_B')); await settle();
  assert.match($('document').textContent, /BODY_C/);
  assert.doesNotMatch($('document').textContent, /LATE_B/);
});

test('visible revision polling is read-only and preserves document, details and focused report controls', async t => {
  const before = item('A', { calls: [rawCall] });
  const host = scriptedHost(snapshotOf([before]));
  const ui = await mount(t, host);
  await openDig(host, 'A', '# Heading\n\n## Summary\n\nTEXT\n\n## Evidence\n\nEVIDENCE');
  const reportDOM = $('document').firstElementChild;
  const tab = byKey(`file:${report('A')}`); tab.focus();
  const after = item('A', { calls: [rawCall, { ...rawCall, id: 'call-2', rawFile: null }], files: [...before.files, 'p/digs/A/answer.md'], answer: 'p/digs/A/answer.md' });
  host.setSnapshot(snapshotOf([after]));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  const count = host.calls.length; await ui.poll(); assert.equal(host.calls.length, count);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await ui.poll();
  assert.equal($('document').firstElementChild, reportDOM);
  assert.equal(document.activeElement, tab);
  assert.equal($('files').children.length, 3);
  assert.match($('notice').textContent, /Saved to this dig: Answer/);
  assert.deepEqual([...new Set(host.calls.map(call => call.name))].sort(), ['library_read', 'library_revision', 'library_snapshot', 'saved_research']);
});

test('settings refresh keeps draft DOM and focus; a save overlapping a poll gets a subsequent fresh snapshot', async t => {
  const blocked = deferred(); let blockNext = false; let servedOld = false;
  const host = scriptedHost(snapshotOf([]), { call(name) {
    if (name === 'library_snapshot' && blockNext && !servedOld) { servedOld = true; return blocked.promise; }
  } });
  const ui = await mount(t, host);
  await click($('nav-settings'));
  const field = $('setting-library'); assert.ok(field);
  field.focus(); await type(field, '/my/unfinished/draft');
  host.setSnapshot({ ...snapshotOf([]), keepRaw: false });
  await ui.poll();
  assert.equal($('setting-library'), field); assert.equal(field.value, '/my/unfinished/draft'); assert.equal(document.activeElement, field);
  const toggle = $('setting-keep_raw');
  blockNext = true; host.setSnapshot(snapshotOf([]));
  await ui.poll();
  await click(toggle);
  assert.ok(host.calls.some(call => call.name === 'settings.update'));
  await React.act(async () => blocked.resolve({ ...snapshotOf([]), keepRaw: true }));
  await settle();
  assert.equal($('setting-library'), field);
  assert.equal(field.value, '/my/unfinished/draft');
  const saves = host.calls.findIndex(call => call.name === 'settings.update');
  assert.ok(host.calls.slice(saves + 1).filter(call => call.name === 'library_snapshot').length >= 1);
  assert.match(toggle.parentElement.textContent, /Saved/);
});

test('deep-link activation refreshes hidden data, resolves the exact file, and does not fetch a provider', async t => {
  const host = scriptedHost(snapshotOf([]));
  await mount(t, host);
  host.setSnapshot(snapshotOf([item('A')]));
  await React.act(async () => host.activate(`/read?file=${encodeURIComponent('/library/' + report('A'))}`)); await settle();
  assert.ok(host.reads.has(`${report('A')}:0`));
  await React.act(async () => host.reads.get(`${report('A')}:0`)('EXACT REPORT')); await settle();
  assert.equal($('detail').hidden, false);
  assert.match($('document').textContent, /EXACT REPORT/);
  assert.equal($('file-name').textContent, report('A'));
  assert.ok(host.calls.filter(call => call.name === 'library_snapshot').length >= 2);
});

test('conversation trail scopes cost and source setup shares settings without starting research', async t => {
  const mine = item('A', { calls: [{ ...rawCall, cost: [{ unit: 'USD', amount: 0.42 }] }] });
  const host = scriptedHost({ ...snapshotOf([mine, item('B', { session: 'elsewhere' })]), live: [{ ...rawCall, id: 'elsewhere', session: 'elsewhere', cost: [{ unit: 'USD', amount: 100 }] }] });
  await mount(t, host);
  await React.act(async () => host.emitResult({ view: 'panel', thread: 'thread-1' })); await settle();
  assert.equal($('panel').hidden, false);
  assert.match($('panel-digs').textContent, /Question A/); assert.doesNotMatch($('panel-digs').textContent, /Question B/);
  assert.match($('panel-figures').textContent, /0\.42/); assert.doesNotMatch($('panel-figures').textContent, /100\.00/);
  await click($('nav-sources'));
  assert.ok($('source-hackernews'));
  assert.match($('sources-summary').textContent, /1 of 1/);
  await click($('nav-about')); await click($('about-back'));
  assert.equal($('sources').hidden, false);
  assert.deepEqual([...new Set(host.calls.map(call => call.name))].sort(), ['library_revision', 'library_snapshot', 'settings.read', 'source_info']);
});

test('Start here is discoverable without replacing the overview or starting research, and About returns to it', async t => {
  const host = scriptedHost(snapshotOf([]));
  await mount(t, host);
  assert.equal($('browse').hidden, false);
  assert.equal($('guide').hidden, true);
  await click($('nav-guide'));
  assert.equal($('guide').hidden, false);
  assert.equal($('browse').hidden, true);
  assert.equal($('nav-guide').getAttribute('aria-current'), 'page');
  assert.equal(document.activeElement, $('guide-title'));
  await click($('nav-about'));
  await click($('about-back'));
  assert.equal($('guide').hidden, false);
  assert.deepEqual([...new Set(host.calls.map(call => call.name))].sort(), ['library_revision', 'library_snapshot', 'source_info']);
});

test('a saved answer opens before newer source reports and detailed accounting', async t => {
  const answer = 'p/digs/A/answer.md';
  const host = scriptedHost(snapshotOf([item('A', { answer, status: 'answered', files: [report('A'), answer] })]));
  await mount(t, host);
  await click(byKey('dig:/project/A:A'));
  assert.equal(document.activeElement, $('dig-title'));
  assert.equal(host.calls.find(call => call.name === 'library_read').args.file, '/library/' + answer);
  await React.act(async () => host.reads.get(answer + ':0')('# Saved answer\n\nThe retained conclusion.')); await settle();
  assert.match($('document').textContent, /The retained conclusion/);
  const details = document.querySelector('.reader-research-details');
  assert.ok($('document').compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(details.querySelector('.dig-disclosure-trigger').getAttribute('aria-expanded'), 'false');
  assert.equal(host.calls.some(call => !['library_snapshot', 'library_revision', 'library_read', 'saved_research'].includes(call.name)), false);
});

test('document strip reveals directional controls only for overflow and updates at either edge', async t => {
  const host = scriptedHost(snapshotOf([item('A')]));
  await mount(t, host);
  await openDig(host, 'A', '# Report');
  const list = $('files');
  assert.equal(document.querySelector('[aria-label="Scroll documents"]'), null);
  Object.defineProperties(list, { clientWidth: { configurable: true, value: 200 }, scrollWidth: { configurable: true, value: 500 } });
  list.scrollBy = ({ left }) => { list.scrollLeft = Math.min(300, Math.max(0, list.scrollLeft + left)); list.dispatchEvent(new Event('scroll')); };
  await React.act(async () => window.dispatchEvent(new Event('resize'))); await settle();
  const left = document.querySelector('[aria-label="Scroll documents left"]');
  const right = document.querySelector('[aria-label="Scroll documents right"]');
  assert.equal(left.disabled, true); assert.equal(right.disabled, false);
  await click(right);
  assert.ok(list.scrollLeft > 0); assert.equal(left.disabled, false);
  await click(right);
  assert.equal(list.scrollLeft, 300); assert.equal(right.disabled, true);
  await click(left);
  assert.ok(list.scrollLeft < 300); assert.equal(right.disabled, false);
  Object.defineProperty(list, 'clientWidth', { configurable: true, value: 600 });
  list.scrollLeft = 0;
  await React.act(async () => window.dispatchEvent(new Event('resize'))); await settle();
  assert.equal(document.querySelector('[aria-label="Scroll documents"]'), null);
});

test('opening research reads its result first; explicitly inspecting an original reopens hidden records', async t => {
  const host = scriptedHost(snapshotOf([item('A', { planned: ['hackernews', 'exa'], calls: [rawCall] })]));
  await mount(t, host);
  await click(byKey('dig:/project/A:A'));
  assert.equal(host.calls.filter(call => call.name === 'library_read').length, 1);
  assert.equal(document.querySelector('.research-record-inspection').hidden, false);
  assert.match($('detail').textContent, /No report saved/);
  assert.equal(host.calls.filter(call => call.name === 'saved_research').length, 1);
  await React.act(async () => host.reads.get(report('A') + ':0')('RETAINED REPORT')); await settle();
  await click($('inspect-records'));
  assert.equal(document.querySelector('.research-record-inspection').hidden, true);
  await click(document.querySelector('#research-calls .dig-disclosure-trigger'));
  await click(byKey('raw:' + rawCall.rawFile));
  assert.equal(document.querySelector('.research-record-inspection').hidden, false);
  await React.act(async () => host.reads.get(rawCall.rawFile + ':0')('{"responses":[{"body":"ORIGINAL EVIDENCE"}]}')); await settle();
  assert.equal($('evidence-pane').hidden, false);
  assert.match($('evidence-body').textContent, /ORIGINAL EVIDENCE/);
  assert.match($('document').textContent, /RETAINED REPORT/);
});

test('late assessments cannot replace another selected question or survive a library switch', async t => {
  const pending = new Map();
  const host = scriptedHost(snapshotOf([item('A'), item('B')]), { call(name, args) {
    if (name === 'saved_research') return new Promise(resolve => pending.set(args.file, resolve));
  } });
  const ui = await mount(t, host);
  await click(byKey('dig:/project/A:A'));
  await click($('back'));
  await click(byKey('dig:/project/B:B'));
  await React.act(async () => pending.get('/library/' + report('A'))({ file: report('A'), path: '/library/' + report('A'), kind: 'report', findings: ['LATE A FINDING'] })); await settle();
  assert.doesNotMatch($('detail').textContent, /LATE A FINDING/);
  host.setSnapshot({ ...snapshotOf([item('B')]), library: '/new-library' });
  await ui.poll();
  await React.act(async () => pending.get('/library/' + report('B'))({ file: report('B'), path: '/library/' + report('B'), kind: 'report', findings: ['OLD LIBRARY FINDING'] })); await settle();
  assert.equal($('browse').hidden, false);
  assert.doesNotMatch($('detail').textContent, /OLD LIBRARY FINDING/);
});

test('unsupported assessment and composed-answer defaults never claim an absence of author follow-ups', async t => {
  let answer = false;
  const host = scriptedHost(snapshotOf([item('A', { answer: 'p/digs/A/answer.md', files: [report('A'), 'p/digs/A/answer.md'] })]), { call(name, args) {
    if (name !== 'saved_research') return undefined;
    const file = args.file.slice('/library/'.length);
    return { file, path: args.file, kind: answer ? 'answer' : 'report', label: 'Fixture', followUps: [], findings: [], contradictions: [], schemaWarnings: answer ? [] : ['Unsupported report structure; read the original wording.'] };
  } });
  await mount(t, host);
  await click(byKey('dig:/project/A:A'));
  assert.match($('detail').textContent, /could not be fully projected/);
  assert.match($('detail').textContent, /Unsupported report structure/);
  assert.doesNotMatch($('detail').textContent, /No follow-up targets/);
  answer = true;
  await click(byKey('file:p/digs/A/answer.md'));
  assert.match($('detail').textContent, /saved answer has no source-author assessment/);
  assert.doesNotMatch($('detail').textContent, /No follow-up targets/);
});

test('cost overview preserves unknowns and separate credit units, and pricing disclosures survive a refresh', async t => {
  const calls = [
    { ...rawCall, id: 'priced', cost: [{ amount: 0.25, unit: 'USD' }] },
    { ...rawCall, id: 'partial', cost: null, knownCost: [{ amount: 0.10, unit: 'USD' }] },
    { ...rawCall, id: 'credits', cost: [{ amount: 4, unit: 'ScrapeCreators credits' }] },
    { ...rawCall, id: 'othercredits', cost: [{ amount: 8, unit: 'Scrape.do credits' }] },
    { ...rawCall, id: 'unknown', source: 'video', tool: 'video_analyze', cost: null },
  ];
  const host = scriptedHost(snapshotOf([item('A', { calls }), item('B')]));
  const ui = await mount(t, host);
  assert.match($('usage').textContent, /0\.35/);
  assert.match($('usage').textContent, /4.*ScrapeCreators credits/);
  assert.match($('usage').textContent, /8.*Scrape\.do credits/);
  assert.match($('usage').textContent, /2.*5.*incompletely priced/);
  const pricing = [...$('usage').querySelectorAll('details')].find(node => /Pricing details/.test(node.querySelector('summary')?.textContent));
  assert.ok(pricing); assert.equal(pricing.open, false); pricing.open = true; pricing.dispatchEvent(new Event('toggle')); pricing.querySelector('summary').focus();
  host.setSnapshot(snapshotOf([item('A', { calls: [...calls, { ...rawCall, id: 'unknown2', cost: null }] }), item('B')]));
  await ui.poll();
  const refreshedPricing = [...$('usage').querySelectorAll('details')].find(node => /Pricing details/.test(node.querySelector('summary')?.textContent));
  assert.equal(refreshedPricing.open, true);
  assert.equal(document.activeElement, refreshedPricing.querySelector('summary'));
  const empty = [...$('list').querySelectorAll('article')].find(node => node.textContent.includes('Question B'));
  assert.doesNotMatch(empty.textContent, /No provider charge|Free|\$0\.00/);
});

test('closed or superseded evidence never reopens; report outline focuses actual rendered headings', async t => {
  const host = scriptedHost(snapshotOf([item('A', { calls: [rawCall] }), item('B')]));
  await mount(t, host);
  await openDig(host, 'A', '# Report\n\n## Summary\n\nWords\n\n## Evidence Highlights\n\nMore words');
  const outline = $('document').querySelector('.outline-link');
  assert.ok(outline); await click(outline);
  assert.equal(document.activeElement.id, outline.getAttribute('aria-controls'));
  await click(byKey(`raw:${rawCall.rawFile}`));
  await click($('close-evidence'));
  await React.act(async () => host.reads.get(`${rawCall.rawFile}:0`)('{"responses":[{"label":"LATE EVIDENCE"}]}')); await settle();
  assert.equal($('evidence-pane').hidden, true); assert.doesNotMatch($('evidence-body').textContent, /LATE EVIDENCE/);
  await click($('back'));
  const originalOpener = byKey('dig:/project/A:A');
  await settle();
  assert.equal(document.activeElement, originalOpener);
  await openDig(host, 'B', 'SECOND REPORT');
  assert.doesNotMatch($('document').textContent, /LATE EVIDENCE/);
});

test('read errors pause visible updates without retrying; reload resumes and replacement notice names the connection', async t => {
  let fail = true;
  const host = scriptedHost({ ...snapshotOf([]), replaced: { version: '99.0.0' } }, { call(name) {
    if (name === 'library_revision' && fail) return Promise.reject(new Error('offline fixture'));
  } });
  await mount(t, host);
  assert.equal(host.calls.filter(call => call.name === 'library_revision').length, 1);
  assert.equal($('reload').hidden, false); assert.match($('notice').textContent, /Automatic updates paused: offline fixture/);
  fail = false;
  await click($('reload'));
  assert.equal($('reload').hidden, true);
  await click($('nav-about'));
  assert.match($('about-body').textContent, /99\.0\.0 was installed/);
  assert.match($('about-body').textContent, /Refresh Dig’s plugin connection/);
});

test('the library path note and text draft survive About and external settings changes', async t => {
  const host = scriptedHost({ ...snapshotOf([]), libraryFolder: 'missing' });
  const ui = await mount(t, host);
  await click($('nav-settings'));
  const field = $('setting-library');
  assert.match($('setting-library-note').textContent, /does not exist yet/);
  field.focus(); await type(field, '/still/typing');
  await click($('nav-about')); await click($('about-back'));
  assert.equal($('setting-library'), field); assert.equal(field.value, '/still/typing');
  host.setSnapshot({ ...snapshotOf([]), libraryFolder: 'not-folder' });
  await ui.poll();
  assert.match($('setting-library-note').textContent, /not a folder/);
  assert.equal(field.value, '/still/typing');
  assert.equal(host.calls.some(call => call.name === 'settings.update'), false);
});

test('a different selected library clears old document, evidence and queries before reusing matching relative names', async t => {
  const original = item('A', { calls: [rawCall] });
  const host = scriptedHost(snapshotOf([original]));
  const ui = await mount(t, host);
  await openDig(host, 'A', 'LIBRARY A BODY');
  await click(byKey(`raw:${rawCall.rawFile}`));
  const finishOldEvidence = host.reads.get(`/library/${rawCall.rawFile}:0`);
  assert.ok(finishOldEvidence);
  host.setSnapshot({ ...snapshotOf([{ ...original, title: 'Library B question' }]), library: '/library-b' });
  await ui.poll();
  assert.equal($('detail').hidden, true);
  assert.equal($('browse').hidden, false);
  assert.equal($('document').textContent, '');
  assert.equal($('evidence-body').textContent, '');
  assert.equal($('dig-title').textContent, '');
  assert.match($('notice').textContent, /research library changed/);
  assert.equal(ui.queryClient.getQueryCache().findAll({ queryKey: ['file', '/library'] }).length, 0);
  await React.act(async () => finishOldEvidence('{"responses":[{"body":"LIBRARY A EVIDENCE"}]}')); await settle();
  assert.equal($('evidence-body').textContent, '');
  await openDig(host, 'A');
  assert.ok(host.reads.has(`/library-b/${report('A')}:0`));
  await React.act(async () => host.reads.get(`/library-b/${report('A')}:0`)('LIBRARY B BODY')); await settle();
  assert.equal($('dig-title').textContent, 'Library B question');
  assert.match($('document').textContent, /LIBRARY B BODY/);
  assert.doesNotMatch($('document').textContent, /LIBRARY A/);
});

test('paged reads pin canonical paths and reject changed identity or inconsistent continuation metadata', async t => {
  let currentResponse;
  const host = scriptedHost(snapshotOf([item('A')]), { call(name, args) {
    if (name !== 'library_read' || args.offset !== 3) return undefined;
    assert.equal(args.file, `/canonical/library/${report('A')}`, 'continuation uses the canonical first-response path');
    return currentResponse;
  } });
  await mount(t, host);
  for (const changed of [
    { path: `/other-library/${report('A')}` },
    { file: report('B'), path: `/canonical/library/${report('B')}` },
    { offset: 2 },
    { totalCharacters: 7, nextOffset: 6 },
    { nextOffset: 3 },
  ]) {
    currentResponse = { file: report('A'), path: `/canonical/library/${report('A')}`, text: 'BBB', offset: 3, nextOffset: null, totalCharacters: 6, ...changed };
    await openDig(host, 'A');
    const firstRequest = host.calls.filter(call => call.name === 'library_read').at(-1);
    assert.equal(firstRequest.args.file, `/library/${report('A')}`, 'first read is pinned to the selected snapshot library');
    await React.act(async () => host.reads.get(`/library/${report('A')}:0`)('AAA', 3, { path: `/canonical/library/${report('A')}`, totalCharacters: 6 })); await settle();
    assert.match($('document').textContent, /Unable to read this file/);
    assert.doesNotMatch($('document').textContent, /AAABBB/);
    await click($('back'));
  }
});
