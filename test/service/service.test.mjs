import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { stat, writeFile } from 'node:fs/promises';
import { VERSION } from '../../src/version.mjs';
import { ensureService, health as fetchHealth, servicePath, summarizeCapabilities } from '../../src/service/service.ts';
import { alive, cleanup, connectLegacy, connectModern, DIG, eventually, node, PRELOAD, run, startService, workspace } from './helpers.mjs';

const post = (space, headers = {}, path = '/mcp') => fetch(`http://127.0.0.1:${space.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
// node's fetch cannot set Host, so the wrong-Host case is sent by hand.
async function rawStatus(port, host) {
  const { connect } = await import('node:net');
  return new Promise((done, fail) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(`GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    let data = ''; socket.on('data', chunk => { data += chunk; }); socket.on('end', () => done(Number(data.split(' ')[1]))); socket.on('error', fail);
  });
}

test('/health answers without a token; /mcp refuses a missing or wrong token, a wrong Host and a foreign Origin; service.json is private', async () => {
  const space = await workspace('access');
  try {
    const service = await startService(space);
    const health = await fetch(`http://127.0.0.1:${space.port}/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.deepEqual({ name: body.name, version: body.version, pid: body.pid }, { name: 'dig', version: VERSION, pid: service.pid });
    assert.match(body.build, /^[0-9a-f]{12}$/);
    assert.equal((await stat(`${space.state}/service.json`)).mode & 0o777, 0o600);
    const file = await space.serviceFile();
    assert.deepEqual([file.port, file.pid, file.version], [space.port, service.pid, VERSION]);
    assert.match(file.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal((await post(space)).status, 401);
    assert.equal((await post(space, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post(space, { authorization: `Bearer ${service.token}`, origin: 'https://example.com' })).status, 403);
    assert.equal((await post(space, { authorization: `Bearer ${service.token}`, origin: `http://localhost:${space.port + 1}` })).status, 403);
    assert.equal(await rawStatus(space.port, `evil.example:${space.port}`), 403);
    assert.equal(await rawStatus(space.port, `127.0.0.1:${space.port + 1}`), 403);
    assert.equal(await rawStatus(space.port, `localhost:${space.port}`), 200);
    assert.equal((await fetch(`http://127.0.0.1:${space.port}/status`)).status, 401);
    // The service's own origin is allowed, and a valid token gets an MCP answer.
    const allowed = await post(space, { authorization: `Bearer ${service.token}`, origin: `http://127.0.0.1:${space.port}` });
    assert.notEqual(allowed.status, 401); assert.notEqual(allowed.status, 403);
  } finally { await cleanup(space); }
});

test('the service exits when idle and keeps its token for the next start; dig status reports it and dig stop stops it', async () => {
  const space = await workspace('lifecycle');
  try {
    const first = await startService(space, { DIG_IDLE_EXIT_MS: '600' });
    assert.equal(await first.exited, 0, 'exits by itself when idle');
    const after = await space.serviceFile();
    assert.equal(after.pid, null); assert.equal(after.token, first.token);
    assert.match((await run(space, ['status'])).stdout, /Dig is not running/);

    const second = await startService(space);
    assert.equal(second.token, first.token, 'the token is made once and kept');
    const status = await run(space, ['status']);
    assert.match(status.stdout, new RegExp(`Dig ${VERSION.replaceAll('.', '\\.')} is running: pid ${second.pid}, http://127\\.0\\.0\\.1:${space.port}/mcp`));
    assert.match(status.stdout, /No running calls\./);
    const stopped = await run(space, ['stop']);
    assert.equal(stopped.code, 0); assert.match(stopped.stdout, /Dig stopped\./);
    assert.equal(await second.exited, 0);
    assert.equal(alive(second.pid), false);
    assert.match((await run(space, ['stop'])).stdout, /Dig was not running\./);
  } finally { await cleanup(space); }
});

test('dig serve refuses to start a second service on a port in use', async () => {
  const space = await workspace('port');
  try {
    const service = await startService(space);
    const second = await run(space, ['serve']);
    assert.notEqual(second.code, 0);
    assert.match(second.stderr, /EADDRINUSE/);
    assert.equal((await space.serviceFile()).pid, service.pid);
    await eventually(async () => alive(service.pid), 'the first service keeps running');
  } finally { await cleanup(space); }
});

test('servicePath appends missing standard POSIX directories after user PATH without duplicates, and leaves Windows PATH untouched', () => {
  const home = homedir();
  const expected = [join(home, '.local', 'bin'), join(home, '.cargo', 'bin'), join(home, '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  assert.deepEqual(servicePath('', 'darwin').split(delimiter), expected);
  const custom = ['/custom/bin', '/usr/local/bin', join(home, '.local', 'bin')].join(delimiter);
  const normalized = servicePath(custom, 'darwin').split(delimiter);
  assert.equal(normalized[0], '/custom/bin', 'preserves user PATH ahead of standard directories');
  assert.equal(normalized.filter(d => d === '/usr/local/bin').length, 1, 'does not duplicate existing entries');
  assert.equal(normalized.filter(d => d === join(home, '.local', 'bin')).length, 1);
  for (const dir of expected) assert.ok(normalized.includes(dir), `missing ${dir}`);
  assert.equal(servicePath('/custom/bin', 'win32'), '/custom/bin', 'never appends POSIX directories on Windows');
});

test('summarizeCapabilities sanitizes control characters and bounds long or numerous capability keys', () => {
  const dirty = { extensions: { ['bad\r\nkey\t' + 'x'.repeat(100)]: {}, ok: {} } };
  const summary = summarizeCapabilities(dirty);
  assert.doesNotMatch(summary, /[\r\n\t]/);
  assert.match(summary, /ext:ok/);
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`cap_${String(i).padStart(2, '0')}`, true]));
  assert.match(summarizeCapabilities(many), /\.\.\. \(\+8\)$/);
});

