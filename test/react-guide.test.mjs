import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://dig.test/' });
globalThis.self = window;
for (const name of ['window', 'document', 'location', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'ResizeObserver', 'getComputedStyle']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : name === 'getComputedStyle' ? window[name].bind(window) : window[name] });
}
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { GuidePage } = await import('../src/frontend/library/guide.tsx');
const { MODULES } = await import('../src/providers/modules.ts');
const settle = async () => React.act(async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
const button = name => [...document.querySelectorAll('button')].find(element => element.textContent === name);
const click = async element => { assert.ok(element, 'button exists'); await React.act(async () => element.click()); await settle(); };

async function mount(t, { hidden = false } = {}) {
  document.body.replaceChildren();
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  const navigation = []; const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { requests.push(args); throw new Error('The guide must not request research or data.'); };
  const onNavigate = path => navigation.push(path);
  const render = async next => { await React.act(async () => root.render(React.createElement(GuidePage, { hidden, onNavigate, ...next }))); await settle(); };
  await render({});
  t.after(async () => {
    await React.act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  });
  return { element, navigation, requests, render };
}

test('Start here renders real ReUI components and a plain-language path without starting work', async t => {
  const ui = await mount(t);
  assert.equal(document.getElementById('guide').hidden, false);
  assert.equal(document.activeElement, document.getElementById('guide-title'));
  assert.equal(document.querySelectorAll('.guide-use-case').length, 8);
  assert.ok(document.querySelectorAll('[data-slot="frame"]').length >= 12);
  assert.ok(document.querySelectorAll('[data-slot="icon-tile"]').length >= 8);
  assert.equal(document.querySelectorAll('.guide-workflow [data-slot="timeline-item"]').length, 4);
  assert.equal(document.querySelectorAll('img,input,textarea,iframe,script').length, 0);
  assert.match(ui.element.textContent, /When original-response retention is on and saving succeeds/);
  assert.match(ui.element.textContent, /One use may make several provider requests/);
  assert.match(ui.element.textContent, /Unknown never means free/);
  assert.match(ui.element.textContent, /selected question, search terms, excerpts, URLs, or media/);
  assert.match(document.querySelector('.guide-role-note').textContent, /Your assistant reads the detailed reports and original evidence/);
  assert.match(document.querySelector('.guide-start-steps').textContent, /Ask what matters to you.*Observe what is recorded.*Steer the next step/);
  assert.deepEqual(ui.navigation, []);
  assert.deepEqual(ui.requests, []);
});

test('guide actions only request the existing local pages', async t => {
  const ui = await mount(t);
  await click(button('Open overview'));
  await click(button('Choose sources & tools'));
  await click(button('Library settings'));
  await click(button('About this installation'));
  assert.deepEqual(ui.navigation, ['/library', '/sources', '/settings', '/about']);
  assert.deepEqual(ui.requests, []);
});

test('examples copy only their text and provide a selectable fallback without sending anything', async t => {
  const copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => copied.push(text) } });
  const ui = await mount(t);
  const copy = document.querySelector('[aria-label="Copy example: A first question"]');
  await click(copy);
  assert.equal(copied.length, 1);
  assert.match(copied[0], /^Use Dig and Hacker News/);
  assert.match(copy.closest('.guide-prompt').textContent, /Copied\. Paste it into the conversation/);
  assert.deepEqual(ui.navigation, []);
  assert.deepEqual(ui.requests, []);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  await click(copy);
  assert.match(copy.closest('.guide-prompt').textContent, /Select the example text and copy it/);
  assert.equal(copy.closest('.guide-prompt').querySelector('.guide-prompt-text').textContent, copied[0]);
  assert.deepEqual(ui.navigation, []);
  assert.deepEqual(ui.requests, []);
});

test('the expanded directory represents every catalog source and helper, including edition add-ons', async t => {
  const ui = await mount(t);
  const trigger = [...document.querySelectorAll('button')].find(element => element.textContent.startsWith('Every source and tool'));
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  await click(trigger);
  const represented = [...document.querySelectorAll('[data-guide-source]')].map(element => element.getAttribute('data-guide-source'));
  assert.deepEqual(represented.sort(), MODULES.map(module => module.id).sort());
  for (const module of MODULES) {
    const entry = document.querySelector(`[data-guide-source="${module.id}"]`);
    assert.match(entry.textContent, new RegExp(module.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(entry.textContent.includes(module.description));
    if (module.kind === 'tool') assert.match(entry.textContent, /Optional helper/);
    if (module.extends) assert.ok(entry.closest(`[data-guide-source="${module.extends}"]`));
  }
  await click(button('See setup and availability'));
  assert.deepEqual(ui.navigation, ['/sources']);
  assert.deepEqual(ui.requests, []);
});

test('guide refreshes preserve disclosure state and focus; entering the tab focuses its heading', async t => {
  const ui = await mount(t, { hidden: true });
  assert.equal(document.getElementById('guide').hidden, true);
  await ui.render({ hidden: false });
  assert.equal(document.activeElement, document.getElementById('guide-title'));
  const trigger = [...document.querySelectorAll('button')].find(element => element.textContent.startsWith('Every source and tool'));
  await click(trigger); trigger.focus();
  await ui.render({ hidden: false });
  assert.equal(document.activeElement, trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  await ui.render({ hidden: true }); await ui.render({ hidden: false });
  assert.equal(document.activeElement, document.getElementById('guide-title'));
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(ui.requests, []);
});

test('the illustrative walkthrough switches evidence views locally and keeps the question and finding in view', async t => {
  const ui = await mount(t);
  const example = document.querySelector('.guide-worked');
  const capabilities = document.querySelector('[aria-labelledby="guide-capabilities"]');
  assert.ok(example.compareDocumentPosition(capabilities) & Node.DOCUMENT_POSITION_FOLLOWING, 'inspection example precedes the long capability catalog');
  assert.match(example.textContent, /Illustrative example/);
  assert.match(example.textContent, /Made-up product and documentation for learning; no research was run/);
  const question = example.querySelector('.guide-worked-question');
  const finding = example.querySelector('.guide-worked-finding');
  const tabs = [...example.querySelectorAll('[role="tab"]')];
  assert.deepEqual(tabs.map(tab => tab.textContent), ['Finding', 'Supporting passage', 'Original response']);
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  assert.match(example.querySelector('[role="tabpanel"]').textContent, /does not establish sync reliability or how conflicting edits are handled/);
  await click(tabs[1]);
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(example.querySelector('blockquote').textContent, 'You can create and edit notes offline. Changes sync when you reconnect.');
  await click(tabs[2]);
  assert.equal(tabs[2].getAttribute('aria-selected'), 'true');
  assert.deepEqual(JSON.parse(example.querySelector('pre').textContent), { illustrative: true, product: 'Sample Notebook', document: 'Offline editing', text: 'You can create and edit notes offline. Changes sync when you reconnect.' });
  assert.equal(example.querySelector('.guide-worked-question'), question);
  assert.equal(example.querySelector('.guide-worked-finding'), finding);
  assert.match(question.textContent, /Can I edit notes without internet\?/);
  assert.match(finding.textContent, /Offline editing appears supported/);
  assert.equal(example.querySelectorAll('a').length, 0);
  assert.deepEqual(ui.navigation, []);
  assert.deepEqual(ui.requests, []);
});
