/**
 * TikHub-native Reddit source plugin (`PaidHttp`, unknown per-request cost).
 *
 * Exposes TikHub-only Reddit discovery and enrichment surfaces:
 * typeahead, trending searches, subreddit metadata/style/settings/highlights,
 * author activity, batch post enrichment, and collapsed reply completion.
 */
import { Effect, Schema } from "effect";
import type { PaidHttp } from "../../core/http.ts";
import {
  defineAction,
  defineSource,
  failed,
  outcome,
  type ActionContext,
  type SourcePlugin,
} from "../../core/plugin.ts";
import { knownSecrets, redactText, redactValue } from "../../core/secrets.ts";
import {
  MISSING_TIKHUB_KEY,
  TIKHUB_BILLING,
  TIKHUB_PROVIDER,
  tikhubBaseUrl,
  tikhubHeaders,
  tikhubRequest,
} from "../shared/tikhub.ts";

const DEFAULT_MAX_ITEMS = 10;
const MAX_MAX_ITEMS = 25;

const OPERATION_VALUES = [
  "discovery_bundle",
  "query_scout",
  "subreddit_context",
  "thread_intelligence",
  "deep_thread",
  "author_context",
  "batch_enrich",
  "feed_discovery",
] as const;

const SEARCH_TYPE_VALUES = ["post", "community", "comment", "media", "people"] as const;
const SEARCH_SORT_VALUES = ["RELEVANCE", "HOT", "TOP", "NEW", "COMMENTS"] as const;
const TIME_RANGE_VALUES = ["all", "year", "month", "week", "day", "hour"] as const;
const COMMENT_SORT_VALUES = ["CONFIDENCE", "NEW", "TOP", "HOT", "CONTROVERSIAL", "OLD", "RANDOM"] as const;
const FEED_SORT_VALUES = ["BEST", "HOT", "NEW", "TOP", "RISING", "CONTROVERSIAL"] as const;
const FEED_VALUES = ["popular", "news", "subreddit", "subreddit_channels"] as const;
const AFTER_TARGET_VALUES = ["user_posts", "user_comments"] as const;

type Operation = (typeof OPERATION_VALUES)[number];

interface ToolArgs {
  readonly operation: Operation;
  readonly query?: string;
  readonly searchType?: (typeof SEARCH_TYPE_VALUES)[number];
  readonly sort?: string;
  readonly timeRange?: (typeof TIME_RANGE_VALUES)[number];
  readonly subredditName?: string;
  readonly subredditId?: string;
  readonly postId?: string;
  readonly postIds?: readonly string[];
  readonly username?: string;
  readonly includeSettings?: boolean;
  readonly includeStyle?: boolean;
  readonly includeHighlights?: boolean;
  readonly includeSubredditContext?: boolean;
  readonly includeBatchEnrich?: boolean;
  readonly includeUserHistory?: boolean;
  readonly includeReplies?: boolean;
  readonly maxReplyCursors?: number;
  readonly feed?: (typeof FEED_VALUES)[number];
  readonly after?: string;
  readonly afterTarget?: (typeof AFTER_TARGET_VALUES)[number];
  readonly allowNsfw?: boolean;
  readonly maxItems?: number;
  readonly needFormat?: boolean;
}

interface TikHubCall {
  readonly label: string;
  readonly endpoint: string;
  readonly params: Record<string, string | number | boolean | undefined>;
  readonly data?: unknown;
  readonly error?: string;
  readonly cancelled?: boolean;
  readonly notes?: readonly string[];
}

interface ClassifiedCall extends TikHubCall {
  readonly usefulRecords: number;
  readonly usefulCandidates: number;
  readonly usefulComments: number;
}

interface Candidate {
  readonly id: string | null;
  readonly title: string | null;
  readonly subreddit: string | null;
  readonly author: string | null;
  readonly score: number | null;
  readonly comments: number | null;
  readonly url: string | null;
  readonly snippet: string | null;
  readonly sourceUrl?: string | null;
}

interface CommentHighlight {
  readonly id: string | null;
  readonly author: string | null;
  readonly score: number | null;
  readonly text: string;
  readonly subreddit: string | null;
  readonly permalink: string | null;
}

interface CommunitySignal {
  readonly id: string | null;
  readonly name: string | null;
  readonly title: string | null;
  readonly subscribers: number | null;
  readonly description: string | null;
  readonly url: string | null;
}

interface QuerySignal {
  readonly text: string;
  readonly kind: string | null;
  readonly score: number | null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return normalized || null;
}

function truncate(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }
  return null;
}

function recordValue(record: Record<string, unknown>, key: string): unknown {
  return asRecord(record[key.split(".")[0]]) && key.includes(".")
    ? key.split(".").reduce<unknown>((current, segment) => asRecord(current)?.[segment], record)
    : record[key];
}

function firstRecordString(record: Record<string, unknown>, ...keys: string[]): string | null {
  return firstString(...keys.map((key) => recordValue(record, key)));
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const cleaned = value.replace(/[^\d.-]/g, "");
      if (!cleaned) continue;
      const parsed = Number(cleaned);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function firstRecordNumber(record: Record<string, unknown>, ...keys: string[]): number | null {
  return firstNumber(...keys.map((key) => recordValue(record, key)));
}

function safeJsonSnippet(value: unknown, maxLength = 1600): string {
  try {
    const serialized = JSON.stringify(redactValue(value, knownSecrets()), null, 2) ?? "";
    if (!serialized) return "{}";
    return serialized.length <= maxLength
      ? serialized
      : `${serialized.slice(0, maxLength - 1).trimEnd()}…`;
  } catch {
    return "[unserializable response]";
  }
}

function payloadOf(call: TikHubCall): unknown {
  return asRecord(call.data)?.data ?? call.data;
}

function collectRecords(value: unknown, maxDepth = 6): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();

  function visit(node: unknown, depth: number): void {
    if (depth > maxDepth || node === null || node === undefined) return;
    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }

    const record = node as Record<string, unknown>;
    records.push(record);
    for (const item of Object.values(record)) visit(item, depth + 1);
  }

  visit(value, 0);
  return records;
}

function collectStringsByKey(value: unknown, keyPattern: RegExp, valuePattern: RegExp): string[] {
  const found = new Set<string>();
  const seen = new Set<unknown>();

  function visit(node: unknown, depth: number): void {
    if (depth > 8 || node === null || node === undefined) return;
    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }

    const record = node as Record<string, unknown>;
    for (const [key, raw] of Object.entries(record)) {
      if (keyPattern.test(key) && typeof raw === "string" && valuePattern.test(raw)) {
        found.add(raw);
      }
      visit(raw, depth + 1);
    }
  }

  visit(value, 0);
  return Array.from(found);
}

