/**
 * `x_users` and `x_follows`: account lookup, signed-in people search,
 * recent posts/mentions timelines, and following/followers pages.
 */
import { Effect, Schema } from "effect";
import type { PaidHttp } from "../../core/http.ts";
import { defineAction, failed, outcome } from "../../core/plugin.ts";
import {
  addIncludes,
  answered,
  bearerToken,
  bounded,
  clamp,
  count,
  dataItems,
  formatListPost,
  formatUser,
  haltLines,
  HANDLE,
  handleOf,
  KEY,
  lookupStatus,
  missingKey,
  missingOf,
  missingUserKeys,
  newIncludes,
  nextToken,
  noneReturned,
  notAttempted,
  num,
  PEOPLE_QUERY,
  PEOPLE_SEARCH_RESULTS,
  POST_PARAMS,
  problemList,
  READS_NOTE,
  rec,
  refusedLookup,
  SEARCH_PAGE,
  sectionLines,
  str,
  TIMELINE_MIN,
  USER_FIELDS,
  USER_PARAMS,
  userKeys,
  verifiedText,
  withProblem,
  X_READS_BILLING,
  xGet,
  xRead,
  ZERO_NOTE,
  type CallContext,
  type Halt,
  type Includes,
  type Json,
  type Section,
} from "./api-client.ts";

const FOLLOWS_LIMIT = 50;
const FOLLOWS_PAGE = { min: 1, max: 1000 } as const;
const DIRECTIONS = ["following", "followers"] as const;
type Direction = (typeof DIRECTIONS)[number];

function userTimeline(
  user: Json,
  kind: "tweets" | "mentions",
  wanted: number,
  inc: Includes,
  ctx: CallContext,
  token: string,
): Effect.Effect<Section, never, PaidHttp> {
  return Effect.gen(function* () {
    const handle = handleOf(user) ?? String(user.id);
    const label = kind === "tweets" ? `posts by @${handle}` : `mentions of @${handle}`;
    const answer = yield* xRead(
      `/2/users/${user.id}/${kind}`,
      { ...POST_PARAMS, max_results: clamp(wanted, TIMELINE_MIN, SEARCH_PAGE.max) },
      label,
      ctx,
      token,
    );
    if (answer.ok) addIncludes(inc, answer.body);
    const posts = answer.ok ? dataItems(answer.body).slice(0, wanted) : [];
    return {
      lines: [
        `${kind === "tweets" ? "Recent posts" : "Recent mentions"}: ${count(posts.length, "post", "posts")}.${posts.length ? ` ${ZERO_NOTE}` : ""}`,
        ...posts.flatMap((item) => formatListPost(item, inc)),
      ],
      failure: answer.ok ? answer.problem : answer.message,
    };
  });
}

