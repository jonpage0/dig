/**
 * DataForSEO source plugin (Effect 4.1.5):
 * - dataforseo_docs_sections: list DataForSEO v3 documentation sections (`FreeHttp`, `billing: "free"`)
 * - dataforseo_docs_index: search DataForSEO v3 documentation pages (`FreeHttp`, `billing: "free"`)
 * - dataforseo_docs_read: read one DataForSEO v3 documentation Markdown page (`FreeHttp`, `billing: "free"`)
 * - dataforseo_request: call any DataForSEO v3 endpoint (`PaidHttp`, zero retries, `timeoutMs: 300_000`,
 *   `slow: true`, live `ctx.progress(...)` updates, USD metered billing with free sandbox `noCharge`)
 */
import { Effect, Result, Schema } from "effect";
import { freeRequest, paidRequest, type FreeHttp } from "../../core/http.ts";
import {
  defineAction,
  defineSource,
  failed,
  meteredBilling,
  outcome,
  setOutsideChat,
  type ActionContext,
  type ActionOutcome,
  type OutcomeStatus,
  type SourcePlugin,
} from "../../core/plugin.ts";
import { knownSecrets, redactValue, registerSecret } from "../../core/secrets.ts";

const DOCS_HOST = "docs.dataforseo.com";
const DOCS_ROOT = `https://${DOCS_HOST}/v3`;
const DOCS_INDEX = `${DOCS_ROOT}/llms.txt`;
const API_HOSTS = {
  live: "https://api.dataforseo.com/v3/",
  sandbox: "https://sandbox.dataforseo.com/v3/",
} as const;

const ACCEPTED = new Set([20000, 20100]);
const NOT_READY = new Set([20100, 40601, 40602]);
const NO_RESULTS = 40102;
const PARTIAL_RESULTS = 40106;
const OUTPUT_LIMIT = 60_000;
const REQUEST_TIMEOUT_MS = 300_000;
const DOCS_TIMEOUT_MS = 60_000;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const UNANSWERED_COST =
  "DataForSEO may have received and charged this request, but no complete response arrived; its cost is unknown.";

export interface DocEntry {
  readonly section: string;
  readonly trail: readonly string[];
  readonly title: string;
  readonly path: string;
  readonly url: string;
  readonly summary: string;
}

interface DfsTask {
  readonly id?: string;
  readonly status_code?: number;
  readonly status_message?: string;
  readonly cost?: number;
  readonly result_count?: number;
  readonly path?: readonly string[];
  readonly data?: unknown;
  readonly result?: readonly unknown[] | null;
}

interface DfsEnvelope {
  readonly status_code?: number;
  readonly status_message?: string;
  readonly time?: string;
  readonly cost?: number;
  readonly tasks_count?: number;
  readonly tasks_error?: number;
  readonly tasks?: readonly DfsTask[];
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function v3Path(value: unknown): { ok: true; path: string } | { ok: false; error: string } {
  let path = String(value ?? "").trim();
  path = path.replace(/^https:\/\/(?:docs|api|sandbox)\.dataforseo\.com/i, "");
  path = path.replace(/[?#].*$/, "").replace(/^\/+/, "").replace(/^v3(?:\.md)?(?:\/|$)/, "");
  path = path.replace(/\/+$/, "").replace(/\.md$/, "");
  if (path && !path.split("/").every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..")) {
    return { ok: false, error: `"${String(value)}" is not a DataForSEO v3 path` };
  }
  return { ok: true, path };
}

const docsUrl = (path: string): string => (path ? `${DOCS_ROOT}/${path}.md` : `${DOCS_ROOT}.md`);

const plain = (text: string): string =>
  text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

export function parseDocsIndex(text: string): DocEntry[] {
  const trail: string[] = [];
  const entries: DocEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const depth = heading[1]!.length - 2;
      trail.length = depth;
      trail[depth] = heading[2]!;
      continue;
    }
    const entry = /^- \[(.+?)\]\((https:\/\/docs\.dataforseo\.com\/v3[^)\s]*)\)(?:\s+—\s+(.*))?$/.exec(line);
    if (!entry) continue;
    const parsed = v3Path(entry[2]);
    if (!parsed.ok) continue;
    const summary = plain(entry[3] ?? "");
    entries.push({
      section: trail[0] ?? "General",
      trail: trail.filter(Boolean),
      title: entry[1]!,
      path: parsed.path,
      url: docsUrl(parsed.path),
      summary: summary.length > 200 ? `${summary.slice(0, 199)}…` : summary,
    });
  }
  return entries;
}

