import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { report } from './report-fixture.mjs';

test('the native boundary retains provider costs honestly and redacts credentials from results, receipts, raw bodies and saved reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dig-native-provider-'));
  const state = join(root, 'state'); await mkdir(state);
  const secret = 'native-test-secret-value';
  await writeFile(join(state, 'keys.env'), `XAI_API_KEY=${secret}\n`, { mode: 0o600 });
  await writeFile(join(state, 'config.toml'), '[sources]\nenabled = ["x"]\n[x]\ndepth = "max"\n');
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', resolve('test/provider-fetch.mjs'), resolve('plugin/dist/server.mjs')], cwd: root, env: { DIG_STATE_DIR: state, PATH: process.env.PATH }, stderr: 'pipe' });
  const client = new Client({ name: 'native-provider-proof', version: '1' });
  const call = async (name, args) => {
    const value = await client.callTool({ name, arguments: args, _meta: { threadId: 'source-worker' } });
    assert.notEqual(value.isError, true, JSON.stringify(value));
    assert.equal(JSON.stringify(value).includes(secret), false);
    return value;
  };
  try {
    await client.connect(transport);
    const source = (await call('source_info', { source: 'x' })).structuredContent.sources[0];
    assert.equal(source.credentials.find(c => c.name === 'XAI_API_KEY').available, true);
    const first = await call('xsearch', { project: root, query: `show-cost ${secret}` });
    assert.deepEqual(first.structuredContent.call.cost, [{ amount: 0.01234, unit: 'USD' }]);
    assert.equal(first.structuredContent.call.args.query, 'show-cost [redacted]');
    assert.match(first.structuredContent.text, /Returned evidence accidentally echoes \[redacted\]/);
    const unknown = await call('xsearch', { project: root, query: 'unknown-cost' });
    assert.equal(unknown.structuredContent.call.cost, null);
    const saved = await call('research_save', { project: root, source: 'x', agent: 'x-breadth', question: 'Direct-source retention', content: report.replace('source: "hackernews"', 'source: "x"') + `\nAccidental credential: ${secret}\n` });
    const listing = (await call('library_list', { project: root })).structuredContent;
    assert.equal(listing.items[0].mode, 'single');
    assert.deepEqual(listing.items[0].calls.map(c => c.cost), [[{ amount: 0.01234, unit: 'USD' }], null]);
    for (const file of [saved.structuredContent.path, ...listing.items[0].calls.map(c => c.rawFile)]) {
      const read = (await call('library_read', { file })).structuredContent;
      assert.equal(read.nextOffset, null);
      assert.match(read.text, /\[redacted\]/);
    }
    const disabled = await call('settings.update', { set: { x_enabled: false } });
    assert.equal(disabled.structuredContent.values.x_enabled, false);
    const refused = await client.callTool({ name: 'xsearch', arguments: { project: root, query: 'must not run' } });
    assert.equal(refused.isError, true);
    assert.equal((await call('library_list', { project: root })).structuredContent.items[0].calls.length, 2);
  } finally { await client.close(); }
});

