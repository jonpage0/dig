/**
 * China social source plugin (Effect 4.1.5):
 * - china_social_search: 7 mainland-China platforms (Xiaohongshu, Bilibili, Douyin, Weibo, Zhihu, Kuaishou, WeChat)
 *   via TikHub (`PaidHttp`, zero retries, unknown cost) plus optional explicit Just One API fallback.
 */
import { Effect, Result, Schema } from "effect";
import { paidRequest, type KeepRaw, type PaidHttp } from "../../core/http.ts";
import {
  defineAction,
  defineSource,
  failed,
  outcome,
  setOutsideChat,
  type ActionOutcome,
  type SourcePlugin,
} from "../../core/plugin.ts";
import { knownSecrets, redactText, redactValue } from "../../core/secrets.ts";
import {
  MISSING_TIKHUB_KEY,
  TIKHUB_BILLING,
  TIKHUB_PROVIDER,
  tikhubBaseUrl,
  tikhubHeaders as baseTikhubHeaders,
} from "../shared/tikhub.ts";

const CHINA_SOCIAL_PLATFORM_VALUES = [
  "xiaohongshu",
  "bilibili",
  "douyin",
  "weibo",
  "zhihu",
  "kuaishou",
  "wechat",
] as const;
const CHINA_SOCIAL_PROVIDER_VALUES = ["auto", "tikhub", "justone"] as const;
const CHINA_SOCIAL_SORT_VALUES = ["relevance", "latest", "hot"] as const;
const CHINA_SOCIAL_TIME_RANGE_VALUES = ["all", "day", "week", "month", "half_year"] as const;
const WEIBO_SEARCH_TYPE_VALUES = [
  "normal",
  "realtime",
  "hot",
  "original",
  "verified",
  "media",
  "viewpoint",
  "image",
  "video",
  "user",
  "topic",
] as const;
const WECHAT_VERTICAL_VALUES = [
  "all",
  "account",
  "article",
  "video",
  "sticker",
  "live_stream",
  "moments",
  "news",
  "book",
  "listen",
  "image",
  "encyclopedia",
  "weixin_index",
] as const;

type ChinaSocialPlatform = (typeof CHINA_SOCIAL_PLATFORM_VALUES)[number];
type ChinaSocialProviderId = (typeof CHINA_SOCIAL_PROVIDER_VALUES)[number];
type ActiveChinaSocialProviderId = Exclude<ChinaSocialProviderId, "auto">;
type ChinaSocialSort = (typeof CHINA_SOCIAL_SORT_VALUES)[number];
type ChinaSocialTimeRange = (typeof CHINA_SOCIAL_TIME_RANGE_VALUES)[number];
type WeiboSearchType = (typeof WEIBO_SEARCH_TYPE_VALUES)[number];
type WechatVertical = (typeof WECHAT_VERTICAL_VALUES)[number];
type SearchCursor =
  | string
  | { readonly search_id: string; readonly search_session_id: string }
  | { readonly cursor: number; readonly search_id: string; readonly backtrace: string };

interface SearchItem {
  readonly platform: ChinaSocialPlatform;
  readonly id?: string | null;
  readonly handles?: Record<string, string>;
  readonly title: string;
  readonly author: string | null;
  readonly summary: string | null;
  readonly url: string | null;
  readonly publishedAt: string | null;
  readonly views: number | null;
  readonly likes: number | null;
  readonly comments: number | null;
  readonly bulletComments?: number | null;
  readonly shares: number | null;
  readonly saves: number | null;
  readonly tags: string[];
}

interface PlatformSearchResult {
  readonly platform: ChinaSocialPlatform;
  readonly provider: ActiveChinaSocialProviderId;
  readonly endpoint: string;
  readonly items: SearchItem[];
  readonly returned: number;
  readonly notes: string[];
  readonly rawCount: number | null;
  readonly rawFallback: string | null;
  readonly httpStatus: number;
  readonly attempts: number;
  readonly durationMs: number;
  readonly requestId: string | null;
  readonly nextCursor: SearchCursor | null;
  readonly availability?: Record<string, unknown>;
}

interface PlatformSearchFailure {
  readonly platform: ChinaSocialPlatform;
  readonly provider: ActiveChinaSocialProviderId;
  readonly message: string;
}

interface ProviderJsonResult {
  readonly payload: Record<string, unknown>;
  readonly httpStatus: number;
  readonly attempts: number;
  readonly durationMs: number;
  readonly requestId: string | null;
}

interface ProviderSearchArgs {
  readonly query: string;
  readonly platform: ChinaSocialPlatform;
  readonly limit: number;
  readonly show: number;
  readonly page: number;
  readonly cursor: SearchCursor | null;
  readonly justoneStart?: string;
  readonly justoneEnd?: string;
  readonly sort: ChinaSocialSort;
  readonly timeRange: ChinaSocialTimeRange;
  readonly weiboSearchType: WeiboSearchType;
  readonly wechatVertical: WechatVertical;
  readonly signal: AbortSignal;
  readonly keep: KeepRaw;
}

const DEFAULT_PLATFORM_SLICE: readonly ChinaSocialPlatform[] = ["xiaohongshu", "bilibili", "douyin"];
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PAGE = 1;

const justoneBaseUrl = (): string => process.env.JUSTONE_BASE_URL?.trim() || "https://api.justoneapi.com";

function normalizeWhitespace(value: string | undefined | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return normalized || null;
}

function truncateText(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const normalized = normalizeWhitespace(value);
      if (normalized) return normalized;
    }
  }
  return null;
}

function opaqueString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
}

/** Quote large 16+ digit integer tokens before JSON.parse so provider IDs never round. */
function parseProviderJson(text: string): unknown {
  return JSON.parse(
    text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) =>
      /^-?\d{16,}$/.test(token) ? JSON.stringify(token) : token,
    ),
  );
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const cleaned = value.replace(/[^\d.-]/g, "").trim();
      if (!cleaned) continue;
      const parsed = Number(cleaned);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function uniqStrings(values: readonly (string | null | undefined)[]): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const normalized = normalizeWhitespace(value);
    if (normalized) deduped.add(normalized);
  }
  return Array.from(deduped);
}

function toIsoDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1_000_000_000_000 ? value : value * 1000;
    try {
      return new Date(millis).toISOString();
    } catch {
      return null;
    }
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{10,13}$/.test(trimmed)) return toIsoDate(Number(trimmed));
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? trimmed : new Date(parsed).toISOString();
}

function formatNumber(value: number | null): string | null {
  if (value === null) return null;
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toString();
}

function safeJsonSnippet(value: unknown, maxLength = 1400): string | null {
  try {
    const serialized = JSON.stringify(redactValue(value, knownSecrets()), null, 2) ?? "";
    if (!serialized) return null;
    return serialized.length <= maxLength ? serialized : `${serialized.slice(0, maxLength - 1).trimEnd()}…`;
  } catch {
    return null;
  }
}