function fetchDocs(
  url: string,
  label: string,
  ctx: Pick<ActionContext, "signal" | "keep">,
): Effect.Effect<
  { readonly ok: true; readonly status: number; readonly text: string } | { readonly ok: false; readonly cancelled: boolean; readonly error: string },
  never,
  FreeHttp
> {
  return Effect.gen(function* () {
    let target = new URL(url);
    for (let hop = 0; ; hop++) {
      if (ctx.signal.aborted) return { ok: false as const, cancelled: true, error: "cancelled" };
      const res = yield* Effect.result(
        freeRequest({
          url: target.href,
          method: "GET",
          headers: { accept: "text/markdown, text/plain;q=0.9" },
          timeoutMs: DOCS_TIMEOUT_MS,
          signal: ctx.signal,
          followRedirects: false,
          label,
          keep: ctx.keep,
        }),
      );
      if (Result.isFailure(res)) {
        if (ctx.signal.aborted) return { ok: false as const, cancelled: true, error: "cancelled" };
        return { ok: false as const, cancelled: false, error: errorText(res.failure) };
      }
      if (ctx.signal.aborted) return { ok: false as const, cancelled: true, error: "cancelled" };
      const { status, text, headers } = res.success;
      const location = headers.location;
      if (status >= 300 && status < 400 && location) {
        const next = new URL(location, target);
        if (next.protocol !== "https:" || next.host !== DOCS_HOST) {
          return { ok: false as const, cancelled: false, error: `the docs site redirected to another host (${next.host})` };
        }
        if (hop >= 3) {
          return { ok: false as const, cancelled: false, error: "the docs site redirected more than three times" };
        }
        target = next;
        continue;
      }
      return { ok: true as const, status, text };
    }
  });
}

function loadDocsIndex(
  ctx: Pick<ActionContext, "signal" | "keep">,
): Effect.Effect<
  { readonly ok: true; readonly entries: DocEntry[] } | { readonly ok: false; readonly cancelled: boolean; readonly error: string },
  never,
  FreeHttp
> {
  return Effect.gen(function* () {
    const res = yield* fetchDocs(DOCS_INDEX, "docs index", ctx);
    if (!res.ok) return res;
    if (res.status < 200 || res.status >= 300) {
      return { ok: false as const, cancelled: false, error: `the documentation index returned HTTP ${res.status}` };
    }
    const entries = parseDocsIndex(res.text);
    if (!entries.length) {
      return { ok: false as const, cancelled: false, error: "the documentation index had no endpoint entries" };
    }
    return { ok: true as const, entries };
  });
}

function bounded(value: unknown, fallback: number, max: number): number {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) && number >= 0 ? Math.min(number, max) : fallback;
}

/** Drops null, empty strings, empty arrays and empty objects. */
export function compact(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(compact).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, compact(item)] as const)
      .filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value === null || value === "" ? undefined : value;
}

const usd = (value: unknown): string =>
  typeof value === "number" && Number.isFinite(value) ? `$${value}` : "not reported";

type TaskClass = "results" | "none" | "partial" | "notReady" | "error";

function classify(task: DfsTask): TaskClass {
  const code = Number(task.status_code);
  if (NOT_READY.has(code)) return "notReady";
  if (code === NO_RESULTS) return "none";
  if (code === PARTIAL_RESULTS) return "partial";
  if (code !== 20000) return "error";
  return Array.isArray(task.result) && task.result.length > 0 ? "results" : "none";
}

