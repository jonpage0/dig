import { Effect, Result } from "effect";
import { paidRequest, type KeepRaw, type PaidHttp } from "../../core/http.ts";
import { setOutsideChat } from "../../core/plugin.ts";
import { knownSecrets, redactText } from "../../core/secrets.ts";
import { USER_AGENT } from "../../version.ts";

export const DEFAULT_EXA_BASE = "https://api.exa.ai";
export const ALLOWED_EXA_HOSTS = new Set(["api.exa.ai", "api.eu.exa.ai"]);
export const MISSING_EXA_KEY = `EXA_API_KEY is not set in Dig's keys.env. Get a key at https://dashboard.exa.ai. ${setOutsideChat()}`;
export const UNANSWERED_EXA_COST =
  "Exa may have received and charged this request, but no complete response arrived; its cost is unknown.";

/** Documented Exa-Beta header value for Dynamic Highlights. */
export const DYNAMIC_HIGHLIGHTS_BETA = "dynamic-highlights-2026-08-28";

export const MAX_RESULTS = 100;
export const MAX_CONTENT_URLS = 100;
export const MAX_CHARACTERS = 10_000;
export const MIN_MAX_AGE_HOURS = -1;
export const MAX_MAX_AGE_HOURS = 720;
export const MAX_ADDITIONAL_QUERIES = 10;

export const DEFAULT_RESULTS = 10;
export const SEARCH_TEXT_CHARACTERS = 3_000;
export const SIMILAR_TEXT_CHARACTERS = 2_000;
export const CONTENTS_TEXT_CHARACTERS = 5_000;
export const TEXT_PREVIEW_CHARACTERS = 500;

export const SEARCH_TIMEOUT_MS = 60_000;
export const RESEARCH_TIMEOUT_MS = 180_000;

export const SEARCH_TYPES = [
  "instant",
  "fast",
  "lite",
  "auto",
  "deep-lite",
  "deep",
  "deep-reasoning",
] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const RESEARCH_MODES = ["auto", "deep-lite", "deep", "deep-reasoning"] as const;
export type ResearchMode = (typeof RESEARCH_MODES)[number];
export const DEFAULT_RESEARCH_MODE: ResearchMode = "deep";

export const HIGHLIGHT_VERBOSITIES = ["low", "medium", "high"] as const;
export type HighlightVerbosity = (typeof HIGHLIGHT_VERBOSITIES)[number];
export const DEFAULT_RESEARCH_VERBOSITY: HighlightVerbosity = "medium";

export type ExaPath = "/search" | "/contents" | "/findSimilar";

export interface ExaResult {
  readonly title?: string;
  readonly url: string;
  readonly id?: string;
  readonly publishedDate?: string;
  readonly author?: string;
  readonly text?: string;
  readonly highlights?: readonly string[];
  readonly summary?: string;
  readonly entities?: readonly Record<string, unknown>[];
  readonly image?: string;
}

export interface ExaCitation {
  readonly url: string;
  readonly title: string;
}

export interface ExaGrounding {
  readonly field: string;
  readonly citations: readonly ExaCitation[];
  readonly confidence: "low" | "medium" | "high";
}

export interface ExaSynthesisOutput {
  readonly content: string | Record<string, unknown>;
  readonly grounding: readonly ExaGrounding[];
}

export interface ExaContentStatus {
  readonly id: string;
  readonly status: "success" | "error";
  readonly source?: "cached" | "crawled";
  readonly error?: { readonly tag?: string; readonly httpStatusCode?: number };
}

export interface ExaResponse {
  readonly requestId?: string;
  readonly results: readonly ExaResult[];
  readonly costDollars?: number;
  readonly searchTime?: number;
  readonly output?: ExaSynthesisOutput;
  readonly statuses: readonly ExaContentStatus[];
}

export type Invalid = { readonly error: string };

export function isInvalid(value: unknown): value is Invalid {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { readonly error?: unknown }).error === "string" &&
    Object.keys(value).length === 1
  );
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : undefined;
}

/** Exa's own charge on one response body (`costDollars.total`, USD); undefined when omitted or negative. */
export function reportedDollars(body: unknown): number | undefined {
  const total = optionalNumber(asRecord(asRecord(body)?.costDollars)?.total);
  return total !== undefined && total >= 0 ? total : undefined;
}

