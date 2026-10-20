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
const { SourceSetting, AccountsPanel } = await import('../src/frontend/library/source-controls.tsx');
const $ = id => document.getElementById(id);
const deferred = () => { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const settle = async () => React.act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
const click = async element => { assert.ok(element); await React.act(async () => element.click()); await settle(); };
async function type(element, value) {
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function commit(element) {
  await React.act(async () => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle();
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
const textProps = { settingKey: 'worker_model', schema: { type: 'string', title: 'Worker model', minLength: 1 }, value: 'initial' };

test('text typing waits for commit and newer drafts survive a completed save and external polling', async t => {
  const blocked = deferred(); const calls = [];
  const save = (key, value) => { calls.push([key, value]); return blocked.promise; };
  const ui = await mount(t, SourceSetting, { ...textProps, save });
  const input = $('setting-worker_model');
  await type(input, 'submitted');
  assert.equal(calls.length, 0);
  await commit(input);
  assert.deepEqual(calls, [['worker_model', 'submitted']]);
  await type(input, 'newer unfinished draft');
  await ui.render({ ...textProps, value: 'external', save });
  assert.equal(input.value, 'newer unfinished draft');
  await React.act(async () => blocked.resolve({ worker_model: 'submitted' })); await settle();
  assert.equal(input.value, 'newer unfinished draft');
  await ui.render({ ...textProps, value: 'another external value', save });
  assert.equal(input.value, 'newer unfinished draft');
  assert.match(ui.element.textContent, /Saved/);
});

test('rapid switch changes are queued in order and the latest failure rolls back to the last saved value', async t => {
  const first = deferred(); const second = deferred(); const calls = [];
  const save = (key, value) => { calls.push([key, value]); return calls.length === 1 ? first.promise : second.promise; };
  const ui = await mount(t, SourceSetting, { settingKey: 'exa_enabled', schema: { type: 'boolean' }, value: false, save, switchLabel: 'Turn Exa on or off' });
  const toggle = $('setting-exa_enabled');
  await click(toggle);
  await click(toggle);
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.deepEqual(calls, [['exa_enabled', true]], 'the second change waits for the first');
  await React.act(async () => first.resolve({ exa_enabled: true })); await settle();
  assert.deepEqual(calls, [['exa_enabled', true], ['exa_enabled', false]]);
  await React.act(async () => second.reject(new Error('fixture refusal'))); await settle();
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.match(ui.element.textContent, /Not saved: fixture refusal/);
});

test('a failed committed value restores saved text but never replaces newer typing', async t => {
  const calls = []; let pending = deferred();
  const save = (key, value) => { calls.push([key, value]); return pending.promise; };
  const ui = await mount(t, SourceSetting, { ...textProps, save });
  const input = $('setting-worker_model');
  await type(input, 'bad'); await commit(input);
  await React.act(async () => pending.reject(new Error('nope'))); await settle();
  assert.equal(input.value, 'initial');
  pending = deferred();
  await type(input, 'also bad'); await commit(input); await type(input, 'keep typing');
  await React.act(async () => pending.reject(new Error('again'))); await settle();
  assert.equal(input.value, 'keep typing');
  assert.match(ui.element.textContent, /Not saved: again/);
});

test('invalid numeric and empty values do not save; browser-preview controls are disabled', async t => {
  const calls = [];
  const save = async (key, value) => { calls.push([key, value]); return { [key]: value }; };
  const ui = await mount(t, SourceSetting, { settingKey: 'limit', schema: { type: 'integer', title: 'Limit', minimum: 1, maximum: 9 }, value: 3, save });
  const input = $('setting-limit');
  await type(input, '10'); await commit(input);
  assert.equal(calls.length, 0); assert.equal(input.getAttribute('aria-invalid'), 'true');
  await type(input, '5'); await commit(input);
  assert.deepEqual(calls, [['limit', 5]]);
  await ui.render({ ...textProps, save });
  await type($('setting-worker_model'), '   '); await commit($('setting-worker_model'));
  assert.equal(calls.length, 1);
  assert.equal($('setting-worker_model').getAttribute('aria-invalid'), 'true');
  await ui.render(textProps);
  assert.equal($('setting-worker_model').disabled, true);
});

test('Base UI select commits a selected option once with an accessible field name', async t => {
  const calls = [];
  const save = async (key, value) => { calls.push([key, value]); return { [key]: value }; };
  await mount(t, SourceSetting, { settingKey: 'worker_effort', schema: { type: 'string', title: 'Worker effort', enum: ['low', 'medium', 'high'] }, value: 'medium', label: 'Effort', save });
  const trigger = $('setting-worker_effort');
  assert.equal(trigger.getAttribute('aria-label'), 'Worker effort');
  await click(trigger);
  const option = [...document.querySelectorAll('[role=option]')].find(element => element.textContent === 'high');
  await click(option);
  assert.deepEqual(calls, [['worker_effort', 'high']]);
  assert.match(trigger.textContent, /high/);
});

test('accounts count aliases and required groups without rendering credential values; directory state survives updates', async t => {
  const sources = [
    { label: 'YouTube', credentials: [{ name: 'GOOGLE_API_KEY', available: true, required: false, value: 'NEVER_RENDER_SECRET' }], prerequisites: [{ name: 'yt-dlp', available: true }] },
    { label: 'DataForSEO', credentials: [{ name: 'DATAFORSEO_USERNAME', available: true, required: true }, { name: 'DATAFORSEO_PASSWORD', available: false, required: true }], prerequisites: [{ name: 'yt-dlp', available: true }] },
  ];
  const ui = await mount(t, AccountsPanel, { sources, keysPath: '/state/keys.env', preview: true });
  const disclosure = ui.element.querySelector('.source-accounts-trigger');
  await click(disclosure);
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
  assert.equal($('edit-keys').disabled, true);
  assert.doesNotMatch(ui.element.textContent, /NEVER_RENDER_SECRET/);
  assert.match(ui.element.querySelector('[data-account=dataforseo]').textContent, /partly set/);
  assert.match(ui.element.querySelector('[data-account=google-gemini]').textContent, /set/);
  assert.equal(ui.element.querySelectorAll('.source-local-tools li').length, 1);
  await ui.render({ sources: sources.map(source => ({ ...source })), keysPath: '/state/keys.env', preview: true });
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
  assert.match(ui.element.textContent, /Presence|present/);
});