function formatFollow(user: Json): string[] {
  const handle = handleOf(user);
  const m = rec(user.public_metrics);
  const flags = [verifiedText(user), user.protected === true ? "protected" : null].filter(Boolean);
  const counts: string[] = [];
  const add = (value: unknown, one: string, many: string) => {
    const n = num(value);
    if (n !== null) counts.push(count(n, one, many));
  };
  add(m?.followers_count, "follower", "followers");
  add(m?.following_count, "following", "following");
  add(m?.post_count ?? m?.tweet_count, "post", "posts");
  const joined = str(user.created_at);
  const body = [
    ...(str(user.description) ? [`Bio: ${user.description}`] : []),
    [
      str(user.location) ? `Location: ${user.location}` : null,
      joined ? `Joined ${joined.slice(0, 10)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    counts.join(" · "),
  ].filter((line) => line !== "");
  return [
    `- ${handle ? `@${handle}` : `user ${String(user.id ?? "")}`} — ${str(user.name) ?? "(no name)"}${flags.length ? ` (${flags.join(", ")})` : ""}`,
    ...body.map((line) => `  ${line}`),
  ];
}

export const XUsersSchema = Schema.Struct({
  handles: Schema.optionalKey(
    Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  ).annotate({
    description: "1-100 X handles, with or without @. Pass this or query.",
  }),
  query: Schema.optionalKey(Schema.String).annotate({
    description:
      "People search (needs X sign-in): letters, digits, underscores, apostrophes and spaces, up to 50 characters. Pass this or handles.",
  }),
  posts: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ).annotate({
    description: "Each account's most recent posts (default 0, max 100).",
  }),
  mentions: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ).annotate({
    description: "Recent posts mentioning each account (default 0, max 100).",
  }),
});

export const xUsersAction = defineAction({
  name: "x_users",
  description:
    "Read X accounts through the X API by 1-100 handles or signed-in people search (query), optionally with recent posts and mentions. " +
    `Profiles carry name, handle, bio, location, link, join date, verification and public counts; posts and mentions (0-100 each) add each account's most recent posts and posts mentioning it. Handles, posts and mentions use X_BEARER_TOKEN. People search needs X sign-in (X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET), because X serves it only to a signed-in account; it runs as that account. ${READS_NOTE}.`,
  schema: XUsersSchema,
  billing: X_READS_BILLING,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const handles: string[] = Array.isArray(args.handles)
        ? args.handles.map((handle) => String(handle).trim().replace(/^@/, ""))
        : [];
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (handles.length && query) return failed("Pass either handles or query, not both.");
      if (!handles.length && !query) {
        return failed("Pass handles (1-100 X handles) or query (a people search).");
      }
      const invalid = handles.filter((handle) => !HANDLE.test(handle));
      if (invalid.length) {
        return failed(
          `Not an X handle: ${invalid.map((handle) => `"${handle}"`).join(", ")}. A handle has 1-15 letters, digits or underscores.`,
        );
      }
      if (query && !PEOPLE_QUERY.test(query)) {
        return failed(
          "People search accepts letters, digits, underscores, apostrophes and spaces, up to 50 characters.",
        );
      }
      const posts = Number(args.posts ?? 0);
      const mentions = Number(args.mentions ?? 0);
      const token = bearerToken();
      const needsToken = handles.length > 0 || posts > 0 || mentions > 0;
      const keys = query ? userKeys() : null;
      if (keys && "missing" in keys) {
        return failed(
          `${missingUserKeys("People search", keys.missing)}${needsToken && !token ? ` Each account's posts and mentions also need ${KEY}.` : ""}`,
        );
      }
      if (needsToken && !token) return failed(missingKey());

      const wanted = [...new Map(handles.map((handle) => [handle.toLowerCase(), handle])).values()];
      const answer = keys
        ? yield* xRead(
            "/2/users/search",
            { ...USER_PARAMS, query, max_results: PEOPLE_SEARCH_RESULTS },
            "people search",
            ctx,
            keys,
          )
        : yield* xGet(
            "/2/users/by",
            { ...USER_PARAMS, usernames: wanted.join(",") },
            "account lookup",
            ctx,
            token ?? "",
          );

      if (!answer.ok) {
        if (answer.cancelled) return outcome("cancelled", "Research call cancelled");
        if (handles.length && answer.resource.length) {
          const refused = refusedLookup(wanted, answer, ["account", "accounts"], "@", null);
          return outcome(refused.status, refused.text, {
            returned: [],
            missing: refused.missing,
            failures: refused.status === "failed" ? [answer.message] : [],
          });
        }
        return failed(answer.message);
      }

      const inc = newIncludes();
      addIncludes(inc, answer.body);
      const found = dataItems(answer.body);
      const missing = handles.length
        ? missingOf(
            wanted,
            new Set(found.map((user) => String(user.username ?? "").toLowerCase())),
            answer.resources,
          )
        : [];
      const failures: string[] = answer.problem ? [answer.problem] : [];
      const blocks: string[][] = [];
      const halt: Halt = { by: null, skipped: 0 };
      const callCtx: CallContext = { ...ctx, halt };

      for (const user of found) {
        if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
        const sections: Section[] = [];
        if (posts > 0 && token && !notAttempted(callCtx, "posts", sections)) {
          sections.push(yield* userTimeline(user, "tweets", posts, inc, callCtx, token));
        }
        if (mentions > 0 && token && !notAttempted(callCtx, "mentions", sections)) {
          sections.push(yield* userTimeline(user, "mentions", mentions, inc, callCtx, token));
        }
        failures.push(...sections.flatMap((section) => (section.failure ? [section.failure] : [])));
        blocks.push([...formatUser(user), ...sectionLines(sections)]);
      }

      const status = handles.length
        ? lookupStatus(wanted.length - missing.length, missing, answer.resources, failures.length)
        : !found.length
          ? "empty"
          : failures.length
            ? "partial"
            : "success";
      const head = handles.length
        ? `${status === "failed" ? "ERROR: " : ""}X API: ${count(wanted.length - missing.length, "account", "accounts")} of ${wanted.length} requested.`
        : `X people search for "${query}": ${count(found.length, "account", "accounts")}.`;
      const lines = [
        head,
        ...missing.map((item) => `Not returned: @${item.id} — ${item.reason}`),
        ...(failures.length ? [`Some requested reads failed: ${failures.join(" | ")}`] : []),
        ...haltLines(halt),
        ...(!found.length && !handles.length ? ["", "X found no accounts for this search."] : []),
        ...blocks.flatMap((block) => ["", "---", "", ...block]),
      ];

      return outcome(status, bounded(lines.join("\n")), {
        returned: found.map((user) => String(user.username ?? user.id)),
        missing,
        failures,
      });
    }),
});

