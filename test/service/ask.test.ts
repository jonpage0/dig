// Asking the person (section 5): the spending questions before a paid call, the ask_above_usd setting, and the key
// page, against the built service with clients that answer, decline, cancel, never answer, or declare no elicitation,
// on the 2026-07-28 path and the 2025-era handshake path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyHTTP } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport as LegacyStdio } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../../src/config.mjs';
import { DIG, PRELOAD, cleanup, modernClient, node, pause, startService, text, workspace } from './helpers.mjs';

type Kind = 'modern' | 'legacy';
type Params = { mode?: string; message: string; url?: string; requestedSchema?: { properties: { choice: { title: string; oneOf: { const: string; title: string }[] } } } };
type Reply = (params: Params) => unknown;
type Space = Awaited<ReturnType<typeof workspace>>;
type Result = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, any> };
const KINDS: Kind[] = ['modern', 'legacy'];
const XAI = 'XAI_API_KEY=xai-service-synthetic-value\n';
const config = (spend: string) => `[sources]\nenabled = ["x", "hackernews"]\n${spend ? `[spend]\n${spend}\n` : ''}`;
const choose = (choice: string): Reply => () => ({ action: 'accept', content: { choice } });

/**
 * A client of either kind, over HTTP or through `dig mcp` as a host launches it; `modes` null declares no elicitation.
 * Every question it is asked is kept in `asked`.
 */
