import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { VERSION } from '../../src/version.mjs';
import { alive, cleanup, eventually, run, startService, workspace } from './helpers.mjs';

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
    assert.deepEqual(await health.json(), { name: 'dig', version: VERSION, pid: service.pid });
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
