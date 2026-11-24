/**
 * Shared X API v2 & TikHub X HTTP client, billing counters (`xReads`),
 * response formatters, pagination helpers, and archive pacing gate.
 *
 * All paid X API and TikHub requests execute over `PaidHttp` (zero retries, manual redirects,
 * hop-safe SSRF guard, automatic credential redaction).
 */
import { Effect, Result } from "effect";
import type * as Headers from "effect/http/Headers";
import type { ReceiptCost } from "../../core/cost.ts";
import { paidRequest, type PaidHttp, type RetainedResponse } from "../../core/http.ts";
import {
  outcome,
  setOutsideChat,
  type ActionContext,
  type ActionOutcome,
  type BillingPolicy,
  type OutcomeStatus,
} from "../../core/plugin.ts";
import { knownSecrets, redactValue } from "../../core/secrets.ts";
import { USER_AGENT } from "../../version.ts";
import { tikhubBaseUrl } from "../shared/tikhub.ts";
import { oauthHeader, signedQuery, USER_KEY_NAMES, type UserKeys } from "./oauth.ts";

export type Json = Record<string, unknown>;
export type CallContext = Pick<ActionContext, "signal" | "keep"> & { readonly halt?: Halt };

export const API_BASE = "https://api.x.com";
export const X_API_DOCS_URL = "https://docs.x.com/x-api/introduction";
export const KEY = "X_BEARER_TOKEN";
export const TIMEOUT_MS = 60_000;
export const OUTPUT_LIMIT = 60_000;
export const MAX_ERROR_CHARS = 300;
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const ARCHIVE_PACING = { intervalMs: 1_100 };
export const ARCHIVE_START = "2006-03-21T00:00:00Z";
export const SNOWFLAKE_FIRST_DAY_MS = 24 * 60 * 60 * 1000;
export const SEARCH_PAGE = { min: 10, max: 100 } as const;
export const ARCHIVE_SEARCH_PAGE = { min: 10, max: 500 } as const;
export const MAX_SEARCH_PAGES = 50;
export const MAX_COUNT_PAGES = 10;
export const TIMELINE_MIN = 5;
export const QUOTES_MIN = 10;
export const COMMUNITIES_MIN = 10;
export const THREAD_PAGE = 100;
export const TRENDS_MAX = 50;
export const SEARCH_LIMIT_MAX = 500;
export const SEARCH_LIMIT = 25;
export const EXPLORE_LIMIT = 25;
export const TRENDS_LIMIT = 20;
export const PEOPLE_SEARCH_RESULTS = 25;
export const WORLDWIDE_WOEID = 1;
export const TIKHUB_PAGES = 30;
export const TIKHUB_LABEL = "fetch_tweet_detail via TikHub";

export const POST_FIELDS = [
  "article",
  "article_title",
  "attachments",
  "card_uri",
  "community_id",
  "conversation_id",
  "created_at",
  "entities",
  "geo",
  "id",
  "lang",
  "note_post",
  "possibly_sensitive",
  "public_metrics",
  "reply_settings",
  "text",
  "withheld",
] as const;

export const POST_EXPANSIONS = [
  "article.cover_media",
  "article.media_entities",
  "attachments.media_keys",
  "attachments.media_source_tweet",
  "attachments.poll_ids",
  "author_id",
  "geo.place_id",
  "referenced_posts",
] as const;

export const USER_FIELDS = [
  "created_at",
  "description",
  "entities",
  "id",
  "is_identity_verified",
  "location",
  "name",
  "profile_banner_url",
  "profile_image_url",
  "protected",
  "public_metrics",
  "url",
  "username",
  "verified",
  "verified_type",
  "withheld",
] as const;

export const USER_EXPANSIONS = ["affiliation", "most_recent_post_id", "pinned_post_id"] as const;
export const MEDIA_FIELDS = [
  "alt_text",
  "duration_ms",
  "height",
  "media_key",
  "preview_image_url",
  "public_metrics",
  "type",
  "url",
  "variants",
  "width",
] as const;
export const POLL_FIELDS = ["duration_minutes", "end_datetime", "id", "options", "voting_status"] as const;
export const PLACE_FIELDS = [
  "contained_within",
  "country",
  "country_code",
  "full_name",
  "geo",
  "id",
  "name",
  "place_type",
] as const;
export const SPACE_FIELDS = [
  "created_at",
  "ended_at",
  "id",
  "is_ticketed",
  "lang",
  "participant_count",
  "scheduled_start",
  "started_at",
  "state",
  "subscriber_count",
  "title",
  "updated_at",
] as const;
export const SPACE_EXPANSIONS = [
  "creator_id",
  "host_ids",
  "invited_user_ids",
  "speaker_ids",
  "topic_ids",
] as const;
export const TOPIC_FIELDS = ["description", "id", "name"] as const;
export const COMMUNITY_FIELDS = [
  "access",
  "created_at",
  "description",
  "id",
  "join_policy",
  "member_count",
  "name",
] as const;
export const NEWS_FIELDS = [
  "category",
  "cluster_posts_results",
  "contexts",
  "disclaimer",
  "hook",
  "id",
  "keywords",
  "name",
  "summary",
  "updated_at",
] as const;
export const TREND_FIELDS = ["trend_name", "tweet_count"] as const;

export const POST_PARAMS: Params = {
  "post.fields": POST_FIELDS.join(","),
  expansions: POST_EXPANSIONS.join(","),
  "user.fields": USER_FIELDS.join(","),
  "media.fields": MEDIA_FIELDS.join(","),
  "poll.fields": POLL_FIELDS.join(","),
  "place.fields": PLACE_FIELDS.join(","),
};

export const USER_PARAMS: Params = {
  "user.fields": USER_FIELDS.join(","),
  expansions: USER_EXPANSIONS.join(","),
  "post.fields": POST_FIELDS.join(","),
};

export const TRUNCATION_NOTE =
  "The complete response is this call's original response when raw retention is on; read it with library_read using the receipt's raw file.";
export const ZERO_NOTE = "List lines leave out counts of zero.";

// ---------------------------------------------------------------------------
// Untrusted JSON accessors & utilities
// ---------------------------------------------------------------------------

export const rec = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

export const recs = (value: unknown): Json[] =>
  Array.isArray(value)
    ? value.flatMap((item): Json[] => {
        const record = rec(item);
        return record ? [record] : [];
      })
    : [];

export const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

export const num = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
};

export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const count = (value: number, one: string, many: string): string =>
  `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const bearerToken = (): string | null => process.env[KEY]?.trim() || null;

export const tikhubKey = (): string | null => process.env.TIKHUB_API_KEY?.trim() || null;

export const missingKey = (): string =>
  `${KEY} is not set in Dig's keys.env. The user creates an app at console.x.com and copies its Bearer Token. ${setOutsideChat()}`;

export function userKeys(): UserKeys | { readonly missing: string[] } {
  const [consumerKey, consumerSecret, accessToken, accessTokenSecret] = USER_KEY_NAMES.map(
    (name) => process.env[name]?.trim() ?? "",
  );
  const missing = USER_KEY_NAMES.filter((name) => !process.env[name]?.trim());
  return missing.length ? { missing } : { consumerKey, consumerSecret, accessToken, accessTokenSecret };
}

