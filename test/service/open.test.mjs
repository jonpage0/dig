// open_library for a client that shows no views: a one-time address for the views in a browser, which the client is
// asked to open with a URL-mode request on both protocol eras; where the page was not confirmed opened, the result
// carries an address for the person. And no document or source tells anyone to run a bare `dig open`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyHTTP } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MODERN, cleanup, modernClient, startService, text, workspace } from './helpers.mjs';

const CONFIG = '[sources]\nenabled = ["hackernews"]\n';
const OPENED = 'The host was asked to open Dig’s library in the person’s browser, and the person agreed.';
const GIVE = ' Give the person this address to open it in a browser: (\\S+) \\. It works once, for 5 minutes, and only on this computer\\.$';
const addressIn = (space, result, reason) => {
  const match = new RegExp(`^${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${GIVE}`).exec(text(result));
  assert.ok(match, text(result));
  assert.match(match[1], new RegExp(`^http://127\\.0\\.0\\.1:${space.port}/open/[A-Za-z0-9_-]{32}$`));
  assert.equal(result.structuredContent.address, match[1]); assert.equal(result.structuredContent.opened, false);
  assert.ok(Date.parse(result.structuredContent.expiresAt) > Date.now());
  return match[1];
};
/** The address works once: it sets the session cookie and reaches the library; a second time it is refused. */
async function worksOnce(space, address) {
  const first = await fetch(address, { redirect: 'manual' });
  assert.equal(first.status, 303); assert.equal(first.headers.get('location'), '/');
  const cookie = first.headers.get('set-cookie').split(';')[0]; assert.match(cookie, /^dig_session=/);
  const page = await fetch(`http://127.0.0.1:${space.port}/`, { headers: { cookie } });
  assert.equal(page.status, 200); assert.match(await page.text(), /<div id="root" data-dig-browser="">/);
  const again = await fetch(address, { redirect: 'manual' });
  assert.equal(again.status, 403); assert.match(await again.text(), /^This address is not valid or was already used\. To open Dig in a browser, ask the assistant to open Dig's library, or run this in a terminal: node \/\S+\/dist\/dig\.mjs open\n$/);
}
// A raw 2026-07-28 request, so the input-required round itself can be read.
let ids = 0;
async function rpc(space, token, params, capabilities) {
  const _meta = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': { name: 'dig-test-open', version: '1.0.0' }, 'io.modelcontextprotocol/clientCapabilities': capabilities };
  const response = await fetch(space.url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call', 'mcp-name': 'open_library' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++ids, method: 'tools/call', params: { name: 'open_library', arguments: {}, ...params, _meta } }) });
  const body = await response.text();
  return JSON.parse(response.headers.get('content-type')?.includes('text/event-stream') ? body.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5)).at(-1) : body).result;
}
async function legacy(space, token, capabilities, reply) {
  const client = new LegacyClient({ name: 'dig-test-legacy', version: '1.0.0' }, { capabilities });
  const asked = [];
  if (capabilities.elicitation) client.setRequestHandler(ElicitRequestSchema, async request => { asked.push(request.params); return reply(request.params); });
  await client.connect(new LegacyHTTP(space.url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return { client, asked };
}
async function modern(space, token, capabilities, reply) {
  const client = modernClient({ capabilities });
  const asked = [];
  if (capabilities.elicitation) client.setRequestHandler('elicitation/create', async request => { asked.push(request.params); return reply(request.params); });
  await client.connect(new StreamableHTTPClientTransport(space.url, { authProvider: { token: async () => token } }));
  return { client, asked };
}
async function withService(name, env, body) {
  const space = await workspace(name, { config: CONFIG });
  try { const service = await startService(space, env); await body(space, service.token); } finally { await cleanup(space); }
}

test('[modern] URL elicitation: the input-required round asks to open a one-time address on the service\'s own origin; it works once; the answered call says the library was opened', async () => {
  await withService('open-modern', {}, async (space, token) => {
    const url = { elicitation: { url: {} } };
    const round = await rpc(space, token, {}, url);
    assert.equal(round.resultType, 'input_required');
    const request = round.inputRequests.library;
    assert.equal(request.method, 'elicitation/create'); assert.equal(request.params.mode, 'url');
    assert.equal(request.params.message, 'Dig would like to open its research library in your browser, from a page Dig serves on this computer.');
    assert.match(request.params.url, new RegExp(`^http://127\\.0\\.0\\.1:${space.port}/open/[A-Za-z0-9_-]{32}$`));
    assert.equal(typeof round.requestState, 'string');
    await worksOnce(space, request.params.url);
    const answered = await rpc(space, token, { inputResponses: { library: { action: 'accept' } }, requestState: round.requestState }, url);
    assert.equal(answered.resultType, 'complete'); assert.equal(answered.isError, undefined);
    assert.equal(text(answered), OPENED);
    assert.deepEqual(answered.structuredContent, { view: 'library', dig: null, library: join(space.state, 'library'), opened: true });
    // The answer applies once: the same state and answer again is asked again.
    assert.equal((await rpc(space, token, { inputResponses: { library: { action: 'accept' } }, requestState: round.requestState }, url)).resultType, 'input_required');
    // Declined on the second round: a fresh address for the person, which works once.
    const next = await rpc(space, token, {}, url);
    const declined = await rpc(space, token, { inputResponses: { library: { action: 'decline' } }, requestState: next.requestState }, url);
    const address = addressIn(space, declined, 'The person declined to open Dig’s library.');
    assert.notEqual(address, next.inputRequests.library.params.url);
    await worksOnce(space, address);
  });
});

test('[modern] through the SDK client, which answers the round itself: accept, decline and dismiss', async () => {
  await withService('open-modern-client', {}, async (space, token) => {
    let answer = 'accept'; let used = 0;
    const { client, asked } = await modern(space, token, { elicitation: { form: {}, url: {} } }, async params => { await worksOnce(space, params.url); used++; return { action: answer }; });
    try {
      const opened = await client.callTool({ name: 'open_library', arguments: {} });
      assert.equal(text(opened), OPENED); assert.equal(opened.structuredContent.opened, true); assert.equal(used, 1);
      assert.equal(asked[0].mode, 'url');
      answer = 'decline'; await worksOnce(space, addressIn(space, await client.callTool({ name: 'open_library', arguments: {} }), 'The person declined to open Dig’s library.'));
      answer = 'cancel'; await worksOnce(space, addressIn(space, await client.callTool({ name: 'open_library', arguments: {} }), 'The person dismissed the request to open Dig’s library.'));
    } finally { await client.close(); }
  });
});

test('[legacy] URL elicitation: the request arrives as a server request for a one-time address that works once; accepted, the result says the library was opened; declined, it carries an address', async () => {
  await withService('open-legacy', {}, async (space, token) => {
    let answer = 'accept';
    const { client, asked } = await legacy(space, token, { elicitation: { form: {}, url: {} } }, async params => { await worksOnce(space, params.url); return { action: answer }; });
    try {
      const opened = await client.callTool({ name: 'open_library', arguments: {} });
      assert.equal(asked.length, 1); assert.equal(asked[0].mode, 'url');
      assert.equal(asked[0].message, 'Dig would like to open its research library in your browser, from a page Dig serves on this computer.');
      assert.match(asked[0].url, new RegExp(`^http://127\\.0\\.0\\.1:${space.port}/open/[A-Za-z0-9_-]{32}$`));
      assert.equal(text(opened), OPENED);
      assert.deepEqual(opened.structuredContent, { view: 'library', dig: null, library: join(space.state, 'library'), opened: true });
      answer = 'decline';
      await worksOnce(space, addressIn(space, await client.callTool({ name: 'open_library', arguments: {} }), 'The person declined to open Dig’s library.'));
    } finally { await client.close(); }
  });
});

test('a client that declares no elicitation, or form mode only, gets a one-time address in the result at once, on both eras', async () => {
  await withService('open-unavailable', {}, async (space, token) => {
    for (const capabilities of [{}, { elicitation: { form: {} } }, { elicitation: {} }]) {
      for (const connect of [modern, legacy]) {
        const { client, asked } = await connect(space, token, capabilities, () => { throw new Error('never asked'); });
        try {
          const begin = Date.now();
          const result = await client.callTool({ name: 'open_library', arguments: {} });
          assert.ok(Date.now() - begin < 3000, 'nothing waits');
          assert.equal(asked.length, 0);
          await worksOnce(space, addressIn(space, result, 'This client cannot open pages.'));
        } finally { await client.close(); }
      }
    }
    // The raw 2026-07-28 form: no input-required round at all.
    const raw = await rpc(space, token, {}, { elicitation: { form: {} } });
    assert.equal(raw.resultType, 'complete'); addressIn(space, raw, 'This client cannot open pages.');
  });
});

test('[legacy] a request nobody answers ends at DIG_ASK_TIMEOUT_MS with an address in the result; nothing hangs', async () => {
  await withService('open-timeout', { DIG_ASK_TIMEOUT_MS: '1500' }, async (space, token) => {
    const { client, asked } = await legacy(space, token, { elicitation: { url: {} } }, () => new Promise(() => {}));
    try {
      const begin = Date.now();
      const result = await client.callTool({ name: 'open_library', arguments: {} });
      assert.ok(Date.now() - begin < 10_000);
      assert.equal(asked.length, 1);
      await worksOnce(space, addressIn(space, result, 'The request to open Dig’s library went unanswered.'));
    } finally { await client.close(); }
  });
});

// ---- No bare `dig open` -------------------------------------------------------------------------------------------
const ROOT = new URL('../../', import.meta.url);
async function files(dir, keep) {
  const out = [];
  for (const entry of await readdir(new URL(dir, ROOT), { withFileTypes: true, recursive: true })) if (entry.isFile() && keep(entry.name)) out.push(relative(ROOT.pathname, join(entry.parentPath, entry.name)));
  return out;
}
const SHORTHAND = /`dig` stands for `node [^`]*dist\/dig\.mjs`/;
const COMMAND = /\bdig (?:open|serve|status|stop|mcp)\b/g;

test('no source file or method mentions `dig open`, and a document writes `dig open` (or another `dig` command) only below its own sentence saying what `dig` stands for', async () => {
  for (const file of [...await files('src/', name => /\.(ts|tsx|mjs|js|css|html)$/.test(name)), ...await files('skills/', () => true)]) {
    assert.doesNotMatch(await readFile(new URL(file, ROOT), 'utf8'), /\bdig open\b/, file);
  }
  for (const file of ['README.md', 'CHANGELOG.md', ...await files('docs/', name => name.endsWith('.md'))]) {
    const body = await readFile(new URL(file, ROOT), 'utf8');
    const defined = SHORTHAND.exec(body)?.index ?? Infinity;
    for (const match of body.matchAll(COMMAND)) assert.ok(match.index > defined, `${file}: "${match[0]}" at ${match.index} is not below a sentence saying what \`dig\` stands for`);
  }
});
