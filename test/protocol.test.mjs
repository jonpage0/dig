import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, cp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { report } from './report-fixture.mjs';
import TOML from '@iarna/toml';
import { VERSION } from '../src/version.mjs';

// The built bundle, copied into Codex's cache layout (<cache>/<marketplace>/<plugin>/<version>), where the server
// learns its plugin identity for links. Only the isolated state directory, PATH and any given variables reach it.
async function startServer(root, environment = {}) {
  const isolated = join(root, 'plugins', 'cache', 'test-market', 'dig', '0.0.0'); await cp(resolve('plugin'), isolated, { recursive: true });
  const transport = new StdioClientTransport({ command: process.env.DIG_TEST_NODE || process.execPath, args: ['--import', resolve('test/mock-fetch.mjs'), join(isolated, 'dist/server.mjs')], cwd: isolated, env: { ...environment, DIG_STATE_DIR: join(root, 'state'), PATH: process.env.PATH }, stderr: 'pipe' });
  const client = new Client({ name: 'offline-proof', version: '1.0.0' });
  await client.connect(transport);
  return { client, isolated };
}
const eventually = async (read, expected, message) => {
  let value;
  for (let n = 0; n < 60; n++) { value = await read(); if (value === expected) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.equal(value, expected, message);
};

test('standalone bundle starts outside the repo, exposes native metadata, retains outcomes and reloads preferences', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dig-native-protocol-'));
  const { client, isolated } = await startServer(root);
  try {
    const tools = (await client.listTools()).tools;
    const open = tools.find(t => t.name === 'open_library');
    assert.deepEqual(open._meta['openai/ui'].entrypoints.map(e => e.type), ['global']);
    const trail = tools.find(t => t.name === 'open_trail');
    assert.notEqual(trail.title, open.title); assert.deepEqual(trail._meta['openai/ui'].entrypoints.map(e => e.type), ['thread']);
    assert.deepEqual(tools.find(t => t.name === 'library_revision')._meta.ui.visibility, ['app']);
    // Codex caches a view by its URI, so each version's views carry the version in their URIs, and every tool that
    // renders or serves a view names a view the server lists; a mismatch would leave that tool without a view.
    const views = (await client.listResources()).resources.map(r => r.uri).filter(uri => uri.startsWith('ui://')).sort();
    assert.deepEqual(views, [`ui://dig/library/v${VERSION}.html`, `ui://dig/saved/v${VERSION}.html`]);
    for (const tool of tools.filter(t => t._meta?.ui?.resourceUri)) assert.ok(views.includes(tool._meta.ui.resourceUri), `${tool.name} names a listed view`);
    const app = await client.readResource({ uri: open._meta.ui.resourceUri });
    assert.equal(app.contents[0].mimeType, 'text/html;profile=mcp-app');
    const source = (await client.callTool({ name: 'source_info', arguments: { source: 'hackernews' } })).structuredContent.sources[0];
    assert.ok(source.methods[0].skillPath.startsWith(await realpath(isolated)));
    const identity = (await client.callTool({ name: 'dig_start', arguments: { project: root, question: 'Explicit test identity' }, _meta: { threadId: 'thread:protocol' } })).structuredContent;
    assert.equal(identity.session, 'thread-protocol');
    for (const [query, expected] of [['sample', 'success'], ['empty', 'empty'], ['failure', 'failed'], ['malformed', 'failed']]) {
      const response = await client.callTool({ name: 'hackernews', arguments: { project: root, dig: identity.dig, query }, _meta: { threadId: 'thread:protocol', callId: `call-${query}` } });
      assert.equal(response.structuredContent.call.status, expected);
      assert.equal(response.structuredContent.call.id, `call-${query}`);
      assert.equal(response.isError === true, expected === 'failed');
      assert.deepEqual(response.structuredContent.call.cost, []);
      assert.equal(response.structuredContent.call.dig, identity.dig, 'The receipt names the dig the call named');
    }
    // The provider's results travel once, in structuredContent; content is a one-line summary.
    const sample = await client.callTool({ name: 'hackernews', arguments: { project: root, dig: identity.dig, query: 'sample' }, _meta: { threadId: 'thread:protocol' } });
    assert.match(sample.structuredContent.text, /Test source item/);
    assert.equal(sample.content.length, 1); assert.doesNotMatch(sample.content[0].text, /Test source item/);
    const before = (await client.callTool({ name: 'library_revision', arguments: {} })).structuredContent.revision;
    const saved = await client.callTool({ name: 'research_save', arguments: { project: root, dig: identity.dig, source: 'hackernews', content: report }, _meta: { threadId: 'thread:protocol' } });
    assert.notEqual((await client.callTool({ name: 'library_revision', arguments: {} })).structuredContent.revision, before);
    assert.match(saved.content[0].text, /Primary artifact:/);
    // The Open in Dig link reaches the reader's /read route with the library-relative file.
    const link = new URL(saved.structuredContent.link);
    assert.equal(`${link.protocol}//${link.host}${link.pathname}`, 'codex://plugins/dig@test-market/app/open_library');
    assert.equal(new URL(link.searchParams.get('path'), 'https://dig.invalid').searchParams.get('file'), saved.structuredContent.file);
    const card = (await client.callTool({ name: 'saved_research', arguments: { file: saved.structuredContent.file } })).structuredContent;
    assert.deepEqual([card.kind, card.label, card.title, card.retrievals, card.link], ['report', 'Hacker News report', 'Explicit test identity', 5, saved.structuredContent.link]);
    const panel = (await client.callTool({ name: 'open_trail', arguments: {}, _meta: { threadId: 'thread:protocol' } })).structuredContent;
    assert.deepEqual([panel.view, panel.thread, panel.items], ['panel', 'thread-protocol', undefined]);
    const unidentified = (await client.callTool({ name: 'open_trail', arguments: {}, _meta: { threadId: '::' } })).structuredContent;
    assert.equal(unidentified.thread, null);
    const listing = (await client.callTool({ name: 'library_list', arguments: {} })).structuredContent;
    assert.equal(listing.items[0].session, 'thread-protocol'); assert.equal(listing.items[0].calls.length, 5);
    const raw = await client.callTool({ name: 'library_read', arguments: { file: listing.items[0].calls[0].rawFile } });
    assert.match(raw.structuredContent.text, /Test source item/);
    const reportResource = await client.readResource({ uri: `dig://library/${encodeURIComponent(listing.items[0].reports[0])}` });
    assert.match(reportResource.contents[0].text, /A small inspected sample/);
    // Composer at-mentions return the saved report as a resource the host can read.
    const mentions = (await client.callTool({ name: 'search_mentions', arguments: { query: 'explicit hacker' } })).structuredContent.items;
    assert.deepEqual(mentions.map(m => m.uri), [`dig://library/${encodeURIComponent(listing.items[0].reports[0])}`]);
    assert.match((await client.readResource({ uri: mentions[0].uri })).contents[0].text, /A small inspected sample/);
    assert.deepEqual((await client.callTool({ name: 'search_mentions', arguments: { query: 'nothing matches this' } })).structuredContent.items, []);
    // The settings page's readiness button names a same-server tool that answers in plain text.
    const settingsPage = (await client.callTool({ name: 'settings.read', arguments: {} })).structuredContent;
    const action = settingsPage.layout.flatMap(group => group.items).find(item => item.kind === 'tool');
    assert.ok(tools.some(t => t.name === action.tool));
    assert.match((await client.callTool({ name: action.tool, arguments: {} })).content[0].text, /Ready: Hacker News/);
    const preference = await client.callTool({ name: 'settings.update', arguments: { set: { hackernews_enabled: false, keep_raw: false } } });
    assert.notEqual(preference.isError, true);
    assert.equal((await client.listTools()).tools.some(t => t.name === 'hackernews'), false);
    const rejected = await client.callTool({ name: 'hackernews', arguments: { project: root, dig: identity.dig, query: 'sample' } });
    assert.equal(rejected.isError, true);
    const config = TOML.parse(await readFile(join(root, 'state/config.toml'), 'utf8'));
    assert.equal(config.keep_raw, false); assert.deepEqual(config.sources.enabled, []);
    await writeFile(join(root, 'state/config.toml'), TOML.stringify({ ...config, sources: { enabled: ['hackernews'] } }));
    let discovered = false;
    for (let n = 0; n < 60; n++) { discovered = (await client.listTools()).tools.some(t => t.name === 'hackernews'); if (discovered) break; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.equal(discovered, true, 'Hand-edited source enablement must update discovery');
    await writeFile(join(root, 'state/config.toml'), TOML.stringify(config));
    let hidden = false;
    for (let n = 0; n < 60; n++) { hidden = !(await client.listTools()).tools.some(t => t.name === 'hackernews'); if (hidden) break; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.equal(hidden, true, 'Hand-edited source disablement must update discovery');
  } finally { await client.close(); }
});

test('keys.env buttons are app-only, an exported key is used only once copied, and saved changes to keys.env or the Papers bridge’s .env apply without restarting Dig', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dig-native-keys-'));
  const { client } = await startServer(root, { EXA_API_KEY: 'exa-from-environment-value' });
  try {
    const tools = (await client.listTools()).tools;
    for (const name of ['prepare_keys_file', 'use_environment_keys']) assert.deepEqual(tools.find(t => t.name === name)._meta.ui.visibility, ['app']);
    const prepared = (await client.callTool({ name: 'prepare_keys_file', arguments: { source: 'exa' } })).structuredContent;
    assert.deepEqual([prepared.path, prepared.added, prepared.created], [join(root, 'state', 'keys.env'), ['EXA_API_KEY'], true]);
    const placeholder = await readFile(prepared.path, 'utf8');
    const exa = async () => { const c = (await client.callTool({ name: 'source_info', arguments: { source: 'exa' } })).structuredContent.sources[0].credentials[0]; return `${c.available}/${c.environment}`; };
    const revision = async () => (await client.callTool({ name: 'library_revision', arguments: {} })).structuredContent.revision;
    assert.equal(await exa(), 'false/unused', 'An exported key is not used until copied, and an empty NAME= line is not a credential');
    const before = await revision();
    await writeFile(prepared.path, placeholder.replace(/^EXA_API_KEY=$/m, 'EXA_API_KEY=exa-protocol-secret-value'));
    await eventually(exa, 'true/different', 'A saved value must load without a restart');
    assert.notEqual(await revision(), before, 'Readiness changes must refresh the open view');
    const again = await client.callTool({ name: 'prepare_keys_file', arguments: { source: 'exa' } });
    assert.deepEqual(again.structuredContent.added, []);
    const copied = await client.callTool({ name: 'use_environment_keys', arguments: { source: 'exa' } });
    assert.deepEqual(copied.structuredContent.copied, ['EXA_API_KEY']);
    assert.equal(await exa(), 'true/same');
    assert.doesNotMatch(JSON.stringify([again, copied]), /exa-protocol-secret-value|exa-from-environment-value/);
    await writeFile(prepared.path, placeholder);
    await eventually(exa, 'false/unused', 'A removed value must unload without a restart');
    // The Papers card says whether only the bridge's own .env holds the Unpaywall address, never the address, and a
    // change there refreshes the open view as a keys.env change does.
    const bridgeEnv = join(root, 'state', 'tools', 'paper-search-mcp', '.env');
    const papers = async () => (await client.callTool({ name: 'source_info', arguments: { source: 'papers' } })).structuredContent;
    const unset = await revision();
    await mkdir(dirname(bridgeEnv), { recursive: true }); await writeFile(bridgeEnv, 'PAPER_SEARCH_MCP_UNPAYWALL_EMAIL="reader@example.org"\n');
    const info = await papers();
    assert.equal(info.sources[0].envSettings[0].bridge, true); assert.doesNotMatch(JSON.stringify(info), /reader@example\.org/);
    const set = await revision();
    assert.notEqual(set, unset, 'Adding the address in the bridge’s .env must refresh the open Papers card');
    await rm(bridgeEnv);
    assert.notEqual(await revision(), set, 'Removing it must refresh the card too');
  } finally { await client.close(); }
});

// Codex's installer removes the old version's cache folder while the desktop keeps the old server running.
test('a later install that removes this version’s folder leaves the running server serving its views and naming the new version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dig-native-replaced-'));
  const { client, isolated } = await startServer(root);
  try {
    const snapshot = async () => (await client.callTool({ name: 'library_snapshot', arguments: {} })).structuredContent;
    const revision = async () => (await client.callTool({ name: 'library_revision', arguments: {} })).structuredContent.revision;
    const tools = (await client.listTools()).tools;
    const uris = ['open_library', 'research_save'].map(name => tools.find(t => t.name === name)._meta.ui.resourceUri);
    const views = async () => (await Promise.all(uris.map(uri => client.readResource({ uri })))).map(read => read.contents[0].text);
    const before = await views();
    assert.equal((await snapshot()).replaced, null);
    const fingerprint = await revision();
    await mkdir(join(isolated, '..', '0.0.1', '.codex-plugin'), { recursive: true });
    await rm(isolated, { recursive: true, force: true });
    assert.deepEqual(await views(), before, 'Both views are served from memory once the package folder is gone');
    assert.deepEqual((await snapshot()).replaced, { version: '0.0.1' });
    assert.notEqual(await revision(), fingerprint, 'An open view notices the replacement');
  } finally { await client.close(); }
});