const andList = (items: readonly string[]): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

export const missingUserKeys = (what: string, missing: readonly string[]): string =>
  `${what} needs X sign-in, and ${andList(missing)} ${missing.length === 1 ? "is" : "are"} not set in Dig's keys.env. Sign-in takes four keys from the X app's Keys and tokens page at console.x.com: its Consumer Key and Secret (X_CONSUMER_KEY, X_CONSUMER_SECRET) and an Access Token and Secret for the user's own account (X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET). ${setOutsideChat(true)} Signed-in reads act as that account.`;

export const SNOWFLAKE_EPOCH = 1288834974657n;

export function snowflakeTime(id: string): number | null {
  try {
    return Number((BigInt(id) >> 22n) + SNOWFLAKE_EPOCH);
  } catch {
    return null;
  }
}

export const utc = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`;

export function stamp(createdAt: unknown, id: string | null): string | null {
  const at = str(createdAt);
  if (at && !Number.isNaN(Date.parse(at))) return utc(new Date(at).toISOString());
  const ms = id ? snowflakeTime(id) : null;
  return ms === null ? null : utc(new Date(ms).toISOString());
}

export function bounded(text: string): string {
  return text.length > OUTPUT_LIMIT
    ? `${text.slice(0, OUTPUT_LIMIT)}\n[Truncated at ${OUTPUT_LIMIT} of ${text.length} characters. ${TRUNCATION_NOTE}]`
    : text;
}

export const withGap = (lines: readonly string[]): string[] => (lines.length ? ["", ...lines] : []);
export const quoteBlock = (lines: readonly string[]): string[] => lines.map((line) => `> ${line}`);
export const isoSecond = (ms: number): string =>
  `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;

export function conversationStart(root: string): string {
  const ms = snowflakeTime(root);
  if (ms === null || ms < Number(SNOWFLAKE_EPOCH) + SNOWFLAKE_FIRST_DAY_MS) return ARCHIVE_START;
  return isoSecond(ms);
}

export function timeWindow(start: string | null, end: string | null): string | null {
  return start || end ? `${start ? `from ${start}` : ""}${start && end ? " " : ""}${end ? `to ${end}` : ""}` : null;
}

export const startTime = (args: { readonly start_time?: unknown }, archive: boolean): string | null =>
  str(args.start_time) ?? (archive ? ARCHIVE_START : null);

