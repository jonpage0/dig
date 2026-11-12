// The service: one local HTTP listener every host connects to, on 127.0.0.1 only. It serves MCP at /mcp (2026-07-28,
// stateless, through the SDK's handler; 2025-era handshake clients through sessions, so they too receive list_changed),
// GET /health without a token, and /status and /stop with it. The key page, /keys/<one-time code>, needs no token:
// a browser opens it, and its form posts back to itself and to nothing else. The views in a browser need no token
// either: a one-time /open/<code> address, which `open_library` (for a client that shows no views) and the `open`
// command ask for, gives the browser a session cookie for the pages (/, /trail, /card) and the tools they call (/api/<tool>). Its token, port, process id and version are kept in
// <state>/service.json (mode 600); the token is made once and kept, so a host configured with the URL form keeps
// working across restarts. It exits by itself after an idle period with no request in progress.
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { openSync, closeSync, watchFile, unwatchFile } from 'node:fs';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport, type McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { initializeConfig, keysPath, loadConfig, loadKeys, stateDirectory } from '../config.mjs';
import { cleanupSearchTemps } from '../search/engine.mjs';
import { VERSION } from '../version.mjs';
import { activity } from './calls.ts';
import { openJobs } from './jobs.ts';
import { createDigServer, LIBRARY_READ, SOURCE_INFO, type ServiceHooks } from './mcp.ts';
import { VIEW_TOOLS, viewPage, type ViewContext } from './views.ts';
import { keyPage, keySubmit, OPEN_CODE_MS, type PageReply } from './ask.ts';

