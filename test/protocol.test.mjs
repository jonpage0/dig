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

test('rich research cards expose read-only validated presentation without creating a second record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dig-native-presentation-'));
  const { client } = await startServer(root);
  try {
    const saved = await client.callTool({ name: 'research_save', arguments: { project: root, source: 'hackernews', content: report, question: 'A retained question' } });
    assert.notEqual(saved.isError, true);
    const file = saved.structuredContent.file;
    const before = (await client.callTool({ name: 'library_revision', arguments: {} })).structuredContent.revision;
    const result = await client.callTool({ name: 'show_research', arguments: { file, insights: [{ title: 'One bounded finding', statement: '<script>source text remains text</script>', details: [{ label: 'Observed', value: 'One small sample' }], evidence: [file], limits: ['Not representative'], nextStep: { label: 'Draft follow-up', prompt: 'Read the retained report before extending this finding.' } }] } });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.card.insights[0].statement, '<script>source text remains text</script>');
    assert.equal(result.structuredContent.card.cost.totalCalls, 0);
    assert.equal(result.structuredContent.card.cost.scope, 'report');
    assert.equal(result.structuredContent.card.insights[0].evidence[0].file, file);
    assert.equal((await client.callTool({ name: 'library_revision', arguments: {} })).structuredContent.revision, before);
    const tool = (await client.listTools()).tools.find(t => t.name === 'show_research');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.ok(tool.outputSchema.properties.card);
    assert.match(tool._meta.ui.resourceUri, /ui:\/\/dig\/saved\/v/);
    const refused = await client.callTool({ name: 'show_research', arguments: { file, insights: [{ title: 'Unsafe link', statement: 'Example', details: [{ label: 'Bad', value: 'Bad', url: 'javascript:alert(1)' }], evidence: [file] }] } });
    assert.equal(refused.isError, true);
  } finally { await client.close(); }
});

test('optional evidence ranking uses native key authority, redacts outbound state and retains a shared-tool receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dig-native-evidence-'));
  const secret = 'typesafe-protocol-synthetic-key';
  const { client } = await startServer(root, { TYPESAFE_API_KEY: secret });
  try {
    assert.equal((await client.listTools()).tools.some(t => t.name === 'evidence_rank'), false);
    await client.callTool({ name: 'settings.update', arguments: { set: { evidence_enabled: true } } });
    const copied = await client.callTool({ name: 'use_environment_keys', arguments: { source: 'evidence' } });
    assert.deepEqual(copied.structuredContent.copied, ['TYPESAFE_API_KEY']);
    const result = await client.callTool({ name: 'evidence_rank', arguments: { project: root, question: 'Which excerpt helps?', candidates: [{ id: 'a', text: `Public test excerpt with an accidental known credential ${secret}`, reference: 'https://example.test/original' }] } });
    assert.equal(result.structuredContent.status, 'success');
    assert.equal(result.structuredContent.cost, null);
    assert.equal(result.structuredContent.call.source, 'evidence');
    assert.deepEqual(result.structuredContent.suggestedOrder, ['a']);
    assert.equal(result.structuredContent.candidates[0].reference, 'https://example.test/original');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    const tools = (await client.listTools()).tools;
    assert.ok(!tools.find(t => t.name === 'research_save').inputSchema.properties.source.enum.includes('evidence'));
    await client.callTool({ name: 'settings.update', arguments: { set: { evidence_enabled: false } } });
    assert.equal((await client.listTools()).tools.some(t => t.name === 'evidence_rank'), false);
    const unavailable = await client.callTool({ name: 'evidence_rank', arguments: { project: root, question: 'Test', candidates: [{id:'a',text:'Test'}] } });
    assert.equal(unavailable.isError, true);
    const library = (await client.callTool({ name: 'library_list', arguments: { project: root } })).structuredContent;
    assert.ok(library.live.some(c => c.source === 'evidence'), 'Disabling the helper preserves its earlier receipt');
  } finally { await client.close(); }
});

