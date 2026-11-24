import { Effect, Result, Schema } from "effect";
import { freeRequest } from "../../core/http.ts";
import {
  defineAction,
  defineSource,
  failed,
  outcome,
  type SourcePlugin,
} from "../../core/plugin.ts";
import { USER_AGENT } from "../../version.ts";

const TIMEOUT_MS = 60_000;

interface HNHit {
  readonly objectID: string;
  readonly title?: string;
  readonly url?: string;
  readonly author: string;
  readonly points?: number | null;
  readonly num_comments?: number | null;
  readonly story_text?: string | null;
  readonly comment_text?: string | null;
  readonly story_title?: string | null;
  readonly story_url?: string | null;
  readonly created_at: string;
  readonly created_at_i: number;
  readonly _tags?: readonly string[];
}

interface HNSearchResponse {
  readonly hits: readonly HNHit[];
  readonly nbHits: number;
  readonly page?: number;
  readonly nbPages?: number;
  readonly hitsPerPage?: number;
}

interface HNItem {
  readonly id: number;
  readonly title?: string;
  readonly url?: string;
  readonly author: string | null;
  readonly text?: string | null;
  readonly points?: number | null;
  readonly type?: string;
  readonly created_at?: string;
  readonly created_at_i?: number;
  readonly children?: readonly HNItem[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** HN's HTML as text: paragraphs and line breaks become newlines, a link becomes its target, other tags are dropped, and &amp; is decoded last so escaped entities stay literal. */
export function hnText(html: string): string {
  return html
    .replace(/<\s*(?:p|br)\b[^>]*>/gi, "\n")
    .replace(/<a\b[^>]*?\bhref\s*=\s*"([^"]*)"[^>]*>[\s\S]*?<\/a\s*>/gi, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n: string) =>
      String.fromCodePoint(n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function excerpt(html: string, max: number): string {
  const text = hnText(html).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const hackernewsSearchSchema = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Search query.",
  }),
  days: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description: "Look back N days (default: 30).",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
      description: "Max results (default: 20, max: 50).",
    }),
  ),
  type: Schema.optionalKey(
    Schema.Literals(["story", "comment", "all"]).annotate({
      description:
        "Filter by result type. Story searches return only stories with more than 2 points; all-type and comment searches apply no points filter (comments carry no points).",
    }),
  ),
  sort: Schema.optionalKey(
    Schema.Literals(["relevance", "date"]).annotate({
      description: "Sort by relevance or newest first.",
    }),
  ),
});