export function apiKey(): string | null {
  return process.env.EXA_API_KEY?.trim() || null;
}

/** Read per request so an EXA_BASE_URL reloaded from keys.env after startup applies. */
export function exaBaseUrl(): string | Invalid {
  const raw = process.env.EXA_BASE_URL?.trim();
  if (!raw) return DEFAULT_EXA_BASE;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: "EXA_BASE_URL must be https://api.exa.ai or https://api.eu.exa.ai." };
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  if (
    parsed.protocol !== "https:" ||
    !ALLOWED_EXA_HOSTS.has(parsed.hostname.toLowerCase()) ||
    parsed.port ||
    cleanPath !== "" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return {
      error:
        "EXA_BASE_URL must be https://api.exa.ai or https://api.eu.exa.ai (plain https:// origin with no port, path, credentials, query, or fragment).",
    };
  }
  return `https://${parsed.hostname.toLowerCase()}`;
}

function parseResult(path: ExaPath, value: unknown, index: number): ExaResult | Invalid {
  const record = asRecord(value);
  const url = optionalString(record?.url);
  if (!record || !url) return { error: `Exa ${path} returned an unexpected payload: results[${index}] has no url` };
  const highlights = record.highlights === undefined ? undefined : stringList(record.highlights);
  if (record.highlights !== undefined && !highlights) {
    return { error: `Exa ${path} returned an unexpected payload: results[${index}].highlights is not a string array` };
  }
  return {
    url,
    title: optionalString(record.title),
    id: optionalString(record.id),
    publishedDate: optionalString(record.publishedDate),
    author: optionalString(record.author),
    text: optionalString(record.text),
    highlights,
    summary: optionalString(record.summary),
    image: optionalString(record.image),
    entities: Array.isArray(record.entities)
      ? record.entities.filter((entry): entry is Record<string, unknown> => asRecord(entry) !== null)
      : undefined,
  };
}

function parseCitation(path: ExaPath, value: unknown, where: string): ExaCitation | Invalid {
  const record = asRecord(value);
  const url = optionalString(record?.url);
  if (!record || !url) {
    return { error: `Exa ${path} returned an unexpected payload: ${where} citation has no url` };
  }
  return { url, title: optionalString(record.title) ?? "" };
}

function parseGrounding(path: ExaPath, value: unknown, index: number): ExaGrounding | Invalid {
  const record = asRecord(value);
  const field = optionalString(record?.field);
  const confidence = optionalString(record?.confidence);
  if (!record || !field || !Array.isArray(record.citations)) {
    return {
      error: `Exa ${path} returned an unexpected payload: output.grounding[${index}] lacks field or citations`,
    };
  }
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
    return {
      error: `Exa ${path} returned an unexpected payload: output.grounding[${index}].confidence is not low|medium|high`,
    };
  }
  const citations: ExaCitation[] = [];
  for (const rawCite of record.citations) {
    const parsed = parseCitation(path, rawCite, `output.grounding[${index}]`);
    if (isInvalid(parsed)) return parsed;
    citations.push(parsed);
  }
  return { field, confidence, citations };
}

function parseOutput(path: ExaPath, value: unknown): ExaSynthesisOutput | undefined | Invalid {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  const content = typeof record?.content === "string" ? record.content : asRecord(record?.content);
  if (!record || content === null || !Array.isArray(record.grounding)) {
    return { error: `Exa ${path} returned an unexpected payload: output lacks content or grounding` };
  }
  const grounding: ExaGrounding[] = [];
  for (let i = 0; i < record.grounding.length; i++) {
    const parsed = parseGrounding(path, record.grounding[i], i);
    if (isInvalid(parsed)) return parsed;
    grounding.push(parsed);
  }
  return { content, grounding };
}

function parseStatus(path: ExaPath, value: unknown, index: number): ExaContentStatus | Invalid {
  const record = asRecord(value);
  const id = optionalString(record?.id);
  const status = optionalString(record?.status);
  if (!record || !id || (status !== "success" && status !== "error")) {
    return {
      error: `Exa ${path} returned an unexpected payload: statuses[${index}] lacks id or a success|error status`,
    };
  }
  const source = optionalString(record.source);
  const error = asRecord(record.error);
  return {
    id,
    status,
    source: source === "cached" || source === "crawled" ? source : undefined,
    error: error
      ? { tag: optionalString(error.tag), httpStatusCode: optionalNumber(error.httpStatusCode) }
      : undefined,
  };
}