test('video utility discovery follows its switch and offers helper guidance without a research report method', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dig-native-video-catalog-'));
  const { client, isolated } = await startServer(root);
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.some(tool => tool.name === 'video_analyze'), false);
    assert.ok(!tools.find(tool => tool.name === 'research_save').inputSchema.properties.source.enum.includes('video'));
    assert.ok(!tools.find(tool => tool.name === 'dig_start').inputSchema.properties.planned.items.enum.includes('video-analyze'));
    const info = (await client.callTool({ name: 'source_info', arguments: { source: 'video' } })).structuredContent.sources[0];
    assert.equal(info.kind, 'tool');
    assert.deepEqual(info.methods, []);
    assert.equal(info.helperSkillPath, join(await realpath(isolated), 'skills/video-analyze/SKILL.md'));
    assert.match(await readFile(info.helperSkillPath, 'utf8'), /video_analyze/);
    const enabled = await client.callTool({ name: 'settings.update', arguments: { set: { video_enabled: true } } });
    assert.notEqual(enabled.isError, true);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'video_analyze'));
    const snapshot = (await client.callTool({ name: 'library_snapshot', arguments: {} })).structuredContent;
    assert.equal(snapshot.sources.find(source => source.id === 'video').kind, 'tool');
    assert.deepEqual(snapshot.enabledSources, ['hackernews', 'video']);
    const refused = await client.callTool({ name: 'research_save', arguments: { project: root, source: 'video', question: 'A utility is not a report source', content: report } });
    assert.equal(refused.isError, true);
    await client.callTool({ name: 'settings.update', arguments: { set: { video_enabled: false } } });
    assert.equal((await client.listTools()).tools.some(tool => tool.name === 'video_analyze'), false);
    const disabled = await client.callTool({ name: 'video_analyze', arguments: { project: root, video: 'https://example.invalid/video.mp4', question: 'Describe the scene.' } });
    assert.equal(disabled.isError, true);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('YouTube Gemini tools use the source switch, retain unknown-cost receipts and save a full video-method report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dig-native-youtube-analysis-'));
  await mkdir(join(root, 'state'));
  await writeFile(join(root, 'state/keys.env'), 'GEMINI_API_KEY=gemini-protocol-synthetic-value\n', { mode: 0o600 });
  const { client, isolated } = await startServer(root);
  const call = (name, args) => client.callTool({ name, arguments: args, _meta: { threadId: 'youtube-protocol-worker' } });
  try {
    const initialTools = (await client.listTools()).tools;
    assert.ok(!initialTools.some(tool => tool.name === 'youtube_analyze'));
    assert.ok(initialTools.find(tool => tool.name === 'dig_start').inputSchema.properties.planned.items.enum.includes('youtube-video'));
    await call('settings.update', { set: { youtube_enabled: true } });
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some(tool => tool.name === 'youtube_analyze'));
    assert.ok(tools.some(tool => tool.name === 'youtube_analysis_status'));
    assert.ok(!tools.some(tool => tool.name === 'video_analyze'), 'The separate Glimpse switch does not change');
    const source = (await call('source_info', { source: 'youtube' })).structuredContent.sources[0];
    assert.deepEqual(source.credentials.find(credential => credential.name === 'GEMINI_API_KEY'), { name: 'GEMINI_API_KEY', available: true, required: false, environment: 'absent' });
    const method = source.methods.find(method => method.name === 'youtube-video');
    assert.equal(method.helper, false);
    assert.ok(method.skillPath.startsWith(await realpath(isolated)));
    assert.match(await readFile(method.skillPath, 'utf8'), /agent: "youtube-video"/);
    const invalid = await call('youtube_analyze', { project: root, question: 'Invalid provider model', videos: [{ url: 'aB_cD-eF123' }], model: 'wrong-model' });
    assert.equal(invalid.isError, true);
    assert.equal(Object.hasOwn(tools.find(tool => tool.name === 'youtube_analyze').inputSchema.properties, 'codeExecution'), false);
    const unsupported = await call('youtube_analyze', { project: root, question: 'Unsupported code tool', videos: [{ url: 'aB_cD-eF123' }], codeExecution: true });
    assert.equal(unsupported.isError, true, 'The public tool refuses code execution for YouTube inputs');
    const analysis = (await call('youtube_analyze', { project: root, question: 'What closes?', videos: [{ url: 'aB_cD-eF123', startSeconds: 2, endSeconds: 20, fps: 2 }] })).structuredContent;
    assert.equal(analysis.status, 'success');
    assert.equal(analysis.dig, undefined, 'Direct analysis needs no pre-created dig');
    assert.equal(analysis.call.source, 'youtube');
    assert.equal(analysis.call.tool, 'youtube_analyze');
    assert.equal(analysis.call.cost, null);
    assert.equal(analysis.call.knownCost, undefined);
    assert.doesNotMatch(JSON.stringify(analysis), /gemini-protocol-synthetic-value/);
    const checked = (await call('youtube_analysis_status', { project: root, interactionId: analysis.interactionId })).structuredContent;
    assert.equal(checked.status, 'success');
    assert.deepEqual(checked.usage, analysis.usage, 'Status usage is the same cumulative observation');
    assert.equal(checked.call.cost, null);
    const saved = (await call('research_save', { project: root, source: 'youtube', agent: 'youtube-video', question: 'What closes?', content: report.replace('hackernews', 'youtube') })).structuredContent;
    assert.equal(saved.report, 'youtube-video.md');
    const listing = (await call('library_list', { project: root, source: 'youtube' })).structuredContent;
    assert.equal(listing.items.length, 1);
    assert.equal(listing.items[0].calls.length, 2);
    assert.ok(listing.items[0].calls.every(receipt => receipt.claimedBy.endsWith('/youtube-video.md')));
    const raw = (await call('library_read', { file: listing.items[0].calls[0].rawFile })).structuredContent.text;
    assert.match(raw, /At 00:10 the door closes/);
    assert.doesNotMatch(raw, /gemini-protocol-synthetic-value/);
    await call('settings.update', { set: { youtube_enabled: false } });
    assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'youtube_analyze'));
    assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'youtube_analysis_status'));
    assert.match((await call('library_read', { file: saved.file })).structuredContent.text, /agent: youtube-video/);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
    assert.deepEqual(views, [`ui://dig/library/v${VERSION}.html`, `ui://dig/saved/v${VERSION}.html`, `ui://dig/trail/v${VERSION}.html`]);
    for (const tool of tools.filter(t => t._meta?.ui?.resourceUri)) assert.ok(views.includes(tool._meta.ui.resourceUri), `${tool.name} names a listed view`);
    const trailResource = await client.readResource({ uri: trail._meta.ui.resourceUri });
    assert.equal(trailResource.contents[0]._meta['openai/ui'].preferredDisplayMode, 'inline');
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
    assert.deepEqual([card.kind, card.label, card.title, card.retrievals], ['report', 'Hacker News report', 'Explicit test identity', 5]);
    assert.equal(card.path, saved.structuredContent.path);
    assert.equal(new URL(new URL(card.link).searchParams.get('path'), 'https://dig.invalid').searchParams.get('file'), card.path, 'Cards pin report links to their originating library');
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
