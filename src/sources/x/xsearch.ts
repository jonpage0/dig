/**
 * `xsearch`: X.com Search via xAI Agent Tools API (`PaidHttp`, `slow: true`).
 *
 * - Reads `[x]` defaults (`model`, `depth`, `web_search`, `code_execution`) from Dig's
 *   `config.toml` at `stateDirectory()`, falling back cleanly to `X_DEFAULTS`.
 * - Streams `POST /v1/responses` over `PaidHttp` (zero retries, manual redirects) and emits
 *   live `ctx.progress(...)` updates for completed search rounds and recovery polling.
 * - Preserves read-only `recoverResponseId` (noCharge) and durable `reconcile(remoteJobId)`
 *   via `GET /v1/responses/:id`, NEVER re-POSTing an interrupted paid request.
 */
import { readFileSync } from "node:fs";
import TOML from "@iarna/toml";
import { Duration, Effect, Result, Schema, Stream } from "effect";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { Lexer, type Token, type Tokens } from "marked";
import {
  configPath,
  stateDirectory,
  X_DEFAULTS,
  X_DEPTHS,
  type XDepth,
} from "../../core/config.ts";
import { PaidHttp, type KeepRaw } from "../../core/http.ts";
import {
  defineAction,
  failed,
  meteredBilling,
  outcome,
  setOutsideChat,
  type ActionOutcome,
  type ToolProgress,
} from "../../core/plugin.ts";
import { knownSecrets, redactProviderText, redactText } from "../../core/secrets.ts";
import { abortableSleep } from "./api-client.ts";

const API_BASE = "https://api.x.ai/v1";
const USD_TICKS_PER_DOLLAR = 10_000_000_000;
const RAW_LABEL = "x_search";
const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed"]);
const FINISHED = new Set(["completed", "incomplete", "failed", "cancelled"]);
const MAX_PROGRESS_DETAIL = 120;
const MAX_TRACKED_PROGRESS_KEYS = 500;
const RECOVERY_GET_TIMEOUT_MS = 30_000;

/** Configurable recovery poll waits after a cut SSE stream (shortened in tests). */
export const RECOVERY = { waitsMs: [2_000, 8_000] as readonly number[] };

export type XSearchMode = "standard" | "semantic";
export type XSearchDepth = XDepth;
type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface XDefaultsConfig {
  readonly model: string;
  readonly depth: XDepth;
  readonly web_search: boolean;
  readonly code_execution: boolean;
}

/**
 * Load `[x]` defaults from `<DIG_STATE_DIR>/config.toml`, falling back to `X_DEFAULTS`
 * whenever `config.toml` is absent or omits `[x]` fields.
 */
export function loadXDefaults(env: NodeJS.ProcessEnv = process.env): XDefaultsConfig {
  try {
    const raw = readFileSync(configPath(stateDirectory(env)), "utf8");
    const parsed = TOML.parse(raw) as Record<string, unknown>;
    const xRaw = parsed.x;
    if (!xRaw || typeof xRaw !== "object" || Array.isArray(xRaw)) return { ...X_DEFAULTS };
    const x = xRaw as Record<string, unknown>;
    const model =
      typeof x.model === "string" && x.model.trim() ? x.model.trim() : X_DEFAULTS.model;
    const depth: XDepth =
      typeof x.depth === "string" && (X_DEPTHS as readonly string[]).includes(x.depth)
        ? (x.depth as XDepth)
        : X_DEFAULTS.depth;
    const web_search = typeof x.web_search === "boolean" ? x.web_search : X_DEFAULTS.web_search;
    const code_execution =
      typeof x.code_execution === "boolean" ? x.code_execution : X_DEFAULTS.code_execution;
    return { model, depth, web_search, code_execution };
  } catch {
    return { ...X_DEFAULTS };
  }
}

interface XSearchToolConfig {
  type: "x_search";
  allowed_x_handles?: string[];
  excluded_x_handles?: string[];
  from_date?: string;
  to_date?: string;
  enable_image_understanding?: boolean;
  enable_video_understanding?: boolean;
}

interface WebSearchToolConfig {
  type: "web_search";
  filters?: {
    allowed_domains?: string[];
    excluded_domains?: string[];
  };
}

interface CodeInterpreterToolConfig {
  type: "code_interpreter";
}

type ToolConfig = XSearchToolConfig | WebSearchToolConfig | CodeInterpreterToolConfig;

interface InputMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

interface ResponsesRequest {
  model: string;
  input: InputMessage[];
  tools: ToolConfig[];
  store?: boolean;
  reasoning?: {
    effort: ReasoningEffort;
  };
  previous_response_id?: string;
  stream?: boolean;
}

interface MessageOutput {
  readonly type: "message";
  readonly id: string;
  readonly role: string;
  readonly content: ReadonlyArray<{
    readonly type: "output_text";
    readonly text: string;
    readonly annotations?: ReadonlyArray<{
      readonly type: "url_citation";
      readonly url: string;
      readonly title?: string;
      readonly start_index: number;
      readonly end_index: number;
    }>;
  }>;
  readonly status?: string;
}

interface ResponsesResponse {
  readonly id: string;
  readonly status?: string;
  readonly incomplete_details?: { readonly reason?: string };
  readonly output: ReadonlyArray<MessageOutput | { readonly type: string; readonly [key: string]: unknown }>;
  readonly citations?: readonly string[];
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly reasoning_tokens?: number;
    readonly output_tokens_details?: {
      readonly reasoning_tokens?: number;
    };
    readonly total_tokens?: number;
    readonly cost_in_usd_ticks?: number;
    readonly num_sources_used?: number;
    readonly num_server_side_tools_used?: number;
    readonly server_side_tool_usage_details?: Record<string, number>;
  };
  readonly server_side_tool_usage?: Record<string, number>;
  readonly error?: {
    readonly message: string;
    readonly code?: string;
  };
}

