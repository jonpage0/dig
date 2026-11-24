/**
 * `x_bookmarks` and `x_likes`: signed-in account bookmarks, bookmark folders, and liked posts.
 */
import { Effect, Schema } from "effect";
import type { PaidHttp } from "../../core/http.ts";
import {
  defineAction,
  failed,
  outcome,
  type ActionOutcome,
  type OutcomeStatus,
} from "../../core/plugin.ts";
import {
  addIncludes,
  answered,
  authorOf,
  bearerToken,
  bounded,
  count,
  dataItems,
  editHistory,
  formatListPost,
  fullText,
  handleOf,
  KEY,
  lookupStatus,
  MAX_SEARCH_PAGES,
  missingKey,
  missingOf,
  missingUserKeys,
  newIncludes,
  nextToken,
  POST_PARAMS,
  readPages,
  READS_NOTE,
  rec,
  recs,
  references,
  refusedLookup,
  REPOST_TYPES,
  signedInAccount,
  str,
  textEntities,
  userKeys,
  X_READS_BILLING,
  xGet,
  xRead,
  ZERO_NOTE,
  type CallContext,
  type Failure,
  type Includes,
  type Json,
  type Missing,
} from "./api-client.ts";
import type { UserKeys } from "./oauth.ts";

const OWN_LIMIT = 50;
const BOOKMARKS_PAGE = { min: 1, max: 100 } as const;
const LIKES_PAGE = { min: 5, max: 100 } as const;
const LOOKUP_IDS = 100;
const FOLDER_PAGES = 10;
const FOLDER_PAGE_MAX = 100;
const OWNED_READS = `${READS_NOTE}.`;

interface MatchWord {
  readonly word: string;
  readonly pattern: RegExp;
}

const matchWords = (value: unknown): MatchWord[] =>
  (typeof value === "string" ? value.toLowerCase().split(/\s+/).filter(Boolean) : []).map((word) => ({
    word,
    pattern: new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu"),
  }));