export const DEFAULT_PORT = 47811;
const IDLE_MS = 30 * 60_000;
// 2025-era sessions that have seen no request for this long are closed; a client that comes back re-initializes.
const SESSION_MS = 24 * 60 * 60_000;
export interface ServiceFile { port: number; token: string; pid: number | null; version: string; startedAt: string | null }
export const serviceFilePath = (state = stateDirectory()) => join(state, 'service.json');
export async function readServiceFile(state = stateDirectory()): Promise<ServiceFile | null> {
  try { const value = JSON.parse(await readFile(serviceFilePath(state), 'utf8')); return value && typeof value.token === 'string' && Number.isInteger(value.port) ? value : null; } catch { return null; }
}
async function writeServiceFile(value: ServiceFile, state = stateDirectory()) {
  const path = serviceFilePath(state); const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, path);
}
/** The port: DIG_PORT, else the one service.json records, else the default. */
export const portOf = (file: ServiceFile | null, env = process.env) => { const fromEnv = Number(env.DIG_PORT); return Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536 ? fromEnv : file?.port ?? DEFAULT_PORT; };
const json = (status: number, value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const rpcError = (status: number, message: string) => json(status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });
const same = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Runs the service in this process until it is stopped or idle. Resolves once it is listening. */
export async function serve({ state = stateDirectory(), env = process.env } = {}) {
  loadKeys();
  await mkdir(state, { recursive: true });
  await initializeConfig().catch(() => {}); await cleanupSearchTemps(state).catch(() => {});
  // Before any request: a job the last service left running is marked failed, and old finished jobs are removed.
  const store = await openJobs(state);
  const previous = await readServiceFile(state);
  const port = portOf(previous, env); const token = previous?.token ?? randomBytes(32).toString('base64url');
  const idleMs = Number(env.DIG_IDLE_EXIT_MS) > 0 ? Number(env.DIG_IDLE_EXIT_MS) : IDLE_MS;
  const startedAt = new Date().toISOString();
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`]; const origins = hosts.map(host => `http://${host}`);

  type Session = { server: McpServer; sync: (c: Awaited<ReturnType<typeof loadConfig>> | null) => void; transport: WebStandardStreamableHTTPServerTransport; lastSeen: number };
  const sessions = new Map<string, Session>();
  const closeSession = (id: string) => { const session = sessions.get(id); if (!session) return; sessions.delete(id); session.server.close().catch(() => {}); };
  // Settings changed (the settings tool, or config.toml edited by hand): 2026-07-28 clients hear it on their
  // subscriptions/listen streams, and each 2025-era session lists or unlists its source tools, which sends it the
  // legacy list_changed notification. Per-request servers read settings afresh, so nothing else needs refreshing.
  const settingsChanged = (c: Awaited<ReturnType<typeof loadConfig>> | null) => { modern.notify.toolsChanged(); modern.notify.promptsChanged(); modern.notify.resourcesChanged(); for (const session of sessions.values()) session.sync(c); };
  const self = `http://127.0.0.1:${port}`;
  const browser = browserViews({ host: 'any', origin: self, settingsChanged });
  const hooks: ServiceHooks = { settingsChanged, origin: self, openAddress: () => browser.issue(self) };
  const onerror = (error: Error) => console.error(`dig: ${error.message}`);
  const modern = createMcpHandler(async context => (await createDigServer(context, hooks)).server, { legacy: 'reject', onerror });

  // A 2025-era client: its handshake opens a session with its own server instance, pinned to the legacy era.
  async function legacy(request: Request): Promise<Response> {
    const id = request.headers.get('mcp-session-id');
    if (id) {
      const session = sessions.get(id);
      if (!session) return rpcError(404, 'Session not found');
      session.lastSeen = Date.now();
      const response = await session.transport.handleRequest(request);
      if (request.method === 'DELETE') closeSession(id);
      return response;
    }
    if (request.method !== 'POST') return rpcError(400, 'Bad Request: no session');
    const { server, sync } = await createDigServer({ era: 'legacy', requestInfo: request }, hooks);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: sid => { sessions.set(sid, { server, sync, transport, lastSeen: Date.now() }); }, onsessionclosed: sid => closeSession(sid) });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    if (!transport.sessionId) await server.close().catch(() => {});
    return response;
  }

  async function route(request: Request): Promise<Response> {
    // A web page must never reach the service: the Host must be the service's own address, and a request that
    // carries an Origin must come from the service itself.
    const host = request.headers.get('host') ?? ''; const origin = request.headers.get('origin');
    if (!hosts.includes(host)) return json(403, { error: 'Forbidden host' });
    if (origin !== null && !origins.includes(origin)) return json(403, { error: 'Forbidden origin' });
    const { pathname } = new URL(request.url);
    if (pathname === '/health' && request.method === 'GET') return json(200, { name: 'dig', version: VERSION, pid: process.pid });
    const keyCode = /^\/keys\/([A-Za-z0-9_-]{1,128})$/.exec(pathname)?.[1];
    if (keyCode) return keyRoute(request, keyCode, `http://${host}`);
    if (pathname === '/' || pathname === '/trail' || pathname === '/card' || pathname.startsWith('/api/') || pathname.startsWith('/open/')) return browser.route(request, pathname, `http://${host}`);
    const auth = request.headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !same(auth.slice(7), token)) return json(401, { error: 'A valid bearer token is required' }, { 'www-authenticate': 'Bearer' });
    if (pathname === '/mcp') return (await isLegacyRequest(request)) ? legacy(request) : modern.fetch(request);
    if (pathname === '/status' && request.method === 'GET') {
      let running: unknown[] = []; try { running = activity.snapshot((await loadConfig()).library); } catch {}
      const jobs = store.running().map(job => ({ id: job.id, tool: job.tool, source: job.source, dig: job.dig, since: job.createdAt }));
      return json(200, { name: 'dig', version: VERSION, pid: process.pid, port, startedAt, running, jobs, sessions: sessions.size });
    }
    if (pathname === '/open' && request.method === 'POST') return json(200, browser.issue(self));
    if (pathname === '/stop' && request.method === 'POST') { setImmediate(() => { void shutdown('stopped'); }); return json(200, { stopping: true }); }
    return json(404, { error: 'Not found' });
  }

  // Requests in progress, open streams included: the service is idle only when there are none.
  let active = 0; let last = Date.now();
  const handler = toNodeHandler({ fetch: route });
  const http = createServer((req, res) => { active++; last = Date.now(); res.once('close', () => { active--; last = Date.now(); }); void handler(req, res); });
  await new Promise<void>((done, fail) => { http.once('error', fail); http.listen(port, '127.0.0.1', () => { http.off('error', fail); done(); }); });
  await writeServiceFile({ port, token, pid: process.pid, version: VERSION, startedAt }, state);

  const configPath = join(state, 'config.toml');
  watchFile(configPath, { persistent: false, interval: 500 }, () => { loadConfig().then(settingsChanged, () => settingsChanged(null)); });
  // Saving keys.env applies without a restart. Credentials come only from this file.
  watchFile(keysPath(), { persistent: false, interval: 500 }, () => { try { loadKeys(); } catch (e) { console.error(`Cannot reload keys.env; the previous keys stay in effect: ${e instanceof Error ? e.message : e}`); } });
  const tick = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) if (now - session.lastSeen > SESSION_MS) closeSession(id);
    // A running job keeps the service up: its result is wanted by a later job or tasks/get call.
    if (active === 0 && store.running().length === 0 && now - last >= idleMs) void shutdown('idle');
  }, Math.max(50, Math.min(idleMs / 4, 30_000)));

  let stopping = false;
  async function shutdown(reason: string) {
    if (stopping) return; stopping = true;
    console.error(`dig: service ${process.pid} exiting (${reason})`);
    clearInterval(tick); unwatchFile(configPath); unwatchFile(keysPath());
    for (const id of [...sessions.keys()]) closeSession(id);
    await modern.close().catch(() => {});
    http.close(); http.closeAllConnections();
    // The token and port stay for the next start; only the process id goes.
    const current = await readServiceFile(state);
    if (current?.pid === process.pid) await writeServiceFile({ ...current, pid: null, startedAt: null }, state).catch(() => {});
    process.exit(0);
  }
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  console.error(`dig: service ${VERSION} (pid ${process.pid}) listening on http://127.0.0.1:${port}/mcp`);
  return { port, token };
}