function recordToCandidate(record: Record<string, unknown>): Candidate | null {
  const id = firstString(record.id, record.fullname, record.thing_id, record.name, record.groupId);
  const hasRedditThingId = Boolean(id && /^t[13]_/.test(id));
  const hasEngagement =
    firstNumber(
      record.score,
      record.ups,
      record.upvotes,
      record.karma,
      record.num_comments,
      record.comment_count,
      record.comments,
      record.reply_count,
      record.commentCount,
    ) !== null;
  const hasRedditContext = Boolean(
    firstString(
      record.subreddit_name_prefixed,
      record.subreddit,
      record.community_name,
      record.subredditName,
      record.author,
      record.author_name,
      record.username,
      record.authorName,
    ),
  );
  const hasLinkContext = Boolean(
    firstString(record.permalink, record.url, record.link, record.outbound_link),
  );

  if (!hasRedditThingId && !hasEngagement && !hasRedditContext) return null;
  if (id && !hasRedditThingId && !hasEngagement && !hasLinkContext) return null;

  const title = firstString(
    record.title,
    record.link_title,
    record.post_title,
    record.display_name,
    record.displayName,
    record.public_description,
    record.name,
    record.body,
    record.selftext,
    record.text,
  );
  const snippet = firstString(
    record.selftext,
    record.body,
    record.text,
    record.description,
    record.public_description,
  );

  if (!title && !snippet) return null;

  return {
    id,
    title: truncate(title, 180),
    subreddit: firstString(
      record.subreddit_name_prefixed,
      record.subreddit,
      record.community_name,
      record.subredditName,
    ),
    author: firstString(record.author, record.author_name, record.username, record.authorName),
    score: firstNumber(record.score, record.ups, record.upvotes, record.karma),
    comments: firstNumber(
      record.num_comments,
      record.comment_count,
      record.comments,
      record.reply_count,
      record.commentCount,
    ),
    url: firstString(record.permalink, record.url, record.link, record.outbound_link),
    snippet: truncate(snippet, 260),
  };
}

function collectNewsCandidates(payload: unknown): Candidate[] {
  const envelope = asRecord(payload);
  const elements = asRecord(envelope && recordValue(envelope, "data.newsfeed.newsV3.elements"));
  return asArray(elements?.edges).flatMap((edge): Candidate[] => {
    const node = asRecord(asRecord(edge)?.node);
    const id = firstString(node?.groupId);
    if (!id || !/^t3_[A-Za-z0-9]+$/.test(id) || node?.adPayload) return [];
    const cells = asArray(node?.cells)
      .map(asRecord)
      .filter((cell): cell is Record<string, unknown> => cell !== null);
    const title =
      cells.map((cell) => firstString(asRecord(cell.titleCell)?.title, cell.title)).find(Boolean) ??
      null;
    if (!title) return [];
    const metadata = cells.find((cell) => firstString(cell.authorName, cell.detailsString) !== null);
    const actions = cells.find(
      (cell) => cell.commentCount !== undefined || cell.score !== undefined,
    );
    return [
      {
        id,
        title: truncate(title, 180),
        subreddit: firstString(metadata?.detailsString, metadata?.subredditName),
        author: firstString(metadata?.authorName),
        score: actions?.isScoreHidden === true ? null : firstNumber(actions?.score),
        comments: firstNumber(actions?.commentCount),
        url: `https://www.reddit.com/comments/${id.slice(3)}/`,
        sourceUrl: firstString(metadata?.mediaPath),
        snippet: null,
      },
    ];
  });
}