export const XFollowsSchema = Schema.Struct({
  handle: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "One X handle, with or without @.",
  }),
  direction: Schema.Literals(DIRECTIONS).annotate({
    description:
      "following: the accounts this account follows. followers: the accounts that follow it.",
  }),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: FOLLOWS_PAGE.min, maximum: FOLLOWS_PAGE.max })),
  ).annotate({
    description: "Accounts to return (default 50, max 1000). X bills every account returned.",
  }),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))).annotate({
    description: "The cursor a previous x_follows call printed, to read the next page.",
  }),
});

export const xFollowsAction = defineAction({
  name: "x_follows",
  description:
    "List who an X account follows (direction following) or who follows it (direction followers) through the X API, to see which community an account belongs to and who pays attention to it. Takes one handle (with or without @); returns one page of up to limit accounts (default 50, max 1000), each with name, handle, verification, bio, location, join date, follower, following and post counts, and the account's own totals. When X has more, the result gives the cursor and the exact call that reads the next page; Dig never reads further pages itself. " +
    `Requires X_BEARER_TOKEN. X bills every account returned, so ask for no more than the question needs. ${READS_NOTE}.`,
  schema: XFollowsSchema,
  billing: X_READS_BILLING,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const handle = String(args.handle ?? "").trim().replace(/^@/, "");
      if (!HANDLE.test(handle)) {
        return failed(`Not an X handle: "${handle}". A handle has 1-15 letters, digits or underscores.`);
      }
      const direction: Direction | null = (DIRECTIONS as readonly string[]).includes(args.direction)
        ? args.direction
        : null;
      if (!direction) {
        return failed(
          "direction must be following (the accounts this account follows) or followers (the accounts that follow it).",
        );
      }
      const limit = clamp(Number(args.limit ?? FOLLOWS_LIMIT), FOLLOWS_PAGE.min, FOLLOWS_PAGE.max);
      const cursor = typeof args.cursor === "string" ? args.cursor.trim() : "";
      const token = bearerToken();
      if (!token) return failed(missingKey());

      const lookup = yield* xGet(
        "/2/users/by",
        { "user.fields": USER_FIELDS.join(","), usernames: handle },
        "account lookup",
        ctx,
        token,
      );
      if (!lookup.ok) {
        if (lookup.cancelled) return outcome("cancelled", "Research call cancelled");
        if (lookup.resource.length) {
          const refused = refusedLookup([handle], lookup, ["account", "accounts"], "@", null);
          return outcome(refused.status, refused.text, {
            direction,
            returned: 0,
            missing: refused.missing,
          });
        }
        return failed(lookup.message);
      }

      const user = dataItems(lookup.body).find(
        (item) => String(item.username ?? "").toLowerCase() === handle.toLowerCase(),
      );
      if (!user || !str(user.id)) {
        const none = noneReturned([handle], lookup.resources, ["account", "accounts"], "@");
        return outcome(none.status, none.text, { direction, returned: 0, missing: none.missing });
      }

      const id = String(user.id);
      const name = handleOf(user) ?? handle;
      const total = num(
        rec(user.public_metrics)?.[direction === "following" ? "following_count" : "followers_count"],
      );
      const label = direction === "following" ? `accounts @${name} follows` : `followers of @${name}`;
      const answer = yield* xRead(
        `/2/users/${id}/${direction}`,
        { "user.fields": USER_FIELDS.join(","), max_results: limit, pagination_token: cursor || undefined },
        label,
        ctx,
        token,
      );

      const head = (returned: number) =>
        `${direction === "following" ? `Accounts @${name} follows` : `Accounts following @${name}`} on X: ${returned.toLocaleString("en-US")} returned${total === null ? "" : ` of ${total.toLocaleString("en-US")} in all`}.`;
      const details = (returned: number, next: string | null) => ({
        account: name,
        id,
        direction,
        returned,
        next,
        ...(total === null ? {} : { total }),
      });

      if (!answer.ok) {
        if (answer.cancelled) return outcome("cancelled", "Research call cancelled");
        if (answered(answer.resource, id)) {
          return outcome(
            "empty",
            [
              head(0),
              `Not returned: @${name}${user.protected === true ? " (protected)" : ""} — ${problemList(answer.resource)}`,
            ].join("\n"),
            details(0, null),
          );
        }
        return failed(answer.message);
      }

      const accounts = dataItems(answer.body);
      const next = nextToken(answer.body);
      const more = next
        ? [
            "",
            `X has more. Next page: x_follows with handle "${name}", direction "${direction}", limit ${limit} and cursor "${next}".`,
          ]
        : [];
      const problems = [lookup.problem, answer.problem].filter(
        (problem): problem is string => problem !== null,
      );
      if (!accounts.length && !problems.length) {
        return outcome("empty", [head(0), "", "X returned no accounts.", ...more].join("\n"), details(0, next));
      }
      return withProblem(
        problems.join(" | ") || null,
        [head(accounts.length), "", ...accounts.flatMap(formatFollow), ...more].join("\n"),
        details(accounts.length, next),
      );
    }),
});