function dedupeItems(items: SearchItem[]): SearchItem[] {
  const seen = new Set<string>();
  const deduped: SearchItem[] = [];
  for (const item of items) {
    const key = item.id
      ? `${item.platform}:${item.id}`
      : item.url || `${item.platform}:${item.title}:${item.author || "unknown"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function collectRecords(value: unknown, maxDepth = 6): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  function visit(current: unknown, depth: number) {
    if (depth > maxDepth) return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    const record = asRecord(current);
    if (!record) return;
    records.push(record);
    for (const nested of Object.values(record)) {
      if (Array.isArray(nested) || asRecord(nested)) visit(nested, depth + 1);
    }
  }
  visit(value, 0);
  return records;
}

const unansweredCost = (provider: string) =>
  `${provider} may have received and charged this request, but no complete response arrived; its cost is unknown.`;

function fetchTikHubJson(args: {
  readonly endpoint: string;
  readonly method?: "GET" | "POST";
  readonly query?: Record<string, string | number>;
  readonly body?: Record<string, unknown>;
  readonly signal: AbortSignal;
  readonly keep: KeepRaw;
}): Effect.Effect<
  { readonly ok: true; readonly data: ProviderJsonResult } | { readonly ok: false; readonly cancelled: boolean; readonly error: string },
  never,
  PaidHttp
> {
  return Effect.gen(function* () {
    const baseHeaders = baseTikhubHeaders();
    if (!baseHeaders) return { ok: false as const, cancelled: false, error: MISSING_TIKHUB_KEY };
    const headers = {
      ...baseHeaders,
      ...(args.body ? { "Content-Type": "application/json" } : {}),
    };
    const url = new URL(args.endpoint, tikhubBaseUrl());
    for (const [key, value] of Object.entries(args.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    const res = yield* Effect.result(
      paidRequest({
        url: url.href,
        method: args.method ?? "GET",
        headers,
        body: args.body,
        signal: args.signal,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        keep: args.keep,
        label: args.endpoint,
        parseJson: parseProviderJson,
      }),
    );
    if (Result.isFailure(res)) {
      if (args.signal.aborted) return { ok: false as const, cancelled: true, error: "cancelled" };
      const msg = res.failure instanceof Error ? res.failure.message : "Unknown error";
      return { ok: false as const, cancelled: false, error: `${msg}. ${unansweredCost("TikHub")}` };
    }
    const response = res.success;
    const record = asRecord(response.payload);
    if (response.status < 200 || response.status >= 300) {
      const detail = asRecord(record?.detail);
      const message =
        firstString(detail?.message, detail?.message_zh, record?.message, record?.message_zh) || "Unknown TikHub error";
      return { ok: false as const, cancelled: false, error: `TikHub returned ${response.status}: ${message}` };
    }
    if (!record) return { ok: false as const, cancelled: false, error: "TikHub returned a non-object JSON payload" };
    const code = firstNumber(record.code);
    if (code !== null && code >= 400) {
      const message = firstString(record.message, record.message_zh) || "Unknown TikHub error";
      return { ok: false as const, cancelled: false, error: message };
    }
    return {
      ok: true as const,
      data: {
        payload: record,
        httpStatus: response.status,
        attempts: 1,
        durationMs: response.durationMs,
        requestId: firstString(record.request_id) ?? response.requestId ?? null,
      },
    };
  });
}

function normalizeXiaohongshuItems(payload: Record<string, unknown>, limit: number): SearchItem[] {
  const records = collectRecords(payload.data ?? payload);
  const items = records.flatMap((record): SearchItem[] => {
    const note = asRecord(record.note) || asRecord(record.note_card) || asRecord(record.noteCard) || record;
    const user = asRecord(note.user) || asRecord(note.author);
    const interact = asRecord(note.interact_info) || asRecord(note.interactInfo);
    const noteId = firstString(note.note_id, note.noteId, note.id, record.note_id, record.id);
    const title = firstString(note.display_title, note.title, note.note_title);
    const summary = truncateText(firstString(note.desc, note.display_desc, note.content, title), 220);
    if (!noteId || !title) return [];
    return [
      {
        platform: "xiaohongshu",
        title,
        author: firstString(user?.nickname, user?.nick_name, user?.name),
        summary,
        url: `https://www.xiaohongshu.com/explore/${noteId}`,
        publishedAt: toIsoDate(note.time ?? note.timestamp ?? note.publish_time ?? note.last_update_time ?? note.update_time),
        views: firstNumber(interact?.view_count, note.view_count),
        likes: firstNumber(interact?.liked_count, note.liked_count, note.like_count),
        comments: firstNumber(interact?.comment_count, note.comment_count, note.comments_count),
        shares: firstNumber(interact?.share_count, note.share_count, note.shared_count),
        saves: firstNumber(interact?.collected_count, note.collected_count, note.favorite_count),
        tags: uniqStrings([
          firstString(asRecord(note.tag_info)?.title),
          ...asArray(note.tag_list).map((tag) => firstString(asRecord(tag)?.name, tag)),
        ]),
      },
    ];
  });
  return dedupeItems(items).slice(0, limit);
}

function normalizeBilibiliItems(payload: Record<string, unknown>, limit: number): SearchItem[] {
  const records = collectRecords(payload.data ?? payload);
  const items = records.flatMap((record): SearchItem[] => {
    const title = firstString(record.title);
    const bvid = firstString(record.bvid);
    const url =
      firstString(record.arcurl, record.url, record.share_url) ||
      (bvid ? `https://www.bilibili.com/video/${bvid}` : null);
    if (!title || !url) return [];
    return [
      {
        platform: "bilibili",
        title,
        author: firstString(record.author, record.up_name, record.uname),
        summary: truncateText(firstString(record.description, record.desc, asArray(record.hit_columns)[0]), 220),
        url,
        publishedAt: toIsoDate(record.pubdate ?? record.created),
        views: firstNumber(record.play, record.view),
        likes: firstNumber(record.like),
        comments: firstNumber(record.review),
        bulletComments: firstNumber(record.video_review),
        shares: firstNumber(record.share),
        saves: firstNumber(record.favorite, record.favorites),
        tags: uniqStrings([
          firstString(record.tag),
          firstString(record.typename),
          ...asArray(record.tags).map((tag) => firstString(asRecord(tag)?.tag_name, tag)),
        ]),
      },
    ];
  });
  return dedupeItems(items).slice(0, limit);
}

function normalizeDouyinItems(payload: Record<string, unknown>, limit: number): SearchItem[] {
  const records = collectRecords(payload.data ?? payload);
  const items = records.flatMap((record): SearchItem[] => {
    const aweme = asRecord(record.aweme_info) || asRecord(record.awemeInfo) || record;
    const author = asRecord(aweme.author);
    const statistics = asRecord(aweme.statistics);
    const awemeId = firstString(aweme.aweme_id, aweme.awemeId, record.aweme_id, record.id);
    const title = firstString(aweme.desc, aweme.title, aweme.text);
    if (!awemeId || !title) return [];
    return [
      {
        platform: "douyin",
        title,
        author: firstString(author?.nickname, author?.unique_id, author?.short_id),
        summary: truncateText(firstString(aweme.desc, aweme.preview_title, aweme.text), 220),
        url: `https://www.douyin.com/video/${awemeId}`,
        publishedAt: toIsoDate(aweme.create_time ?? aweme.publish_time),
        views: firstNumber(statistics?.play_count, aweme.play_count),
        likes: firstNumber(statistics?.digg_count, statistics?.like_count, aweme.like_count),
        comments: firstNumber(statistics?.comment_count, aweme.comment_count),
        shares: firstNumber(statistics?.share_count, aweme.share_count),
        saves: firstNumber(statistics?.collect_count, aweme.collect_count),
        tags: uniqStrings(
          asArray(aweme.text_extra).map((tag) =>
            firstString(asRecord(tag)?.hashtag_name, asRecord(tag)?.tag_name),
          ),
        ),
      },
    ];
  });
  return dedupeItems(items).slice(0, limit);
}

