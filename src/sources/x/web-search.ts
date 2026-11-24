/**
 * `x_web_search`: Google-indexed public X post search through ScrapeCreators
 * (`GET /v1/twitter/search/posts`, `PaidHttp`, `scrapecreatorsBilling`).
 */
import { Effect, Schema } from "effect";
import {
  defineAction,
  failed,
  outcome,
  type ActionOutcome,
  type OutcomeStatus,
} from "../../core/plugin.ts";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  cleanText,
  expectArray,
  failText,
  knownCharge,
  MISSING_SCRAPECREATORS_KEY,
  provenanceLine,
  scrapecreatorsBilling,
  scrapecreatorsHeaders,
  scrapecreatorsRequest,
} from "../shared/scrapecreators.ts";

type Json = Record<string, unknown>;

const PATH = "/v1/twitter/search/posts";
const LABEL = "ScrapeCreators X web search";
const OUTPUT_LIMIT = 60_000;
const TRUNCATION_NOTE =
  "The complete response is this call's original response when raw retention is on; read it with library_read using the receipt's raw file.";
const ZERO_NOTE = "List lines leave out counts of zero.";
const SCOPE_NOTE =
  "Google-indexed public X posts hydrated live (best for broad/historical discovery >24 h old). For last-24 h posts, exact X operators, counts or thread verification, use x_search_posts and x_post.";

