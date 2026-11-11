import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { providerTools } from '../src/providers/index.ts';
import { USER_AGENT, VERSION } from '../src/version.mjs';

const tools = join(import.meta.dirname, '../src/providers/tools');

test('every request Dig sends that sets a User-Agent sends dig/<version>', async t => {
  assert.equal(USER_AGENT, `dig/${VERSION}`);
  const original = globalThis.fetch; const saved = process.env.PERPLEXITY_API_KEY;
  t.after(() => { globalThis.fetch = original; if (saved === undefined) delete process.env.PERPLEXITY_API_KEY; else process.env.PERPLEXITY_API_KEY = saved; });
  process.env.PERPLEXITY_API_KEY = 'user-agent-fixture-key';
  const ctx = { sessionID: 'test', directory: '/tmp', worktree: '/tmp', abort: new AbortController().signal, keep() {} };
  for (const [name, args] of [['hackernews', { query: 'agents' }], ['hackernews_read', { item: '1' }], ['polymarket', { query: 'election' }], ['papers_semantic_scholar_search', { query: 'graphs' }], ['perplexity_search', { query: 'agents' }]]) {
    const sent = [];
    globalThis.fetch = async (_url, init) => { sent.push(new Headers(init?.headers).get('user-agent')); return Response.json({}, { status: 500 }); };
    await providerTools[name].execute(args, ctx);
    assert.ok(sent.length, `${name} sent a request`);
    assert.deepEqual([...new Set(sent)], [USER_AGENT], name);
  }
  // No tool spells its own User-Agent.
  for (const file of (await readdir(tools)).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    for (const line of (await readFile(join(tools, file), 'utf8')).split('\n').filter(line => /user-agent/i.test(line) && !/^\s*(\/\/|\*)/.test(line))) assert.match(line, /"User-Agent": USER_AGENT\b/, `${file}: ${line.trim()}`);
  }
});
