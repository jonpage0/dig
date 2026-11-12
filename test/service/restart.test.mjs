// `dig mcp` across a service restart. A 2025-era handshake client (Codex, ChatGPT desktop) keeps working without doing
// anything: the front opens a new session for it on the new service and sends its request again once, since the
// service refused it without running it. A request in flight when the service stops is answered at once, and never
// sent again. The service runs with xAI's search mocked and delayable (jobs-preload.mjs) where a test needs a slow call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { VERSION } from '../../src/version.mjs';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StdioClientTransport as LegacyStdio } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { alive, cleanup, DIG, eventually, legacyClient, MODERN, modernClient, node, pause, PRELOAD, run, text, workspace } from './helpers.mjs';

const JOBS_PRELOAD = resolve('test/service/jobs-preload.mjs');
const SETUP = { keys: 'XAI_API_KEY=xai-service-synthetic-value\n', config: '[sources]\nenabled = ["hackernews", "x"]\n' };
const STOPPED = /^(MCP error -32603: )?Dig's service stopped while this request was running, so it got no answer\. A paid request may still have been sent: if the call had a job, the job is marked failed when the service starts again, with an unknown cost\. Do not call the tool again blindly: `job` or the dig's receipts show what happened\.$/;

/** A client of either kind on `dig mcp`, with the front's stderr kept. */
async function front(space, kind, { preload = PRELOAD } = {}) {
  const params = { command: node, args: ['--import', preload, DIG, 'mcp'], env: space.env, stderr: 'pipe' };
  const transport = kind === 'modern' ? new StdioClientTransport(params) : new LegacyStdio(params);
  const log = { stderr: '' }; transport.stderr.on('data', chunk => { log.stderr += chunk; });
  const client = kind === 'modern' ? modernClient() : legacyClient();
  await client.connect(transport);
  return { client, log };
}
const hackernews = (client, dig, query) => client.callTool({ name: 'hackernews', arguments: { dig, action: 'hackernews', args: { query } } });
const succeeded = result => { assert.notEqual(result.isError, true, text(result)); assert.match(text(result), /^Hacker News · hackernews · success · /); };
/** Stops the service under the front, politely (`dig stop`) or not (SIGKILL), and returns the pid it had. */
async function stopUnder(space, how) {
  const { pid } = await space.serviceFile();
  if (how === 'stop') assert.equal((await run(space, ['stop'])).stdout.trim(), 'Dig stopped.');
  else process.kill(pid, 'SIGKILL');
  await eventually(async () => !alive(pid), 'the service did not stop');
  return pid;
}

for (const how of ['stop', 'kill']) {
  test(`a 2025-era client through dig mcp keeps working after the service is ${how === 'stop' ? 'stopped' : 'killed'}: the front opens a new session on the new service, and list_changed still arrives`, async () => {
    const space = await workspace(`restart-legacy-${how}`);
    let client;
    try {
      const opened = await front(space, 'legacy'); client = opened.client;
      let changed = 0; client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed++; });
      const { dig } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: `Does a 2025-era client survive a ${how}?` } })).structuredContent;
      succeeded(await hackernews(client, dig, 'before'));
      const first = await stopUnder(space, how);
      // The same client, with nothing done on its side: the call goes to a new service process, on a new session.
      succeeded(await hackernews(client, dig, 'after'));
      const { pid: second, token } = await space.serviceFile();
      assert.notEqual(second, first); assert.ok(alive(second));
      succeeded(await hackernews(client, dig, 'again'));
      const status = await (await fetch(`http://127.0.0.1:${space.port}/status`, { headers: { authorization: `Bearer ${token}` } })).json();
      assert.equal(status.sessions, 1, 'one session on the new service');
      // The session's server-to-client stream is open again: enabling a source reaches the client as list_changed.
      changed = 0;
      const set = await client.callTool({ name: 'settings', arguments: { set: { reddit_enabled: true } } });
      assert.notEqual(set.isError, true, text(set));
      await eventually(async () => changed > 0, 'list_changed did not reach the client after the restart');
      assert.ok((await client.listTools()).tools.some(tool => tool.name === 'reddit'));
      assert.equal(opened.log.stderr, '', opened.log.stderr);
    } finally { await client?.close(); await cleanup(space); }
  });
}

test('a 2026-07-28 client through dig mcp keeps working across a stop', async () => {
  const space = await workspace('restart-modern');
  let client;
  try {
    const opened = await front(space, 'modern'); client = opened.client;
    assert.equal(client.getNegotiatedProtocolVersion(), MODERN);
    const { dig } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: 'Does a 2026-07-28 client survive a stop?' } })).structuredContent;
    succeeded(await hackernews(client, dig, 'before'));
    const first = await stopUnder(space, 'stop');
    succeeded(await hackernews(client, dig, 'after'));
    assert.notEqual((await space.serviceFile()).pid, first);
    succeeded(await hackernews(client, dig, 'again'));
    assert.equal(opened.log.stderr, '', opened.log.stderr);
  } finally { await client?.close(); await cleanup(space); }
});

