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
const { SettingsPage } = await import('../src/frontend/library/settings.tsx');
const $ = id => document.getElementById(id);
const settle = async () => React.act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
function fixture() {
  const calls = [];
  const values = { library: '/saved/research', keep_raw: true, worker_model: 'suggested-model', worker_effort: 'medium', exa_enabled: true, tikhub_reddit_worker_model: 'source-specific' };
  const properties = {
    library: { type: 'string', title: 'Research library', minLength: 1, description: 'Changing the directory selects a library; it does not move research.' },
    keep_raw: { type: 'boolean', title: 'Retain original provider responses', description: 'Keep the evidence behind reports.' },
    worker_model: { type: 'string', title: 'Source worker model', description: 'Suggested model; the conversation may choose another.' },
    worker_effort: { type: 'string', title: 'Source worker effort', enum: ['low', 'medium', 'high'] },
    exa_enabled: { type: 'boolean', title: 'Enable Exa' },
    tikhub_reddit_worker_model: { type: 'string', title: 'TikHub Reddit worker' },
  };
  const app = {
    settings: { schema: { type: 'object', properties }, values, layout: [
      { title: 'Library', items: ['library', 'keep_raw'].map(property => ({ kind: 'property', property })) },
      { title: 'Source workers', items: ['worker_model', 'worker_effort'].map(property => ({ kind: 'property', property })) },
      { title: 'Sources', items: ['exa_enabled', 'tikhub_reddit_worker_model'].map(property => ({ kind: 'property', property })) },
    ] },
    snapshot: { library: '/saved/research', configPath: '/state/config.toml', libraryFolder: 'folder' },
    saveSetting: async (key, value) => { calls.push([key, value]); return { ...values, [key]: value }; },
  };
  return { app, host: { preview: false }, calls };
}
async function mount(t, props) {
  document.body.replaceChildren();
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  const render = async next => { await React.act(async () => root.render(React.createElement(SettingsPage, next))); await settle(); };
  await render(props);
  t.after(async () => { await React.act(async () => root.unmount()); });
  return { render, element };
}

test('settings presents current operating preferences and only global schema controls through the existing authority', async t => {
  const { app, host, calls } = fixture();
  const ui = await mount(t, { app, host, hidden: false });
  assert.match(ui.element.querySelector('.settings-state').textContent, /Originals retained/);
  assert.match(ui.element.querySelector('.settings-state').textContent, /suggested-model/);
  assert.match(ui.element.querySelector('.settings-state').textContent, /conversation may choose another/);
  assert.equal(ui.element.querySelectorAll('.settings-groups > [data-slot=frame]').length, 2);
  assert.ok($('setting-library').closest('.source-control-row'));
  assert.equal($('setting-exa_enabled'), null);
  assert.equal($('setting-tikhub_reddit_worker_model'), null);
  assert.equal($('config-path').textContent, '/state/config.toml');
  assert.deepEqual(calls, []);
  await React.act(async () => $('setting-keep_raw').click()); await settle();
  assert.deepEqual(calls, [['keep_raw', false]]);
});

test('folder warnings and in-progress drafts survive hidden navigation and external settings refresh', async t => {
  const { app, host, calls } = fixture();
  const ui = await mount(t, { app: { ...app, snapshot: { ...app.snapshot, libraryFolder: 'missing' } }, host, hidden: false });
  const field = $('setting-library');
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(field, '/my/new/draft');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.match($('setting-library-note').textContent, /does not exist yet/);
  const changed = { ...app, snapshot: { ...app.snapshot, libraryFolder: 'not-folder' }, settings: { ...app.settings, values: { ...app.settings.values, library: '/external' } } };
  await ui.render({ app: changed, host, hidden: true }); await ui.render({ app: changed, host, hidden: false });
  assert.equal($('setting-library'), field);
  assert.equal(field.value, '/my/new/draft');
  assert.match($('setting-library-note').textContent, /not a folder/);
  assert.deepEqual(calls, []);
});

test('preview remains read-only and unavailable schema is disclosed', async t => {
  const { app } = fixture();
  const ui = await mount(t, { app, host: { preview: true }, hidden: false });
  assert.equal($('setting-library').disabled, true);
  assert.equal($('setting-keep_raw').disabled, true);
  assert.match($('settings-status').textContent, /read-only/);
  await ui.render({ app: { ...app, settings: { values: {} } }, host: { preview: true }, hidden: false });
  assert.match($('settings-status').textContent, /without their schema/);
  assert.equal($('setting-library'), null);
});