async function connect(kind: Kind, space: Space, token: string, { modes = ['form', 'url'], reply = choose('send'), stdio = false }: { modes?: string[] | null; reply?: Reply; stdio?: boolean } = {}) {
  const asked: Params[] = []; let answer = reply;
  const capabilities = modes ? { elicitation: Object.fromEntries(modes.map(mode => [mode, {}])) } : {};
  const handle = async (params: Params) => { asked.push(params); return answer(params); };
  let client: any;
  if (kind === 'modern') {
    client = modernClient({ capabilities });
    if (modes) client.setRequestHandler('elicitation/create', async (request: { params: Params }) => handle(request.params));
    await client.connect(stdio ? new StdioClientTransport(bridge(space)) : new StreamableHTTPClientTransport(space.url, { authProvider: { token: async () => token } }));
  } else {
    client = new LegacyClient({ name: 'dig-test-legacy', version: '1.0.0' }, { capabilities });
    if (modes) client.setRequestHandler(ElicitRequestSchema, async (request: { params: Params }) => handle(request.params) as never);
    await client.connect(stdio ? new LegacyStdio(bridge(space)) : new LegacyHTTP(space.url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  }
  const call = (name: string, args: Record<string, unknown>): Promise<Result> => client.callTool({ name, arguments: args });
  const start = async (question = 'What does a paid source cost here?') => (await call('dig_start', { project: space.root, question })).structuredContent!.dig as string;
  const receipts = async (dig: string) => ((await call('library_list', {})).structuredContent!.items.find((item: { dig: string }) => item.dig === dig)?.calls ?? []).length as number;
  return { client, asked, call, start, receipts, answerWith: (next: Reply) => { answer = next; } };
}
const bridge = (space: Space) => ({ command: node, args: ['--import', PRELOAD, DIG, 'mcp'], env: space.env, stderr: 'pipe' as const });
const requests = async (space: Space) => { try { return (await readFile(join(space.state, 'xai-requests.log'), 'utf8')).trim().split('\n').filter(Boolean).length; } catch { return 0; } };
const xsearch = (dig: string, query: string, extra: Record<string, unknown> = {}) => ({ dig, action: 'xsearch', args: { query, ...extra } });
async function withService(name: string, files: { config?: string; keys?: string }, env: Record<string, string>, body: (space: Space, token: string, service: Awaited<ReturnType<typeof startService>>) => Promise<void>) {
  const space = await workspace(name, files);
  try { const service = await startService(space, env); await body(space, service.token, service); } finally { await cleanup(space); }
}

for (const kind of KINDS) {
  test(`[${kind}] per-call question: asked with no priced history and at or above ask_above_usd; "Send it" sends once; not asked below it, for a free action or a no-charge call`, async () => {
    await withService(`ask-${kind}`, { config: config('ask_above_usd = 0.01'), keys: XAI }, {}, async (space, token) => {
      const { client, asked, call, start, receipts } = await connect(kind, space, token);
      try {
        const dig = await start();
        const first = await call('x', xsearch(dig, 'first'));
        assert.notEqual(first.isError, true, text(first));
        assert.equal(asked.length, 1); assert.equal(await requests(space), 1); assert.equal(await receipts(dig), 1);
        const question = asked[0];
        assert.equal(question.mode ?? 'form', 'form');
        assert.equal(question.message, 'Dig is about to send a paid request: X’s xsearch action. This library has no priced call of it yet, so what it will cost is unknown.');
        assert.equal(question.requestedSchema!.properties.choice.title, 'Dig: send a paid call?');
        assert.deepEqual(question.requestedSchema!.properties.choice.oneOf.map(c => c.title), ['Send it', 'Send it, and don’t ask again for this dig', 'Don’t send it']);
        await call('x', xsearch(dig, 'second'));
        assert.equal(asked.length, 2); assert.equal(await requests(space), 2);
        assert.equal(asked[1].message, 'Dig is about to send a paid request: X’s xsearch action. Its calls in this library have typically cost $0.0123 each (the median of 1 priced call in the last 90 days), at or above the $0.01 from which Dig asks first.');
        // A free action, and a call the metered tool makes at no charge, are never asked about.
        assert.notEqual((await call('hackernews', { dig, action: 'hackernews', args: { query: 'ask' } })).isError, true);
        assert.notEqual((await call('x', xsearch(dig, 'third', { recoverResponseId: 'stored-response' }))).isError, true);
        assert.equal(asked.length, 2);
        // Below the setting: not asked.
        await call('settings', { set: { spend_ask_above_usd: 0.02 } });
        assert.notEqual((await call('x', xsearch(dig, 'below'))).isError, true);
        assert.equal(asked.length, 2); assert.equal(await requests(space), 3);
        // No setting: not asked.
        await call('settings', { set: { spend_ask_above_usd: 0 } });
        await call('x', xsearch(dig, 'unset'));
        assert.equal(asked.length, 2); assert.equal(await requests(space), 4);
      } finally { await client.close(); }
    });
  });

  test(`[${kind}] per-call question: "don't ask again" holds for that dig only; "Don't send it", decline, cancel and a client that cannot be asked refuse and send nothing`, async () => {
    await withService(`ask-refuse-${kind}`, { config: config('ask_above_usd = 0.01'), keys: XAI }, {}, async (space, token) => {
      const asking = await connect(kind, space, token, { reply: choose('send-dig') });
      try {
        const dig = await asking.start();
        await asking.call('x', xsearch(dig, 'first')); await asking.call('x', xsearch(dig, 'second'));
        assert.equal(asking.asked.length, 1, 'not asked again in the same dig'); assert.equal(await requests(space), 2);
        const other = await asking.start('Another question');
        const refusals: [Reply, RegExp][] = [
          [choose('stop'), /^The person chose not to send this X xsearch call, so no request was sent; do not send it another way\.$/],
          [() => ({ action: 'decline' }), /^The person declined the question whether to send this X xsearch call, so no request was sent\.$/],
          [() => ({ action: 'cancel' }), /^The person dismissed the question whether to send this X xsearch call without answering, so no request was sent\.$/],
        ];
        for (const [reply, expected] of refusals) {
          asking.answerWith(reply);
          const result = await asking.call('x', xsearch(other, 'refused'));
          assert.equal(result.isError, true); assert.match(text(result), expected);
        }
        assert.equal(asking.asked.length, 4, 'asked in the other dig each time');
        assert.equal(await requests(space), 2); assert.equal(await asking.receipts(other), 0, 'no receipt for a refused call');
      } finally { await asking.client.close(); }
      const mute = await connect(kind, space, token, { modes: null });
      try {
        const dig = await mute.start('A third question');
        const result = await mute.call('x', xsearch(dig, 'mute'));
        assert.equal(result.isError, true);
        assert.match(text(result), /^This X xsearch call needs the person’s go-ahead first \(it has typically cost \$0\.0123, at or above ask_above_usd of \$0\.01\), but this client cannot ask them, so no request was sent; tell the user, who can change ask_above_usd under \[spend\] in Dig’s settings\.$/);
        assert.equal(await requests(space), 2); assert.equal(await mute.receipts(dig), 0);
      } finally { await mute.client.close(); }
    });
  });

  test(`[${kind}] ceiling question: raising lets the next paid call run and holds for that dig only; "Stop here" refuses; a client that cannot be asked gets today's refusal`, async () => {
    await withService(`ceiling-${kind}`, { config: config('dig_ceiling_usd = 0.02'), keys: XAI }, {}, async (space, token) => {
      const asking = await connect(kind, space, token, { reply: choose('raise') });
      try {
        const dig = await asking.start();
        await asking.call('x', xsearch(dig, 'one')); await asking.call('x', xsearch(dig, 'two'));
        assert.equal(asking.asked.length, 0, 'below the ceiling nothing is asked');
        const third = await asking.call('x', xsearch(dig, 'three'));
        assert.notEqual(third.isError, true, text(third));
        assert.equal(asking.asked.length, 1); assert.equal(await requests(space), 3);
        const question = asking.asked[0];
        assert.equal(question.message, 'This dig has reached its spending ceiling: its calls have recorded $0.0247 in provider-reported US-dollar costs, and the ceiling is $0.02. The next call is X’s xsearch action, a paid request. Raise the ceiling for this dig, or stop its paid calls here?');
        assert.equal(question.requestedSchema!.properties.choice.title, 'Dig: spending ceiling reached');
        assert.deepEqual(question.requestedSchema!.properties.choice.oneOf.map(c => c.title), ['Raise the ceiling for this dig by $0.02', 'Stop here']);
        // $0.037 recorded against a ceiling of $0.04 for this dig: the next call runs without a question.
        assert.notEqual((await asking.call('x', xsearch(dig, 'four'))).isError, true);
        assert.equal(asking.asked.length, 1); assert.equal(await requests(space), 4);
        // Another dig keeps the configured ceiling.
        const other = await asking.start('Another question');
        await asking.call('x', xsearch(other, 'one')); await asking.call('x', xsearch(other, 'two'));
        asking.answerWith(choose('stop'));
        const stopped = await asking.call('x', xsearch(other, 'three'));
        assert.equal(stopped.isError, true);
        assert.match(text(stopped), /^The person chose to stop here when asked whether to raise this dig’s spending ceiling\. This dig has reached its spending ceiling: .* the ceiling is \$0\.02\. No request was sent\./);
        assert.equal(asking.asked.length, 2); assert.equal(await requests(space), 6);
        const answers = JSON.parse(await readFile(join(space.state, 'jobs', 'digs', ...dig.split('/')) + '.json', 'utf8'));
        assert.equal(answers.raisedUsd, 0.02, 'the raise is kept beside the jobs');
        assert.doesNotMatch(await readFile(join(space.state, 'config.toml'), 'utf8'), /0\.04/, 'never in config.toml');
      } finally { await asking.client.close(); }
      const mute = await connect(kind, space, token, { modes: null });
      try {
        const dig = await mute.start('A third question');
        await mute.call('x', xsearch(dig, 'one')); await mute.call('x', xsearch(dig, 'two'));
        const result = await mute.call('x', xsearch(dig, 'three'));
        assert.equal(result.isError, true);
        assert.match(text(result), /^This dig has reached its spending ceiling: its calls have recorded \$0\.0247 in provider-reported US-dollar costs, and the ceiling is \$0\.02\. No request was sent\. The user can raise or remove the ceiling in Dig’s settings \(dig_ceiling_usd under \[spend\] in config\.toml\)\. Tell the user; do not work around it/);
        assert.equal(await requests(space), 8);
      } finally { await mute.client.close(); }
    });
  });
}

test('through dig mcp, both kinds of client are asked and answer', async () => {
  await withService('ask-stdio', { config: config('ask_above_usd = 0.01'), keys: XAI }, {}, async (space, token) => {
    for (const [index, kind] of KINDS.entries()) {
      const { client, asked, call, start } = await connect(kind, space, token, { stdio: true });
      try {
        const dig = await start(`Question ${index}`);
        const result = await call('x', xsearch(dig, `stdio ${kind}`));
        assert.notEqual(result.isError, true, text(result));
        assert.equal(asked.length, 1, kind); assert.equal(await requests(space), index + 1);
      } finally { await client.close(); }
    }
  });
});

test('[legacy] a question that is never answered ends at the timeout as not answered, and nothing is sent', async () => {
  await withService('ask-timeout', { config: config('ask_above_usd = 0.01'), keys: XAI }, { DIG_ASK_TIMEOUT_MS: '1500' }, async (space, token) => {
    const silent = await connect('legacy', space, token, { reply: () => new Promise(() => {}) });
    try {
      const dig = await silent.start();
      const begin = Date.now();
      const result = await silent.call('x', xsearch(dig, 'silent'));
      assert.ok(Date.now() - begin < 10_000);
      assert.equal(result.isError, true);
      assert.match(text(result), /^The question whether to send this X xsearch call went unanswered for 1 minute, so no request was sent\.$/);
      assert.equal(silent.asked.length, 1); assert.equal(await requests(space), 0); assert.equal(await silent.receipts(dig), 0);
    } finally { await silent.client.close(); }
  });
});

test('ask_above_usd round-trips through config.toml and the settings tool; 0 removes it; a bad value is refused', async () => {
  await withService('ask-setting', { config: config('') }, {}, async (space, token) => {
    const { client, call } = await connect('modern', space, token, { modes: null });
    const path = join(space.state, 'config.toml');
    try {
      assert.equal((await call('settings', {})).structuredContent!.values.spend_ask_above_usd, 0);
      const set = await call('settings', { set: { spend_ask_above_usd: 0.25 } });
      assert.equal(set.structuredContent!.values.spend_ask_above_usd, 0.25);
      assert.match(await readFile(path, 'utf8'), /\[spend\]\nask_above_usd = 0\.25\n/);
      assert.equal((await loadConfig(space.state)).spend.ask_above_usd, 0.25);
      await call('settings', { set: { spend_ask_above_usd: 0 } });
      assert.doesNotMatch(await readFile(path, 'utf8'), /ask_above_usd|\[spend\]/);
      assert.equal((await loadConfig(space.state)).spend.ask_above_usd, null);
      for (const bad of [-1, 'a lot', null]) {
        const result = await call('settings', { set: { spend_ask_above_usd: bad } });
        assert.equal(result.isError, true); assert.match(text(result), /spend_ask_above_usd must be a number of US dollars, 0 to stop asking/);
      }
      assert.match((await client.listTools()).tools.find((tool: { name: string }) => tool.name === 'settings').description, /- spend_ask_above_usd: /);
    } finally { await client.close(); }
  });
  const state = await mkdtemp(join(tmpdir(), 'dig-ask-config-'));
  try {
    for (const value of ['0', '-2', '"0.5"']) {
      await writeFile(join(state, 'config.toml'), `[spend]\nask_above_usd = ${value}\n`);
      await assert.rejects(loadConfig(state), /spend\.ask_above_usd must be a positive number of US dollars/);
    }
    await writeFile(join(state, 'config.toml'), '[spend]\nask_above_usd = 0.5\ndig_ceiling_usd = 2\n');
    assert.deepEqual((await loadConfig(state)).spend, { dig_ceiling_usd: 2, ask_above_usd: 0.5 });
  } finally { await rm(state, { recursive: true, force: true }); }
});

// ---- Keys -------------------------------------------------------------------------------------------------------
const SECRET = 'xai-typed-on-the-page-0123456789';
const form = (space: Space, url: string, fields: Record<string, string>, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', redirect: 'manual', headers: { origin: `http://127.0.0.1:${space.port}`, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });
const keysFile = async (space: Space) => { try { return await readFile(join(space.state, 'keys.env'), 'utf8'); } catch { return ''; } };
const available = async (call: (name: string, args: Record<string, unknown>) => Promise<Result>, name: string) => (await call('source_info', { source: 'x' })).structuredContent!.sources[0].credentials.find((entry: { name: string }) => entry.name === name).available;

for (const kind of KINDS) {
  test(`[${kind}] keys: the tool asks for the page to be opened; the page lists names without values; a submission writes keys.env, applies at once, and its code cannot be used twice`, async () => {
    await withService(`keys-${kind}`, { config: config(''), keys: 'X_BEARER_TOKEN=existing-bearer-value\n' }, {}, async (space, token, service) => {
      let page = ''; let address = '';
      // The person: opens the page in a browser, types one key, and sends the form.
      const browser = async (params: Params) => {
        address = params.url!;
        page = await (await fetch(address)).text();
        const sent = await form(space, address, { XAI_API_KEY: SECRET });
        assert.equal(sent.status, 200); assert.match(await sent.text(), /Dig saved these in keys\.env and is using them now:<\/p><ul><li>XAI_API_KEY<\/li><\/ul>/);
        return { action: 'accept' };
      };
      const results: Result[] = [];
      const { client, asked, call } = await connect(kind, space, token, { reply: browser });
      try {
        assert.equal(await available(call, 'XAI_API_KEY'), false);
        const result = await call('keys', { source: 'x' }); results.push(result);
        assert.notEqual(result.isError, true, text(result));
        assert.equal(asked.length, 1); assert.equal(asked[0].mode, 'url');
        assert.match(address, new RegExp(`^http://127\\.0\\.0\\.1:${space.port}/keys/[A-Za-z0-9_-]{32}$`));
        assert.match(asked[0].message, /^Dig would like you to type X’s credentials into a page on this computer \(XAI_API_KEY, X_BEARER_TOKEN, .*\)\. They are saved in Dig’s keys\.env and never pass through the conversation\.$/);
        // The page: a password field per name, its guidance, whether it is set, and no value.
        assert.match(page, /<label for="XAI_API_KEY">XAI_API_KEY <span class="state">· not set<\/span><\/label><p class="note">X: XAI_API_KEY for xsearch; /);
        assert.match(page, /<label for="X_BEARER_TOKEN">X_BEARER_TOKEN <span class="state">· set; a new value replaces it<\/span>/);
        assert.match(page, /<input type="password" id="XAI_API_KEY" name="XAI_API_KEY"/);
        assert.doesNotMatch(page, /existing-bearer-value/);
        assert.doesNotMatch(page, /<script|https?:\/\/(?!127)/, 'no script and no external resource');
        // The result: names only.
        assert.match(text(result), /^The person saved XAI_API_KEY on the key page; Dig is using it now\.\nSet: XAI_API_KEY, X_BEARER_TOKEN\.\nStill missing: X_CONSUMER_KEY, /);
        assert.deepEqual(result.structuredContent!.saved, ['XAI_API_KEY']);
        assert.ok(result.structuredContent!.set.includes('XAI_API_KEY'));
        // Written to keys.env and applied at once.
        assert.match(await keysFile(space), new RegExp(`^XAI_API_KEY=${SECRET}$`, 'm'));
        assert.match(await keysFile(space), /^X_BEARER_TOKEN=existing-bearer-value$/m);
        assert.equal(await available(call, 'XAI_API_KEY'), true);
        // The code cannot be used twice.
        const again = await form(space, address, { XAI_API_KEY: 'a-second-value' });
        assert.equal(again.status, 410); assert.match(await again.text(), /already been used/);
        assert.equal((await fetch(address)).status, 410);
        assert.doesNotMatch(await keysFile(space), /a-second-value/);
        // The value is in no tool result and no log.
        for (const value of results) assert.doesNotMatch(JSON.stringify(value), new RegExp(SECRET));
        assert.doesNotMatch(service.log(), new RegExp(SECRET));
        assert.doesNotMatch(JSON.stringify(await call('source_info', { source: 'x' })), new RegExp(SECRET));
      } finally { await client.close(); }
    });
  });
}

test('keys: a client that cannot open a URL gets the address; foreign, missing and wrong submissions are refused; an expired code accepts nothing', async () => {
  await withService('keys-address', { config: config('') }, { DIG_KEYS_TTL_MS: '3000' }, async (space, token, service) => {
    const { client, call } = await connect('modern', space, token, { modes: ['form'] });
    try {
      const result = await call('keys', {});
      assert.notEqual(result.isError, true, text(result));
      const address = result.structuredContent!.address as string;
      assert.match(text(result), new RegExp(`^This client cannot open a page for the person\\. Give them this address to open in a browser on this computer: ${address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\. It works for one submission and expires in 1 minute`));
      assert.match(text(result), /\nSet: none\.\nStill missing: XAI_API_KEY, X_BEARER_TOKEN, /);
      // Every enabled source's missing names: X's, and Hacker News needs none.
      const page = await (await fetch(address)).text();
      assert.match(page, /name="XAI_API_KEY"/);
      // Only from the page itself: another origin, no origin, another browser site, or not a form, is refused.
      const refusals = [
        await form(space, address, { XAI_API_KEY: SECRET }, { origin: 'https://example.com' }),
        await fetch(address, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `XAI_API_KEY=${SECRET}` }),
        await form(space, address, { XAI_API_KEY: SECRET }, { 'sec-fetch-site': 'cross-site' }),
        await form(space, address, { XAI_API_KEY: SECRET }, { 'content-type': 'application/json' }),
      ];
      assert.deepEqual(refusals.map(response => response.status), [403, 403, 403, 415]);
      // Without the code, or with a wrong one, nothing is accepted.
      const wrong = await form(space, `http://127.0.0.1:${space.port}/keys/not-a-real-code`, { XAI_API_KEY: SECRET });
      assert.equal(wrong.status, 404); assert.match(await wrong.text(), /not valid/);
      assert.equal((await form(space, `http://127.0.0.1:${space.port}/keys/`, { XAI_API_KEY: SECRET })).status, 401);
      assert.equal((await fetch(`http://127.0.0.1:${space.port}/keys/not-a-real-code`)).status, 404);
      assert.equal(await keysFile(space), '');
      // Expired: the page says so and the form accepts nothing.
      await pause(3200);
      const late = await fetch(address); assert.equal(late.status, 410); assert.match(await late.text(), /expired/);
      const expired = await form(space, address, { XAI_API_KEY: SECRET });
      assert.equal(expired.status, 410); assert.match(await expired.text(), /expired/);
      assert.equal(await keysFile(space), '');
      assert.equal(await available(call, 'XAI_API_KEY'), false);
      assert.doesNotMatch(service.log(), new RegExp(SECRET));
    } finally { await client.close(); }
  });
});

test('keys: a declined request changes nothing and its page stops working', async () => {
  await withService('keys-decline', { config: config('') }, {}, async (space, token) => {
    let address = '';
    const { client, call } = await connect('legacy', space, token, { reply: params => { address = params.url!; return { action: 'decline' }; } });
    try {
      const result = await call('keys', { source: 'x' });
      assert.match(text(result), /^The person declined to open the key page; nothing was changed\./);
      assert.equal((await fetch(address)).status, 404);
      assert.equal(await keysFile(space), '');
    } finally { await client.close(); }
  });
});