// ---- The key page ------------------------------------------------------------------------------------------------
// The page carries no script and loads nothing; it can be neither framed nor sent anywhere but back to itself.
const PAGE_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };
const page = ({ status, html }: PageReply) => new Response(html, { status, headers: PAGE_HEADERS });
const KEY_FORM_LIMIT = 64 * 1024;
/**
 * GET shows the page for a valid code. POST is the one route a browser may call: it takes only the code in its path,
 * and only from the page itself, so it must carry the service's own Origin (a form post always does) and, where the
 * browser says, come from the same origin. Its values are written to keys.env and never logged or echoed.
 */
async function keyRoute(request: Request, code: string, self: string): Promise<Response> {
  if (request.method === 'GET') return page(keyPage(code));
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
  const site = request.headers.get('sec-fetch-site');
  const refuse = (status: number, text: string) => page({ status, html: `<!doctype html><meta charset="utf-8"><title>Dig · Not accepted</title><p>${text}</p>` });
  if (request.headers.get('origin') !== self || (site !== null && site !== 'same-origin')) return refuse(403, 'This form is accepted only from its own page.');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return refuse(415, 'This form is accepted only as a form submission.');
  if (Number(request.headers.get('content-length') ?? 0) > KEY_FORM_LIMIT) return refuse(413, 'This form is too large.');
  const body = await request.text();
  if (body.length > KEY_FORM_LIMIT) return refuse(413, 'This form is too large.');
  return page(await keySubmit(code, new URLSearchParams(body)));
}

// ---- The views in a browser -----------------------------------------------------------------------------------------
const BROWSER_SESSION_MS = 24 * 60 * 60_000;
const API_BODY_LIMIT = 1024 * 1024;
const COOKIE = 'dig_session';
// The built page carries its scripts, styles and logos inline and calls only /api on its own origin.
const VIEW_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'" };
const line = (status: number, text: string, headers: Record<string, string> = {}) => new Response(`${text}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } });
// The command this service was started with, as a person would type it: no `dig` command is installed, and on macOS and
// Linux that name is the DNS lookup tool.
const quoted = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll('\'', '\'\\\'\'')}'`);
export const digCommand = () => `node ${quoted(resolve(process.argv[1] ?? 'dist/dig.mjs'))}`;
const needsOpen = () => `To open Dig in a browser, ask the assistant to open Dig's library, or run this in a terminal: ${digCommand()} open`;
// What /api runs: exactly the tools the views call, and never a source tool.
const API_TOOLS: Record<string, { inputSchema: { safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }; run(args: never, view: ViewContext): Promise<unknown> }> = { ...VIEW_TOOLS, source_info: SOURCE_INFO, library_read: LIBRARY_READ };
export const API_TOOL_NAMES = Object.keys(API_TOOLS);
/**
 * The pages and their tools for a browser. `issue` (for open_library, and for the `open` command with the bearer token) makes a one-time code; its
 * address sets an HttpOnly, SameSite=Strict session cookie and redirects to the library. Without that cookie every page
 * and /api route answers 401. /api takes JSON POSTs from the page's own origin only and answers with the tool's result.
 */
