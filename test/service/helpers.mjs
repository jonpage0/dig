// Starting the built `dig` command as child processes with an isolated state folder and a free port, and the two
// kinds of client: a 2026-07-28 client (the v2 SDK) and a 2025-era handshake client (the 1.x SDK).
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyHTTP } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport as LegacyStdio } from '@modelcontextprotocol/sdk/client/stdio.js';

export const DIG = resolve('dist/dig.mjs');
export const PRELOAD = resolve('test/service/preload.mjs');
export const MODERN = '2026-07-28';
export const node = process.env.DIG_TEST_NODE || process.execPath;

export const freePort = () => new Promise((done, fail) => { const server = createServer(); server.once('error', fail); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); }); });
export const pause = ms => new Promise(done => setTimeout(done, ms));
export async function eventually(read, message, ms = 10_000) { const end = Date.now() + ms; let value; for (;;) { value = await read(); if (value) return value; if (Date.now() > end) throw new Error(message); await pause(50); } }
export const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A temporary root with `state/` (optionally with config.toml and keys.env) and a free port. */
export async function workspace(name, { config, keys } = {}) {
  const root = await mkdtemp(join(tmpdir(), `dig-service-${name}-`));
  await mkdir(join(root, 'state'));
  if (config) await writeFile(join(root, 'state/config.toml'), config);
  if (keys) await writeFile(join(root, 'state/keys.env'), keys, { mode: 0o600 });
  const port = await freePort();
  const env = { DIG_STATE_DIR: join(root, 'state'), DIG_PORT: String(port), PATH: process.env.PATH, HOME: root };
  return { root, port, env, state: join(root, 'state'), url: new URL(`http://127.0.0.1:${port}/mcp`), serviceFile: async () => JSON.parse(await readFile(join(root, 'state/service.json'), 'utf8')) };
}
/** Runs `dig <args>` to completion and returns its output. */
export function run(space, args, env = {}) {
  return new Promise((done, fail) => {
    const child = spawn(node, ['--import', PRELOAD, DIG, ...args], { env: { ...space.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', fail); child.once('exit', code => done({ code, stdout, stderr }));
  });
}
/** Starts `dig serve` as a child process and waits until it answers and has written service.json. */
export async function startService(space, env = {}) {
  const child = spawn(node, ['--import', PRELOAD, DIG, 'serve'], { env: { ...space.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = ''; child.stderr.on('data', chunk => { log += chunk; });
  const exited = new Promise(done => child.once('exit', code => done(code)));
  const file = await eventually(async () => { try { const value = await space.serviceFile(); return value.pid === child.pid ? value : null; } catch { return null; } }, `service did not start: ${log}`);
  return { child, token: file.token, pid: child.pid, exited, log: () => log };
}
/** Stops whatever service the workspace's service.json names, and removes the workspace. */
export async function cleanup(space) {
  try { const { pid } = await space.serviceFile(); if (pid && alive(pid)) { process.kill(pid, 'SIGTERM'); await eventually(async () => !alive(pid), 'service did not stop'); } } catch {}
  await rm(space.root, { recursive: true, force: true });
}

export function modernClient(options = {}) { return new Client({ name: 'dig-test-modern', version: '1.0.0' }, { versionNegotiation: { mode: { pin: MODERN } }, ...options }); }
export const legacyClient = () => new LegacyClient({ name: 'dig-test-legacy', version: '1.0.0' });
export async function connectModern(space, token, options) { const client = modernClient(options); await client.connect(new StreamableHTTPClientTransport(space.url, { authProvider: { token: async () => token } })); return client; }
export async function connectLegacy(space, token) { const client = legacyClient(); await client.connect(new LegacyHTTP(space.url, { requestInit: { headers: { authorization: `Bearer ${token}` } } })); return client; }
/** A client of either kind connected to `dig mcp` over stdio, as a host launches it. */
export async function connectStdio(space, kind, options) {
  const params = { command: node, args: ['--import', PRELOAD, DIG, 'mcp'], env: space.env, stderr: 'pipe' };
  const client = kind === 'modern' ? modernClient(options) : legacyClient();
  await client.connect(kind === 'modern' ? new StdioClientTransport(params) : new LegacyStdio(params));
  return client;
}
/** The text block of a tool result. */
export const text = result => result.content.find(block => block.type === 'text')?.text ?? '';
