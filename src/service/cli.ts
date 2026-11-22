// The `dig` command, run as `node <path>/dist/dig.mjs <command>` (nothing installs a `dig` command, and on macOS and Linux
// that name is the DNS lookup tool). `serve` runs the service; `mcp` is what a host launches: a stdio front that forwards
// every message to the service over HTTP, starting the service first when it is not running; `status` and `stop` report
// on and stop it; `open` opens the views in the default browser, for hosts that render none.
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { SdkHttpError, StreamableHTTPClientTransport, isJSONRPCErrorResponse, isJSONRPCNotification, isJSONRPCRequest, isJSONRPCResponse, isJSONRPCResultResponse, type JSONRPCMessage, type JSONRPCRequest } from '@modelcontextprotocol/client';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { loadConfig, stateDirectory } from '../config.mjs';
import { projectFolder, readLibraryFile } from '../library.mjs';
import { ALL_MODULES, reportSources } from '../providers/modules.ts';
import { costSummary } from '../providers/library/cost.ts';
import { searchLibrary } from '../search/search.mjs';
import { costAmounts, costShort, costTotal, duration, plural, shortDate } from '../ui/format.mjs';
import { toolHistory, usageOf } from '../ui/usage.mjs';
import { VERSION } from '../version.mjs';
import { handleOf, listing, Refusal, resolveHandle } from './calls.ts';
import { ensureService, health, digCommand, openAddress, portOf, readServiceFile, serve, stopService } from './service.ts';

// How this process was started, so the service it starts runs the same code (and, in tests, the same preloads).
const self = { execPath: process.execPath, args: [...process.execArgv, process.argv[1]] };
const isConnectionRefused = (error: unknown) => { const cause = (error as { cause?: { code?: string } })?.cause; return cause?.code === 'ECONNREFUSED'; };
// A connection that broke after it was made (the service stopped under it): what was sent may have reached the service.
const isBroken = (error: unknown) => error instanceof TypeError && !isConnectionRefused(error);
type Id = string | number;
// The answer to a request whose stream ended with no response: the service stopped while it ran. A tool call may have
// sent a paid request, so it is never sent again; the job store marks its job failed, cost unknown, on the next start.
const stopped = (request: JSONRPCRequest) => `Dig's service stopped while this request was running, so it got no answer.${request.method === 'tools/call' ? ' A paid request may still have been sent: if the call had a job, the job is marked failed when the service starts again, with an unknown cost. Do not call the tool again blindly: `job` or the dig\'s receipts show what happened.' : ''}`;

/**
 * The stdio front. It forwards: messages pass through unchanged in both directions, through the SDK's own stdio
 * server transport and Streamable HTTP client transport (the SDK has no bridge of its own). Forwarding needs three
 * things of the protocol: the request id (so a cancelled request's HTTP exchange is aborted, which is cancellation on
 * 2026-07-28, and a request that gets no answer from the service still gets an error answer), the revision an
 * `initialize` answer names (sent as MCP-Protocol-Version on a 2025-era session's later requests), and the session a
 * 2025-era handshake opened (kept by the HTTP transport). The token is added here, so no host configuration holds it.
 *
 * In one place the front acts on the protocol itself: a 2025-era session lives in one service process, so when the
 * service stops and starts again (idle exit, `dig stop`, a newer version, a crash) the session is gone, and a client
 * such as Codex or ChatGPT desktop never sends `initialize` again on its own. So when the service answers a request
 * on a session with 404 and its JSON-RPC error, the front opens a new session with the client's own `initialize` and
 * `notifications/initialized`, keeps that answer from the client (it has one), and sends the request again, once. The
 * service refused it without running it, so that cannot repeat a provider request. 2026-07-28 clients hold no session.
 */
