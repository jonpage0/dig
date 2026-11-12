// The `dig` command, run as `node <path>/dist/dig.mjs <command>` (nothing installs a `dig` command, and on macOS and Linux
// that name is the DNS lookup tool). `serve` runs the service; `mcp` is what a host launches: a stdio front that forwards
// every message to the service over HTTP, starting the service first when it is not running; `status` and `stop` report
// on and stop it; `open` opens the views in the default browser, for hosts that render none.
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { SdkHttpError, StreamableHTTPClientTransport, isJSONRPCErrorResponse, isJSONRPCNotification, isJSONRPCRequest, isJSONRPCResponse, isJSONRPCResultResponse, type JSONRPCMessage, type JSONRPCRequest } from '@modelcontextprotocol/client';
import { stateDirectory } from '../config.mjs';
import { VERSION } from '../version.mjs';
import { spawn } from 'node:child_process';
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

const command = process.argv[2];
if (command === 'serve') await serve();
else if (command === 'mcp') await bridge();
else if (command === 'status') await status();
else if (command === 'open') await open();
else if (command === 'stop') console.log((await stopService()) ? 'Dig stopped.' : 'Dig was not running.');
else if (command === '--version' || command === 'version') console.log(VERSION);
else { console.error(`Usage: ${digCommand()} serve | mcp | status | stop | open [--no-browser]`); process.exitCode = command ? 2 : 0; }