async function standInHealthServer(space, { build, status, statusCode = 200, stopCode = 200 }) {
  let stopped = false;
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'dig', version: VERSION, ...(build ? { build } : {}), pid: process.pid }));
      return;
    }
    if (pathname === '/status' && req.method === 'GET') {
      res.writeHead(statusCode, { 'content-type': 'application/json' });
      res.end(JSON.stringify(statusCode === 200 ? { name: 'dig', version: VERSION, pid: process.pid, port: space.port, running: status.running ?? [], jobs: status.jobs ?? [], pendingPrompts: status.pendingPrompts === true, sessions: 0 } : { error: 'unavailable' }));
      return;
    }
    if (pathname === '/stop' && req.method === 'POST') {
      if (stopCode !== 200) {
        res.writeHead(stopCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ stopping: false, busy: true }));
        return;
      }
      stopped = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stopping: true }));
      setImmediate(() => { server.closeAllConnections(); server.close(); });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(done => server.listen(space.port, '127.0.0.1', done));
  await writeFile(join(space.state, 'service.json'), JSON.stringify({ port: space.port, token: 'stand-in-token', pid: null, version: VERSION, startedAt: new Date().toISOString() }), { mode: 0o600 });
  return { wasStopped: () => stopped, close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); }) };
}

test('ensureService replaces an idle service on build mismatch, and refuses to stop one with active work, pending prompts, failed status, or a busy /stop race', async () => {
  // (a) Idle service with a mismatched build is replaced.
  const idleSpace = await workspace('build-replace');
  const idleStandIn = await standInHealthServer(idleSpace, { build: '000000000000', status: { running: [], jobs: [] } });
  try {
    const started = await ensureService({ execPath: node, args: ['--import', PRELOAD, DIG] }, idleSpace.state);
    assert.equal(idleStandIn.wasStopped(), true, 'idle mismatched service is stopped');
    assert.equal(started.port, idleSpace.port);
    const live = await fetchHealth(idleSpace.port);
    assert.ok(live && live.pid !== process.pid, 'replaced with a newly started service');
    assert.match(live.build ?? '', /^[0-9a-f]{12}$/);
    assert.notEqual(live.build, '000000000000');
  } finally {
    await idleStandIn.close();
    await cleanup(idleSpace);
  }

  // (b) Service with active work, pending prompts, /status failure, or 409 /stop?ifIdle=1 race is NOT killed.
  for (const [label, opts] of [
    ['active-job', { status: { running: [], jobs: [{ id: 'job-active', tool: 'xsearch', source: 'x', dig: 'p/d', since: new Date().toISOString() }] } }],
    ['active-call', { status: { running: [{ tool: 'hackernews', source: 'hackernews', at: new Date().toISOString() }], jobs: [] } }],
    ['pending-prompt', { status: { running: [], jobs: [], pendingPrompts: true } }],
    ['status-error', { status: {}, statusCode: 500 }],
    ['busy-stop-race', { status: { running: [], jobs: [] }, stopCode: 409 }],
  ]) {
    const busySpace = await workspace(`build-${label}`);
    const busyStandIn = await standInHealthServer(busySpace, { build: '000000000000', ...opts });
    try {
      const kept = await ensureService({ execPath: node, args: ['--import', PRELOAD, DIG] }, busySpace.state);
      assert.equal(busyStandIn.wasStopped(), false, `${label} prevents stopping the running service`);
      assert.deepEqual(kept, { port: busySpace.port, token: 'stand-in-token' });
      const live = await fetchHealth(busySpace.port);
      assert.equal(live?.build, '000000000000', 'running stand-in stays untouched');
    } finally {
      await busyStandIn.close();
      await cleanup(busySpace);
    }
  }
});