function matchText(post: Json, inc: Includes): string {
  const author = authorOf(post, inc);
  const links = (item: Json) =>
    [...recs(textEntities(item)?.urls), ...recs(rec(item.entities)?.urls)].flatMap((link) =>
      [str(link.expanded_url), str(link.unwound_url)].filter((value): value is string => value !== null),
    );
  const carried = references(post)
    .filter((reference) => reference.type === "quoted" || REPOST_TYPES.has(String(reference.type)))
    .map((reference) => inc.posts.get(String(reference.id)))
    .filter((item): item is Json => item !== undefined);
  return [
    fullText(post),
    str(post.text),
    handleOf(author),
    str(author?.name),
    ...links(post),
    ...carried.flatMap((item) => [fullText(item), ...links(item)]),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

const matches = (post: Json, inc: Includes, words: readonly MatchWord[]): boolean => {
  const text = matchText(post, inc);
  return words.every(({ pattern }) => pattern.test(text));
};

interface OwnRead {
  readonly title: string;
  readonly noun: string;
  readonly posts: Json[];
  readonly more: boolean;
  readonly capped: boolean;
  readonly pages: number;
  readonly error: string | null;
  readonly missing: Missing[];
  readonly failures: string[];
  readonly incomplete?: string[];
  readonly lookup?: OutcomeStatus;
  readonly also?: string[];
}

function ownOutcome(
  read: OwnRead,
  words: readonly MatchWord[],
  inc: Includes,
  details: Record<string, unknown>,
): ActionOutcome {
  const shown = words.length ? read.posts.filter((post) => matches(post, inc, words)) : read.posts;
  const asked = words.map(({ word }) => word).join(" ");
  const matching = words.length ? `, ${count(shown.length, "post", "posts")} matching "${asked}"` : "";
  const head = `${read.title}: ${count(read.posts.length, "post", "posts")} read${matching}${read.more && !read.error ? "; X has more" : ""}.`;
  const problems = [
    ...(read.error
      ? [`Page ${read.pages} failed or reported a problem, so later posts may be missing: ${read.error}`]
      : []),
    ...(read.capped
      ? [`Stopped at the ${MAX_SEARCH_PAGES}-page safety limit with ${count(read.posts.length, "post", "posts")} read.`]
      : []),
    ...(read.failures.length ? [`Some requested reads failed: ${read.failures.join(" | ")}`] : []),
    ...(read.incomplete ?? []),
  ];
  const all = {
    ...details,
    read: read.posts.length,
    matching: shown.length,
    more: read.more,
    missing: read.missing,
    failures: read.failures,
  };
  if (!read.posts.length && (read.error || read.failures.length)) {
    return outcome(
      "failed",
      [
        `ERROR: ${read.error ?? read.failures[0]}`,
        head,
        ...read.missing.map((item) => `Not returned: ${item.id} — ${item.reason}`),
      ].join("\n"),
      all,
    );
  }
  const lines = [
    head,
    ...read.missing.map((item) => `Not returned: ${item.id} — ${item.reason}`),
    ...(read.also ?? []).map((problem) => `X also reported: ${problem}`),
    ...problems,
    "",
    ...(!read.posts.length
      ? [`X returned no ${read.noun}.`]
      : !shown.length
        ? [`None of the ${count(read.posts.length, "post", "posts")} read match "${asked}".`]
        : [ZERO_NOTE, ...shown.flatMap((post) => formatListPost(post, inc))]),
  ];
  const status: OutcomeStatus =
    problems.length || read.lookup === "partial" ? "partial" : shown.length ? "success" : "empty";
  return outcome(status, bounded(lines.join("\n")), all);
}

function bookmarkFolders(
  userId: string,
  keys: UserKeys,
  ctx: CallContext,
): Effect.Effect<
  { readonly ok: true; readonly folders: Json[]; readonly full: boolean; readonly problem: string | null } | Failure,
  never,
  PaidHttp
> {
  return Effect.gen(function* () {
    const folders: Json[] = [];
    let cursor: string | null = null;
    let full = false;
    for (let page = 1; page <= FOLDER_PAGES; page++) {
      const answer = yield* xRead(
        `/2/users/${userId}/bookmarks/folders`,
        { max_results: FOLDER_PAGE_MAX, pagination_token: cursor ?? undefined },
        `bookmark folders${page > 1 ? `, page ${page}` : ""}`,
        ctx,
        keys,
      );
      if (!answer.ok) return answer;
      const listed = dataItems(answer.body);
      folders.push(...listed);
      if (answer.problem) return { ok: true as const, folders, full: false, problem: answer.problem };
      cursor = nextToken(answer.body);
      full = !cursor && listed.length >= FOLDER_PAGE_MAX;
      if (!cursor) break;
    }
    return { ok: true as const, folders, full: full || Boolean(cursor), problem: null };
  });
}

function folderPostIds(
  userId: string,
  folderId: string,
  limit: number,
  keys: UserKeys,
  ctx: CallContext,
): Effect.Effect<
  {
    readonly ids: string[];
    readonly pages: number;
    readonly more: boolean;
    readonly capped: boolean;
    readonly full: boolean;
    readonly error: string | null;
    readonly cancelled?: boolean;
  },
  never,
  PaidHttp
> {
  return Effect.gen(function* () {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      if (ctx.signal.aborted) {
        return { ids, pages, more: true, capped: false, full: false, error: "Research call cancelled", cancelled: true };
      }
      pages += 1;
      const answer = yield* xRead(
        `/2/users/${userId}/bookmarks/folders/${folderId}`,
        { max_results: FOLDER_PAGE_MAX, pagination_token: cursor ?? undefined },
        `bookmark folder ${folderId}${pages > 1 ? `, page ${pages}` : ""}`,
        ctx,
        keys,
      );
      if (!answer.ok) {
        return {
          ids,
          pages,
          more: true,
          capped: false,
          full: false,
          error: answer.message,
          ...(answer.cancelled ? { cancelled: true } : {}),
        };
      }
      const listed = dataItems(answer.body);
      for (const item of listed) {
        const id = str(item.id);
        if (id && !ids.includes(id)) ids.push(id);
      }
      cursor = nextToken(answer.body);
      if (answer.problem) {
        return { ids: ids.slice(0, limit), pages, more: true, capped: false, full: false, error: answer.problem };
      }
      const full = !cursor && listed.length >= FOLDER_PAGE_MAX && ids.length < limit;
      if (!cursor || ids.length >= limit) {
        return {
          ids: ids.slice(0, limit),
          pages,
          more: Boolean(cursor) || ids.length > limit,
          capped: false,
          full,
          error: null,
        };
      }
      if (pages >= MAX_SEARCH_PAGES) {
        return { ids, pages, more: true, capped: true, full, error: null };
      }
    }
  });
}

function lookupPosts(
  ids: readonly string[],
  inc: Includes,
  ctx: CallContext,
  token: string,
): Effect.Effect<
  {
    readonly posts: Json[];
    readonly missing: Missing[];
    readonly failures: string[];
    readonly also: string[];
    readonly status: OutcomeStatus;
    readonly cancelled?: boolean;
  },
  never,
  PaidHttp
> {
  return Effect.gen(function* () {
    const found = new Map<string, Json>();
    const missing: Missing[] = [];
    const failures: string[] = [];
    const also: string[] = [];
    const resources: Json[] = [];
    const chunks = Array.from({ length: Math.ceil(ids.length / LOOKUP_IDS) }, (_, i) =>
      ids.slice(i * LOOKUP_IDS, (i + 1) * LOOKUP_IDS),
    );
    for (const [index, chunk] of chunks.entries()) {
      if (ctx.signal.aborted) {
        return { posts: [], missing, failures, also, status: "cancelled" as const, cancelled: true };
      }
      const answer = yield* xGet(
        "/2/tweets",
        { ...POST_PARAMS, ids: chunk.join(",") },
        chunks.length > 1 ? `post lookup ${index + 1} of ${chunks.length}` : "post lookup",
        ctx,
        token,
      );
      if (!answer.ok) {
        if (answer.cancelled) {
          return { posts: [], missing, failures, also, status: "cancelled" as const, cancelled: true };
        }
        resources.push(...answer.resource);
        const refused = refusedLookup(chunk, answer, ["post", "posts"], "", null);
        if (refused.status === "empty") {
          missing.push(...refused.missing);
          if (answer.problem) also.push(answer.problem);
        } else {
          failures.push(answer.message);
          missing.push(...refused.missing.filter((item) => answered(answer.resource, item.id)));
        }
        continue;
      }
      resources.push(...answer.resources);
      addIncludes(inc, answer.body);
      for (const post of dataItems(answer.body)) {
        for (const id of [String(post.id), ...editHistory(post)]) found.set(id, post);
      }
      if (answer.problem) failures.push(answer.problem);
      const unread = missingOf(
        chunk,
        new Set([...found.keys()].map((id) => id.toLowerCase())),
        answer.resources,
      );
      missing.push(...unread);
      const unanswered = unread.filter((item) => !answered(answer.resources, item.id)).length;
      if (unanswered) {
        failures.push(
          `X returned neither ${count(unanswered, "post", "posts")} nor an error naming ${unanswered === 1 ? "it" : "them"}`,
        );
      }
    }
    const posts = [...new Set(ids.map((id) => found.get(id)).filter((post): post is Json => post !== undefined))];
    const status =
      failures.length && !posts.length
        ? "failed"
        : lookupStatus(posts.length, missing, resources, failures.length);
    return { posts, missing, failures, also, status };
  });
}

export const XBookmarksSchema = Schema.Struct({
  folder: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))).annotate({
    description:
      "One bookmark folder: its name (case-insensitive, exact) or its numeric id. Without it, all bookmarks.",
  }),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 800 })),
  ).annotate({
    description: "Posts to read, newest first (default 50, max 800).",
  }),
  match: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))).annotate({
    description:
      "Keep posts matching every word as a case-insensitive word prefix in text, author, links or quoted/reposted post.",
  }),
});