async function bridge() {
  let service = await ensureService(self);
  // A connection refused means the request never reached the service (it exited when idle): start it and send
  // once more. Any other failure is reported, never re-sent, so no provider request can be repeated.
  const forward: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); url.port = String(service.port);
    try { return await fetch(url, init); } catch (error) {
      if (!isConnectionRefused(error)) throw error;
      service = await ensureService(self); url.port = String(service.port);
      return fetch(url, init);
    }
  };
  const http = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.port}/mcp`), {
    authProvider: { token: async () => service.token, onUnauthorized: async () => { const file = await readServiceFile(); if (file) service = { port: portOf(file), token: file.token }; } },
    fetch: forward, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  const stdio = new StdioServerTransport();
  const pending = new Map<Id, AbortController>(); const initializing = new Set<Id>();
  const answer = (id: Id, message: string) => { if (!pending.delete(id)) return; void stdio.send({ jsonrpc: '2.0', id, error: { code: -32603, message } }); };
  // A request whose connection broke may have reached the service: it is answered as a stop, never sent again.
  const answerError = (request: JSONRPCRequest, error: unknown) => answer(request.id, isBroken(error) ? stopped(request) : `Dig's service could not be reached: ${error instanceof Error ? error.message : String(error)}`);

  // The client's handshake, its revision and whether it sent notifications/initialized: what a new session repeats.
  let handshake: JSONRPCRequest | undefined; let revision: string | undefined; let initialized = false;
  // Set when a new session came back in another revision: the client still believes the first, so it must reconnect.
  let reconnect: string | undefined;
  const own = new Map<Id, { done: (message: JSONRPCMessage) => void; fail: (error: Error) => void }>(); let opened = 0; let reopening: Promise<void> | undefined;
  /** Opens a new session in place of `stale`, once for every request that found it gone. */
  const reopen = (stale: string): Promise<void> => reopening ?? (http.sessionId !== stale ? Promise.resolve() : reopening = (async () => {
    const id = `dig-mcp-reopen-${++opened}`;
    const reply = new Promise<JSONRPCMessage>((done, fail) => own.set(id, { done, fail })); reply.catch(() => {});
    try { await http.send({ ...handshake!, id }, { onRequestStreamEnd: () => own.get(id)?.fail(new Error('Dig\'s service stopped before it answered a new session\'s initialize')) }); } catch (error) { own.delete(id); throw error; }
    const message = await reply;
    if (isJSONRPCErrorResponse(message)) throw new Error(message.error.message);
    const version = isJSONRPCResultResponse(message) ? message.result.protocolVersion : undefined;
    if (typeof version !== 'string' || version !== revision) {
      reconnect = `Dig's service restarted and now speaks MCP revision ${String(version)}, not the ${revision} this connection began with. Restart Dig's connection in the host to go on.`;
      await http.terminateSession().catch(() => {});
      throw new Error(reconnect);
    }
    http.setProtocolVersion(version);
    // notifications/initialized answered 202 makes the HTTP transport open the session's server-to-client stream again.
    if (initialized) await http.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  })().finally(() => { reopening = undefined; }));
  // A 404 to a request that carried a session, with the JSON-RPC error the MCP endpoint gives (its id is null, which the
  // SDK's response guard refuses): the session is gone. Any other 404 (an unknown path answers plain JSON) is a failure.
  const sessionGone = (error: unknown) => {
    if (!(error instanceof SdkHttpError) || error.status !== 404) return false;
    try { const body = JSON.parse(String(error.data.text)); return body?.jsonrpc === '2.0' && typeof body.error?.code === 'number'; } catch { return false; }
  };

  http.onmessage = message => {
    if (isJSONRPCResponse(message) && message.id !== null && message.id !== undefined) {
      const mine = own.get(message.id); if (mine) { own.delete(message.id); mine.done(message); return; }
      pending.delete(message.id);
      if (initializing.delete(message.id) && 'result' in message && typeof message.result?.protocolVersion === 'string') { http.setProtocolVersion(message.result.protocolVersion); revision = message.result.protocolVersion; }
    }
    void stdio.send(message);
  };
  // The front never reconnects a stream (maxRetries 0). A stream that ends because the service stopped or exited idle
  // is ordinary: a request that was waiting on it is answered, the next request starts the service again (and opens a
  // new session where one is needed), and only a failure there is reported. The SDK reports such endings as "Maximum
  // reconnection attempts (0) exceeded", "SSE stream disconnected" or a broken fetch, and a gone session as a 404, so
  // those say nothing.
  http.onerror = error => { if (!/^(Maximum reconnection attempts|SSE stream disconnected)/.test(error.message) && !isBroken(error) && !sessionGone(error)) console.error(`dig mcp: ${error.message}`); };
  /** Sends a client request; on a gone session, opens a new one and sends it again, once. */
  const send = (request: JSONRPCRequest, controller: AbortController, again = false) => {
    const stale = http.sessionId;
    // A stream that ends with no answer: the service stopped while the request ran. It is answered, never sent again.
    http.send(request, { requestSignal: controller.signal, onRequestStreamEnd: () => answer(request.id, stopped(request)) }).catch(async error => {
      if (controller.signal.aborted) return;
      if (!again && stale && handshake && request.method !== 'initialize' && sessionGone(error)) {
        try { await reopen(stale); } catch (failure) { answer(request.id, failure instanceof Error && failure.message === reconnect ? reconnect : `Dig's service could not open a new session: ${failure instanceof Error ? failure.message : String(failure)}`); return; }
        if (!controller.signal.aborted) send(request, controller, true);
        return;
      }
      answerError(request, error);
    });
  };
  stdio.onmessage = (message: JSONRPCMessage) => {
    if (isJSONRPCRequest(message)) {
      const controller = new AbortController(); pending.set(message.id, controller);
      if (reconnect) { answer(message.id, reconnect); return; }
      if (message.method === 'initialize') { initializing.add(message.id); handshake = message; initialized = false; }
      send(message, controller);
      return;
    }
    if (reconnect) return;
    if (isJSONRPCNotification(message) && message.method === 'notifications/initialized') initialized = true;
    if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
      const id = (message.params as { requestId?: Id } | undefined)?.requestId;
      if (id !== undefined) { pending.get(id)?.abort(); pending.delete(id); }
    }
    // A notification or answer for a session that is gone has nothing left to reach.
    http.send(message).catch(error => { if (!sessionGone(error)) console.error(`dig mcp: ${error instanceof Error ? error.message : error}`); });
  };
  let closed = false;
  stdio.onclose = () => {
    if (closed) return; closed = true;
    for (const controller of pending.values()) controller.abort();
    // A 2025-era session is ended at the service; a 2026-07-28 connection holds nothing there.
    void (http.sessionId ? http.terminateSession().catch(() => {}) : Promise.resolve()).finally(() => http.close().finally(() => process.exit(0)));
  };
  await http.start(); await stdio.start();
}