function describe(
  payload: unknown,
  httpStatus: number,
  call: { readonly method: string; readonly path: string; readonly sandbox: boolean },
): ActionOutcome {
  const where = call.sandbox ? "sandbox: free dummy data, not evidence" : "live API";
  const head = `DataForSEO ${call.method} ${call.path} (${where})`;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return failed(`${head}: HTTP ${httpStatus} without a DataForSEO response envelope.`);
  }
  const body = redactValue(payload, knownSecrets()) as DfsEnvelope;
  const tasks = Array.isArray(body.tasks) ? body.tasks : [];
  const lines = [
    head,
    `Status ${body.status_code ?? "missing"} ${body.status_message ?? ""}`.trim() +
      ` · returned cost ${usd(body.cost)} · ${tasks.length} task${tasks.length === 1 ? "" : "s"}, ${body.tasks_error ?? 0} with errors · ${body.time ?? "time not reported"}`,
    ...tasks.map(
      (task) =>
        `Task ${task.id ?? "(no id)"}: ${task.status_code ?? "missing"} ${task.status_message ?? ""} · cost ${usd(task.cost)} · result_count ${task.result_count ?? 0}`,
    ),
  ];
  const details = {
    endpoint: call.path,
    method: call.method,
    sandbox: call.sandbox,
    statusCode: body.status_code ?? null,
    tasks: tasks.map((task) => ({
      id: task.id ?? null,
      statusCode: task.status_code ?? null,
      statusMessage: task.status_message ?? null,
      reportedCostUsd: typeof task.cost === "number" ? task.cost : null,
      resultCount: task.result_count ?? 0,
    })),
  };
  if (!ACCEPTED.has(Number(body.status_code))) {
    return outcome(
      "failed",
      `${lines.join("\n")}\nThe request failed; look up the status code in the documentation's Appendix (errors).`,
      details,
    );
  }
  const classes = tasks.map(classify);
  const status: OutcomeStatus =
    classes.length && classes.every((c) => c === "error")
      ? "failed"
      : classes.some((c) => c === "error" || c === "partial")
        ? "partial"
        : classes.some((c) => c === "results" || c === "notReady")
          ? "success"
          : "empty";
  const notes = [
    classes.includes("notReady")
      ? "A task without results yet (20100, 40601, 40602) is retrieved later with its documented task_get path and id."
      : null,
    classes.includes("partial")
      ? "40106: DataForSEO returned partial results and did not charge for pages it could not retrieve."
      : null,
    classes.includes("error") ? "Look up other task codes in the documentation's Appendix (errors)." : null,
  ].filter((note): note is string => note !== null);
  const results =
    JSON.stringify(
      compact(
        tasks.map((task) => ({
          id: task.id,
          status_code: task.status_code,
          data: task.data,
          result: task.result,
        })),
      ),
    ) ?? "[]";
  const truncated = results.length > OUTPUT_LIMIT;
  const shown = truncated
    ? `${results.slice(0, OUTPUT_LIMIT)}\n[Truncated at ${OUTPUT_LIMIT} of ${results.length} characters. The complete response is this call's original response when raw retention is on; read it with library_read using the receipt's raw file.]`
    : results;
  return outcome(
    status,
    `${[...lines, ...notes].join("\n")}\n\nTasks (data echoes the request; null and empty fields omitted):\n${shown}`,
    { ...details, truncated },
  );
}

// ---------------------------------------------------------------------------
// Actions 1–3: free documentation readers
// ---------------------------------------------------------------------------

const DocsSectionsSchema = Schema.Struct({});

