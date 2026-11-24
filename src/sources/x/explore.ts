/**
 * `x_news`, `x_explore`, and `x_community`.
 *
 * Dig 2.0 billing fix: `x_explore` uses `X_EXPLORE_BILLING` so `kind: "list"`
 * honestly counts returned X posts and accounts ("X post reads" / "X account reads"),
 * while `trends`, `spaces`, and `communities` remain unknown cost.
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
  answered,
  bearerToken,
  bounded,
  clamp,
  COMMUNITIES_MIN,
  COMMUNITY_FIELDS,
  communityId,
  communityLink,
  count,
  dataItems,
  EXPLORE_LIMIT,
  formatListPost,
  formatTikhubListPost,
  handleOf,
  KEY,
  listId,
  missingKey,
  missingUserKeys,
  newIncludes,
  NEWS_FIELDS,
  nextToken,
  noneReturned,
  num,
  NUMERIC_ID,
  permalink,
  POST_PARAMS,
  problemList,
  READS_NOTE,
  rec,
  recs,
  refusedLookup,
  SEARCH_PAGE,
  SPACE_EXPANSIONS,
  SPACE_FIELDS,
  stamp,
  str,
  strings,
  TIKHUB_PAGES,
  tikhubGet,
  tikhubKey,
  tikhubPost,
  TOPIC_FIELDS,
  TREND_FIELDS,
  TRENDS_LIMIT,
  TRENDS_MAX,
  USER_FIELDS,
  userKeys,
  withGap,
  withProblem,
  WORLDWIDE_WOEID,
  X_API_DOCS_URL,
  X_EXPLORE_BILLING,
  xGet,
  xRead,
  ZERO_NOTE,
  type CallContext,
  type Includes,
  type Json,
  type TikhubPost,
} from "./api-client.ts";

// ---------------------------------------------------------------------------
// x_news
// ---------------------------------------------------------------------------

function stringLists(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
    return items.length ? [`${path || "values"}: ${items.join(", ")}`] : [];
  }
  const record = rec(value);
  if (!record) return typeof value === "string" && value.trim() ? [`${path}: ${value}`] : [];
  return Object.entries(record).flatMap(([key, item]) =>
    stringLists(item, path ? `${path}.${key}` : key),
  );
}

function formatStory(story: Json): string[] {
  const posts = recs(story.cluster_posts_results).flatMap((item) => str(item.post_id) ?? []);
  const updated = str(story.updated_at);
  return [
    `X News story: ${str(story.name) ?? "(no name)"}`,
    [`id ${String(story.id ?? "?")}`, str(story.category), updated ? `updated ${updated}` : null]
      .filter(Boolean)
      .join(" · "),
    ...(str(story.hook) ? [`Hook: ${story.hook}`] : []),
    ...(str(story.summary) ? [`Summary: ${story.summary}`] : []),
    ...stringLists(story.contexts).map((line) => `Context ${line}`),
    ...stringLists(story.keywords, "keywords"),
    ...(posts.length ? [`Posts in this story (${posts.length}):`, ...posts.map((id) => `- ${permalink(id, null)}`)] : []),
    ...(str(story.disclaimer) ? [`Disclaimer: ${story.disclaimer}`] : []),
  ];
}

export const XNewsSchema = Schema.Struct({
  query: Schema.optionalKey(Schema.String).annotate({
    description: "Search X News stories. Pass this or id.",
  }),
  id: Schema.optionalKey(Schema.String).annotate({
    description: "One X News story id. Pass this or query.",
  }),
  max_age_hours: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 720 })),
  ).annotate({
    description: "With query: only stories updated within this many hours (X's default 168).",
  }),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  ).annotate({
    description: "With query: stories to return (X's default 10).",
  }),
});

export const xNewsAction = defineAction({
  name: "x_news",
  description:
    `Read X's News stories through the X API: search by query (optional max_age_hours 1-720, default 168, and limit 1-100, default 10) or read one story by id. Each story has its name, summary, hook, category, contexts (entities, topics, tickers), keywords and links to the posts it clusters. Requires X_BEARER_TOKEN. X reports no per-call charge, so the cost is recorded as unknown (see ${X_API_DOCS_URL}).`,
  schema: XNewsSchema,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (query && id) return failed("Pass either query or id, not both.");
      if (!query && !id) return failed("Pass query (a News search) or id (one story).");
      if (id && (args.max_age_hours !== undefined || args.limit !== undefined)) {
        return failed("max_age_hours and limit apply to a News search by query, not to a story id.");
      }
      if (id && !NUMERIC_ID.test(id)) return failed(`"${id}" is not an X News story id; ids are numeric.`);
      const token = bearerToken();
      if (!token) return failed(missingKey());

      const answer = id
        ? yield* xGet(`/2/news/${id}`, { "news.fields": NEWS_FIELDS.join(",") }, `news story ${id}`, ctx, token)
        : yield* xRead(
            "/2/news/search",
            {
              query,
              max_results: args.limit,
              max_age_hours: args.max_age_hours,
              "news.fields": NEWS_FIELDS.join(","),
            },
            "news search",
            ctx,
            token,
          );

      if (!answer.ok) {
        if (answer.cancelled) return outcome("cancelled", "Research call cancelled");
        if (id && answer.resource.length) {
          const refused = refusedLookup([id], answer, ["News story", "News stories"], "", null);
          return outcome(refused.status, refused.text, { stories: 0 });
        }
        return failed(answer.message);
      }

      const stories = dataItems(answer.body);
      if (!stories.length) {
        if (!id) {
          return outcome(
            "empty",
            `X News found no stories for "${query}"${args.max_age_hours ? ` in the last ${args.max_age_hours} hours` : ""}.`,
            { stories: 0 },
          );
        }
        const none = noneReturned([id], answer.resources, ["News story", "News stories"], "");
        return outcome(none.status, none.text, { stories: 0 });
      }
      const head = id
        ? `X News story ${id}.`
        : `X News search for "${query}": ${count(stories.length, "story", "stories")}.`;
      return withProblem(
        answer.problem,
        [head, ...stories.flatMap((story) => ["", "---", "", ...formatStory(story)])].join("\n"),
        { stories: stories.length },
      );
    }),
});

// ---------------------------------------------------------------------------
// x_explore
// ---------------------------------------------------------------------------

const KINDS = {
  trends: ["woeid", "limit"],
  spaces: ["query", "state", "limit"],
  communities: ["query", "limit"],
  list: ["list", "limit"],
} as const;
const EXPLORE_KINDS = ["trends", "spaces", "communities", "list"] as const;
type Kind = keyof typeof KINDS;
const KIND_ARGS = ["woeid", "query", "state", "list", "limit"] as const;
const SPACE_STATES = ["live", "scheduled", "all"] as const;

function formatSpace(space: Json, inc: Includes): string[] {
  const hosts = strings(space.host_ids)
    .map((id) => inc.users.get(id))
    .filter((user): user is Json => Boolean(user))
    .map((user) => `@${handleOf(user)}`);
  const topics = strings(space.topic_ids)
    .map((id) => str(inc.topics.get(id)?.name))
    .filter(Boolean);
  const when = str(space.started_at)
    ? `started ${stamp(space.started_at, null)}`
    : str(space.scheduled_start)
      ? `scheduled for ${stamp(space.scheduled_start, null)}`
      : null;
  const participants = num(space.participant_count);
  const reminders = num(space.subscriber_count);
  const facts = [
    str(space.state),
    when,
    participants === null ? null : count(participants, "participant", "participants"),
    reminders === null ? null : count(reminders, "reminder", "reminders"),
    space.is_ticketed === true ? "ticketed" : null,
    str(space.lang) ? `language ${space.lang}` : null,
  ].filter(Boolean);
  return [
    `- ${str(space.title) ?? "(untitled Space)"} · ${facts.join(" · ")}`,
    ...(hosts.length ? [`  Hosts: ${hosts.join(", ")}`] : []),
    ...(topics.length ? [`  Topics: ${topics.join(", ")}`] : []),
    `  https://x.com/i/spaces/${String(space.id ?? "")}`,
  ];
}

function formatCommunity(community: Json): string[] {
  const members = num(community.member_count);
  return [
    `- ${str(community.name) ?? "(unnamed Community)"} · ${[
      str(community.access),
      str(community.join_policy),
      members === null ? null : count(members, "member", "members"),
      str(community.created_at) ? `created ${String(community.created_at).slice(0, 10)}` : null,
    ]
      .filter(Boolean)
      .join(" · ")}`,
    `  ${communityLink(String(community.id ?? "?"))}`,
    ...(str(community.description) ? [`  ${community.description}`] : []),
  ];
}

function formatTikhubCommunity(community: Json): string[] {
  const members = num(community.member_count);
  const topic =
    str(community.primary_topic) ??
    str(rec(community.primary_topic)?.topic_name) ??
    str(rec(community.primary_topic)?.name);
  const facts = [
    members === null ? null : count(members, "member", "members"),
    topic ? `topic ${topic}` : null,
    community.is_nsfw === true ? "marked NSFW" : null,
  ].filter(Boolean);
  return [
    `- ${str(community.name) ?? "(unnamed Community)"}${facts.length ? ` · ${facts.join(" · ")}` : ""}`,
    `  ${communityLink(String(community.community_id ?? community.id ?? "?"))}`,
  ];
}

function tikhubCommunitySearch(
  query: string,
  wanted: number,
  apiKey: string,
  ctx: CallContext,
): Effect.Effect<ActionOutcome, never, PaidHttp> {
  return Effect.gen(function* () {
    const found: Json[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    let more = false;
    let capped = false;
    let error: string | null = null;

    for (;;) {
      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
      pages += 1;
      const page: { readonly data: Json } | { readonly error: string; readonly cancelled?: boolean } = yield* tikhubGet(
        "fetch_search_communities",
        { keyword: query, cursor: cursor ?? undefined },
        `fetch_search_communities via TikHub${pages > 1 ? `, page ${pages}` : ""}`,
        apiKey,
        ctx,
      );
      if ("error" in page) {
        if (page.cancelled) return outcome("cancelled", "Research call cancelled");
        error = page.error;
        break;
      }
      const before = found.length;
      for (const community of recs(page.data.communities)) {
        const id = str(community.community_id) ?? str(community.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        found.push(community);
      }
      cursor = str(page.data.next_cursor) ?? str(page.data.cursor);
      if (found.length >= wanted) {
        more = Boolean(cursor) || found.length > wanted;
        break;
      }
      if (!cursor || found.length === before) break;
      if (pages >= TIKHUB_PAGES) {
        more = true;
        capped = true;
        break;
      }
    }

    const communities = found.slice(0, wanted);
    const head = `X Communities search for "${query}" via TikHub: ${count(communities.length, "Community", "Communities")}${more ? " (TikHub has more)" : ""}.`;
    const details = { kind: "communities", items: communities.length, provider: "tikhub", via: "TikHub" };
    if (error && !communities.length) return outcome("failed", `ERROR: ${error}\n${head}`, details);
    if (!communities.length) return outcome("empty", `${head} TikHub found none.`, details);
    const cap = capped
      ? [
          `Stopped at the ${TIKHUB_PAGES}-page safety limit with ${count(communities.length, "Community", "Communities")} of the ${wanted} asked for; TikHub has more.`,
        ]
      : [];
    const lines = [
      head,
      ...(error ? [`Page ${pages} failed, so later Communities may be missing: ${error}`] : []),
      ...cap,
      "",
      ...communities.flatMap(formatTikhubCommunity),
    ];
    return outcome(error || capped ? "partial" : "success", bounded(lines.join("\n")), {
      ...details,
      capped,
    });
  });
}

export const XExploreSchema = Schema.Struct({
  kind: Schema.Literals(EXPLORE_KINDS).annotate({
    description:
      "trends (woeid, limit), spaces (query, state, limit), communities (query, limit) or list (list, limit).",
  }),
  woeid: Schema.optionalKey(Schema.Int).annotate({
    description: "trends: Yahoo! Where On Earth ID of the place (default 1, worldwide).",
  }),
  query: Schema.optionalKey(Schema.String).annotate({
    description:
      "spaces or communities: what to search for (communities runs signed in, or through TikHub without sign-in).",
  }),
  state: Schema.optionalKey(Schema.Literals(SPACE_STATES)).annotate({
    description: "spaces: which Spaces (default all).",
  }),
  list: Schema.optionalKey(Schema.String).annotate({
    description: "list: an X List id or link (https://x.com/i/lists/<id>).",
  }),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  ).annotate({
    description:
      "Items to return: trends up to 50 (default 20); spaces, communities and list default 25.",
  }),
});

export const xExploreAction = defineAction({
  name: "x_explore",
  description:
    "Explore X by kind: trends (woeid), spaces (query, state), communities (query) or list (List id/link). " +
    "Trends cap at 50 (default 20); spaces, communities and list cap at 100 (default 25). Arguments that do not belong to the kind are refused. Trends, Spaces and Lists use X_BEARER_TOKEN. Communities search runs signed in when X sign-in is set (X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET), because X serves it only to a signed-in account; otherwise it is read through TikHub (TIKHUB_API_KEY) and labelled via TikHub. Each Community comes with its link, which x_community reads. " +
    `For kind="list", ${READS_NOTE}. Trends, Spaces and Communities report no per-call charge, so their cost is recorded as unknown.`,
  schema: XExploreSchema,
  billing: X_EXPLORE_BILLING,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const kind: Kind = args.kind;
      if (!Object.hasOwn(KINDS, kind)) {
        return failed(`kind must be one of ${Object.keys(KINDS).join(", ")}.`);
      }
      const allowed: readonly string[] = KINDS[kind];
      const argsRecord = args as unknown as Record<string, unknown>;
      const stray = KIND_ARGS.filter((name) => argsRecord[name] !== undefined && !allowed.includes(name));
      if (stray.length) {
        return failed(
          `kind "${kind}" takes ${allowed.join(", ")}; ${stray.join(" and ")} ${stray.length === 1 ? "belongs" : "belong"} to another kind.`,
        );
      }
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if ((kind === "spaces" || kind === "communities") && !query) {
        return failed(`kind "${kind}" needs query.`);
      }
      const limit = args.limit === undefined ? null : Number(args.limit);
      if (kind === "trends" && limit !== null && limit > TRENDS_MAX) {
        return failed(`X returns at most ${TRENDS_MAX} trends; pass limit 1-${TRENDS_MAX}.`);
      }
      const list = kind === "list" ? listId(String(args.list ?? "")) : null;
      if (kind === "list" && !list) {
        return failed("list must be an X List id or link such as https://x.com/i/lists/<id>.");
      }
      const inc = newIncludes();

      if (kind === "communities") {
        const wanted = limit ?? EXPLORE_LIMIT;
        const keys = userKeys();
        if ("missing" in keys) {
          const apiKey = tikhubKey();
          if (!apiKey) {
            return failed(
              `Communities search needs X sign-in or TikHub. ${missingUserKeys("X's Communities search", keys.missing)} Without sign-in, Dig reads Communities search through TikHub, which needs TIKHUB_API_KEY, and that is not set in Dig's keys.env either.`,
            );
          }
          return yield* tikhubCommunitySearch(query, wanted, apiKey, ctx);
        }
        const answer = yield* xRead(
          "/2/communities/search",
          {
            query,
            max_results: clamp(wanted, COMMUNITIES_MIN, SEARCH_PAGE.max),
            "community.fields": COMMUNITY_FIELDS.join(","),
          },
          "Communities search",
          ctx,
          keys,
        );
        if (!answer.ok) {
          return answer.cancelled ? outcome("cancelled", "Research call cancelled") : failed(answer.message);
        }
        const communities = dataItems(answer.body).slice(0, wanted);
        const head = `X Communities search for "${query}": ${count(communities.length, "Community", "Communities")}${nextToken(answer.body) ? " (X has more)" : ""}.`;
        if (!communities.length) return outcome("empty", `${head} X found none.`, { kind, items: 0 });
        return withProblem(
          answer.problem,
          [head, "", ...communities.flatMap(formatCommunity)].join("\n"),
          { kind, items: communities.length },
        );
      }

      const token = bearerToken();
      if (!token) return failed(missingKey());

      if (kind === "trends") {
        const woeid = Number(args.woeid ?? WORLDWIDE_WOEID);
        const answer = yield* xRead(
          `/2/trends/by/woeid/${woeid}`,
          { max_trends: limit ?? TRENDS_LIMIT, "trend.fields": TREND_FIELDS.join(",") },
          `trends for WOEID ${woeid}`,
          ctx,
          token,
        );
        if (!answer.ok) {
          return answer.cancelled ? outcome("cancelled", "Research call cancelled") : failed(answer.message);
        }
        const trends = dataItems(answer.body);
        const place = woeid === WORLDWIDE_WOEID ? "worldwide (WOEID 1)" : `WOEID ${woeid}`;
        if (!trends.length) return outcome("empty", `X returned no trends for ${place}.`, { kind, items: 0 });
        const lines = trends.map((trend, index) => {
          const posts = num(trend.tweet_count ?? trend.post_count);
          return `${index + 1}. ${String(trend.trend_name ?? "(unnamed)")}${posts === null ? "" : ` — ${count(posts, "post", "posts")}`}`;
        });
        return withProblem(
          answer.problem,
          [`X trends ${place}: ${count(trends.length, "trend", "trends")}.`, "", ...lines].join("\n"),
          { kind, items: trends.length },
        );
      }

      if (kind === "spaces") {
        const state =
          args.state && (SPACE_STATES as readonly string[]).includes(args.state) ? args.state : "all";
        const answer = yield* xRead(
          "/2/spaces/search",
          {
            query,
            state,
            max_results: limit ?? EXPLORE_LIMIT,
            "space.fields": SPACE_FIELDS.join(","),
            expansions: SPACE_EXPANSIONS.join(","),
            "user.fields": USER_FIELDS.join(","),
            "topic.fields": TOPIC_FIELDS.join(","),
          },
          "Spaces search",
          ctx,
          token,
        );
        if (!answer.ok) {
          return answer.cancelled ? outcome("cancelled", "Research call cancelled") : failed(answer.message);
        }
        addIncludes(inc, answer.body);
        const spaces = dataItems(answer.body);
        const head = `X Spaces search for "${query}" (${state}): ${count(spaces.length, "Space", "Spaces")}.`;
        if (!spaces.length) return outcome("empty", `${head} X found none.`, { kind, items: 0 });
        return withProblem(
          answer.problem,
          [head, "", ...spaces.flatMap((space) => formatSpace(space, inc))].join("\n"),
          { kind, items: spaces.length },
        );
      }

      // kind === "list"
      const wanted = limit ?? EXPLORE_LIMIT;
      const answer = yield* xGet(
        `/2/lists/${list}/tweets`,
        { ...POST_PARAMS, max_results: wanted },
        `List ${list} posts`,
        ctx,
        token,
      );
      if (!answer.ok) {
        if (answer.cancelled) return outcome("cancelled", "Research call cancelled");
        if (answer.resource.length) {
          const refused = refusedLookup([String(list)], answer, ["List", "Lists"], "", null);
          return outcome(refused.status, refused.text, { kind, items: 0 });
        }
        return failed(answer.message);
      }
      addIncludes(inc, answer.body);
      const posts = dataItems(answer.body).slice(0, wanted);
      const head = `X List ${list} (https://x.com/i/lists/${list}): ${count(posts.length, "post", "posts")}, newest first${nextToken(answer.body) ? "; X has more" : ""}.`;
      if (!posts.length) {
        if (answered(answer.resources, String(list))) {
          const none = noneReturned([String(list)], answer.resources, ["List", "Lists"], "");
          return outcome(none.status, none.text, { kind, items: 0 });
        }
        if (answer.resources.length) {
          return failed(
            `X API List ${list} posts reported ${problemList(answer.resources)}, and returned no data`,
          );
        }
        return outcome("empty", `${head} X returned no posts.`, { kind, items: 0 });
      }
      return withProblem(
        answer.problem,
        [head, "", ZERO_NOTE, ...posts.flatMap((item) => formatListPost(item, inc))].join("\n"),
        { kind, items: posts.length },
      );
    }),
});

// ---------------------------------------------------------------------------
// x_community
// ---------------------------------------------------------------------------

const COMMUNITY_POSTS = 25;
const COMMUNITY_SORTS = ["recent", "relevant"] as const;

function communityDetails(community: Json): string[] {
  const members = num(community.member_count);
  return [
    [
      str(community.access),
      str(community.join_policy) ? `join policy ${community.join_policy}` : null,
      members === null ? null : count(members, "member", "members"),
      str(community.created_at) ? `created ${String(community.created_at).slice(0, 10)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    ...(str(community.description) ? [`Description: ${community.description}`] : []),
  ].filter((line) => line !== "");
}

function tikhubCommunityDetails(community: Json): string[] {
  const members = num(community.member_count);
  const created = num(community.created_at);
  const topic =
    str(community.primary_topic) ??
    str(rec(community.primary_topic)?.topic_name) ??
    str(rec(community.primary_topic)?.name);
  const rules = recs(community.rules).map(
    (rule, index) => `${index + 1}. ${[str(rule.name), str(rule.description)].filter(Boolean).join(": ")}`,
  );
  return [
    [
      members === null ? null : count(members, "member", "members"),
      created === null ? null : `created ${new Date(created).toISOString().slice(0, 10)}`,
      topic ? `topic ${topic}` : null,
      community.is_nsfw === true ? "marked NSFW" : null,
    ]
      .filter(Boolean)
      .join(" · "),
    ...(str(community.description) ? [`Description: ${community.description}`] : []),
    ...(rules.length ? ["Rules:", ...rules] : []),
  ].filter((line) => line !== "");
}

function tikhubCommunityPosts(
  id: string,
  wanted: number,
  ranking: string,
  apiKey: string,
  ctx: CallContext,
): Effect.Effect<
  {
    readonly posts: TikhubPost[];
    readonly pages: number;
    readonly more: boolean;
    readonly capped: boolean;
    readonly error: string | null;
    readonly cancelled?: boolean;
  },
  never,
  PaidHttp
> {
  return Effect.gen(function* () {
    const posts: TikhubPost[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    for (;;) {
      if (ctx.signal.aborted) {
        return { posts: posts.slice(0, wanted), pages, more: true, capped: false, error: "Research call cancelled", cancelled: true };
      }
      pages += 1;
      const page: { readonly data: Json } | { readonly error: string; readonly cancelled?: boolean } = yield* tikhubGet(
        "fetch_community_timeline",
        { community_id: id, ranking, cursor: cursor ?? undefined },
        `fetch_community_timeline via TikHub${pages > 1 ? `, page ${pages}` : ""}`,
        apiKey,
        ctx,
      );
      if ("error" in page) {
        return {
          posts: posts.slice(0, wanted),
          pages,
          more: true,
          capped: false,
          error: page.error,
          ...(page.cancelled ? { cancelled: true } : {}),
        };
      }
      const before = posts.length;
      for (const item of recs(page.data.timeline)) {
        const post = tikhubPost(item);
        if (!post || seen.has(post.id)) continue;
        seen.add(post.id);
        posts.push(post);
      }
      cursor = str(page.data.cursor) ?? str(page.data.next_cursor);
      if (posts.length >= wanted) {
        return {
          posts: posts.slice(0, wanted),
          pages,
          more: Boolean(cursor) || posts.length > wanted,
          capped: false,
          error: null,
        };
      }
      if (!cursor || posts.length === before) {
        return { posts, pages, more: false, capped: false, error: null };
      }
      if (pages >= TIKHUB_PAGES) {
        return { posts, pages, more: true, capped: true, error: null };
      }
    }
  });
}

export const XCommunitySchema = Schema.Struct({
  community: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "An X Community id or link (https://x.com/i/communities/<id>).",
  }),
  posts: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 })),
  ).annotate({
    description:
      "The Community's posts to read through TikHub (default 25, max 500; 0 reads details only).",
  }),
  sort: Schema.optionalKey(Schema.Literals(COMMUNITY_SORTS)).annotate({
    description:
      "recent (default): TikHub's Recency ranking, shown newest first (not strictly by time across pages); relevant: TikHub's Relevance ranking, in its order.",
  }),
});

export const xCommunityAction = defineAction({
  name: "x_community",
  description:
    "Read one X Community by id or link: its details and up to 500 posts via TikHub (default 25; 0 reads details only). " +
    "sort recent (default) reads TikHub's Recency ranking and shows the posts read newest first by their own time; TikHub's ranking is not strictly by time, so a newer post may sit on a later page. sort relevant reads TikHub's Relevance ranking and keeps its order. " +
    `Details come from X's Community lookup with X_BEARER_TOKEN, or through TikHub (TIKHUB_API_KEY) without it. X's API has no Community timeline for an app, so the posts are always read through TikHub, labelled via TikHub; without TIKHUB_API_KEY the call returns the details and says the posts need it. Members are not read. X and TikHub report no per-call charge, so the cost is recorded as unknown (see ${X_API_DOCS_URL}).`,
  schema: XCommunitySchema,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const id = communityId(String(args.community ?? ""));
      if (!id) {
        return failed("community must be an X Community id or link such as https://x.com/i/communities/<id>.");
      }
      const wanted = Number(args.posts ?? COMMUNITY_POSTS);
      const recent = args.sort !== "relevant";
      const token = bearerToken();
      const apiKey = tikhubKey();
      if (!token && !apiKey) {
        return failed(
          `x_community reads a Community's details with ${KEY} or through TikHub, and its posts through TikHub; neither ${KEY} nor TIKHUB_API_KEY is set in Dig's keys.env. ${setOutsideChat(true)}`,
        );
      }

      const failures: string[] = [];
      let name: string | null = null;
      let details: string[] = [];
      let source: string | null = null;

      if (token) {
        const answer = yield* xGet(
          `/2/communities/${id}`,
          { "community.fields": COMMUNITY_FIELDS.join(",") },
          `Community ${id}`,
          ctx,
          token,
        );
        if (!answer.ok && answer.cancelled) return outcome("cancelled", "Research call cancelled");
        if (!answer.ok && answer.resource.length) {
          const refused = refusedLookup([id], answer, ["Community", "Communities"], "", null);
          return outcome(refused.status, refused.text, { community: id, posts: 0 });
        }
        const data = answer.ok ? rec(answer.body.data) : null;
        if (answer.ok && !data) {
          const none = noneReturned([id], answer.resources, ["Community", "Communities"], "");
          return outcome(none.status, none.text, { community: id, posts: 0 });
        }
        if (!answer.ok) failures.push(answer.message);
        else if (data) {
          name = str(data.name);
          details = communityDetails(data);
          source = "X API";
          if (answer.problem) failures.push(answer.problem);
        }
      } else if (apiKey) {
        const info = yield* tikhubGet(
          "fetch_community_info",
          { community_id: id },
          "fetch_community_info via TikHub",
          apiKey,
          ctx,
        );
        if ("error" in info) {
          if (info.cancelled) return outcome("cancelled", "Research call cancelled");
          failures.push(info.error);
        } else if (!str(info.data.name)) {
          failures.push(`TikHub fetch_community_info returned no Community ${id}`);
        } else {
          name = str(info.data.name);
          details = tikhubCommunityDetails(info.data);
          source = "TikHub";
        }
      }

      let postLines: string[] = [];
      let postsRead = 0;
      if (wanted > 0) {
        if (!apiKey) {
          failures.push(
            `the Community's posts: Dig reads them through TikHub, which needs TIKHUB_API_KEY, and it is not set in Dig's keys.env; ${setOutsideChat()}`,
          );
        } else {
          const result = yield* tikhubCommunityPosts(
            id,
            wanted,
            recent ? "Recency" : "Relevance",
            apiKey,
            ctx,
          );
          if (result.cancelled) return outcome("cancelled", "Research call cancelled");
          postsRead = result.posts.length;
          if (result.error) failures.push(result.error);
          if (result.capped) {
            failures.push(
              `the rest of the Community's posts: TikHub paging stopped at its ${TIKHUB_PAGES}-page safety limit after ${count(postsRead, "post", "posts")} of the ${wanted} asked for`,
            );
          }
          const shown = recent
            ? result.posts
                .map((post, index) => ({ post, index, at: Date.parse(post.createdAt ?? "") }))
                .sort(
                  (a, b) =>
                    (Number.isNaN(b.at) ? -1 : Number.isNaN(a.at) ? 1 : b.at - a.at) ||
                    a.index - b.index,
                )
                .map(({ post }) => post)
            : result.posts;
          const order = recent
            ? `${count(postsRead, "post", "posts")} read through TikHub's Recency ranking, shown newest first${result.more && !result.error ? "; TikHub has more" : ""}. TikHub's ranking is not strictly by time, so a newer post may sit on a later page.`
            : `${count(postsRead, "post", "posts")} read in TikHub's Relevance ranking, in its order${result.more && !result.error ? "; TikHub has more" : ""}.`;
          postLines = [
            `Posts via TikHub: ${order}`,
            ...(result.error && postsRead
              ? [`Page ${result.pages} failed, so later posts may be missing: ${result.error}`]
              : []),
            ...(postsRead
              ? [ZERO_NOTE, ...shown.flatMap(formatTikhubListPost)]
              : result.error
                ? []
                : ["TikHub returned no posts for this Community."]),
          ];
        }
      }

      const head = `X Community ${id}${name ? ` "${name}"` : ""} (${communityLink(id)}): ${source ? `details ${source === "TikHub" ? "via TikHub" : "from the X API"}` : "details not read"}${wanted > 0 ? `, ${count(postsRead, "post", "posts")} via TikHub` : ""}.`;
      const lines = [
        head,
        ...(failures.length ? [`Not read: ${failures.join(" | ")}`] : []),
        ...withGap(details),
        ...withGap(postLines),
      ];
      const resultDetails = {
        community: id,
        details: source,
        posts: postsRead,
        ...(source === "TikHub" || postsRead ? { via: "TikHub" } : {}),
      };
      if (failures.length && !source && !postsRead) {
        return outcome("failed", bounded([`ERROR: ${failures[0]}`, ...lines].join("\n")), resultDetails);
      }
      return outcome(failures.length ? "partial" : "success", bounded(lines.join("\n")), resultDetails);
    }),
});