async function status() {
  const file = await readServiceFile(); const port = portOf(file); const running = await health(port);
  if (!running || !file) { console.log(`Dig is not running (port ${port}, state ${stateDirectory()}).`); return; }
  const response = await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: `Bearer ${file.token}` } });
  const info = await response.json() as { version: string; pid: number; startedAt: string; running: { tool: string; source: string; dig?: string; at: string }[]; jobs?: { id: string; tool: string; source: string; since: string }[] };
  console.log(`Dig ${info.version} is running: pid ${info.pid}, http://127.0.0.1:${port}/mcp, since ${info.startedAt}.`);
  console.log(info.running.length ? `Running calls (${info.running.length}):\n${info.running.map(call => `  ${call.tool} (${call.source})${call.dig ? ` in ${call.dig}` : ''} since ${call.at}`).join('\n')}` : 'No running calls.');
  const jobs = info.jobs ?? []; const age = (since: string) => { const s = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000)); return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`; };
  console.log(jobs.length ? `Running jobs (${jobs.length}):\n${jobs.map(job => `  ${job.id} ${job.tool} (${job.source}) for ${age(job.since)}`).join('\n')}` : 'No running jobs.');
}

/**
 * Starts the service if needed, asks it for a one-time address and opens it in the default browser (unless
 * --no-browser), printing it either way. The address works once; it gives that browser a session for the views.
 */
async function open() {
  await ensureService(self);
  const { address } = await openAddress();
  console.log(`Dig's library: ${address}\nThis address works once; run this command again for another browser.`);
  if (process.argv.includes('--no-browser')) return;
  const [file, args] = process.platform === 'darwin' ? ['open', [address]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', address]] : ['xdg-open', [address]];
  try { spawn(file, args, { detached: true, stdio: 'ignore' }).on('error', () => console.error('Could not open a browser; open the address above.')).unref(); } catch { console.error('Could not open a browser; open the address above.'); }
}

