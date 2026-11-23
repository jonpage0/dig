import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { providerTools } from '../src/providers/index.ts';
import { USER_AGENT, VERSION } from '../src/version.mjs';

const tools = join(import.meta.dirname, '../src/providers/tools');

test('every request Dig sends that sets a User-Agent sends dig/<version>', async t => {
  assert.equal(USER_AGENT, `dig/${VERSION}`);
  const original = globalThis.fetch;
  const saved = { PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY, FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY, SEC_USER_AGENT: process.env.SEC_USER_AGENT };
  t.after(() => {
    globalThis.fetch = original;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  process.env.PERPLEXITY_API_KEY = 'user-agent-fixture-key';
  process.env.FIRECRAWL_API_KEY = 'user-agent-firecrawl-key';
  delete process.env.SEC_USER_AGENT;
  const ctx = { sessionID: 'test', directory: '/tmp', worktree: '/tmp', abort: new AbortController().signal, keep() {} };
  for (const [name, args] of [['hackernews', { query: 'agents' }], ['hackernews_read', { item: '1' }], ['polymarket', { query: 'election' }], ['wayback_snapshots', { url: 'example.com' }], ['wayback_read', { url: 'example.com' }], ['papers_semantic_scholar_search', { query: 'graphs' }], ['perplexity_search', { query: 'agents' }], ['firecrawl_scrape', { url: 'https://example.com' }], ['bluesky_search', { q: 'atproto' }], ['bluesky_profile', { actor: 'bsky.app', includePosts: false }]]) {
    const sent = [];
    globalThis.fetch = async (_url, init) => { sent.push(new Headers(init?.headers).get('user-agent')); return Response.json({}, { status: 500 }); };
    await providerTools[name].execute(args, ctx);
    assert.ok(sent.length, `${name} sent a request`);
    assert.deepEqual([...new Set(sent)], [USER_AGENT], name);
  }
  // SEC EDGAR requires a descriptive User-Agent per SEC fair-access policy (configurable via SEC_USER_AGENT).
  const secSent = [];
  globalThis.fetch = async (_url, init) => { secSent.push(new Headers(init?.headers).get('user-agent')); return Response.json({}, { status: 500 }); };
  await providerTools.sec_search.execute({ q: 'risk' }, ctx);
  assert.match(secSent[0] ?? '', /^DigResearch\/1\.0 \(/);
  process.env.SEC_USER_AGENT = 'CustomResearcher/1.0 (ops@example.com)';
  await providerTools.sec_search.execute({ q: 'risk' }, ctx);
  assert.equal(secSent[1], 'CustomResearcher/1.0 (ops@example.com)');
  // No tool (except sec.ts, which must satisfy SEC fair-access User-Agent policy) spells its own User-Agent.
  for (const file of (await readdir(tools)).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'sec.ts')) {
    for (const line of (await readFile(join(tools, file), 'utf8')).split('\n').filter(line => /user-agent/i.test(line) && !/^\s*(\/\/|\*)/.test(line))) assert.match(line, /"User-Agent": USER_AGENT\b/, `${file}: ${line.trim()}`);
  }
});