/** Abortable sleep as an Effect (used for archive pacing & xsearch recovery polling). */
export function abortableSleep(ms: number, signal: AbortSignal): Effect.Effect<void, Error> {
  if (signal.aborted) return Effect.fail(new Error("Request aborted"));
  if (ms <= 0) return Effect.void;
  return Effect.callback<void, Error>((resume) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resume(Effect.void);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resume(Effect.fail(new Error("Request aborted")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}

// ---------------------------------------------------------------------------
// Requests & error classification
// ---------------------------------------------------------------------------

export type FailureKind = "auth" | "payment" | "rate" | "server" | "network" | "redirect" | "request";
export const FALLBACK_KINDS: ReadonlySet<FailureKind> = new Set([
  "auth",
  "payment",
  "rate",
  "server",
  "network",
]);
export const HALT_KINDS: ReadonlySet<FailureKind> = new Set(["auth", "payment", "rate"]);

export interface Halt {
  by: Failure | null;
  skipped: number;
}

export interface Failure {
  readonly ok: false;
  readonly cancelled?: boolean;
  readonly kind: FailureKind;
  readonly status: number | null;
  readonly message: string;
  readonly problem: string | null;
  readonly resource: Json[];
}

export interface Answer {
  readonly ok: true;
  readonly status: number;
  readonly body: Json;
  readonly problem: string | null;
  readonly resources: Json[];
}

export type Params = Record<string, string | number | undefined>;
export type Auth = string | UserKeys;

const credentialOf = (auth: Auth): string =>
  typeof auth === "string" ? KEY : `the X sign-in keys (${USER_KEY_NAMES.join(", ")})`;

export function problemText(body: Json | null): string | null {
  if (!body) return null;
  const problem = [...new Set([str(body.title), str(body.detail)].filter(Boolean))].join(": ");
  const legacy = recs(body.errors)
    .map((error) => str(error.message) ?? [str(error.title), str(error.detail)].filter(Boolean).join(": "))
    .filter(Boolean)
    .join("; ");
  const text = problem || legacy || str(body.reason) || str(body.error);
  return text ? text.slice(0, MAX_ERROR_CHARS) : null;
}

const RESOURCE_PROBLEMS = new Set([
  "resource-not-found",
  "not-authorized-for-resource",
  "resource-unavailable",
]);

export const problemType = (problem: Json): string | null =>
  str(problem.type)?.match(/\/problems\/([a-z-]+)$/)?.[1] ?? null;

export function isResourceProblem(problem: Json): boolean {
  const type = problemType(problem);
  if (type) return RESOURCE_PROBLEMS.has(type);
  const status = num(problem.status);
  return (
    Boolean(str(problem.resource_type) && (str(problem.resource_id) ?? str(problem.value))) &&
    !(status !== null && status >= 500)
  );
}

export const namesResource = (problem: Json, id: string): boolean =>
  [problem.resource_id, problem.value].some(
    (value) => String(value ?? "").toLowerCase() === id.toLowerCase(),
  );

export function problemsOf(body: Json | null): Json[] {
  if (!body) return [];
  const listed = recs(body.errors);
  return listed.length ? listed : str(body.type) || str(body.title) || str(body.detail) ? [body] : [];
}

export const problemList = (problems: readonly Json[]): string =>
  problems
    .map((problem) => problemText(problem) ?? problemType(problem) ?? "an unnamed problem")
    .join("; ");

export function problemKind(problems: readonly Json[]): FailureKind {
  for (const problem of problems) {
    const type = problemType(problem);
    const status = num(problem.status);
    if (type === "internal-error" || (status !== null && status >= 500)) return "server";
    if (type === "rate-limit-exceeded" || status === 429) return "rate";
    if (type === "usage-capped" || status === 402) return "payment";
    if (type === "client-forbidden" || status === 401 || status === 403) return "auth";
  }
  return "request";
}

function resetTime(headers: Headers.Headers): string | null {
  const seconds = num(headers["x-rate-limit-reset"]);
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

function statusFailure(
  status: number,
  headers: Headers.Headers,
  body: Json | null,
  label: string,
  auth: Auth,
): Pick<Failure, "kind" | "status" | "message"> {
  const said = problemText(body);
  const detail = said ? `: ${said}` : "";
  if (status >= 300 && status < 400) {
    const location = headers["location"];
    return {
      kind: "redirect",
      status,
      message: `X API ${label} answered HTTP ${status}${location ? ` with a redirect to ${location}` : ""}. Dig does not follow redirects for X API requests.`,
    };
  }
  if (status === 429) {
    const reset = resetTime(headers);
    return {
      kind: "rate",
      status,
      message: `X API rate limit reached (HTTP 429) for ${label}${detail}. ${reset ? `The limit resets at ${reset} (x-rate-limit-reset).` : "X did not say when the limit resets."} Dig does not wait or retry.`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      kind: "auth",
      status,
      message: `X API refused ${label} with ${credentialOf(auth)} (HTTP ${status})${detail}`,
    };
  }
  if (status === 402) {
    return {
      kind: "payment",
      status,
      message: `X API ${label} needs credits in the X developer account (HTTP 402)${detail}`,
    };
  }
  if (status >= 500) {
    return { kind: "server", status, message: `X API ${label} failed with HTTP ${status}${detail}` };
  }
  return { kind: "request", status, message: `X API ${label} returned HTTP ${status}${detail}` };
}

function makeFailure(
  status: number,
  headers: Headers.Headers,
  body: Json | null,
  label: string,
  auth: Auth,
): Failure {
  const problems = problemsOf(body);
  const others = problems.filter((problem) => !isResourceProblem(problem));
  return {
    ok: false,
    ...statusFailure(status, headers, body, label, auth),
    problem: others.length ? problemList(others) : null,
    resource: problems.filter(isResourceProblem),
  };
}

/**
 * One GET against the X API over `PaidHttp` (zero retries, manual redirects, hop-safe SSRF guard).
 */
export function xGet(
  path: string,
  params: Params,
  label: string,
  ctx: CallContext,
  auth: Auth,
): Effect.Effect<Answer | Failure, never, PaidHttp> {
  return Effect.gen(function* () {
    if (ctx.signal.aborted) {
      return {
        ok: false as const,
        cancelled: true,
        kind: "network" as const,
        status: null,
        message: "Research call cancelled",
        problem: null,
        resource: [],
      };
    }
    let url = new URL(path, API_BASE);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
    }
    if (typeof auth !== "string") url = signedQuery(url);

    const res = yield* Effect.result(
      paidRequest({
        url: url.href,
        method: "GET",
        headers: {
          authorization: typeof auth === "string" ? `Bearer ${auth}` : oauthHeader("GET", url, auth),
          accept: "application/json",
        },
        timeoutMs: TIMEOUT_MS,
        signal: ctx.signal,
        label,
        keep: ctx.keep,
      }),
    );

    if (Result.isFailure(res)) {
      if (ctx.signal.aborted) {
        return {
          ok: false as const,
          cancelled: true,
          kind: "network" as const,
          status: null,
          message: "Research call cancelled",
          problem: null,
          resource: [],
        };
      }
      return {
        ok: false as const,
        kind: "network" as const,
        status: null,
        message: `X API ${label} could not be reached: ${message(res.failure)}`,
        problem: null,
        resource: [],
      };
    }

    const { status, headers, payload } = res.success;
    const body = rec(payload);
    if (status < 200 || status >= 300) {
      return makeFailure(status, headers, body, label, auth);
    }
    if (!body) {
      return {
        ok: false as const,
        kind: "server" as const,
        status,
        message: `X API ${label} answered HTTP ${status} without a JSON object`,
        problem: null,
        resource: [],
      };
    }
    const errors = recs(body.errors);
    const resources = errors.filter(isResourceProblem);
    const others = errors.filter((problem) => !isResourceProblem(problem));
    if (!others.length) {
      return { ok: true as const, status, body, problem: null, resources };
    }
    const said = `X API ${label} reported ${problemList(others)}`;
    if (!dataItems(body).length) {
      return {
        ok: false as const,
        kind: problemKind(others),
        status,
        message: `${said}, and returned no data`,
        problem: problemList(others),
        resource: resources,
      };
    }
    return { ok: true as const, status, body, problem: said, resources };
  });
}

export function xRead(
  path: string,
  params: Params,
  label: string,
  ctx: CallContext,
  auth: Auth,
): Effect.Effect<Answer | Failure, never, PaidHttp> {
  return Effect.gen(function* () {
    const answer = yield* xGet(path, params, label, ctx, auth);
    if (!answer.ok && ctx.halt && !ctx.halt.by && HALT_KINDS.has(answer.kind)) {
      ctx.halt.by = answer;
    }
    if (!answer.ok || !answer.resources.length || dataItems(answer.body).length) {
      return answer;
    }
    return {
      ok: false as const,
      kind: "request" as const,
      status: answer.status,
      message: `X API ${label} reported ${problemList(answer.resources)}, and returned no data`,
      problem: null,
      resource: answer.resources,
    };
  });
}

// ---------------------------------------------------------------------------
// Signed-in account cache & archive pacing
// ---------------------------------------------------------------------------

export interface SignedIn {
  readonly ok: true;
  readonly id: string;
  readonly handle: string | null;
}

const signedInAccounts = new Map<string, SignedIn>();

export function clearSignedInAccountCache(): void {
  signedInAccounts.clear();
}

export function signedInAccount(
  keys: UserKeys,
  ctx: CallContext,
): Effect.Effect<SignedIn | Failure, never, PaidHttp> {
  return Effect.gen(function* () {
    const known = signedInAccounts.get(keys.accessToken);
    if (known) return known;
    const answer = yield* xGet(
      "/2/users/me",
      { "user.fields": "id,name,username" },
      "signed-in account",
      ctx,
      keys,
    );
    if (!answer.ok) return answer;
    const id = str(rec(answer.body.data)?.id);
    if (!id) {
      return {
        ok: false as const,
        kind: "server" as const,
        status: answer.status,
        message: "X API signed-in account answered without the account's id",
        problem: null,
        resource: [],
      };
    }
    const resolved: SignedIn = { ok: true, id, handle: str(rec(answer.body.data)?.username) };
    signedInAccounts.set(keys.accessToken, resolved);
    return resolved;
  });
}

let archiveQueue: Promise<void> = Promise.resolve();
let lastArchiveRequest = 0;

export function resetArchivePacing(): void {
  lastArchiveRequest = 0;
}

export function archiveTurn(signal: AbortSignal): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: () => {
      const turn = archiveQueue.then(async () => {
        if (signal.aborted) throw new Error("Request aborted");
        const wait = lastArchiveRequest + ARCHIVE_PACING.intervalMs - Date.now();
        if (wait > 0) {
          await Effect.runPromise(abortableSleep(wait, signal));
        }
        lastArchiveRequest = Date.now();
      });
      archiveQueue = turn.catch(() => {});
      return turn;
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });
}

// ---------------------------------------------------------------------------
// Response objects & honest X reads billing
// ---------------------------------------------------------------------------

export interface Includes {
  readonly users: Map<string, Json>;
  readonly posts: Map<string, Json>;
  readonly media: Map<string, Json>;
  readonly polls: Map<string, Json>;
  readonly places: Map<string, Json>;
  readonly topics: Map<string, Json>;
}

export const newIncludes = (): Includes => ({
  users: new Map(),
  posts: new Map(),
  media: new Map(),
  polls: new Map(),
  places: new Map(),
  topics: new Map(),
});

export function addIncludes(into: Includes, body: Json): void {
  const inc = rec(body.includes);
  if (!inc) return;
  const put = (map: Map<string, Json>, items: readonly Json[], key: string) => {
    for (const item of items) {
      const id = str(item[key]);
      if (id) map.set(id, item);
    }
  };
  put(into.users, recs(inc.users), "id");
  put(into.posts, [...recs(inc.posts), ...recs(inc.tweets)], "id");
  put(into.media, recs(inc.media), "media_key");
  put(into.polls, recs(inc.polls), "id");
  put(into.places, recs(inc.places), "id");
  put(into.topics, recs(inc.topics), "id");
}

export const dataItems = (body: Json): Json[] => {
  const single = rec(body.data);
  return Array.isArray(body.data) ? recs(body.data) : single ? [single] : [];
};

export const nextToken = (body: Json): string | null => str(rec(body.meta)?.next_token);

export const POST_READS = "X post reads";
export const ACCOUNT_READS = "X account reads";
export const VIA_TIKHUB = "via TikHub";

/**
 * Count X posts and accounts returned by one kept X API response:
 * post objects in `data` and in `includes.posts`/`includes.tweets`;
 * account objects in `data` and in `includes.users`.
 * Returns `null` (unknown) for TikHub responses or non-HTTP transport errors.
 */
export function xReads(response: RetainedResponse): { readonly posts: number; readonly accounts: number } | null {
  if (typeof response.status !== "number" || response.label.includes(VIA_TIKHUB)) return null;
  const body = rec(response.body);
  if (!body) {
    // A 2xx response without a JSON object cannot establish zero reads; keep cost unknown.
    return response.status >= 200 && response.status < 300 ? null : { posts: 0, accounts: 0 };
  }
  const inc = rec(body.includes);
  const data = dataItems(body);
  const accounts = data.filter((item) => str(item.username) !== null);
  const posts = data.filter(
    (item) =>
      str(item.username) === null &&
      (typeof item.text === "string" || rec(item.note_post) !== null || rec(item.note_tweet) !== null),
  );
  return {
    posts: posts.length + recs(inc?.posts).length + recs(inc?.tweets).length,
    accounts: accounts.length + recs(inc?.users).length,
  };
}

/** Honest resource-read billing policy for X post and account actions. */
export const X_READS_BILLING: BillingPolicy<unknown> = {
  charge(response): ReceiptCost {
    const reads = xReads(response);
    return reads === null
      ? { cost: null }
      : {
          cost: [
            { amount: reads.posts, unit: POST_READS },
            { amount: reads.accounts, unit: ACCOUNT_READS },
          ],
        };
  },
};

/**
 * Honest billing policy for `x_explore`:
 * - `kind: "list"` returns X posts and accounts, so count them via `xReads`.
 * - `trends`, `spaces`, and `communities` remain unknown (`{ cost: null }`).
 */
export const X_EXPLORE_BILLING: BillingPolicy<{ readonly kind: string }> = {
  charge(response, args): ReceiptCost {
    if (args.kind !== "list") return { cost: null };
    const reads = xReads(response);
    return reads === null
      ? { cost: null }
      : {
          cost: [
            { amount: reads.posts, unit: POST_READS },
            { amount: reads.accounts, unit: ACCOUNT_READS },
          ],
        };
  },
};

export const READS_NOTE = `X reports no per-call charge, so the cost is recorded as the posts and accounts X returned (${POST_READS} and ${ACCOUNT_READS}), not money (see ${X_API_DOCS_URL})`;

// ---------------------------------------------------------------------------
// Post and account formatting
// ---------------------------------------------------------------------------

export const fullText = (post: Json): string =>
  str(rec(post.note_post)?.text) ?? str(rec(post.note_tweet)?.text) ?? str(post.text) ?? "";

export const textEntities = (post: Json): Json | null =>
  rec(rec(post.note_post)?.entities) ?? rec(rec(post.note_tweet)?.entities) ?? rec(post.entities);

export const references = (post: Json): Json[] =>
  recs(post.referenced_posts ?? post.referenced_tweets);

export const editHistory = (post: Json): string[] =>
  strings(post.edit_history_post_ids ?? post.edit_history_tweet_ids);

export const authorOf = (post: Json, inc: Includes): Json | null =>
  inc.users.get(String(post.author_id ?? "")) ?? null;

export const handleOf = (user: Json | null): string | null => str(user?.username);

export const permalink = (id: string, handle: string | null): string =>
  `https://x.com/${handle ?? "i"}/status/${id}`;

export const postLink = (post: Json, inc: Includes): string =>
  permalink(String(post.id), handleOf(authorOf(post, inc)));

export function verifiedText(user: Json): string | null {
  if (user.verified !== true) return null;
  const kind = str(user.verified_type);
  return kind && kind !== "none" ? `verified ${kind}` : "verified";
}

export function byline(user: Json | null, authorId?: unknown): string {
  if (!user) return authorId ? `author ${String(authorId)}` : "unknown author";
  const followers = num(rec(user.public_metrics)?.followers_count);
  const about = [
    str(user.name),
    followers === null ? null : count(followers, "follower", "followers"),
    verifiedText(user),
    user.protected === true ? "protected" : null,
  ].filter((part): part is string => part !== null);
  const who = handleOf(user) ? `@${handleOf(user)}` : `user ${String(user.id ?? "")}`;
  return about.length ? `${who} (${about.join(", ")})` : who;
}

export function metrics(post: Json, skipZero = false): string[] {
  const m = rec(post.public_metrics);
  if (!m) return [];
  const parts: string[] = [];
  const add = (value: unknown, one: string, many: string) => {
    const n = num(value);
    if (n !== null && !(skipZero && n === 0)) parts.push(count(n, one, many));
  };
  add(m.reply_count, "reply", "replies");
  add(m.repost_count ?? m.retweet_count, "repost", "reposts");
  add(m.quote_count, "quote", "quotes");
  add(m.like_count, "like", "likes");
  add(m.bookmark_count, "bookmark", "bookmarks");
  add(m.impression_count, "impression", "impressions");
  return parts;
}

export function mediaLines(post: Json, inc: Includes): string[] {
  return strings(rec(post.attachments)?.media_keys).map((key) => {
    const media = inc.media.get(key);
    if (!media) return `Media: ${key} (not expanded by X)`;
    const mp4 = recs(media.variants)
      .filter((variant) => variant.content_type === "video/mp4" && str(variant.url))
      .sort((a, b) => (num(b.bit_rate) ?? 0) - (num(a.bit_rate) ?? 0))[0];
    const url = str(mp4?.url) ?? str(media.url) ?? str(media.preview_image_url);
    const duration = num(media.duration_ms);
    const views = num(rec(media.public_metrics)?.view_count);
    const notes = [
      duration === null ? null : `${(duration / 1000).toFixed(1)} s`,
      views === null ? null : count(views, "view", "views"),
      mp4 && str(media.preview_image_url) ? `preview ${media.preview_image_url}` : null,
      str(media.alt_text) ? `alt text: ${media.alt_text}` : null,
    ].filter(Boolean);
    return `Media: ${str(media.type) ?? "media"} ${url ?? "(no URL returned)"}${notes.length ? ` (${notes.join("; ")})` : ""}`;
  });
}

export function pollLines(post: Json, inc: Includes): string[] {
  return strings(rec(post.attachments)?.poll_ids).flatMap((id) => {
    const poll = inc.polls.get(id);
    if (!poll) return [`Poll: ${id} (not expanded by X)`];
    const end = str(poll.end_datetime);
    const about = [
      str(poll.voting_status),
      end ? `${poll.voting_status === "closed" ? "ended" : "ends"} ${stamp(end, null)}` : null,
      num(poll.duration_minutes) === null ? null : `${poll.duration_minutes} minutes`,
    ].filter(Boolean);
    const options = recs(poll.options).map(
      (option) =>
        `${option.position ?? "?"}. ${String(option.label ?? "")} — ${count(num(option.votes) ?? 0, "vote", "votes")}`,
    );
    return [`Poll${about.length ? ` (${about.join(", ")})` : ""}: ${options.join("; ")}`];
  });
}

export function placeLines(post: Json, inc: Includes): string[] {
  const geo = rec(post.geo);
  if (!geo) return [];
  const lines: string[] = [];
  const place = inc.places.get(String(geo.place_id ?? ""));
  if (place) {
    lines.push(
      `Place: ${str(place.full_name) ?? str(place.name) ?? place.id} (${[str(place.place_type), str(place.country)].filter(Boolean).join(", ")})`,
    );
  }
  const point = rec(geo.coordinates);
  if (point && Array.isArray(point.coordinates)) {
    lines.push(`Point (longitude, latitude): ${point.coordinates.join(", ")}`);
  }
  return lines;
}

export function linkLines(post: Json): string[] {
  return recs(textEntities(post)?.urls)
    .filter((link) => !str(link.media_key))
    .flatMap((link) => {
      const address = str(link.unwound_url) ?? str(link.expanded_url) ?? str(link.url);
      return address ? [`Link: ${address}${str(link.title) ? ` — ${link.title}` : ""}`] : [];
    });
}

export function contextLine(post: Json): string | null {
  const pairs = new Set(
    recs(post.context_annotations).map(
      (annotation) =>
        `${str(rec(annotation.domain)?.name)?.trim() ?? "?"}: ${str(rec(annotation.entity)?.name)?.trim() ?? "?"}`,
    ),
  );
  return pairs.size ? `Context annotations: ${[...pairs].join("; ")}` : null;
}

export function articleLines(post: Json): string[] {
  const article = rec(post.article);
  const fields = Object.entries(article ?? {}).flatMap(([key, value]) =>
    str(value) ? [`${key}: ${value}`] : [],
  );
  const title = str(article?.title)
    ? null
    : (str(post.article_title) ?? str(rec(post.article_title)?.title));
  if (!fields.length && !title) return [];
  return ["X Article:", ...(title ? [`title: ${title}`] : []), ...fields];
}

export const REPOST_TYPES = new Set(["retweeted", "reposted"]);

export const referenceVerb = (type: unknown): string =>
  type === "quoted"
    ? "Quoting"
    : REPOST_TYPES.has(String(type))
      ? "Reposting"
      : type === "replied_to"
        ? "Replying to"
        : "Referencing";

export function referenceLines(post: Json, inc: Includes, full: boolean): string[] {
  const lines: string[] = [];
  for (const reference of references(post)) {
    const id = str(reference.id);
    if (!id) continue;
    const target = inc.posts.get(id);
    const author = target
      ? authorOf(target, inc)
      : reference.type === "replied_to"
        ? (inc.users.get(String(post.in_reply_to_user_id ?? "")) ?? null)
        : null;
    const verb = referenceVerb(reference.type);
    const link = permalink(id, handleOf(author));
    const original = target
      ? quoteBlock([...fullText(target).split("\n"), ...mediaLines(target, inc), ...linkLines(target)])
      : [];
    if (!full || !target) {
      lines.push(
        `${verb} ${author ? `@${handleOf(author)}` : "a post"}: ${link}${target || !full ? "" : " (not expanded by X)"}`,
      );
      if (verb === "Reposting") lines.push(...original);
      continue;
    }
    lines.push(
      "",
      `${verb} ${byline(author, target.author_id)} · ${[stamp(target.created_at, id), ...metrics(target)].filter(Boolean).join(" · ")}`,
      link,
      ...original,
    );
  }
  return lines;
}

export function editLines(post: Json, inc: Includes): string[] {
  const versions = editHistory(post);
  if (versions.length < 2) return [];
  const earlier = versions.flatMap((id) => {
    const version = id === post.id ? undefined : inc.posts.get(id);
    return version ? [{ id, version }] : [];
  });
  return [
    `Edit history: ${versions.length} versions (${versions.join(", ")}); this is ${post.id}.`,
    ...earlier.flatMap(({ id, version }) => [
      `Earlier version ${id}:`,
      ...quoteBlock(fullText(version).split("\n")),
    ]),
  ];
}

export const communityLink = (id: string): string => `https://x.com/i/communities/${id}`;
export const communityLines = (post: Json): string[] =>
  str(post.community_id) ? [`Community: ${communityLink(String(post.community_id))}`] : [];

export function formatPost(post: Json, inc: Includes): string[] {
  const id = String(post.id);
  const author = authorOf(post, inc);
  const facts = [
    stamp(post.created_at, id),
    str(post.lang) ? `language ${post.lang}` : null,
    ...metrics(post),
  ].filter(Boolean);
  const flags = [
    post.possibly_sensitive === true ? "possibly sensitive" : null,
    post.paid_partnership === true ? "disclosed paid partnership" : null,
    str(post.reply_settings) && post.reply_settings !== "everyone"
      ? `replies limited to ${post.reply_settings}`
      : null,
    strings(rec(post.withheld)?.country_codes).length
      ? `withheld in ${strings(rec(post.withheld)?.country_codes).join(", ")}`
      : null,
  ].filter(Boolean);
  const context = contextLine(post);
  return [
    `X post by ${byline(author, post.author_id)}`,
    permalink(id, handleOf(author)),
    facts.join(" · "),
    ...(flags.length ? [`Flags: ${flags.join("; ")}`] : []),
    ...editLines(post, inc),
    ...communityLines(post),
    "",
    fullText(post) || "(no text)",
    ...withGap([
      ...articleLines(post),
      ...mediaLines(post, inc),
      ...pollLines(post, inc),
      ...placeLines(post, inc),
      ...linkLines(post),
      ...(context ? [context] : []),
    ]),
    ...referenceLines(post, inc, true),
  ];
}

export function formatListPost(post: Json, inc: Includes): string[] {
  const id = String(post.id);
  const author = authorOf(post, inc);
  const head = [
    byline(author, post.author_id),
    stamp(post.created_at, id),
    ...metrics(post, true),
    postLink(post, inc),
  ]
    .filter(Boolean)
    .join(" · ");
  const body = [
    ...(fullText(post) || "(no text)").split("\n"),
    ...communityLines(post),
    ...mediaLines(post, inc),
    ...pollLines(post, inc),
    ...linkLines(post),
    ...referenceLines(post, inc, false),
  ];
  return [`- ${head}`, ...body.map((line) => `  ${line}`)];
}

export function userUrl(user: Json): string | null {
  const expanded = recs(rec(rec(user.entities)?.url)?.urls)
    .map((link) => str(link.expanded_url))
    .find(Boolean);
  return expanded ?? str(user.url);
}

export function formatUser(user: Json): string[] {
  const handle = handleOf(user);
  const m = rec(user.public_metrics);
  const flags = [
    verifiedText(user),
    user.is_identity_verified === true ? "ID verified" : null,
    user.protected === true ? "protected" : null,
  ].filter(Boolean);
  const counts: string[] = [];
  const add = (value: unknown, one: string, many: string) => {
    const n = num(value);
    if (n !== null) counts.push(count(n, one, many));
  };
  add(m?.followers_count, "follower", "followers");
  add(m?.following_count, "following", "following");
  add(m?.post_count ?? m?.tweet_count, "post", "posts");
  add(m?.listed_count, "list", "lists");
  add(m?.like_count, "like given", "likes given");
  add(m?.media_count, "media item", "media items");
  const pinned = str(user.pinned_post_id) ?? str(user.pinned_tweet_id);
  const withheldCodes = strings(rec(user.withheld)?.country_codes);
  const joined = str(user.created_at);
  return [
    `${handle ? `@${handle}` : `user ${String(user.id ?? "")}`} — ${str(user.name) ?? "(no name)"}${flags.length ? ` (${flags.join(", ")})` : ""}`,
    ...(handle ? [`https://x.com/${handle}`] : []),
    ...(str(user.description) ? [`Bio: ${user.description}`] : []),
    [
      str(user.location) ? `Location: ${user.location}` : null,
      userUrl(user) ? `Link: ${userUrl(user)}` : null,
      joined ? `Joined ${joined.slice(0, 10)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    counts.join(" · "),
    ...(pinned ? [`Pinned post: ${permalink(pinned, handle)}`] : []),
    ...(withheldCodes.length ? [`Withheld in: ${withheldCodes.join(", ")}`] : []),
  ].filter((line) => line !== "");
}

export const userLine = (user: Json): string =>
  `- ${byline(user)}${handleOf(user) ? ` · https://x.com/${handleOf(user)}` : ""}`;

// ---------------------------------------------------------------------------
// Missing/refusal/problem helpers
// ---------------------------------------------------------------------------

export interface Missing {
  readonly id: string;
  readonly reason: string;
}

export const answered = (resources: readonly Json[], id: string): boolean =>
  resources.some((problem) => namesResource(problem, id));

export function missingOf(
  requested: readonly string[],
  returned: ReadonlySet<string>,
  resources: readonly Json[],
): Missing[] {
  return requested
    .filter((id) => !returned.has(id.toLowerCase()))
    .map((id) => {
      const problem = resources.find((candidate) => namesResource(candidate, id));
      return {
        id,
        reason: problem
          ? (problemText(problem) ?? problemType(problem) ?? "X named it without a reason")
          : "X returned neither it nor an error naming it",
      };
    });
}

export function lookupStatus(
  returned: number,
  missing: readonly Missing[],
  resources: readonly Json[],
  partFailures: number,
): OutcomeStatus {
  if (!returned) return missing.every((item) => answered(resources, item.id)) ? "empty" : "failed";
  return missing.length || partFailures ? "partial" : "success";
}

export const withheld = (resources: readonly Json[], posts: number): string =>
  `X refused or withheld ${posts === 1 ? "the post" : "posts"} (${problemList(resources)}), so ${posts === 1 ? "it was" : "they were"} not read elsewhere.`;

export function refusedLookup(
  requested: readonly string[],
  refusal: Failure,
  nouns: readonly [string, string],
  mark: string,
  note: string | null,
): { readonly status: OutcomeStatus; readonly text: string; readonly missing: Missing[] } {
  const missing = missingOf(requested, new Set(), refusal.resource);
  const notReturned = missing.map((item) => `Not returned: ${mark}${item.id} — ${item.reason}`);
  if (missing.every((item) => answered(refusal.resource, item.id))) {
    return {
      status: "empty",
      missing,
      text: [
        `X API: ${count(0, ...nouns)} of ${requested.length} requested.`,
        ...notReturned,
        ...(refusal.problem ? [`X also reported: ${refusal.problem}`] : []),
      ].join("\n"),
    };
  }
  return {
    status: "failed",
    missing,
    text: [`ERROR: ${refusal.message}`, ...(note ? [note] : []), ...notReturned].join("\n"),
  };
}

export function noneReturned(
  requested: readonly string[],
  resources: readonly Json[],
  nouns: readonly [string, string],
  mark: string,
): { readonly status: OutcomeStatus; readonly text: string; readonly missing: Missing[] } {
  const missing = missingOf(requested, new Set(), resources);
  const status = lookupStatus(0, missing, resources, 0);
  const lines = [
    `${status === "failed" ? "ERROR: " : ""}X API: ${count(0, ...nouns)} of ${requested.length} requested.`,
    ...missing.map((item) => `Not returned: ${mark}${item.id} — ${item.reason}`),
    ...(status === "failed" && resources.length ? [`X reported: ${problemList(resources)}`] : []),
  ];
  return { status, missing, text: lines.join("\n") };
}

export function withProblem(
  problem: string | null,
  text: string,
  details: Record<string, unknown>,
): ActionOutcome {
  if (!problem) return outcome("success", bounded(text), details);
  const [first, ...rest] = text.split("\n");
  return outcome("partial", bounded([first, `Partial: ${problem}`, ...rest].join("\n")), details);
}

// ---------------------------------------------------------------------------
// Links & identifiers
// ---------------------------------------------------------------------------

export const POST_HOSTS = new Set(["x.com", "twitter.com"]);
export const NUMERIC_ID = /^\d{1,19}$/;
export const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
export const PEOPLE_QUERY = /^[A-Za-z0-9_' ]{1,50}$/;

export function urlOf(value: string): URL | null {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
}

export function postId(input: string): string | null {
  const value = input.trim();
  if (NUMERIC_ID.test(value)) return value;
  const url = urlOf(value);
  if (!url || !POST_HOSTS.has(url.hostname.toLowerCase().replace(/^(?:www|mobile)\./, ""))) {
    return null;
  }
  return url.pathname.match(/\/status(?:es)?\/(\d{1,19})(?:\/|$)/)?.[1] ?? null;
}

export function listId(input: string): string | null {
  const value = input.trim();
  if (NUMERIC_ID.test(value)) return value;
  const url = urlOf(value);
  if (!url || !POST_HOSTS.has(url.hostname.toLowerCase().replace(/^(?:www|mobile)\./, ""))) {
    return null;
  }
  return url.pathname.match(/\/lists\/(\d{1,19})(?:\/|$)/)?.[1] ?? null;
}

export function communityId(input: string): string | null {
  const value = input.trim();
  if (NUMERIC_ID.test(value)) return value;
  const url = urlOf(value);
  if (!url || !POST_HOSTS.has(url.hostname.toLowerCase().replace(/^(?:www|mobile)\./, ""))) {
    return null;
  }
  return url.pathname.match(/\/i\/communities\/(\d{1,19})(?:\/|$)/)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Section & halt helpers
// ---------------------------------------------------------------------------

export interface Section {
  readonly lines: string[];
  readonly failure: string | null;
  readonly skipped?: string;
}

export function notAttempted(ctx: CallContext, what: string, sections: Section[]): boolean {
  if (!ctx.halt?.by) return false;
  ctx.halt.skipped += 1;
  sections.push({ lines: [], failure: null, skipped: what });
  return true;
}

export function sectionLines(sections: readonly Section[]): string[] {
  const skipped = sections.flatMap((section) => (section.skipped ? [section.skipped] : []));
  return [
    ...sections
      .filter((section) => !section.skipped)
      .flatMap((section) => [
        "",
        ...section.lines,
        ...(section.failure ? [`Not read: ${section.failure}`] : []),
      ]),
    ...(skipped.length ? ["", `Not attempted: ${skipped.join(", ")}.`] : []),
  ];
}

export function haltLines(halt: Halt): string[] {
  if (!halt.by || !halt.skipped) return [];
  const why =
    halt.by.kind === "rate"
      ? "X's rate limit"
      : halt.by.kind === "payment"
        ? "X's credit failure"
        : "X's refusal of the credential";
  return [
    `Not attempted: ${count(halt.skipped, "requested read", "requested reads")}. After ${why} above, Dig sent no further reads in this call.`,
  ];
}

export function byId(a: Json, b: Json): number {
  const x = BigInt(String(a.id));
  const y = BigInt(String(b.id));
  return x < y ? -1 : x > y ? 1 : 0;
}

export function postTime(post: Json): number | null {
  const at = Date.parse(String(post.created_at ?? ""));
  return Number.isNaN(at) ? snowflakeTime(String(post.id)) : at;
}

// ---------------------------------------------------------------------------
// Paged post reads
// ---------------------------------------------------------------------------

export interface SearchPages {
  readonly posts: Json[];
  readonly pages: number;
  readonly more: boolean;
  readonly capped: boolean;
  readonly error: string | null;
  readonly cancelled?: boolean;
}

export interface Paging {
  readonly path: string;
  readonly params: Params;
  readonly limit: number;
  readonly label: string;
  readonly cursor: "next_token" | "pagination_token";
  readonly size: { readonly min: number; readonly max: number };
  readonly archive?: boolean;
}

export function readPages(
  paging: Paging,
  inc: Includes,
  ctx: CallContext,
  auth: Auth,
): Effect.Effect<SearchPages, never, PaidHttp> {
  return Effect.gen(function* () {
    const { limit, label } = paging;
    const posts: Json[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    for (;;) {
      if (ctx.signal.aborted) {
        return { posts, pages, more: true, capped: false, error: "Research call cancelled", cancelled: true };
      }
      if (paging.archive) {
        const paced = yield* Effect.result(archiveTurn(ctx.signal));
        if (Result.isFailure(paced)) {
          return { posts, pages, more: true, capped: false, error: "Research call cancelled", cancelled: true };
        }
      }
      pages += 1;
      const answer = yield* xRead(
        paging.path,
        {
          ...POST_PARAMS,
          ...paging.params,
          max_results: clamp(limit - posts.length, paging.size.min, paging.size.max),
          [paging.cursor]: cursor ?? undefined,
        },
        pages === 1 ? label : `${label}, page ${pages}`,
        ctx,
        auth,
      );
      if (!answer.ok) {
        return {
          posts,
          pages,
          more: true,
          capped: false,
          error: answer.message,
          ...(answer.cancelled ? { cancelled: true } : {}),
        };
      }
      addIncludes(inc, answer.body);
      for (const post of dataItems(answer.body)) {
        const id = str(post.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        posts.push(post);
      }
      cursor = nextToken(answer.body);
      if (answer.problem) {
        return { posts: posts.slice(0, limit), pages, more: true, capped: false, error: answer.problem };
      }
      if (!cursor || posts.length >= limit) {
        return {
          posts: posts.slice(0, limit),
          pages,
          more: Boolean(cursor) || posts.length > limit,
          capped: false,
          error: null,
        };
      }
      if (pages >= MAX_SEARCH_PAGES) {
        return { posts, pages, more: true, capped: true, error: null };
      }
    }
  });
}

export function searchPages(
  endpoint: "recent" | "all",
  params: Params,
  limit: number,
  label: string,
  inc: Includes,
  ctx: CallContext,
  token: string,
): Effect.Effect<SearchPages, never, PaidHttp> {
  return readPages(
    {
      path: `/2/tweets/search/${endpoint}`,
      params,
      limit,
      label,
      cursor: "next_token",
      size: endpoint === "all" ? ARCHIVE_SEARCH_PAGE : SEARCH_PAGE,
      archive: endpoint === "all",
    },
    inc,
    ctx,
    token,
  );
}

// ---------------------------------------------------------------------------
// TikHub X helpers (single-post fallback, Communities search & posts)
// ---------------------------------------------------------------------------

export interface TikhubMedia {
  readonly kind: string;
  readonly url: string;
}

export interface TikhubPost {
  readonly id: string;
  readonly handle: string | null;
  readonly name: string | null;
  readonly followers: number | null;
  readonly verified: boolean;
  readonly createdAt: string | null;
  readonly text: string;
  readonly replies: number | null;
  readonly reposts: number | null;
  readonly quotes: number | null;
  readonly likes: number | null;
  readonly bookmarks: number | null;
  readonly views: number | null;
  readonly replyToId: string | null;
  readonly replyToHandle: string | null;
  readonly media: TikhubMedia[];
  readonly quoted: TikhubPost | null;
}

const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";

export function tikhubTime(createdAt: unknown, id: string): string | null {
  const match =
    typeof createdAt === "string"
      ? createdAt.match(/^\w{3} (\w{3}) (\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2}) (\d{4})$/)
      : null;
  const month = match ? MONTHS.indexOf(match[1]) : -1;
  if (match && month >= 0 && month % 3 === 0) {
    const date = new Date(
      `${match[6]}-${String(month / 3 + 1).padStart(2, "0")}-${match[2]}T${match[3]}${match[4]}:${match[5]}`,
    );
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const ms = snowflakeTime(id);
  return ms === null ? null : new Date(ms).toISOString();
}

export function tikhubMedia(value: unknown): TikhubMedia[] {
  const groups: Array<[string, unknown[]]> = Array.isArray(value)
    ? value.map((item) => [str(rec(item)?.type) ?? "media", [item]])
    : Object.entries(rec(value) ?? {}).map(([kind, items]) => [kind, Array.isArray(items) ? items : []]);
  const media: TikhubMedia[] = [];
  for (const [kind, items] of groups) {
    for (const item of recs(items)) {
      const mp4 = recs(item.variants)
        .filter((variant) => variant.content_type === "video/mp4" && str(variant.url))
        .sort((a, b) => (num(b.bitrate) ?? 0) - (num(a.bitrate) ?? 0))[0];
      const url = str(mp4?.url) ?? str(item.media_url_https) ?? str(item.url);
      if (url) media.push({ kind, url });
    }
  }
  return media;
}

export function expandLinks(text: string, entities: unknown): string {
  let expanded = text;
  for (const link of recs(rec(entities)?.urls)) {
    const short = str(link.url);
    const long = str(link.expanded_url);
    if (short && long) expanded = expanded.replaceAll(short, long);
  }
  return expanded;
}

export function tikhubPost(raw: unknown): TikhubPost | null {
  const record = rec(raw);
  if (!record) return null;
  const id = str(record.id) ?? str(record.tweet_id);
  if (!id || !/^\d+$/.test(id)) return null;
  const author = rec(record.author) ?? rec(record.user_info);
  const quoted = rec(record.quoted);
  return {
    id,
    handle: str(author?.screen_name) ?? str(record.screen_name),
    name: str(author?.name),
    followers: num(author?.followers_count) ?? num(author?.sub_count),
    verified: author?.blue_verified === true || author?.verified === true,
    createdAt: tikhubTime(record.created_at, id),
    text: expandLinks(str(record.text) ?? str(record.display_text) ?? "", record.entities),
    replies: num(record.replies),
    reposts: num(record.retweets),
    quotes: num(record.quotes),
    likes: num(record.likes) ?? num(record.favorites),
    bookmarks: num(record.bookmarks),
    views: num(record.views),
    replyToId: str(record.in_reply_to_status_id_str) ?? str(record.reply_to),
    replyToHandle: str(record.in_reply_to_screen_name),
    media: tikhubMedia(record.media),
    quoted: quoted ? tikhubPost(quoted) : null,
  };
}

export function tikhubByline(post: TikhubPost): string {
  const about = [
    post.name,
    post.followers === null ? null : count(post.followers, "follower", "followers"),
    post.verified ? "verified" : null,
  ].filter((part): part is string => part !== null);
  const who = post.handle ? `@${post.handle}` : "unknown author";
  return about.length ? `${who} (${about.join(", ")})` : who;
}

export function tikhubFacts(post: TikhubPost, skipZero = false): string {
  const parts: string[] = [];
  const add = (value: number | null, one: string, many: string) => {
    if (value !== null && !(skipZero && value === 0)) parts.push(count(value, one, many));
  };
  add(post.replies, "reply", "replies");
  add(post.reposts, "repost", "reposts");
  add(post.quotes, "quote", "quotes");
  add(post.likes, "like", "likes");
  add(post.bookmarks, "bookmark", "bookmarks");
  add(post.views, "view", "views");
  return [post.createdAt ? utc(post.createdAt) : null, ...parts].filter(Boolean).join(" · ");
}

export function formatTikhubPost(post: TikhubPost): string[] {
  const media = (item: TikhubPost) => item.media.map((entry) => `Media: ${entry.kind} ${entry.url}`);
  const lines = [
    `X post by ${tikhubByline(post)}`,
    permalink(post.id, post.handle),
    tikhubFacts(post),
  ];
  if (post.replyToId) {
    lines.push(
      `Replying to ${post.replyToHandle ? `@${post.replyToHandle}` : "a post"}: ${permalink(post.replyToId, post.replyToHandle)}`,
    );
  }
  lines.push("", post.text || "(no text)", ...withGap(media(post)));
  if (post.quoted) {
    const quoted = post.quoted;
    lines.push(
      "",
      `Quoting ${tikhubByline(quoted)} · ${tikhubFacts(quoted)}`,
      permalink(quoted.id, quoted.handle),
      ...quoteBlock([...(quoted.text || "(no text)").split("\n"), ...media(quoted)]),
    );
  }
  return lines;
}

export function formatTikhubListPost(post: TikhubPost): string[] {
  const media = (item: TikhubPost) => item.media.map((entry) => `Media: ${entry.kind} ${entry.url}`);
  const body = [...(post.text || "(no text)").split("\n"), ...media(post)];
  if (post.replyToId) {
    body.push(
      `Replying to ${post.replyToHandle ? `@${post.replyToHandle}` : "a post"}: ${permalink(post.replyToId, post.replyToHandle)}`,
    );
  }
  if (post.quoted) {
    body.push(
      `Quoting ${post.quoted.handle ? `@${post.quoted.handle}` : "a post"}: ${permalink(post.quoted.id, post.quoted.handle)}`,
      ...quoteBlock([...(post.quoted.text || "(no text)").split("\n"), ...media(post.quoted)]),
    );
  }
  return [
    `- ${[tikhubByline(post), tikhubFacts(post, true), permalink(post.id, post.handle)].filter(Boolean).join(" · ")}`,
    ...body.map((line) => `  ${line}`),
  ];
}

/**
 * One GET of a TikHub Twitter web endpoint over `PaidHttp` (zero retries, manual redirects).
 */
export function tikhubGet(
  endpoint: string,
  params: Params,
  label: string,
  apiKey: string,
  ctx: CallContext,
): Effect.Effect<{ readonly data: Json } | { readonly error: string; readonly cancelled?: boolean }, never, PaidHttp> {
  return Effect.gen(function* () {
    if (ctx.signal.aborted) return { error: "Research call cancelled", cancelled: true };
    const url = new URL(`/api/v1/twitter/web/${endpoint}`, `${tikhubBaseUrl().replace(/\/+$/, "")}/`);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
    }

    const res = yield* Effect.result(
      paidRequest({
        url: url.href,
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
        timeoutMs: TIMEOUT_MS,
        signal: ctx.signal,
        label,
        keep: ctx.keep,
      }),
    );

    if (Result.isFailure(res)) {
      if (ctx.signal.aborted) return { error: "Research call cancelled", cancelled: true };
      return { error: `TikHub could not be reached: ${message(res.failure)}` };
    }

    const { status, headers, payload } = res.success;
    if (status >= 300 && status < 400) {
      const location = headers["location"];
      return {
        error: `TikHub ${endpoint} answered HTTP ${status}${location ? ` with a redirect to ${location}` : ""}; Dig does not follow redirects`,
      };
    }

    const body = rec(redactValue(payload, knownSecrets()));
    if (status === 200 && body && num(body.code) === 200) {
      const data = rec(body.data);
      return data ? { data } : { error: `TikHub ${endpoint} returned no data` };
    }
    const said = str(rec(body?.detail)?.message) ?? str(body?.detail) ?? str(body?.message);
    return {
      error: `TikHub ${endpoint} returned HTTP ${status}${said ? `: ${said.slice(0, MAX_ERROR_CHARS).replace(/[.\s]+$/, "")}` : ""}`,
    };
  });
}