// ---- Read-only local library commands ----------------------------------------------------------------------------
class ArgError extends Error {}
const intFlag = (name: string, raw: string | undefined, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) => {
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) throw new ArgError(`--${name} must be an integer`);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ArgError(`--${name} must be between ${min} and ${max}`);
  return value;
};
const parseFlags = <T extends ParseArgsOptionsConfig>(args: string[], options: T) => {
  try { return parseArgs({ args, options, allowPositionals: true, strict: true }); } catch (error) { throw new ArgError(error instanceof Error ? error.message : String(error)); }
};
const str = (value: string | boolean | (string | boolean)[] | undefined) => (typeof value === 'string' ? value : undefined);

async function listCmd(args: string[]) {
  const { values, positionals } = parseFlags(args, {
    project: { type: 'string' }, source: { type: 'string' }, query: { type: 'string' },
    limit: { type: 'string' }, offset: { type: 'string' }, json: { type: 'boolean', default: false },
  });
  if (positionals.length) throw new ArgError(`Unexpected argument: ${positionals[0]}`);
  const limit = intFlag('limit', str(values.limit), 20, 1, 100);
  const offset = intFlag('offset', str(values.offset), 0, 0);
  const source = str(values.source);
  if (source !== undefined && !(ALL_MODULES as readonly string[]).includes(source)) throw new ArgError(`Unknown source: ${source}`);
  const projectRaw = str(values.project);
  const project = projectRaw ? resolve(projectRaw) : undefined;
  const query = str(values.query);
  const c = await loadConfig();
  const data = await listing(c);
  const needle = query?.toLowerCase();
  const items = data.items.filter(item => (!project || item.project === project) && (!source || item.sources.includes(source) || item.calls.some(call => call.source === source)) && (!needle || [item.title, item.snippet, ...item.reportDetails.map(r => r.summary)].join('\n').toLowerCase().includes(needle)));
  const live = data.live.filter(call => (!project || call.projectFolder === projectFolder(project)) && (!source || call.source === source));
  const page = items.slice(offset, offset + limit).map(item => ({ ...item, dig: handleOf(item.project, item.id) }));
  const nextOffset = offset + limit < items.length ? offset + limit : null;
  if (values.json === true) {
    console.log(JSON.stringify({ library: c.library, configPath: c.path, items: page, total: items.length, nextOffset, live: live.slice(0, limit), liveTotal: live.length }, null, 2));
    return;
  }
  console.log(`${page.length} of ${items.length} saved questions${nextOffset === null ? '' : ` (next offset ${nextOffset})`}; ${live.length} unclaimed retrievals.`);
  for (const item of page) {
    console.log(`${item.dig}  [${item.status}]  ${item.displayTitle}`);
    const cost = item.calls.length ? costShort(costSummary(item.calls), item.calls.length) : '';
    const meta = [`sources: ${item.sources.join(', ') || 'none'}`, `reports: ${item.reportDetails.length}`, `calls: ${item.calls.length}`, ...(item.startedAt ? [shortDate(item.startedAt)] : []), ...(cost ? [cost] : [])];
    console.log(`  ${meta.join(' · ')}`);
  }
}