test('the X API tools are listed under X with their argument names, record an unknown cost, and keep the Bearer Token out of results, receipts and raw bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dig-native-x-api-'));
  const state = join(root, 'state'); await mkdir(state);
  const secret = 'x-bearer-native-secret%3Dvalue';
  await writeFile(join(state, 'keys.env'), `X_BEARER_TOKEN=${secret}\n`, { mode: 0o600 });
  await writeFile(join(state, 'config.toml'), '[sources]\nenabled = ["x"]\n');
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', resolve('test/provider-fetch.mjs'), resolve('plugin/dist/server.mjs')], cwd: root, env: { DIG_STATE_DIR: state, PATH: process.env.PATH }, stderr: 'pipe' });
  const client = new Client({ name: 'native-x-api-proof', version: '1' });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const argumentsOf = name => Object.keys(tools.find(t => t.name === name).inputSchema.properties).filter(key => !['project', 'dig'].includes(key)).sort();
    assert.deepEqual(Object.fromEntries(['x_post', 'x_search_posts', 'x_count_posts', 'x_users', 'x_news', 'x_explore', 'x_bookmarks', 'x_likes', 'x_community'].map(name => [name, argumentsOf(name)])), {
      x_post: ['posts', 'quotes', 'replies', 'reposters', 'thread'],
      x_search_posts: ['archive', 'end_time', 'limit', 'query', 'sort', 'start_time'],
      x_count_posts: ['archive', 'end_time', 'granularity', 'query', 'start_time'],
      x_users: ['handles', 'mentions', 'posts', 'query'],
      x_news: ['id', 'limit', 'max_age_hours', 'query'],
      x_explore: ['kind', 'limit', 'list', 'query', 'state', 'woeid'],
      x_bookmarks: ['folder', 'limit', 'match'],
      x_likes: ['limit', 'match'],
      x_community: ['community', 'posts', 'sort'],
    });
    const source = (await client.callTool({ name: 'source_info', arguments: { source: 'x' } })).structuredContent.sources[0];
    assert.deepEqual(source.tools, ['xsearch', 'x_post', 'x_search_posts', 'x_count_posts', 'x_users', 'x_news', 'x_explore', 'x_bookmarks', 'x_likes', 'x_community']);
    const read = await client.callTool({ name: 'x_post', arguments: { project: root, posts: ['https://x.com/fixture/status/20'] }, _meta: { threadId: 'x-worker' } });
    assert.equal(read.structuredContent.status, 'success');
    assert.equal(read.structuredContent.call.cost, null);
    assert.equal(read.structuredContent.call.knownCost, undefined);
    assert.match(read.structuredContent.text, /Retained post accidentally echoes \[redacted\]/);
    assert.equal(JSON.stringify(read).includes(secret), false);
    const { live } = (await client.callTool({ name: 'library_list', arguments: { project: root } })).structuredContent;
    assert.deepEqual(live.map(call => [call.tool, call.cost]), [['x_post', null]]);
    const raw = (await client.callTool({ name: 'library_read', arguments: { file: live[0].rawFile } })).structuredContent;
    assert.match(raw.text, /\[redacted\]/);
    assert.equal(raw.text.includes(secret), false);
  } finally { await client.close(); }
});

test('signed-in X reads keep all four sign-in keys out of results, receipts and raw bodies, and record an unknown cost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dig-native-x-signin-'));
  const state = join(root, 'state'); await mkdir(state);
  const keys = { X_CONSUMER_KEY: 'consumer-key-native-fixture', X_CONSUMER_SECRET: 'consumer-secret-native-fixture', X_ACCESS_TOKEN: '99-access-token-native-fixture', X_ACCESS_TOKEN_SECRET: 'access-token-secret-native-fixture' };
  await writeFile(join(state, 'keys.env'), Object.entries(keys).map(([name, value]) => `${name}=${value}\n`).join(''), { mode: 0o600 });
  await writeFile(join(state, 'config.toml'), '[sources]\nenabled = ["x"]\n');
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', resolve('test/provider-fetch.mjs'), resolve('plugin/dist/server.mjs')], cwd: root, env: { DIG_STATE_DIR: state, PATH: process.env.PATH }, stderr: 'pipe' });
  const client = new Client({ name: 'native-x-signin-proof', version: '1' });
  try {
    await client.connect(transport);
    const source = (await client.callTool({ name: 'source_info', arguments: { source: 'x' } })).structuredContent.sources[0];
    assert.equal(source.readiness.status, 'setup-required', 'Sign-in alone does not make X ready');
    assert.deepEqual(source.credentials.filter(c => c.name in keys).map(c => [c.name, c.available, c.required]), Object.keys(keys).map(name => [name, true, false]));
    const read = await client.callTool({ name: 'x_likes', arguments: { project: root, limit: 5 }, _meta: { threadId: 'x-signin' } });
    assert.equal(read.structuredContent.status, 'success');
    assert.match(read.structuredContent.text, /^X posts liked by @signed_in_fixture: 1 post read\./);
    assert.match(read.structuredContent.text, /Liked post accidentally echoes \[redacted\] \[redacted\] \[redacted\] \[redacted\]/);
    assert.equal(read.structuredContent.call.cost, null);
    assert.equal(read.structuredContent.call.knownCost, undefined);
    const { live } = (await client.callTool({ name: 'library_list', arguments: { project: root } })).structuredContent;
    const raw = (await client.callTool({ name: 'library_read', arguments: { file: live[0].rawFile } })).structuredContent;
    for (const text of [JSON.stringify(read), raw.text]) for (const value of Object.values(keys)) assert.equal(text.includes(value), false, 'No sign-in key survives');
  } finally { await client.close(); }
});