function parseResponse(path: ExaPath, payload: Record<string, unknown>): ExaResponse | Invalid {
  if (!Array.isArray(payload.results)) {
    return { error: `Exa ${path} returned an unexpected payload: no results array` };
  }
  if (path === "/contents" && !Array.isArray(payload.statuses)) {
    return { error: `Exa ${path} returned an unexpected payload: no statuses array` };
  }
  const results: ExaResult[] = [];
  for (let i = 0; i < payload.results.length; i++) {
    const parsed = parseResult(path, payload.results[i], i);
    if (isInvalid(parsed)) return parsed;
    results.push(parsed);
  }
  const output = parseOutput(path, payload.output);
  if (isInvalid(output)) return output;
  const rawStatuses = Array.isArray(payload.statuses) ? payload.statuses : [];
  const statuses: ExaContentStatus[] = [];
  for (let i = 0; i < rawStatuses.length; i++) {
    const parsed = parseStatus(path, rawStatuses[i], i);
    if (isInvalid(parsed)) return parsed;
    statuses.push(parsed);
  }
  return {
    requestId: optionalString(payload.requestId),
    results,
    costDollars: reportedDollars(payload),
    searchTime: optionalNumber(payload.searchTime),
    output,
    statuses,
  };
}

export type ExaPostResult =
  | { readonly ok: true; readonly response: ExaResponse }
  | { readonly ok: false; readonly cancelled: boolean; readonly error: string };

/**
 * Execute one paid Exa POST through `PaidHttp` (compile-time zero retries, manual redirects).
 */
export function exaPost(
  path: ExaPath,
  body: Record<string, unknown>,
  options: {
    readonly operation: string;
    readonly baseUrl: string;
    readonly key: string;
    readonly signal: AbortSignal;
    readonly keep: KeepRaw;
    readonly timeoutMs: number;
    readonly beta?: string;
  },
): Effect.Effect<ExaPostResult, never, PaidHttp> {
  return Effect.gen(function* () {
    if (options.signal.aborted) {
      return {
        ok: false as const,
        cancelled: true,
        error: `Exa ${options.operation} canceled before completion; not a provider failure.`,
      };
    }

    const headers: Record<string, string> = {
      "x-api-key": options.key,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (options.beta) headers["Exa-Beta"] = options.beta;

    const res = yield* Effect.result(
      paidRequest({
        url: `${options.baseUrl}${path}`,
        method: "POST",
        headers,
        body,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        label: path,
        keep: options.keep,
      }),
    );

    if (Result.isFailure(res)) {
      if (options.signal.aborted) {
        return {
          ok: false as const,
          cancelled: true,
          error: `Exa ${options.operation} canceled before completion; not a provider failure.`,
        };
      }
      const message = res.failure instanceof Error ? res.failure.message : String(res.failure);
      return {
        ok: false as const,
        cancelled: false,
        error: `Exa ${options.operation} failed: ${redactText(message, knownSecrets())}. ${UNANSWERED_EXA_COST}`,
      };
    }

    const { status, payload: rawPayload, requestId: headerRequestId } = res.success;
    const payload = asRecord(rawPayload);
    const envelopeError = optionalString(payload?.error);
    if (status < 200 || status >= 300 || envelopeError !== undefined) {
      const message = envelopeError ?? `HTTP ${status}`;
      const tag = optionalString(payload?.tag);
      const requestId = optionalString(payload?.requestId) ?? headerRequestId;
      const detail = `Exa ${path} returned HTTP ${status}${tag ? ` (${tag})` : ""}: ${message}${requestId ? ` [request ${requestId}]` : ""}`;
      return {
        ok: false as const,
        cancelled: false,
        error: `Exa ${options.operation} failed: ${redactText(detail, knownSecrets())}`,
      };
    }

    if (!payload) {
      return {
        ok: false as const,
        cancelled: false,
        error: `Exa ${options.operation} failed: Exa ${path} returned an unexpected payload: non-object JSON body`,
      };
    }

    const parsed = parseResponse(path, payload);
    if (isInvalid(parsed)) {
      return {
        ok: false as const,
        cancelled: false,
        error: `Exa ${options.operation} failed: ${redactText(parsed.error, knownSecrets())}`,
      };
    }
    return { ok: true as const, response: parsed };
  });
}

// ---------------------------------------------------------------------------
// Argument helpers & validation
// ---------------------------------------------------------------------------

export function requireText(value: unknown, name: string): string | Invalid {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : { error: `${name} is required.` };
}

export function optionalText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

export function optionalStringArray(value: unknown, name: string): readonly string[] | undefined | Invalid {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return { error: `${name} must be an array of strings.` };
  }
  return value as readonly string[];
}

