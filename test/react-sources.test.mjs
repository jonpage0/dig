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
const { SourcesPage, groupSourceModules } = await import('../src/frontend/library/sources.tsx');
const { MODULES } = await import('../src/providers/modules.ts');
const $ = id => document.getElementById(id);
const keyed = key => [...document.querySelectorAll('[data-key]')].find(node => node.dataset.key === key);
const settle = async () => React.act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
const click = async element => { assert.ok(element); await React.act(async () => element.click()); await settle(); };
async function type(element, value) {
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const properties = {
  exa_enabled: { type: 'boolean', title: 'Enable Exa' },
  exa_max_results: { type: 'integer', title: 'Maximum results', minimum: 1, maximum: 100 },
  exa_worker_model: { type: 'string', title: 'Exa worker model' },
  exa_worker_effort: { type: 'string', title: 'Exa worker effort', enum: ['', 'low', 'high'] },
  dataforseo_enabled: { type: 'boolean', title: 'Enable DataForSEO' },
  tikhub_reddit_enabled: { type: 'boolean', title: 'Enable TikHub Reddit' },
  tikhub_reddit_worker_model: { type: 'string', title: 'TikHub Reddit worker model' },
  tikhub_reddit_limit: { type: 'integer', title: 'Reddit results', minimum: 1 },
};
function fixture() {
  const calls = [];
  const values = { exa_enabled: true, exa_max_results: 10, exa_worker_model: 'gpt-6.1-sol', exa_worker_effort: '', dataforseo_enabled: false, tikhub_reddit_enabled: true, tikhub_reddit_worker_model: '', tikhub_reddit_limit: 5 };
  const exa = { id: 'exa', label: 'Exa', enabled: true, readiness: { status: 'partial', message: 'An optional setting is missing.' }, credentials: [{ name: 'EXA_API_KEY', required: true, available: true, environment: 'different' }, { name: 'OPTIONAL_KEY', required: false, available: false, environment: 'unused' }], envSettings: [{ name: 'CONTACT_EMAIL', label: 'Contact email', purpose: 'identify requests', bridge: true }], prerequisites: [{ name: 'fixture executable', available: false, detail: 'Install it explicitly.' }] };
  const app = {
    sources: { keysPath: '/state/keys.env', sources: [exa, { id: 'dataforseo', label: 'DataForSEO', enabled: false, readiness: { status: 'disabled' }, credentials: [], prerequisites: [] }] },
    settings: { schema: { type: 'object', properties }, values, layout: [{ title: 'Exa', items: Object.keys(properties).map(property => ({ kind: 'property', property })) }] },
    snapshot: { items: [{ calls: [{ id: 'call-1', source: 'exa', tool: 'exa_search', status: 'partial', at: '2026-10-20T12:00:00Z' }] }], live: [] },
    saveSetting: async (key, value) => { calls.push(['setting', key, value]); return { ...values, [key]: value }; },
    editKeys: async source => { calls.push(['keys', source]); },
    useEnvironment: async source => { calls.push(['environment', source]); },
    notify: (...args) => calls.push(['notify', ...args]),
  };
  const host = { preview: false, openLink: async url => { calls.push(['link', url]); }, call() { throw new Error('Sources must never make a provider request'); } };
  return { app, host, calls };
}
async function mount(t, props) {
  document.body.replaceChildren();
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  const render = async next => { await React.act(async () => root.render(React.createElement(SourcesPage, next))); await settle(); };
  await render(props);
  t.after(async () => { await React.act(async () => root.unmount()); });
  return { render, element };
}

test('React Sources uses ReUI frames and icon tiles, with capabilities/cost prominent and both secondary examples at the bottom', async t => {
  const { app, host, calls } = fixture();
  await mount(t, { app, host, hidden: false });
  assert.equal(document.querySelectorAll('.source-page-card:not(.source-page-addon)').length, MODULES.filter(module => !module.extends).length);
  const exa = $('source-exa');
  assert.ok(exa.querySelector('[data-slot="frame"]'));
  assert.ok(exa.querySelector('[data-slot="icon-tile"]'));
  assert.match(exa.querySelector('.source-page-capabilities').textContent, /Fast or cache-only/);
  assert.match(exa.querySelector('.source-page-billing').textContent, /Cost/);
  const footer = exa.querySelector('.source-page-card-footer');
  assert.deepEqual([...footer.querySelectorAll(':scope > details > summary')].map(node => node.textContent), ['About this source', 'Example for the conversation']);
  assert.ok([...footer.querySelectorAll('details')].every(node => !node.open));
  assert.equal(exa.querySelectorAll('img').length, 0);
  assert.equal(document.querySelectorAll('input[type="search"],textarea').length, 0);
  assert.deepEqual(calls, []);
  await click(keyed('category:web'));
  assert.equal(document.activeElement, $('source-group-heading-web'));
});

test('enablement, own controls and worker drafts retain identity through polling, hidden navigation and setup closure', async t => {
  const { app, host, calls } = fixture();
  const ui = await mount(t, { app, host, hidden: false });
  await click(keyed('setup:exa'));
  const worker = $('setting-exa_worker_model'); worker.focus();
  await type(worker, 'unfinished draft');
  const exa = $('source-exa');
  assert.ok(exa.contains($('setting-exa_max_results')));
  assert.ok($('source-tikhub-reddit').contains($('setting-tikhub_reddit_limit')));
  assert.equal($('source-reddit').contains($('setting-tikhub_reddit_limit')), false);
  const refreshed = { ...app, sources: { ...app.sources, sources: app.sources.sources.map(source => source.id === 'exa' ? { ...source, readiness: { status: 'ready' } } : source) }, settings: { ...app.settings, values: { ...app.settings.values, exa_worker_model: 'external update' } } };
  await ui.render({ app: refreshed, host, hidden: true });
  await ui.render({ app: refreshed, host, hidden: false });
  assert.equal($('setting-exa_worker_model'), worker);
  assert.equal(worker.value, 'unfinished draft');
  assert.equal(document.activeElement, worker);
  assert.equal(keyed('setup:exa').getAttribute('aria-expanded'), 'true');
  assert.match(exa.querySelector('.source-page-state-row').textContent, /Configured/);
  await click(keyed('setup:exa')); await click(keyed('setup:exa'));
  assert.equal($('setting-exa_worker_model'), worker);
  assert.equal(worker.value, 'unfinished draft');
  assert.deepEqual(calls, []);
  await click($('setting-exa_enabled'));
  assert.deepEqual(calls, [['setting', 'exa_enabled', false]]);
});

test('setup exposes presence, optional names, historical activity and explicit key actions without exposing values', async t => {
  const { app, host, calls } = fixture();
  await mount(t, { app, host, hidden: false });
  await click(keyed('setup:exa'));
  const card = $('source-exa');
  assert.match(card.textContent, /EXA_API_KEY/);
  assert.match(card.textContent, /OPTIONAL_KEYOptional/);
  assert.match(card.textContent, /CONTACT_EMAIL/);
  assert.match(card.textContent, /Papers bridge’s \.env/);
  assert.match(card.textContent, /fixture executableNot installed/);
  assert.match(card.querySelector('.source-page-activity').textContent, /Last retained callPartial results/);
  assert.match(card.querySelector('.source-page-activity-detail').textContent, /not a current connection check/);
  await click(keyed('env:exa')); await click(keyed('keys:exa'));
  assert.deepEqual(calls, [['environment', 'exa'], ['keys', 'exa']]);
  assert.match(card.textContent, /replaces the keys.env values/);
  const provider = card.querySelector('.source-page-providers a');
  await click(provider);
  assert.deepEqual(calls.at(-1), ['link', provider.href]);
});

test('example copying never submits a conversation; preview keeps source actions disabled', async t => {
  const { app, host, calls } = fixture();
  const copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied.push(text); } } });
  const ui = await mount(t, { app, host: { ...host, preview: true }, hidden: false });
  assert.equal($('setting-exa_enabled').disabled, true);
  await click(keyed('setup:exa'));
  assert.equal(keyed('env:exa').disabled, true);
  assert.equal(keyed('keys:exa').disabled, true);
  const example = keyed('example:exa'); example.open = true;
  await click([...example.querySelectorAll('button')].find(button => button.textContent === 'Copy example'));
  assert.equal(copied.length, 1);
  assert.match(example.textContent, /Copied\. Paste it into the conversation/);
  assert.deepEqual(calls, []);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  await click([...example.querySelectorAll('button')].find(button => button.textContent === 'Copy example'));
  assert.match(example.textContent, /Select the example text and copy it/);
  await ui.render({ app, host: { ...host, preview: true }, hidden: true });
  await ui.render({ app, host: { ...host, preview: true }, hidden: false });
  assert.equal(keyed('example:exa'), example);
  assert.equal(example.open, true);
});