const SNOWFLAKE_EPOCH = 1288834974657n;
const NUMERIC_ID = /^\d{1,19}$/;
const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
const POST_URL_HANDLE =
  /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,19})(?:[/?#]|$)/i;

const count = (value: number, one: string, many: string): string =>
  `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;
const permalink = (id: string, handle: string | null): string =>
  `https://x.com/${handle ?? "i"}/status/${id}`;
const utc = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const quoteBlock = (lines: readonly string[]): string[] => lines.map((line) => `> ${line}`);

function snowflakeIso(id: string): string | null {
  try {
    const ms = Number((BigInt(id) >> 22n) + SNOWFLAKE_EPOCH);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  } catch {
    return null;
  }
}

function parseTime(createdAt: unknown, id: string): string | null {
  if (typeof createdAt === "string") {
    const match = createdAt.match(
      /^\w{3} (\w{3}) (\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2}) (\d{4})$/,
    );
    const month = match ? MONTHS.indexOf(match[1]) : -1;
    if (match && month >= 0 && month % 3 === 0) {
      const date = new Date(
        `${match[6]}-${String(month / 3 + 1).padStart(2, "0")}-${match[2]}T${match[3]}${match[4]}:${match[5]}`,
      );
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    const parsed = Date.parse(createdAt);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return snowflakeIso(id);
}

function expandLinks(text: string, ...entitySets: ReadonlyArray<Json | null>): string {
  let expanded = text;
  for (const entities of entitySets) {
    for (const item of asArray(entities?.urls)) {
      const link = asRecord(item);
      const short = asString(link?.url);
      const long = asString(link?.expanded_url);
      if (short && long) expanded = expanded.replaceAll(short, long);
    }
  }
  return expanded;
}

interface WebMedia {
  readonly type: string;
  readonly url: string;
  readonly preview: string | null;
  readonly durationMs: number | null;
  readonly altText: string | null;
}

interface WebPost {
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
  readonly media: WebMedia[];
  readonly quoted: WebPost | null;
}

function extractMedia(legacy: Json): WebMedia[] {
  const list = asArray(asRecord(legacy.extended_entities)?.media);
  const items = list.length ? list : asArray(asRecord(legacy.entities)?.media);
  const out: WebMedia[] = [];
  for (const entry of items) {
    const item = asRecord(entry);
    if (!item) continue;
    const type = asString(item.type) ?? "media";
    const preview = asString(item.media_url_https) ?? asString(item.url);
    const videoInfo = asRecord(item.video_info);
    const mp4 = asArray(videoInfo?.variants)
      .map(asRecord)
      .filter(
        (variant): variant is Json =>
          Boolean(variant && variant.content_type === "video/mp4" && asString(variant.url)),
      )
      .sort((a, b) => (asNumber(b.bitrate) ?? 0) - (asNumber(a.bitrate) ?? 0))[0];
    const mp4Url = asString(mp4?.url);
    const url = mp4Url ?? preview;
    if (!url) continue;
    out.push({
      type,
      url,
      preview: mp4Url && preview ? preview : null,
      durationMs: asNumber(videoInfo?.duration_millis),
      altText: asString(item.ext_alt_text),
    });
  }
  return out;
}

function normalizeWebPost(raw: unknown, depth = 0): WebPost | null {
  const outer = asRecord(raw);
  if (!outer) return null;
  const tweet = asRecord(outer.tweet) ?? outer;
  const legacy = asRecord(tweet.legacy) ?? {};
  const urlMatch =
    asString(tweet.url)?.match(POST_URL_HANDLE) ??
    asString(outer.url)?.match(POST_URL_HANDLE) ??
    null;
  const id =
    asString(tweet.rest_id) ??
    asString(legacy.id_str) ??
    asString(tweet.id_str) ??
    asString(tweet.id) ??
    urlMatch?.[2] ??
    null;
  if (!id || !NUMERIC_ID.test(id)) return null;

  const user = asRecord(asRecord(asRecord(tweet.core)?.user_results)?.result);
  const userCore = asRecord(user?.core);
  const userLegacy = asRecord(user?.legacy);
  const urlHandle = urlMatch?.[1] && urlMatch[1].toLowerCase() !== "i" ? urlMatch[1] : null;
  const handle =
    asString(userCore?.screen_name) ??
    asString(userLegacy?.screen_name) ??
    asString(user?.screen_name) ??
    urlHandle;
  const name = asString(userCore?.name) ?? asString(userLegacy?.name) ?? asString(user?.name);
  const followers = asNumber(userLegacy?.followers_count) ?? asNumber(user?.followers_count);
  const verified =
    user?.is_blue_verified === true || userLegacy?.verified === true || user?.verified === true;

  const noteResult = asRecord(asRecord(asRecord(tweet.note_tweet)?.note_tweet_results)?.result);
  const rawText =
    asString(noteResult?.text) ??
    asString(legacy.full_text) ??
    asString(tweet.full_text) ??
    asString(tweet.text) ??
    "";
  const text = expandLinks(rawText, asRecord(noteResult?.entity_set), asRecord(legacy.entities));
  const media = extractMedia(legacy);
  if (!text && !media.length && !Object.keys(legacy).length) return null;

  const quotedRaw = depth < 1 ? asRecord(asRecord(tweet.quoted_status_result)?.result) : null;
  return {
    id,
    handle,
    name,
    followers,
    verified,
    createdAt: parseTime(legacy.created_at ?? tweet.created_at, id),
    text,
    replies: asNumber(legacy.reply_count),
    reposts: asNumber(legacy.retweet_count),
    quotes: asNumber(legacy.quote_count),
    likes: asNumber(legacy.favorite_count),
    bookmarks: asNumber(legacy.bookmark_count),
    views: asNumber(asRecord(tweet.views)?.count) ?? asNumber(tweet.views),
    replyToId: asString(legacy.in_reply_to_status_id_str),
    replyToHandle: asString(legacy.in_reply_to_screen_name),
    media,
    quoted: quotedRaw ? normalizeWebPost(quotedRaw, depth + 1) : null,
  };
}

function byline(post: WebPost): string {
  const about = [
    post.name,
    post.followers === null ? null : count(post.followers, "follower", "followers"),
    post.verified ? "verified" : null,
  ].filter((part): part is string => part !== null);
  const who = post.handle ? `@${post.handle}` : "unknown author";
  return about.length ? `${who} (${about.join(", ")})` : who;
}

function facts(post: WebPost): string {
  const parts: string[] = [];
  const add = (value: number | null, one: string, many: string) => {
    if (value !== null && value !== 0) parts.push(count(value, one, many));
  };
  add(post.replies, "reply", "replies");
  add(post.reposts, "repost", "reposts");
  add(post.quotes, "quote", "quotes");
  add(post.likes, "like", "likes");
  add(post.bookmarks, "bookmark", "bookmarks");
  add(post.views, "view", "views");
  return [post.createdAt ? utc(post.createdAt) : null, ...parts].filter(Boolean).join(" · ");
}

function formatMedia(items: readonly WebMedia[]): string[] {
  return items.map((item) => {
    const notes = [
      item.durationMs === null ? null : `${(item.durationMs / 1000).toFixed(1)} s`,
      item.preview ? `preview ${item.preview}` : null,
      item.altText ? `alt text: ${item.altText}` : null,
    ].filter(Boolean);
    return `Media: ${item.type} ${item.url}${notes.length ? ` (${notes.join("; ")})` : ""}`;
  });
}

function formatWebPost(post: WebPost): string[] {
  const body = [...(post.text || "(no text)").split("\n"), ...formatMedia(post.media)];
  if (post.replyToId) {
    body.push(
      `Replying to ${post.replyToHandle ? `@${post.replyToHandle}` : "a post"}: ${permalink(post.replyToId, post.replyToHandle)}`,
    );
  }
  if (post.quoted) {
    body.push(
      `Quoting ${post.quoted.handle ? `@${post.quoted.handle}` : "a post"}: ${permalink(post.quoted.id, post.quoted.handle)}`,
      ...quoteBlock([...(post.quoted.text || "(no text)").split("\n"), ...formatMedia(post.quoted.media)]),
    );
  }
  const head = [byline(post), facts(post), permalink(post.id, post.handle)].filter(Boolean).join(" · ");
  return [`- ${head}`, ...body.map((line) => `  ${line}`)];
}

function boundedResult(
  status: OutcomeStatus,
  lines: readonly string[],
  details: Record<string, unknown>,
  tail?: string,
): ActionOutcome {
  const text = lines.join("\n");
  const truncated = text.length > OUTPUT_LIMIT;
  const body = truncated
    ? `${text.slice(0, OUTPUT_LIMIT)}\n[Truncated at ${OUTPUT_LIMIT} of ${text.length} characters. ${TRUNCATION_NOTE}]`
    : text;
  return outcome(
    truncated && status === "success" ? "partial" : status,
    tail ? `${body}\n\n${tail}` : body,
    { provider: "scrapecreators", via: "ScrapeCreators", ...details, truncated },
  );
}

export const XWebSearchSchema = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Keyword/topic query for Google-indexed public X posts via ScrapeCreators.",
  }),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))).annotate({
    description: "Page cursor from a previous x_web_search response (pages 1-11).",
  }),
});