type Stored =
  | { readonly state: "finished"; readonly body: Record<string, unknown> }
  | { readonly state: "running" }
  | { readonly state: "missing" }
  | { readonly state: "cancelled" }
  | { readonly state: "error"; readonly status: number | string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateRange(fromDate?: string, toDate?: string): string {
  return [
    fromDate ? `from ${fromDate} 00:00 UTC (inclusive)` : "start not set",
    toDate ? `before ${toDate} 00:00 UTC (exclusive)` : "end not set",
  ].join("; ");
}

function buildSystemMessage(options: {
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly webSearchEnabled: boolean;
  readonly mode: XSearchMode;
}): string {
  const today = new Date().toISOString().split("T")[0];

  let message =
    options.mode === "semantic"
      ? `You are an X.com semantic lead finder. Current Date: ${today} (UTC).

SEMANTIC SEED MODE:
1. Use ONLY x_semantic_search (2 to 4 calls in 1 parallel round). Do NOT call x_keyword_search, x_thread_fetch, or x_user_search.
2. Stop immediately after that first round and return a concise bullet list of up to 20 distinct relevant X posts.
3. Cite every post inline with its full link (https://x.com/<handle>/status/<id>) and a 1-sentence note on what it says or why it matches. Never cite a post by number, such as [3] or [post:12]: numbers do not reach the reader as links.
4. If no posts match, state clearly "No results found" and explain why. Never fabricate posts.`
      : `You are an X.com search specialist. Current Date: ${today} (UTC).

Your job:
1. Use the x_search tool to find relevant X.com posts
2. Analyze the posts you find
3. Report findings, citing each post inline where you use it with its full link (https://x.com/<handle>/status/<id>). Never cite a post by number, such as [3] or [post:12]: numbers do not reach the reader as links.
4. If no results, state clearly "No results found" and explain why

Response Format:
- Summary (1-3 sentences)
- Key Findings with citations
- Claims vs Discourse: distinguish corroborated facts from social-media claims or vibes
- Evidence Table or Timeline when it materially improves clarity
- Sentiment/Discourse (if applicable)
- Negative Evidence: note material handles, time windows, or query angles that produced weak/no signal

Never fabricate posts. If search returns empty, say so clearly.`;

  if (options.webSearchEnabled) {
    message +=
      "\n\nYou also have web_search available. Prioritize X.com posts — they are the primary source. Use web search only to verify claims or add context from official sources.";
  }

  if (options.fromDate || options.toDate) {
    message += `\n\nDate constraints: ${dateRange(options.fromDate, options.toDate)}.`;
  }

  return message;
}

function parseError(status: number, errorText: string): string {
  try {
    const errorJson = JSON.parse(errorText) as { error?: string | { message?: string } };
    const message = typeof errorJson.error === "string" ? errorJson.error : errorJson.error?.message;
    if (typeof message === "string" && message) return message;
  } catch {
    // Non-JSON error body handled below.
  }
  if (status === 401 || status === 403) {
    return `AUTH_ERROR: ${errorText || "Authentication failed - check XAI_API_KEY"}`;
  }
  if (status === 429) return `RATE_LIMIT: ${errorText || "Too many requests - try again later"}`;
  if (status === 402) {
    return `PAYMENT_REQUIRED: ${errorText || "Insufficient credits - add funds at console.x.ai"}`;
  }
  if (status === 410) return `API_DEPRECATED: ${errorText || "This API endpoint has been deprecated"}`;
  if (status >= 500) return `SERVER_ERROR: ${errorText || "xAI API server error - try again later"}`;
  return errorText || `HTTP ${status}`;
}

function extractContent(
  response: ResponsesResponse,
): { readonly text: string; readonly sources: Array<{ readonly url: string; readonly title?: string }> } {
  let text = "";
  const sources: Array<{ readonly url: string; readonly title?: string }> = [];
  const seenUrls = new Set<string>();

  for (const item of response.output) {
    if (item.type === "message") {
      const messageItem = item as MessageOutput;
      for (const content of messageItem.content) {
        if (content.type === "output_text") {
          text += content.text;
          if (content.annotations) {
            for (const annotation of content.annotations) {
              if (annotation.type === "url_citation" && !seenUrls.has(annotation.url)) {
                seenUrls.add(annotation.url);
                sources.push({ url: annotation.url, title: annotation.title });
              }
            }
          }
        }
      }
    }
  }

  for (const url of response.citations ?? []) {
    if (!seenUrls.has(url)) {
      seenUrls.add(url);
      sources.push({ url });
    }
  }

  return { text, sources };
}

const NOT_PROSE = new Set(["link", "image", "code", "codespan", "escape", "html", "def"]);

function proseOf(tokens: readonly Token[], out: string[] = []): string[] {
  for (const token of tokens) {
    if (NOT_PROSE.has(token.type)) continue;
    const inner = "tokens" in token ? (token.tokens as readonly Token[] | undefined) : undefined;
    if (token.type === "text" && !inner) out.push(token.raw);
    if (inner) proseOf(inner, out);
    if (token.type === "list") {
      for (const item of (token as Tokens.List).items) proseOf(item.tokens, out);
    }
    if (token.type === "table") {
      const table = token as Tokens.Table;
      for (const cell of [...table.header, ...table.rows.flat()]) proseOf(cell.tokens, out);
    }
  }
  return out;
}

function numberedCitations(text: string): string[] {
  const number = String.raw`(?:post:\s*\d{1,4}|\d{1,3})`;
  const marker = new RegExp(String.raw`\[${number}(?:\s*[,–-]\s*${number})*\]`, "gi");
  return proseOf(Lexer.lex(text)).flatMap((prose) => prose.match(marker) ?? []);
}

function reasoningEffortForDepth(depth: XSearchDepth): ReasoningEffort {
  if (depth === "quick") return "low";
  if (depth === "max") return "high";
  if (depth === "ultra") return "xhigh";
  return "medium";
}

const HOSTNAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function normalizeWebDomains(
  value: unknown,
  field: "webAllowedDomains" | "webExcludedDomains",
): { readonly domains: string[] } | { readonly error: string } {
  if (value === undefined) return { domains: [] };
  if (!Array.isArray(value)) return { error: `${field} must be an array of up to 5 hostnames.` };
  if (value.length > 5) {
    return {
      error:
        "Each web domain filter accepts at most 5 hostnames. Split a larger scope into explicit searches; no domains were silently omitted.",
    };
  }
  const domains: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      return { error: `${field} entries must be hostname strings (e.g. "example.com").` };
    }
    const host = entry.trim().toLowerCase();
    const tld = host.split(".").at(-1) ?? "";
    if (!host || host.length > 253 || !HOSTNAME_RE.test(host) || /^\d+$/.test(tld)) {
      return {
        error: `Invalid hostname "${entry}" in ${field}: pass bare hostnames without scheme, path or port (e.g. "example.com").`,
      };
    }
    if (!seen.has(host)) {
      seen.add(host);
      domains.push(host);
    }
  }
  return { domains };
}

