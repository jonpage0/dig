import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://dig.test/' });
globalThis.self = window;
for (const name of ['window', 'document', 'location', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'DocumentFragment', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'MutationObserver', 'ResizeObserver', 'getComputedStyle']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : name === 'getComputedStyle' ? window[name].bind(window) : window[name] });
}
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { ResearchSteering } = await import('../src/frontend/library/research-steering.tsx');
const item = id => ({ id, title: 'Question ' + id, project: '/project', reports: ['p/digs/' + id + '/exa.md'] });
const settle = async () => React.act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
const button = text => [...document.querySelectorAll('button')].find(element => element.textContent === text);
const click = async text => { const element = button(text); assert.ok(element, text); await React.act(async () => element.click()); await settle(); };
const deferred = () => { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
async function mount(t, props) {
  document.body.replaceChildren(); const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  const render = async next => { await React.act(async () => root.render(React.createElement(ResearchSteering, { ...props, ...next }))); await settle(); };
  await render({});
  t.after(async () => { await React.act(async () => root.unmount()); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
  return { render };
}

test('opening and choosing a direction is inert; only the explicit action requests an unsent draft', async t => {
  const drafted = []; const host = { preview: false, canDraft: () => true, draft: async prompt => drafted.push(prompt) };
  await mount(t, { host, item: item('A'), library: '/library' });
  await click('Steer research'); await click('Review gaps');
  assert.equal(drafted.length, 0);
  await click('Draft in conversation');
  assert.equal(drafted.length, 1);
  assert.match(drafted[0], /Review the reported limitations/);
  assert.match(drafted[0], /\/library\/p\/digs\/A\/exa.md/);
  assert.match(document.body.textContent, /unsent draft/);
});

test('late draft completion never confirms a different selected question', async t => {
  const waiting = deferred(); const drafted = [];
  const host = { preview: false, canDraft: () => true, draft: prompt => { drafted.push(prompt); return waiting.promise; } };
  const ui = await mount(t, { host, item: item('A'), library: '/library' });
  await click('Steer research'); await click('Draft in conversation');
  await ui.render({ item: item('B') }); await click('Steer research');
  await React.act(async () => waiting.resolve()); await settle();
  assert.match(document.querySelector('.research-steering-question').textContent, /Question B/);
  assert.doesNotMatch(document.body.textContent, /Placed in the conversation/);
  assert.match(drafted[0], /Question A/);
});

test('closing and reopening invalidates old feedback and snapshots the instruction references', async t => {
  const waiting = deferred();
  const host = { preview: false, canDraft: () => true, draft: () => waiting.promise };
  const ui = await mount(t, { host, item: item('A'), library: '/library' });
  await click('Steer research');
  await ui.render({ item: { ...item('A'), reports: ['p/digs/A/new-report.md'] } });
  assert.match(document.querySelector('.research-steering-context pre').textContent, /exa\.md/);
  assert.doesNotMatch(document.querySelector('.research-steering-context pre').textContent, /new-report/);
  await click('Draft in conversation'); await click('Close'); await click('Steer research');
  assert.match(document.querySelector('.research-steering-context pre').textContent, /new-report/);
  await React.act(async () => waiting.reject(new Error('Old request failed'))); await settle();
  assert.doesNotMatch(document.body.textContent, /Old request failed/);
});

test('preview copy fallback never calls the native host and a changed direction rejects a stale clipboard notice', async t => {
  const waiting = deferred(); let copied = ''; let drafts = 0;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: text => { copied = text; return waiting.promise; } } });
  await mount(t, { host: { preview: true, canDraft: () => false, draft: () => drafts++ }, item: item('A'), library: '/library' });
  await click('Steer research');
  assert.equal(button('Draft in conversation'), undefined);
  await click('Copy instruction'); await click('Refocus the question');
  await React.act(async () => waiting.resolve()); await settle();
  assert.doesNotMatch(document.body.textContent, /Copied\. Paste/);
  assert.match(copied, /recommend the next useful step/);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  await click('Copy instruction');
  assert.match(document.body.textContent, /Open Instruction and saved references/);
  assert.equal(drafts, 0);
});
