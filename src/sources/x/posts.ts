/**
 * `x_post`: read 1-100 X posts by link or id, with optional author thread,
 * conversation replies, quote posts, reposters, and single-post TikHub fallback.
 */
import { Effect, Schema } from "effect";
import type { PaidHttp } from "../../core/http.ts";
import {
  defineAction,
  failed,
  outcome,
  setOutsideChat,
  type ActionOutcome,
} from "../../core/plugin.ts";
import {
  addIncludes,
  authorOf,
  bearerToken,
  bounded,
  byId,
  clamp,
  conversationStart,
  count,
  dataItems,
  editHistory,
  FALLBACK_KINDS,
  formatListPost,
  formatPost,
  formatTikhubPost,
  haltLines,
  handleOf,
  isoSecond,
  KEY,
  lookupStatus,
  MAX_SEARCH_PAGES,
  missingKey,
  missingOf,
  newIncludes,
  nextToken,
  notAttempted,
  POST_PARAMS,
  postId,
  postTime,
  QUOTES_MIN,
  READS_NOTE,
  RECENT_WINDOW_MS,
  refusedLookup,
  SEARCH_LIMIT_MAX,
  SEARCH_PAGE,
  searchPages,
  sectionLines,
  snowflakeTime,
  str,
  THREAD_PAGE,
  TIKHUB_LABEL,
  tikhubGet,
  tikhubKey,
  tikhubPost,
  USER_PARAMS,
  userLine,
  withheld,
  X_READS_BILLING,
  xGet,
  xRead,
  ZERO_NOTE,
  type CallContext,
  type Halt,
  type Includes,
  type Json,
  type SearchPages,
  type Section,
} from "./api-client.ts";

interface Extras {
  readonly thread: boolean;
  readonly replies: number;
  readonly quotes: number;
  readonly reposters: number;
}

const anyExtras = (extras: Extras): boolean =>
  extras.thread || extras.replies > 0 || extras.quotes > 0 || extras.reposters > 0;

type Searches = Map<string, SearchPages>;

function tikhubFallback(
  id: string,
  reason: string,
  extras: Extras,
  ctx: CallContext,
): Effect.Effect<ActionOutcome, never, PaidHttp> {
  return Effect.gen(function* () {
    const apiKey = tikhubKey();
    if (!apiKey) {
      return failed(
        `X post ${id} could not be read: ${reason}. The TikHub fallback needs TIKHUB_API_KEY, which is not set in Dig's keys.env either. ${setOutsideChat()}`,
      );
    }
    const detail = yield* tikhubGet("fetch_tweet_detail", { tweet_id: id }, TIKHUB_LABEL, apiKey, ctx);
    if ("error" in detail) {
      if (detail.cancelled) return outcome("cancelled", "Research call cancelled");
      return failed(
        `X post ${id} could not be read through the X API (${reason}) or TikHub (${detail.error}).`,
      );
    }
    const post = tikhubPost(detail.data);
    if (!post || post.id !== id || (!post.text && !post.media.length)) {
      return failed(
        `X post ${id} could not be read through the X API (${reason}), and TikHub fetch_tweet_detail did not return that post with its text or media.`,
      );
    }
    const unserved = anyExtras(extras);
    const lines = [
      `X post ${id} via TikHub: the X API could not serve it (${reason}).`,
      ...(unserved
        ? ["The thread, replies, quote posts and reposters need the X API; TikHub read only the post."]
        : []),
      "",
      ...formatTikhubPost(post),
    ];
    return outcome(unserved ? "partial" : "success", bounded(lines.join("\n")), {
      provider: "tikhub",
      via: "TikHub",
      requested: [id],
      returned: [post.id],
      author: post.handle,
      xApiFailure: reason,
    });
  });
}