function supportsReasoningEffort(model: string): boolean {
  return model === "grok-4.3" || /^grok-4\.[5-9](?:-|$)/.test(model) || model.includes("reasoning");
}

function compactProgressDetail(value: unknown): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > MAX_PROGRESS_DETAIL ? `${clean.slice(0, MAX_PROGRESS_DETAIL - 1)}…` : clean;
}

function parseToolInput(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input !== "string" || !input.trim()) return null;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function searchRoundFromItem(
  item: unknown,
  seen: Set<string>,
  nextRound: number,
): ToolProgress | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const itemType = typeof record.type === "string" ? record.type : "";
  let label = "";
  let query = "";
  let url = "";
  let postId = "";

  if (itemType === "custom_tool_call") {
    const name = typeof record.name === "string" ? record.name : "";
    if (!name || (!name.startsWith("x_") && name !== "web_search" && name !== "browse_page")) {
      return null;
    }
    label = name;
    const parsed = parseToolInput(record.input);
    query = compactProgressDetail(parsed?.query);
    url = compactProgressDetail(parsed?.url);
    postId = compactProgressDetail(parsed?.post_id ?? parsed?.tweet_id);
  } else if (itemType === "web_search_call" || itemType === "x_search_call") {
    const action =
      record.action && typeof record.action === "object" && !Array.isArray(record.action)
        ? (record.action as Record<string, unknown>)
        : null;
    const actionType = typeof action?.type === "string" ? action.type : "";
    label =
      actionType === "open_page"
        ? "open_page"
        : itemType === "x_search_call"
          ? "x_search"
          : "web_search";
    query = compactProgressDetail(action?.query ?? record.query);
    url = compactProgressDetail(action?.url ?? record.url);
  } else {
    return null;
  }

  const key =
    (typeof record.call_id === "string" && record.call_id) ||
    (typeof record.id === "string" && record.id) ||
    `${label}\0${query}\0${url}\0${postId}`;
  if (seen.has(key)) return null;
  if (seen.size < MAX_TRACKED_PROGRESS_KEYS) seen.add(key);

  const message = query
    ? `Search round ${nextRound} (${label}): "${query}"`
    : postId
      ? `Search round ${nextRound} (${label}): post ${postId}`
      : url
        ? `Search round ${nextRound} (${label}): ${url}`
        : `Search round ${nextRound} (${label})`;
  return { progress: nextRound, message };
}

const responseId = (value: unknown): string | undefined =>
  value && typeof value === "object" && "id" in value && typeof value.id === "string" && value.id
    ? value.id
    : undefined;

function incompleteNote(data: ResponsesResponse): string {
  const reason =
    typeof data.incomplete_details?.reason === "string" ? ` (${data.incomplete_details.reason})` : "";
  return `\n\n**Incomplete response:** xAI marked this response incomplete${reason}. The readable text is retained, but it is not a complete research result.`;
}

function citationNote(text: string): string {
  const numbered = numberedCitations(text);
  if (!numbered.length) return "";
  const markers =
    numbered.length === 1
      ? "1 bracketed marker that looks like a citation by number"
      : `${numbered.length} bracketed markers that look like citations by number`;
  return `\n\n**Citations by number:** this write-up has ${markers} (such as ${numbered[0]}) but no link for them. Dig does not resolve which post each means, and the Sources list below is numbered by Dig, not by Grok, so do not read a number as that Sources entry. Find the post a claim rests on through X's search (\`x_search_posts\`) before relying on it.`;
}

function sourceList(sources: ReturnType<typeof extractContent>["sources"]): string {
  if (!sources.length) return "";
  return `\n---\n**Sources:**\n${sources.map((source, index) => `- [${index + 1}] ${source.url}${source.title ? ` - ${source.title}` : ""}\n`).join("")}`;
}

const isIncomplete = (data: ResponsesResponse): boolean =>
  data.status === "incomplete" ||
  data.output.some((item) => item.type === "message" && item.status === "incomplete");

function shouldRetryWithoutStorage(status: number, errorText: string): boolean {
  return status === 400 && errorText.includes("Response is too large to store");
}

function shouldRetryWithoutReasoning(
  status: number,
  errorText: string,
  sentReasoning: boolean,
): boolean {
  return sentReasoning && status === 400 && /reasoning|effort|xhigh/i.test(errorText);
}

export function reportedTicks(body: unknown): number | null {
  if (!body || typeof body !== "object" || !("usage" in body)) return null;
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || !("cost_in_usd_ticks" in usage)) return null;
  const ticks = (usage as { cost_in_usd_ticks?: unknown }).cost_in_usd_ticks;
  return typeof ticks === "number" && Number.isFinite(ticks) ? ticks : null;
}

export function reportedUsd(body: unknown): number | null {
  const ticks = reportedTicks(body);
  return ticks === null ? null : ticks / USD_TICKS_PER_DOLLAR;
}

function getReasoningTokens(usage: NonNullable<ResponsesResponse["usage"]>): number | undefined {
  return usage.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens;
}

function getServerSideToolUsage(response: ResponsesResponse): Record<string, number> | undefined {
  return response.server_side_tool_usage ?? response.usage?.server_side_tool_usage_details;
}

// ---------------------------------------------------------------------------
// Effect-native PaidHttp streaming & read-only recovery
// ---------------------------------------------------------------------------

