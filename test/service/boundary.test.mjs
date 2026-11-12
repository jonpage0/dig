// The provider boundary through the service: what a call returns, its receipt and its retained original carry no
// credential, costs are recorded as providers report them (unknown is never zero), receipts keep the arguments the
// action declares, each source tool lists its actions with their arguments, the shared tools and the YouTube video
// analysis follow their switches, and settings, keys.env and the Papers bridge's .env take effect without a restart.
// Each test runs `dig serve` with an isolated state folder, a free port and a provider fixture (DIG_TEST_FETCH).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import TOML from '@iarna/toml';
import { providerTools } from '../../src/providers/index.ts';
import { MODULES } from '../../src/providers/modules.ts';
import { report } from '../report-fixture.mjs';
import { alive, cleanup, connectLegacy, connectModern, eventually, startService, text, workspace } from './helpers.mjs';

const FIXTURE = name => ({ DIG_TEST_FETCH: resolve(`test/${name}`) });
const UI = { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } };
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==';

/** A source call's first line: label, action, status and receipt id. */
function head(result) {
  const line = text(result).split('\n', 1)[0];
  const match = /^(.+?) · ([a-z_]+) · ([a-z]+) · (?:receipt (c-\S+)|[^·]+) · cost: (.+?)(?: · dig so far: .+)?\.$/.exec(line);
  assert.ok(match, line);
  return { label: match[1], action: match[2], status: match[3], receipt: match[4] ?? null, cost: match[5] };
}
/** The tool's own text, after the first line. */
const body = result => text(result).split('\n\n').slice(1).join('\n\n');
const receipts = async (space, dig) => { const [folder, id] = dig.split('/'); try { return (await readFile(join(space.state, 'library', folder, 'sessions', id, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
const receipt = async (space, dig, id) => (await receipts(space, dig)).find(r => r.id === id);
const original = async (space, dig, r) => { const [folder, id] = dig.split('/'); return readFile(join(space.state, 'library', folder, 'sessions', id, r.raw), 'utf8'); };
/**
 * The tool names listed now. A 2026-07-28 client keeps a list for its ttlMs, so each look at a modern listing is a new
 * connection; a 2025-era session lists afresh and hears list_changed.
 */
async function names(client, space, service) {
  if (!space) return (await client.listTools()).tools.map(tool => tool.name);
  const fresh = await connectModern(space, service.token);
  try { return (await fresh.listTools()).tools.map(tool => tool.name); } finally { await fresh.close(); }
}
/** A call to a source that is off: refused, as an error result or, for a tool the service no longer lists, a protocol error. */
async function refusedCall(pending) {
  try { const result = await pending; return result.isError === true; } catch (error) { return /disabled/.test(error.message); }
}
/** One client, one dig, and a call helper: `call(tool, action, args)` for a source, `call(name, args)` for a core tool. */
async function session(space, service, { kind = 'modern', options, question = 'What does the boundary keep?' } = {}) {
  const client = kind === 'modern' ? await connectModern(space, service.token, options) : await connectLegacy(space, service.token);
  const core = (name, args = {}) => client.callTool({ name, arguments: args });
  const { dig } = (await core('dig_start', { project: space.root, question })).structuredContent;
  const call = (tool, action, args) => typeof action === 'string' ? core(tool, { dig, action, args }) : core(tool, action);
  return { client, dig, call };
}
/** Stops the workspace's service and waits for it to exit. */
async function stop(space) { const { pid } = await space.serviceFile(); process.kill(pid, 'SIGTERM'); await eventually(async () => !alive(pid), 'service did not stop'); }

test('the boundary records provider costs honestly and redacts a credential from results, receipts, retained originals and saved reports', async () => {
  const secret = 'native-test-secret-value';
  const space = await workspace('boundary-redact', { keys: `XAI_API_KEY=${secret}\n`, config: '[sources]\nenabled = ["x"]\n[x]\ndepth = "max"\n' });
  try {
    const service = await startService(space, FIXTURE('provider-fetch.mjs'));
    const { client, dig, call } = await session(space, service);
    try {
      const clean = value => { assert.notEqual(value.isError, true, text(value)); assert.equal(JSON.stringify(value).includes(secret), false); return value; };
      assert.equal(clean(await call('source_info', { source: 'x' })).structuredContent.sources[0].credentials.find(c => c.name === 'XAI_API_KEY').available, true);
      const first = clean(await call('x', 'xsearch', { query: `show-cost ${secret}` }));
      assert.match(body(first), /Returned evidence accidentally echoes \[redacted\]/);
      const priced = await receipt(space, dig, head(first).receipt);
      assert.deepEqual(priced.cost, [{ amount: 0.01234, unit: 'USD' }]);
      assert.equal(priced.args.query, 'show-cost [redacted]');
      const unknown = clean(await call('x', 'xsearch', { query: 'unknown-cost' }));
      assert.equal((await receipt(space, dig, head(unknown).receipt)).cost, null, 'a call whose cost the provider did not report is unknown, not free');
      assert.match(head(unknown).cost, /unknown/);
      const saved = clean(await call('research_save', { dig, source: 'x', agent: 'x-breadth', content: `${report.replace('source: "hackernews"', 'source: "x"')}\nAccidental credential: ${secret}\n` }));
      const listing = (await call('library_list', {})).structuredContent;
      assert.deepEqual(listing.items[0].calls.map(c => c.cost), [[{ amount: 0.01234, unit: 'USD' }], null]);
      for (const file of [saved.structuredContent.path, ...listing.items[0].calls.map(c => c.rawFile)]) {
        const read = clean(await call('library_read', { file })).structuredContent;
        assert.equal(read.nextOffset, null); assert.match(read.text, /\[redacted\]/);
      }
      assert.equal(JSON.stringify(await receipts(space, dig)).includes(secret), false);
      clean(await call('settings', { set: { x_enabled: false } }));
      assert.ok(await refusedCall(call('x', 'xsearch', { query: 'must not run' })));
      assert.equal((await receipts(space, dig)).length, 2);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('the x tool lists every X API action with its argument names; reads record the posts and accounts X returned as the cost, and the Bearer Token stays out', async () => {
  const secret = 'x-bearer-native-secret%3Dvalue';
  const space = await workspace('boundary-x-api', { keys: `X_BEARER_TOKEN=${secret}\n`, config: '[sources]\nenabled = ["x"]\n' });
  try {
    const service = await startService(space, FIXTURE('provider-fetch.mjs'));
    const { client, dig, call } = await session(space, service);
    try {
      const x = (await client.listTools()).tools.find(tool => tool.name === 'x');
      const argumentsOf = action => Object.keys(x.inputSchema.properties.args.anyOf.find(branch => branch.title === action).properties).sort();
      assert.deepEqual(Object.fromEntries(['x_post', 'x_search_posts', 'x_count_posts', 'x_users', 'x_follows', 'x_news', 'x_explore', 'x_bookmarks', 'x_likes', 'x_community', 'x_images'].map(action => [action, argumentsOf(action)])), {
        x_post: ['posts', 'quotes', 'replies', 'reposters', 'thread'],
        x_search_posts: ['archive', 'end_time', 'limit', 'query', 'sort', 'start_time'],
        x_count_posts: ['archive', 'end_time', 'granularity', 'query', 'start_time'],
        x_users: ['handles', 'mentions', 'posts', 'query'],
        x_follows: ['cursor', 'direction', 'handle', 'limit'],
        x_news: ['id', 'limit', 'max_age_hours', 'query'],
        x_explore: ['kind', 'limit', 'list', 'query', 'state', 'woeid'],
        x_bookmarks: ['folder', 'limit', 'match'],
        x_likes: ['limit', 'match'],
        x_community: ['community', 'posts', 'sort'],
        x_images: ['images', 'size'],
      });
      const actions = ['xsearch', 'x_post', 'x_search_posts', 'x_count_posts', 'x_users', 'x_follows', 'x_news', 'x_explore', 'x_bookmarks', 'x_likes', 'x_community', 'x_images'];
      assert.deepEqual(x.inputSchema.properties.action.enum, actions);
      assert.deepEqual((await call('source_info', { source: 'x' })).structuredContent.sources[0].tools, actions);
      const read = await call('x', 'x_post', { posts: ['https://x.com/fixture/status/20'] });
      assert.equal(head(read).status, 'success', text(read));
      assert.match(body(read), /Retained post accidentally echoes \[redacted\]/);
      assert.equal(JSON.stringify(read).includes(secret), false);
      const kept = await receipt(space, dig, head(read).receipt);
      assert.deepEqual(kept.cost, [{ amount: 1, unit: 'X post reads' }, { amount: 1, unit: 'X account reads' }]);
      assert.equal(kept.knownCost, undefined);
      const raw = await original(space, dig, kept);
      assert.match(raw, /\[redacted\]/); assert.equal(raw.includes(secret), false);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('signed-in X reads keep all four sign-in keys out of results, receipts and originals, and record the posts and accounts X returned', async () => {
  const keys = { X_CONSUMER_KEY: 'consumer-key-native-fixture', X_CONSUMER_SECRET: 'consumer-secret-native-fixture', X_ACCESS_TOKEN: '99-access-token-native-fixture', X_ACCESS_TOKEN_SECRET: 'access-token-secret-native-fixture' };
  const space = await workspace('boundary-x-signin', { keys: Object.entries(keys).map(([name, value]) => `${name}=${value}\n`).join(''), config: '[sources]\nenabled = ["x"]\n' });
  try {
    const service = await startService(space, FIXTURE('provider-fetch.mjs'));
    const { client, dig, call } = await session(space, service);
    try {
      const source = (await call('source_info', { source: 'x' })).structuredContent.sources[0];
      assert.equal(source.readiness.status, 'setup-required', 'sign-in alone does not make X ready');
      assert.deepEqual(source.credentials.filter(c => c.name in keys).map(c => [c.name, c.available, c.required]), Object.keys(keys).map(name => [name, true, false]));
      const read = await call('x', 'x_likes', { limit: 5 });
      assert.equal(head(read).status, 'success', text(read));
      assert.match(body(read), /^X posts liked by @signed_in_fixture: 1 post read\./);
      assert.match(body(read), /Liked post accidentally echoes \[redacted\] \[redacted\] \[redacted\] \[redacted\]/);
      const kept = await receipt(space, dig, head(read).receipt);
      // The signed-in account, then the liked post and its author.
      assert.deepEqual(kept.cost, [{ amount: 2, unit: 'X account reads' }, { amount: 1, unit: 'X post reads' }]);
      assert.equal(kept.knownCost, undefined);
      for (const written of [JSON.stringify(read), JSON.stringify(await receipts(space, dig)), await original(space, dig, kept)]) for (const value of Object.values(keys)) assert.equal(written.includes(value), false, 'no sign-in key survives');
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('a key rotated in keys.env while a request that used it is outstanding stays redacted from that request’s result and retained original', async () => {
  const before = 'x-bearer-original-before-rotation';
  const space = await workspace('boundary-rotation', { keys: `X_BEARER_TOKEN=${before}\n`, config: '[sources]\nenabled = ["x"]\n' });
  try {
    const service = await startService(space, FIXTURE('provider-fetch.mjs'));
    const { client, dig, call } = await session(space, service);
    try {
      // test/provider-fetch.mjs rewrites keys.env for post 30 and answers only once the service has loaded the new key.
      const read = await call('x', 'x_post', { posts: ['30'] });
      assert.equal(head(read).status, 'success', text(read));
      assert.match(body(read), /Retained post accidentally echoes \[redacted\]/);
      assert.equal(JSON.stringify(read).includes(before), false);
      const raw = await original(space, dig, await receipt(space, dig, head(read).receipt));
      assert.match(raw, /\[redacted\]/); assert.equal(raw.includes(before), false);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('a key echoed with lowercase percent escapes, form encoding or every byte escaped reaches neither the result, the receipt, the original, its kept cost header nor a saved report', async () => {
  const key = 'Native/key+PRIVATE sample';
  const space = await workspace('boundary-encoded', { keys: `SCRAPE_DO_API_KEY=${key}\n`, config: '[sources]\nenabled = ["commerce"]\n' });
  // test/provider-fetch.mjs echoes the token it was sent in these spellings, in the response body and its cost header.
  const lowercaseEscapes = value => value.replace(/%[0-9A-F]{2}/g, escape => escape.toLowerCase());
  const spellings = {
    'percent-encoded': lowercaseEscapes(encodeURIComponent(key)),
    'form-encoded': lowercaseEscapes(new URLSearchParams({ v: key }).toString().slice(2)),
    'every-byte-escaped': [...new TextEncoder().encode(key)].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join(''),
  };
  try {
    const service = await startService(space, FIXTURE('provider-fetch.mjs'));
    const { client, dig, call } = await session(space, service);
    try {
      const result = await call('commerce', 'commerce_search', { query: `usb ${spellings['every-byte-escaped']}` });
      assert.equal(head(result).status, 'failed'); assert.equal(result.isError, true);
      assert.match(body(result), /bad token \[redacted\] or \[redacted\] or \[redacted\]/);
      const kept = await receipt(space, dig, head(result).receipt);
      assert.equal(kept.args.query, 'usb [redacted]');
      const raw = await original(space, dig, kept);
      assert.deepEqual(JSON.parse(raw).responses[0].headers, { 'scrape.do-request-cost': '[redacted] [redacted]' });
      const saved = await call('research_save', { dig, source: 'commerce', content: `${report.replace('source: "hackernews"', 'source: "commerce"')}\n${Object.values(spellings).join(' ')}\n` });
      const savedReport = (await call('library_read', { file: saved.structuredContent.path })).structuredContent.text;
      const written = [JSON.stringify(result), raw, JSON.stringify(await receipts(space, dig)), savedReport].join('\n');
      for (const [name, spelling] of Object.entries(spellings)) assert.equal(written.includes(spelling), false, `no ${name} spelling survives`);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('receipts keep declared arguments named like credentials, such as token_id and paging tokens, while a known key passed in one is still redacted', async () => {
  const secret = 'declared-argument-secret-value';
  const space = await workspace('boundary-declared', { keys: `SCRAPECREATORS_API_KEY=${secret}\n`, config: '[sources]\nenabled = ["polymarket", "papers", "facebook"]\n' });
  try {
    // test/provider-fetch.mjs answers none of these requests, so each call fails; its receipt still records its arguments.
    const service = await startService(space, FIXTURE('provider-fetch.mjs'));
    const { client, dig, call } = await session(space, service);
    try {
      const args = async (tool, action, values) => (await receipt(space, dig, head(await call(tool, action, values)).receipt)).args;
      assert.deepEqual(await args('polymarket', 'polymarket_history', { token_id: '123456', interval: '1d' }), { token_id: '123456', interval: '1d' });
      assert.deepEqual(await args('papers', 'papers_semantic_scholar_search', { query: 'graphs', token: 'next-page-token' }), { query: 'graphs', token: 'next-page-token' });
      assert.deepEqual(await args('facebook', 'scrapecreators_facebook', { kind: 'replies', feedback_id: 'fb-1', expansion_token: 'expand-1' }), { kind: 'replies', feedback_id: 'fb-1', expansion_token: 'expand-1' });
      assert.deepEqual(await args('papers', 'papers_semantic_scholar_search', { query: 'graphs', token: secret }), { query: 'graphs', token: '[redacted]' });
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('dig_start redacts a known credential from the question before naming the dig or writing dig.md', async () => {
  const secret = 'NativeMixedCaseSecretQA42';
  const space = await workspace('boundary-start', { keys: `EXA_API_KEY=${secret}\n` });
  try {
    const service = await startService(space);
    const client = await connectModern(space, service.token);
    try {
      const started = await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: `Does ${secret} remain private?` } });
      assert.notEqual(started.isError, true, text(started));
      assert.equal(JSON.stringify(started).toLowerCase().includes(secret.toLowerCase()), false);
      const file = (await client.callTool({ name: 'library_read', arguments: { file: join(started.structuredContent.path, 'dig.md') } })).structuredContent;
      assert.equal(file.nextOffset, null);
      assert.match(file.text, /Does \[redacted\] remain private\?/);
      assert.equal(file.text.toLowerCase().includes(secret.toLowerCase()), false);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('a metered call whose second request fails keeps its known subtotal after a restart, with either raw-retention setting', async () => {
  for (const keepRaw of [true, false]) {
    const space = await workspace(`boundary-subtotal-${keepRaw}`, { keys: 'SCRAPE_DO_API_KEY=private-header-fixture\n', config: `keep_raw = ${keepRaw}\n[sources]\nenabled = ["commerce"]\n` });
    try {
      let service = await startService(space, FIXTURE('provider-fetch.mjs'));
      let id; let dig;
      const first = await session(space, service);
      try {
        dig = first.dig;
        const result = await first.call('commerce', 'commerce_product', { asin: 'B000000001' });
        // The paid product page is kept when only the offer listing fails: partial, with the total charge unknown.
        assert.equal(result.isError, undefined, text(result));
        assert.equal(head(result).status, 'partial');
        assert.doesNotMatch(text(result).split('\n', 1)[0], /Evidence receipt not saved/);
        id = head(result).receipt;
      } finally { await first.client.close(); }
      await stop(space);
      service = await startService(space, FIXTURE('provider-fetch.mjs'));
      const client = await connectModern(space, service.token);
      try {
        const listing = (await client.callTool({ name: 'library_list', arguments: {} })).structuredContent;
        const call = listing.items.find(item => item.dig === dig).calls.find(c => c.id === id);
        assert.equal(call.cost, null);
        assert.deepEqual(call.knownCost, [{ amount: 1, unit: 'Scrape.do credits' }]);
        if (keepRaw) {
          const read = (await client.callTool({ name: 'library_read', arguments: { file: call.rawFile } })).structuredContent;
          const raw = JSON.parse(read.text);
          assert.deepEqual(raw.responses[0].headers, { 'scrape.do-request-cost': '1' });
          assert.equal(raw.responses[1].headers, undefined);
          for (const kept of ['private-header-fixture', 'remaining-credits', 'set-cookie']) assert.equal(read.text.includes(kept), false, kept);
        } else {
          assert.equal(call.raw, undefined); assert.equal(call.rawFile, null);
        }
      } finally { await client.close(); }
    } finally { await cleanup(space); }
  }
});

test('direct social reads follow source enablement, keep their receipts with the dig and redact the key', async () => {
  const secret = 'native-social-test-secret';
  const space = await workspace('boundary-social', { keys: `SCRAPECREATORS_API_KEY=${secret}\n`, config: '[sources]\nenabled = ["tiktok", "instagram"]\n' });
  try {
    const service = await startService(space, FIXTURE('direct-social-fetch.mjs'));
    const { client, dig, call } = await session(space, service);
    try {
      const tools = (await client.listTools()).tools;
      for (const source of ['tiktok', 'instagram']) {
        assert.ok(tools.find(tool => tool.name === source).inputSchema.properties.action.enum.includes(`${source}_read`), source);
        assert.ok((await call('source_info', { source })).structuredContent.sources[0].methods[0].tools.includes(`${source}_read`), source);
      }
      const a = await call('tiktok', 'tiktok_read', { kind: 'post', url: 'https://www.tiktok.com/@fixture/photo/12345' });
      const b = await call('instagram', 'instagram_read', { kind: 'posts', handle: 'fixture' });
      // Another page of posts is success, with the cursor stated: partial is kept for something that failed.
      for (const result of [a, b]) {
        assert.equal(result.isError, undefined, text(result)); assert.equal(head(result).status, 'success');
        assert.equal(JSON.stringify(result).includes(secret), false);
        const kept = await receipt(space, dig, head(result).receipt);
        assert.deepEqual(kept.cost, [{ amount: 1, unit: 'credits' }]);
        const raw = await original(space, dig, kept);
        assert.equal(raw.includes(secret), false); assert.ok(raw.includes('[redacted]'));
      }
      assert.deepEqual((await receipts(space, dig)).map(r => r.source).sort(), ['instagram', 'tiktok']);
      await call('settings', { set: { tiktok_enabled: false } });
      const remaining = await names(client, space, service);
      assert.ok(!remaining.includes('tiktok')); assert.ok(remaining.includes('instagram'));
      assert.ok(await refusedCall(call('tiktok', 'tiktok_read', { kind: 'post', url: 'https://www.tiktok.com/@fixture/photo/12345' })));
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('the library view shows a running provider call before its receipt exists, without its arguments, then the retained outcome', async () => {
  const space = await workspace('boundary-activity', { keys: 'XAI_API_KEY=activity-fixture\n', config: '[sources]\nenabled = ["x"]\n' });
  let pending;
  try {
    const service = await startService(space, { ...FIXTURE('activity-fetch.mjs'), DIG_ACTIVITY_GATE: space.root });
    const { client, dig, call } = await session(space, service, { options: UI });
    try {
      const view = async name => (await call(name, {})).structuredContent;
      const before = (await view('library_revision')).revision;
      pending = call('x', 'xsearch', { query: 'This query must not enter active metadata' });
      await eventually(async () => { try { await access(join(space.root, 'started')); return true; } catch { return false; } }, 'the fixture did not start');
      const during = await view('library_snapshot');
      assert.equal(during.activeCalls.length, 1);
      assert.deepEqual([during.activeCalls[0].source, during.activeCalls[0].tool, during.activeCalls[0].session], ['x', 'xsearch', dig.split('/')[1]]);
      assert.equal(during.activeCalls[0].args, undefined);
      assert.equal(JSON.stringify(during).includes('must not enter'), false);
      assert.equal(during.items.find(item => item.dig === dig).calls.length, 0, 'an executing call is not a retained receipt');
      assert.notEqual((await view('library_revision')).revision, before);
      await writeFile(join(space.root, 'release'), 'go');
      const result = await pending;
      assert.equal(head(result).status, 'success', text(result));
      const after = await view('library_snapshot');
      assert.deepEqual(after.activeCalls, []);
      assert.deepEqual(after.items.find(item => item.dig === dig).calls.map(c => [c.tool, c.status]), [['xsearch', 'success']]);
    } finally { await client.close(); }
  } finally {
    await writeFile(join(space.root, 'release'), 'go').catch(() => {});
    await pending?.catch(() => {}); await cleanup(space);
  }
});

test('evidence ranking follows its switch, keeps the key and the dig out of what reaches the provider, and keeps a shared-tool receipt', async () => {
  const secret = 'typesafe-protocol-synthetic-key';
  const space = await workspace('boundary-evidence', { keys: `TYPESAFE_API_KEY=${secret}\n` });
  try {
    const service = await startService(space);
    const { client, dig, call } = await session(space, service);
    try {
      assert.equal((await names(client, space, service)).includes('evidence'), false, 'off by default');
      await call('settings', { set: { evidence_enabled: true } });
      // test/mock-fetch.mjs refuses a request whose body carries the key, a project or a dig.
      const result = await call('evidence', 'evidence_rank', { question: 'Which excerpt helps?', candidates: [{ id: 'a', text: `Public test excerpt with an accidental known credential ${secret}`, reference: 'https://example.test/original' }] });
      assert.equal(head(result).status, 'success', text(result));
      assert.equal(JSON.stringify(result).includes(secret), false);
      const kept = await receipt(space, dig, head(result).receipt);
      assert.deepEqual([kept.source, kept.tool, kept.cost], ['evidence', 'evidence_rank', null]);
      const save = (await client.listTools()).tools.find(tool => tool.name === 'research_save');
      assert.ok(!save.inputSchema.properties.source.enum.includes('evidence'), 'a shared tool has no reports');
      await call('settings', { set: { evidence_enabled: false } });
      assert.equal((await names(client, space, service)).includes('evidence'), false);
      assert.ok(await refusedCall(call('evidence', 'evidence_rank', { question: 'Test', candidates: [{ id: 'a', text: 'Test' }] })));
      assert.ok((await call('library_list', {})).structuredContent.items[0].calls.some(c => c.source === 'evidence'), 'disabling the tool keeps its receipt');
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('the video utility follows its switch, has helper guidance and no report method, and cannot save a report', async () => {
  const space = await workspace('boundary-video');
  try {
    const service = await startService(space);
    const { client, dig, call } = await session(space, service);
    try {
      const tools = (await client.listTools()).tools;
      assert.equal(tools.some(tool => tool.name === 'video'), false);
      assert.ok(!tools.find(tool => tool.name === 'research_save').inputSchema.properties.source.enum.includes('video'));
      assert.ok(!tools.find(tool => tool.name === 'dig_start').inputSchema.properties.planned.items.enum.includes('video-analyze'));
      const info = (await call('source_info', { source: 'video' })).structuredContent.sources[0];
      assert.deepEqual([info.kind, info.tool, info.methods, info.tools], ['tool', 'video', [], ['video_analyze']]);
      assert.notEqual((await call('settings', { set: { video_enabled: true } })).isError, true);
      assert.ok((await names(client, space, service)).includes('video'));
      assert.equal((await call('research_save', { dig, source: 'video', content: report })).isError, true);
      await call('settings', { set: { video_enabled: false } });
      assert.equal((await names(client, space, service)).includes('video'), false);
      assert.ok(await refusedCall(call('video', 'video_analyze', { video: 'https://example.invalid/video.mp4', question: 'Describe the scene.' })));
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('YouTube video analysis follows the YouTube switch, keeps unknown-cost receipts and saves a full video-method report', async () => {
  const key = 'gemini-protocol-synthetic-value';
  const space = await workspace('boundary-youtube', { keys: `GEMINI_API_KEY=${key}\n` });
  try {
    const service = await startService(space);
    const { client, dig, call } = await session(space, service, { question: 'What closes?' });
    try {
      assert.equal((await names(client, space, service)).includes('youtube'), false);
      assert.ok((await client.listTools()).tools.find(tool => tool.name === 'dig_start').inputSchema.properties.planned.items.enum.includes('youtube-video'));
      await call('settings', { set: { youtube_enabled: true } });
      const fresh = await connectModern(space, service.token); const tools = (await fresh.listTools()).tools; await fresh.close();
      const youtube = tools.find(tool => tool.name === 'youtube');
      for (const action of ['youtube_analyze', 'youtube_analysis_status']) assert.ok(youtube.inputSchema.properties.action.enum.includes(action), action);
      assert.equal(tools.some(tool => tool.name === 'video'), false, 'the separate video switch does not change');
      const source = (await call('source_info', { source: 'youtube' })).structuredContent.sources[0];
      assert.deepEqual(source.credentials.find(c => c.name === 'GEMINI_API_KEY'), { name: 'GEMINI_API_KEY', available: true, required: false, environment: 'absent' });
      assert.equal(source.methods.find(method => method.name === 'youtube-video').helper, false);
      assert.equal((await call('youtube', 'youtube_analyze', { question: 'Invalid provider model', videos: [{ url: 'aB_cD-eF123' }], model: 'wrong-model' })).isError, true);
      assert.equal(Object.hasOwn(youtube.inputSchema.properties.args.anyOf.find(branch => branch.title === 'youtube_analyze').properties, 'codeExecution'), false);
      assert.equal((await call('youtube', 'youtube_analyze', { question: 'Unsupported code tool', videos: [{ url: 'aB_cD-eF123' }], codeExecution: true })).isError, true, 'code execution is refused for YouTube inputs');
      const analysis = await call('youtube', 'youtube_analyze', { question: 'What closes?', videos: [{ url: 'aB_cD-eF123', startSeconds: 2, endSeconds: 20, fps: 2 }] });
      assert.equal(head(analysis).status, 'success', text(analysis));
      assert.equal(JSON.stringify(analysis).includes(key), false);
      const kept = await receipt(space, dig, head(analysis).receipt);
      assert.deepEqual([kept.source, kept.tool, kept.cost, kept.knownCost], ['youtube', 'youtube_analyze', null, undefined]);
      const status = await call('youtube', 'youtube_analysis_status', { interactionId: 'interaction_protocol_fixture' });
      assert.equal(head(status).status, 'success', text(status));
      assert.equal((await receipt(space, dig, head(status).receipt)).cost, null);
      const saved = (await call('research_save', { dig, source: 'youtube', agent: 'youtube-video', content: report.replace('hackernews', 'youtube') })).structuredContent;
      assert.equal(saved.report, 'youtube-video.md');
      const listing = (await call('library_list', { source: 'youtube' })).structuredContent;
      assert.equal(listing.items.length, 1); assert.equal(listing.items[0].calls.length, 2);
      assert.ok(listing.items[0].calls.every(r => r.claimedBy.endsWith('/youtube-video.md')));
      const raw = (await call('library_read', { file: listing.items[0].calls[0].rawFile })).structuredContent.text;
      assert.match(raw, /At 00:10 the door closes/); assert.equal(raw.includes(key), false);
      await call('settings', { set: { youtube_enabled: false } });
      assert.equal((await names(client, space, service)).includes('youtube'), false);
      assert.match((await call('library_read', { file: saved.file })).structuredContent.text, /agent: youtube-video/);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('a source call reads success, empty or failed with a receipt each; a saved report is found by library_search; settings and a hand-edited config.toml change what a session lists', async () => {
  const space = await workspace('boundary-statuses');
  try {
    const service = await startService(space);
    const { client, dig, call } = await session(space, service, { kind: 'legacy', question: 'Explicit test identity' });
    try {
      for (const [query, expected] of [['sample', 'success'], ['empty', 'empty'], ['failure', 'failed'], ['malformed', 'failed']]) {
        const result = await call('hackernews', 'hackernews', { query });
        assert.equal(head(result).status, expected, query);
        assert.equal(result.isError === true, expected === 'failed', query);
        const kept = await receipt(space, dig, head(result).receipt);
        assert.deepEqual([kept.status, kept.cost, kept.dig], [expected, [], dig.split('/')[1]]);
      }
      const saved = (await call('research_save', { dig, source: 'hackernews', content: report })).structuredContent;
      const search = await call('library_search', { query: 'inspected sample', mode: 'keyword', file: saved.file });
      assert.equal(search.structuredContent.status, 'complete'); assert.ok(search.structuredContent.hits.length);
      const hit = search.structuredContent.hits[0];
      assert.match(text(search), /^\d+ hits? in 1 of 1 files · complete · keyword\. /); assert.equal(text(search).includes(hit.excerpt), false);
      assert.equal((await call('library_read', hit.read)).structuredContent.text, hit.excerpt);
      // The settings tool writes config.toml and relists; a hand edit of the file relists too.
      assert.notEqual((await call('settings', { set: { hackernews_enabled: false, keep_raw: false } })).isError, true);
      assert.equal((await names(client)).includes('hackernews'), false);
      assert.ok(await refusedCall(call('hackernews', 'hackernews', { query: 'sample' })));
      const config = TOML.parse(await readFile(join(space.state, 'config.toml'), 'utf8'));
      assert.equal(config.keep_raw, false); assert.deepEqual(config.sources.enabled, []);
      await writeFile(join(space.state, 'config.toml'), TOML.stringify({ ...config, sources: { enabled: ['hackernews'] } }));
      await eventually(async () => (await names(client)).includes('hackernews'), 'a hand-edited enablement must change what is listed');
      await writeFile(join(space.state, 'config.toml'), TOML.stringify(config));
      await eventually(async () => !(await names(client)).includes('hackernews'), 'a hand-edited disablement must change what is listed');
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('invalid settings at startup leave the service running with every source unlisted until the file is corrected', async () => {
  const space = await workspace('boundary-invalid', { config: 'keep_raw = "yes"\n' });
  try {
    const service = await startService(space);
    const client = await connectLegacy(space, service.token);
    try {
      assert.ok((await names(client)).includes('source_info'));
      assert.equal((await names(client)).includes('hackernews'), false, 'source tools stay unlisted while the settings are invalid');
      await writeFile(join(space.state, 'config.toml'), 'keep_raw = true\n');
      await eventually(async () => (await names(client)).includes('hackernews'), 'correcting the file lists its sources');
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('a key set in keys.env or removed, and the Papers bridge’s own .env, apply without a restart; a key only in the starting environment is not used', async () => {
  const space = await workspace('boundary-keys');
  try {
    const service = await startService(space, { EXA_API_KEY: 'exa-from-environment-value' });
    const client = await connectModern(space, service.token, UI);
    try {
      const call = (name, args = {}) => client.callTool({ name, arguments: args });
      const exa = async () => { const source = (await call('source_info', { source: 'exa' })).structuredContent.sources[0]; return { state: `${source.credentials[0].available}/${source.credentials[0].environment}`, message: source.readiness.message }; };
      const revision = async () => (await call('library_revision')).structuredContent.revision;
      assert.deepEqual(await exa(), { state: 'false/unused', message: 'Disabled in Dig settings. Missing EXA_API_KEY in Dig’s keys.env. The environment Dig started with has EXA_API_KEY, which Dig does not use until it is in keys.env: the user sets it outside chat, on the page Dig’s keys tool opens or in keys.env.' });
      const before = await revision();
      const keys = join(space.state, 'keys.env');
      await writeFile(keys, 'EXA_API_KEY=exa-protocol-secret-value\n', { mode: 0o600 });
      await eventually(async () => (await exa()).state === 'true/different', 'a saved value must load without a restart');
      assert.notEqual(await revision(), before, 'a readiness change refreshes an open view');
      assert.doesNotMatch(JSON.stringify(await call('source_info', {})), /exa-protocol-secret-value|exa-from-environment-value/);
      await writeFile(keys, '');
      await eventually(async () => (await exa()).state === 'false/unused', 'a removed value must unload without a restart');
      // The Papers entry says whether only the bridge's own .env holds the Unpaywall address, never the address, and a
      // change there refreshes an open view as a keys.env change does.
      const bridgeEnv = join(space.state, 'tools', 'paper-search-mcp', '.env');
      const unset = await revision();
      await mkdir(dirname(bridgeEnv), { recursive: true }); await writeFile(bridgeEnv, 'PAPER_SEARCH_MCP_UNPAYWALL_EMAIL="reader@example.org"\n');
      const papers = await call('source_info', { source: 'papers' });
      assert.equal(papers.structuredContent.sources[0].envSettings[0].bridge, true); assert.doesNotMatch(JSON.stringify(papers), /reader@example\.org/);
      const set = await revision();
      assert.notEqual(set, unset, 'adding the address in the bridge’s .env refreshes the view');
      await rm(bridgeEnv);
      assert.notEqual(await revision(), set, 'removing it refreshes the view too');
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('source_info gives each action’s recorded history in this library: calls, failures, priced and free calls, typical cost and time', async () => {
  const space = await workspace('boundary-history', { keys: 'XAI_API_KEY=xai-service-synthetic-value\n', config: '[sources]\nenabled = ["hackernews", "x"]\n' });
  try {
    const service = await startService(space);
    const { client, call } = await session(space, service);
    try {
      for (const query of ['first', 'second']) assert.equal(head(await call('x', 'xsearch', { query })).status, 'success');
      // A stored answer read back by its id sends no search and records no charge.
      assert.match(head(await call('x', 'xsearch', { query: 'third', recoverResponseId: 'stored-response' })).cost, /no charge recorded/);
      assert.equal(head(await call('hackernews', 'hackernews', { query: 'history' })).status, 'success');
      const info = await call('source_info', {});
      assert.equal(info.structuredContent.historyDays, 90);
      assert.match(text(info), /enabled\. Readiness is credential and prerequisite presence only\.$/);
      const history = id => info.structuredContent.sources.find(source => source.id === id).history;
      assert.deepEqual(history('x').map(row => [row.tool, row.source, row.calls, row.failed, row.failureRate, row.pricedCalls, row.unknownCalls, row.freeCalls]), [['xsearch', 'x', 3, 0, 0, 3, 0, 1]]);
      assert.deepEqual(history('x')[0].typicalCost, [{ amount: 0.01234, unit: 'USD' }]);
      assert.equal(typeof history('x')[0].medianMs, 'number');
      assert.deepEqual(history('hackernews').map(row => [row.tool, row.calls, row.typicalCost]), [['hackernews', 1, []]]);
      assert.deepEqual(history('reddit'), []);
      assert.match((await client.listTools()).tools.find(tool => tool.name === 'source_info').description, /history/);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('every provider tool is an action of one source tool; x_images shows some pictures as partial and refuses a host other than X’s before any request, and no picture is kept', async () => {
  const space = await workspace('boundary-actions', { config: `[sources]\nenabled = [${MODULES.map(m => JSON.stringify(m.id)).join(', ')}]\n` });
  try {
    const service = await startService(space);
    const { client, dig, call } = await session(space, service);
    try {
      const actions = (await client.listTools()).tools.flatMap(tool => tool.inputSchema.properties?.action?.enum ?? []);
      assert.deepEqual([...actions].sort(), Object.keys(providerTools).sort(), 'each provider tool is listed once, as an action');
      const partial = await call('x', 'x_images', { images: ['https://pbs.twimg.com/media/first.jpg', 'https://pbs.twimg.com/media/redirect.jpg'] });
      assert.equal(head(partial).status, 'partial', text(partial));
      assert.deepEqual(partial.content.map(block => block.type), ['text', 'resource_link', 'resource_link', 'image']);
      const refused = await call('x', 'x_images', { images: ['https://example.com/a.jpg'] });
      assert.equal(refused.isError, true);
      assert.match(body(refused), /ERROR: X images refused before any request: .*is on example\.com, not pbs\.twimg\.com/);
      const kept = await receipts(space, dig);
      assert.equal(JSON.stringify(kept).includes(PIXEL), false, 'no picture in a receipt');
      for (const r of kept.filter(r => r.raw)) assert.equal((await original(space, dig, r)).includes(PIXEL), false, 'no picture in a retained original');
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});
