import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createDigHost } from '../src/frontend/shared/host.ts';

const window = new Window({ url: 'https://dig.test/' });
for (const key of ['window', 'document', 'location']) Object.defineProperty(globalThis, key, { value: window[key] ?? window, configurable: true, writable: true });

function nativeFixture() {
  const events = new Map();
  const calls = [];
  let context = { theme: 'dark', styles: { variables: { '--font-sans': 'Host Sans', '--color-text-primary': '#ddd' } } };
  const app = {
    addEventListener(name, callback) { events.set(name, callback); },
    removeEventListener(name, callback) { if (events.get(name) === callback) events.delete(name); },
    async connect() { calls.push(['connect']); },
    async close() { calls.push(['close']); },
    getHostContext() { return context; },
    async callServerTool(value) { calls.push(['tool', value]); return { structuredContent: { ok: true } }; },
    async openLink(value) { calls.push(['link', value]); return {}; },
  };
  const extensions = {
    deepLink: { getCurrent() { return context['openai/deepLink']; } },
    files: { async open(path) { calls.push(['file', path]); return {}; } },
    message: { async send(value) { calls.push(['draft', value]); return {}; } },
  };
  const host = createDigHost('Foundation test', { appFactory: () => app, extensionsFactory: () => extensions });
  return { host, app, extensions, calls, events, setContext(value) { context = value; } };
}

test('native host routes tools through MCP, applies host tokens, delivers early results and cleans up', async () => {
  const fixture = nativeFixture();
  const { host, calls, events } = fixture;
  let result; let activation;
  host.subscribeResult(value => { result = value; });
  const unsubscribe = host.subscribeActivation(value => { activation = value; });
  await Promise.all([host.start(), host.start()]);
  assert.equal(calls.filter(([kind]) => kind === 'connect').length, 1);
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(document.documentElement.style.getPropertyValue('--font-sans'), 'Host Sans');
  assert.deepEqual(await host.call('library_snapshot'), { ok: true });
  assert.deepEqual(calls.at(-1), ['tool', { name: 'library_snapshot', arguments: {} }]);
  events.get('toolresult')({ structuredContent: { file: 'saved.md' } });
  assert.equal(result.structuredContent.file, 'saved.md');
  events.get('hostcontextchanged')({ theme: 'light' });
  assert.equal(activation.theme, 'light');
  unsubscribe();
  events.get('hostcontextchanged')({ theme: 'dark' });
  assert.equal(activation.theme, 'light');
  host.dispose();
  assert.equal(events.size, 0);
  assert.equal(host.canDraft(), false);
  await assert.rejects(() => host.call('library_snapshot'), /closed/);
});

test('composer integration submits only an editable unsent draft and surfaces refusal without retry', async () => {
  const { host, calls, extensions } = nativeFixture();
  await host.start();
  assert.equal(host.canDraft(), true);
  await host.draft('Discuss the retained evidence.');
  assert.deepEqual(calls.at(-1), ['draft', {
    role: 'user',
    content: [{ type: 'text', text: 'Discuss the retained evidence.' }],
    _meta: { 'openai/message': { target: 'active', send: false } },
  }]);
  let refused = 0;
  extensions.message.send = async value => { refused++; assert.equal(value._meta['openai/message'].send, false); return { isError: true, content: [{ type: 'text', text: 'Draft unsupported' }] }; };
  await assert.rejects(() => host.draft('Another draft'), /Draft unsupported/);
  assert.equal(refused, 1);
  delete extensions.message;
  assert.equal(host.canDraft(), false);
  await assert.rejects(() => host.draft('No capability'), /does not support/);
  host.dispose();
});

test('native link/file refusals stay explicit and deep links are app-relative', async () => {
  const { host, setContext, calls, app } = nativeFixture();
  await host.start();
  setContext({ 'openai/deepLink': { url: '/read?file=project%2Freport.md' } });
  assert.equal(host.readDeepLink(), '/read?file=project%2Freport.md');
  for (const url of ['//elsewhere.test/read', 'https://elsewhere.test/read', 'javascript:alert(1)', '/\\elsewhere.test/read']) {
    setContext({ 'openai/deepLink': { url } });
    assert.equal(host.readDeepLink(), null);
  }
  await host.openFile('/library/report.md');
  assert.deepEqual(calls.at(-1), ['file', '/library/report.md']);
  await assert.rejects(() => host.openLink('javascript:alert(1)'), /cannot be opened/);
  app.openLink = async () => ({ isError: true });
  await assert.rejects(() => host.openLink('https://example.com'), /did not open/);
  host.dispose();
});

test('browser preview is the only HTTP adapter and cannot draft or open native files', async () => {
  window.location.href = 'http://localhost:1234/?preview=1&path=%2Fread%3Ffile%3Done.md';
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (...args) => { requests.push(args); return { ok: true, json: async () => ({ structuredContent: { items: [] } }) }; };
  const host = createDigHost('Preview');
  try {
    await host.start();
    assert.equal(host.preview, true);
    assert.equal(host.readDeepLink(), '/read?file=one.md');
    assert.deepEqual(await host.call('library_snapshot'), { items: [] });
    assert.equal(requests[0][0], '/api/library_snapshot');
    assert.equal(host.canDraft(), false);
    await assert.rejects(() => host.draft('No automatic send'), /read-only browser preview/);
    await assert.rejects(() => host.openFile('/anything'), /read-only browser preview/);
  } finally {
    host.dispose(); globalThis.fetch = originalFetch; window.location.href = 'https://dig.test/';
  }
});