function raceWithSignal<A, E>(
  eff: Effect.Effect<A, E>,
  signal: AbortSignal,
  makeAbortError: () => E,
): Effect.Effect<A, E> {
  if (signal.aborted) return Effect.fail(makeAbortError());
  const abortWait = Effect.callback<never, E>((resume) => {
    const onAbort = () => resume(Effect.fail(makeAbortError()));
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
  return Effect.raceFirst(eff, abortWait);
}

/**
 * Read a stored xAI response by its id (`GET /v1/responses/:id`, read-only, free, NEVER re-POSTs)
 * over `PaidHttp`. Emits optional progress messages while waiting between polls.
 */
function storedResponse(
  apiKey: string,
  id: string,
  signal: AbortSignal,
  waitsMs: readonly number[],
  onProgress?: (update: ToolProgress) => void,
  startProgress = 0,
): Effect.Effect<Stored, never, PaidHttp> {
  return Effect.gen(function* () {
    const client = yield* PaidHttp;
    let found: Stored = { state: "missing" };

    for (let idx = 0; idx < waitsMs.length; idx++) {
      const wait = waitsMs[idx];
      if (wait > 0) {
        onProgress?.({
          progress: startProgress + idx + 1,
          total: startProgress + waitsMs.length,
          message: `Stream interrupted; polling stored xAI response ${id} (${idx + 1}/${waitsMs.length})...`,
        });
        const slept = yield* Effect.result(abortableSleep(wait, signal));
        if (Result.isFailure(slept)) return { state: "cancelled" as const };
      } else if (signal.aborted) {
        return { state: "cancelled" as const };
      }

      const url = `${API_BASE}/responses/${encodeURIComponent(id)}`;
      const req = HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeaders({ Authorization: `Bearer ${apiKey}` }),
      );
      const makeAbort = () =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request: req, description: "Request aborted" }),
        });

      const res = yield* Effect.result(
        Effect.scoped(
          Effect.gen(function* () {
            const response = yield* raceWithSignal(
              client.execute(req).pipe(
                Effect.timeoutOrElse({
                  duration: Duration.millis(RECOVERY_GET_TIMEOUT_MS),
                  orElse: () =>
                    Effect.fail(
                      new HttpClientError.HttpClientError({
                        reason: new HttpClientError.TransportError({
                          request: req,
                          description: "Stored response read timed out",
                        }),
                      }),
                    ),
                }),
              ),
              signal,
              makeAbort,
            );
            const text = yield* raceWithSignal(response.text, signal, makeAbort);
            return { status: response.status, text };
          }),
        ),
      );

      if (Result.isFailure(res)) {
        if (signal.aborted) return { state: "cancelled" as const };
        found = {
          state: "error",
          status: res.failure instanceof Error ? res.failure.message : String(res.failure),
        };
        continue;
      }

      const { status, text } = res.success;
      if (status < 200 || status >= 300) {
        found = status === 404 ? { state: "missing" } : { state: "error", status };
        if (status === 401 || status === 403) return found;
        continue;
      }

      const record = redactProviderText(text, knownSecrets());
      const body =
        record.json && record.value && typeof record.value === "object"
          ? (record.value as Record<string, unknown>)
          : undefined;
      if (body && FINISHED.has(String(body.status))) {
        return { state: "finished" as const, body };
      }
      found = body ? { state: "running" } : { state: "error", status: "unreadable response" };
    }

    return found;
  });
}

type PostOutcome =
  | { readonly kind: "ok"; readonly body: unknown; readonly recovered?: true }
  | { readonly kind: "http_error"; readonly status: number; readonly errorText: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "error"; readonly message: string };

/**
 * Send one `POST /v1/responses` over `PaidHttp` (zero retries, manual redirects) and consume
 * either its SSE stream (emitting live `onProgress` round updates and attempting read-only recovery
 * on stream drop) or a direct JSON body.
 */
