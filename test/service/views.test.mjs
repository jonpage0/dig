// The views: as MCP Apps to a client that declares io.modelcontextprotocol/ui, absent for one that does not (but for
// open_library, which opens them in a browser), and in a browser through a one-time address, a session cookie and /api.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyHTTP } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { VERSION } from '../../src/version.mjs';
import { MODULES } from '../../src/providers/modules.ts';
import { report } from '../report-fixture.mjs';
import { DIG, cleanup, connectModern, run, startService, text, workspace } from './helpers.mjs';

const UI = 'io.modelcontextprotocol/ui';
const MIME = 'text/html;profile=mcp-app';
const URIS = [`ui://dig/library/v${VERSION}.html`, `ui://dig/trail/v${VERSION}.html`, `ui://dig/saved/v${VERSION}.html`];
const APP_ONLY = ['library_snapshot', 'library_revision', 'saved_research', 'view_settings', 'view_keys'];
const OPENERS = ['open_library', 'open_trail'];
const declaring = { capabilities: { extensions: { [UI]: { mimeTypes: [MIME] } } } };
const CONFIG = '[sources]\nenabled = ["hackernews", "exa"]\n';

async function connect(space, token, kind, ui) {
  if (kind === 'modern') return connectModern(space, token, ui ? declaring : {});
  const client = new LegacyClient({ name: 'dig-test-legacy', version: '1.0.0' }, ui ? declaring : {});
  await client.connect(new LegacyHTTP(space.url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
/** What a host gives the model: every listed tool but those whose view metadata limits them to the app. */
const modelTools = tools => tools.filter(tool => !tool._meta?.ui?.visibility || tool._meta.ui.visibility.includes('model'));
/** A page has no external resource: no script, stylesheet, font or image loaded from anywhere. */
const selfContained = html => !/<script[^>]+\bsrc=|<link[^>]+\bhref=|@import|url\(\s*["']?(?:https?:)?\/\//i.test(html);

for (const kind of ['modern', 'legacy']) {
  test(`[${kind}] a client that declares the UI extension lists and reads the three views, opens them, and calls the app-only tools the model never sees`, async () => {
    const space = await workspace(`views-${kind}`, { config: CONFIG });
    try {
      const service = await startService(space);
      const client = await connect(space, service.token, kind, true);
      assert.deepEqual(client.getServerCapabilities()?.extensions?.[UI], {});
      // The three ui:// resources are listed and read as self-contained MCP App pages.
      const listed = (await client.listResources()).resources.filter(resource => resource.uri.startsWith('ui://'));
      assert.deepEqual(listed.map(resource => resource.uri).sort(), [...URIS].sort());
      for (const uri of URIS) {
        const [page] = (await client.readResource({ uri })).contents;
        assert.equal(page.mimeType, MIME); assert.match(page.text, /<div id="root"/); assert.ok(selfContained(page.text), uri);
        assert.deepEqual(page._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
        assert.doesNotMatch(page.text, /data-dig-browser/);
      }
      assert.match((await client.readResource({ uri: URIS[1] })).contents[0].text, /<div id="root" data-dig-surface="trail">/);
      // open_library and open_trail are the model's; the view tools are listed for the host with visibility app only.
      const tools = (await client.listTools()).tools; const names = tools.map(tool => tool.name);
      for (const name of [...OPENERS, ...APP_ONLY]) assert.ok(names.includes(name), name);
      const model = modelTools(tools).map(tool => tool.name);
      for (const name of OPENERS) assert.ok(model.includes(name), name);
      for (const name of APP_ONLY) { assert.ok(!model.includes(name), name); assert.deepEqual(tools.find(tool => tool.name === name)._meta.ui.visibility, ['app']); }
      assert.deepEqual(tools.find(tool => tool.name === 'open_library')._meta['openai/ui'], { entrypoints: [{ type: 'global' }] });
      assert.deepEqual(tools.find(tool => tool.name === 'open_trail')._meta['openai/ui'], { entrypoints: [{ type: 'thread' }] });
      assert.equal(tools.find(tool => tool.name === 'research_save')._meta.ui.resourceUri, URIS[2]);
      assert.equal(tools.find(tool => tool.name === 'dig_finish')._meta.ui.resourceUri, URIS[2]);

      // A dig, a saved report and the views' data for them.
      const { dig } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: 'What do the views show?' } })).structuredContent;
      const opened = await client.callTool({ name: 'open_trail', arguments: { dig } });
      assert.deepEqual(opened.structuredContent, { view: 'panel', dig, library: join(space.state, 'library') });
      assert.equal((await client.callTool({ name: 'open_trail', arguments: { dig: 'nope' } })).isError, true);
      // open_library's result for a view client: the view it requested, and the command for a host that is given the views and shows none.
      const library = await client.callTool({ name: 'open_library', arguments: {} });
      assert.deepEqual(library.content, [{ type: 'text', text: `Requested the Dig library view. Where the host shows no view (Codex in a terminal), the person runs: node ${DIG} open` }]);
      assert.deepEqual(library.structuredContent, { view: 'library', dig: null, library: join(space.state, 'library') });
      const lister = tools.find(tool => tool.name === 'open_library');
      assert.deepEqual(lister._meta, { ui: { resourceUri: URIS[0] }, 'openai/ui': { entrypoints: [{ type: 'global' }] }, 'openai/iconStyle': 'monochrome', 'ui/resourceUri': URIS[0] });
      assert.deepEqual(Object.keys(lister.outputSchema.properties), ['view', 'dig', 'library']);
      assert.equal(lister.annotations.readOnlyHint, true);
      const saved = await client.callTool({ name: 'research_save', arguments: { dig, source: 'hackernews', content: report } });
      assert.notEqual(saved.isError, true, text(saved));
      const snapshot = (await client.callTool({ name: 'library_snapshot', arguments: {} })).structuredContent;
      assert.equal(snapshot.items.length, 1); assert.equal(snapshot.items[0].dig, dig);
      assert.deepEqual(snapshot.jobs, []); assert.equal('replaced' in snapshot, false); assert.equal(snapshot.version, VERSION);
      assert.match((await client.callTool({ name: 'library_revision', arguments: {} })).structuredContent.revision, /^[0-9a-f]{24}$/);
      const card = (await client.callTool({ name: 'saved_research', arguments: { file: saved.structuredContent.file } })).structuredContent;
      assert.equal(card.file, saved.structuredContent.file); assert.equal(card.kind, 'report'); assert.equal('link' in card, false);
      // Settings: the settings tool's values and checks, with the schema the pages draw from.
      const settings = (await client.callTool({ name: 'view_settings', arguments: {} })).structuredContent;
      assert.equal(settings.schema.properties.spend_ask_above_usd.type, 'number'); assert.equal(settings.values.spend_ask_above_usd, 0);
      assert.doesNotMatch(JSON.stringify(settings.schema), /Codex|ChatGPT|Claude|plugin/);
      assert.ok(settings.layout.every(group => group.items.every(item => item.kind === 'property')), 'every layout item is a settings field the pages can draw');
      assert.ok(settings.layout.find(group => group.title === 'Library').items.some(item => item.property === 'spend_ask_above_usd'));
      const changed = (await client.callTool({ name: 'view_settings', arguments: { set: { keep_raw: false } } })).structuredContent;
      assert.equal(changed.values.keep_raw, false);
      assert.equal((await client.callTool({ name: 'settings', arguments: {} })).structuredContent.values.keep_raw, false);
      assert.match(await readFile(join(space.state, 'config.toml'), 'utf8'), /keep_raw = false/);
      assert.equal((await client.callTool({ name: 'view_settings', arguments: { set: { keep_raw: 'yes' } } })).isError, true);
      // Keys: the key page's one-time address, which shows names and never a value.
      const keys = (await client.callTool({ name: 'view_keys', arguments: { source: 'exa' } })).structuredContent;
      assert.deepEqual(keys.names, ['EXA_API_KEY']); assert.match(keys.address, new RegExp(`^http://127\\.0\\.0\\.1:${space.port}/keys/[A-Za-z0-9_-]+$`));
      const page = await fetch(keys.address); assert.equal(page.status, 200); assert.match(await page.text(), /EXA_API_KEY/);
      await client.close();
    } finally { await cleanup(space); }
  });

  test(`[${kind}] a client that does not declare the UI extension sees no view, no view tool and no opener but open_library, which carries no view metadata`, async () => {
    const space = await workspace(`noviews-${kind}`, { config: CONFIG });
    try {
      const service = await startService(space);
      const client = await connect(space, service.token, kind, false);
      assert.deepEqual(client.getServerCapabilities()?.extensions?.[UI], {}, 'the service declares the extension either way');
      assert.deepEqual((await client.listResources()).resources.filter(resource => resource.uri.startsWith('ui://')), []);
      const tools = (await client.listTools()).tools; const names = tools.map(tool => tool.name);
      for (const name of ['open_trail', ...APP_ONLY]) assert.ok(!names.includes(name), name);
      const library = tools.find(tool => tool.name === 'open_library');
      assert.ok(library, 'open_library is listed to every client');
      assert.equal(library._meta, undefined);
      assert.deepEqual(Object.keys(library.outputSchema.properties), ['view', 'dig', 'library', 'opened', 'address', 'expiresAt']);
      assert.equal(library.annotations.readOnlyHint, true); assert.match(library.description, /never launches research/);
      assert.equal(tools.find(tool => tool.name === 'research_save')._meta?.ui, undefined);
      const call = await client.callTool({ name: 'library_snapshot', arguments: {} }).catch(error => ({ isError: true, content: [{ type: 'text', text: error.message }] }));
      assert.equal(call.isError, true); assert.match(text(call), /disabled|not found/i);
      await assert.rejects(() => client.readResource({ uri: URIS[0] }));
      await client.close();
    } finally { await cleanup(space); }
  });
}

test('a client that names itself as Codex gets the views without declaring the extension, as ChatGPT desktop renders them from tool metadata', async () => {
  const space = await workspace('views-codex', { config: CONFIG });
  try {
    const service = await startService(space);
    // A 2025-era handshake as Codex 0.167.2 sends it: no extensions in its capabilities.
    const headers = { authorization: `Bearer ${service.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const read = async response => { const body = await response.text(); const line = /^data: (.*)$/m.exec(body); return JSON.parse(line ? line[1] : body); };
    const hello = await fetch(space.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {}, url: {} } }, clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: '0.167.2' } } }) });
    const session = hello.headers.get('mcp-session-id'); assert.ok(session, 'a 2025-era session');
    await read(hello);
    const sessioned = { ...headers, 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' };
    await fetch(space.url, { method: 'POST', headers: sessioned, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    const tools = (await read(await fetch(space.url, { method: 'POST', headers: sessioned, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) }))).result.tools;
    const names = tools.map(tool => tool.name);
    for (const name of [...OPENERS, ...APP_ONLY]) assert.ok(names.includes(name), name);
    assert.equal(typeof tools.find(tool => tool.name === 'open_library')._meta?.ui?.resourceUri, 'string');
    await fetch(space.url, { method: 'DELETE', headers: sessioned });
  } finally { await cleanup(space); }
});

test('in a browser: no cookie is 401; the open command\'s one-time address sets the session cookie; the pages load; /api serves only the views\' tools to their own origin', async () => {
  const space = await workspace('browser', { config: CONFIG });
  const base = `http://127.0.0.1:${space.port}`;
  const api = (name, { cookie, origin = base, body = {}, type = 'application/json' } = {}) => fetch(`${base}/api/${name}`, { method: 'POST', headers: { 'content-type': type, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
  try {
    await startService(space);
    for (const path of ['/', '/trail', '/card']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 401, path); assert.equal(await response.text(), `To open Dig in a browser, ask the assistant to open Dig's library, or run this in a terminal: node ${DIG} open\n`);
    }
    assert.equal((await api('library_snapshot')).status, 401);
    assert.equal((await fetch(`${base}/open/not-a-code`, { redirect: 'manual' })).status, 403);

    const opened = await run(space, ['open', '--no-browser']);
    assert.equal(opened.code, 0, opened.stderr); assert.match(opened.stdout, /\nThis address works once; run this command again for another browser\.\n$/);
    const address = new RegExp(`(${base}/open/[A-Za-z0-9_-]+)`).exec(opened.stdout)?.[1];
    assert.ok(address, opened.stdout);
    const first = await fetch(address, { redirect: 'manual' });
    assert.equal(first.status, 303); assert.equal(first.headers.get('location'), '/');
    const setCookie = first.headers.get('set-cookie');
    assert.match(setCookie, /^dig_session=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/$/);
    const cookie = setCookie.split(';')[0];
    assert.equal((await fetch(address, { redirect: 'manual' })).status, 403, 'a used code is refused');

    const page = await fetch(`${base}/`, { headers: { cookie } });
    assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'.*connect-src 'self'/);
    const html = await page.text();
    assert.match(html, /<div id="root" data-dig-browser="">/); assert.ok(selfContained(html));
    assert.match(await (await fetch(`${base}/trail`, { headers: { cookie } })).text(), /<div id="root" data-dig-surface="trail" data-dig-browser="">/);
    assert.equal((await fetch(`${base}/card`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/`, { headers: { cookie: 'dig_session=forged' } })).status, 401);

    // The snapshot with the cookie, from the page's own origin; never from another origin or without one.
    const snapshot = await api('library_snapshot', { cookie });
    assert.equal(snapshot.status, 200);
    const value = (await snapshot.json()).structuredContent;
    assert.deepEqual(value.items, []); assert.equal(value.host, 'any'); assert.deepEqual(value.jobs, []);
    assert.equal((await api('library_snapshot', { cookie, origin: 'https://example.com' })).status, 403);
    assert.equal((await api('library_snapshot', { cookie, origin: `http://localhost:${space.port}` })).status, 403);
    assert.equal((await api('library_snapshot', { cookie, origin: null })).status, 403);
    assert.equal((await api('library_snapshot', { cookie, type: 'text/plain' })).status, 415);
    assert.equal((await fetch(`${base}/api/library_snapshot`, { headers: { cookie } })).status, 405);
    // Exactly the views' tools: no source tool, no action, no other core tool.
    for (const name of ['hackernews', 'exa', 'xsearch', 'exa_search', 'settings', 'keys', 'dig_start', 'research_save', 'job', 'constructor', '__proto__']) assert.equal((await api(name, { cookie, body: { dig: 'x', action: 'hackernews', args: {} } })).status, 404, name);
    assert.equal((await api('source_info', { cookie })).status, 200);
    const bad = await api('saved_research', { cookie, body: {} });
    assert.equal(bad.status, 400); assert.match(text(await bad.json()), /Invalid arguments for saved_research/);
    const set = await api('view_settings', { cookie, body: { set: { keep_raw: false } } });
    assert.equal((await set.json()).structuredContent.values.keep_raw, false);
    assert.match(await readFile(join(space.state, 'config.toml'), 'utf8'), /keep_raw = false/);
    const keys = (await (await api('view_keys', { cookie, body: { source: 'exa' } })).json()).structuredContent;
    assert.match(keys.address, new RegExp(`^${base}/keys/`));
    // MCP still takes the bearer token only, never the cookie.
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 401);
  } finally { await cleanup(space); }
});

test('with every source enabled, the tools/list a UI client receives, the app-only tools included, stays under 140,000 characters, and so does one without views, open_library included', async () => {
  const space = await workspace('views-size', { config: `[sources]\nenabled = ${JSON.stringify(MODULES.map(m => m.id))}\n` });
  try {
    const service = await startService(space);
    const client = await connectModern(space, service.token, declaring);
    const list = await client.listTools();
    assert.ok(list.tools.some(tool => tool.name === 'library_snapshot'));
    const size = JSON.stringify(list).length;
    console.log(`tools/list for a UI client with every source enabled: ${size} characters, ${list.tools.length} tools, ${modelTools(list.tools).length} for the model`);
    assert.ok(size < 140_000, `tools/list grew to ${size} characters`);
    await client.close();
    const plain = await connectModern(space, service.token, {});
    const without = await plain.listTools();
    assert.ok(without.tools.some(tool => tool.name === 'open_library')); assert.ok(!without.tools.some(tool => tool.name === 'library_snapshot'));
    const plainSize = JSON.stringify(without).length;
    console.log(`tools/list for a client without views with every source enabled: ${plainSize} characters, ${without.tools.length} tools`);
    assert.ok(plainSize < 140_000, `tools/list grew to ${plainSize} characters`);
    await plain.close();
  } finally { await cleanup(space); }
});