export function resultCount(value: unknown): { readonly numResults: number; readonly note?: string } {
  if (typeof value !== "number" || !Number.isFinite(value)) return { numResults: DEFAULT_RESULTS };
  const requested = Math.trunc(value);
  if (requested > MAX_RESULTS) {
    return {
      numResults: MAX_RESULTS,
      note: `numResults ${requested} exceeds Exa's public limit; capped at ${MAX_RESULTS}.`,
    };
  }
  return { numResults: Math.max(1, requested) };
}

export function maxAgeHours(value: unknown): number | undefined | Invalid {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_MAX_AGE_HOURS ||
    value > MAX_MAX_AGE_HOURS
  ) {
    return { error: `maxAgeHours must be an integer from ${MIN_MAX_AGE_HOURS} to ${MAX_MAX_AGE_HOURS}.` };
  }
  return value;
}

export function characterBudget(value: unknown, name: string): number | undefined | Invalid {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_CHARACTERS) {
    return { error: `${name} must be an integer from 1 to ${MAX_CHARACTERS}.` };
  }
  return value;
}

export function userLocation(value: unknown): string | undefined | Invalid {
  if (value === undefined || value === null) return undefined;
  const code = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z]{2}$/.test(code)) {
    return { error: "userLocation must be a 2-letter ISO-3166-1 alpha-2 country code (e.g. US)." };
  }
  return code.toUpperCase();
}

export function parseHighlightVerbosity(value: unknown): HighlightVerbosity | undefined | Invalid {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !(HIGHLIGHT_VERBOSITIES as readonly string[]).includes(value)) {
    return { error: `highlightVerbosity must be one of ${HIGHLIGHT_VERBOSITIES.join(", ")}.` };
  }
  return value as HighlightVerbosity;
}

export function snapshotTime(value: unknown): string | undefined | Invalid {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return { error: "snapshotAsOf must be an ISO date or date-time with timezone." };
  }
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    return { error: "snapshotAsOf must name a valid calendar date." };
  }
  if (Date.parse(value) > Date.now()) return { error: "snapshotAsOf must not be in the future." };
  return value;
}

export interface HighlightArgs {
  readonly query?: string;
  readonly highlightMaxCharacters?: number;
  readonly dynamicHighlights?: boolean;
  readonly highlightVerbosity?: HighlightVerbosity;
}

export interface HighlightPlan {
  readonly highlights: true | Record<string, unknown>;
  readonly dynamic: boolean;
  readonly beta?: string;
}

/**
 * Current highlights contract: `true` for Exa's default budget, or an object with
 * `query`, `maxCharacters`, or `dynamic` (+ optional `verbosity`). Setting
 * `highlightVerbosity` enables Dynamic Highlights and requires `Exa-Beta`.
 */
export function highlightPlan(args: HighlightArgs): HighlightPlan | Invalid {
  const verbosity = parseHighlightVerbosity(args.highlightVerbosity);
  if (isInvalid(verbosity)) return verbosity;
  if (args.dynamicHighlights === false && verbosity !== undefined) {
    return { error: "highlightVerbosity requires dynamicHighlights (omit dynamicHighlights: false)." };
  }
  const dynamic = args.dynamicHighlights === true || verbosity !== undefined;
  const maxCharacters = characterBudget(args.highlightMaxCharacters, "highlightMaxCharacters");
  if (isInvalid(maxCharacters)) return maxCharacters;
  if (dynamic && maxCharacters !== undefined) {
    return {
      error: "highlightMaxCharacters cannot be combined with dynamicHighlights (Exa allocates one shared budget).",
    };
  }
  const query = optionalText(args.query);

  const options: Record<string, unknown> = {};
  if (query) options.query = query;
  if (dynamic) options.dynamic = true;
  if (verbosity !== undefined) options.verbosity = verbosity;
  if (maxCharacters !== undefined) options.maxCharacters = maxCharacters;

  return {
    highlights: Object.keys(options).length > 0 ? options : true,
    dynamic,
    ...(dynamic ? { beta: DYNAMIC_HIGHLIGHTS_BETA } : {}),
  };
}