function postResponsesStream(options: {
  readonly apiKey: string;
  readonly requestBody: ResponsesRequest;
  readonly signal: AbortSignal;
  readonly keep: KeepRaw;
  readonly onProgress?: (update: ToolProgress) => void;
  readonly onRemoteJobId?: (id: string) => void;
  readonly allowRecovery: boolean;
}): Effect.Effect<PostOutcome, never, PaidHttp> {
  return Effect.gen(function* () {
    const client = yield* PaidHttp;
    const req = HttpClientRequest.post(`${API_BASE}/responses`).pipe(
      HttpClientRequest.setHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      }),
      HttpClientRequest.bodyJsonUnsafe(options.requestBody),
    );
    const makeAbort = () =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request: req, description: "Request aborted" }),
      });

    // State shared across SSE consumption so stream cut can recover by response id.
    let status = 0;
    let seen: unknown = "";
    let answer: object | undefined;
    let streamError: { message?: unknown } | undefined;
    let roundCount = 0;

    const readOneResponse = (
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<PostOutcome, never, PaidHttp> =>
      Effect.gen(function* () {
        status = response.status;
        if (status < 200 || status >= 300) {
          const textRes = yield* Effect.result(
            raceWithSignal(response.text, options.signal, makeAbort),
          );
          if (Result.isFailure(textRes)) {
            if (options.signal.aborted) return { kind: "cancelled" as const };
            options.keep(RAW_LABEL, status, "", undefined, true);
            return {
              kind: "error" as const,
              message: `xAI error body could not be read (HTTP ${status})`,
            };
          }
          const redacted = redactProviderText(textRes.success, knownSecrets());
          options.keep(RAW_LABEL, status, redacted.json ? redacted.value : redacted.text);
          return { kind: "http_error" as const, status, errorText: redacted.text };
        }

        const contentType = response.headers["content-type"] ?? "";
        if (!/^text\/event-stream\b/i.test(contentType)) {
          const textRes = yield* Effect.result(
            raceWithSignal(response.text, options.signal, makeAbort),
          );
          if (Result.isFailure(textRes)) {
            if (options.signal.aborted) return { kind: "cancelled" as const };
            options.keep(RAW_LABEL, status, "", undefined, true);
            return {
              kind: "error" as const,
              message: `xAI response body was interrupted. xAI accepted the request, so the pass may still have run and been charged; its cost is unknown.`,
            };
          }
          const redacted = redactProviderText(textRes.success, knownSecrets());
          if (!redacted.json) {
            options.keep(RAW_LABEL, status, redacted.text);
            return { kind: "error" as const, message: `The ${RAW_LABEL} response is not JSON` };
          }
          options.keep(RAW_LABEL, status, redacted.value);
          return { kind: "ok" as const, body: redacted.value };
        }

        // SSE stream reading
        const secrets = knownSecrets();
        const decoder = new TextDecoder();
        let buffer = "";
        let event = "";
        let data: string[] = [];
        const seenRounds = new Set<string>();

        const dispatch = () => {
          const text = data.join("\n");
          const named = event;
          event = "";
          data = [];
          if (!text || text === "[DONE]") return;
          const record = redactProviderText(text, secrets);
          if (!record.json || !record.value || typeof record.value !== "object") return;
          const value = record.value as {
            type?: unknown;
            response?: unknown;
            message?: unknown;
            item?: unknown;
          };
          const type = typeof value.type === "string" ? value.type : named;
          const snapshot =
            value.response && typeof value.response === "object" ? value.response : undefined;
          if (snapshot) {
            seen = snapshot;
            const snapId = (snapshot as { id?: unknown }).id;
            if (typeof snapId === "string" && snapId.trim()) {
              try {
                options.onRemoteJobId?.(snapId.trim());
              } catch {}
            }
          }
          if (type === "response.output_item.done" && options.onProgress) {
            const update = searchRoundFromItem(value.item, seenRounds, roundCount + 1);
            if (update) {
              roundCount = update.progress;
              try {
                options.onProgress(update);
              } catch {
                // Progress listeners must never abort provider consumption.
              }
            }
          }
          if (snapshot && TERMINAL_EVENTS.has(type)) answer = snapshot;
          else if (type === "error") seen = streamError = value;
        };

        const processLine = (text: string) => {
          if (!text) return dispatch();
          if (text.startsWith(":")) return;
          const colon = text.indexOf(":");
          const field = colon < 0 ? text : text.slice(0, colon);
          const value = colon < 0 ? "" : text.slice(colon + 1).replace(/^ /, "");
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        };

        const consumeChunk = (chunk: Uint8Array) => {
          if (answer || streamError) return;
          buffer += decoder.decode(chunk, { stream: true });
          for (
            let match: RegExpExecArray | null;
            !answer &&
            !streamError &&
            (match = /\r\n|\n|\r/.exec(buffer)) &&
            !(match[0] === "\r" && match.index === buffer.length - 1);
          ) {
            processLine(buffer.slice(0, match.index));
            buffer = buffer.slice(match.index + match[0].length);
          }
        };

        const streamRes = yield* Effect.result(
          raceWithSignal(
            Stream.runForEach(response.stream, (chunk) =>
              Effect.sync(() => consumeChunk(chunk)),
            ),
            options.signal,
            makeAbort,
          ),
        );

        if (Result.isSuccess(streamRes) && !answer && !streamError) {
          buffer += decoder.decode();
          if (buffer) {
            for (const part of buffer.split(/\r\n|\n|\r/)) {
              if (answer || streamError) break;
              processLine(part);
            }
          }
          dispatch();
        }

        const cutOutcome = (why: string, found?: Stored): PostOutcome => {
          options.keep(RAW_LABEL, status, seen, undefined, true);
          const id = responseId(seen);
          const later =
            !found || !id
              ? ""
              : found.state === "running"
                ? ` Its response id is ${id}, and xAI still shows the pass running. To read the answer once it finishes, without paying for a new pass, call xsearch with recoverResponseId set to that id.`
                : ` Its response id is ${id}; xAI held no finished response under it when Dig looked${found.state === "error" ? ` (the last read failed: ${found.status})` : ""}. To look again without paying for a new pass, call xsearch with recoverResponseId set to that id.`;
          return {
            kind: "error",
            message: `${why}. xAI accepted the request, so the pass may still have run and been charged; its cost is unknown.${later}`,
          };
        };

        const tryRecover = (why: string): Effect.Effect<PostOutcome, never, PaidHttp> =>
          Effect.gen(function* () {
            const id = responseId(seen);
            if (!options.allowRecovery || !id) return cutOutcome(why);
            const found = yield* storedResponse(
              options.apiKey,
              id,
              options.signal,
              RECOVERY.waitsMs,
              options.onProgress,
              roundCount,
            );
            if (found.state === "cancelled") return { kind: "cancelled" as const };
            if (found.state !== "finished") return cutOutcome(why, found);
            options.keep(RAW_LABEL, 200, found.body);
            return { kind: "ok" as const, body: found.body, recovered: true as const };
          });

        if (Result.isFailure(streamRes)) {
          if (options.signal.aborted) return { kind: "cancelled" as const };
          const failure = streamRes.failure;
          const causeCode =
            failure instanceof Error
              ? (failure.cause as { code?: unknown } | undefined)?.code
              : undefined;
          const why = [
            failure instanceof Error ? failure.message : String(failure),
            typeof causeCode === "string" ? causeCode : "",
          ]
            .filter(Boolean)
            .join(": ");
          return yield* tryRecover(`xAI's stream broke before its final event${why ? ` (${why})` : ""}`);
        }

        if (streamError) {
          return cutOutcome(
            `xAI's stream reported an error: ${typeof streamError.message === "string" && streamError.message ? streamError.message : "no message"}`,
          );
        }
        if (!answer) {
          return yield* tryRecover("xAI's stream ended before its final event");
        }
        options.keep(RAW_LABEL, status, answer);
        return { kind: "ok" as const, body: answer };
      });

    const execResult = yield* Effect.result(
      Effect.scoped(
        Effect.gen(function* () {
          const response = yield* raceWithSignal(client.execute(req), options.signal, makeAbort);
          return yield* readOneResponse(response);
        }),
      ),
    );

    if (Result.isFailure(execResult)) {
      if (options.signal.aborted) return { kind: "cancelled" as const };
      const err = execResult.failure;
      const msg = err instanceof Error ? err.message : String(err);
      options.keep(RAW_LABEL, "error", msg);
      const cause =
        err instanceof Error
          ? (err.cause as { code?: unknown; message?: unknown } | undefined)
          : undefined;
      const why =
        typeof cause?.code === "string"
          ? cause.code
          : typeof cause?.message === "string"
            ? cause.message
            : null;
      return {
        kind: "error" as const,
        message: redactText(
          `${msg}${why ? ` (${why})` : ""}. xAI may have received the request, so the pass may still have run and been charged; its cost is unknown.`,
          knownSecrets(),
        ),
      };
    }

    return execResult.success;
  });
}

