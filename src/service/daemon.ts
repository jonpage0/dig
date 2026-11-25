// Dig 2.0 daemon lifecycle: boots `DigManagedRuntime`, runs the localhost Effect `NodeHttpServer`
// on `127.0.0.1:<port>`, manages `<state>/service.json` (mode 0600 atomic), watches `config.toml`
// & `keys.env`, auto-exits when idle with no active requests/jobs/pending tokens, and provides
// cross-process helpers (`health`, `ensureService`, `stopService`, `openAddress`).
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, unwatchFile, watchFile } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { Effect, Exit, Scope } from "effect";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  ConfigService,
  KeysService,
  configPath as configPathOf,
  keysPath as keysPathOf,
  stateDirectory,
} from "../core/config.ts";
import { bootDigRuntime, type DigManagedRuntime } from "../core/runtime.ts";
import { ExecutionService } from "../core/workflow.ts";
import { ACCOUNTS, SOURCES } from "../sources/index.ts";
import { VERSION } from "../version.ts";
import { createDigHttpApi } from "./http-api.ts";

export const DEFAULT_PORT = 47811;
const DEFAULT_IDLE_MS = 30 * 60_000;

function computeBuildFingerprint(): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([VERSION, SOURCES.map((s) => s.id)]));
  if (process.argv[1]) {
    try {
      hash.update(readFileSync(process.argv[1]));
    } catch {
      // Ignore if argv[1] is not a readable path
    }
  }
  return hash.digest("hex").slice(0, 12);
}

export const BUILD = computeBuildFingerprint();

const standardPathDirs = (platform: NodeJS.Platform = process.platform): string[] =>
  platform === "win32"
    ? []
    : [
        join(homedir(), ".local", "bin"),
        join(homedir(), ".cargo", "bin"),
        join(homedir(), ".bun", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
      ];

/** Appends missing standard executable directories after `current`, preserving order and avoiding duplicates. */
export function servicePath(
  current: string | undefined = process.env.PATH,
  platform: NodeJS.Platform = process.platform,
): string {
  const parts = (current ?? "").split(delimiter).filter(Boolean);
  const seen = new Set(parts.map((dir) => dir.replace(/\/+$/, "") || dir));
  for (const dir of standardPathDirs(platform)) {
    if (!seen.has(dir)) {
      seen.add(dir);
      parts.push(dir);
    }
  }
  return parts.join(delimiter);
}

const quoted = (word: string): string =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

export const digCommand = (): string =>
  `node ${quoted(resolve(process.argv[1] ?? "dist/dig.mjs"))}`;

export interface ServiceFile {
  readonly port: number;
  readonly token: string;
  readonly pid: number | null;
  readonly version: string;
  readonly startedAt: string | null;
}

export const serviceFilePath = (state = stateDirectory()): string => join(state, "service.json");

export async function readServiceFile(state = stateDirectory()): Promise<ServiceFile | null> {
  try {
    const value = JSON.parse(await readFile(serviceFilePath(state), "utf8")) as Partial<ServiceFile>;
    return value &&
      typeof value.token === "string" &&
      typeof value.port === "number" &&
      Number.isInteger(value.port)
      ? (value as ServiceFile)
      : null;
  } catch {
    return null;
  }
}

export async function writeServiceFile(
  value: ServiceFile,
  state = stateDirectory(),
): Promise<void> {
  await mkdir(state, { recursive: true, mode: 0o700 });
  const target = serviceFilePath(state);
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}

/** The port: `DIG_PORT`, else the one `service.json` records, else `DEFAULT_PORT`. */
export function portOf(
  file: ServiceFile | null,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fromEnv = Number(env.DIG_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  return file?.port ?? DEFAULT_PORT;
}

export interface HealthResponse {
  readonly ok: boolean;
  readonly name?: string;
  readonly version: string;
  readonly build?: string;
  readonly pid: number;
  readonly startedAt?: string;
  readonly stateDir?: string;
  readonly runningJobs?: number;
}

export async function health(port: number): Promise<HealthResponse | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<HealthResponse> | null;
    return body && (body.ok === true || body.name === "dig") && typeof body.version === "string"
      ? (body as HealthResponse)
      : null;
  } catch {
    return null;
  }
}

const isOlderVersion = (a: string, b: string): boolean => {
  const [x, y] = [a, b].map((v) => v.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0));
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i];
  }
  return false;
};

const needsReplace = (running: { version: string; build?: string }): boolean =>
  isOlderVersion(running.version, VERSION) ||
  (running.version === VERSION &&
    typeof running.build === "string" &&
    running.build.length > 0 &&
    running.build !== BUILD);