export interface ContentsArgs extends HighlightArgs {
  readonly contents?: boolean;
  readonly snapshotAsOf?: string;
  readonly summary?: boolean;
  readonly maxAgeHours?: number;
}

export interface ContentsPlan {
  readonly contents?: Record<string, unknown>;
  readonly dynamic: boolean;
  readonly beta?: string;
}

export function contentsPlan(
  args: ContentsArgs,
  textCharacters: number,
  summaryQuery?: string,
): ContentsPlan | Invalid {
  if (args.snapshotAsOf !== undefined && args.contents === false) {
    return { error: "snapshotAsOf requires contents." };
  }
  if (args.contents === false) return { dynamic: false };
  const highlights = highlightPlan(args);
  if (isInvalid(highlights)) return highlights;
  const age = maxAgeHours(args.maxAgeHours);
  if (isInvalid(age)) return age;

  const contents: Record<string, unknown> = {
    ...(highlights.dynamic ? {} : { text: { maxCharacters: textCharacters } }),
    highlights: highlights.highlights,
  };
  if (args.summary === true) contents.summary = summaryQuery ? { query: summaryQuery } : {};
  if (age !== undefined) contents.maxAgeHours = age;
  const snapshot = snapshotTime(args.snapshotAsOf);
  if (isInvalid(snapshot)) return snapshot;
  if (snapshot !== undefined) {
    if (args.maxAgeHours !== undefined) {
      return { error: "snapshotAsOf cannot be combined with maxAgeHours." };
    }
    contents.snapshotAsOf = snapshot;
  }
  return { contents, dynamic: highlights.dynamic, ...(highlights.beta ? { beta: highlights.beta } : {}) };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function costLine(response: ExaResponse): string {
  const parts: string[] = [];
  if (response.costDollars !== undefined) parts.push(`cost $${response.costDollars.toFixed(4)}`);
  if (typeof response.searchTime === "number") parts.push(`search ${Math.round(response.searchTime)} ms`);
  if (response.requestId) parts.push(`request ${response.requestId}`);
  return parts.join("; ");
}

export function resultDetails(
  response: ExaResponse,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    provider: "exa",
    ...(response.requestId !== undefined ? { requestId: response.requestId } : {}),
    ...(response.costDollars !== undefined ? { costDollars: response.costDollars } : {}),
    results: response.results.length,
    ...extra,
  };
}

function formatResult(r: ExaResult, lines: string[]): void {
  const indent = "  ";
  lines.push(`**${r.title || "(no title)"}**`);
  lines.push(
    `${indent}URL: ${r.url}` +
      (r.publishedDate ? ` | Published: ${r.publishedDate.split("T")[0]}` : "") +
      (r.author ? ` | Author: ${r.author}` : ""),
  );
  if (r.summary) lines.push(`${indent}Summary: ${r.summary}`);
  if (r.entities?.length) lines.push(`${indent}Structured entities: ${JSON.stringify(r.entities)}`);
  if (r.highlights && r.highlights.length > 0) {
    lines.push(`${indent}Highlights:`);
    for (const h of r.highlights) lines.push(`${indent}  > ${h}`);
  }
  if (r.text) {
    const preview = r.text.slice(0, TEXT_PREVIEW_CHARACTERS).replace(/\n+/g, " ");
    lines.push(
      `${indent}Text preview (first ${Math.min(r.text.length, TEXT_PREVIEW_CHARACTERS)} of ${r.text.length} returned characters): ${preview}${r.text.length > TEXT_PREVIEW_CHARACTERS ? "..." : ""}`,
    );
  }
  lines.push("");
}

export function formatResults(
  header: string,
  notes: readonly string[],
  response: ExaResponse,
): string {
  const lines: string[] = [header];
  const cost = costLine(response);
  if (cost) lines.push(`(${cost})`);
  for (const note of notes) lines.push(`Note: ${note}`);
  lines.push("");
  for (const r of response.results) formatResult(r, lines);
  return lines.join("\n");
}

export function formatSynthesis(content: ExaSynthesisOutput["content"]): string[] {
  if (typeof content === "string") return [content];
  return ["```json", JSON.stringify(content, null, 2), "```"];
}