function browserViews(view: ViewContext) {
  const codes = new Map<string, number>(); const sessions = new Map<string, number>();
  const prune = (map: Map<string, number>) => { const now = Date.now(); for (const [key, until] of map) if (until < now) map.delete(key); };
  const session = (request: Request) => {
    const value = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim().split('=')).find(([name]) => name === COOKIE)?.[1] ?? '';
    prune(sessions); return !!value && [...sessions.keys()].some(known => same(known, value));
  };
  async function api(request: Request, name: string, self: string): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    const site = request.headers.get('sec-fetch-site');
    if (request.headers.get('origin') !== self || (site !== null && site !== 'same-origin')) return json(403, { error: 'Dig\'s views may be called only from their own page' });
    const tool = Object.hasOwn(API_TOOLS, name) ? API_TOOLS[name] : undefined;
    if (!tool) return json(404, { error: `No view tool is named ${name}` });
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json(415, { error: 'A JSON body is required' });
    const body = await request.text();
    if (body.length > API_BODY_LIMIT) return json(413, { error: 'The request is too large' });
    let input: unknown; try { input = JSON.parse(body || '{}'); } catch { return json(400, { error: 'The body is not JSON' }); }
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) return json(400, { isError: true, content: [{ type: 'text', text: `Invalid arguments for ${name}: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ')}` }] });
    return json(200, await tool.run(parsed.data as never, view), { 'cache-control': 'no-store' });
  }
  return {
    issue(origin: string) { prune(codes); const code = randomBytes(24).toString('base64url'); codes.set(code, Date.now() + OPEN_CODE_MS); return { address: `${origin}/open/${code}`, expiresAt: new Date(Date.now() + OPEN_CODE_MS).toISOString() }; },
    async route(request: Request, pathname: string, self: string): Promise<Response> {
      const code = /^\/open\/([A-Za-z0-9_-]{1,128})$/.exec(pathname)?.[1];
      if (pathname.startsWith('/open/')) {
        if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } });
        prune(codes);
        // A code works once: a wrong, used or expired one is refused alike.
        if (!code || !codes.delete(code)) return line(403, `This address is not valid or was already used. ${needsOpen()}`);
        const id = randomBytes(32).toString('base64url'); sessions.set(id, Date.now() + BROWSER_SESSION_MS);
        return new Response(null, { status: 303, headers: { location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/` } });
      }
      if (!session(request)) return line(401, needsOpen());
      if (pathname.startsWith('/api/')) return api(request, pathname.slice(5), self);
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } });
      return new Response(viewPage(pathname === '/trail' ? 'trail' : pathname === '/card' ? 'card' : 'library', true), { status: 200, headers: VIEW_HEADERS });
    },
  };
}

/** Asks the running service for a one-time address that opens the views in a browser. */
export async function openAddress(state = stateDirectory()): Promise<{ address: string; expiresAt: string }> {
  const file = await readServiceFile(state); if (!file) throw new Error('Dig\'s service is not running');
  const response = await fetch(`http://127.0.0.1:${portOf(file)}/open`, { method: 'POST', headers: { authorization: `Bearer ${file.token}` } });
  if (!response.ok) throw new Error(`Dig's service did not give an address (${response.status})`);
  return response.json() as Promise<{ address: string; expiresAt: string }>;
}

// ---- Reaching the service from another process (dig mcp, status, stop) ------------------------------------------
export async function health(port: number): Promise<{ name: string; version: string; pid: number } | null> {
  try { const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }); if (!response.ok) return null; const body = await response.json(); return body?.name === 'dig' ? body : null; } catch { return null; }
}
const older = (a: string, b: string) => { const [x, y] = [a, b].map(v => v.split(/[.-]/).map(n => Number.parseInt(n, 10) || 0)); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; };
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
async function until<T>(read: () => Promise<T | null | false>, ms: number): Promise<T | null> { const end = Date.now() + ms; for (;;) { const value = await read(); if (value) return value; if (Date.now() > end) return null; await pause(100); } }
/** Asks the running service to exit and waits until it has. */
export async function stopService(state = stateDirectory()) {
  const file = await readServiceFile(state); if (!file) return false;
  const port = portOf(file); if (!(await health(port))) return false;
  await fetch(`http://127.0.0.1:${port}/stop`, { method: 'POST', headers: { authorization: `Bearer ${file.token}` } }).catch(() => {});
  return (await until(async () => !(await health(port)), 15_000)) !== null;
}
/**
 * The running service's address and token, starting it first when none is running (detached, logging to
 * <state>/service.log) and replacing it when it runs an older version. `command` starts `dig serve`.
 */
export async function ensureService(command: { execPath: string; args: string[] }, state = stateDirectory()): Promise<{ port: number; token: string }> {
  await mkdir(state, { recursive: true });
  let file = await readServiceFile(state); const port = portOf(file);
  let running = await health(port);
  if (running && older(running.version, VERSION)) { await stopService(state); running = null; }
  if (!running) {
    const log = openSync(join(state, 'service.log'), 'a');
    const child = spawn(command.execPath, [...command.args, 'serve'], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, DIG_PORT: String(port) } });
    child.unref(); closeSync(log);
    // Two starters may race: the one that binds the port writes service.json; the other exits.
    running = await until(async () => { const seen = await health(port); file = await readServiceFile(state); return seen && file?.pid === seen.pid ? seen : null; }, 30_000);
    if (!running) throw new Error(`Dig's service did not start on port ${port}; see ${join(state, 'service.log')}`);
  }
  file = await readServiceFile(state);
  if (!file) throw new Error(`Dig's service is running on port ${port} but ${serviceFilePath(state)} is missing`);
  return { port, token: file.token };
}