export const dataforseoDocsSectionsAction = defineAction({
  name: "dataforseo_docs_sections",
  description:
    "List DataForSEO v3 documentation sections (SERP, Labs, Keywords Data, Backlinks, Business Data, …) with their subsections and page counts.",
  schema: DocsSectionsSchema,
  billing: "free",
  execute: (_args, ctx) =>
    Effect.gen(function* () {
      const index = yield* loadDocsIndex(ctx);
      if (!index.ok) {
        return index.cancelled
          ? outcome("cancelled", "Research call cancelled")
          : failed(`DataForSEO documentation index failed: ${index.error}`);
      }
      const sections = new Map<string, { pages: number; parts: Set<string> }>();
      for (const entry of index.entries) {
        const section = sections.get(entry.section) ?? { pages: 0, parts: new Set<string>() };
        section.pages += 1;
        if (entry.trail[1]) section.parts.add(entry.trail[1]);
        sections.set(entry.section, section);
      }
      const lines = [...sections].map(
        ([name, { pages, parts }]) => `- ${name} (${pages} pages)${parts.size ? `: ${[...parts].join(", ")}` : ""}`,
      );
      return outcome(
        "success",
        `DataForSEO documentation sections:\n${lines.join("\n")}\n\nList a section's pages with dataforseo_docs_index.`,
      );
    }),
});

const DocsIndexSchema = Schema.Struct({
  section: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'Top-level documentation section, e.g. "SERP API" or "DataForSEO Labs API" (case-insensitive part of the name).',
    }),
  ),
  query: Schema.optionalKey(
    Schema.String.annotate({
      description: "Words that must all appear in a page's title, path, heading trail or summary.",
    }),
  ),
  offset: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Matches to skip (default: 0).",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })).annotate({
      description: "Matches to return (default: 50, max: 200).",
    }),
  ),
});