test('source grouping keeps arbitrary private add-ons with their parent and includes additional catalog modules', () => {
  const parent = { id: 'papers', label: 'Papers' };
  const addon = { id: 'fixture-addon', label: 'Optional extension', extends: 'papers' };
  const extra = { id: 'fixture-extra', label: 'Additional source' };
  const groups = groupSourceModules([parent, addon, extra]);
  assert.equal(groups.flatMap(group => group.members).length, 2);
  const papers = groups.find(group => group.id === 'papers').members[0];
  assert.equal(papers.module, parent);
  assert.deepEqual(papers.addOns, [addon]);
  assert.equal(groups.find(group => group.id === 'other').members[0].module, extra);
});

test('source recorded use preserves every scoped receipt, separates reported units, and keeps unknown costs explicit', async t => {
  const { app, host, calls } = fixture();
  app.snapshot = { items: [{ calls: [
    { id: 'shared-id', session: 'one', source: 'exa', tool: 'exa_search', at: '2020-01-01T12:00:00Z', status: 'success', cost: [{ amount: 0.2, unit: 'USD' }] },
    { id: 'shared-id', session: 'two', source: 'exa', tool: 'exa_search', at: '2020-01-02T12:00:00Z', status: 'partial', cost: [{ amount: 3, unit: 'fixture credits' }] },
  ] }], live: [{ id: 'unclaimed', source: 'exa', tool: 'exa_search', at: '2020-01-03T12:00:00Z', status: 'failed', cost: null }] };
  await mount(t, { app, host, hidden: false });
  const recorded = $('source-exa').querySelector('.source-page-recorded');
  assert.match(recorded.textContent, /All-time retained usage/);
  assert.match(recorded.textContent, /Calls3/);
  assert.doesNotMatch(recorded.textContent, /returned results|with results/);
  assert.match(recorded.textContent, /Reported subtotal/);
  assert.match(recorded.textContent, /\$0\.2000/);
  assert.match(recorded.textContent, /3 fixture credits/);
  assert.match(recorded.textContent, /1 call incompletely priced/);
  assert.doesNotMatch(recorded.textContent, /\$3\.20|No charge recorded/);
  const empty = $('source-github').querySelector('.source-page-recorded');
  assert.match(empty.textContent, /No retained calls yet/);
  assert.doesNotMatch(empty.textContent, /Free|\$0|No charge recorded/);
  assert.deepEqual(calls, []);
});