function postNeighbourhood(
  post: Json,
  extras: Extras,
  inc: Includes,
  ctx: CallContext,
  token: string,
  requested: ReadonlySet<string>,
  searches: Searches,
): Effect.Effect<Section[], never, PaidHttp> {
  return Effect.gen(function* () {
    const id = String(post.id);
    const author = authorOf(post, inc);
    const from = handleOf(author) ?? str(post.author_id);
    const root = str(post.conversation_id) ?? id;
    const rootTime = snowflakeTime(root);
    const endpoint = rootTime !== null && Date.now() - rootTime < RECENT_WINDOW_MS ? "recent" : "all";
    const start = endpoint === "all" ? conversationStart(root) : undefined;
    const where = endpoint === "recent" ? "recent search" : `full-archive search from ${start}`;

    const search = (
      query: string,
      limit: number,
      label: string,
    ): Effect.Effect<SearchPages, never, PaidHttp> =>
      Effect.gen(function* () {
        const key = JSON.stringify([endpoint, query, start ?? null, limit]);
        const known = searches.get(key);
        if (known) return known;
        const result = yield* searchPages(
          endpoint,
          { query, sort_order: "recency", start_time: start },
          limit,
          label,
          inc,
          ctx,
          token,
        );
        if (!result.error) searches.set(key, result);
        return result;
      });

    const readOn = (query: string, posts: readonly Json[]): string => {
      const times = posts.flatMap((item) => postTime(item) ?? []);
      const oldest = times.length ? Math.min(...times) : null;
      const argsList = [
        `query "${query}"`,
        ...(start ? ["archive true", `start_time ${start}`] : []),
        ...(oldest === null ? [] : [`end_time ${isoSecond(oldest + 1000)}`]),
        `limit ${SEARCH_LIMIT_MAX}`,
      ];
      const call = `x_search_posts with ${argsList.slice(0, -1).join(", ")} and ${argsList.at(-1)}`;
      return oldest === null
        ? call
        : `${call}; it may repeat posts from ${isoSecond(oldest)}, the second of the oldest post read here`;
    };

    const coverage = (result: SearchPages, what: string, query: string): string[] =>
      result.more && !result.error
        ? [
            `Coverage incomplete: X has more ${what} than the ${count(result.posts.length, "post", "posts")} read here; read on with ${readOn(query, result.posts)}.`,
          ]
        : [];

    const shortfall = (result: SearchPages, what: string): string | null =>
      result.error ??
      (result.capped
        ? `the rest of ${what}: the search stopped at its ${MAX_SEARCH_PAGES}-page safety limit after ${count(result.posts.length, "post", "posts")}`
        : null);

    const sections: Section[] = [];
    const listed = new Set<string>([...requested, root]);

    if (extras.thread && !notAttempted(ctx, "thread", sections)) {
      const query = `conversation_id:${root} from:${from}`;
      const result: SearchPages = from
        ? yield* search(query, THREAD_PAGE, `thread of ${id}`)
        : {
            posts: [],
            pages: 0,
            more: false,
            capped: false,
            error: `thread of ${id}: X returned no author for this post, so its thread cannot be searched`,
          };
      const thread = result.posts.filter((item) => !requested.has(String(item.id))).sort(byId);
      for (const item of thread) listed.add(String(item.id));
      sections.push({
        lines: [
          `Thread: ${count(thread.length, "post", "posts")} by ${from ? `@${from}` : "the author"} in conversation ${root} (${where}), oldest first.${thread.length ? ` ${ZERO_NOTE}` : ""}`,
          ...coverage(result, "of this thread", query),
          ...thread.flatMap((item) => formatListPost(item, inc)),
        ],
        failure:
          shortfall(result, `the thread of ${id}`) ??
          (result.more
            ? `the rest of the thread of ${id}: Dig reads at most ${THREAD_PAGE} of a thread's posts in one call`
            : null),
      });
    }

    if (extras.replies > 0 && !notAttempted(ctx, "replies", sections)) {
      const query = `conversation_id:${root}${extras.thread && from ? ` -from:${from}` : ""}`;
      const result = yield* search(
        query,
        Math.min(extras.replies + 2, SEARCH_PAGE.max),
        `replies to ${id}`,
      );
      const kept = result.posts.filter((item) => !listed.has(String(item.id)));
      const replies = kept.slice(0, extras.replies);
      const shown = kept.length > replies.length ? { ...result, posts: replies, more: true } : result;
      sections.push({
        lines: [
          `Replies: ${count(replies.length, "post", "posts")} from conversation ${root}${extras.thread ? ", besides the author's thread" : ""} (${where}, newest first).${replies.length ? ` ${ZERO_NOTE}` : ""}`,
          ...coverage(shown, "replies in this conversation", query),
          ...replies.flatMap((item) => formatListPost(item, inc)),
        ],
        failure: shortfall(result, `the replies to ${id}`),
      });
    }

    if (extras.quotes > 0 && !notAttempted(ctx, "quote posts", sections)) {
      const answer = yield* xRead(
        `/2/tweets/${id}/quote_tweets`,
        { ...POST_PARAMS, max_results: clamp(extras.quotes, QUOTES_MIN, SEARCH_PAGE.max) },
        `quote posts of ${id}`,
        ctx,
        token,
      );
      if (answer.ok) addIncludes(inc, answer.body);
      const quotes = answer.ok ? dataItems(answer.body).slice(0, extras.quotes) : [];
      sections.push({
        lines: [
          `Quote posts: ${count(quotes.length, "post", "posts")}${answer.ok && nextToken(answer.body) ? " (X has more)" : ""}.${quotes.length ? ` ${ZERO_NOTE}` : ""}`,
          ...quotes.flatMap((item) => formatListPost(item, inc)),
        ],
        failure: answer.ok ? answer.problem : answer.message,
      });
    }

    if (extras.reposters > 0 && !notAttempted(ctx, "reposters", sections)) {
      const answer = yield* xRead(
        `/2/tweets/${id}/retweeted_by`,
        { ...USER_PARAMS, max_results: extras.reposters },
        `reposters of ${id}`,
        ctx,
        token,
      );
      if (answer.ok) addIncludes(inc, answer.body);
      const users = answer.ok ? dataItems(answer.body).slice(0, extras.reposters) : [];
      sections.push({
        lines: [
          `Reposted by: ${count(users.length, "account", "accounts")}${answer.ok && nextToken(answer.body) ? " (X has more)" : ""}.`,
          ...users.map(userLine),
        ],
        failure: answer.ok ? answer.problem : answer.message,
      });
    }

    return sections;
  });
}

