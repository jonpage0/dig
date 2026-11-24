// Dig 2.0 CLI entrypoint built on Effect 4.1.5 `effect/cli` (`Command`, `Flag`, `Argument`) + `NodeServices.layer`.
// Subcommands: `serve`, `mcp` (rock-solid stdio<->HTTP bridge), `setup`, `open`, `status`, `stop`,
// `list`, `read`, `search`, `stats`, `version`.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Console, Effect, Option } from "effect";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  SdkHttpError,
  StreamableHTTPClientTransport,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResponse,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type JSONRPCRequest,
} from "@modelcontextprotocol/client";
import { ConfigService, stateDirectory } from "../core/config.ts";
import { costSummary } from "../core/cost.ts";
import { LibraryService, handleOf, projectFolder } from "../core/library.ts";
import { bootDigRuntime } from "../core/runtime.ts";
import { SearchService, type SearchMode } from "../core/search.ts";
import { SETUP_PRESETS } from "../core/setup.ts";
import { ACCOUNTS, ALL_SOURCE_IDS, SOURCES, reportSourceIds } from "../sources/index.ts";
import { costAmounts, costShort, costTotal, duration, plural, shortDate } from "../ui/format.ts";
import { toolHistory, usageOf } from "../ui/usage.ts";
import { VERSION } from "../version.ts";
import {
  ensureService,
  health,
  openAddress,
  portOf,
  readServiceFile,
  serve,
  stopService,
} from "./daemon.ts";
import { runSetupWizard } from "./setup-tui.ts";

// How this process was started, so spawning `dig serve` uses the exact same entrypoint and preloads.
const selfCommand = () => ({
  execPath: process.execPath,
  args: [...process.execArgv, process.argv[1]],
});

const isConnectionRefused = (error: unknown): boolean => {
  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  return cause?.code === "ECONNREFUSED";
};

// A connection that broke after being opened: the request may already have reached the daemon.
const isBrokenConnection = (error: unknown): boolean =>
  error instanceof TypeError && !isConnectionRefused(error);

type JsonRpcId = string | number;

const stoppedMessage = (request: JSONRPCRequest): string =>
  `Dig's service stopped while this request was running, so it got no answer.${
    request.method === "tools/call"
      ? " A paid request may still have been sent: if the call had a job, the job is marked failed when the service starts again, with an unknown cost. Do not call the tool again blindly: `job` or the dig's receipts show what happened."
      : ""
  }`;

/**
 * Rock-solid stdio <-> localhost HTTP MCP bridge:
 * - Auto-starts the daemon via `ensureService`
 * - Never retries a paid request whose stream broke after connecting
 * - Transparently reopens expired 2025-era sessions on 404 JSON-RPC error (once)
 */