for (const kind of ['legacy', 'modern']) {
  test(`a ${kind === 'legacy' ? '2025-era' : '2026-07-28'} request in flight when the service is killed is answered at once and never sent again; a later call works`, async () => {
    const space = await workspace(`inflight-${kind}`, SETUP);
    const calls = async () => (await readFile(join(space.state, 'provider-calls.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;
    let client;
    try {
      ({ client } = await front(space, kind, { preload: JOBS_PRELOAD }));
      const { dig } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: 'What happens to a call cut off by a stop?' } })).structuredContent;
      await writeFile(join(space.state, 'provider-delay-ms'), '600000');
      const xsearch = query => client.callTool({ name: 'x', arguments: { dig, action: 'xsearch', args: { query } } }, undefined, { timeout: 120_000 });
      const cut = xsearch('cut off'); cut.catch(() => {});
      await eventually(async () => (await calls()) === 1, 'the provider request was not sent');
      const { pid } = await space.serviceFile();
      process.kill(pid, 'SIGKILL'); const killed = Date.now();
      await assert.rejects(cut, error => { assert.match(error.message, STOPPED); return true; });
      assert.ok(Date.now() - killed < 5000, `answered after ${Date.now() - killed} ms`);
      // A later call starts the service again, which marks the cut-off job failed; nothing sends its request again.
      await writeFile(join(space.state, 'provider-delay-ms'), '0');
      const later = await xsearch('later');
      assert.notEqual(later.isError, true, text(later)); assert.match(text(later), /^X · xsearch · success · /);
      await pause(300);
      assert.equal(await calls(), 2, 'the cut-off request was not sent again');
      const jobs = await Promise.all((await readdir(join(space.state, 'jobs'))).filter(name => /^job-.*\.json$/.test(name)).map(async name => JSON.parse(await readFile(join(space.state, 'jobs', name), 'utf8'))));
      assert.deepEqual(jobs.map(job => job.status).sort(), ['completed', 'failed']);
      assert.match(jobs.find(job => job.status === 'failed').error, /^The service stopped while this job was running/);
    } finally { await client?.close(); await cleanup(space); }
  });
}

/**
 * A stand-in for the service on the workspace's port, answering /health as Dig of this version: `initialize` opens
 * session s<n> and names the revision `versions` gives for that handshake; any other request on a session answers
 * `gone` (a 404 with the JSON-RPC session-not-found error the service gives) or `path` (a 404 as for an unknown path).
 */
async function standIn(space, { requests, versions = [] }) {
  const seen = { initialize: 0, requests: [] };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: 'dig', version: VERSION, pid: process.pid })); return; }
    if (req.method === 'GET') { res.writeHead(405).end(); return; }
    if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
    const message = JSON.parse(body);
    if (message.method === 'initialize') {
      const n = ++seen.initialize;
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `s${n}` });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: versions[n - 1] ?? message.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'dig', version: VERSION } } }));
      return;
    }
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    seen.requests.push(`${req.headers['mcp-session-id']} ${message.method}`);
    if (requests === 'gone' && req.headers['mcp-session-id'] === 's1') { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Session not found' }, id: null })); return; }
    if (requests === 'path') { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }));
  });
  await new Promise(done => server.listen(space.port, '127.0.0.1', done));
  await writeFile(join(space.state, 'service.json'), JSON.stringify({ port: space.port, token: 'stand-in', pid: null, version: VERSION, startedAt: new Date().toISOString() }), { mode: 0o600 });
  return { seen, close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}

test('a 404 that is not a missing session is passed on as an error, and the front opens no new session for it', async () => {
  const space = await workspace('restart-path');
  const service = await standIn(space, { requests: 'path' });
  let client;
  try {
    ({ client } = await front(space, 'legacy'));
    await assert.rejects(client.listTools(), /Not found/);
    assert.equal(service.seen.initialize, 1);
    assert.deepEqual(service.seen.requests, ['s1 tools/list']);
  } finally { await client?.close(); await service.close(); await cleanup(space); }
});

test('a missing session is reopened once and the request sent again on it; a new session in another revision fails the request and asks for a restart of the connection', async () => {
  for (const versions of [[], ['2025-06-18', '2025-03-26']]) {
    const space = await workspace('restart-version');
    const service = await standIn(space, { requests: 'gone', versions });
    let client;
    try {
      ({ client } = await front(space, 'legacy'));
      if (!versions.length) {
        assert.deepEqual((await client.listTools()).tools, []);
        assert.equal(service.seen.initialize, 2);
        assert.deepEqual(service.seen.requests, ['s1 tools/list', 's2 tools/list']);
        continue;
      }
      const restart = /Dig's service restarted and now speaks MCP revision 2025-03-26, not the 2025-06-18 this connection began with\. Restart Dig's connection in the host to go on\./;
      await assert.rejects(client.listTools(), restart);
      // The connection stays refused: the client believes the first revision, and nothing more is sent.
      await assert.rejects(client.listTools(), restart);
      assert.equal(service.seen.initialize, 2);
      assert.deepEqual(service.seen.requests, ['s1 tools/list']);
    } finally { await client?.close(); await service.close(); await cleanup(space); }
  }
});