test('POST /stop?ifIdle=1 refuses with 409 while a key page is open, and succeeds once idle', async () => {
  const space = await workspace('stop-if-idle', { config: '[sources]\nenabled = ["exa"]\n' });
  let client;
  try {
    const service = await startService(space);
    client = await connectModern(space, service.token);
    const opened = await client.callTool({ name: 'keys', arguments: { source: 'exa' } });
    assert.ok(opened.structuredContent.address, 'key page opened');
    const busyStatus = await (await fetch(`http://127.0.0.1:${space.port}/status`, { headers: { authorization: `Bearer ${service.token}` } })).json();
    assert.equal(busyStatus.pendingPrompts, true);
    const refusedStop = await fetch(`http://127.0.0.1:${space.port}/stop?ifIdle=1`, { method: 'POST', headers: { authorization: `Bearer ${service.token}` } });
    assert.equal(refusedStop.status, 409);
    assert.equal(alive(service.pid), true);
    // Submitting the empty key form marks the code used, making the service idle again.
    const submit = await fetch(opened.structuredContent.address, {
      method: 'POST',
      headers: { origin: `http://127.0.0.1:${space.port}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    assert.equal(submit.status, 200);
    const okStop = await fetch(`http://127.0.0.1:${space.port}/stop?ifIdle=1`, { method: 'POST', headers: { authorization: `Bearer ${service.token}` } });
    assert.equal(okStop.status, 200);
    assert.equal(await service.exited, 0);
  } finally {
    await client?.close();
    await cleanup(space);
  }
});

test('the service logs each unique client name and capabilities once without logging tokens', async () => {
  const space = await workspace('client-log');
  let modern; let legacy;
  try {
    const service = await startService(space);
    modern = await connectModern(space, service.token);
    await modern.listTools();
    await modern.listTools();
    legacy = await connectLegacy(space, service.token);
    await legacy.listTools();
    await eventually(async () => /dig: client legacy dig-test-legacy\/1\.0\.0 capabilities=\[none\]/.test(service.log()), 'legacy client log missing');
    const log = service.log();
    assert.match(log, /dig: client modern dig-test-modern\/1\.0\.0 capabilities=\[/);
    assert.equal(log.match(/dig: client legacy dig-test-legacy\/1\.0\.0 capabilities=\[none\]/g)?.length, 1, 'deduplicated per unique tuple');
    assert.doesNotMatch(log, new RegExp(service.token), 'never logs bearer token');
  } finally {
    await modern?.close();
    await legacy?.close();
    await cleanup(space);
  }
});