function formatRecoveredResponse(
  data: ResponsesResponse,
  passLabel: string,
  mode: "recover" | "reconcile",
): ActionOutcome {
  if (data.error) {
    return failed(`xAI reports the pass with response id ${data.id} failed: ${data.error.message}`);
  }
  if (!Array.isArray(data.output)) {
    return failed(`xAI's stored response under id ${data.id} has no readable output`);
  }
  const { text, sources } = extractContent(data);
  const incomplete = isIncomplete(data);
  if (!text) {
    return failed(
      `xAI's stored response under id ${data.id} is ${data.status ?? "finished"} with no readable content`,
    );
  }
  const charged = reportedUsd(data);
  let result = `${passLabel}\n${text}${incomplete ? incompleteNote(data) : ""}${citationNote(text)}`;
  result +=
    "\n\n---\n**Recovered pass:** this is the stored answer of an earlier pass, read from xAI by its response id. No search was run by this call, and the query, dates, handles and depth are those of that pass, not of this call's other arguments.\n";
  if (mode === "reconcile") {
    result +=
      charged === null
        ? "- Billing: xAI's stored response reports no charge for the pass; do not estimate one.\n"
        : `- Billing: xAI reports the pass cost $${charged.toFixed(4)}.\n`;
  } else {
    result +=
      charged === null
        ? "- Billing: this read is free. xAI's stored response reports no charge for the pass; do not estimate one.\n"
        : `- Billing: this read is free. xAI reports the pass itself cost $${charged.toFixed(4)}; that charge belongs to the call that sent it, whose receipt records its cost as unknown.\n`;
  }
  result += sourceList(sources);
  result += `\n---\n**response_id:** ${data.id}\n`;
  if (data.usage) {
    result += `*Tokens: ${data.usage.total_tokens?.toLocaleString() ?? "not reported"}*`;
  }
  const details: Record<string, unknown> =
    mode === "reconcile"
      ? {
          responseId: data.id,
          reconciled: true,
          cost: charged !== null ? [{ amount: charged, unit: "USD" }] : null,
        }
      : { responseId: data.id, recovered: true };
  return outcome(incomplete ? "partial" : "success", result, details);
}

// ---------------------------------------------------------------------------
// Schema & Action Definition
// ---------------------------------------------------------------------------

export const XSearchSchema = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "What to search for on X.com.",
  }),
  passLabel: Schema.optionalKey(Schema.String).annotate({
    description: "Optional lowercase label prefix.",
  }),
  previousResponseId: Schema.optionalKey(Schema.String).annotate({
    description: "Previous response id for chaining.",
  }),
  recoverResponseId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))).annotate({
    description:
      "Read a stored pass by id without searching (free). Pass original query; other args ignored.",
  }),
  handles: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(20))).annotate({
    description: "At most 20 handles without @. Exclusive with excludeHandles.",
  }),
  excludeHandles: Schema.optionalKey(
    Schema.Array(Schema.String).check(Schema.isMaxLength(20)),
  ).annotate({
    description: "Exclude at most 20 handles without @. Exclusive with handles.",
  }),
  fromDate: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  ).annotate({
    description: "Inclusive start date, YYYY-MM-DD at 00:00 UTC.",
  }),
  toDate: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  ).annotate({
    description: "Exclusive end date, YYYY-MM-DD at 00:00 UTC (use next day to include a full day).",
  }),
  mode: Schema.optionalKey(Schema.Literals(["standard", "semantic"])).annotate({
    description:
      "standard (default): full X research. semantic: 2-4 x_semantic_search calls only (fast low-cost leads; defaults depth to quick).",
  }),
  depth: Schema.optionalKey(Schema.Literals(X_DEPTHS)).annotate({
    description: "Depth (omit for [x] depth setting; semantic mode defaults to quick).",
  }),
  enableWebSearch: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Add web search alongside X (omit for [x] web_search setting, default off).",
  }),
  webAllowedDomains: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMaxLength(5)),
  ).annotate({
    description: "Up to 5 web_search hostnames (needs web search; exclusive with webExcludedDomains).",
  }),
  webExcludedDomains: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMaxLength(5)),
  ).annotate({
    description: "Exclude up to 5 web_search hostnames (needs web search; exclusive with webAllowedDomains).",
  }),
  media: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Grok reads post images/video (default false).",
  }),
});