export const dataforseoDocsIndexAction = defineAction({
  name: "dataforseo_docs_index",
  description:
    "Find DataForSEO v3 documentation pages by section and words; returns each page's path for dataforseo_docs_read.",
  schema: DocsIndexSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const index = yield* loadDocsIndex(ctx);
      if (!index.ok) {
        return index.cancelled
          ? outcome("cancelled", "Research call cancelled")
          : failed(`DataForSEO documentation index failed: ${index.error}`);
      }
      const section = String(args.section ?? "").trim().toLowerCase();
      const words = String(args.query ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const offset = bounded(args.offset, 0, Number.MAX_SAFE_INTEGER);
      const limit = Math.max(1, bounded(args.limit, 50, 200));
      const matches = index.entries.filter((entry) => {
        if (section && !entry.section.toLowerCase().includes(section)) return false;
        const haystack = `${entry.title}\n${entry.path}\n${entry.trail.join(" ")}\n${entry.summary}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      });
      if (!matches.length) {
        return outcome(
          "empty",
          `No DataForSEO documentation pages matched${section ? ` section "${args.section}"` : ""}${words.length ? ` and "${args.query}"` : ""}. List sections with dataforseo_docs_sections.`,
        );
      }
      const page = matches.slice(offset, offset + limit);
      const next = offset + limit < matches.length ? offset + limit : null;
      const lines = page.map(
        (entry) =>
          `- ${entry.title} — ${entry.path || entry.url} — ${entry.trail.join(" › ")}${entry.summary ? ` — ${entry.summary}` : ""}`,
      );
      const range = page.length ? `${offset + 1}–${offset + page.length}` : "none";
      return outcome(
        page.length ? "success" : "empty",
        `DataForSEO documentation pages ${range} of ${matches.length}${next === null ? "" : `; continue at offset ${next}`}:\n${lines.join("\n")}\n\nRead a page with dataforseo_docs_read before calling its endpoint.`,
        { total: matches.length, nextOffset: next },
      );
    }),
});

const DocsReadSchema = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "Documentation path such as serp/google/organic/live/advanced, or its full docs.dataforseo.com URL.",
  }),
  offset: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Character offset to continue from (default: 0).",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })).annotate({
      description: "Characters to return (default: 40000, max: 100000).",
    }),
  ),
});

export const dataforseoDocsReadAction = defineAction({
  name: "dataforseo_docs_read",
  description:
    "Read one DataForSEO v3 documentation page (method, parameters, limits, response fields) by path or docs URL, in pages of characters.",
  schema: DocsReadSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const parsed = v3Path(args.path);
      if (!parsed.ok) return failed(`DataForSEO documentation read failed: ${parsed.error}`);
      const path = parsed.path;
      const offset = bounded(args.offset, 0, Number.MAX_SAFE_INTEGER);
      const limit = Math.max(1, bounded(args.limit, 40_000, 100_000));
      const res = yield* fetchDocs(docsUrl(path), `docs ${path || "home"}`, ctx);
      if (!res.ok) {
        return res.cancelled
          ? outcome("cancelled", "Research call cancelled")
          : failed(`DataForSEO documentation read failed: ${res.error}`);
      }
      if (res.status === 404) {
        return failed(`No DataForSEO documentation page at "${path}". Find the exact path with dataforseo_docs_index.`);
      }
      if (res.status < 200 || res.status >= 300) {
        return failed(`DataForSEO documentation returned HTTP ${res.status} for "${path}"`);
      }
      const slice = res.text.slice(offset, offset + limit);
      const end = offset + slice.length;
      const next = end < res.text.length ? end : null;
      return outcome(
        "success",
        `${docsUrl(path)} · characters ${offset}–${end} of ${res.text.length}${next === null ? ", complete" : `; continue at offset ${next}`}\n\n${slice}`,
        { path, totalCharacters: res.text.length, nextOffset: next },
      );
    }),
});

// ---------------------------------------------------------------------------
// Action 4: dataforseo_request (slow, PaidHttp, 300s timeout, live progress)
// ---------------------------------------------------------------------------

const DataForSeoRequestSchema = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "Endpoint path after /v3/, exactly as documented, e.g. serp/google/organic/live/advanced or serp/google/locations/us. Full responses only: no .ai suffix.",
  }),
  method: Schema.optionalKey(
    Schema.Literals(["GET", "POST"]).annotate({
      description:
        "HTTP method from the endpoint's documentation. Default: POST when tasks are given, otherwise GET.",
    }),
  ),
  tasks: Schema.optionalKey(
    Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
      .check(Schema.isMinLength(1), Schema.isMaxLength(100))
      .annotate({
        description: "POST body: the documented array of task objects (a Live endpoint takes one task).",
      }),
  ),
  sandbox: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Use DataForSEO's free sandbox, which returns dummy data in the real response shape. For checking a request, never as evidence.",
    }),
  ),
});

export const dataforseoRequestAction = defineAction({
  name: "dataforseo_request",
  description:
    "Call any DataForSEO v3 endpoint with the documented method and task array. Paid per request: the returned USD cost is recorded. sandbox: true returns free dummy data for checking a request shape, and records no charge.",
  schema: DataForSeoRequestSchema,
  slow: true,
  billing: meteredBilling<Schema.Schema.Type<typeof DataForSeoRequestSchema>>(
    "USD",
    (body) => {
      const cost = (body as DfsEnvelope | null)?.cost;
      return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
    },
    (args) => args.sandbox === true,
  ),
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const given = String(args.path ?? "").trim();
      if (/^https:\/\/sandbox\.dataforseo\.com/i.test(given) && args.sandbox !== true) {
        return failed(
          "path names the sandbox host, but sandbox is not set. Pass sandbox: true for the free sandbox, or give the bare path after /v3/ for the live API.",
        );
      }
      if (given.includes("?")) {
        return failed(
          "path must not carry a query string: Dig sends only the path after /v3/. Give the endpoint's parameters as the documented path segments, or as tasks in a POST.",
        );
      }
      const parsed = v3Path(args.path);
      if (!parsed.ok) return failed(parsed.error);
      const path = parsed.path;
      if (!path) return failed("path is required: the endpoint path after /v3/, as documented");
      if (/\.ai$/.test(path)) {
        return failed(
          "Request the full response without the .ai suffix: only the full response reports the call's cost, and Dig trims the output itself.",
        );
      }
      const tasks = args.tasks;
      const method: "GET" | "POST" = args.method ?? (tasks === undefined ? "GET" : "POST");
      if (method === "POST" && (!Array.isArray(tasks) || !tasks.length)) {
        return failed("POST needs tasks: the documented array of task objects");
      }
      if (method === "GET" && tasks !== undefined) {
        return failed("GET takes no tasks; its parameters are part of the documented path");
      }
      const login = process.env.DATAFORSEO_USERNAME?.trim();
      const password = process.env.DATAFORSEO_PASSWORD?.trim();
      if (!login || !password) {
        return failed(
          `DATAFORSEO_USERNAME and DATAFORSEO_PASSWORD must both be set in Dig's keys.env (DataForSEO's API login and API password). ${setOutsideChat(true)}`,
        );
      }

      const basic = Buffer.from(`${login}:${password}`).toString("base64");
      registerSecret(basic);
      const sandbox = args.sandbox === true;
      const targetUrl = `${sandbox ? API_HOSTS.sandbox : API_HOSTS.live}${path}`;

      ctx.progress({
        progress: 1,
        total: 3,
        message: `Sending DataForSEO ${method} ${path}${sandbox ? " (sandbox)" : ""}`,
      });

      const res = yield* Effect.result(
        paidRequest({
          url: targetUrl,
          method,
          headers: {
            authorization: `Basic ${basic}`,
            "content-type": "application/json",
          },
          body: method === "POST" ? tasks : undefined,
          timeoutMs: REQUEST_TIMEOUT_MS,
          signal: ctx.signal,
          label: `${method} ${path}`,
          keep: ctx.keep,
        }),
      );

      if (Result.isFailure(res)) {
        if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
        const msg = errorText(res.failure);
        ctx.progress({ progress: 3, total: 3, message: `DataForSEO ${method} ${path} failed: ${msg}` });
        return failed(`DataForSEO request failed: ${msg}${sandbox ? "" : `. ${UNANSWERED_COST}`}`);
      }
      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");

      const { status: httpStatus, payload, headers } = res.success;
      ctx.progress({
        progress: 2,
        total: 3,
        message: `Received HTTP ${httpStatus} from DataForSEO ${path}; formatting tasks`,
      });

      if (httpStatus >= 300 && httpStatus < 400) {
        const location = headers.location;
        ctx.progress({ progress: 3, total: 3, message: `DataForSEO ${path} returned redirect HTTP ${httpStatus}` });
        return failed(
          `DataForSEO answered HTTP ${httpStatus}${location ? ` with a redirect to ${location}` : ""}. Dig does not follow redirects for API requests; check the documented path.`,
        );
      }

      const result = describe(payload, httpStatus, { method, path, sandbox });
      ctx.progress({
        progress: 3,
        total: 3,
        message: `Completed DataForSEO ${method} ${path} (${result.status})`,
      });
      return result;
    }),
});

export const dataforseoSource: SourcePlugin = defineSource({
  id: "dataforseo",
  group: "markets",
  skills: ["dataforseo", "dataforseo-ai-visibility"],
  label: "DataForSEO",
  description: "SERPs, keywords, rankings, backlinks, local business and AI visibility",
  about:
    "Search-market data: Google results pages, keyword volumes, rankings, backlinks, local businesses and AI-search visibility, plus Google Trends, the ads a company runs on Google, and app-store and Trustpilot reviews. Dig reads DataForSEO's documentation before calling an endpoint.",
  providers: [{ name: "DataForSEO v3 API", url: "https://dataforseo.com" }],
  billing:
    "Paid per request in US dollars from a prepaid DataForSEO account. Dig records the cost each live response reports, and unknown when no complete response arrived; the free sandbox checks request shapes with dummy data and records no charge.",
  env: ["DATAFORSEO_USERNAME", "DATAFORSEO_PASSWORD"],
  keys: ["DATAFORSEO_USERNAME", "DATAFORSEO_PASSWORD"],
  credential:
    "DATAFORSEO_USERNAME and DATAFORSEO_PASSWORD: the API login and API password from DataForSEO's API Access page, not your dashboard password",
  actions: [
    dataforseoDocsSectionsAction,
    dataforseoDocsIndexAction,
    dataforseoDocsReadAction,
    dataforseoRequestAction,
  ],
});

export default dataforseoSource;