export const xWebSearchAction = defineAction({
  name: "x_web_search",
  description:
    "Search Google-indexed public X posts (>24 h old) via ScrapeCreators (/v1/twitter/search/posts), returning ~8-10 live-hydrated posts/page with metrics, views, bookmarks and Media: links (zero X API reads). " +
    "Best for broad or historical topic discovery (>24 h old); recent (<24 h) posts, exact X search operators, counts and thread reads need x_search_posts and x_post. " +
    "One request per call; pass the returned cursor (pages 1-11) for the next page. Requires SCRAPECREATORS_API_KEY; 1 credit per request.",
  schema: XWebSearchSchema,
  billing: scrapecreatorsBilling,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const headers = scrapecreatorsHeaders();
      if (!headers) return failed(MISSING_SCRAPECREATORS_KEY);
      const query = cleanText(args.query);
      if (!query) return failed("query is required.");
      if (args.cursor !== undefined && (typeof args.cursor !== "string" || !args.cursor.trim())) {
        return failed("cursor must be a non-empty string returned by a previous response.");
      }
      const cursor = args.cursor?.trim() || undefined;

      const response = yield* scrapecreatorsRequest(PATH, { query, cursor }, headers, ctx, LABEL);
      if (!response.ok) {
        return outcome(response.cancelled ? "cancelled" : "failed", failText(response));
      }
      const payload = response.payload;
      const listed = expectArray(payload, "posts", LABEL);
      if (!listed.ok) return failed(listed.error);

      const seen = new Set<string>();
      const posts: WebPost[] = [];
      let unreadable = 0;
      let duplicates = 0;
      for (const entry of listed.items) {
        const post = normalizeWebPost(entry);
        if (!post) {
          unreadable += 1;
          continue;
        }
        if (seen.has(post.id)) {
          duplicates += 1;
          continue;
        }
        seen.add(post.id);
        posts.push(post);
      }
      if (!posts.length && unreadable) {
        return failed(
          `${LABEL} returned an unexpected payload: none of the ${count(unreadable, "entry", "entries")} carried a readable X post record`,
        );
      }

      const next =
        asString(payload.cursor) ??
        (asNumber(payload.cursor) !== null ? String(asNumber(payload.cursor)) : null);
      const lines = [
        `X web search via ScrapeCreators for "${query}" (${cursor ? `cursor=${cursor}` : "first page"}): ${count(posts.length, "post", "posts")}${duplicates ? ` (${count(duplicates, "duplicate", "duplicates")} dropped)` : ""}.`,
        provenanceLine(payload, response.charges),
        SCOPE_NOTE,
      ];
      if (unreadable) {
        lines.push(
          `Unreadable entries: ${count(unreadable, "returned entry", "returned entries")} lacked a readable X post record and ${unreadable === 1 ? "was" : "were"} skipped; see the retained original.`,
        );
      }

      const details = {
        query,
        returned: posts.length,
        duplicates_dropped: duplicates,
        unreadable,
        cursor: next,
        post_ids: posts.map((post) => post.id),
        credits_charged: knownCharge(response.charges),
      };
      if (!posts.length) {
        lines.push(
          "",
          "ScrapeCreators returned no indexed X posts for this query. Google-indexed search can miss posts under ~24 hours old or narrow phrasing; try broader terms or x_search_posts.",
        );
        return boundedResult("empty", lines, details);
      }
      lines.push("", ZERO_NOTE, ...posts.flatMap(formatWebPost));
      const tail = next
        ? `Next page: pass cursor="${next}" with the same query (ScrapeCreators supports pages 1-11).`
        : "Next page: no cursor returned; the provider gave no further page.";
      return boundedResult(unreadable ? "partial" : "success", lines, details, tail);
    }),
});