export const xsearchAction = defineAction({
  name: "xsearch",
  description:
    'Search X.com via Grok (xAI): semantic lead mode (mode: "semantic"), targeted video/image reads (media: true, default off), or discourse synthesis. ' +
    "Returns synthesized findings with citations to X posts, and can report per-post public " +
    "metrics (likes, reposts, quotes, replies, bookmarks, views) when asked for them. " +
    "Supports X search operators in the query, handle filtering, date ranges, multimedia " +
    "understanding, and multi-turn chaining via previousResponseId. Date bounds are " +
    "inclusive fromDate and exclusive toDate at 00:00 UTC. Each handle filter accepts at most 20 handles. " +
    "A pass is never sent twice: when its stream is cut, Dig looks for the finished answer under its response id (xAI keeps a finished pass, not one whose connection dropped while it ran), " +
    "and recoverResponseId reads a stored pass later, free, without running a search.",
  schema: XSearchSchema,
  slow: true,
  billing: meteredBilling<Schema.Schema.Type<typeof XSearchSchema>>(
    "USD",
    (body) => reportedUsd(body),
    (args) => typeof args?.recoverResponseId === "string" && args.recoverResponseId.trim().length > 0,
  ),
  reconcile: (remoteJobId, args, ctx) =>
    Effect.gen(function* () {
      const apiKey = process.env.XAI_API_KEY?.trim();
      const id = remoteJobId.trim();
      if (!apiKey || !id) return null;
      const found = yield* storedResponse(apiKey, id, ctx.signal, [0]);
      if (found.state !== "finished") return null;
      ctx.keep(RAW_LABEL, 200, found.body);
      const data = found.body as unknown as ResponsesResponse;
      return formatRecoveredResponse(data, args.passLabel?.trim() || "pass-1", "reconcile");
    }),
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const xConfig: XDefaultsConfig = ctx.xConfig
        ? {
            model: ctx.xConfig.model,
            depth: ctx.xConfig.depth,
            web_search: ctx.xConfig.webSearch,
            code_execution: ctx.xConfig.codeExecution,
          }
        : loadXDefaults();
      let attempts = 0;
      let ticks = 0;
      let unreported = 0;
      const keep: KeepRaw = (label, status, body, headers, interrupted) => {
        attempts += 1;
        const charged = interrupted ? null : reportedTicks(body);
        if (charged === null) unreported += 1;
        else ticks += charged;
        if (interrupted) ctx.keep(label, status, body, headers, true);
        else ctx.keep(label, status, body, headers);
      };
      const passUsd = (): number | null =>
        attempts && !unreported ? ticks / USD_TICKS_PER_DOLLAR : null;

      const apiKey = process.env.XAI_API_KEY?.trim();
      if (!apiKey) {
        return failed(`XAI_API_KEY is not set in Dig's keys.env. ${setOutsideChat()}`);
      }

      const recoverId = typeof args.recoverResponseId === "string" ? args.recoverResponseId.trim() : "";
      if (recoverId) {
        const found = yield* storedResponse(apiKey, recoverId, ctx.signal, [0]);
        if (found.state === "cancelled") return outcome("cancelled", "Research call cancelled");
        if (found.state === "running") {
          return outcome(
            "empty",
            `xAI still shows the pass with response id ${recoverId} running. Nothing was searched or charged by this read; call again with the same recoverResponseId once it has had time to finish.`,
          );
        }
        if (found.state === "missing") {
          return outcome(
            "empty",
            `xAI holds no response under id ${recoverId}. It stores a pass for 30 days, and only a pass sent with storage on; a pass whose connection dropped before xAI began it is not stored. Nothing was searched or charged by this read.`,
          );
        }
        if (found.state === "error") {
          return failed(
            `xAI could not be read for response id ${recoverId} (${found.status}). Nothing was searched or charged by this read.`,
          );
        }
        ctx.keep(RAW_LABEL, 200, found.body);
        const data = found.body as unknown as ResponsesResponse;
        return formatRecoveredResponse(data, args.passLabel?.trim() || "pass-1", "recover");
      }

      if (args.mode !== undefined && args.mode !== "standard" && args.mode !== "semantic") {
        return failed("mode must be 'standard' or 'semantic'");
      }
      const mode: XSearchMode = args.mode ?? "standard";
      if (mode === "semantic" && args.previousResponseId) {
        return failed(
          "mode 'semantic' cannot be chained with previousResponseId; start a fresh semantic pass.",
        );
      }
      if (args.handles?.length && args.excludeHandles?.length) {
        return failed("Cannot use both 'handles' and 'excludeHandles' - choose one");
      }
      if ((args.handles?.length ?? 0) > 20 || (args.excludeHandles?.length ?? 0) > 20) {
        return failed(
          "Each handle filter accepts at most 20 handles. Split a larger scope into explicit searches; no handles were silently omitted.",
        );
      }
      for (const [name, value] of [
        ["fromDate", args.fromDate],
        ["toDate", args.toDate],
      ] as const) {
        if (value !== undefined && !validDate(value)) {
          return failed(`${name} must be a valid YYYY-MM-DD date. Date-time values are not applied by X Search.`);
        }
      }
      if (args.fromDate && args.toDate && args.fromDate >= args.toDate) {
        return failed(
          "toDate must be after fromDate. toDate is exclusive at 00:00 UTC; to search one day, use the following date.",
        );
      }

      const xSearchTool: XSearchToolConfig = { type: "x_search" };
      if (args.handles?.length) {
        xSearchTool.allowed_x_handles = args.handles.map((h) => h.replace(/^@/, ""));
      }
      if (args.excludeHandles?.length) {
        xSearchTool.excluded_x_handles = args.excludeHandles.map((h) => h.replace(/^@/, ""));
      }
      if (args.fromDate) xSearchTool.from_date = args.fromDate;
      if (args.toDate) xSearchTool.to_date = args.toDate;
      const mediaEnabled = args.media === true;
      if (mediaEnabled) {
        xSearchTool.enable_image_understanding = true;
        xSearchTool.enable_video_understanding = true;
      }

      const tools: ToolConfig[] = [xSearchTool];

      const parsedAllowedDomains = normalizeWebDomains(args.webAllowedDomains, "webAllowedDomains");
      if ("error" in parsedAllowedDomains) return failed(parsedAllowedDomains.error);
      const parsedExcludedDomains = normalizeWebDomains(args.webExcludedDomains, "webExcludedDomains");
      if ("error" in parsedExcludedDomains) return failed(parsedExcludedDomains.error);
      const webAllowedDomains = parsedAllowedDomains.domains;
      const webExcludedDomains = parsedExcludedDomains.domains;
      if (webAllowedDomains.length && webExcludedDomains.length) {
        return failed("Cannot use both 'webAllowedDomains' and 'webExcludedDomains' - choose one");
      }

      const webSearchEnabled = args.enableWebSearch ?? xConfig.web_search;
      if ((webAllowedDomains.length || webExcludedDomains.length) && !webSearchEnabled) {
        return failed(
          "webAllowedDomains and webExcludedDomains require web search to be enabled (pass enableWebSearch: true or enable [x] web_search).",
        );
      }
      if (webSearchEnabled) {
        const webSearchTool: WebSearchToolConfig = { type: "web_search" };
        if (webAllowedDomains.length) {
          webSearchTool.filters = { allowed_domains: webAllowedDomains };
        } else if (webExcludedDomains.length) {
          webSearchTool.filters = { excluded_domains: webExcludedDomains };
        }
        tools.push(webSearchTool);
      }
      if (xConfig.code_execution) {
        tools.push({ type: "code_interpreter" });
      }

      let queryWithContext = args.query;
      if (args.fromDate || args.toDate) {
        queryWithContext = `${args.query} (Date range: ${dateRange(args.fromDate, args.toDate)})`;
      }

      const input: InputMessage[] = [];
      if (!args.previousResponseId) {
        input.push({
          role: "system",
          content: buildSystemMessage({
            fromDate: args.fromDate,
            toDate: args.toDate,
            webSearchEnabled,
            mode,
          }),
        });
      }
      input.push({ role: "user", content: queryWithContext });

      const depth: XSearchDepth = args.depth ?? (mode === "semantic" ? "quick" : xConfig.depth);
      const selectedModel = xConfig.model;
      const requestBody: ResponsesRequest = {
        model: selectedModel,
        input,
        tools,
        store: true,
        stream: true,
      };
      if (supportsReasoningEffort(selectedModel)) {
        requestBody.reasoning = { effort: reasoningEffortForDepth(depth) };
      }
      if (args.previousResponseId) {
        requestBody.previous_response_id = args.previousResponseId;
      }

      let postResult = yield* postResponsesStream({
        apiKey,
        requestBody,
        signal: ctx.signal,
        keep,
        onProgress: ctx.progress,
        onRemoteJobId: ctx.reportRemoteJobId,
        allowRecovery: requestBody.store !== false,
      });
      for (let retries = 0; postResult.kind === "http_error" && retries < 2; retries += 1) {
        if (shouldRetryWithoutStorage(postResult.status, postResult.errorText) && requestBody.store !== false) {
          if (requestBody.previous_response_id) {
            return failed(
              `${parseError(postResult.status, postResult.errorText)} (status ${postResult.status}). The chained request was not retried without its previous response context. To continue, start an explicit new pass with the full question and relevant prior evidence.`,
            );
          }
          requestBody.store = false;
        } else if (
          shouldRetryWithoutReasoning(
            postResult.status,
            postResult.errorText,
            requestBody.reasoning != null,
          )
        ) {
          requestBody.reasoning = undefined;
        } else {
          return failed(
            `${parseError(postResult.status, postResult.errorText)} (status ${postResult.status})`,
          );
        }
        postResult = yield* postResponsesStream({
          apiKey,
          requestBody,
          signal: ctx.signal,
          keep,
          onProgress: ctx.progress,
          allowRecovery: requestBody.store !== false,
        });
      }

      if (postResult.kind === "cancelled") return outcome("cancelled", "Research call cancelled");
      if (postResult.kind === "error") return failed(postResult.message);
      if (postResult.kind === "http_error") {
        return failed(
          `${parseError(postResult.status, postResult.errorText)} (status ${postResult.status})`,
        );
      }

      const data = postResult.body as ResponsesResponse;
      if (data.error) return failed(data.error.message);
      if (!Array.isArray(data.output)) return failed("No response content from xAI API");

      const { text, sources } = extractContent(data);
      const incomplete = isIncomplete(data);
      if (!text) {
        return failed(
          incomplete
            ? "xAI returned an incomplete response with no readable content"
            : "No response content from xAI API",
        );
      }

      const passLabel = args.passLabel?.trim() || "pass-1";
      let result = `${passLabel}\n${text}`;
      if (incomplete) result += incompleteNote(data);
      result += citationNote(text);
      if (postResult.recovered) {
        result +=
          "\n\n**Recovered:** xAI's stream was cut before its final event. The pass was not sent again: Dig read the finished answer back from xAI by its response id.";
      }

      const handleList = args.handles?.length
        ? args.handles.map((h) => h.replace(/^@/, "")).join(", ")
        : "none";
      const excludeList = args.excludeHandles?.length
        ? args.excludeHandles.map((h) => h.replace(/^@/, "")).join(", ")
        : "none";
      const activeTools = tools.map((t) => t.type).join(", ");

      result += "\n\n---\n**Search Parameters:**\n";
      result += `- Query: ${args.query}\n`;
      result += `- Model: ${selectedModel}\n`;
      result += `- Mode: ${mode}\n`;
      result += `- Depth: ${depth}${requestBody.reasoning ? ` (requested effort: ${requestBody.reasoning.effort})` : " (effort not sent; provider default applies)"}\n`;
      result +=
        "- Billing: every pass is paid, and a deeper pass costs more; the receipt records the charge xAI reported.\n";
      result += `- Tools: ${activeTools}\n`;
      result += `- Media understanding: ${mediaEnabled ? "enabled" : "off"}\n`;
      result += `- Store: ${requestBody.store === false ? "false" : "true"}\n`;
      result += `- Handles: ${handleList}\n`;
      result += `- Excluded Handles: ${excludeList}\n`;
      if (webAllowedDomains.length) {
        result += `- Web Allowed Domains: ${webAllowedDomains.join(", ")}\n`;
      }
      if (webExcludedDomains.length) {
        result += `- Web Excluded Domains: ${webExcludedDomains.join(", ")}\n`;
      }
      result += `- Date Range: ${dateRange(args.fromDate, args.toDate)}\n`;
      if (requestBody.previous_response_id) {
        result += `- Chained from: ${requestBody.previous_response_id}\n`;
      }

      result += sourceList(sources);

      result += "\n---\n";
      result += `**response_id:** ${data.id}\n`;
      const usdTotal = passUsd();
      const serverSideToolUsage = getServerSideToolUsage(data);
      if (data.usage) {
        const costStr =
          usdTotal != null
            ? ` | $${usdTotal.toFixed(4)}${attempts > 1 ? ` over ${attempts} attempts` : ""}`
            : "";
        const reasoningTokens = getReasoningTokens(data.usage);
        const reasoningStr =
          reasoningTokens != null ? ` | Reasoning: ${reasoningTokens.toLocaleString()}` : "";
        result += `*Tokens: ${data.usage.total_tokens?.toLocaleString() ?? "not reported"}${reasoningStr}${costStr}*`;
        if (
          data.usage.num_sources_used != null ||
          data.usage.num_server_side_tools_used != null
        ) {
          const sourceStr =
            data.usage.num_sources_used != null
              ? `Sources used: ${data.usage.num_sources_used.toLocaleString()}`
              : "";
          const toolStr =
            data.usage.num_server_side_tools_used != null
              ? `Server-side tools: ${data.usage.num_server_side_tools_used.toLocaleString()}`
              : "";
          result += `\n*${[sourceStr, toolStr].filter(Boolean).join(" | ")}*`;
        }
      }
      if (
        serverSideToolUsage &&
        (serverSideToolUsage.x_posts_fetched != null || serverSideToolUsage.x_users_fetched != null)
      ) {
        const postsStr =
          serverSideToolUsage.x_posts_fetched != null
            ? `Posts fetched: ${serverSideToolUsage.x_posts_fetched.toLocaleString()}`
            : "";
        const usersStr =
          serverSideToolUsage.x_users_fetched != null
            ? `Users fetched: ${serverSideToolUsage.x_users_fetched.toLocaleString()}`
            : "";
        result += `\n*${[postsStr, usersStr].filter(Boolean).join(" | ")}*`;
      }
      if (usdTotal == null) {
        result +=
          "\n*Provider cost unavailable; do not estimate it from the number of cited posts or tool calls.*";
      }
      const otherServerSideTools = serverSideToolUsage
        ? Object.entries(serverSideToolUsage).filter(
            ([tool]) => tool !== "x_posts_fetched" && tool !== "x_users_fetched",
          )
        : [];
      if (otherServerSideTools.length > 0) {
        result += "\n\n**Server-side tool usage:**\n";
        for (const [tool, toolCount] of otherServerSideTools) {
          result += `- ${tool}: ${toolCount}\n`;
        }
      }

      return outcome(incomplete ? "partial" : "success", result, {
        responseId: data.id,
        model: selectedModel,
        mode,
        depth,
      });
    }),
});