export const XPostSchema = Schema.Struct({
  posts: Schema.Array(Schema.String)
    .check(Schema.isMinLength(1), Schema.isMaxLength(100))
    .annotate({
      description: "1-100 X posts: x.com or twitter.com status links, or numeric post ids.",
    }),
  thread: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Also read the author's own posts in each post's conversation (default false).",
  }),
  replies: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ).annotate({
    description: "Replies to read from each post's conversation, newest first (default 0, max 100).",
  }),
  quotes: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ).annotate({
    description: "Quote posts of each post to read (default 0, max 100).",
  }),
  reposters: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ).annotate({
    description: "Accounts that reposted each post (default 0, max 100).",
  }),
});

export const xPostAction = defineAction({
  name: "x_post",
  description:
    "Read 1-100 X posts by link or id through the X API: full text (long posts and X Articles), author, time, public counts, media, poll, quoted/replied-to post, language and links. " +
    "Optionally each post's thread by its author, replies from its conversation, quote posts and reposters (conversation reads use recent search for conversations under 7 days old, and full-archive search from the conversation's first post for older ones; when X has more than was read, the result says so and gives the x_search_posts call that reads on from the oldest post read). " +
    `Requires X_BEARER_TOKEN; when one post is requested and the X API cannot serve it (token missing, auth, credits, rate limit, server or network failure), the post is read through TikHub (TIKHUB_API_KEY) and labelled via TikHub. X saying the post is missing, protected or suspended is reported, never read through TikHub. ${READS_NOTE}; a post read through TikHub makes the cost unknown.`,
  schema: XPostSchema,
  billing: X_READS_BILLING,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const inputs: string[] = Array.isArray(args.posts) ? args.posts.map(String) : [];
      const invalid = inputs.filter((input) => !postId(input));
      if (!inputs.length) return failed("posts needs 1 to 100 X post links or numeric post ids.");
      if (invalid.length) {
        return failed(
          `Not an X post link or numeric post id: ${invalid.map((input) => `"${input}"`).join(", ")}. Use https://x.com/<handle>/status/<id> or the id itself.`,
        );
      }
      const ids = [...new Set(inputs.flatMap((input) => postId(input) ?? []))];
      const extras: Extras = {
        thread: args.thread === true,
        replies: Number(args.replies ?? 0),
        quotes: Number(args.quotes ?? 0),
        reposters: Number(args.reposters ?? 0),
      };
      const token = bearerToken();
      if (!token) {
        if (ids.length === 1) {
          return yield* tikhubFallback(ids[0], `${KEY} is not set in Dig's keys.env`, extras, ctx);
        }
        return failed(`${missingKey()} TikHub stands in only for a single post.`);
      }

      const lookup = yield* xGet("/2/tweets", { ...POST_PARAMS, ids: ids.join(",") }, "post lookup", ctx, token);
      if (!lookup.ok) {
        if (lookup.cancelled) return outcome("cancelled", "Research call cancelled");
        if (lookup.resource.length) {
          const refused = refusedLookup(ids, lookup, ["post", "posts"], "", withheld(lookup.resource, ids.length));
          return outcome(refused.status, refused.text, {
            provider: "x-api",
            requested: ids,
            returned: [],
            missing: refused.missing,
            failures: refused.status === "failed" ? [lookup.message] : [],
          });
        }
        if (ids.length === 1 && FALLBACK_KINDS.has(lookup.kind)) {
          return yield* tikhubFallback(ids[0], lookup.message, extras, ctx);
        }
        return failed(lookup.message);
      }

      const inc = newIncludes();
      addIncludes(inc, lookup.body);
      const found = dataItems(lookup.body);
      const returned = new Set(found.flatMap((item) => [String(item.id), ...editHistory(item)]));
      const missing = missingOf(ids, returned, lookup.resources);
      const requested = new Set(ids);
      const blocks: string[][] = [];
      const failures: string[] = lookup.problem ? [lookup.problem] : [];
      const searches: Searches = new Map();
      const halt: Halt = { by: null, skipped: 0 };
      const callCtx: CallContext = { ...ctx, halt };

      for (const item of found) {
        if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
        const sections = anyExtras(extras)
          ? yield* postNeighbourhood(item, extras, inc, callCtx, token, requested, searches)
          : [];
        failures.push(...sections.flatMap((section) => (section.failure ? [section.failure] : [])));
        blocks.push([...formatPost(item, inc), ...sectionLines(sections)]);
      }

      const status = lookupStatus(ids.length - missing.length, missing, lookup.resources, failures.length);
      const head = `${status === "failed" ? "ERROR: " : ""}X API: ${count(ids.length - missing.length, "post", "posts")} of ${ids.length} requested.`;
      const lines = [
        head,
        ...missing.map((item) => `Not returned: ${item.id} — ${item.reason}`),
        ...(status === "failed" && lookup.resources.length ? [withheld(lookup.resources, ids.length)] : []),
        ...(failures.length ? [`Some requested reads failed: ${failures.join(" | ")}`] : []),
        ...haltLines(halt),
        ...blocks.flatMap((block) => ["", "---", "", ...block]),
      ];

      return outcome(status, bounded(lines.join("\n")), {
        provider: "x-api",
        requested: ids,
        returned: found.map((item) => String(item.id)),
        missing,
        failures,
      });
    }),
});