function collectCandidates(calls: readonly TikHubCall[], maxItems: number): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const call of calls) {
    if (call.error) continue;
    if (call.endpoint === "/api/v1/reddit/app/fetch_news_feed") {
      for (const candidate of collectNewsCandidates(call.data)) {
        if (!candidate.id || seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        candidates.push(candidate);
        if (candidates.length >= maxItems) return candidates;
      }
      continue;
    }
    for (const record of collectRecords(payloadOf(call))) {
      const candidate = recordToCandidate(record);
      if (!candidate) continue;
      const key =
        candidate.id || `${candidate.title || ""}:${candidate.subreddit || ""}:${candidate.author || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
      if (candidates.length >= maxItems) return candidates;
    }
  }

  return candidates;
}

function recordToCommentHighlight(record: Record<string, unknown>): CommentHighlight | null {
  const id = firstRecordString(record, "id", "fullname", "thing_id", "name", "commentId");
  const text = firstRecordString(
    record,
    "body",
    "bodyText",
    "text",
    "markdown",
    "content.markdown",
    "content.text",
    "comment.content.markdown",
    "comment.body",
    "node.content.markdown",
  );
  if (!text || text.length < 20) return null;

  const looksLikeComment =
    !id || /^t1_/.test(id) || Boolean(firstRecordString(record, "commentId", "parentId", "parent_id"));
  if (!looksLikeComment) return null;

  const author = firstRecordString(
    record,
    "author",
    "authorName",
    "author_name",
    "username",
    "user.name",
    "user.username",
    "authorInfo.name",
    "authorInfo.username",
    "comment.author",
    "comment.authorName",
  );

  return {
    id,
    author,
    score: firstRecordNumber(record, "score", "ups", "upvotes", "voteScore", "commentScore", "karma"),
    text: truncate(text, 360) || text,
    subreddit: firstRecordString(
      record,
      "subreddit",
      "subredditName",
      "subreddit_name_prefixed",
      "communityName",
    ),
    permalink: firstRecordString(record, "permalink", "url", "link"),
  };
}

function collectCommentHighlights(calls: readonly TikHubCall[], maxItems: number): CommentHighlight[] {
  const comments: CommentHighlight[] = [];
  const seen = new Map<string, number>();

  for (const call of calls) {
    if (call.error) continue;
    if (!/(^post comments|collapsed replies|dynamic comment search|user comments)/i.test(call.label)) {
      continue;
    }
    for (const record of collectRecords(payloadOf(call), 8)) {
      const comment = recordToCommentHighlight(record);
      if (!comment) continue;
      const key = comment.text.toLowerCase().replace(/\s+/g, " ").slice(0, 220);
      const existingIndex = seen.get(key);
      if (existingIndex !== undefined) {
        const existing = comments[existingIndex];
        const existingRichness =
          (existing.id ? 1 : 0) + (existing.author ? 1 : 0) + (existing.permalink ? 1 : 0);
        const newRichness =
          (comment.id ? 1 : 0) + (comment.author ? 1 : 0) + (comment.permalink ? 1 : 0);
        if (newRichness > existingRichness) comments[existingIndex] = comment;
        continue;
      }
      seen.set(key, comments.length);
      comments.push(comment);
      if (comments.length >= maxItems) return comments;
    }
  }

  return comments;
}

function recordToCommunitySignal(record: Record<string, unknown>): CommunitySignal | null {
  const id = firstRecordString(record, "id", "name", "subredditId", "subreddit_id", "thing_id");
  const name = firstRecordString(
    record,
    "display_name_prefixed",
    "subreddit_name_prefixed",
    "display_name",
    "subreddit",
    "subredditName",
    "community_name",
    "name",
  );
  const normalizedName = name?.replace(/^r\//, "") || null;
  const title = firstRecordString(record, "title", "public_description", "description", "displayName");
  const description = firstRecordString(
    record,
    "public_description",
    "description",
    "subreddit.description",
    "communityDescription",
  );
  const subscribers = firstRecordNumber(
    record,
    "subscribers",
    "subscriber_count",
    "members",
    "memberCount",
    "active_user_count",
  );
  const hasCommunitySignal =
    Boolean(id && /^t5_/.test(id)) ||
    Boolean(
      firstRecordString(
        record,
        "display_name",
        "display_name_prefixed",
        "subredditName",
        "subreddit_name_prefixed",
      ),
    ) ||
    subscribers !== null;

  if (!hasCommunitySignal || !normalizedName) return null;

  return {
    id: id && /^t5_/.test(id) ? id : null,
    name: normalizedName,
    title: truncate(title, 160),
    subscribers,
    description: truncate(description, 260),
    url: firstRecordString(record, "url", "permalink") || `/r/${normalizedName}`,
  };
}

function collectCommunitySignals(calls: readonly TikHubCall[], maxItems: number): CommunitySignal[] {
  const communities: CommunitySignal[] = [];
  const seen = new Set<string>();

  for (const call of calls) {
    if (call.error) continue;
    for (const record of collectRecords(payloadOf(call), 8)) {
      const community = recordToCommunitySignal(record);
      if (!community) continue;
      const key = community.id || community.name?.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      communities.push(community);
      if (communities.length >= maxItems) return communities;
    }
  }

  return communities;
}

function recordToQuerySignal(record: Record<string, unknown>): QuerySignal | null {
  const text = firstRecordString(
    record,
    "query",
    "term",
    "text",
    "title",
    "name",
    "displayText",
    "display_text",
  );
  if (!text || text.length < 2 || /^t[135]_/.test(text)) return null;
  const kind = firstRecordString(record, "type", "kind", "search_type", "result_type");
  const score = firstRecordNumber(record, "score", "rank", "count", "popularity");
  const looksLikeSuggestion =
    Boolean(firstRecordString(record, "query", "term", "displayText", "display_text")) ||
    /search|trend|suggest|typeahead|query/i.test(kind || "");

  if (!looksLikeSuggestion) return null;

  return { text: truncate(text, 140) || text, kind, score };
}

function collectQuerySignals(calls: readonly TikHubCall[], maxItems: number): QuerySignal[] {
  const signals: QuerySignal[] = [];
  const seen = new Set<string>();

  for (const call of calls) {
    if (call.error) continue;
    for (const record of collectRecords(payloadOf(call), 8)) {
      const signal = recordToQuerySignal(record);
      if (!signal) continue;
      const key = signal.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      signals.push(signal);
      if (signals.length >= maxItems) return signals;
    }
  }

  return signals;
}

function formatCommentHighlight(comment: CommentHighlight, index: number): string {
  const parts = [
    comment.id ? `ID: ${comment.id}` : null,
    comment.author ? `u/${comment.author.replace(/^u\//, "")}` : null,
    comment.subreddit ? `r/${comment.subreddit.replace(/^r\//, "")}` : null,
    comment.score !== null ? `${comment.score} pts` : null,
  ].filter(Boolean);

  const lines = [`${index}. ${parts.length ? `${parts.join(" | ")} — ` : ""}"${comment.text}"`];
  if (comment.permalink) {
    lines.push(
      `   URL: ${comment.permalink.startsWith("http") ? comment.permalink : `https://reddit.com${comment.permalink}`}`,
    );
  }
  return lines.join("\n");
}

function formatCommunitySignal(community: CommunitySignal, index: number): string {
  const parts = [
    community.id ? `ID: ${community.id}` : null,
    community.subscribers !== null ? `${community.subscribers} subscribers` : null,
  ].filter(Boolean);
  const name = community.name ? `r/${community.name.replace(/^r\//, "")}` : "unknown subreddit";
  const lines = [`${index}. **${name}**${parts.length ? ` — ${parts.join(" | ")}` : ""}`];
  if (community.title) lines.push(`   Title: ${community.title}`);
  if (community.description) lines.push(`   Description: ${community.description}`);
  if (community.url) {
    lines.push(
      `   URL: ${community.url.startsWith("http") ? community.url : `https://reddit.com${community.url.startsWith("/") ? community.url : `/${community.url}`}`}`,
    );
  }
  return lines.join("\n");
}

function formatQuerySignal(signal: QuerySignal, index: number): string {
  const parts = [
    signal.kind ? `kind: ${signal.kind}` : null,
    signal.score !== null ? `score/count: ${signal.score}` : null,
  ].filter(Boolean);
  return `${index}. ${signal.text}${parts.length ? ` (${parts.join("; ")})` : ""}`;
}

function classifyCalls(calls: readonly TikHubCall[]): ClassifiedCall[] {
  return calls.map((call) => {
    const usefulCandidates = call.error ? 0 : collectCandidates([call], 5).length;
    const usefulComments = call.error ? 0 : collectCommentHighlights([call], 5).length;
    const communities = call.error ? 0 : collectCommunitySignals([call], 5).length;
    const queries = call.error ? 0 : collectQuerySignals([call], 5).length;
    return {
      ...call,
      usefulRecords: usefulCandidates + usefulComments + communities + queries,
      usefulCandidates,
      usefulComments,
    };
  });
}

function extractSubredditId(calls: readonly TikHubCall[]): string | null {
  for (const call of calls) {
    if (call.error) continue;
    const ids = collectStringsByKey(payloadOf(call), /(^id$|subreddit.*id|name)/i, /^t5_[A-Za-z0-9_]+$/);
    if (ids.length > 0) return ids[0];
  }
  return null;
}

function extractReplyCursors(calls: readonly TikHubCall[], maxCursors: number): string[] {
  const cursors = new Set<string>();
  for (const call of calls) {
    if (call.error) continue;
    if (!/(^post comments|collapsed replies)/i.test(call.label)) continue;
    for (const cursor of collectStringsByKey(payloadOf(call), /cursor/i, /[A-Za-z0-9:_-]{8,}/)) {
      cursors.add(cursor);
      if (cursors.size >= maxCursors) return Array.from(cursors);
    }
  }
  return Array.from(cursors);
}

function formatCandidate(candidate: Candidate, index: number): string {
  const parts = [
    candidate.subreddit ? `r/${candidate.subreddit.replace(/^r\//, "")}` : null,
    candidate.author ? `u/${candidate.author.replace(/^u\//, "")}` : null,
    candidate.score !== null ? `${candidate.score} pts` : null,
    candidate.comments !== null ? `${candidate.comments} comments` : null,
  ].filter(Boolean);

  const lines = [
    `${index}. **${candidate.title || candidate.id || "Untitled item"}**${parts.length ? ` — ${parts.join(" | ")}` : ""}`,
  ];
  if (candidate.id) lines.push(`   ID: ${candidate.id}`);
  if (candidate.url) {
    lines.push(
      `   URL: ${candidate.url.startsWith("http") ? candidate.url : `https://reddit.com${candidate.url}`}`,
    );
  }
  if (candidate.sourceUrl) lines.push(`   Linked source: ${candidate.sourceUrl}`);
  if (candidate.snippet && candidate.snippet !== candidate.title) {
    lines.push(`   Snippet: ${candidate.snippet}`);
  }
  return lines.join("\n");
}

function runCall(
  label: string,
  endpoint: string,
  rawParams: Record<string, string | number | boolean | undefined>,
  headers: Record<string, string>,
  ctx: Pick<ActionContext, "signal" | "keep">,
): Effect.Effect<TikHubCall, never, PaidHttp> {
  return Effect.gen(function* () {
    const params = { ...rawParams };
    const notes: string[] = [];
    if (endpoint.endsWith("/fetch_news_feed")) {
      notes.push("Organic news post groups only; promoted ad groups and presentation widgets are excluded.");
    }
    if (endpoint.endsWith("/fetch_dynamic_search")) {
      const type = params.search_type;
      if (type !== "post" && type !== "media" && params.time_range !== undefined) {
        notes.push(`Unsupported time_range=${String(params.time_range)} for ${String(type)}; not sent.`);
        delete params.time_range;
      }
      if ((type === "community" || type === "people") && params.sort !== undefined) {
        notes.push(`Unsupported sort=${String(params.sort)} for ${String(type)}; not sent.`);
        delete params.sort;
      } else if (type !== "post" && params.sort === "COMMENTS") {
        notes.push(`Unsupported COMMENTS sort for ${String(type)}; not sent (provider default ordering).`);
        delete params.sort;
      }
    }

    if (ctx.signal.aborted) {
      return {
        label,
        endpoint,
        params,
        notes,
        cancelled: true,
        error: "TikHub Reddit cancelled",
      };
    }

    const res = yield* tikhubRequest({
      path: endpoint,
      method: "GET",
      params,
      headers,
      ctx,
      label: endpoint,
    });

    if (!res.ok) {
      if (res.cancelled) {
        return { label, endpoint, params, notes, cancelled: true, error: res.error };
      }
      const errText =
        res.status === undefined
          ? `${res.error}. TikHub may have received and charged this request, but no complete response arrived; its cost is unknown.`
          : `TikHub ${res.status}: ${safeJsonSnippet(res.payload ?? res.error, 500)}`;
      return {
        label,
        endpoint,
        params,
        notes,
        error: redactText(errText, knownSecrets()),
      };
    }

    const envelope = asRecord(res.payload);
    if (!envelope) {
      return {
        label,
        endpoint,
        params,
        notes,
        error: "TikHub returned a non-object JSON response",
      };
    }
    if (envelope.code !== undefined && envelope.code !== 200 && envelope.code !== 0) {
      return {
        label,
        endpoint,
        params,
        notes,
        error: redactText(
          `TikHub returned code ${String(envelope.code)}: ${firstString(envelope.message) ?? "request failed"}`,
          knownSecrets(),
        ),
      };
    }
    return { label, endpoint, params, data: res.payload, notes };
  });
}

function need(value: string | undefined, message: string): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string } {
  const trimmed = value?.trim();
  if (!trimmed) return { ok: false, error: message };
  return { ok: true, value: trimmed };
}

function withPostKind(id: string): string {
  return /^t3_/i.test(id) ? id : `t3_${id}`;
}

function normalizeSort<T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  fallback: T[number],
): { readonly ok: true; readonly value: T[number] } | { readonly ok: false; readonly error: string } {
  const normalized = value?.trim().toUpperCase();
  if (normalized && !(allowed as readonly string[]).includes(normalized)) {
    return { ok: false, error: `Unsupported sort ${value}; expected ${allowed.join(", ")}` };
  }
  return { ok: true, value: (normalized || fallback) as T[number] };
}

function buildCalls(
  args: ToolArgs,
  headers: Record<string, string>,
  ctx: Pick<ActionContext, "signal" | "keep">,
): Effect.Effect<{ readonly ok: true; readonly calls: TikHubCall[] } | { readonly ok: false; readonly cancelled?: boolean; readonly error: string }, never, PaidHttp> {
  return Effect.gen(function* () {
    const needFormat = args.needFormat ?? true;
    const allowNsfw = args.allowNsfw ? 1 : 0;
    const calls: TikHubCall[] = [];

    const pushCall = (
      label: string,
      endpoint: string,
      params: Record<string, string | number | boolean | undefined>,
    ): Effect.Effect<boolean, never, PaidHttp> =>
      Effect.gen(function* () {
        const res = yield* runCall(label, endpoint, params, headers, ctx);
        calls.push(res);
        return Boolean(res.cancelled);
      });

    // Resolve sort before any paid HTTP call so an unsupported sort never follows paid calls.
    let sort: string | undefined;
    if (args.operation === "discovery_bundle" || args.operation === "query_scout") {
      const s = normalizeSort(args.sort, SEARCH_SORT_VALUES, "RELEVANCE");
      if (!s.ok) return s;
      sort = s.value;
    } else if (args.operation === "deep_thread" || args.operation === "thread_intelligence") {
      const s = normalizeSort(args.sort, COMMENT_SORT_VALUES, "CONFIDENCE");
      if (!s.ok) return s;
      sort = s.value;
    } else if (args.operation === "author_context" && (args.includeUserHistory ?? true)) {
      const s = normalizeSort(args.sort, ["NEW", "TOP", "HOT", "CONTROVERSIAL"] as const, "NEW");
      if (!s.ok) return s;
      sort = s.value;
    } else if (
      args.operation === "subreddit_context" ||
      (args.operation === "feed_discovery" && (args.feed ?? "popular") !== "news")
    ) {
      const s = normalizeSort(
        args.sort,
        FEED_SORT_VALUES,
        args.operation === "feed_discovery" && args.feed === "subreddit_channels" ? "HOT" : "BEST",
      );
      if (!s.ok) return s;
      sort = s.value;
    }

    const cancelledResult = {
      ok: false as const,
      cancelled: true,
      error: "TikHub Reddit cancelled; cancellation is not provider failure or evidence absence.",
    };

    if (args.operation === "discovery_bundle") {
      const q = need(args.query, "query is required for discovery_bundle");
      if (!q.ok) return q;
      if (
        yield* pushCall("typeahead", "/api/v1/reddit/app/fetch_search_typeahead", {
          query: q.value,
          safe_search: "unset",
          allow_nsfw: allowNsfw,
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }
      if (
        yield* pushCall("dynamic post search", "/api/v1/reddit/app/fetch_dynamic_search", {
          query: q.value,
          search_type: "post",
          sort,
          time_range: args.timeRange ?? "month",
          safe_search: "unset",
          allow_nsfw: allowNsfw,
          after: args.after,
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }
      if (
        yield* pushCall("dynamic community search", "/api/v1/reddit/app/fetch_dynamic_search", {
          query: q.value,
          search_type: "community",
          safe_search: "unset",
          allow_nsfw: allowNsfw,
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }
      if (
        yield* pushCall("dynamic comment search", "/api/v1/reddit/app/fetch_dynamic_search", {
          query: q.value,
          search_type: "comment",
          sort,
          safe_search: "unset",
          allow_nsfw: allowNsfw,
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }
      if (
        yield* pushCall("trending searches", "/api/v1/reddit/app/fetch_trending_searches", {
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }

      if (args.includeSubredditContext ?? true) {
        for (const community of collectCommunitySignals(calls, 3)) {
          if (!community.name) continue;
          if (
            yield* pushCall(`context r/${community.name}`, "/api/v1/reddit/app/fetch_subreddit_info", {
              subreddit_name: community.name,
              need_format: needFormat,
            })
          ) {
            return cancelledResult;
          }
          if (
            yield* pushCall(`feed r/${community.name}`, "/api/v1/reddit/app/fetch_subreddit_feed", {
              subreddit_name: community.name,
              sort: "BEST",
              need_format: needFormat,
            })
          ) {
            return cancelledResult;
          }
        }
      }

      if (args.includeBatchEnrich ?? true) {
        const postIds = Array.from(
          new Set(
            calls.flatMap((c) =>
              collectStringsByKey(payloadOf(c), /(^id$|name|post.*id|thing_id)/i, /^t3_[A-Za-z0-9_]+$/),
            ),
          ),
        ).slice(0, 5);
        if (postIds.length > 0) {
          if (
            yield* pushCall("discovery batch post details", "/api/v1/reddit/app/fetch_post_details_batch", {
              post_ids: postIds.join(","),
              need_format: needFormat,
            })
          ) {
            return cancelledResult;
          }
        }
      }

      return { ok: true as const, calls };
    }

    if (args.operation === "query_scout") {
      const q = need(args.query, "query is required for query_scout");
      if (!q.ok) return q;
      if (
        yield* pushCall("typeahead", "/api/v1/reddit/app/fetch_search_typeahead", {
          query: q.value,
          safe_search: "unset",
          allow_nsfw: allowNsfw,
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }
      if (
        yield* pushCall(
          args.searchType === "comment" ? "dynamic comment search" : "dynamic search",
          "/api/v1/reddit/app/fetch_dynamic_search",
          {
            query: q.value,
            search_type: args.searchType ?? "post",
            sort,
            time_range: args.timeRange ?? "month",
            safe_search: "unset",
            allow_nsfw: allowNsfw,
            after: args.after,
            need_format: needFormat,
          },
        )
      ) {
        return cancelledResult;
      }
      if (
        yield* pushCall("trending searches", "/api/v1/reddit/app/fetch_trending_searches", {
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }
      return { ok: true as const, calls };
    }

    if (args.operation === "subreddit_context") {
      const sub = need(args.subredditName, "subredditName is required for subreddit_context");
      if (!sub.ok) return sub;
      const subredditName = sub.value.replace(/^r\//, "");
      if (
        yield* pushCall("subreddit info", "/api/v1/reddit/app/fetch_subreddit_info", {
          subreddit_name: subredditName,
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }
      if (args.includeStyle ?? true) {
        if (
          yield* pushCall("subreddit style/rules", "/api/v1/reddit/app/fetch_subreddit_style", {
            subreddit_name: subredditName,
            need_format: needFormat,
          })
        ) {
          return cancelledResult;
        }
      }
      if (
        yield* pushCall("subreddit feed", "/api/v1/reddit/app/fetch_subreddit_feed", {
          subreddit_name: subredditName,
          sort,
          after: args.after,
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }
      const subredditId = args.subredditId || extractSubredditId(calls);
      if (subredditId && (args.includeSettings ?? true)) {
        if (
          yield* pushCall("subreddit settings", "/api/v1/reddit/app/fetch_subreddit_settings", {
            subreddit_id: subredditId,
            need_format: needFormat,
          })
        ) {
          return cancelledResult;
        }
      }
      if (subredditId && (args.includeHighlights ?? true)) {
        if (
          yield* pushCall("community highlights", "/api/v1/reddit/app/fetch_community_highlights", {
            subreddit_id: subredditId,
            need_format: needFormat,
          })
        ) {
          return cancelledResult;
        }
      }
      return { ok: true as const, calls };
    }

    if (args.operation === "deep_thread") {
      const pid = need(args.postId, "postId is required for deep_thread");
      if (!pid.ok) return pid;
      const postId = withPostKind(pid.value);
      if (
        yield* pushCall("post details", "/api/v1/reddit/app/fetch_post_details", {
          post_id: postId,
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }
      if (
        yield* pushCall("post comments", "/api/v1/reddit/app/fetch_post_comments", {
          post_id: postId,
          sort_type: sort,
          after: args.after,
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }
      if (args.includeReplies ?? true) {
        const maxReplyCursors = Math.min(Math.max(args.maxReplyCursors ?? 3, 0), 8);
        for (const cursor of extractReplyCursors(calls, maxReplyCursors)) {
          if (
            yield* pushCall(`collapsed replies ${calls.length}`, "/api/v1/reddit/app/fetch_comment_replies", {
              post_id: postId,
              cursor,
              sort_type: sort,
              need_format: needFormat,
            })
          ) {
            return cancelledResult;
          }
        }
      }
      return { ok: true as const, calls };
    }

    if (args.operation === "thread_intelligence") {
      const postIds = (args.postIds && args.postIds.length > 0 ? [...args.postIds] : args.postId ? [args.postId] : [])
        .map((id) => id.trim())
        .filter(Boolean)
        .map(withPostKind);
      if (postIds.length === 0) {
        return { ok: false as const, error: "postIds or postId is required for thread_intelligence" };
      }
      const maxReplyCursors = Math.min(Math.max(args.maxReplyCursors ?? 2, 0), 5);
      for (const postId of postIds) {
        const before = calls.length;
        if (
          yield* pushCall(`post details ${postId}`, "/api/v1/reddit/app/fetch_post_details", {
            post_id: postId,
            need_format: needFormat,
          })
        ) {
          return cancelledResult;
        }
        if (
          yield* pushCall(`post comments ${postId}`, "/api/v1/reddit/app/fetch_post_comments", {
            post_id: postId,
            sort_type: sort,
            need_format: needFormat,
          })
        ) {
          return cancelledResult;
        }
        if (args.includeReplies ?? true) {
          const postCalls = calls.slice(before);
          for (const cursor of extractReplyCursors(postCalls, maxReplyCursors)) {
            if (
              yield* pushCall(`collapsed replies ${postId}`, "/api/v1/reddit/app/fetch_comment_replies", {
                post_id: postId,
                cursor,
                sort_type: sort,
                need_format: needFormat,
              })
            ) {
              return cancelledResult;
            }
          }
        }
      }
      return { ok: true as const, calls };
    }

    if (args.operation === "author_context") {
      const u = need(args.username, "username is required for author_context");
      if (!u.ok) return u;
      const username = u.value.replace(/^u\//, "");
      if (
        yield* pushCall("user profile", "/api/v1/reddit/app/fetch_user_profile", {
          username,
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }
      if (
        yield* pushCall("active subreddits", "/api/v1/reddit/app/fetch_user_active_subreddits", {
          username,
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }
      if (args.includeUserHistory ?? true) {
        if (
          yield* pushCall("user posts", "/api/v1/reddit/app/fetch_user_posts", {
            username,
            sort,
            after: args.afterTarget === "user_posts" ? args.after : undefined,
            need_format: needFormat,
          })
        ) {
          return cancelledResult;
        }
        if (
          yield* pushCall("user comments", "/api/v1/reddit/app/fetch_user_comments", {
            username,
            sort,
            page_size: 25,
            after: args.afterTarget === "user_comments" ? args.after : undefined,
            need_format: needFormat,
          })
        ) {
          return cancelledResult;
        }
      }
      return { ok: true as const, calls };
    }

    if (args.operation === "batch_enrich") {
      const postIds = (args.postIds ?? []).map((id) => id.trim()).filter(Boolean);
      if (postIds.length === 0) {
        return { ok: false as const, error: "postIds is required for batch_enrich" };
      }
      const endpoint =
        postIds.length > 5
          ? "/api/v1/reddit/app/fetch_post_details_batch_large"
          : "/api/v1/reddit/app/fetch_post_details_batch";
      if (
        yield* pushCall(postIds.length > 5 ? "large batch post details" : "batch post details", endpoint, {
          post_ids: postIds.join(","),
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }
      return { ok: true as const, calls };
    }

    // feed_discovery
    const feed = args.feed ?? "popular";
    if (feed === "popular") {
      if (
        yield* pushCall("popular feed", "/api/v1/reddit/app/fetch_popular_feed", {
          sort,
          time: args.timeRange?.toUpperCase() ?? "ALL",
          after: args.after,
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }
    } else if (feed === "news") {
      if (
        yield* pushCall("news feed", "/api/v1/reddit/app/fetch_news_feed", {
          subtopic_ids: "all",
          after: args.after,
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }
    } else if (feed === "subreddit") {
      const sub = need(args.subredditName, "subredditName is required for subreddit feed discovery");
      if (!sub.ok) return sub;
      if (
        yield* pushCall("subreddit feed", "/api/v1/reddit/app/fetch_subreddit_feed", {
          subreddit_name: sub.value.replace(/^r\//, ""),
          sort,
          after: args.after,
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }
    } else {
      const sub = need(
        args.subredditName,
        "subredditName is required for subreddit channel feed discovery",
      );
      if (!sub.ok) return sub;
      if (
        yield* pushCall("subreddit post channels", "/api/v1/reddit/app/fetch_subreddit_post_channels", {
          subreddit_name: sub.value.replace(/^r\//, ""),
          sort,
          range: args.timeRange?.toUpperCase() ?? "DAY",
          need_format: needFormat,
        })
      ) {
        return cancelledResult;
      }
    }
    return { ok: true as const, calls };
  });
}

function formatOutput(args: ToolArgs, calls: readonly TikHubCall[]): string {
  const maxItems = Math.min(Math.max(args.maxItems ?? DEFAULT_MAX_ITEMS, 1), MAX_MAX_ITEMS);
  const classified = classifyCalls(calls);
  const querySignals = collectQuerySignals(calls, maxItems);
  const communities = collectCommunitySignals(calls, maxItems);
  const candidates = collectCandidates(calls, maxItems);
  const commentHighlights = collectCommentHighlights(calls, Math.min(maxItems, 12));
  const successCount = calls.filter((call) => !call.error).length;
  const failedCalls = calls.filter((call) => call.error);
  const thin = classified.filter((call) => !call.error && call.usefulRecords === 0);
  const postIds = Array.from(
    new Set(
      calls.flatMap((call) =>
        collectStringsByKey(payloadOf(call), /(^id$|name|post.*id|thing_id)/i, /^t3_[A-Za-z0-9_]+$/),
      ),
    ),
  ).slice(0, 20);
  const subredditIds = Array.from(
    new Set(
      calls.flatMap((call) =>
        collectStringsByKey(payloadOf(call), /(^id$|name|subreddit.*id)/i, /^t5_[A-Za-z0-9_]+$/),
      ),
    ),
  ).slice(0, 12);
  const replyCursors = extractReplyCursors(calls, 10);

  const lines: string[] = [];
  if (successCount === 0) {
    lines.push("ERROR: All TikHub Reddit endpoint calls failed; see per-call diagnostics below.", "");
  }
  lines.push(`# TikHub Reddit ${args.operation}`);
  lines.push("");
  lines.push(`Calls: ${successCount}/${calls.length} succeeded`);
  lines.push(
    `Useful records: ${classified.reduce((total, call) => total + call.usefulRecords, 0)} extracted (${thin.length} thin successful calls)`,
  );
  lines.push(`TikHub base: ${tikhubBaseUrl()}`);
  lines.push(
    `Display cap: ${maxItems} per evidence section, ${Math.min(maxItems, 12)} for Comment Highlights (never more than 12); raw excerpts are truncated, not a complete dataset.`,
  );
  lines.push("");

  const notes = calls.flatMap((call) => (call.notes ?? []).map((note) => `${call.label}: ${note}`));
  if (
    args.timeRange !== undefined &&
    !calls.some((call) => ["time_range", "time", "range"].some((key) => call.params[key] !== undefined))
  ) {
    notes.push(`Unsupported timeRange for ${args.operation}/${args.feed ?? ""}; not applied.`);
  }
  if (
    args.sort !== undefined &&
    !calls.some((call) => call.params.sort !== undefined || call.params.sort_type !== undefined)
  ) {
    notes.push(`Unsupported sort for ${args.operation}/${args.feed ?? ""}; not applied.`);
  }
  if (args.after !== undefined && !calls.some((call) => call.params.after === args.after)) {
    notes.push("Unsupported after cursor for this operation; not applied.");
  }
  if (args.allowNsfw !== undefined && !calls.some((call) => call.params.allow_nsfw !== undefined)) {
    notes.push("Unsupported allowNsfw for this operation; not applied.");
  }
  if (args.searchType !== undefined && args.operation !== "query_scout") {
    notes.push("searchType applies only to query_scout; not applied.");
  }
  if (args.afterTarget !== undefined && args.operation !== "author_context") {
    notes.push("afterTarget applies only to author_context; not applied.");
  }

  const optionOperations: Partial<Record<keyof ToolArgs, readonly Operation[]>> = {
    includeSettings: ["subreddit_context"],
    includeStyle: ["subreddit_context"],
    includeHighlights: ["subreddit_context"],
    includeSubredditContext: ["discovery_bundle"],
    includeBatchEnrich: ["discovery_bundle"],
    includeUserHistory: ["author_context"],
    includeReplies: ["deep_thread", "thread_intelligence"],
    maxReplyCursors: ["deep_thread", "thread_intelligence"],
    feed: ["feed_discovery"],
  };
  for (const [option, operations] of Object.entries(optionOperations)) {
    if (
      operations &&
      Object.prototype.hasOwnProperty.call(args, option) &&
      (args as unknown as Record<string, unknown>)[option] !== undefined &&
      !operations.includes(args.operation)
    ) {
      notes.push(`${option} is unsupported for ${args.operation}; not applied.`);
    }
  }
  if (args.operation === "thread_intelligence" && (args.maxReplyCursors ?? 0) > 5) {
    notes.push("thread_intelligence caps maxReplyCursors at 5 per post.");
  }
  if (args.operation === "discovery_bundle") {
    notes.push(
      "Bundle filters/cursor apply to post search; comment/community searches and contextual feeds have separate coverage.",
    );
  }
  if (notes.length) lines.push("## Filter / Coverage Notes", ...notes.map((note) => `- ${note}`), "");

  lines.push("## Endpoint Calls");
  lines.push("| Label | Endpoint | Status | Key Params |");
  lines.push("|---|---|---|---|");
  for (const call of calls) {
    const params = Object.entries(call.params)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("; ");
    lines.push(
      `| ${call.label} | \`${call.endpoint}\` | ${call.error ? "failed" : "ok"} | ${params.replace(/\|/g, "\\|")} |`,
    );
  }
  lines.push("");

  if (failedCalls.length > 0) {
    lines.push("## Call Failures");
    for (const call of failedCalls) {
      lines.push(`- ${call.label}: ${call.error}`);
    }
    lines.push("");
  }

  if (thin.length > 0) {
    lines.push("## Thin Successful Calls");
    for (const call of thin) {
      lines.push(
        `- ${call.label}: request succeeded but no query/community/post/comment records were confidently extracted.`,
      );
    }
    lines.push("");
  }

  if (querySignals.length > 0) {
    lines.push("## Query Suggestions");
    querySignals.forEach((signal, index) => lines.push(formatQuerySignal(signal, index + 1)));
    lines.push("");
  }

  if (communities.length > 0) {
    lines.push("## Candidate Communities");
    communities.forEach((community, index) => lines.push(formatCommunitySignal(community, index + 1)));
    lines.push("");
  }

  if (candidates.length > 0) {
    lines.push("## Candidate Posts / Items");
    candidates.forEach((candidate, index) => lines.push(formatCandidate(candidate, index + 1)));
    lines.push("");
  }

  if (commentHighlights.length > 0) {
    lines.push("## Comment Highlights");
    commentHighlights.forEach((comment, index) =>
      lines.push(formatCommentHighlight(comment, index + 1)),
    );
    lines.push("");
  }

  lines.push("## Follow-Up Handles");
  const followUpPostIds = Array.from(
    new Set([
      ...postIds,
      ...candidates.flatMap((candidate) => (candidate.id?.startsWith("t3_") ? [candidate.id] : [])),
    ]),
  );
  lines.push(
    `- Post IDs: ${followUpPostIds.length ? followUpPostIds.map((id) => `\`${id}\``).join(", ") : "none surfaced"}`,
  );
  lines.push(
    `- Subreddit IDs: ${subredditIds.length ? subredditIds.map((id) => `\`${id}\``).join(", ") : "none surfaced"}`,
  );
  lines.push(
    `- Reply cursors: ${replyCursors.length ? replyCursors.slice(0, 5).map((cursor) => `\`${cursor}\``).join(", ") : "none surfaced"}`,
  );
  for (const call of calls) {
    if (call.error) continue;
    const envelope = asRecord(call.data);
    const cursors = collectStringsByKey(
      envelope?.data ?? call.data,
      /^(after|endCursor|end_cursor|next_cursor|nextCursor)$/i,
      /[\s\S]+/,
    );
    if (cursors.length) {
      lines.push(
        `- Listing pagination for ${call.label} (${call.endpoint}): ${JSON.stringify(cursors)}. Reuse only for this listing, keeping its query/filter context.`,
      );
    }
  }
  lines.push(
    "- Collapsed replies are bounded by maxReplyCursors; surfaced cursors do not prove the entire tree was completed.",
  );
  lines.push("");

  lines.push("## Raw Response Samples");
  for (const call of calls.filter((item) => !item.error).slice(0, 6)) {
    lines.push(`### ${call.label}`);
    lines.push("```json");
    lines.push(safeJsonSnippet(payloadOf(call), 2200));
    lines.push("```");
  }

  return lines.join("\n");
}

const TikHubRedditSchema = Schema.Struct({
  operation: Schema.Literals(OPERATION_VALUES).annotate({
    description: "High-level TikHub Reddit operation.",
  }),
  query: Schema.optionalKey(Schema.String).annotate({
    description: "Search query for query_scout/discovery_bundle.",
  }),
  searchType: Schema.optionalKey(Schema.Literals(SEARCH_TYPE_VALUES)).annotate({
    description: "Dynamic search type; query_scout only.",
  }),
  sort: Schema.optionalKey(Schema.String).annotate({
    description:
      "Operation-specific sort: search RELEVANCE/HOT/TOP/NEW/COMMENTS (COMMENTS posts only); feeds include BEST/RISING/CONTROVERSIAL; comments CONFIDENCE/NEW/TOP/HOT/CONTROVERSIAL/OLD/RANDOM.",
  }),
  timeRange: Schema.optionalKey(Schema.Literals(TIME_RANGE_VALUES)).annotate({
    description:
      "Time range for post/media search and popular/channel feeds; unsupported combinations are reported.",
  }),
  subredditName: Schema.optionalKey(Schema.String).annotate({
    description: "Subreddit name, with or without r/.",
  }),
  subredditId: Schema.optionalKey(Schema.String).annotate({
    description: "Reddit subreddit fullname like t5_abc.",
  }),
  postId: Schema.optionalKey(Schema.String).annotate({
    description: "Reddit post fullname/id, usually t3_... .",
  }),
  postIds: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Post IDs: max 5 for thread_intelligence, max 30 for batch_enrich.",
  }),
  username: Schema.optionalKey(Schema.String).annotate({
    description: "Reddit username, with or without u/.",
  }),
  includeSettings: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Fetch subreddit settings when available (default: true).",
  }),
  includeStyle: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Fetch subreddit rules/style (default: true).",
  }),
  includeHighlights: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Fetch community highlights (default: true).",
  }),
  includeSubredditContext: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Fetch lightweight context/feed for surfaced communities (default: true).",
  }),
  includeBatchEnrich: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Batch-enrich surfaced post IDs when available (default: true).",
  }),
  includeUserHistory: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Fetch recent user posts/comments (default: true).",
  }),
  includeReplies: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Fetch bounded collapsed-reply cursors from the first comment page (default: true).",
  }),
  maxReplyCursors: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
  ).annotate({
    description:
      "Max collapsed reply cursors to complete (default: 3 for deep_thread; thread_intelligence defaults to 2 and caps at 5 per post).",
  }),
  feed: Schema.optionalKey(Schema.Literals(FEED_VALUES)).annotate({
    description: "Feed type for feed_discovery.",
  }),
  after: Schema.optionalKey(Schema.String).annotate({
    description:
      "Exact cursor returned for this listing; never reuse across independent listings.",
  }),
  afterTarget: Schema.optionalKey(Schema.Literals(AFTER_TARGET_VALUES)).annotate({
    description:
      "Required with after for author_context: select which independent listing owns the cursor.",
  }),
  allowNsfw: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Allow NSFW results where TikHub supports it.",
  }),
  maxItems: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_MAX_ITEMS })),
  ).annotate({
    description:
      "Max candidate items to format per evidence section (default: 10; Comment Highlights never more than 12), not a complete dataset.",
  }),
  needFormat: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Pass TikHub need_format flag (default: true).",
  }),
});

export const tikhubRedditAction = defineAction({
  name: "tikhub_reddit",
  description:
    "Use TikHub's native Reddit API surface for advanced Reddit discovery and enrichment: " +
    "discovery bundles with typeahead/search/trending/context, subreddit context cards, thread intelligence with collapsed replies, " +
    "author activity context, batch post enrichment, and feed/trend discovery. Requires TIKHUB_API_KEY.",
  schema: TikHubRedditSchema,
  // Billing omitted intentionally: TikHub does not report per-request cost, so cost is recorded as unknown (`null`).
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (!(OPERATION_VALUES as readonly string[]).includes(args.operation)) {
        return failed("TikHub Reddit failed: Unknown operation");
      }
      const headers = tikhubHeaders();
      if (!headers) {
        return failed(`TikHub Reddit failed: ${MISSING_TIKHUB_KEY}`);
      }
      if (args.searchType !== undefined && !(SEARCH_TYPE_VALUES as readonly string[]).includes(args.searchType)) {
        return failed("TikHub Reddit failed: Unknown searchType");
      }
      if (args.timeRange !== undefined && !(TIME_RANGE_VALUES as readonly string[]).includes(args.timeRange)) {
        return failed("TikHub Reddit failed: Unknown timeRange");
      }
      if (args.feed !== undefined && !(FEED_VALUES as readonly string[]).includes(args.feed)) {
        return failed("TikHub Reddit failed: Unknown feed");
      }
      if (args.afterTarget !== undefined && !(AFTER_TARGET_VALUES as readonly string[]).includes(args.afterTarget)) {
        return failed("TikHub Reddit failed: Unknown afterTarget");
      }
      if (args.after && args.operation === "author_context" && !args.afterTarget) {
        return failed(
          "TikHub Reddit failed: author_context pagination requires afterTarget=user_posts or user_comments; their cursors are not interchangeable",
        );
      }
      if (args.postIds && args.postIds.length > (args.operation === "thread_intelligence" ? 5 : 30)) {
        return failed(
          "TikHub Reddit failed: Too many postIds; thread_intelligence supports 5 and batch_enrich supports 30",
        );
      }

      const built = yield* buildCalls(args, headers, ctx);
      if (!built.ok) {
        if (built.cancelled || ctx.signal.aborted) {
          return outcome(
            "cancelled",
            "ERROR: TikHub Reddit cancelled; cancellation is not provider failure or evidence absence.",
          );
        }
        return failed(`TikHub Reddit failed: ${redactText(built.error, knownSecrets())}`);
      }

      const calls = built.calls;
      const text = redactText(formatOutput(args, calls), knownSecrets());
      const failedCount = calls.filter((call) => call.error).length;
      if (failedCount === calls.length) {
        return outcome("failed", text);
      }
      if (failedCount > 0) {
        return outcome("partial", text);
      }
      return outcome("success", text);
    }),
});

export const tikhubRedditSource: SourcePlugin = defineSource({
  id: "tikhub-reddit",
  group: "social",
  label: "TikHub Reddit",
  description: "Advanced Reddit discovery and enrichment",
  about:
    "Deeper Reddit research: query scouting, subreddit context, a thread's first page of comments with up to 8 collapsed-reply continuations per call, public author history and batch enrichment of posts.",
  providers: [TIKHUB_PROVIDER],
  billing: TIKHUB_BILLING,
  logo: "reddit",
  env: ["TIKHUB_API_KEY", "TIKHUB_BASE_URL"],
  keys: ["TIKHUB_API_KEY"],
  credential: "TIKHUB_API_KEY",
  actions: [tikhubRedditAction],
});

export default tikhubRedditSource;