export const xBookmarksAction = defineAction({
  name: "x_bookmarks",
  description:
    'Read the signed-in account\'s X bookmarks, newest first: limit posts (1-800, default 50), or those of one bookmark folder (folder: its name, matched case-insensitively, or its numeric id). match keeps only posts in which every one of its words starts a word (case-insensitive; "ai" matches AI, AI\'s and #AI but not brainstorm, "agent" matches agents) in their text, long-form text, author\'s handle or name, links\' addresses, or the text of a post they quote or repost; X has no search inside bookmarks, so Dig filters what it read and says how many posts it read and how many match. ' +
    `Needs X sign-in (X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET) and reads as that account; a folder lists post ids only, so its posts are read through the post lookup with X_BEARER_TOKEN. ${OWNED_READS}`,
  schema: XBookmarksSchema,
  billing: X_READS_BILLING,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const folder = typeof args.folder === "string" ? args.folder.trim() : "";
      const limit = Number(args.limit ?? OWN_LIMIT);
      const words = matchWords(args.match);
      const keys = userKeys();
      const token = bearerToken();
      if ("missing" in keys) {
        return failed(
          `${missingUserKeys(folder ? "Reading a bookmark folder" : "Reading bookmarks", keys.missing)}${folder && !token ? ` A folder's posts are then read through the post lookup, which also needs ${KEY}.` : ""}`,
        );
      }
      if (folder && !token) {
        return failed(
          `A bookmark folder lists post ids only, and Dig reads its posts through the post lookup, which needs ${KEY}. ${missingKey()}`,
        );
      }
      const me = yield* signedInAccount(keys, ctx);
      if (!me.ok) {
        return me.cancelled ? outcome("cancelled", "Research call cancelled") : failed(me.message);
      }
      const who = me.handle ? `@${me.handle}` : `account ${me.id}`;
      const inc = newIncludes();

      if (!folder) {
        const result = yield* readPages(
          {
            path: `/2/users/${me.id}/bookmarks`,
            params: {},
            limit,
            label: "bookmarks",
            cursor: "pagination_token",
            size: BOOKMARKS_PAGE,
          },
          inc,
          ctx,
          keys,
        );
        if (result.cancelled) return outcome("cancelled", "Research call cancelled");
        return ownOutcome(
          { title: `X bookmarks of ${who}`, noun: "bookmarks", ...result, missing: [], failures: [] },
          words,
          inc,
          { endpoint: "/2/users/:id/bookmarks" },
        );
      }

      const listed = yield* bookmarkFolders(me.id, keys, ctx);
      if (!listed.ok) {
        return listed.cancelled ? outcome("cancelled", "Research call cancelled") : failed(listed.message);
      }
      const chosen =
        listed.folders.find((item) => str(item.id) === folder) ??
        listed.folders.find((item) => String(item.name ?? "").toLowerCase() === folder.toLowerCase());
      const names = listed.folders.map((item) => `"${String(item.name ?? item.id)}"`);
      const shown = names.length
        ? `X listed ${count(names.length, "folder", "folders")}: ${names.join(", ")}.`
        : "X listed no bookmark folders.";
      if (!chosen) {
        if (listed.problem || listed.full) {
          const why =
            listed.problem ??
            `X's folder list returned ${FOLDER_PAGE_MAX} folders, its maximum per request, and no way to read further`;
          return failed(
            `Dig could not tell whether ${who} has a bookmark folder named or numbered "${folder}": the folder list was incomplete (${why}). ${shown}`,
          );
        }
        return failed(
          `${who} has no bookmark folder named or numbered "${folder}". ${names.length ? `X lists ${count(names.length, "folder", "folders")}: ${names.join(", ")}.` : "X lists no bookmark folders for this account."}`,
        );
      }

      const folderId = String(chosen.id);
      const name = str(chosen.name) ?? folderId;
      const listing = yield* folderPostIds(me.id, folderId, limit, keys, ctx);
      if (listing.cancelled) return outcome("cancelled", "Research call cancelled");
      const title = `X bookmarks of ${who}, folder "${name}"`;
      if (listing.error && !listing.ids.length) return failed(listing.error);

      const looked = listing.ids.length
        ? yield* lookupPosts(listing.ids, inc, ctx, token ?? "")
        : { posts: [] as Json[], missing: [] as Missing[], failures: [] as string[], also: [] as string[], status: "empty" as OutcomeStatus };
      if ("cancelled" in looked && looked.cancelled) {
        return outcome("cancelled", "Research call cancelled");
      }

      const incomplete = [
        ...(listed.problem
          ? [`The folder list reported a problem, though it listed this folder: ${listed.problem}`]
          : []),
        ...(listing.full
          ? [
              `X's folder endpoint returned ${FOLDER_PAGE_MAX} post ids, its maximum per request, and no way to read further; the folder may hold more.`,
            ]
          : []),
      ];
      return ownOutcome(
        {
          title,
          noun: "posts in this folder",
          posts: looked.posts,
          more: listing.more,
          capped: listing.capped,
          pages: listing.pages,
          error: listing.error,
          missing: looked.missing,
          failures: looked.failures,
          incomplete,
          lookup: looked.status,
          also: looked.also,
        },
        words,
        inc,
        { endpoint: "/2/users/:id/bookmarks/folders/:folder_id", folder: folderId, listed: listing.ids.length },
      );
    }),
});

