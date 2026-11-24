/**
 * `x_search_posts` and `x_count_posts`: recent and full-archive X API search and volume counts.
 */
import { Effect, Schema } from "effect";
import {
  defineAction,
  failed,
  outcome,
  type OutcomeStatus,
} from "../../core/plugin.ts";
import {
  bearerToken,
  bounded,
  count,
  dataItems,
  formatListPost,
  MAX_COUNT_PAGES,
  MAX_SEARCH_PAGES,
  missingKey,
  newIncludes,
  nextToken,
  num,
  READS_NOTE,
  rec,
  SEARCH_LIMIT,
  SEARCH_LIMIT_MAX,
  searchPages,
  startTime,
  str,
  timeWindow,
  utc,
  X_API_DOCS_URL,
  X_READS_BILLING,
  xRead,
  ZERO_NOTE,
} from "./api-client.ts";

const SORT_VALUES = ["recency", "relevancy"] as const;
const GRANULARITIES = ["minute", "hour", "day"] as const;
type Granularity = (typeof GRANULARITIES)[number];

export const XSearchPostsSchema = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      "X search query; every X search operator passes through (from:, to:, conversation_id:, is:reply, -is:retweet, has:media, lang:, min_likes: …).",
  }),
  archive: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "false (default): the last 7 days. true: the full archive, at one request per second.",
  }),
  start_time: Schema.optionalKey(Schema.String).annotate({
    description:
      "Earliest post time, ISO 8601 (e.g. 2026-10-01T00:00:00Z); within the last 7 days unless archive is true.",
  }),
  end_time: Schema.optionalKey(Schema.String).annotate({
    description: "Latest post time, ISO 8601.",
  }),
  sort: Schema.optionalKey(Schema.Literals(SORT_VALUES)).annotate({
    description: "Order of results (default recency).",
  }),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SEARCH_LIMIT_MAX })),
  ).annotate({
    description: "Posts to return, paged internally (default 25, max 500).",
  }),
});

export const xSearchPostsAction = defineAction({
  name: "x_search_posts",
  description:
    "Search X posts with X's own search syntax (every operator passes through: from:, to:, conversation_id:, is:reply, has:media, lang:, min_likes: and the rest). archive false searches the last 7 days; true searches the full archive, from 2006-03-21 unless start_time says otherwise (X's own default there is the last 30 days), at one request per second, so pages are spaced. " +
    `Pages internally up to limit (default 25, max 500; at most 50 pages), each page kept as its own original response; returns each post with author, time, permalink, nonzero public counts and full text. Requires X_BEARER_TOKEN. ${READS_NOTE}.`,
  schema: XSearchPostsSchema,
  billing: X_READS_BILLING,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const token = bearerToken();
      if (!token) return failed(missingKey());
      const query = String(args.query ?? "").trim();
      if (!query) return failed("query is required: X search syntax, as on x.com search.");
      const archive = args.archive === true;
      const limit = Number(args.limit ?? SEARCH_LIMIT);
      const sort = args.sort === "relevancy" ? "relevancy" : "recency";
      const inc = newIncludes();
      const start = startTime(args, archive);
      const result = yield* searchPages(
        archive ? "all" : "recent",
        {
          query,
          sort_order: sort,
          start_time: start ?? undefined,
          end_time: str(args.end_time) ?? undefined,
        },
        limit,
        archive ? "full-archive search" : "recent search",
        inc,
        ctx,
        token,
      );
      if (result.cancelled) return outcome("cancelled", "Research call cancelled");
      const scope = [
        archive ? "full archive" : "last 7 days",
        timeWindow(start, str(args.end_time)),
        sort === "relevancy" ? "most relevant first" : "newest first",
      ]
        .filter(Boolean)
        .join(", ");
      const reachedLimit = result.more && !result.error && !result.capped;
      const head = `X search for "${query}" (${scope}): ${count(result.posts.length, "post", "posts")} over ${count(result.pages, "page", "pages")}${reachedLimit ? `; X has more beyond limit ${limit}` : ""}.`;
      const details = {
        endpoint: archive ? "/2/tweets/search/all" : "/2/tweets/search/recent",
        pages: result.pages,
        returned: result.posts.length,
        more: result.more,
        capped: result.capped,
      };
      if (result.error && !result.posts.length) {
        return outcome("failed", `ERROR: ${result.error}\n${head}`, details);
      }
      const lines = [
        head,
        ...(result.error
          ? [`Page ${result.pages} failed or reported a problem, so later matches may be missing: ${result.error}`]
          : []),
        ...(result.capped
          ? [
              `Stopped at the ${MAX_SEARCH_PAGES}-page safety limit with ${result.posts.length} of the ${limit} posts asked for; X has more. Narrow the window with start_time and end_time to read further.`,
            ]
          : []),
        ...(result.posts.length
          ? ["", ZERO_NOTE, ...result.posts.flatMap((item) => formatListPost(item, inc))]
          : ["", "X found no posts matching this query."]),
      ];
      const status: OutcomeStatus =
        result.error || result.capped ? "partial" : result.posts.length ? "success" : "empty";
      return outcome(status, bounded(lines.join("\n")), details);
    }),
});

