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

test('native link/file refusals stay explicit, and a host carries no reader link of its own', async () => {
  const { host, setContext, calls, app } = nativeFixture();
  await host.start();
  setContext({ 'openai/deepLink': { url: '/read?file=project%2Freport.md' } });
  assert.equal(host.readDeepLink(), null);
  await host.openFile('/library/report.md');
  assert.deepEqual(calls.at(-1), ['file', '/library/report.md']);
  await assert.rejects(() => host.openLink('javascript:alert(1)'), /cannot be opened/);
  await assert.rejects(() => host.openLink('codex://plugins/dig@dig/app/open_library'), /cannot be opened/);
  app.openLink = async () => ({ isError: true });
  await assert.rejects(() => host.openLink('https://example.com'), /did not open/);
  host.dispose();
});

test('the page the service serves in a browser calls /api with its cookie, opens links in a new tab and keeps reader links app-relative', async () => {
  window.location.href = 'http://127.0.0.1:47811/?dig=p%2Fd&path=%2Fread%3Ffile%3Done.md';
  const root = document.createElement('div'); root.id = 'root'; root.dataset.digBrowser = ''; root.dataset.digSurface = 'trail'; document.body.append(root);
  const originalFetch = globalThis.fetch; const originalOpen = window.open;
  const requests = []; const windows = [];
  let answer = { ok: true, json: async () => ({ content: [], structuredContent: { revision: 'r1' } }) };
  globalThis.fetch = async (...args) => { requests.push(args); return answer; };
  window.open = (...args) => { windows.push(args); return null; };
  const host = createDigHost('Browser');
  try {
    await host.start();
    assert.equal(host.browser, true);
    assert.equal(host.getContext().toolInfo.tool.name, 'open_trail');
    assert.equal(host.readDeepLink(), '/read?file=one.md');
    assert.deepEqual(await host.call('library_revision'), { revision: 'r1' });
    assert.equal(requests[0][0], '/api/library_revision'); assert.equal(requests[0][1].method, 'POST'); assert.equal(requests[0][1].credentials, 'same-origin');
    // The service's 401 says how to open Dig again, with its own command; without it, the view says to ask the assistant.
    answer = { ok: false, status: 401, json: async () => ({}), text: async () => 'To open Dig in a browser, ask the assistant to open Dig\'s library, or run this in a terminal: node /checkout/dist/dig.mjs open\n' };
    await assert.rejects(() => host.call('library_revision'), /This browser session has ended\. To open Dig in a browser, ask the assistant to open Dig's library, or run this in a terminal: node \/checkout\/dist\/dig\.mjs open$/);
    answer = { ok: false, status: 401, json: async () => ({}), text: async () => { throw new Error('no body'); } };
    await assert.rejects(() => host.call('library_revision'), /This browser session has ended\. Ask the assistant to open Dig's library again\.$/);
    answer = { ok: false, status: 400, json: async () => ({ isError: true, content: [{ type: 'text', text: 'Invalid arguments for saved_research: file: required' }] }) };
    await assert.rejects(() => host.call('saved_research', {}), /Invalid arguments for saved_research/);
    await host.openLink('http://127.0.0.1:47811/keys/one-time');
    assert.deepEqual(windows, [['http://127.0.0.1:47811/keys/one-time', '_blank', 'noopener,noreferrer']]);
    await assert.rejects(() => host.openLink('javascript:alert(1)'), /cannot be opened/);
    assert.equal(await host.requestDisplayMode('fullscreen'), null);
    assert.equal(host.canDraft(), false); assert.equal(host.canOpenFile(), false);
    await assert.rejects(() => host.openFile('/anything'), /not in the browser/);
  } finally {
    host.dispose(); root.remove(); globalThis.fetch = originalFetch; window.open = originalOpen; window.location.href = 'https://dig.test/';
  }
});


test('display mode uses the standard host capability and respects refused or unavailable modes', async () => {
  const { host, app, calls, setContext } = nativeFixture();
  await host.start();
  app.requestDisplayMode = async value => { calls.push(['display', value]); return { mode: value.mode }; };
  setContext({ displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] });
  assert.equal(await host.requestDisplayMode('fullscreen'), 'fullscreen');
  assert.deepEqual(calls.at(-1), ['display', { mode: 'fullscreen' }]);
  setContext({ displayMode: 'inline', availableDisplayModes: ['inline'] });
  const before = calls.length;
  assert.equal(await host.requestDisplayMode('fullscreen'), 'inline'); assert.equal(calls.length, before);
  setContext({ displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] });
  app.requestDisplayMode = async () => ({ mode: 'inline' });
  assert.equal(await host.requestDisplayMode('fullscreen'), 'inline', 'Host-selected mode is authoritative');
  app.requestDisplayMode = async () => { throw Error('Refused'); };
  await assert.rejects(host.requestDisplayMode('fullscreen'), /Refused/);
  host.dispose();
});