async function hasActiveWork(port: number, token: string | undefined): Promise<boolean> {
  if (!token) return true;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return true;
    const info = (await response.json()) as {
      runningJobs?: unknown[];
      activeCalls?: unknown[];
      pendingTokens?: boolean;
    };
    return (
      (Array.isArray(info.runningJobs) && info.runningJobs.length > 0) ||
      (Array.isArray(info.activeCalls) && info.activeCalls.length > 0) ||
      info.pendingTokens === true
    );
  } catch {
    return true;
  }
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitUntil<T>(read: () => Promise<T | null | false>, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) return null;
    await pause(100);
  }
}

/** Asks the running service to exit and waits until it stops. With `ifIdle`, returns `false` if busy. */
export async function stopService(
  state = stateDirectory(),
  { ifIdle = false }: { readonly ifIdle?: boolean } = {},
): Promise<boolean> {
  const file = await readServiceFile(state);
  if (!file) return false;
  const port = portOf(file);
  if (!(await health(port))) return false;
  const response = await fetch(`http://127.0.0.1:${port}/stop${ifIdle ? "?ifIdle=1" : ""}`, {
    method: "POST",
    headers: { authorization: `Bearer ${file.token}` },
  }).catch(() => null);
  if (ifIdle && (!response || response.status === 409)) return false;
  return (await waitUntil(async () => !(await health(port)), 15_000)) !== null;
}

/**
 * Returns the running service's port & bearer token, spawning `dig serve` detached if none is
 * running and replacing an idle service running an older version or mismatched build fingerprint.
 */
export async function ensureService(
  command: { readonly execPath: string; readonly args: readonly string[] },
  state = stateDirectory(),
): Promise<{ readonly port: number; readonly token: string }> {
  await mkdir(state, { recursive: true, mode: 0o700 });
  let file = await readServiceFile(state);
  const port = portOf(file);
  let running = await health(port);

  if (running && needsReplace(running)) {
    if (await hasActiveWork(port, file?.token)) {
      console.error(
        `dig: keeping running service ${running.version}${running.build ? ` (${running.build})` : ""} on port ${port} because it has active work or status could not be confirmed`,
      );
    } else if (await stopService(state, { ifIdle: true })) {
      running = null;
    } else {
      console.error(
        `dig: keeping running service ${running.version}${running.build ? ` (${running.build})` : ""} on port ${port} because it became busy before stopping`,
      );
    }
  }

  if (!running) {
    const log = openSync(join(state, "service.log"), "a");
    const child = spawn(command.execPath, [...command.args, "serve"], {
      detached: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        PATH: servicePath(process.env.PATH),
        DIG_PORT: String(port),
        DIG_STATE_DIR: state,
      },
    });
    child.unref();
    closeSync(log);

    running = await waitUntil(async () => {
      const seen = await health(port);
      file = await readServiceFile(state);
      return seen && file?.pid === seen.pid ? seen : null;
    }, 30_000);
    if (!running) {
      throw new Error(`Dig's service did not start on port ${port}; see ${join(state, "service.log")}`);
    }
  }

  file = await readServiceFile(state);
  if (!file) {
    throw new Error(`Dig's service is running on port ${port} but ${serviceFilePath(state)} is missing`);
  }
  if (file.pid !== running.pid) {
    throw new Error(
      `Port ${port} answered with pid ${running.pid}, which does not match ${serviceFilePath(state)} (pid ${file.pid ?? "none"}). Refusing to send bearer token.`,
    );
  }
  return { port, token: file.token };
}

/** Asks the running service for a single-use `/open/<code>` address to open the localhost Web SPA. */
export async function openAddress(
  state = stateDirectory(),
  options: { readonly path?: string; readonly view?: string; readonly dig?: string } = {},
): Promise<{ readonly address: string; readonly expiresAt: string; readonly path?: string }> {
  const file = await readServiceFile(state);
  if (!file) throw new Error("Dig's service is not running");
  const hasBody = Boolean(options.path || options.view || options.dig);
  const response = await fetch(`http://127.0.0.1:${portOf(file)}/open`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${file.token}`,
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(options) } : {}),
  });
  if (!response.ok) {
    throw new Error(`Dig's service did not give an open link (${response.status})`);
  }
  return response.json() as Promise<{ readonly address: string; readonly expiresAt: string; readonly path?: string }>;
}