export const XCountPostsSchema = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "X search query whose matching posts to count.",
  }),
  archive: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "false (default): the last 7 days. true: the full archive, which needs start_time.",
  }),
  start_time: Schema.optionalKey(Schema.String).annotate({
    description: "Start of the counted window, ISO 8601. Required with archive true.",
  }),
  end_time: Schema.optionalKey(Schema.String).annotate({
    description: "End of the counted window, ISO 8601.",
  }),
  granularity: Schema.optionalKey(Schema.Literals(GRANULARITIES)).annotate({
    description: "Bucket size (default day).",
  }),
});

export const xCountPostsAction = defineAction({
  name: "x_count_posts",
  description:
    `Count X posts matching a query per minute, hour or day (default day) without reading them; archive true counts the full archive and needs start_time. ` +
    `Returns each bucket's count and the total. Follows at most ${MAX_COUNT_PAGES} pages of X's buckets; a count that needs more stops there and is partial, so narrow the window with start_time and end_time. Requires X_BEARER_TOKEN. X reports no per-call charge, so the cost is recorded as unknown (see ${X_API_DOCS_URL}).`,
  schema: XCountPostsSchema,
  // Billing omitted: X count requests report no per-call charge and return no posts/accounts.
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const token = bearerToken();
      if (!token) return failed(missingKey());
      const query = String(args.query ?? "").trim();
      if (!query) return failed("query is required: X search syntax, as on x.com search.");
      const archive = args.archive === true;
      if (archive && !str(args.start_time)) {
        return failed(
          `A full-archive count needs start_time (and may take end_time): a count from X's archive start in 2006 can run past the ${MAX_COUNT_PAGES} pages of X's buckets Dig follows and stop with an incomplete total. Pass the window to count; no request was sent.`,
        );
      }
      const granularity: Granularity =
        args.granularity && (GRANULARITIES as readonly string[]).includes(args.granularity)
          ? args.granularity
          : "day";
      const endpoint = archive ? "/2/tweets/counts/all" : "/2/tweets/counts/recent";
      const start = startTime(args, archive);
      const buckets: Array<{ readonly start: string; readonly end: string; readonly count: number }> = [];
      let reportedTotal: number | null = 0;
      let pageToken: string | null = null;
      let pages = 0;
      let error: string | null = null;

      do {
        if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
        pages += 1;
        const answer = yield* xRead(
          endpoint,
          {
            query,
            granularity,
            start_time: start ?? undefined,
            end_time: str(args.end_time) ?? undefined,
            next_token: pageToken ?? undefined,
          },
          pages === 1 ? "post counts" : `post counts, page ${pages}`,
          ctx,
          token,
        );
        if (!answer.ok) {
          if (answer.cancelled) return outcome("cancelled", "Research call cancelled");
          error = answer.message;
          break;
        }
        for (const bucket of dataItems(answer.body)) {
          const value = num(bucket.post_count ?? bucket.tweet_count);
          const bucketStart = str(bucket.start);
          if (bucketStart && value !== null) {
            buckets.push({ start: bucketStart, end: String(bucket.end ?? ""), count: value });
          }
        }
        const pageTotal = num(
          rec(answer.body.meta)?.total_post_count ?? rec(answer.body.meta)?.total_tweet_count,
        );
        reportedTotal =
          reportedTotal === null || pageTotal === null ? null : reportedTotal + pageTotal;
        pageToken = nextToken(answer.body);
        if (answer.problem) {
          error = answer.problem;
          break;
        }
      } while (pageToken && pages < MAX_COUNT_PAGES);

      const summed = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
      const total = reportedTotal ?? summed;
      const none = Boolean(error) && !buckets.length;
      const details = {
        endpoint,
        granularity,
        pages,
        buckets: buckets.length,
        ...(none ? {} : { total }),
        more: Boolean(pageToken),
      };
      const scope = [
        archive ? "full archive" : "last 7 days",
        timeWindow(start, str(args.end_time)),
        `per ${granularity}`,
      ]
        .filter(Boolean)
        .join(", ");
      const head = `X post counts for "${query}" (${scope})${none ? "" : `: ${count(total, "post", "posts")} in ${count(buckets.length, "bucket", "buckets")}`}.`;
      if (none) return outcome("failed", `ERROR: ${error}\n${head}`, details);
      const label = (bucketStart: string) =>
        granularity === "day" ? bucketStart.slice(0, 10) : utc(bucketStart);
      const lines = [
        head,
        ...(error
          ? [
              `Page ${pages} failed or reported a problem, so later buckets may be missing and the total may be incomplete: ${error}`,
            ]
          : []),
        ...(pageToken && !error
          ? [
              `Stopped after ${count(pages, "page", "pages")}; X has more buckets, so the total is incomplete. Narrow the window with start_time and end_time.`,
            ]
          : []),
        "",
        ...buckets.map((bucket) => `${label(bucket.start)}: ${bucket.count.toLocaleString("en-US")}`),
      ];
      const status: OutcomeStatus = error || pageToken ? "partial" : total > 0 ? "success" : "empty";
      return outcome(status, bounded(lines.join("\n")), details);
    }),
});