export const XLikesSchema = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 800 })),
  ).annotate({
    description: "Liked posts to read, newest first (default 50, max 800).",
  }),
  match: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))).annotate({
    description:
      "Keep posts matching every word as a case-insensitive word prefix in text, author, links or quoted/reposted post.",
  }),
});

export const xLikesAction = defineAction({
  name: "x_likes",
  description:
    'Read the posts the signed-in X account has liked, newest first: limit posts (1-800, default 50). match keeps only posts in which every one of its words starts a word (case-insensitive; "ai" matches AI, AI\'s and #AI but not brainstorm, "agent" matches agents) in their text, long-form text, author\'s handle or name, links\' addresses, or the text of a post they quote or repost; X has no search inside likes, so Dig filters what it read and says how many posts it read and how many match. ' +
    `Needs X sign-in (X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET) and reads as that account. ${OWNED_READS}`,
  schema: XLikesSchema,
  billing: X_READS_BILLING,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const limit = Number(args.limit ?? OWN_LIMIT);
      const words = matchWords(args.match);
      const keys = userKeys();
      if ("missing" in keys) return failed(missingUserKeys("Reading liked posts", keys.missing));
      const me = yield* signedInAccount(keys, ctx);
      if (!me.ok) {
        return me.cancelled ? outcome("cancelled", "Research call cancelled") : failed(me.message);
      }
      const inc = newIncludes();
      const result = yield* readPages(
        {
          path: `/2/users/${me.id}/liked_tweets`,
          params: {},
          limit,
          label: "liked posts",
          cursor: "pagination_token",
          size: LIKES_PAGE,
        },
        inc,
        ctx,
        keys,
      );
      if (result.cancelled) return outcome("cancelled", "Research call cancelled");
      return ownOutcome(
        {
          title: `X posts liked by ${me.handle ? `@${me.handle}` : `account ${me.id}`}`,
          noun: "liked posts",
          ...result,
          missing: [],
          failures: [],
        },
        words,
        inc,
        { endpoint: "/2/users/:id/liked_tweets" },
      );
    }),
});