function normalizeWeiboItems(payload: Record<string, unknown>, limit: number): SearchItem[] {
  const records = collectRecords(payload.data ?? payload);
  const items = records.flatMap((record): SearchItem[] => {
    const post = asRecord(record.mblog) || asRecord(record.blog) || record;
    const user = asRecord(post.user) || asRecord(post.author);
    const pageInfo = asRecord(post.page_info) || asRecord(post.pageInfo);
    const rawText = firstString(post.text_raw, post.text, post.content, record.text_raw, record.text);
    const title = truncateText(firstString(record.title, post.title, rawText), 120);
    const postId = firstString(
      post.idstr,
      post.mblogid,
      post.mid,
      post.weibo_id,
      post.id,
      record.idstr,
      record.mblogid,
      record.mid,
      record.id,
    );
    const hasPostSignal =
      !!firstString(post.created_at, post.createdAt) ||
      firstNumber(post.attitudes_count, post.comments_count, post.reposts_count, pageInfo?.play_count) !== null;
    if (!postId || !title || (!hasPostSignal && !rawText)) return [];
    return [
      {
        platform: "weibo",
        title,
        author: firstString(user?.screen_name, user?.screenName, user?.name),
        summary: truncateText(rawText ?? firstString(post.source, record.desc), 220),
        url:
          firstString(post.scheme, post.url, pageInfo?.page_url, pageInfo?.url, record.url) ||
          `https://weibo.com/status/${postId}`,
        publishedAt: toIsoDate(post.created_at ?? post.createdAt),
        views: firstNumber(pageInfo?.play_count, pageInfo?.page_views, post.read_count, record.read_count),
        likes: firstNumber(post.attitudes_count, post.like_count),
        comments: firstNumber(post.comments_count, post.comment_count),
        shares: firstNumber(post.reposts_count, post.repost_count, post.share_count),
        saves: firstNumber(post.favorited_count, post.favorite_count),
        tags: uniqStrings([
          firstString(pageInfo?.object_type),
          ...asArray(post.topic_struct).map((topic) =>
            firstString(asRecord(topic)?.topic_title, asRecord(topic)?.title, asRecord(topic)?.topic_name, topic),
          ),
        ]),
      },
    ];
  });
  return dedupeItems(items).slice(0, limit);
}

function buildZhihuUrl(args: {
  readonly itemType: string | null;
  readonly itemId: string | null;
  readonly questionId: string | null;
  readonly explicitUrl: string | null;
}): string | null {
  if (args.explicitUrl) return args.explicitUrl;
  switch (args.itemType) {
    case "article":
      return args.itemId ? `https://zhuanlan.zhihu.com/p/${args.itemId}` : null;
    case "answer":
      return args.itemId && args.questionId
        ? `https://www.zhihu.com/question/${args.questionId}/answer/${args.itemId}`
        : args.questionId
          ? `https://www.zhihu.com/question/${args.questionId}`
          : null;
    case "question":
      return args.questionId || args.itemId
        ? `https://www.zhihu.com/question/${args.questionId ?? args.itemId}`
        : null;
    case "zvideo":
      return args.itemId ? `https://www.zhihu.com/zvideo/${args.itemId}` : null;
    default:
      return args.questionId
        ? `https://www.zhihu.com/question/${args.questionId}`
        : args.itemId
          ? `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(args.itemId)}`
          : null;
  }
}

function normalizeZhihuItems(payload: Record<string, unknown>, limit: number): SearchItem[] {
  const records = collectRecords(payload.data ?? payload);
  const supportedTypes = new Set(["answer", "article", "question", "zvideo"]);
  const nestedQuestions = new Set(
    records.flatMap((record) =>
      [record, asRecord(record.object), asRecord(record.target)]
        .map((holder) => asRecord(holder?.question))
        .filter((question): question is Record<string, unknown> => question !== null),
    ),
  );
  const items = records.flatMap((record): SearchItem[] => {
    if (nestedQuestions.has(record)) return [];
    const target = asRecord(record.object) || asRecord(record.target) || record;
    const question = asRecord(target.question) || asRecord(record.question);
    const author = asRecord(target.author) || asRecord(record.author);
    const itemType =
      firstString(target.type, target.object_type, record.type, record.object_type)?.toLowerCase() || null;
    if (itemType && !supportedTypes.has(itemType)) return [];
    const itemId = firstString(
      target.id,
      target.answer_id,
      target.article_id,
      target.zvideo_id,
      target.url_token,
      record.id,
      record.answer_id,
      record.article_id,
    );
    const questionId = firstString(question?.id, question?.question_id, target.question_id, record.question_id);
    const title =
      firstString(target.title, question?.name, question?.title, record.title, record.name) ||
      truncateText(firstString(target.excerpt, target.description, record.excerpt), 120);
    const explicitUrl = firstString(target.url, target.share_url, record.url);
    const url = buildZhihuUrl({ itemType, itemId, questionId, explicitUrl });
    if (!title || (!itemId && !url)) return [];
    return [
      {
        platform: "zhihu",
        title,
        author: firstString(author?.name, author?.headline),
        summary: truncateText(
          firstString(target.excerpt, target.description, target.content, record.excerpt, record.content),
          220,
        ),
        url,
        publishedAt: toIsoDate(target.created_time ?? target.created ?? target.updated_time ?? record.created_time),
        views: firstNumber(target.read_count, target.view_count, target.visits_count, record.read_count),
        likes: firstNumber(target.voteup_count, target.likes_count, target.like_count, record.voteup_count),
        comments: firstNumber(target.comment_count, target.comments_count, record.comment_count),
        shares: firstNumber(target.share_count, record.share_count),
        saves: firstNumber(target.favlists_count, target.favorite_count, record.favlists_count),
        tags: uniqStrings([
          itemType,
          ...asArray(target.topics ?? question?.topics ?? record.topics).map((topic) =>
            firstString(asRecord(topic)?.name, asRecord(topic)?.title, asRecord(topic)?.topic_name, topic),
          ),
        ]),
      },
    ];
  });
  return dedupeItems(items).slice(0, limit);
}

function extractRawCount(payload: Record<string, unknown>): number | null {
  const data = asRecord(payload.data);
  const paging = asRecord(data?.paging);
  const cardlistInfo = asRecord(data?.cardlistInfo);
  return firstNumber(
    payload.total,
    payload.total_number,
    data?.total,
    data?.count,
    data?.item_count,
    data?.cursor_count,
    paging?.totals,
    paging?.total,
    cardlistInfo?.total,
  );
}