test('a key rotated in keys.env while a request that used it is outstanding stays redacted from that request’s result and retained response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dig-native-x-rotation-'));
  const state = join(root, 'state'); await mkdir(state);
  const original = 'x-bearer-original-before-rotation';
  await writeFile(join(state, 'keys.env'), `X_BEARER_TOKEN=${original}\n`, { mode: 0o600 });
  await writeFile(join(state, 'config.toml'), '[sources]\nenabled = ["x"]\n');
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', resolve('test/provider-fetch.mjs'), resolve('plugin/dist/server.mjs')], cwd: root, env: { DIG_STATE_DIR: state, PATH: process.env.PATH }, stderr: 'pipe' });
  const client = new Client({ name: 'native-x-rotation-proof', version: '1' });
  try {
    await client.connect(transport);
    // test/provider-fetch.mjs rewrites keys.env for post 30 and answers only once the server has loaded the new key.
    const read = await client.callTool({ name: 'x_post', arguments: { project: root, posts: ['30'] }, _meta: { threadId: 'x-rotation' } });
    assert.equal(read.structuredContent.status, 'success');
    assert.match(read.structuredContent.text, /Retained post accidentally echoes \[redacted\]/);
    assert.equal(JSON.stringify(read).includes(original), false);
    const { live } = (await client.callTool({ name: 'library_list', arguments: { project: root } })).structuredContent;
    const raw = (await client.callTool({ name: 'library_read', arguments: { file: live[0].rawFile } })).structuredContent;
    assert.match(raw.text, /\[redacted\]/);
    assert.equal(raw.text.includes(original), false);
  } finally { await client.close(); }
});

test('grouped questions redact known credentials before deriving record names or saving metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dig-native-start-'));
  const secret = 'NativeMixedCaseSecretQA42';
  await writeFile(join(root, 'keys.env'), `EXA_API_KEY=${secret}\n`, { mode: 0o600 });
  const client = new Client({ name: 'native-start-proof', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('plugin/dist/server.mjs')], cwd: root, env: { DIG_STATE_DIR: root, PATH: process.env.PATH }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const started = await client.callTool({ name: 'dig_start', arguments: { project: root, question: `Does ${secret} remain private?` } });
    assert.notEqual(started.isError, true);
    assert.equal(JSON.stringify(started).toLowerCase().includes(secret.toLowerCase()), false);
    const file = await client.callTool({ name: 'library_read', arguments: { file: join(started.structuredContent.path, 'dig.md') } });
    assert.equal(file.structuredContent.nextOffset, null);
    assert.match(file.structuredContent.text, /Does \[redacted\] remain private\?/);
    assert.equal(file.structuredContent.text.toLowerCase().includes(secret.toLowerCase()), false);
  } finally { await client.close(); }
});

test('a failed metered call retains its known subtotal after restart with either raw-retention setting', async () => {
  for (const keepRaw of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), 'dig-native-partial-cost-'));
    await writeFile(join(root, 'config.toml'), `keep_raw = ${keepRaw}\n[sources]\nenabled = ["commerce"]\n`);
    await writeFile(join(root, 'keys.env'), 'SCRAPE_DO_API_KEY=private-header-fixture\n', { mode: 0o600 });
    const connect = async () => {
      const client = new Client({ name: 'native-partial-cost-proof', version: '1' });
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: ['--import', resolve('test/provider-fetch.mjs'), resolve('plugin/dist/server.mjs')], cwd: root,
        env: { DIG_STATE_DIR: root, PATH: process.env.PATH }, stderr: 'pipe',
      }));
      return client;
    };
    let client = await connect();
    let id;
    try {
      const result = await client.callTool({ name: 'commerce_product', arguments: { project: root, asin: 'B000000001' }, _meta: { threadId: 'cost-thread' } });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.retentionError, null);
      assert.equal(result.structuredContent.call.status, 'failed');
      assert.equal(result.structuredContent.call.cost, null);
      assert.deepEqual(result.structuredContent.call.knownCost, [{ amount: 1, unit: 'Scrape.do credits' }]);
      id = result.structuredContent.call.id;
    } finally { await client.close(); }
    client = await connect();
    try {
      const listing = (await client.callTool({ name: 'library_list', arguments: { project: root } })).structuredContent;
      const call = listing.live.find(call => call.id === id);
      assert.equal(call.cost, null);
      assert.deepEqual(call.knownCost, [{ amount: 1, unit: 'Scrape.do credits' }]);
      if (keepRaw) {
        const read = (await client.callTool({ name: 'library_read', arguments: { file: call.rawFile } })).structuredContent;
        const raw = JSON.parse(read.text);
        assert.deepEqual(raw.responses[0].headers, { 'scrape.do-request-cost': '1' });
        assert.equal(raw.responses[1].headers, undefined);
        assert.equal(read.text.includes('private-header-fixture'), false);
        assert.equal(read.text.includes('remaining-credits'), false);
        assert.equal(read.text.includes('set-cookie'), false);
      } else {
        assert.equal(call.raw, undefined);
        assert.equal(call.rawFile, null);
      }
    } finally { await client.close(); }
  }
});