export async function runStdioBridge(): Promise<void> {
  let service = await ensureService(selfCommand());

  const forward: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    url.port = String(service.port);
    try {
      return await fetch(url, init);
    } catch (error) {
      if (!isConnectionRefused(error)) throw error;
      service = await ensureService(selfCommand());
      url.port = String(service.port);
      return fetch(url, init);
    }
  };

  const http = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.port}/mcp`), {
    authProvider: {
      token: async () => service.token,
      onUnauthorized: async () => {
        const file = await readServiceFile();
        if (file) service = { port: portOf(file), token: file.token };
      },
    },
    fetch: forward,
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  });

  const stdio = new StdioServerTransport();
  const pending = new Map<JsonRpcId, AbortController>();
  const initializing = new Set<JsonRpcId>();

  const answer = (id: JsonRpcId, message: string) => {
    if (!pending.delete(id)) return;
    void stdio.send({ jsonrpc: "2.0", id, error: { code: -32603, message } });
  };

  const answerError = (request: JSONRPCRequest, error: unknown) =>
    answer(
      request.id,
      isBrokenConnection(error)
        ? stoppedMessage(request)
        : `Dig's service could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );

  let handshake: JSONRPCRequest | undefined;
  let revision: string | undefined;
  let initialized = false;
  let reconnect: string | undefined;
  const own = new Map<
    JsonRpcId,
    { done: (message: JSONRPCMessage) => void; fail: (error: Error) => void }
  >();
  let opened = 0;
  let reopening: Promise<void> | undefined;

  const reopen = (stale: string): Promise<void> =>
    reopening ??
    (http.sessionId !== stale
      ? Promise.resolve()
      : (reopening = (async () => {
          const id = `dig-mcp-reopen-${++opened}`;
          const reply = new Promise<JSONRPCMessage>((done, fail) => own.set(id, { done, fail }));
          reply.catch(() => {});
          try {
            await http.send(
              { ...handshake!, id },
              {
                onRequestStreamEnd: () =>
                  own
                    .get(id)
                    ?.fail(
                      new Error("Dig's service stopped before it answered a new session's initialize"),
                    ),
              },
            );
          } catch (error) {
            own.delete(id);
            throw error;
          }
          const message = await reply;
          if (isJSONRPCErrorResponse(message)) throw new Error(message.error.message);
          const version = isJSONRPCResultResponse(message)
            ? (message.result as { protocolVersion?: unknown }).protocolVersion
            : undefined;
          if (typeof version !== "string" || version !== revision) {
            reconnect = `Dig's service restarted and now speaks MCP revision ${String(version)}, not the ${revision} this connection began with. Restart Dig's connection in the host to go on.`;
            await http.terminateSession().catch(() => {});
            throw new Error(reconnect);
          }
          http.setProtocolVersion(version);
          if (initialized) await http.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        })().finally(() => {
          reopening = undefined;
        })));

  const sessionGone = (error: unknown): boolean => {
    if (!(error instanceof SdkHttpError) || error.status !== 404) return false;
    try {
      const body = JSON.parse(String(error.data.text)) as {
        jsonrpc?: string;
        error?: { code?: unknown };
      };
      return body?.jsonrpc === "2.0" && typeof body.error?.code === "number";
    } catch {
      return false;
    }
  };

  http.onmessage = (message) => {
    if (isJSONRPCResponse(message) && message.id !== null && message.id !== undefined) {
      const mine = own.get(message.id);
      if (mine) {
        own.delete(message.id);
        mine.done(message);
        return;
      }
      pending.delete(message.id);
      if (
        initializing.delete(message.id) &&
        "result" in message &&
        typeof (message.result as { protocolVersion?: unknown })?.protocolVersion === "string"
      ) {
        const pv = (message.result as { protocolVersion: string }).protocolVersion;
        http.setProtocolVersion(pv);
        revision = pv;
      }
    }
    void stdio.send(message);
  };

  http.onerror = (error) => {
    if (
      !/^(Maximum reconnection attempts|SSE stream disconnected)/.test(error.message) &&
      !isBrokenConnection(error) &&
      !sessionGone(error)
    ) {
      console.error(`dig mcp: ${error.message}`);
    }
  };

  const send = (request: JSONRPCRequest, controller: AbortController, again = false) => {
    const stale = http.sessionId;
    http
      .send(request, {
        requestSignal: controller.signal,
        onRequestStreamEnd: () => answer(request.id, stoppedMessage(request)),
      })
      .catch(async (error) => {
        if (controller.signal.aborted) return;
        if (!again && stale && handshake && request.method !== "initialize" && sessionGone(error)) {
          try {
            await reopen(stale);
          } catch (failure) {
            answer(
              request.id,
              failure instanceof Error && failure.message === reconnect
                ? reconnect
                : `Dig's service could not open a new session: ${failure instanceof Error ? failure.message : String(failure)}`,
            );
            return;
          }
          if (!controller.signal.aborted) send(request, controller, true);
          return;
        }
        answerError(request, error);
      });
  };

  stdio.onmessage = (message: JSONRPCMessage) => {
    if (isJSONRPCRequest(message)) {
      const controller = new AbortController();
      pending.set(message.id, controller);
      if (reconnect) {
        answer(message.id, reconnect);
        return;
      }
      if (message.method === "initialize") {
        initializing.add(message.id);
        handshake = message;
        initialized = false;
      }
      send(message, controller);
      return;
    }
    if (reconnect) return;
    if (isJSONRPCNotification(message) && message.method === "notifications/initialized") {
      initialized = true;
    }
    if (isJSONRPCNotification(message) && message.method === "notifications/cancelled") {
      const id = (message.params as { requestId?: JsonRpcId } | undefined)?.requestId;
      if (id !== undefined) {
        pending.get(id)?.abort();
        pending.delete(id);
      }
    }
    http.send(message).catch((error) => {
      if (!sessionGone(error)) {
        console.error(`dig mcp: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };

  await new Promise<void>((resolveDone, rejectDone) => {
    let closed = false;
    stdio.onclose = () => {
      if (closed) return;
      closed = true;
      for (const controller of pending.values()) controller.abort();
      void (http.sessionId ? http.terminateSession().catch(() => {}) : Promise.resolve())
        .finally(() => http.close().catch(() => {}))
        .finally(() => resolveDone());
    };
    void http.start().then(() => stdio.start()).catch(rejectDone);
  });
}

// ---- Helper to run a read-only local library command using DigManagedRuntime ----

async function withLocalRuntime<A>(
  fn: (rt: Awaited<ReturnType<typeof bootDigRuntime>>) => Promise<A>,
): Promise<A> {
  const rt = await bootDigRuntime({
    plugins: SOURCES,
    accounts: ACCOUNTS,
    loadKeys: false,
  });
  try {
    return await fn(rt);
  } finally {
    await rt.dispose();
  }
}

const userFail = (message: string, cause?: unknown) =>
  Effect.fail(new CliError.UserError({ cause: cause ?? new Error(message), userMessage: message }));

const tryUser = <A>(fn: () => Promise<A>): Effect.Effect<A, CliError.UserError> =>
  Effect.tryPromise({
    try: fn,
    catch: (e) =>
      new CliError.UserError({
        cause: e,
        userMessage: e instanceof Error ? e.message : String(e),
      }),
  });

// ---- Subcommands built on `effect/cli` ----

const serveCmd = Command.make(
  "serve",
  {
    port: Flag.Int("port").pipe(
      Flag.withDescription("Local TCP port to bind on 127.0.0.1."),
      Flag.optional,
    ),
  },
  ({ port }) =>
    tryUser(async () => {
      const running = await serve({
        ...(Option.isSome(port) ? { port: port.value } : {}),
      });
      await running.waitForStop;
    }),
).pipe(Command.withDescription("Run the local Dig HTTP/MCP/SPA daemon."));

const mcpCmd = Command.make("mcp", {}, () => tryUser(() => runStdioBridge())).pipe(
  Command.withDescription("Run the stdio-to-HTTP MCP bridge for host integrations."),
);

const setupCmd = Command.make(
  "setup",
  {
    preset: Flag.Literals(
      "preset",
      Object.keys(SETUP_PRESETS) as [string, ...string[]],
    ).pipe(
      Flag.withDescription("Apply a source preset non-interactively (starter, research, social, all)."),
      Flag.optional,
    ),
  },
  ({ preset }) =>
    runSetupWizard({
      ...(Option.isSome(preset) ? { preset: preset.value } : {}),
    }),
).pipe(Command.withDescription("Configure enabled sources, API keys (0600), and spend caps."));

const openCmd = Command.make(
  "open",
  {
    path: Flag.String("path").pipe(
      Flag.withDescription("SPA route to open (e.g. /, /setup, /trail, /sources, /settings)."),
      Flag.withDefault("/"),
    ),
    noBrowser: Flag.Boolean("no-browser").pipe(
      Flag.withDescription("Print the one-time URL without launching a browser."),
      Flag.withDefault(false),
    ),
  },
  ({ path, noBrowser }) =>
    tryUser(async () => {
      await ensureService(selfCommand());
      const { address } = await openAddress(stateDirectory(), { path });
      console.log(
        `Dig web app: ${address}\nThis address works once; run this command again for another browser.`,
      );
      if (noBrowser) return;
      const [file, args] =
        process.platform === "darwin"
          ? ["open", [address]]
          : process.platform === "win32"
            ? ["cmd", ["/c", "start", '""', address]]
            : ["xdg-open", [address]];
      try {
        spawn(file, args, { detached: true, stdio: "ignore" })
          .on("error", () => console.error("Could not open a browser; open the address above."))
          .unref();
      } catch {
        console.error("Could not open a browser; open the address above.");
      }
    }),
).pipe(Command.withDescription("Open the Dig localhost web app in your default browser."));

const statusCmd = Command.make("status", {}, () =>
  tryUser(async () => {
    const file = await readServiceFile();
    const port = portOf(file);
    const running = await health(port);
    if (!running || !file) {
      console.log(`Dig is not running (port ${port}, state ${stateDirectory()}).`);
      return;
    }
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { authorization: `Bearer ${file.token}` },
    });
    if (!response.ok) {
      throw new Error(`Dig status check failed with HTTP ${response.status}`);
    }
    const info = (await response.json()) as {
      version: string;
      pid: number;
      startedAt: string;
      activeCalls?: { tool: string; source: string; dig?: string; startedAt: string }[];
      runningJobs?: { id: string; tool: string; source: string; createdAt: string }[];
    };
    console.log(
      `Dig ${info.version} is running: pid ${info.pid}, http://127.0.0.1:${port}/mcp, since ${info.startedAt}.`,
    );
    const active = info.activeCalls ?? [];
    console.log(
      active.length
        ? `Active calls (${active.length}):\n${active.map((c) => `  ${c.tool} (${c.source})${c.dig ? ` in ${c.dig}` : ""} since ${c.startedAt}`).join("\n")}`
        : "No active calls.",
    );
    const jobs = info.runningJobs ?? [];
    const age = (since: string) => {
      const s = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
      return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
    };
    console.log(
      jobs.length
        ? `Running jobs (${jobs.length}):\n${jobs.map((j) => `  ${j.id} ${j.tool} (${j.source}) for ${age(j.createdAt)}`).join("\n")}`
        : "No running jobs.",
    );
  }),
).pipe(Command.withDescription("Show whether the local Dig service is running and active jobs."));

const stopCmd = Command.make("stop", {}, () =>
  tryUser(async () => {
    const stopped = await stopService();
    console.log(stopped ? "Dig stopped." : "Dig was not running.");
  }),
).pipe(Command.withDescription("Stop the running local Dig service."));

const listCmd = Command.make(
  "list",
  {
    project: Flag.String("project").pipe(Flag.withDescription("Filter by project directory."), Flag.optional),
    source: Flag.String("source").pipe(Flag.withDescription("Filter by source id."), Flag.optional),
    query: Flag.String("query").pipe(Flag.withDescription("Match title or summary text."), Flag.optional),
    limit: Flag.Int("limit").pipe(Flag.withDefault(20)),
    offset: Flag.Int("offset").pipe(Flag.withDefault(0)),
    json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
  },
  ({ project, source, query, limit, offset, json }) =>
    Effect.gen(function* () {
      if (limit < 1 || limit > 100) return yield* userFail("--limit must be between 1 and 100");
      if (offset < 0) return yield* userFail("--offset must be >= 0");
      const src = Option.getOrUndefined(source);
      if (src !== undefined && !ALL_SOURCE_IDS.includes(src)) {
        return yield* userFail(`Unknown source: ${src}`);
      }
      const proj = Option.isSome(project) ? resolve(project.value) : undefined;
      const needle = Option.getOrUndefined(query)?.toLowerCase();

      yield* tryUser(() =>
        withLocalRuntime(async (rt) => {
          const { cfg, data } = await rt.runPromise(
            Effect.gen(function* () {
              const c = yield* ConfigService;
              const lib = yield* LibraryService;
              return { cfg: yield* c.load(), data: yield* lib.listLibrary() };
            }),
          );
          const items = data.items.filter(
            (item) =>
              (!proj || item.project === proj) &&
              (!src ||
                item.sources.includes(src) ||
                item.calls.some((call) => call.source === src)) &&
              (!needle ||
                [item.title, item.snippet, ...item.reportDetails.map((r) => r.summary)]
                  .join("\n")
                  .toLowerCase()
                  .includes(needle)),
          );
          const live = data.live.filter(
            (call) =>
              (!proj || call.projectFolder === projectFolder(proj)) &&
              (!src || call.source === src),
          );
          const page = items
            .slice(offset, offset + limit)
            .map((item) => ({ ...item, dig: handleOf(item.project, item.id) }));
          const nextOffset = offset + limit < items.length ? offset + limit : null;

          if (json) {
            console.log(
              JSON.stringify(
                {
                  library: cfg.library,
                  configPath: cfg.path,
                  items: page,
                  total: items.length,
                  nextOffset,
                  live: live.slice(0, limit),
                  liveTotal: live.length,
                },
                null,
                2,
              ),
            );
            return;
          }
          console.log(
            `${page.length} of ${items.length} saved questions${nextOffset === null ? "" : ` (next offset ${nextOffset})`}; ${live.length} unclaimed retrievals.`,
          );
          for (const item of page) {
            console.log(`${item.dig}  [${item.status}]  ${item.displayTitle}`);
            const cost = item.calls.length
              ? costShort(costSummary(item.calls), item.calls.length)
              : "";
            const meta = [
              `sources: ${item.sources.join(", ") || "none"}`,
              `reports: ${item.reportDetails.length}`,
              `calls: ${item.calls.length}`,
              ...(item.startedAt ? [shortDate(item.startedAt)] : []),
              ...(cost ? [cost] : []),
            ];
            console.log(`  ${meta.join(" · ")}`);
          }
        }),
      );
    }),
).pipe(Command.withDescription("List saved research digs in the local library."));

const readCmd = Command.make(
  "read",
  {
    file: Argument.String("file").pipe(Argument.withDescription("Library-relative or absolute file path.")),
    offset: Flag.Int("offset").pipe(Flag.withDefault(0)),
    limit: Flag.Int("limit").pipe(Flag.withDefault(60_000)),
    json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
  },
  ({ file, offset, limit, json }) =>
    Effect.gen(function* () {
      if (offset < 0) return yield* userFail("--offset must be >= 0");
      if (limit < 1 || limit > 100_000) return yield* userFail("--limit must be between 1 and 100000");

      yield* tryUser(() =>
        withLocalRuntime(async (rt) => {
          const data = await rt.runPromise(
            Effect.flatMap(LibraryService, (lib) => lib.readFile(file, offset, limit)),
          );
          if (json) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          process.stdout.write(data.text);
          if (data.nextOffset !== null) {
            console.error(
              `\ndig: showing characters ${data.offset}-${data.offset + data.text.length} of ${data.totalCharacters}; continue with --offset ${data.nextOffset}`,
            );
          }
        }),
      );
    }),
).pipe(Command.withDescription("Read a report, answer, receipt, or raw file from the library."));

const searchCmd = Command.make(
  "search",
  {
    query: Argument.String("query").pipe(
      Argument.withDescription("Search query terms."),
      Argument.variadic({ min: 1 }),
    ),
    mode: Flag.Literals("mode", ["hybrid", "keyword"]).pipe(Flag.withDefault("hybrid")),
    source: Flag.String("source").pipe(Flag.optional),
    project: Flag.String("project").pipe(Flag.optional),
    dig: Flag.String("dig").pipe(Flag.optional),
    limit: Flag.Int("limit").pipe(Flag.withDefault(10)),
    json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
  },
  ({ query, mode, source, project, dig, limit, json }) =>
    Effect.gen(function* () {
      const q = query.join(" ").trim();
      if (!q) return yield* userFail("A non-empty search query is required");
      if (limit < 1 || limit > 30) return yield* userFail("--limit must be between 1 and 30");
      const src = Option.getOrUndefined(source);
      if (src !== undefined && !reportSourceIds(ALL_SOURCE_IDS).includes(src)) {
        return yield* userFail(`Unknown report source: ${src}`);
      }
      const proj = Option.isSome(project) ? resolve(project.value) : undefined;
      const digHandle = Option.getOrUndefined(dig);

      yield* tryUser(() =>
        withLocalRuntime(async (rt) => {
          const result = await rt.runPromise(
            Effect.flatMap(SearchService, (svc) =>
              svc.search({
                query: q,
                mode: mode as SearchMode,
                ...(src ? { source: src } : {}),
                ...(proj ? { project: proj } : {}),
                ...(digHandle ? { dig: digHandle } : {}),
                limit,
              }),
            ),
          );
          if (json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          console.log(
            `${result.hits.length} hit${result.hits.length === 1 ? "" : "s"} in ${result.coverage.searched_files} of ${result.coverage.eligible_files} files (${result.status}, ${result.mode_used}).`,
          );
          for (const w of result.warnings) console.log(`Warning (${w.code}): ${w.message}`);
          for (const hit of result.hits) {
            console.log(
              `${hit.file} [${hit.kind}${hit.source ? `/${hit.source}` : ""}] (score ${hit.score.toFixed(3)}, offset ${hit.read.offset}, limit ${hit.read.limit})`,
            );
            if (hit.heading) console.log(`  ## ${hit.heading}`);
            console.log(`  ${hit.excerpt.replace(/\s+/g, " ").trim().slice(0, 240)}`);
          }
        }),
      );
    }),
).pipe(Command.withDescription("Search inside saved reports and answers (SQLite FTS5 + optional ONNX)."));

const statsCmd = Command.make(
  "stats",
  {
    days: Flag.Int("days").pipe(Flag.withDefault(0)),
    json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
  },
  ({ days, json }) =>
    Effect.gen(function* () {
      if (days < 0 || days > 36500) return yield* userFail("--days must be between 0 and 36500");

      yield* tryUser(() =>
        withLocalRuntime(async (rt) => {
          const { cfg, data } = await rt.runPromise(
            Effect.gen(function* () {
              const c = yield* ConfigService;
              const lib = yield* LibraryService;
              return { cfg: yield* c.load(), data: yield* lib.listLibrary() };
            }),
          );
          const now = Date.now();
          const usage = usageOf(data, { days, now });
          const allCalls = [...data.items.flatMap((i) => i.calls), ...data.live];
          const historyDays = days > 0 ? days : Math.max(1, Math.ceil(now / 86_400_000));
          const tools = toolHistory(allCalls, { days: historyDays, now });

          if (json) {
            console.log(
              JSON.stringify(
                { library: cfg.library, days, questions: data.items.length, usage, tools },
                null,
                2,
              ),
            );
            return;
          }
          const windowLabel = days > 0 ? `Last ${plural(days, "day")}` : "All time";
          console.log(`Dig library stats (${windowLabel}) · ${cfg.library}`);
          console.log(
            `Questions: ${data.items.length} · Reports: ${usage.totals.reports} · Calls: ${usage.totals.total} (${usage.totals.results} results, ${usage.totals.empty} empty, ${usage.totals.failed} failed)`,
          );
          const totalCost = costTotal(usage.totals.cost, usage.totals.total);
          if (totalCost) console.log(`Cost: ${totalCost}`);
          if (usage.sources.length) {
            console.log("Sources:");
            for (const s of usage.sources) {
              const cost = s.total ? costShort(s.cost, s.total) : "";
              console.log(
                `  ${s.id}: ${plural(s.total, "call")} (${s.results} results, ${s.empty} empty, ${s.failed} failed), ${plural(s.reports, "report")}${cost ? ` · ${cost}` : ""}`,
              );
            }
          }
          if (tools.length) {
            console.log("Tools:");
            for (const row of tools) {
              const typical =
                row.typicalCost === null
                  ? ""
                  : row.typicalCost.length
                    ? costAmounts({
                        byUnit: Object.fromEntries(row.typicalCost.map((e) => [e.unit, e.amount])),
                      }).join(" + ")
                    : "no charge";
              const parts = [
                plural(row.calls, "call") + (row.failed ? ` (${row.failed} failed)` : ""),
                ...(row.medianMs !== null ? [`median ${duration(row.medianMs)}`] : []),
                ...(typical ? [`typical ${typical}`] : []),
              ];
              console.log(`  ${row.tool}: ${parts.join(" · ")}`);
            }
          }
        }),
      );
    }),
).pipe(Command.withDescription("Show local library usage and provider-reported cost stats."));

const versionCmd = Command.make("version", {}, () => Console.log(VERSION)).pipe(
  Command.withDescription("Print Dig version."),
);

export const digCli = Command.make("dig").pipe(
  Command.withDescription("Dig 2.0 local research daemon, MCP bridge, setup wizard, and library CLI."),
  Command.withSubcommands([
    serveCmd,
    mcpCmd,
    setupCmd,
    openCmd,
    statusCmd,
    stopCmd,
    listCmd,
    readCmd,
    searchCmd,
    statsCmd,
    versionCmd,
  ]),
);

export const runCli = (args?: readonly string[]) =>
  (args !== undefined
    ? Command.runWith(digCli, { version: VERSION })(args)
    : Command.run(digCli, { version: VERSION })
  ).pipe(Effect.provide(NodeServices.layer));

// Execute automatically only when invoked directly as the CLI entrypoint (including bundled `dist/dig.mjs`
// or invocations through a symlinked path).
const realOrResolved = (p: string): string => {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
};

const isMain =
  typeof process.argv[1] === "string" &&
  realOrResolved(process.argv[1]) === realOrResolved(fileURLToPath(import.meta.url));

if (isMain) {
  NodeRuntime.runMain(runCli());
}