function normalizeKuaishouItems(payload: Record<string, unknown>, limit: number): SearchItem[] {
  const data = asRecord(payload.data);
  const items = asArray(data?.mixFeeds).flatMap((entry): SearchItem[] => {
    const feed = asRecord(asRecord(entry)?.feed);
    if (!feed) return [];
    const shareInfo = firstString(feed.share_info);
    const shareParams = shareInfo ? new URLSearchParams(shareInfo) : null;
    const photoId = shareParams?.get("photoId") || firstString(feed.photo_id);
    const title = firstString(feed.caption, feed.captionToComment);
    if (!photoId || !title) return [];
    return [
      {
        platform: "kuaishou",
        title,
        author: firstString(feed.user_name),
        summary: truncateText(firstString(feed.caption, feed.captionToComment), 220),
        url: `https://www.kuaishou.com/short-video/${encodeURIComponent(photoId)}`,
        publishedAt: toIsoDate(feed.timestamp ?? feed.time),
        views: firstNumber(feed.view_count),
        likes: firstNumber(feed.like_count),
        comments: firstNumber(feed.comment_count),
        shares: firstNumber(feed.share_count),
        saves: null,
        tags: uniqStrings((title.match(/#[^#\s]+/g) ?? []).map((tag) => tag.slice(1))),
      },
    ];
  });
  return dedupeItems(items).slice(0, limit);
}

function normalizeCommonItems(
  payload: Record<string, unknown>,
  platform: ChinaSocialPlatform,
  limit: number,
): SearchItem[] {
  const records = collectRecords(payload.data ?? payload);
  const items = records.flatMap((record): SearchItem[] => {
    const author = asRecord(record.author ?? record.user ?? record.owner ?? record.account);
    const jump = asRecord(record.jumpInfo);
    const statistics = asRecord(record.statistics ?? record.stats ?? record.metrics);
    const title = firstString(
      record.title,
      record.name,
      record.nickname,
      record.screen_name,
      record.desc,
      record.description,
      record.text,
      record.content,
    );
    const id = opaqueString(
      record.docID,
      record.exportId,
      record.uid,
      record.id,
      record.note_id,
      record.aweme_id,
      record.aid,
      record.bvid,
      record.mid,
    );
    const url = firstString(record.url, record.link, record.share_url, record.web_url, record.jump_url, jump?.url);
    if (!title || (!id && !url)) return [];
    return [
      {
        platform,
        id,
        handles: Object.fromEntries(
          Object.entries({
            userName: opaqueString(jump?.userName),
            exportId: opaqueString(record.exportId),
            feedNonceId: opaqueString(asRecord(jump?.extInfo)?.feedNonceId),
          }).filter((entry): entry is [string, string] => entry[1] !== null),
        ),
        title,
        author: firstString(
          author?.name,
          author?.nickname,
          author?.screen_name,
          record.author_name,
          record.author,
          jump?.nickName,
          jump?.userName,
        ),
        summary: truncateText(
          firstString(record.summary, record.desc, record.description, record.text, record.content),
          220,
        ),
        url,
        publishedAt: toIsoDate(record.published_at ?? record.publish_time ?? record.created_at ?? record.create_time),
        views: firstNumber(statistics?.views, statistics?.view_count, record.views, record.view_count),
        likes: firstNumber(statistics?.likes, statistics?.like_count, record.likes, record.like_count),
        comments: firstNumber(statistics?.comments, statistics?.comment_count, record.comments, record.comment_count),
        shares: firstNumber(statistics?.shares, statistics?.share_count, record.shares, record.share_count),
        saves: firstNumber(
          statistics?.saves,
          statistics?.collect_count,
          record.saves,
          record.collect_count,
          record.favorite_count,
        ),
        tags: uniqStrings([
          firstString(record.accTypeName),
          ...asArray(record.tags ?? record.hashtags).map((tag) =>
            firstString(asRecord(tag)?.name, asRecord(tag)?.title, tag),
          ),
        ]),
      },
    ];
  });
  return dedupeItems(items).slice(0, limit);
}

function normalizePlatformItems(
  payload: Record<string, unknown>,
  platform: ChinaSocialPlatform,
  limit: number,
): SearchItem[] {
  switch (platform) {
    case "xiaohongshu":
      return normalizeXiaohongshuItems(payload, limit);
    case "bilibili":
      return normalizeBilibiliItems(payload, limit);
    case "douyin":
      return normalizeDouyinItems(payload, limit);
    case "weibo":
      return normalizeWeiboItems(payload, limit);
    case "zhihu":
      return normalizeZhihuItems(payload, limit);
    case "kuaishou":
      return normalizeKuaishouItems(payload, limit);
    case "wechat":
      return normalizeCommonItems(payload, platform, limit);
  }
}

function extractNextCursor(
  payload: Record<string, unknown>,
  search: ProviderSearchArgs,
  provider: ActiveChinaSocialProviderId,
): SearchCursor | null {
  const data = asRecord(payload.data);
  const nested = asRecord(data?.data);
  const business = asRecord(data?.business_config);
  const paging = asRecord(data?.paging);
  if (provider === "justone") return opaqueString(data?.nextCursor, payload.nextCursor);
  if (
    data?.has_more === false ||
    data?.has_more === 0 ||
    nested?.has_more === false ||
    nested?.has_more === 0 ||
    business?.has_more === false ||
    business?.has_more === 0
  ) {
    return null;
  }
  if (search.platform === "xiaohongshu") {
    const prior = asRecord(search.cursor);
    const search_id = opaqueString(nested?.search_id, data?.search_id, prior?.search_id);
    const search_session_id = opaqueString(nested?.search_session_id, data?.search_session_id, prior?.search_session_id);
    return search_id && search_session_id ? { search_id, search_session_id } : null;
  }
  if (search.platform === "douyin") {
    const nextPage = asRecord(business?.next_page);
    const cursor = nextPage?.cursor ?? nested?.cursor ?? data?.cursor;
    const search_id = opaqueString(nextPage?.search_id, nested?.search_id, data?.search_id);
    const backtrace = business?.backtrace ?? nested?.backtrace ?? data?.backtrace;
    return typeof cursor === "number" &&
      Number.isSafeInteger(cursor) &&
      cursor >= 0 &&
      search_id &&
      typeof backtrace === "string"
      ? { cursor, search_id, backtrace }
      : null;
  }
  if (search.platform === "wechat" && data?.continue_flag !== true && data?.continue_flag !== 1) return null;
  return opaqueString(
    data?.cursor,
    data?.pcursor,
    data?.recoPcursor,
    data?.next_cursor,
    data?.search_hash_id,
    paging?.next,
    paging?.next_cursor,
    payload.cursor,
    payload.pcursor,
  );
}

function platformResult(args: {
  readonly search: ProviderSearchArgs;
  readonly provider: ActiveChinaSocialProviderId;
  readonly endpoint: string;
  readonly response: ProviderJsonResult;
  readonly notes: string[];
}): PlatformSearchResult {
  const data = asRecord(args.response.payload.data);
  let returned =
    args.provider === "justone"
      ? normalizeCommonItems(args.response.payload, args.search.platform, Number.POSITIVE_INFINITY)
      : normalizePlatformItems(args.response.payload, args.search.platform, Number.POSITIVE_INFINITY);
  if (
    args.provider === "tikhub" &&
    args.search.platform === "weibo" &&
    ["user", "topic"].includes(args.search.weiboSearchType)
  ) {
    returned = normalizeCommonItems(args.response.payload, "weibo", Number.POSITIVE_INFINITY);
  }
  const items = returned.slice(0, args.search.show);
  const nextCursor = extractNextCursor(args.response.payload, args.search, args.provider);
  const notes = [
    ...args.notes,
    items.length < returned.length
      ? `${items.length} shown of ${returned.length} returned (limit); the next cursor or page continues after all ${returned.length}, including the ${returned.length - items.length} not shown.`
      : "Every normalized item in this response is shown; one page is not a complete result census.",
  ];
  if (!items.length && !data?.no_more && extractRawCount(args.response.payload) !== 0) {
    notes.push(
      "No items normalized; response-shape coverage is uncertain, not evidence of no matching content. See raw excerpt.",
    );
  }
  const nested = asRecord(data?.data);
  const business = asRecord(data?.business_config);
  if (
    !nextCursor &&
    (data?.has_more === true ||
      data?.has_more === 1 ||
      nested?.has_more === true ||
      nested?.has_more === 1 ||
      business?.has_more === true ||
      business?.has_more === 1 ||
      data?.continue_flag === true ||
      data?.continue_flag === 1)
  ) {
    notes.push("Provider reports more results but complete reusable pagination state was not returned; pagination unavailable.");
  }
  return {
    platform: args.search.platform,
    provider: args.provider,
    endpoint: args.endpoint,
    items,
    returned: returned.length,
    notes,
    rawCount: extractRawCount(args.response.payload),
    rawFallback: safeJsonSnippet(args.response.payload.data ?? args.response.payload),
    httpStatus: args.response.httpStatus,
    attempts: args.response.attempts,
    durationMs: args.response.durationMs,
    requestId: args.response.requestId,
    nextCursor,
    ...(args.search.platform === "wechat" && args.provider === "tikhub"
      ? {
          availability: {
            categories: data?.categories ?? null,
            no_more: data?.no_more ?? null,
            continue_flag: data?.continue_flag ?? null,
            business_type: data?.business_type ?? null,
          },
        }
      : {}),
  };
}

function parseJustOnePayload(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof value.data !== "string") return value;
  try {
    const parsed = parseProviderJson(value.data);
    return { ...value, data: asRecord(parsed) ?? parsed };
  } catch {
    return value;
  }
}

function fetchJustOneJson(
  args: ProviderSearchArgs,
): Effect.Effect<
  { readonly ok: true; readonly data: ProviderJsonResult } | { readonly ok: false; readonly cancelled: boolean; readonly error: string },
  never,
  PaidHttp
> {
  return Effect.gen(function* () {
    const token = process.env.JUSTONE_API_KEY?.trim();
    if (!token) return { ok: false as const, cancelled: false, error: `JUSTONE_API_KEY is not set in Dig's keys.env. ${setOutsideChat()}` };
    if (!args.cursor && (!args.justoneStart || !args.justoneEnd)) {
      return {
        ok: false as const,
        cancelled: false,
        error:
          "Just One initial requests require justone_start and justone_end (yyyy-MM-dd HH:mm:ss); official prose requires them despite optional OpenAPI flags.",
      };
    }
    const url = new URL("/api/search/v1", justoneBaseUrl());
    url.searchParams.set("token", token);
    url.searchParams.set("keyword", args.query);
    url.searchParams.set("source", args.platform === "wechat" ? "WEIXIN" : args.platform.toUpperCase());
    if (args.justoneStart) url.searchParams.set("start", args.justoneStart);
    if (args.justoneEnd) url.searchParams.set("end", args.justoneEnd);
    if (typeof args.cursor === "string") url.searchParams.set("nextCursor", args.cursor);

    const res = yield* Effect.result(
      paidRequest({
        url: url.href,
        method: "GET",
        headers: { Accept: "application/json" },
        signal: args.signal,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        keep: args.keep,
        label: "search/v1",
        parseJson: parseProviderJson,
      }),
    );
    if (Result.isFailure(res)) {
      if (args.signal.aborted) return { ok: false as const, cancelled: true, error: "Just One API request cancelled" };
      return {
        ok: false as const,
        cancelled: false,
        error: `Just One API transport failed (token-bearing diagnostics withheld). ${unansweredCost("Just One API")}`,
      };
    }
    const response = res.success;
    const record = asRecord(response.payload);
    if (response.status < 200 || response.status >= 300) {
      return { ok: false as const, cancelled: false, error: `Just One API returned HTTP ${response.status}` };
    }
    if (!record) return { ok: false as const, cancelled: false, error: "Just One API returned a non-object JSON payload" };
    const code = firstNumber(record.code);
    if (code !== 0) return { ok: false as const, cancelled: false, error: `Just One API returned code ${code ?? "unknown"}` };
    const payload = parseJustOnePayload(record);
    return {
      ok: true as const,
      data: {
        payload,
        httpStatus: response.status,
        attempts: 1,
        durationMs: response.durationMs,
        requestId: firstString(record.requestId, record.request_id) ?? response.requestId ?? null,
      },
    };
  });
}

function searchTikHubPlatform(
  args: ProviderSearchArgs,
): Effect.Effect<
  { readonly ok: true; readonly result: PlatformSearchResult } | { readonly ok: false; readonly cancelled: boolean; readonly error: string },
  never,
  PaidHttp
> {
  return Effect.gen(function* () {
    switch (args.platform) {
      case "xiaohongshu": {
        const endpoint = "/api/v1/xiaohongshu/app_v2/search_notes";
        const state = asRecord(args.cursor);
        if (args.cursor && (!opaqueString(state?.search_id) || !opaqueString(state?.search_session_id))) {
          return {
            ok: false as const,
            cancelled: false,
            error: "Xiaohongshu cursor must contain search_id and search_session_id from the first response.",
          };
        }
        if (args.page > 1 && !state) {
          return {
            ok: false as const,
            cancelled: false,
            error: "Xiaohongshu page > 1 requires the returned cursor object; session IDs cannot be guessed.",
          };
        }
        if (state && args.page === 1) {
          return {
            ok: false as const,
            cancelled: false,
            error:
              "Xiaohongshu cursor continues a later page; pass page 2 or more with it (page 2 for the cursor from the first response).",
          };
        }
        const res = yield* fetchTikHubJson({
          endpoint,
          query: {
            keyword: args.query,
            page: args.page,
            ...(state ? { search_id: String(state.search_id), search_session_id: String(state.search_session_id) } : {}),
            sort_type:
              args.sort === "latest" ? "time_descending" : args.sort === "hot" ? "popularity_descending" : "general",
            note_type: "不限",
            time_filter:
              args.timeRange === "day"
                ? "一天内"
                : args.timeRange === "week"
                  ? "一周内"
                  : args.timeRange === "half_year"
                    ? "半年内"
                    : "不限",
            source: "explore_feed",
            ai_mode: 0,
          },
          signal: args.signal,
          keep: args.keep,
        });
        if (!res.ok) return res;
        return {
          ok: true as const,
          result: platformResult({
            search: args,
            provider: "tikhub",
            endpoint,
            response: res.data,
            notes: [
              "TikHub Xiaohongshu App V2 search-notes endpoint",
              ...(args.timeRange === "month"
                ? ["Unsupported month filter; used all time, not an undocumented month value."]
                : []),
            ],
          }),
        };
      }
      case "bilibili": {
        const endpoint = "/api/v1/bilibili/web/fetch_general_search";
        const end = Math.floor(Date.now() / 1000);
        const days = { all: 0, day: 1, week: 7, month: 30, half_year: 180 }[args.timeRange];
        const res = yield* fetchTikHubJson({
          endpoint,
          query: {
            keyword: args.query,
            order: args.sort === "latest" ? "pubdate" : args.sort === "hot" ? "click" : "totalrank",
            page: args.page,
            page_size: Math.max(args.limit, 4),
            ...(days ? { pubtime_begin_s: end - days * 86400, pubtime_end_s: end } : {}),
          },
          signal: args.signal,
          keep: args.keep,
        });
        if (!res.ok) return res;
        return {
          ok: true as const,
          result: platformResult({
            search: args,
            provider: "tikhub",
            endpoint,
            response: res.data,
            notes: [
              "TikHub Bilibili general search endpoint",
              days
                ? `Publication window sent: ${end - days * 86400}–${end} Unix seconds (${days} days)`
                : "No time filter requested",
            ],
          }),
        };
      }
      case "douyin": {
        const endpoint = "/api/v1/douyin/search/fetch_video_search_v2";
        const state = asRecord(args.cursor);
        if (
          args.cursor &&
          (!state ||
            typeof state.cursor !== "number" ||
            !Number.isSafeInteger(state.cursor) ||
            state.cursor < 0 ||
            !opaqueString(state.search_id) ||
            typeof state.backtrace !== "string")
        ) {
          return {
            ok: false as const,
            cancelled: false,
            error: "Douyin cursor must contain the returned integer cursor, search_id, and backtrace.",
          };
        }
        if (args.page !== 1) {
          return {
            ok: false as const,
            cancelled: false,
            error: "Douyin uses returned cursor state, not page numbers; omit page and pass cursor.",
          };
        }
        const res = yield* fetchTikHubJson({
          endpoint,
          method: "POST",
          body: {
            keyword: args.query,
            cursor: state?.cursor ?? 0,
            sort_type: args.sort === "latest" ? "2" : args.sort === "hot" ? "1" : "0",
            publish_time:
              args.timeRange === "day" ? "1" : args.timeRange === "week" ? "7" : args.timeRange === "half_year" ? "180" : "0",
            filter_duration: "0",
            content_type: "0",
            search_id: state?.search_id ?? "",
            backtrace: state?.backtrace ?? "",
          },
          signal: args.signal,
          keep: args.keep,
        });
        if (!res.ok) return res;
        return {
          ok: true as const,
          result: platformResult({
            search: args,
            provider: "tikhub",
            endpoint,
            response: res.data,
            notes: [
              "TikHub Douyin dedicated video-search V2 endpoint",
              ...(args.timeRange === "month"
                ? ["Unsupported month filter; used all time, not an undocumented 30-day value."]
                : []),
            ],
          }),
        };
      }
      case "weibo": {
        const vertical = args.weiboSearchType === "normal" && args.sort === "latest" ? "realtime" : args.weiboSearchType;
        const routes: Partial<Record<WeiboSearchType, string>> = {
          realtime: "fetch_realtime_search",
          image: "fetch_pic_search",
          video: "fetch_video_search",
          user: "fetch_user_search",
          topic: "fetch_topic_search",
        };
        const route = routes[vertical] ?? "fetch_advanced_search";
        const endpoint = `/api/v1/weibo/web_v2/${route}`;
        const query: Record<string, string | number> = { page: args.page };
        const notes = [`TikHub Weibo Web V2 ${vertical} search`];
        if (route === "fetch_advanced_search") {
          query.q = args.query;
          query.search_type = vertical === "normal" ? (args.sort === "hot" ? "hot" : "all") : vertical;
          if (args.sort === "latest") notes.push("Unsupported latest sort for this advanced vertical; vertical retained.");
          if (args.sort === "hot" && vertical !== "normal" && vertical !== "hot") {
            notes.push("Unsupported hot sort alongside this advanced vertical; vertical retained.");
          }
          if (args.timeRange !== "all") {
            const end = new Date();
            const days = { day: 1, week: 7, month: 30, half_year: 180 }[args.timeRange];
            const start = new Date(end.getTime() - days * 86400000);
            const hour = (date: Date) => date.toISOString().slice(0, 13).replace("T", "-");
            query.timescope = `custom:${hour(start)}:${hour(end)}`;
            notes.push(
              `Time scope sent at UTC hour precision: ${query.timescope}; provider timezone interpretation not verified.`,
            );
          }
        } else {
          query.query = args.query;
          if (vertical === "video") query.mode = args.sort === "hot" ? "hot" : "all";
          if (args.timeRange !== "all") notes.push("Unsupported time filter for this Weibo vertical; no time filter sent.");
          if (
            args.sort !== "relevance" &&
            !(vertical === "realtime" && args.sort === "latest") &&
            !(vertical === "video" && args.sort === "hot")
          ) {
            notes.push(`Unsupported ${args.sort} sort for this Weibo vertical.`);
          }
        }
        const res = yield* fetchTikHubJson({ endpoint, query, signal: args.signal, keep: args.keep });
        if (!res.ok) return res;
        return {
          ok: true as const,
          result: platformResult({ search: args, provider: "tikhub", endpoint, response: res.data, notes }),
        };
      }
      case "zhihu": {
        const endpoint = "/api/v1/zhihu/web/fetch_article_search_v3";
        const res = yield* fetchTikHubJson({
          endpoint,
          query: {
            keyword: args.query,
            offset: Math.max(0, (args.page - 1) * Math.max(args.limit, 5)),
            limit: Math.max(args.limit, 5),
            show_all_topics: 0,
            search_source: args.sort !== "relevance" || args.timeRange !== "all" ? "Filter" : "Normal",
            search_hash_id: typeof args.cursor === "string" ? args.cursor : "",
            vertical: "",
            sort: args.sort === "latest" ? "created_time" : args.sort === "hot" ? "upvoted_count" : "",
            time_interval: { all: "", day: "a_day", week: "a_week", month: "a_month", half_year: "half_a_year" }[
              args.timeRange
            ],
            vertical_info: "",
          },
          signal: args.signal,
          keep: args.keep,
        });
        if (!res.ok) return res;
        return {
          ok: true as const,
          result: platformResult({
            search: args,
            provider: "tikhub",
            endpoint,
            response: res.data,
            notes: ["TikHub Zhihu article-search V3 endpoint", "Requested sort/time intent mapped to documented native filters"],
          }),
        };
      }
      case "kuaishou": {
        const endpoint = "/api/v1/kuaishou/app/search_comprehensive";
        const res = yield* fetchTikHubJson({
          endpoint,
          query: {
            keyword: args.query,
            pcursor: typeof args.cursor === "string" ? args.cursor : "",
            sort_type: args.sort === "latest" ? "newest" : args.sort === "hot" ? "most_likes" : "all",
            publish_time:
              args.timeRange === "day"
                ? "one_day"
                : args.timeRange === "week"
                  ? "one_week"
                  : args.timeRange === "month"
                    ? "one_month"
                    : "all",
            duration: "all",
          },
          signal: args.signal,
          keep: args.keep,
        });
        if (!res.ok) return res;
        return {
          ok: true as const,
          result: platformResult({
            search: args,
            provider: "tikhub",
            endpoint,
            response: res.data,
            notes: [
              "TikHub Kuaishou comprehensive-search endpoint",
              args.timeRange === "half_year"
                ? "Kuaishou endpoint cannot apply a half-year filter; used all time"
                : "Requested native filters sent",
            ],
          }),
        };
      }
      case "wechat": {
        const endpoint = "/api/v1/wechat_search/v2/fetch_search";
        const res = yield* fetchTikHubJson({
          endpoint,
          method: "POST",
          body: {
            keyword: args.query,
            business_type: args.wechatVertical,
            sort: args.sort === "latest" ? "latest" : args.sort === "hot" ? "hot" : "default",
            publish_time:
              args.timeRange === "day"
                ? "day"
                : args.timeRange === "week"
                  ? "week"
                  : args.timeRange === "half_year"
                    ? "half_year"
                    : "all",
            offset: 0,
            cursor: typeof args.cursor === "string" ? args.cursor : null,
            raw: false,
          },
          signal: args.signal,
          keep: args.keep,
        });
        if (!res.ok) return res;
        return {
          ok: true as const,
          result: platformResult({
            search: args,
            provider: "tikhub",
            endpoint,
            response: res.data,
            notes: [
              "TikHub WeChat universal-search V2 endpoint with simplified parsing",
              "Provider price is $0.01 per request",
              ...(!["all", "account", "article", "video", "sticker"].includes(args.wechatVertical)
                ? [
                    "This vertical is account/region gated and documented as currently empty; a billed empty response is not evidence that content is absent. Inspect categories from an all search.",
                  ]
                : []),
              args.timeRange === "month"
                ? "WeChat endpoint cannot apply a one-month filter; used all time"
                : "Requested native filters sent",
            ],
          }),
        };
      }
    }
  });
}

function searchJustOnePlatform(
  args: ProviderSearchArgs,
): Effect.Effect<
  { readonly ok: true; readonly result: PlatformSearchResult } | { readonly ok: false; readonly cancelled: boolean; readonly error: string },
  never,
  PaidHttp
> {
  return Effect.gen(function* () {
    const res = yield* fetchJustOneJson(args);
    if (!res.ok) return res;
    return {
      ok: true as const,
      result: platformResult({
        search: args,
        provider: "justone",
        endpoint: "/api/search/v1",
        response: res.data,
        notes: [
          "Just One API cached cross-platform search endpoint",
          "Cached results may be incomplete for uncommon queries",
          "Common sort/time intent and platform-specific verticals are unsupported; only explicit justone_start/end filters apply",
        ],
      }),
    };
  });
}

function platformLabel(platform: ChinaSocialPlatform): string {
  switch (platform) {
    case "xiaohongshu":
      return "Xiaohongshu";
    case "bilibili":
      return "Bilibili";
    case "douyin":
      return "Douyin";
    case "weibo":
      return "Weibo";
    case "zhihu":
      return "Zhihu";
    case "kuaishou":
      return "Kuaishou";
    case "wechat":
      return "WeChat";
  }
}

function providerLabel(provider: ActiveChinaSocialProviderId): string {
  return provider === "tikhub" ? "TikHub" : "Just One API";
}

function formatPlatformFailure(failure: PlatformSearchFailure): string {
  return `- ${platformLabel(failure.platform)} (${providerLabel(failure.provider)}): ${failure.message}`;
}

function formatPlatformResult(result: PlatformSearchResult): string {
  const lines: string[] = [];
  lines.push(`## ${platformLabel(result.platform)}`);
  lines.push(`Provider: ${providerLabel(result.provider)} | Endpoint: ${result.endpoint}`);
  lines.push(
    `Run evidence: HTTP ${result.httpStatus} | Attempts ${result.attempts} | ${result.durationMs}ms | Normalized ${result.items.length}${result.requestId ? ` | Request ${result.requestId}` : ""}`,
  );
  if (result.nextCursor) {
    lines.push(
      `Next cursor: ${typeof result.nextCursor === "string" ? result.nextCursor : JSON.stringify(result.nextCursor)}`,
    );
  }
  if (result.availability) lines.push(`WeChat availability: ${JSON.stringify(result.availability)}`);
  if (result.rawCount !== null) lines.push(`Reported result count: ${result.rawCount}`);
  if (result.notes.length > 0) lines.push(`Notes: ${result.notes.join("; ")}`);
  lines.push("");

  if (result.items.length === 0) {
    lines.push(`No normalized ${platformLabel(result.platform)} results were extracted for this query.`);
    if (result.rawFallback) {
      lines.push("", "Raw data excerpt:", "```json", result.rawFallback, "```");
    }
    return lines.join("\n");
  }

  lines.push(
    `Top normalized results: ${result.items.length}${result.returned > result.items.length ? ` shown of ${result.returned} returned` : ""}`,
  );
  lines.push("");

  for (const item of result.items) {
    const stats = [
      item.views !== null ? `Views ${formatNumber(item.views)}` : null,
      item.likes !== null ? `Likes ${formatNumber(item.likes)}` : null,
      item.comments !== null ? `Comments ${formatNumber(item.comments)}` : null,
      item.bulletComments != null ? `Bullet comments ${formatNumber(item.bulletComments)}` : null,
      item.shares !== null ? `Shares ${formatNumber(item.shares)}` : null,
      item.saves !== null ? `Saves ${formatNumber(item.saves)}` : null,
    ].filter(Boolean);

    lines.push(`- **${item.title}**`);
    if (item.id) lines.push(`  - ID: ${item.id}`);
    if (item.handles && Object.keys(item.handles).length) {
      lines.push(`  - Follow-up handles: ${JSON.stringify(item.handles)}`);
    }
    if (item.author) lines.push(`  - Author: ${item.author}`);
    if (item.publishedAt) lines.push(`  - Published: ${item.publishedAt}`);
    if (stats.length > 0) lines.push(`  - Engagement: ${stats.join(" | ")}`);
    if (item.url) lines.push(`  - URL: ${item.url}`);
    if (item.tags.length > 0) lines.push(`  - Tags: ${item.tags.slice(0, 8).join(", ")}`);
    if (item.summary) lines.push(`  - Summary: ${item.summary}`);
  }

  return lines.join("\n");
}

const ChinaSocialSearchSchema = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "China social search query.",
  }),
  platforms: Schema.optionalKey(
    Schema.Array(Schema.Literals(CHINA_SOCIAL_PLATFORM_VALUES)).annotate({
      description:
        "Platforms to search. A cursor requires exactly one platform. WeChat costs $0.01 per TikHub request.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIMIT })).annotate({
      description:
        "Max normalized items shown per platform (default: every item in the response); the next cursor or page still starts after the whole response. Bilibili also requests max(limit, 4) items per page and Zhihu max(limit, 5), 5 for both when limit is omitted, with Zhihu's page offset counted in that size, so keep limit unchanged while paging.",
    }),
  ),
  provider: Schema.optionalKey(
    Schema.Literals(CHINA_SOCIAL_PROVIDER_VALUES).annotate({
      description: "Provider choice. auto selects TikHub; Just One is explicit and credential-gated.",
    }),
  ),
  page: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description:
        "Page for Bilibili/Weibo/Zhihu/XHS. XHS page 2+ also needs both session IDs. Omit for cursor-only providers.",
    }),
  ),
  cursor: Schema.optionalKey(
    Schema.Union([
      Schema.String.annotate({
        description: "Exact opaque cursor for Kuaishou/WeChat/Just One or Zhihu search hash.",
      }),
      Schema.Struct({
        search_id: Schema.String.check(Schema.isMinLength(1)),
        search_session_id: Schema.String.check(Schema.isMinLength(1)),
      }).annotate({ description: "XHS session state from first response; also set page." }),
      Schema.Struct({
        cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        search_id: Schema.String.check(Schema.isMinLength(1)),
        backtrace: Schema.String,
      }).annotate({ description: "Douyin state from prior response; never derive cursor from page." }),
    ]).annotate({
      description: "Returned pagination state, scoped to exactly one platform. Preserve values verbatim.",
    }),
  ),
  justone_start: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)).annotate({
      description: "Just One initial start date yyyy-MM-dd HH:mm:ss; required with justone_end on first call.",
    }),
  ),
  justone_end: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)).annotate({
      description:
        "Just One end date yyyy-MM-dd HH:mm:ss. Common time_range does not substitute for this boundary.",
    }),
  ),
  sort: Schema.optionalKey(
    Schema.Literals(CHINA_SOCIAL_SORT_VALUES).annotate({
      description: "Common sort intent. Unsupported combinations are reported.",
    }),
  ),
  time_range: Schema.optionalKey(
    Schema.Literals(CHINA_SOCIAL_TIME_RANGE_VALUES).annotate({
      description: "Publication-time intent. XHS/Douyin/WeChat month and Kuaishou half_year are unsupported.",
    }),
  ),
  weibo_search_type: Schema.optionalKey(
    Schema.Literals(WEIBO_SEARCH_TYPE_VALUES).annotate({
      description:
        "Weibo Web V2 vertical. Retired article vertical is unsupported. Separate verticals have separate filter support.",
    }),
  ),
  wechat_vertical: Schema.optionalKey(
    Schema.Literals(WECHAT_VERTICAL_VALUES).annotate({
      description:
        "WeChat vertical; all/account/article/video/sticker are documented usable. Others are account/region-gated and may be billed empty; inspect returned categories.",
    }),
  ),
});