export const hackernewsReadSchema = Schema.Struct({
  item: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Numeric item ID or https://news.ycombinator.com/item?id=... URL.",
  }),
  offset: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Comment offset, default 0.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })).annotate({
      description: "Comments to show, default 100.",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const hackernewsSearchAction = defineAction({
  name: "hackernews",
  description:
    "Search Hacker News for stories, Show HN posts, Ask HN threads, and comments. " +
    "Uses the Algolia HN Search API (free, no auth). " +
    "Returns results with points, comment counts, authors, and URLs. " +
    "Story searches return only stories with more than 2 points. All-type searches apply no points filter, because comments carry no points and the filter would remove every one; comment searches are unfiltered. " +
    "Can fetch full comment trees for top stories (recursive, single API call). " +
    "Best for tech community sentiment, startup news, and developer sentiment.",
  schema: hackernewsSearchSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (ctx.signal.aborted) return outcome("cancelled", "Hacker News search cancelled");

      const days = args.days ?? 30;
      const limit = Math.min(args.limit ?? 20, 50);
      const type = args.type ?? "story";
      const sortBy = args.sort ?? "relevance";

      const cutoffTimestamp = Math.floor(Date.now() / 1000) - days * 86400;

      let tagFilter = "";
      if (type === "story") {
        tagFilter = "&tags=story";
      } else if (type === "comment") {
        tagFilter = "&tags=comment";
      }

      const endpoint =
        sortBy === "date"
          ? "https://hn.algolia.com/api/v1/search_by_date"
          : "https://hn.algolia.com/api/v1/search";

      const pointsFilter = type === "story" ? ",points>2" : "";

      const url =
        `${endpoint}?query=${encodeURIComponent(args.query)}` +
        `&numericFilters=created_at_i>${cutoffTimestamp}${pointsFilter}` +
        `&hitsPerPage=${limit}` +
        tagFilter;

      const searchRes = yield* Effect.result(
        freeRequest({
          url,
          method: "GET",
          headers: { "User-Agent": USER_AGENT },
          timeoutMs: TIMEOUT_MS,
          signal: ctx.signal,
          label: "search",
          keep: ctx.keep,
        }),
      );

      if (Result.isFailure(searchRes)) {
        if (ctx.signal.aborted) return outcome("cancelled", "Hacker News search cancelled");
        return failed(`Failed to search Hacker News: ${searchRes.failure.message}`);
      }

      if (searchRes.success.status < 200 || searchRes.success.status >= 300) {
        return failed(`HN API returned ${searchRes.success.status}`);
      }

      const payloadRec = asRecord(searchRes.success.payload);
      if (!payloadRec || !Array.isArray(payloadRec.hits)) {
        return failed("Failed to search Hacker News: unexpected response payload");
      }

      const data: HNSearchResponse = {
        hits: payloadRec.hits as readonly HNHit[],
        nbHits: typeof payloadRec.nbHits === "number" ? payloadRec.nbHits : payloadRec.hits.length,
      };

      if (data.hits.length === 0) {
        return outcome(
          "empty",
          `No Hacker News results found for "${args.query}" in the last ${days} days.`,
        );
      }

      const commentTrees = new Map<string, HNItem>();
      let treeAttempts = 0;
      let treeFailures = 0;

      if (type === "story" || type === "all") {
        const highEngagement = data.hits
          .filter((h) => h._tags?.includes("story") && (h.num_comments ?? 0) >= 5)
          .sort((a, b) => (b.num_comments ?? 0) - (a.num_comments ?? 0))
          .slice(0, 5);
        treeAttempts = highEngagement.length;

        const treeEffects = highEngagement.map((hit) =>
          Effect.gen(function* () {
            const itemRes = yield* Effect.result(
              freeRequest({
                url: `https://hn.algolia.com/api/v1/items/${hit.objectID}`,
                method: "GET",
                headers: { "User-Agent": USER_AGENT },
                timeoutMs: TIMEOUT_MS,
                signal: ctx.signal,
                label: `item ${hit.objectID}`,
                keep: ctx.keep,
              }),
            );
            if (Result.isFailure(itemRes)) {
              treeFailures += 1;
              return;
            }
            if (itemRes.success.status >= 200 && itemRes.success.status < 300 && asRecord(itemRes.success.payload)) {
              commentTrees.set(hit.objectID, itemRes.success.payload as HNItem);
            } else {
              treeFailures += 1;
            }
          }),
        );

        yield* Effect.all(treeEffects, { concurrency: "unbounded" });
        if (ctx.signal.aborted) return outcome("cancelled", "Hacker News search cancelled");
      }

      const results = data.hits.map((hit) => {
        const isComment = hit._tags?.includes("comment");

        if (isComment) {
          const text = hit.comment_text ? excerpt(hit.comment_text, 300) : "(no text)";
          return [
            `**${hit.objectID}** (comment) by ${hit.author} on "${hit.story_title || "unknown"}"`,
            `  ${text}`,
            hit.story_url ? `  Story: ${hit.story_url}` : null,
            `  HN: https://news.ycombinator.com/item?id=${hit.objectID}`,
            `  Date: ${hit.created_at.split("T")[0]}`,
          ]
            .filter(Boolean)
            .join("\n");
        }

        const tags: string[] = [];
        if (hit._tags?.includes("show_hn")) tags.push("Show HN");
        if (hit._tags?.includes("ask_hn")) tags.push("Ask HN");

        const lines: Array<string | null> = [
          `**${hit.objectID}** ${tags.length > 0 ? `[${tags.join(", ")}] ` : ""}${hit.title || "(no title)"}`,
          `  Points: ${hit.points ?? "unavailable"} | Comments: ${hit.num_comments ?? "unavailable"} | Author: ${hit.author}`,
          hit.url ? `  URL: ${hit.url}` : null,
          `  HN: https://news.ycombinator.com/item?id=${hit.objectID}`,
          `  Date: ${hit.created_at.split("T")[0]}`,
          hit.story_text ? `  Text: ${excerpt(hit.story_text, 200)}` : null,
        ];

        const tree = commentTrees.get(hit.objectID);
        if (tree && tree.children && tree.children.length > 0) {
          lines.push("  Top comments:");
          const topComments = tree.children
            .filter((c) => c.author && c.text && c.author !== "[deleted]")
            .sort((a, b) => (b.children?.length ?? 0) - (a.children?.length ?? 0))
            .slice(0, 5);

          for (const comment of topComments) {
            const text = excerpt(comment.text || "", 250);
            const replyCount = comment.children?.length ?? 0;
            lines.push(`    💬 ${comment.author} (${replyCount} replies): ${text}`);
          }
        }

        return lines.filter(Boolean).join("\n");
      });

      const enrichedCount = commentTrees.size;
      const header = [
        `Hacker News results for "${args.query}" (last ${days} days, ${data.nbHits} total matches${pointsFilter ? " with more than 2 points" : ""}):`,
        `Showing ${data.hits.length} results sorted by ${sortBy}.` +
          (pointsFilter
            ? " Only items with more than 2 points were searched."
            : type === "all"
              ? " No points filter: comments carry no points, so items of every score are searched."
              : "") +
          (enrichedCount > 0 ? ` Comment trees fetched for ${enrichedCount} top stories.` : "") +
          (treeFailures > 0 ? ` ${treeFailures} of ${treeAttempts} comment-tree fetches failed.` : ""),
        "",
      ].join("\n");

      return outcome(treeFailures > 0 ? "partial" : "success", header + results.join("\n\n"));
    }),
});

