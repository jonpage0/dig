// Dig 2.0 localhost HTTP & SSE backend built on Effect 4.1.5 `HttpRouter` + `HttpEffect.fromWebHandler`
// (zero `@modelcontextprotocol/node`). Serves:
// - Host & Origin DNS-rebinding / CSRF guards on every route
// - `GET /health` (unauthenticated), `GET /status`, `POST /stop`, `POST /open` (Bearer token)
// - `POST|GET|DELETE /mcp` (Bearer token; 2026-07-28 `modern.fetch` + 2025-era sessionful transport)
// - `GET|POST /keys/:code` & `GET|POST /approve/:code` (single-use opaque codes, strict CSP, zero JS)
// - `GET /open/:code` (single-use opaque code -> `HttpOnly; SameSite=Strict` cookie + 302 redirect)
// - Cookie-authenticated SPA JSON APIs (`/api/library*`, `/api/settings`, `/api/setup*`) + live SSE `/api/events`
// - Cookie-authenticated static SPA asset server from `dist/web/` with client-side route fallback
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Exit, Option, Queue, Scope, Stream } from "effect";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
  type ClientCapabilities,
  type McpServer,
} from "@modelcontextprotocol/server";
import type {
  DigSseEvent,
  LibraryReadRequest,
  LibrarySearchRequest,
  LibrarySnapshotResponse,
  SettingsUpdateRequest,
  SetupKeysSaveRequest,
  SetupPresetRequest,
  SetupSourcesRequest,
  SourceCatalogItem,
} from "../core/api-types.ts";
import { ConfigService, KeysService, type DigConfig } from "../core/config.ts";
import { costSummary } from "../core/cost.ts";
import { LibraryService } from "../core/library.ts";
import { ProgressHub } from "../core/progress.ts";
import type { DigManagedRuntime } from "../core/runtime.ts";
import { SearchService, type SearchMode } from "../core/search.ts";
import { SETUP_PRESETS, SetupService } from "../core/setup.ts";
import { ExecutionService, OPEN_CODE_MS } from "../core/workflow.ts";
import { SOURCES, SOURCE_GROUPS } from "../sources/index.ts";
import { VERSION } from "../version.ts";
import {
  buildSettingsResponse,
  createDigServer,
  overridePatchForUnit,
  type KeyScopeEntry,
  type ServiceHooks,
} from "./mcp.ts";
import { toolName } from "./surface.ts";

const COOKIE_NAME = "dig_session";
const BROWSER_SESSION_MS = 24 * 60 * 60_000;
const MCP_SESSION_MS = 24 * 60 * 60_000;
const FORM_BODY_LIMIT = 64 * 1024;
const JSON_BODY_LIMIT = 1024 * 1024;
const MAX_LOGGED_CLIENTS = 64;

const DEFAULT_WEB_DIR = fileURLToPath(
  ["./web/", "../../dist/web/"]
    .map((rel) => new URL(rel, import.meta.url))
    .find((url) => existsSync(new URL("index.html", url))) ??
    new URL("../../dist/web/", import.meta.url),
);

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const FORM_PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const SPA_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

const SPA_HTML_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": SPA_CSP,
};

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );

const PAGE_STYLE =
  "body{margin:0;font:16px/1.5 system-ui,-apple-system,sans-serif;color-scheme:light dark;background:Canvas;color:CanvasText}main{max-width:38rem;margin:0 auto;padding:24px 16px}h1{font-size:1.4rem;margin:0 0 12px}label{display:block;font-weight:600;margin-top:20px;overflow-wrap:anywhere}.state{font-weight:400;font-size:.875rem;opacity:.75}p.note{margin:4px 0 6px;font-size:.875rem;opacity:.8;overflow-wrap:anywhere}input[type=password]{box-sizing:border-box;width:100%;font:inherit;padding:10px;border:1px solid GrayText;border-radius:6px;background:Field;color:FieldText}button{margin-top:20px;font:inherit;font-weight:600;padding:10px 20px;border-radius:6px;border:1px solid GrayText;cursor:pointer}.choice{display:flex;align-items:center;gap:10px;margin:10px 0;font-weight:500}footer{margin-top:24px;font-size:.875rem;opacity:.75}ul{padding-left:20px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}";

const renderHtmlPage = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body><main>${body}</main></body></html>`;

const htmlResp = (
  status: number,
  html: string,
  headers: Record<string, string> = FORM_PAGE_HEADERS,
) => HttpServerResponse.text(html, { status, headers });

const jsonResp = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });

const webJson = (status: number, value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const webRpcError = (status: number, message: string) =>
  webJson(status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });

const untilClock = (iso: string): string =>
  new Date(Date.parse(iso)).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

const quotedArg = (word: string): string =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

export const cliInvocation = (): string =>
  `node ${quotedArg(resolve(process.argv[1] ?? "dist/dig.mjs"))}`;

const errorMessage = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e && typeof e.message === "string") return e.message;
  return String(e);
};

/** Ensure browser redirect targets stay strictly same-origin relative paths (never protocol-relative `//` or `/\`). */
export function safeRedirectPath(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  const trimmed = raw.trim();
  if (!/^\/(?![/\\])/.test(trimmed) || /[\r\n\0\\]/.test(trimmed)) return "/";
  return trimmed;
}

const MAX_LOGGED_CAPS = 32;
const cleanCap = (value: string) => value.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 64);

/** Compact sorted summary of declared MCP client capabilities (keys only; never values). */
export function summarizeCapabilities(capabilities: ClientCapabilities | undefined): string {
  if (!capabilities || typeof capabilities !== "object") return "none";
  const items = new Set<string>();
  const push = (label: string) => {
    const cleaned = cleanCap(label);
    if (cleaned) items.add(cleaned);
  };
  for (const [rawKey, value] of Object.entries(capabilities)) {
    if (!value) continue;
    const key = cleanCap(rawKey);
    if (!key) continue;
    if (key === "elicitation" && typeof value === "object") {
      const elicit = value as { form?: unknown; url?: unknown };
      if (elicit.form !== undefined || elicit.url === undefined) push("elicitation.form");
      if (elicit.url !== undefined) push("elicitation.url");
    } else if (key === "extensions" && typeof value === "object") {
      const exts = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && v !== null && v !== false)
        .map(([k]) => cleanCap(k))
        .filter(Boolean);
      if (exts.length) for (const ext of exts) push(`ext:${ext}`);
      else push("extensions");
    } else if (typeof value === "object") {
      const sub = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && v !== null && v !== false)
        .map(([k]) => cleanCap(k))
        .filter(Boolean);
      if (sub.length) for (const k of sub) push(`${key}.${k}`);
      else push(key);
    } else {
      push(key);
    }
  }
  const sorted = [...items].sort();
  if (!sorted.length) return "none";
  return sorted.length > MAX_LOGGED_CAPS
    ? `${sorted.slice(0, MAX_LOGGED_CAPS).join(", ")}, ... (+${sorted.length - MAX_LOGGED_CAPS})`
    : sorted.join(", ");
}

export interface HttpApiOptions {
  readonly runtime: DigManagedRuntime;
  readonly token: string;
  readonly build: string;
  readonly startedAt: string;
  readonly stateDir: string;
  readonly getPort: () => number;
  readonly webDir?: string;
  readonly onStop: (reason: string) => void;
}