export const chinaSocialSearchAction = defineAction({
  name: "china_social_search",
  description:
    "Search Xiaohongshu, Bilibili, Douyin, Weibo, Zhihu, Kuaishou, and WeChat through TikHub, " +
    "or use the credential-gated Just One API cross-platform backend. Results include live per-request provider evidence.",
  schema: ChinaSocialSearchSchema,
  execute: (args, ctx): Effect.Effect<ActionOutcome, never, PaidHttp> =>
    Effect.gen(function* () {
      const platforms: ChinaSocialPlatform[] = args.platforms?.length
        ? Array.from(new Set(args.platforms))
        : [...DEFAULT_PLATFORM_SLICE];
      const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      const show = args.limit === undefined ? Number.POSITIVE_INFINITY : limit;
      const providerChoice: ChinaSocialProviderId = args.provider ?? "auto";
      const requestedProvider: ActiveChinaSocialProviderId =
        providerChoice === "auto" ? "tikhub" : providerChoice;

      if (!args.query?.trim()) return failed("China-social search failed: query is required");
      if (!(CHINA_SOCIAL_PROVIDER_VALUES as readonly string[]).includes(providerChoice)) {
        return failed("China-social search failed: Unknown provider");
      }
      if (platforms.some((p) => !(CHINA_SOCIAL_PLATFORM_VALUES as readonly string[]).includes(p))) {
        return failed("China-social search failed: Unknown platform");
      }
      if (args.page !== undefined && (!Number.isSafeInteger(args.page) || args.page < 1)) {
        return failed("China-social search failed: page must be a positive integer");
      }
      if (args.sort !== undefined && !(CHINA_SOCIAL_SORT_VALUES as readonly string[]).includes(args.sort)) {
        return failed("China-social search failed: Unsupported sort");
      }
      if (args.time_range !== undefined && !(CHINA_SOCIAL_TIME_RANGE_VALUES as readonly string[]).includes(args.time_range)) {
        return failed("China-social search failed: Unsupported time_range");
      }
      if (
        args.weibo_search_type !== undefined &&
        !(WEIBO_SEARCH_TYPE_VALUES as readonly string[]).includes(args.weibo_search_type)
      ) {
        return failed(
          "China-social search failed: Unsupported Weibo vertical; article search is not offered by the current Web V2 search contract",
        );
      }
      if (
        args.wechat_vertical !== undefined &&
        !(WECHAT_VERTICAL_VALUES as readonly string[]).includes(args.wechat_vertical)
      ) {
        return failed("China-social search failed: Unsupported WeChat vertical");
      }
      if (args.weibo_search_type !== undefined && !platforms.includes("weibo")) {
        return failed("China-social search failed: weibo_search_type requires the weibo platform");
      }
      if (args.wechat_vertical !== undefined && !platforms.includes("wechat")) {
        return failed("China-social search failed: wechat_vertical requires the wechat platform");
      }
      if (args.cursor !== undefined && platforms.length !== 1) {
        return failed("China-social search failed: Pagination cursor must be scoped to exactly one platform");
      }
      if (args.cursor !== undefined && typeof args.cursor !== "string" && !asRecord(args.cursor)) {
        return failed("China-social search failed: cursor must be an opaque string or returned state object");
      }
      if (requestedProvider === "justone" || !["xiaohongshu", "douyin"].includes(platforms[0] ?? "")) {
        if (args.cursor !== undefined && typeof args.cursor !== "string") {
          return failed("China-social search failed: This endpoint requires an opaque string cursor");
        }
      }
      if (args.cursor !== undefined && ["bilibili", "weibo"].includes(platforms[0] ?? "") && requestedProvider === "tikhub") {
        return failed("China-social search failed: This endpoint uses page, not cursor");
      }
      if (
        (args.page ?? 1) > 1 &&
        (requestedProvider === "justone" || platforms.some((p) => ["douyin", "kuaishou", "wechat"].includes(p)))
      ) {
        return failed(
          "China-social search failed: Cursor-only endpoints do not support page; pass the returned cursor and omit page",
        );
      }
      if (requestedProvider !== "justone" && (args.justone_start !== undefined || args.justone_end !== undefined)) {
        return failed("China-social search failed: justone_start/end only apply to provider=justone");
      }
      for (const boundary of [args.justone_start, args.justone_end]) {
        if (boundary !== undefined && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(boundary)) {
          return failed("China-social search failed: Just One dates must use yyyy-MM-dd HH:mm:ss");
        }
      }
      if (args.justone_start && args.justone_end && args.justone_start >= args.justone_end) {
        return failed("China-social search failed: justone_start must precede justone_end");
      }

      const results: PlatformSearchResult[] = [];
      const failures: PlatformSearchFailure[] = [];

      for (const platform of platforms) {
        const searchArgs: ProviderSearchArgs = {
          query: args.query,
          platform,
          limit,
          show,
          page: Math.max(args.page ?? DEFAULT_PAGE, 1),
          cursor: args.cursor ?? null,
          justoneStart: args.justone_start,
          justoneEnd: args.justone_end,
          sort: args.sort ?? "relevance",
          timeRange: args.time_range ?? "all",
          weiboSearchType: args.weibo_search_type ?? "normal",
          wechatVertical: args.wechat_vertical ?? "all",
          signal: ctx.signal,
          keep: ctx.keep,
        };
        const res =
          requestedProvider === "justone"
            ? yield* searchJustOnePlatform(searchArgs)
            : yield* searchTikHubPlatform(searchArgs);
        if (!res.ok) {
          if (res.cancelled || ctx.signal.aborted) {
            return outcome(
              "cancelled",
              "ERROR: China-social search cancelled; cancellation is not provider failure or evidence absence.",
            );
          }
          failures.push({
            platform,
            provider: requestedProvider,
            message: redactText(res.error, knownSecrets()),
          });
        } else {
          results.push(res.result);
        }
      }

      if (results.length === 0) {
        return failed(
          `China-social search failed: All requested platforms failed: ${failures
            .map((failure) => `${platformLabel(failure.platform)} (${providerLabel(failure.provider)}): ${failure.message}`)
            .join("; ")}`,
        );
      }

      const totalItems = results.reduce((sum, result) => sum + result.items.length, 0);
      const lines: string[] = [
        "# China Social Search",
        "",
        `Query: ${args.query}`,
        `Platforms: ${platforms.map(platformLabel).join(", ")}`,
        `Provider mode: ${providerChoice}`,
        `Normalized results: ${totalItems}`,
        "",
        "Provider standing below is evidence from this run, not a permanent platform-health claim. TikHub is the automatic primary; Just One API is an explicit credential-gated alternative.",
        "",
      ];

      if (failures.length > 0) {
        lines.push("## Warnings");
        lines.push(
          "Some requested platforms failed in this run, so successful platforms are returned as partial results. A run failure is provider evidence, not proof that the platform itself is unavailable.",
        );
        for (const failure of failures) lines.push(formatPlatformFailure(failure));
        lines.push("");
      }

      for (const result of results) {
        lines.push(formatPlatformResult(result));
        lines.push("");
      }

      return outcome(failures.length > 0 ? "partial" : "success", lines.join("\n").trim(), {
        source: "china-social",
        providerMode: providerChoice,
        totalItems,
        successfulPlatforms: results.map((result) => result.platform),
        failedPlatforms: failures.map((failure) => failure.platform),
        runs: results.map((result) => ({
          platform: result.platform,
          provider: result.provider,
          endpoint: result.endpoint,
          httpStatus: result.httpStatus,
          attempts: result.attempts,
          durationMs: result.durationMs,
          requestId: result.requestId,
          normalizedItems: result.items.length,
          nextCursor: result.nextCursor,
          availability: result.availability,
          notes: result.notes,
          items: result.items,
        })),
      });
    }),
});

export const chinaSocialSource: SourcePlugin = defineSource({
  id: "china-social",
  group: "social",
  label: "China social",
  description: "Seven platforms via TikHub and an optional fallback",
  about:
    "Mainland-China social platforms (Xiaohongshu, Bilibili, Douyin, Weibo, Zhihu, Kuaishou and WeChat) through TikHub, with the Just One API as a fallback used only when asked for. Reports translate what they quote.",
  providers: [TIKHUB_PROVIDER, { name: "Just One API", url: "https://justoneapi.com" }],
  billing: `${TIKHUB_BILLING} Just One needs its own key and account.`,
  env: ["TIKHUB_API_KEY", "TIKHUB_BASE_URL", "JUSTONE_API_KEY", "JUSTONE_BASE_URL"],
  keys: ["TIKHUB_API_KEY"],
  credential: "TIKHUB_API_KEY; JUSTONE_API_KEY only for explicit fallback",
  actions: [chinaSocialSearchAction],
});

export default chinaSocialSource;