/**
 * `dig serve` could not bind its port. `holder` is the Dig service answering `/health` there, if any: then the
 * service the caller wanted is already running (the usual end of a start race), and this start is not needed.
 */
export class PortInUseError extends Error {
  constructor(
    readonly port: number,
    readonly holder: HealthResponse | null,
  ) {
    super(
      holder
        ? `Dig ${holder.version} (pid ${holder.pid}) already serves port ${port}`
        : `Port ${port} on 127.0.0.1 is in use by something that is not Dig. Stop it, or set DIG_PORT to a free port for Dig.`,
    );
    this.name = "PortInUseError";
  }
}

/** Whether a failure, or any of its causes, is a listen on a port that is already taken. */
function isAddressInUse(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === "object" && !seen.has(current); ) {
    seen.add(current);
    if ((current as { code?: unknown }).code === "EADDRINUSE") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The Dig service on `port`, asking for about two seconds while one that has just bound starts answering. */
async function digHolding(port: number): Promise<HealthResponse | null> {
  const end = Date.now() + 2_000;
  for (;;) {
    const found = await health(port);
    if (found || Date.now() >= end) return found;
    await pause(200);
  }
}

export interface ServeOptions {
  readonly state?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Explicit TCP port (`0` selects a free OS-assigned port for isolated tests). */
  readonly port?: number;
  readonly webDir?: string;
  /** Optional pre-booted runtime (primarily for tests); when provided, `serve` does not dispose it unless owned. */
  readonly runtime?: DigManagedRuntime;
  /** Install SIGTERM/SIGINT signal handlers (defaults to true). */
  readonly handleSignals?: boolean;
}

export interface RunningService {
  readonly port: number;
  readonly token: string;
  readonly origin: string;
  readonly stateDir: string;
  readonly runtime: DigManagedRuntime;
  readonly stop: (reason?: string) => Promise<void>;
  readonly waitForStop: Promise<void>;
}

/**
 * Boots `DigManagedRuntime`, binds the Effect `NodeHttpServer` on `127.0.0.1:<port>`,
 * writes `<state>/service.json` (0600), watches `config.toml` & `keys.env`, sweeps idle
 * state, and resolves once listening. Disposes the runtime cleanly on `stop` / signals / idle.
 */
export async function serve(options: ServeOptions = {}): Promise<RunningService> {
  const env = options.env ?? process.env;
  const state = options.state ?? stateDirectory(env);
  await mkdir(state, { recursive: true, mode: 0o700 });

  const previous = await readServiceFile(state);
  const requestedPort = options.port !== undefined ? options.port : portOf(previous, env);
  const token = previous?.token ?? randomBytes(32).toString("base64url");
  const idleRaw = Number(env.DIG_IDLE_EXIT_MS);
  const idleMs = Number.isFinite(idleRaw) && idleRaw > 0 ? idleRaw : DEFAULT_IDLE_MS;
  const startedAt = new Date().toISOString();

  // A Dig service already on the port settles it before this start opens any state: the usual end of a start race.
  if (requestedPort !== 0) {
    const holder = await health(requestedPort);
    if (holder) throw new PortInUseError(requestedPort, holder);
  }

  const ownsRuntime = !options.runtime;
  const runtime =
    options.runtime ??
    (await bootDigRuntime({
      stateDir: state,
      plugins: SOURCES,
      accounts: ACCOUNTS,
      recoverOnBoot: false,
    }));

  let boundPort = requestedPort;
  let activeRequests = 0;
  let lastActivity = Date.now();
  let stopping = false;
  let resolveStop!: () => void;
  const waitForStop = new Promise<void>((r) => {
    resolveStop = r;
  });

  const api = await createDigHttpApi({
    runtime,
    token,
    build: BUILD,
    startedAt,
    stateDir: state,
    getPort: () => boundPort,
    webDir: options.webDir,
    onStop: (reason) => {
      void shutdown(reason);
    },
  });

  const serverScope = await Effect.runPromise(Scope.make());
  let rawNodeServer: ReturnType<typeof createServer> | undefined;

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const httpServer = yield* NodeHttpServer.make(
          () => {
            const s = createServer();
            rawNodeServer = s;
            s.on("request", (_req, res) => {
              activeRequests++;
              lastActivity = Date.now();
              res.once("close", () => {
                activeRequests = Math.max(0, activeRequests - 1);
                lastActivity = Date.now();
              });
            });
            return s;
          },
          {
            host: "127.0.0.1",
            port: requestedPort,
            disablePreemptiveShutdown: true,
            gracefulShutdownTimeout: "2 seconds",
          },
        );
        const addr = rawNodeServer?.address();
        if (addr && typeof addr === "object" && typeof addr.port === "number") {
          boundPort = addr.port;
        }
        yield* httpServer.serve(api.httpApp);
      }).pipe(Scope.provide(serverScope), Effect.provide(NodeHttpServer.layerHttpServices)),
    );
  } catch (error) {
    await api.close().catch(() => {});
    await Effect.runPromise(Scope.close(serverScope, Exit.void)).catch(() => {});
    if (ownsRuntime) await runtime.dispose().catch(() => {});
    if (requestedPort !== 0 && isAddressInUse(error)) {
      throw new PortInUseError(requestedPort, await digHolding(requestedPort));
    }
    throw error;
  }

  // Only recover crashed jobs and sweep stale rows AFTER binding the port exclusively,
  // so a second `dig serve` that fails EADDRINUSE never touches the live daemon's jobs.
  await runtime.runPromise(
    Effect.flatMap(ExecutionService, (exec) =>
      Effect.andThen(exec.recoverCrashedCalls(), exec.sweep()),
    ),
  );

  await writeServiceFile({ port: boundPort, token, pid: process.pid, version: VERSION, startedAt }, state);

  const cfgFile = configPathOf(state);
  const keysFile = keysPathOf(state);

  const onConfigChanged = () => {
    void runtime
      .runPromise(Effect.flatMap(ConfigService, (c) => c.load()))
      .then(
        (cfg) => api.notifySettingsChanged(cfg),
        () => api.notifySettingsChanged(null),
      );
  };
  const onKeysChanged = () => {
    void runtime.runPromise(Effect.flatMap(KeysService, (k) => k.reload())).catch((e) => {
      console.error(
        `dig: cannot reload keys.env; previous keys stay in effect: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  };

  watchFile(cfgFile, { persistent: false, interval: 500 }, onConfigChanged);
  watchFile(keysFile, { persistent: false, interval: 500 }, onKeysChanged);

  const tick = setInterval(() => {
    api.sweepSessions();
    void runtime
      .runPromise(
        Effect.gen(function* () {
          const exec = yield* ExecutionService;
          yield* exec.sweep();
          const running = yield* exec.runningJobs();
          const pendingTokens = yield* exec.hasPendingTokens();
          return { running: running.length, pendingTokens };
        }),
      )
      .then(({ running, pendingTokens }) => {
        if (
          activeRequests === 0 &&
          running === 0 &&
          !pendingTokens &&
          Date.now() - lastActivity >= idleMs
        ) {
          void shutdown("idle");
        }
      })
      .catch(() => {});
  }, Math.max(50, Math.min(idleMs / 4, 30_000)));
  tick.unref();

  const onSigTerm = () => void shutdown("SIGTERM");
  const onSigInt = () => void shutdown("SIGINT");
  const handleSignals = options.handleSignals !== false;
  if (handleSignals) {
    process.once("SIGTERM", onSigTerm);
    process.once("SIGINT", onSigInt);
  }

  async function shutdown(reason = "stopped") {
    if (stopping) return;
    stopping = true;
    console.error(`dig: service ${process.pid} exiting (${reason})`);
    clearInterval(tick);
    unwatchFile(cfgFile, onConfigChanged);
    unwatchFile(keysFile, onKeysChanged);
    if (handleSignals) {
      process.off("SIGTERM", onSigTerm);
      process.off("SIGINT", onSigInt);
    }

    // Dispose the runtime BEFORE closing the listening port so in-flight jobs settle cleanly via
    // fiber interruption (marking plain paid calls `failed` with unknown cost and leaving
    // reconcile-capable calls `dispatched`, NEVER user-style `cancelled`) before `dig stop` returns.
    await api.close().catch(() => {});
    if (ownsRuntime) {
      await runtime.dispose().catch(() => {});
    }

    rawNodeServer?.closeAllConnections?.();
    await Effect.runPromise(Scope.close(serverScope, Exit.void)).catch(() => {});

    const current = await readServiceFile(state);
    if (current?.pid === process.pid) {
      await writeServiceFile({ ...current, pid: null, startedAt: null }, state).catch(() => {});
    }
    resolveStop();
  }

  const origin = `http://127.0.0.1:${boundPort}`;
  console.error(`dig: service ${VERSION} (pid ${process.pid}) listening on ${origin}/mcp`);

  return {
    port: boundPort,
    token,
    origin,
    stateDir: state,
    runtime,
    stop: shutdown,
    waitForStop,
  };
}