export interface HttpApiController {
  /** Effect HTTP handler ready to pass to `NodeHttpServer` (`srv.serve(httpApp)`). */
  readonly httpApp: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >;
  /** Notify all connected 2026-07-28 listeners & 2025-era sessions that settings changed. */
  readonly notifySettingsChanged: (c: DigConfig | null) => void;
  /** Sweep expired 2025-era MCP sessions and browser sessions. */
  readonly sweepSessions: () => void;
  /** Close all open MCP sessions & handlers on daemon shutdown. */
  readonly close: () => Promise<void>;
  /** Current count of active 2025-era MCP sessions. */
  readonly sessionCount: () => number;
}

export async function createDigHttpApi(options: HttpApiOptions): Promise<HttpApiController> {
  const { runtime, token, build, startedAt, stateDir, getPort, onStop } = options;
  const webRoot = resolve(options.webDir ?? DEFAULT_WEB_DIR);

  // ---- Browser sessions (cached in memory + persisted in SQLite `browser_sessions`) ----
  const browserSessions = new Map<string, number>();
  // ---- Key page waiters (wakes `keys` MCP tool when user submits `/keys/:code`) ----
  const keyWaiters = new Map<string, Set<() => void>>();
  // ---- In-flight `/keys/:code` submissions (prevents concurrent double-writes without burning failed saves) ----
  const inFlightKeyCodes = new Set<string>();
  // ---- One-time browser spend approvals (`choice === "send"` from `/approve/:code`) ----
  const approvedBinds = new Map<string, number>();

  const pruneMaps = () => {
    const now = Date.now();
    for (const [sid, exp] of browserSessions) if (exp < now) browserSessions.delete(sid);
    for (const [bind, exp] of approvedBinds) if (exp < now) approvedBinds.delete(bind);
  };

  const wakeKeyCode = (code: string) => {
    const waiters = keyWaiters.get(code);
    if (!waiters) return;
    keyWaiters.delete(code);
    for (const done of waiters) done();
  };

  const waitForKeyCode = (code: string, timeoutMs: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolveWait) => {
      if (signal?.aborted || timeoutMs <= 0) {
        resolveWait();
        return;
      }
      let set = keyWaiters.get(code);
      if (!set) {
        set = new Set();
        keyWaiters.set(code, set);
      }
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        set?.delete(finish);
        if (set?.size === 0) keyWaiters.delete(code);
        resolveWait();
      };
      set.add(finish);
      const timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener("abort", finish, { once: true });
    });

  const consumeApprovedBind = (bind: string): boolean => {
    pruneMaps();
    const exp = approvedBinds.get(bind);
    if (!exp || exp < Date.now()) {
      approvedBinds.delete(bind);
      return false;
    }
    approvedBinds.delete(bind);
    return true;
  };

  // ---- MCP 2026-07-28 + 2025-era session management ----
  interface LegacySession {
    readonly server: McpServer;
    readonly sync: (c: DigConfig | null) => void;
    readonly transport: WebStandardStreamableHTTPServerTransport;
    lastSeen: number;
  }
  const mcpSessions = new Map<string, LegacySession>();
  const closeMcpSession = (id: string) => {
    const session = mcpSessions.get(id);
    if (!session) return;
    mcpSessions.delete(id);
    session.server.close().catch(() => {});
  };

  const notifySettingsChanged = (c: DigConfig | null) => {
    modern.notify.toolsChanged();
    modern.notify.promptsChanged();
    modern.notify.resourcesChanged();
    for (const session of mcpSessions.values()) session.sync(c);
  };

  const hooks: ServiceHooks = {
    runtime,
    origin: () => `http://127.0.0.1:${getPort()}`,
    settingsChanged: notifySettingsChanged,
    waitForKeyCode,
    consumeApprovedBind,
  };

  const modern = createMcpHandler(async (ctx) => (await createDigServer(ctx, hooks)).server, {
    legacy: "reject",
    onerror: (error) => console.error(`dig: ${error.message}`),
  });

  const seenClients = new Set<string>();
  const logClient = (
    era: "modern" | "legacy",
    info: { name?: unknown; version?: unknown } | undefined,
    capabilities: ClientCapabilities | undefined,
  ) => {
    const clean = (v: unknown) =>
      typeof v === "string" ? v.trim().replace(/[\r\n\t]+/g, " ").slice(0, 120) : "";
    const name = clean(info?.name);
    const version = clean(info?.version);
    const who = name ? (version ? `${name}/${version}` : name) : "unknown";
    const line = `dig: client ${era} ${who} capabilities=[${summarizeCapabilities(capabilities)}]`;
    if (seenClients.has(line)) return;
    if (seenClients.size >= MAX_LOGGED_CLIENTS) {
      const oldest = seenClients.values().next().value;
      if (oldest) seenClients.delete(oldest);
    }
    seenClients.add(line);
    console.error(line);
  };

  async function handleLegacyMcp(request: Request): Promise<Response> {
    const sid = request.headers.get("mcp-session-id");
    if (sid) {
      const session = mcpSessions.get(sid);
      if (!session) return webRpcError(404, "Session not found");
      session.lastSeen = Date.now();
      const response = await session.transport.handleRequest(request);
      if (request.method === "DELETE") closeMcpSession(sid);
      return response;
    }
    if (request.method !== "POST") return webRpcError(400, "Bad Request: no session");
    const { server, sync } = await createDigServer({ era: "legacy", requestInfo: request }, hooks);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        mcpSessions.set(id, { server, sync, transport, lastSeen: Date.now() });
      },
      onsessionclosed: (id) => closeMcpSession(id),
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    logClient("legacy", server.server.getClientVersion(), server.server.getClientCapabilities());
    if (!transport.sessionId) await server.close().catch(() => {});
    return response;
  }

  async function handleMcpWebRequest(request: Request): Promise<Response> {
    if (await isLegacyRequest(request)) return handleLegacyMcp(request);
    if (request.method === "POST" && !(Number(request.headers.get("content-length")) > 16_384)) {
      const body = (await request
        .clone()
        .json()
        .catch(() => null)) as { method?: unknown; params?: { _meta?: Record<string, unknown> } } | null;
      if (body && typeof body === "object" && typeof body.method === "string") {
        const meta = body.params?._meta;
        logClient(
          "modern",
          meta?.[CLIENT_INFO_META_KEY] as { name?: unknown; version?: unknown } | undefined,
          meta?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined,
        );
      }
    }
    return modern.fetch(request);
  }

  // ---- Request Auth & CSRF Guards ----

  const hasBearerAuth = (req: HttpServerRequest.HttpServerRequest): boolean => {
    const auth = req.headers.authorization ?? "";
    return auth.startsWith("Bearer ") && sameSecret(auth.slice(7), token);
  };

  const requireBearer = (req: HttpServerRequest.HttpServerRequest) =>
    hasBearerAuth(req)
      ? null
      : jsonResp(
          401,
          { error: "A valid bearer token is required" },
          { "www-authenticate": "Bearer" },
        );

  const cookieName = (): string => `${COOKIE_NAME}_${getPort()}`;

  const hasBrowserSession = async (req: HttpServerRequest.HttpServerRequest): Promise<boolean> => {
    const value = req.cookies[cookieName()] ?? "";
    if (!value) return false;
    const hashed = sha256Hex(value);
    pruneMaps();
    if ([...browserSessions.keys()].some((known) => sameSecret(known, hashed))) return true;
    // Fallback check against SQLite `browser_sessions` in case of restart or cross-check
    const nowIso = new Date().toISOString();
    const rows = await runtime.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql<{ session_id: string; expires_at: string }>`
            SELECT session_id, expires_at FROM browser_sessions WHERE expires_at > ${nowIso}
          `.pipe(Effect.orElseSucceed(() => [] as { session_id: string; expires_at: string }[])),
      ),
    );
    for (const row of rows) {
      const exp = Date.parse(row.expires_at);
      if (Number.isFinite(exp)) browserSessions.set(row.session_id, exp);
    }
    return [...browserSessions.keys()].some((known) => sameSecret(known, hashed));
  };

  const checkSameOriginPost = (
    req: HttpServerRequest.HttpServerRequest,
    options: { readonly allowNullSameSite?: boolean } = {},
  ): HttpServerResponse.HttpServerResponse | null => {
    const self = `http://${req.headers.host ?? `127.0.0.1:${getPort()}`}`;
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    const referer = req.headers.referer;
    const nullSameSite = options.allowNullSameSite === true && origin === "null" && site === "same-origin";
    if (origin !== undefined && origin !== self && !nullSameSite) {
      return jsonResp(403, { error: "Cross-origin requests are forbidden" });
    }
    if (site !== undefined && site !== "same-origin") {
      return jsonResp(403, { error: "Cross-site requests are forbidden" });
    }
    if (referer !== undefined) {
      try {
        if (new URL(referer).origin !== self) {
          return jsonResp(403, { error: "Cross-origin referer is forbidden" });
        }
      } catch {
        return jsonResp(403, { error: "Invalid referer" });
      }
    }
    return null;
  };

  async function readJsonBody<T>(
    req: HttpServerRequest.HttpServerRequest,
  ): Promise<{ readonly ok: true; readonly data: T } | { readonly ok: false; readonly response: HttpServerResponse.HttpServerResponse }> {
    const ct = (req.headers["content-type"] ?? "").toLowerCase();
    if (!ct.startsWith("application/json")) {
      return { ok: false, response: jsonResp(415, { error: "Content-Type application/json is required" }) };
    }
    const len = Number(req.headers["content-length"] ?? 0);
    if (len > JSON_BODY_LIMIT) {
      return { ok: false, response: jsonResp(413, { error: "Request body is too large" }) };
    }
    const raw = await Effect.runPromise(req.text.pipe(Effect.orElseSucceed(() => "")));
    if (Buffer.byteLength(raw, "utf8") > JSON_BODY_LIMIT) {
      return { ok: false, response: jsonResp(413, { error: "Request body is too large" }) };
    }
    try {
      const parsed = JSON.parse(raw || "{}") as T;
      return { ok: true, data: parsed };
    } catch {
      return { ok: false, response: jsonResp(400, { error: "Body is not valid JSON" }) };
    }
  }

  const unauthSpaPage = () =>
    htmlResp(
      401,
      renderHtmlPage(
        "Dig · Sign in locally",
        `<h1>Open Dig through a one-time link</h1><p>This local page requires a one-time browser link from Dig.</p><p>Ask your assistant to call <code>open_library</code>, or run:</p><p><code>${escapeHtml(cliInvocation())} open</code></p>`,
      ),
      SPA_HTML_HEADERS,
    );

  // ---- Static SPA File Serving (`dist/web/`) ----

  async function serveSpaPath(pathname: string): Promise<HttpServerResponse.HttpServerResponse> {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      return jsonResp(400, { error: "Malformed path" });
    }
    if (decodedPath.includes("\0")) return jsonResp(400, { error: "Invalid path" });

    const cleanRel = decodedPath.replace(/^\/+/, "");
    const isClientRoute =
      cleanRel === "" ||
      cleanRel === "trail" ||
      cleanRel === "sources" ||
      cleanRel === "setup" ||
      cleanRel === "settings" ||
      cleanRel === "about" ||
      cleanRel.startsWith("dig/");
    const hasExtension = !isClientRoute && Boolean(extname(cleanRel));

    const tryServeFile = async (rel: string): Promise<HttpServerResponse.HttpServerResponse | null> => {
      if (!existsSync(webRoot)) return null;
      const rootReal = await realpath(webRoot);
      const candidate = resolve(rootReal, rel);
      const relFromRoot = relative(rootReal, candidate);
      if (relFromRoot === ".." || relFromRoot.startsWith(`..${sep}`) || isAbsolute(relFromRoot)) {
        return null;
      }
      try {
        const st = await stat(candidate);
        if (!st.isFile()) return null;
        const safe = await realpath(candidate);
        const safeRel = relative(rootReal, safe);
        if (safeRel === ".." || safeRel.startsWith(`..${sep}`) || isAbsolute(safeRel)) return null;
        const bytes = await readFile(safe);
        const ext = extname(safe).toLowerCase();
        const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
        return HttpServerResponse.uint8Array(new Uint8Array(bytes), {
          status: 200,
          headers: {
            "content-type": mime,
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "x-frame-options": "DENY",
            "content-security-policy": SPA_CSP,
            "cache-control": ext === ".html" ? "no-store" : "private, max-age=300",
          },
        });
      } catch {
        return null;
      }
    };

    if (cleanRel) {
      const exact = await tryServeFile(cleanRel);
      if (exact) return exact;
      if (hasExtension) return jsonResp(404, { error: "Asset not found" });
    }

    const index = await tryServeFile("index.html");
    if (index) return index;

    // Clean fallback HTML if `dist/web/index.html` has not been built yet (e.g. during backend-only dev/tests).
    return htmlResp(
      200,
      renderHtmlPage(
        "Dig 2.0",
        `<h1>Dig ${escapeHtml(VERSION)}</h1><p>Localhost API &amp; SSE backend is running. Run <code>npm run build</code> to bundle the Web SPA into <code>dist/web/</code>.</p>`,
      ),
      SPA_HTML_HEADERS,
    );
  }

  // ---- Effect `HttpRouter` Route Table ----

  const routesLayer = HttpRouter.use((router) =>
    Effect.gen(function* () {
      // 1. GET /health (unauthenticated)
      yield* router.add("GET", "/health", () =>
        Effect.promise(async () => {
          const running = await runtime.runPromise(
            Effect.flatMap(ExecutionService, (exec) => exec.runningJobs()),
          );
          return jsonResp(200, {
            ok: true,
            name: "dig",
            version: VERSION,
            build,
            pid: process.pid,
            startedAt,
            runningJobs: running.length,
          });
        }),
      );

      // 2. GET /status (Bearer token)
      yield* router.add("GET", "/status", (req) =>
        Effect.promise(async () => {
          const denied = requireBearer(req);
          if (denied) return denied;
          const status = await runtime.runPromise(
            Effect.gen(function* () {
              const exec = yield* ExecutionService;
              const hub = yield* ProgressHub;
              return {
                runningJobs: yield* exec.runningJobs(),
                activeCalls: yield* hub.activeCalls(),
                pendingTokens: yield* exec.hasPendingTokens(),
              };
            }),
          );
          return jsonResp(200, {
            ok: true,
            name: "dig",
            version: VERSION,
            build,
            pid: process.pid,
            port: getPort(),
            startedAt,
            stateDir,
            runningJobs: status.runningJobs,
            activeCalls: status.activeCalls,
            pendingTokens: status.pendingTokens,
            sessions: mcpSessions.size,
          });
        }),
      );

      // 3. POST /stop (Bearer token)
      yield* router.add("POST", "/stop", (req) =>
        Effect.promise(async () => {
          const denied = requireBearer(req);
          if (denied) return denied;
          const url = Option.getOrUndefined(HttpServerRequest.toURL(req));
          const ifIdle = url?.searchParams.get("ifIdle") === "1";
          if (ifIdle) {
            const busy = await runtime.runPromise(
              Effect.gen(function* () {
                const exec = yield* ExecutionService;
                const hub = yield* ProgressHub;
                const jobs = yield* exec.runningJobs();
                const calls = yield* hub.activeCalls();
                const pending = yield* exec.hasPendingTokens();
                return jobs.length > 0 || calls.length > 0 || pending;
              }),
            );
            if (busy) return jsonResp(409, { stopping: false, busy: true });
          }
          setImmediate(() => onStop("stopped"));
          return jsonResp(200, { stopping: true });
        }),
      );

      // 4. POST /open (Bearer token) — mints one-time `/open/<code>` browser link for `dig open`
      yield* router.add("POST", "/open", (req) =>
        Effect.promise(async () => {
          const denied = requireBearer(req);
          if (denied) return denied;
          let targetPath = "/";
          const ct = (req.headers["content-type"] ?? "").toLowerCase();
          if (ct.startsWith("application/json")) {
            const raw = await Effect.runPromise(req.text.pipe(Effect.orElseSucceed(() => "")));
            try {
              const body = JSON.parse(raw || "{}") as { path?: unknown; view?: unknown; dig?: unknown };
              if (typeof body.path === "string") targetPath = safeRedirectPath(body.path);
              else if (typeof body.dig === "string" && body.dig.trim()) {
                const trimmed = body.dig.trim();
                const slash = trimmed.indexOf("/");
                targetPath =
                  body.view === "trail"
                    ? `/trail?dig=${encodeURIComponent(trimmed)}`
                    : slash > 0
                      ? `/dig/${encodeURIComponent(trimmed.slice(0, slash))}/${encodeURIComponent(trimmed.slice(slash + 1))}`
                      : `/dig/${encodeURIComponent(trimmed)}`;
              } else if (typeof body.view === "string" && body.view !== "library") {
                targetPath = safeRedirectPath(`/${body.view}`);
              }
            } catch {
              return jsonResp(400, { error: "Invalid JSON body" });
            }
          }
          const minted = await runtime.runPromise(
            Effect.flatMap(ExecutionService, (exec) =>
              exec.createOpaqueCode({
                kind: "browser_open",
                payload: { path: targetPath },
                ttlMs: OPEN_CODE_MS,
              }),
            ),
          );
          return jsonResp(200, {
            address: `http://127.0.0.1:${getPort()}/open/${minted.code}`,
            expiresAt: minted.expiresAt,
            path: targetPath,
          });
        }),
      );

      // 5. POST|GET|DELETE /mcp (Bearer token) — mounted via Effect `HttpEffect.fromWebHandler`
      const mcpRouteHandler = (req: HttpServerRequest.HttpServerRequest) =>
        Effect.gen(function* () {
          const denied = requireBearer(req);
          if (denied) return denied;
          return yield* HttpEffect.fromWebHandler(handleMcpWebRequest);
        });

      yield* router.add("POST", "/mcp", mcpRouteHandler);
      yield* router.add("GET", "/mcp", mcpRouteHandler);
      yield* router.add("DELETE", "/mcp", mcpRouteHandler);

      // 6. GET /keys/:code & POST /keys/:code (single-use opaque code, zero bearer token, strict CSP)
      yield* router.add("GET", "/keys/:code", () =>
        Effect.gen(function* () {
          const { code } = yield* HttpRouter.params;
          return yield* Effect.promise(async () => {
            const record = code
              ? await runtime.runPromise(
                  Effect.flatMap(ExecutionService, (exec) => exec.readOpaqueCode(code)),
                )
              : null;
            if (!record || record.kind !== "keys") {
              return htmlResp(
                404,
                renderHtmlPage(
                  "Dig · Link not valid",
                  "<h1>Link not valid</h1><p>This key page link is not valid. Ask for a new link with Dig's <code>keys</code> tool.</p>",
                ),
              );
            }
            if (record.used) {
              return htmlResp(
                410,
                renderHtmlPage(
                  "Dig · Link already used",
                  "<h1>Link already used</h1><p>This key page link has already been used and accepts nothing more. Ask for a new link with Dig's <code>keys</code> tool.</p>",
                ),
              );
            }
            if (record.expiresAt < new Date().toISOString()) {
              return htmlResp(
                410,
                renderHtmlPage(
                  "Dig · Link expired",
                  "<h1>Link expired</h1><p>This key page link has expired. Ask for a new link with Dig's <code>keys</code> tool.</p>",
                ),
              );
            }

            const keysSvc = await runtime.runPromise(KeysService);
            const entries = Array.isArray(record.payload.names)
              ? (record.payload.names as KeyScopeEntry[])
              : [];
            const fields = entries
              .map(({ name, labels, guidance }) => {
                const isSet = keysSvc.has(name);
                return `<label for="${escapeHtml(name)}">${escapeHtml(name)} <span class="state">· ${isSet ? "set; a new value replaces it" : "not set"}</span></label><p class="note">${escapeHtml(labels.join(", "))}: ${escapeHtml(guidance)}</p><input type="password" id="${escapeHtml(name)}" name="${escapeHtml(name)}" autocomplete="off" autocapitalize="off" spellcheck="false">`;
              })
              .join("");

            return htmlResp(
              200,
              renderHtmlPage(
                "Dig · Keys",
                `<h1>Dig keys</h1><p>Enter the credentials Dig should use. Values are saved directly to <code>keys.env</code> (mode 0600) on this computer and never pass through chat. Leave a field blank to keep it unchanged.</p><form method="post" action="/keys/${escapeHtml(record.code)}">${fields}<button type="submit">Save keys</button></form><footer>Single-use page · expires at ${escapeHtml(untilClock(record.expiresAt))}.</footer>`,
              ),
            );
          });
        }),
      );

      yield* router.add("POST", "/keys/:code", (req) =>
        Effect.gen(function* () {
          const { code } = yield* HttpRouter.params;
          return yield* Effect.promise(async () => {
            const csrfErr = checkSameOriginPost(req, { allowNullSameSite: true });
            if (csrfErr) {
              return htmlResp(
                403,
                renderHtmlPage(
                  "Dig · Not accepted",
                  "<h1>Not accepted</h1><p>This form is accepted only from its own page.</p>",
                ),
              );
            }
            const ct = (req.headers["content-type"] ?? "").toLowerCase();
            if (!ct.startsWith("application/x-www-form-urlencoded")) {
              return htmlResp(
                415,
                renderHtmlPage(
                  "Dig · Not accepted",
                  "<h1>Not accepted</h1><p>This form is accepted only as a standard form submission.</p>",
                ),
              );
            }
            const len = Number(req.headers["content-length"] ?? 0);
            if (len > FORM_BODY_LIMIT) {
              return htmlResp(413, renderHtmlPage("Dig · Too large", "<h1>Form too large</h1>"));
            }
            const rawBody = await Effect.runPromise(req.text.pipe(Effect.orElseSucceed(() => "")));
            if (Buffer.byteLength(rawBody, "utf8") > FORM_BODY_LIMIT) {
              return htmlResp(413, renderHtmlPage("Dig · Too large", "<h1>Form too large</h1>"));
            }

            const existing = code
              ? await runtime.runPromise(
                  Effect.flatMap(ExecutionService, (exec) => exec.readOpaqueCode(code)),
                )
              : null;
            if (!existing || existing.kind !== "keys") {
              return htmlResp(
                404,
                renderHtmlPage("Dig · Link not valid", "<h1>Link not valid</h1><p>This key page link is not valid.</p>"),
              );
            }
            if (existing.used) {
              return htmlResp(
                410,
                renderHtmlPage(
                  "Dig · Link already used",
                  "<h1>Link already used</h1><p>This key page link has already been used and cannot be replayed.</p>",
                ),
              );
            }
            if (existing.expiresAt < new Date().toISOString()) {
              return htmlResp(
                410,
                renderHtmlPage("Dig · Link expired", "<h1>Link expired</h1><p>This key page link has expired.</p>"),
              );
            }

            const entries = Array.isArray(existing.payload.names)
              ? (existing.payload.names as KeyScopeEntry[])
              : [];
            const form = new URLSearchParams(rawBody);
            const values: Record<string, string> = {};
            for (const { name } of entries) {
              const rawVal = form.get(name);
              if (rawVal === null) continue;
              if (/[\r\n\0]/.test(rawVal)) {
                return htmlResp(
                  400,
                  renderHtmlPage(
                    "Dig · Not saved",
                    `<h1>Not saved</h1><p>The value for ${escapeHtml(name)} spans multiple lines. Nothing was saved.</p>`,
                  ),
                );
              }
              const val = rawVal.trim();
              if (val) values[name] = val;
            }

            if (inFlightKeyCodes.has(code!)) {
              return htmlResp(
                410,
                renderHtmlPage(
                  "Dig · Link already used",
                  "<h1>Link already used</h1><p>This link is already being redeemed.</p>",
                ),
              );
            }
            inFlightKeyCodes.add(code!);
            let saved: readonly string[] = [];
            try {
              try {
                const res = await runtime.runPromise(
                  Effect.flatMap(SetupService, (setup) => setup.saveKeys(values)),
                );
                saved = res.saved;
              } catch (error) {
                const msg = errorMessage(error);
                const safeMsg =
                  /^(?:[A-Z0-9_]+ is not a credential|The value for [A-Z0-9_]+ spans)/.test(msg)
                    ? msg
                    : "keys.env could not be written";
                return htmlResp(
                  400,
                  renderHtmlPage(
                    "Dig · Not saved",
                    `<h1>Not saved</h1><p>${escapeHtml(safeMsg)}. Nothing was saved.</p>`,
                  ),
                );
              }

              const redeemed = await runtime.runPromise(
                Effect.flatMap(ExecutionService, (exec) => exec.redeemOpaqueCode(code!, { saved })),
              );
              if (!redeemed) {
                return htmlResp(
                  410,
                  renderHtmlPage(
                    "Dig · Link already used",
                    "<h1>Link already used</h1><p>This link was already redeemed.</p>",
                  ),
                );
              }
            } finally {
              inFlightKeyCodes.delete(code!);
            }

            wakeKeyCode(code!);
            const keysSvc = await runtime.runPromise(KeysService);
            const missing = entries.filter(({ name }) => !keysSvc.has(name)).map(({ name }) => name);
            const renderList = (names: readonly string[]) =>
              `<ul>${names.map((n) => `<li><code>${escapeHtml(n)}</code></li>`).join("")}</ul>`;

            return htmlResp(
              200,
              renderHtmlPage(
                "Dig · Keys saved",
                `<h1>${saved.length ? "Saved" : "Nothing saved"}</h1>${saved.length ? `<p>Dig saved these credentials in <code>keys.env</code> (mode 0600) and reloaded them:</p>${renderList(saved)}` : "<p>No field was filled in, so <code>keys.env</code> is unchanged.</p>"}${missing.length ? `<p>Still not set:</p>${renderList(missing)}` : ""}<p>You can close this page and return to your assistant.</p>`,
              ),
            );
          });
        }),
      );

      // 7. GET /approve/:code & POST /approve/:code (browser spend-approval page; requires browser session cookie)
      yield* router.add("GET", "/approve/:code", (req) =>
        Effect.gen(function* () {
          const { code } = yield* HttpRouter.params;
          return yield* Effect.promise(async () => {
            if (!(await hasBrowserSession(req))) return unauthSpaPage();
            const record = code
              ? await runtime.runPromise(
                  Effect.flatMap(ExecutionService, (exec) => exec.readOpaqueCode(code)),
                )
              : null;
            if (!record || record.kind !== "spend_approval") {
              return htmlResp(
                404,
                renderHtmlPage("Dig · Approval not valid", "<h1>Link not valid</h1><p>This approval link is not valid.</p>"),
              );
            }
            if (record.used) {
              return htmlResp(
                410,
                renderHtmlPage(
                  "Dig · Already answered",
                  "<h1>Already answered</h1><p>This spend approval link has already been used.</p>",
                ),
              );
            }
            if (record.expiresAt < new Date().toISOString()) {
              return htmlResp(
                410,
                renderHtmlPage("Dig · Link expired", "<h1>Link expired</h1><p>This approval link has expired.</p>"),
              );
            }

            const title = typeof record.payload.title === "string" ? record.payload.title : "Dig spend approval";
            const message = typeof record.payload.message === "string" ? record.payload.message : "";
            const choices = Array.isArray(record.payload.choices)
              ? (record.payload.choices as { value: string; title: string }[])
              : [];
            const radios = choices
              .map(
                (c, i) =>
                  `<label class="choice"><input type="radio" name="choice" value="${escapeHtml(c.value)}"${i === 0 ? " checked" : ""}> ${escapeHtml(c.title)}</label>`,
              )
              .join("");

            return htmlResp(
              200,
              renderHtmlPage(
                `Dig · ${title}`,
                `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><form method="post" action="/approve/${escapeHtml(record.code)}">${radios}<button type="submit">Confirm</button></form><footer>Single-use approval · expires at ${escapeHtml(untilClock(record.expiresAt))}.</footer>`,
              ),
            );
          });
        }),
      );

      yield* router.add("POST", "/approve/:code", (req) =>
        Effect.gen(function* () {
          const { code } = yield* HttpRouter.params;
          return yield* Effect.promise(async () => {
            if (!(await hasBrowserSession(req))) return unauthSpaPage();
            const csrfErr = checkSameOriginPost(req, { allowNullSameSite: true });
            if (csrfErr) {
              return htmlResp(
                403,
                renderHtmlPage("Dig · Not accepted", "<h1>Not accepted</h1><p>Cross-origin form post rejected.</p>"),
              );
            }
            const ct = (req.headers["content-type"] ?? "").toLowerCase();
            if (!ct.startsWith("application/x-www-form-urlencoded")) {
              return htmlResp(
                415,
                renderHtmlPage("Dig · Not accepted", "<h1>Not accepted</h1><p>Expected form submission.</p>"),
              );
            }
            const len = Number(req.headers["content-length"] ?? 0);
            if (len > FORM_BODY_LIMIT) {
              return htmlResp(413, renderHtmlPage("Dig · Too large", "<h1>Form too large</h1>"));
            }
            const rawBody = await Effect.runPromise(req.text.pipe(Effect.orElseSucceed(() => "")));
            if (Buffer.byteLength(rawBody, "utf8") > FORM_BODY_LIMIT) {
              return htmlResp(413, renderHtmlPage("Dig · Too large", "<h1>Form too large</h1>"));
            }
            const form = new URLSearchParams(rawBody);
            const choice = form.get("choice")?.trim() ?? "";

            const existing = code
              ? await runtime.runPromise(
                  Effect.flatMap(ExecutionService, (exec) => exec.readOpaqueCode(code)),
                )
              : null;
            if (!existing || existing.kind !== "spend_approval") {
              return htmlResp(404, renderHtmlPage("Dig · Link not valid", "<h1>Link not valid</h1>"));
            }
            if (existing.used || existing.expiresAt < new Date().toISOString()) {
              return htmlResp(
                410,
                renderHtmlPage("Dig · Already used", "<h1>Already used or expired</h1>"),
              );
            }
            const choices = Array.isArray(existing.payload.choices)
              ? (existing.payload.choices as { value: string; title: string }[])
              : [];
            if (!choices.some((c) => c.value === choice)) {
              return htmlResp(400, renderHtmlPage("Dig · Invalid choice", "<h1>Invalid choice</h1>"));
            }

            const redeemed = await runtime.runPromise(
              Effect.flatMap(ExecutionService, (exec) => exec.redeemOpaqueCode(code!, { choice })),
            );
            if (!redeemed) {
              return htmlResp(410, renderHtmlPage("Dig · Already used", "<h1>Already used</h1>"));
            }

            const digHandle = typeof redeemed.payload.digHandle === "string" ? redeemed.payload.digHandle : "";
            const key = typeof redeemed.payload.key === "string" ? redeemed.payload.key : "";
            const unit = typeof redeemed.payload.unit === "string" ? redeemed.payload.unit : "USD";
            const targetRaised =
              typeof redeemed.payload.targetRaised === "number" ? redeemed.payload.targetRaised : 0;
            const bind = typeof redeemed.payload.bind === "string" ? redeemed.payload.bind : "";

            let summary = "No spending override was applied.";
            if (key === "ceiling" && choice === "raise" && digHandle) {
              await runtime.runPromise(
                Effect.flatMap(ExecutionService, (exec) =>
                  exec.applySpendOverride(digHandle, overridePatchForUnit(unit, targetRaised)),
                ),
              );
              summary = `Raised the ${unit} ceiling for dig ${digHandle}. You can retry the call in your assistant.`;
            } else if (key === "spend" && choice === "send-dig" && digHandle) {
              await runtime.runPromise(
                Effect.flatMap(ExecutionService, (exec) =>
                  exec.applySpendOverride(digHandle, { dontAsk: true }),
                ),
              );
              summary = `Enabled auto-approval for remaining calls in dig ${digHandle}. You can retry the call in your assistant.`;
            } else if (key === "spend" && choice === "send" && bind) {
              approvedBinds.set(bind, Date.now() + 10 * 60_000);
              summary = "Approved this single call. Retry the call in your assistant.";
            }

            // Notify open SPA tabs so the pending-approval banner refreshes immediately.
            await runtime.runPromise(
              Effect.flatMap(ProgressHub, (hub) =>
                hub.publish({ type: "settings_changed", at: new Date().toISOString() }),
              ),
            );

            return htmlResp(
              200,
              renderHtmlPage(
                "Dig · Decision recorded",
                `<h1>Decision recorded</h1><p>${escapeHtml(summary)}</p><p>You can close this page.</p>`,
              ),
            );
          });
        }),
      );

      // 8. GET /open/:code — single-use browser session mint + 302 redirect
      yield* router.add("GET", "/open/:code", () =>
        Effect.gen(function* () {
          const { code } = yield* HttpRouter.params;
          return yield* Effect.promise(async () => {
            const redeemed = code
              ? await runtime.runPromise(
                  Effect.flatMap(ExecutionService, (exec) => exec.redeemOpaqueCode(code)),
                )
              : null;
            if (!redeemed || redeemed.kind !== "browser_open") {
              return htmlResp(
                403,
                renderHtmlPage(
                  "Dig · Link invalid or used",
                  `<h1>Link invalid or already used</h1><p>Run <code>${escapeHtml(cliInvocation())} open</code> or ask your assistant to call <code>open_library</code> for a fresh one-time link.</p>`,
                ),
                SPA_HTML_HEADERS,
              );
            }
            const sid = randomBytes(32).toString("base64url");
            const sidHash = sha256Hex(sid);
            const nowMs = Date.now();
            const expMs = nowMs + BROWSER_SESSION_MS;
            browserSessions.set(sidHash, expMs);
            await runtime.runPromise(
              Effect.flatMap(
                SqlClient.SqlClient,
                (sql) =>
                  sql`
                    INSERT INTO browser_sessions (session_id, created_at, expires_at)
                    VALUES (${sidHash}, ${new Date(nowMs).toISOString()}, ${new Date(expMs).toISOString()})
                  `.pipe(Effect.ignore),
              ),
            );
            const location = safeRedirectPath(redeemed.payload.path);
            return HttpServerResponse.empty({
              status: 302,
              headers: {
                location,
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
                "set-cookie": `${cookieName()}=${sid}; HttpOnly; SameSite=Strict; Path=/`,
              },
            });
          });
        }),
      );

      // ---- Cookie-Authenticated SPA JSON API Endpoints ----

      // GET /api/library -> LibrarySnapshotResponse
      yield* router.add("GET", "/api/library", (req) =>
        Effect.promise(async () => {
          if (!(await hasBrowserSession(req))) return jsonResp(401, { error: "Session cookie required" });
          try {
            const data = await runtime.runPromise(
              Effect.gen(function* () {
                const cfgSvc = yield* ConfigService;
                const libSvc = yield* LibraryService;
                const setupSvc = yield* SetupService;
                const execSvc = yield* ExecutionService;
                const hub = yield* ProgressHub;

                const config = yield* cfgSvc.load();
                const listing = yield* libSvc.listLibrary();
                const snap = yield* setupSvc.snapshot();
                const running = yield* execSvc.runningJobs();
                const activeCalls = yield* hub.activeCalls();
                const pendingApprovals = yield* execSvc.listPendingApprovals();
                const history = yield* libSvc.toolHistory(90).pipe(Effect.orElseSucceed(() => []));

                const statusById = new Map(snap.sources.map((s) => [s.id, s]));
                const sources: SourceCatalogItem[] = SOURCES.map((plugin) => {
                  const st = statusById.get(plugin.id)!;
                  const actionNames = plugin.actions.map((a) => a.name);
                  const rowHistory = history.filter((h) => actionNames.includes(h.tool));
                  return {
                    ...st,
                    about: plugin.about,
                    providers: plugin.providers,
                    ...(plugin.logo ? { logo: plugin.logo } : {}),
                    ...(plugin.env ? { env: plugin.env } : {}),
                    ...(plugin.envSettings ? { envSettings: plugin.envSettings } : {}),
                    ...(plugin.requires ? { requires: plugin.requires } : {}),
                    tool: toolName(plugin.id),
                    slow: plugin.actions.filter((a) => a.slow).map((a) => a.name),
                    ...(rowHistory.length ? { history: rowHistory } : {}),
                  };
                });

                const allCalls = [
                  ...listing.items.flatMap((i) => i.calls),
                  ...listing.live,
                ];

                const response: LibrarySnapshotResponse = {
                  version: VERSION,
                  host: "any",
                  library: config.library,
                  configPath: config.path,
                  keysPath: snap.keysPath,
                  items: listing.items,
                  live: listing.live,
                  running,
                  activeCalls,
                  pendingApprovals,
                  sources,
                  groups: SOURCE_GROUPS,
                  accounts: snap.accounts,
                  spend: config.spend,
                  keepRaw: config.keep_raw,
                  searchSemantic: config.search.semantic,
                  cost: costSummary(allCalls),
                };
                return response;
              }),
            );
            return jsonResp(200, data);
          } catch (error) {
            return jsonResp(500, { error: errorMessage(error) });
          }
        }),
      );

      // POST /api/library/read -> LibraryReadResponse
      yield* router.add("POST", "/api/library/read", (req) =>
        Effect.promise(async () => {
          if (!(await hasBrowserSession(req))) return jsonResp(401, { error: "Session cookie required" });
          const csrfErr = checkSameOriginPost(req);
          if (csrfErr) return csrfErr;
          const parsed = await readJsonBody<LibraryReadRequest>(req);
          if (!parsed.ok) return parsed.response;
          const { file, offset, limit } = parsed.data;
          if (typeof file !== "string" || !file.trim()) {
            return jsonResp(400, { error: "file is required" });
          }
          if (offset !== undefined && (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)) {
            return jsonResp(400, { error: "offset must be a non-negative integer" });
          }
          if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)) {
            return jsonResp(400, { error: "limit must be a positive integer" });
          }
          try {
            const result = await runtime.runPromise(
              Effect.flatMap(LibraryService, (lib) => lib.readFile(file, offset, limit)),
            );
            return jsonResp(200, result);
          } catch (error) {
            return jsonResp(400, { error: errorMessage(error) });
          }
        }),
      );

      // POST /api/library/search -> LibrarySearchResponse
      yield* router.add("POST", "/api/library/search", (req) =>
        Effect.promise(async () => {
          if (!(await hasBrowserSession(req))) return jsonResp(401, { error: "Session cookie required" });
          const csrfErr = checkSameOriginPost(req);
          if (csrfErr) return csrfErr;
          const parsed = await readJsonBody<LibrarySearchRequest>(req);
          if (!parsed.ok) return parsed.response;
          const { query, project, dig, source, mode, limit } = parsed.data;
          if (typeof query !== "string" || !query.trim()) {
            return jsonResp(400, { error: "query is required" });
          }
          if (project !== undefined && typeof project !== "string") {
            return jsonResp(400, { error: "project must be a string" });
          }
          if (dig !== undefined && typeof dig !== "string") {
            return jsonResp(400, { error: "dig must be a string" });
          }
          if (source !== undefined && typeof source !== "string") {
            return jsonResp(400, { error: "source must be a string" });
          }
          if (mode !== undefined && mode !== "keyword" && mode !== "hybrid") {
            return jsonResp(400, { error: 'mode must be "keyword" or "hybrid"' });
          }
          if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)) {
            return jsonResp(400, { error: "limit must be a positive integer" });
          }
          const searchMode: SearchMode = mode === "keyword" ? "keyword" : "hybrid";
          try {
            const result = await runtime.runPromise(
              Effect.flatMap(SearchService, (svc) =>
                svc.search({ query, project, dig, source, mode: searchMode, limit }),
              ),
            );
            return jsonResp(200, result);
          } catch (error) {
            return jsonResp(400, { error: errorMessage(error) });
          }
        }),
      );

      // GET /api/settings -> SettingsResponse
      yield* router.add("GET", "/api/settings", (req) =>
        Effect.promise(async () => {
          if (!(await hasBrowserSession(req))) return jsonResp(401, { error: "Session cookie required" });
          try {
            const data = await runtime.runPromise(
              Effect.gen(function* () {
                const cfgSvc = yield* ConfigService;
                const config = yield* cfgSvc.load();
                return buildSettingsResponse(config, cfgSvc.flatValues(config));
              }),
            );
            return jsonResp(200, data);
          } catch (error) {
            return jsonResp(500, { error: errorMessage(error) });
          }
        }),
      );

      // POST /api/settings -> SettingsResponse
      yield* router.add("POST", "/api/settings", (req) =>
        Effect.promise(async () => {
          if (!(await hasBrowserSession(req))) return jsonResp(401, { error: "Session cookie required" });
          const csrfErr = checkSameOriginPost(req);
          if (csrfErr) return csrfErr;
          const parsed = await readJsonBody<SettingsUpdateRequest>(req);
          if (!parsed.ok) return parsed.response;
          const set = parsed.data?.set;
          if (!set || typeof set !== "object" || Array.isArray(set)) {
            return jsonResp(400, { error: "set object is required" });
          }
          try {
            const { updated, response } = await runtime.runPromise(
              Effect.gen(function* () {
                const cfgSvc = yield* ConfigService;
                const setupSvc = yield* SetupService;
                const next = yield* setupSvc.updateSettings(set);
                return { updated: next, response: buildSettingsResponse(next, cfgSvc.flatValues(next)) };
              }),
            );
            notifySettingsChanged(updated);
            return jsonResp(200, response);
          } catch (error) {
            return jsonResp(400, { error: errorMessage(error) });
          }
        }),
      );

      // GET /api/setup -> SetupSnapshotResponse
      yield* router.add("GET", "/api/setup", (req) =>
        Effect.promise(async () => {
          if (!(await hasBrowserSession(req))) return jsonResp(401, { error: "Session cookie required" });
          try {
            const snap = await runtime.runPromise(
              Effect.flatMap(SetupService, (setup) => setup.snapshot()),
            );
            return jsonResp(200, snap);
          } catch (error) {
            return jsonResp(500, { error: errorMessage(error) });
          }
        }),
      );

      // POST /api/setup/preset -> SetupSnapshotResponse
      yield* router.add("POST", "/api/setup/preset", (req) =>
        Effect.promise(async () => {
          if (!(await hasBrowserSession(req))) return jsonResp(401, { error: "Session cookie required" });
          const csrfErr = checkSameOriginPost(req);
          if (csrfErr) return csrfErr;
          const parsed = await readJsonBody<SetupPresetRequest>(req);
          if (!parsed.ok) return parsed.response;
          const preset = parsed.data?.preset;
          if (typeof preset !== "string" || !Object.hasOwn(SETUP_PRESETS, preset)) {
            return jsonResp(400, {
              error: `Unknown preset. Expected one of: ${Object.keys(SETUP_PRESETS).join(", ")}`,
            });
          }
          try {
            const { updated, snap } = await runtime.runPromise(
              Effect.gen(function* () {
                const setup = yield* SetupService;
                const next = yield* setup.applyPreset(preset);
                return { updated: next, snap: yield* setup.snapshot() };
              }),
            );
            notifySettingsChanged(updated);
            return jsonResp(200, snap);
          } catch (error) {
            return jsonResp(400, { error: errorMessage(error) });
          }
        }),
      );

      // POST /api/setup/sources -> SetupSnapshotResponse
      yield* router.add("POST", "/api/setup/sources", (req) =>
        Effect.promise(async () => {
          if (!(await hasBrowserSession(req))) return jsonResp(401, { error: "Session cookie required" });
          const csrfErr = checkSameOriginPost(req);
          if (csrfErr) return csrfErr;
          const parsed = await readJsonBody<SetupSourcesRequest>(req);
          if (!parsed.ok) return parsed.response;
          const enabled = parsed.data?.enabled;
          if (!Array.isArray(enabled) || enabled.some((id) => typeof id !== "string")) {
            return jsonResp(400, { error: "enabled must be an array of source ids" });
          }
          try {
            const { updated, snap } = await runtime.runPromise(
              Effect.gen(function* () {
                const setup = yield* SetupService;
                const next = yield* setup.setEnabledSources(enabled);
                return { updated: next, snap: yield* setup.snapshot() };
              }),
            );
            notifySettingsChanged(updated);
            return jsonResp(200, snap);
          } catch (error) {
            return jsonResp(400, { error: errorMessage(error) });
          }
        }),
      );

      // POST /api/setup/keys -> SetupKeysSaveResponse (NEVER echoes any key value!)
      yield* router.add("POST", "/api/setup/keys", (req) =>
        Effect.promise(async () => {
          if (!(await hasBrowserSession(req))) return jsonResp(401, { error: "Session cookie required" });
          const csrfErr = checkSameOriginPost(req);
          if (csrfErr) return csrfErr;
          const parsed = await readJsonBody<SetupKeysSaveRequest>(req);
          if (!parsed.ok) return parsed.response;
          const values = parsed.data?.values;
          if (!values || typeof values !== "object" || Array.isArray(values)) {
            return jsonResp(400, { error: "values object is required" });
          }
          const cleanValues: Record<string, string> = {};
          for (const [k, v] of Object.entries(values)) {
            if (typeof v === "string") cleanValues[k] = v;
          }
          try {
            const result = await runtime.runPromise(
              Effect.gen(function* () {
                const setup = yield* SetupService;
                const { saved } = yield* setup.saveKeys(cleanValues);
                const snapshot = yield* setup.snapshot();
                return { saved, snapshot };
              }),
            );
            return jsonResp(200, result);
          } catch (error) {
            const msg = errorMessage(error);
            const safeMsg =
              /^(?:[A-Z0-9_]+ is not a credential|The value for [A-Z0-9_]+ spans)/.test(msg)
                ? msg
                : "keys.env could not be written";
            return jsonResp(400, { error: safeMsg });
          }
        }),
      );

      // GET /api/events -> Typed SSE (`DigSseEvent`: connected, jobs_snapshot, live ProgressHub events, 25s heartbeat + snapshot resync)
      yield* router.add("GET", "/api/events", (req) =>
        Effect.gen(function* () {
          const authed = yield* Effect.promise(() => hasBrowserSession(req));
          if (!authed) return jsonResp(401, { error: "Session cookie required" });

          const hub = yield* Effect.promise(() => runtime.runPromise(ProgressHub));
          const readSnapshot = () =>
            Effect.promise(() =>
              runtime.runPromise(
                Effect.gen(function* () {
                  const h = yield* ProgressHub;
                  const exec = yield* ExecutionService;
                  return {
                    running: yield* exec.runningJobs(),
                    activeCalls: yield* h.activeCalls(),
                    pendingApprovals: yield* exec.listPendingApprovals(),
                  };
                }),
              ),
            );

          const encoder = new TextEncoder();
          const encodeSse = (payload: DigSseEvent): Uint8Array =>
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

          // Subscribe to ProgressHub FIRST before taking the initial snapshot so zero events are missed!
          const byteStream = Stream.callback<Uint8Array>((queue) =>
            Effect.gen(function* () {
              const pull = yield* Stream.toPull(hub.stream());
              const snap = yield* readSnapshot();
              const nowIso = new Date().toISOString();
              yield* Queue.offer(queue, encodeSse({ type: "connected", version: VERSION, at: nowIso }));
              yield* Queue.offer(
                queue,
                encodeSse({
                  type: "jobs_snapshot",
                  running: snap.running,
                  activeCalls: snap.activeCalls,
                  pendingApprovals: snap.pendingApprovals,
                  at: nowIso,
                }),
              );

              yield* Effect.forkScoped(
                Effect.forever(
                  Effect.gen(function* () {
                    const batch = yield* pull;
                    let needsSnapshot = false;
                    for (const event of batch) {
                      yield* Queue.offer(queue, encodeSse({ type: "event", event }));
                      if (event.type === "approval_requested" || event.type === "settings_changed") {
                        needsSnapshot = true;
                      }
                    }
                    if (needsSnapshot) {
                      const fresh = yield* readSnapshot().pipe(Effect.orElseSucceed(() => null));
                      if (fresh) {
                        yield* Queue.offer(
                          queue,
                          encodeSse({
                            type: "jobs_snapshot",
                            running: fresh.running,
                            activeCalls: fresh.activeCalls,
                            pendingApprovals: fresh.pendingApprovals,
                            at: new Date().toISOString(),
                          }),
                        );
                      }
                    }
                  }),
                ).pipe(Effect.catch(() => Effect.void)),
              );

              yield* Effect.forkScoped(
                Effect.forever(
                  Effect.sleep("25 seconds").pipe(
                    Effect.andThen(
                      Effect.gen(function* () {
                        const resync = yield* readSnapshot().pipe(
                          Effect.orElseSucceed(() => null),
                        );
                        const beatIso = new Date().toISOString();
                        if (resync) {
                          yield* Queue.offer(
                            queue,
                            encodeSse({
                              type: "jobs_snapshot",
                              running: resync.running,
                              activeCalls: resync.activeCalls,
                              pendingApprovals: resync.pendingApprovals,
                              at: beatIso,
                            }),
                          );
                        }
                        yield* Queue.offer(queue, encodeSse({ type: "heartbeat", at: beatIso }));
                      }),
                    ),
                  ),
                ),
              );
            }),
          );

          return HttpServerResponse.stream(byteStream, {
            status: 200,
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              connection: "keep-alive",
              "x-accel-buffering": "no",
            },
          });
        }),
      );

      // Catch-all unknown /api/* -> JSON 404 (never falls through to SPA HTML)
      yield* router.add("*", "/api/*", (req) =>
        Effect.promise(async () => {
          if (!(await hasBrowserSession(req))) return jsonResp(401, { error: "Session cookie required" });
          return jsonResp(404, { error: "API route not found" });
        }),
      );

      // ---- Cookie-Authenticated Static SPA Asset & Client-Route Server ----
      const spaHandler = (req: HttpServerRequest.HttpServerRequest) =>
        Effect.promise(async () => {
          if (!(await hasBrowserSession(req))) return unauthSpaPage();
          const url = Option.getOrUndefined(HttpServerRequest.toURL(req));
          return serveSpaPath(url?.pathname ?? "/");
        });

      yield* router.add("GET", "/", spaHandler);
      yield* router.add("GET", "/*", spaHandler);
    }),
  );

  // Build the router into an HttpEffect once (using a long-lived Scope disposed on `close()`).
  const routerScope = await Effect.runPromise(Scope.make());
  const routerEffect = await Effect.runPromise(
    HttpRouter.toHttpEffect(routesLayer).pipe(Scope.provide(routerScope)),
  );

  // Global Host & Origin DNS-rebinding / CSRF guard running BEFORE every route.
  const httpApp = Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    const port = getPort();
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

    const host = req.headers.host ?? "";
    if (!allowedHosts.has(host)) {
      return jsonResp(403, { error: "Forbidden host" });
    }
    const origin = req.headers.origin;
    const reqPath = Option.getOrUndefined(HttpServerRequest.toURL(req))?.pathname ?? "";
    const allowNullFormOrigin =
      req.method === "POST" &&
      origin === "null" &&
      req.headers["sec-fetch-site"] === "same-origin" &&
      (reqPath.startsWith("/keys/") || reqPath.startsWith("/approve/"));
    if (origin !== undefined && !allowedOrigins.has(origin) && !allowNullFormOrigin) {
      return jsonResp(403, { error: "Forbidden origin" });
    }

    return yield* routerEffect.pipe(
      Effect.catch((err) => {
        const reason =
          err && typeof err === "object" && "reason" in err
            ? (err as { reason?: { _tag?: string } }).reason
            : undefined;
        if (reason?._tag === "RouteNotFound") {
          return Effect.succeed(jsonResp(404, { error: "Not found" }));
        }
        return Effect.succeed(jsonResp(500, { error: errorMessage(err) }));
      }),
    );
  });

  const sweepSessions = () => {
    pruneMaps();
    const now = Date.now();
    for (const [id, session] of mcpSessions) {
      if (now - session.lastSeen > MCP_SESSION_MS) closeMcpSession(id);
    }
  };

  const close = async () => {
    for (const code of [...keyWaiters.keys()]) wakeKeyCode(code);
    for (const id of [...mcpSessions.keys()]) closeMcpSession(id);
    await modern.close().catch(() => {});
    await Effect.runPromise(Scope.close(routerScope, Exit.void)).catch(() => {});
  };

  return {
    httpApp,
    notifySettingsChanged,
    sweepSessions,
    close,
    sessionCount: () => mcpSessions.size,
  };
}