export const hackernewsReadAction = defineAction({
  name: "hackernews_read",
  description:
    "Read a specific Hacker News story or comment by item ID or news.ycombinator.com item URL, with unshortened text and a bounded page of comments in the provider's order. Use offset to continue. No account or key required.",
  schema: hackernewsReadSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      let id = String(args.item ?? "").trim();
      if (id.startsWith("https://")) {
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(id);
        } catch {
          return failed("Use a Hacker News item URL or numeric ID");
        }
        if (parsedUrl.hostname !== "news.ycombinator.com" || parsedUrl.pathname !== "/item") {
          return failed("Use a Hacker News item URL or numeric ID");
        }
        id = parsedUrl.searchParams.get("id") ?? "";
      }
      if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
        return failed("item must be a positive safe integer ID or a Hacker News item URL");
      }
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 100;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 500
      ) {
        return failed("offset must be nonnegative and limit must be 1–500");
      }

      const itemRes = yield* Effect.result(
        freeRequest({
          url: `https://hn.algolia.com/api/v1/items/${id}`,
          method: "GET",
          headers: { "User-Agent": USER_AGENT },
          timeoutMs: TIMEOUT_MS,
          signal: ctx.signal,
          label: `item ${id}`,
          keep: ctx.keep,
        }),
      );

      if (Result.isFailure(itemRes)) {
        if (ctx.signal.aborted) return outcome("cancelled", "HN item read cancelled");
        return failed(itemRes.failure.message);
      }

      if (itemRes.success.status < 200 || itemRes.success.status >= 300) {
        return failed(`HN item read returned HTTP ${itemRes.success.status}`);
      }

      const rawRoot = itemRes.success.payload;
      if (rawRoot === null && itemRes.success.isJson) {
        return outcome("empty", `Hacker News returned no item for ${id}.`);
      }
      const root = asRecord(rawRoot);
      if (!root || String(root.id) !== id || !Array.isArray(root.children)) {
        return failed("HN returned an unexpected item payload");
      }

      const comments: Array<{ readonly item: Record<string, unknown>; readonly parent: number }> = [];
      const rootId = Number(root.id);
      const stack: Array<{ readonly item: unknown; readonly parent: number }> = [...root.children]
        .reverse()
        .map((item) => ({ item, parent: rootId }));
      let malformed = false;
      while (stack.length) {
        const entry = stack.pop()!;
        const rec = asRecord(entry.item);
        if (
          !rec ||
          typeof rec.id !== "number" ||
          !Number.isSafeInteger(rec.id) ||
          !Array.isArray(rec.children)
        ) {
          malformed = true;
          continue;
        }
        comments.push({ item: rec, parent: entry.parent });
        for (const child of [...rec.children].reverse()) {
          stack.push({ item: child, parent: rec.id });
        }
      }

      const show = (item: Record<string, unknown>, parent?: number): string =>
        [
          `## ${String(item.id)}${parent ? ` (reply to ${parent})` : ""}${typeof item.title === "string" ? ` — ${hnText(item.title)}` : ""}`,
          `HN: https://news.ycombinator.com/item?id=${String(item.id)}`,
          `Author: ${typeof item.author === "string" ? item.author : "unavailable/deleted"} | Date: ${typeof item.created_at === "string" ? item.created_at : "unavailable"}`,
          ...(typeof item.url === "string" ? [`Linked URL: ${item.url}`] : []),
          typeof item.text === "string" ? hnText(item.text) : "[No text returned]",
        ].join("\n");

      const selected = comments.slice(offset, offset + limit);
      const more = offset + selected.length < comments.length;
      const lines = [
        show(root),
        `\nComments: ${selected.length} shown of ${comments.length} returned; offset ${offset}.`,
        ...selected.map((entry) => show(entry.item, entry.parent)),
      ];
      if (more) {
        lines.push(
          `Continue with hackernews_read item=${id}, offset=${offset + selected.length}, limit=${limit}.`,
        );
      }
      if (malformed) {
        lines.push("Some descendant records were malformed; comment coverage is incomplete.");
      }
      return outcome(malformed ? "partial" : "success", lines.join("\n\n"));
    }),
});

export const hackernewsSource: SourcePlugin = defineSource({
  id: "hackernews",
  group: "code",
  label: "Hacker News",
  description: "Developer stories and discussions",
  about:
    "Hacker News stories and comment threads, searched through Algolia's public Hacker News index, with comment trees read for context. Useful for how developers and founders react to a launch, a tool or an idea.",
  providers: [{ name: "Algolia Hacker News search", url: "https://hn.algolia.com/api" }],
  billing: "Free. No account or key.",
  logo: "ycombinator",
  actions: [hackernewsSearchAction, hackernewsReadAction],
});

export default hackernewsSource;