async function readCmd(args: string[]) {
  const { values, positionals } = parseFlags(args, {
    offset: { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean', default: false },
  });
  if (positionals.length !== 1) throw new ArgError('Usage: read <file> [--offset <n>] [--limit <n>] [--json]');
  const offset = intFlag('offset', str(values.offset), 0, 0);
  const limit = intFlag('limit', str(values.limit), 60000, 1, 100000);
  const c = await loadConfig();
  const data = await readLibraryFile(c, positionals[0], offset, limit);
  if (values.json === true) { console.log(JSON.stringify(data, null, 2)); return; }
  process.stdout.write(data.text);
  if (data.nextOffset !== null) console.error(`\ndig: showing characters ${data.offset}-${data.offset + data.text.length} of ${data.totalCharacters}; continue with --offset ${data.nextOffset}`);
}

type SearchResult = {
  status: string; mode_requested: string; mode_used: string; library: string; index_revision: string | null;
  coverage: { eligible_files: number; searched_files: number; skipped_files: number; semantic_passages: number; lexical_passages: number };
  warnings: { code: string; message: string }[];
  hits: { file: string; path: string; project: string; dig: string; kind: string; source: string | null; method: string | null; title: string; question: string; at: string | null; superseded: boolean; heading: string | null; start: number; end: number; excerpt: string; score: number; matched_by: string[]; read: { file: string; offset: number; limit: number } }[];
};
const runSearch = searchLibrary as unknown as (c: Awaited<ReturnType<typeof loadConfig>>, args: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<SearchResult>;

async function searchCmd(args: string[]) {
  const { values, positionals } = parseFlags(args, {
    mode: { type: 'string' }, source: { type: 'string' }, project: { type: 'string' },
    dig: { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean', default: false },
  });
  const query = positionals.join(' ').trim();
  if (!query) throw new ArgError('Usage: search <query> [--mode hybrid|keyword] [--source <id>] [--project <dir>] [--dig <handle>] [--limit <n>] [--json]');
  const mode = str(values.mode) ?? 'hybrid';
  if (mode !== 'hybrid' && mode !== 'keyword') throw new ArgError('--mode must be hybrid or keyword');
  const source = str(values.source);
  if (source !== undefined && !(reportSources(ALL_MODULES) as readonly string[]).includes(source)) throw new ArgError(`Unknown report source: ${source}`);
  const limit = intFlag('limit', str(values.limit), 10, 1, 30);
  const c = await loadConfig();
  const projectRaw = str(values.project);
  let project = projectRaw ? resolve(projectRaw) : undefined;
  let dig: string | undefined;
  const digArg = str(values.dig);
  if (digArg) {
    let resolved;
    try { resolved = await resolveHandle(c, digArg); } catch (error) { throw new ArgError(error instanceof Refusal ? error.message : 'Invalid dig handle'); }
    if (project && project !== resolved.project) throw new ArgError('--project does not match --dig');
    project = resolved.project;
    dig = resolved.dig;
  }
  const result = await runSearch(c, { query, mode, ...(source ? { source } : {}), ...(project ? { project } : {}), ...(dig ? { dig } : {}), limit }, { signal: new AbortController().signal });
  if (values.json === true) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`${result.hits.length} hit${result.hits.length === 1 ? '' : 's'} in ${result.coverage.searched_files} of ${result.coverage.eligible_files} files (${result.status}, ${result.mode_used}).`);
  for (const warning of result.warnings) console.log(`Warning (${warning.code}): ${warning.message}`);
  for (const hit of result.hits) {
    console.log(`${hit.file} [${hit.kind}${hit.source ? `/${hit.source}` : ''}] (score ${hit.score.toFixed(3)}, offset ${hit.read.offset}, limit ${hit.read.limit})`);
    if (hit.heading) console.log(`  ## ${hit.heading}`);
    console.log(`  ${hit.excerpt.replace(/\s+/g, ' ').trim().slice(0, 240)}`);
  }
}

type UsageResult = {
  days: number; start: number; end: number; weekly: boolean; buckets: { start: number; results: number; empty: number; failed: number; total: number }[]; recorded: number;
  totals: { results: number; empty: number; failed: number; total: number; reports: number; cost: { byUnit: Record<string, number>; unknownCalls: number; freeCalls: number } };
  sources: { id: string; results: number; empty: number; failed: number; total: number; reports: number; cost: { byUnit: Record<string, number>; unknownCalls: number; freeCalls: number } }[];
};
type ToolHistoryRow = { tool: string; source: string | null; calls: number; failed: number; failureRate: number; medianMs: number | null; typicalCost: { amount: number; unit: string }[] | null; pricedCalls: number; unknownCalls: number; freeCalls: number; lastAt: string };

async function statsCmd(args: string[]) {
  const { values, positionals } = parseFlags(args, { days: { type: 'string' }, json: { type: 'boolean', default: false } });
  if (positionals.length) throw new ArgError(`Unexpected argument: ${positionals[0]}`);
  const days = intFlag('days', str(values.days), 0, 0, 36500);
  const c = await loadConfig();
  const data = await listing(c);
  const now = Date.now();
  const usage = usageOf(data, { days, now }) as UsageResult;
  const allCalls = [...data.items.flatMap(item => item.calls), ...data.live];
  const historyDays = days > 0 ? days : Math.max(1, Math.ceil(now / 86_400_000));
  const tools = toolHistory(allCalls, { days: historyDays, now }) as ToolHistoryRow[];
  if (values.json === true) {
    console.log(JSON.stringify({ library: c.library, days, questions: data.items.length, usage, tools }, null, 2));
    return;
  }
  const windowLabel = days > 0 ? `Last ${plural(days, 'day')}` : 'All time';
  console.log(`Dig library stats (${windowLabel}) · ${c.library}`);
  console.log(`Questions: ${data.items.length} · Reports: ${usage.totals.reports} · Calls: ${usage.totals.total} (${usage.totals.results} results, ${usage.totals.empty} empty, ${usage.totals.failed} failed)`);
  const totalCost = costTotal(usage.totals.cost, usage.totals.total);
  if (totalCost) console.log(`Cost: ${totalCost}`);
  if (usage.sources.length) {
    console.log('Sources:');
    for (const s of usage.sources) {
      const cost = s.total ? costShort(s.cost, s.total) : '';
      console.log(`  ${s.id}: ${plural(s.total, 'call')} (${s.results} results, ${s.empty} empty, ${s.failed} failed), ${plural(s.reports, 'report')}${cost ? ` · ${cost}` : ''}`);
    }
  }
  if (tools.length) {
    console.log('Tools:');
    for (const row of tools) {
      const typical = row.typicalCost === null ? '' : row.typicalCost.length ? costAmounts({ byUnit: Object.fromEntries(row.typicalCost.map(e => [e.unit, e.amount])) }).join(' + ') : 'no charge';
      const parts = [plural(row.calls, 'call') + (row.failed ? ` (${row.failed} failed)` : ''), ...(row.medianMs !== null ? [`median ${duration(row.medianMs)}`] : []), ...(typical ? [`typical ${typical}`] : [])];
      console.log(`  ${row.tool}: ${parts.join(' · ')}`);
    }
  }
}

async function runCliCommand(name: string, fn: () => Promise<void>) {
  try { await fn(); } catch (error) {
    console.error(`dig ${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof ArgError ? 2 : 1;
  }
}

const command = process.argv[2];
if (command === 'serve') await serve();
else if (command === 'mcp') await bridge();
else if (command === 'status') await status();
else if (command === 'open') await open();
else if (command === 'stop') console.log((await stopService()) ? 'Dig stopped.' : 'Dig was not running.');
else if (command === 'list') await runCliCommand('list', () => listCmd(process.argv.slice(3)));
else if (command === 'read') await runCliCommand('read', () => readCmd(process.argv.slice(3)));
else if (command === 'search') await runCliCommand('search', () => searchCmd(process.argv.slice(3)));
else if (command === 'stats') await runCliCommand('stats', () => statsCmd(process.argv.slice(3)));
else if (command === '--version' || command === 'version') console.log(VERSION);
else { console.error(`Usage: ${digCommand()} serve | mcp | status | stop | open [--no-browser] | list | read <file> | search <query> | stats | version`); process.exitCode = command ? 2 : 0; }
