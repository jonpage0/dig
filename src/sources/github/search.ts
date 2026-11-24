import { Effect, Schema } from "effect";
import { defineAction, failed, outcome } from "../../core/plugin.ts";
import {
  apiUrl,
  asArray,
  asNumber,
  asRecord,
  asString,
  authLabel,
  clampInt,
  describeFailure,
  fmtDate,
  fmtNum,
  githubRequest,
  isMarkedPublic,
  resolveAuth,
  truncate,
} from "./client.ts";

const SEARCH_RESULT_CAP = 1_000;
const SEARCH_DEFAULT_PER_PAGE = 20;
const SEARCH_MAX_PER_PAGE = 100;
const SEARCH_SORT_VALUES = [
  "best-match",
  "stars",
  "forks",
  "help-wanted-issues",
  "updated",
] as const;
const SEARCH_ORDER_VALUES = ["desc", "asc"] as const;

interface SearchItem {
  readonly fullName: string;
  readonly htmlUrl: string;
  readonly description: string | null;
  readonly language: string | null;
  readonly license: string | null;
  readonly stars: number | null;
  readonly forks: number | null;
  readonly openIssuesAndPrs: number | null;
  readonly archived: boolean;
  readonly fork: boolean;
  readonly createdAt: string | null;
  readonly pushedAt: string | null;
  readonly topics: readonly string[];
}

function normalizeSearchItem(raw: unknown): SearchItem | null {
  const record = asRecord(raw);
  const fullName = asString(record?.full_name);
  if (!record || !fullName || !isMarkedPublic(record)) return null;
  const license = asRecord(record.license);
  return {
    fullName,
    htmlUrl: asString(record.html_url) ?? `https://github.com/${fullName}`,
    description: asString(record.description),
    language: asString(record.language),
    license: asString(license?.spdx_id) ?? asString(license?.name),
    stars: asNumber(record.stargazers_count),
    forks: asNumber(record.forks_count),
    openIssuesAndPrs: asNumber(record.open_issues_count),
    archived: record.archived === true,
    fork: record.fork === true,
    createdAt: asString(record.created_at),
    pushedAt: asString(record.pushed_at),
    topics: asArray(record.topics)
      .map(asString)
      .filter((topic): topic is string => topic !== null),
  };
}

function formatSearchItem(item: SearchItem, index: number): string {
  const flags: string[] = [];
  if (item.archived) flags.push("ARCHIVED");
  if (item.fork) flags.push("fork");
  const lines = [
    `${index + 1}. ${item.fullName}${flags.length ? ` [${flags.join(", ")}]` : ""}`,
    `   Stars: ${fmtNum(item.stars)} | Forks: ${fmtNum(item.forks)} | Open issues+PRs: ${fmtNum(item.openIssuesAndPrs)} | Language: ${item.language ?? "n/a"} | License: ${item.license ?? "none detected"}`,
    `   Created: ${fmtDate(item.createdAt)} | Last push (any branch): ${fmtDate(item.pushedAt)} | ${item.htmlUrl}`,
  ];
  if (item.description) lines.push(`   ${truncate(item.description, 220)}`);
  if (item.topics.length) {
    lines.push(
      `   Topics: ${item.topics.slice(0, 12).join(", ")}${item.topics.length > 12 ? ", …" : ""}`,
    );
  }
  return lines.join("\n");
}

export const githubSearchSchema = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      "Repository search query with optional GitHub qualifiers (in:name,description,readme, topic:, language:, created:, pushed:, stars:, archived:false, fork:). is:public is always appended; is:private, is:internal, visibility:, and negated is:public are rejected.",
  }),
  sort: Schema.optionalKey(
    Schema.Literals(SEARCH_SORT_VALUES).annotate({
      description: "Sort order (default: best-match).",
    }),
  ),
  order: Schema.optionalKey(
    Schema.Literals(SEARCH_ORDER_VALUES).annotate({
      description: "Sort direction (default: desc); ignored for best-match.",
    }),
  ),
  page: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description: "Result page (default: 1). page * perPage may not exceed GitHub's 1,000-result cap.",
    }),
  ),
  perPage: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SEARCH_MAX_PER_PAGE })).annotate({
      description: "Results per page (default: 20, max: 100).",
    }),
  ),
});

export const githubSearchAction = defineAction({
  name: "github_search",
  description:
    "Search public GitHub repositories with GitHub's native repository search. The query is forced to is:public and supports GitHub qualifiers (in:name,description,readme, topic:, language:, created:, pushed:, stars:, archived:false, fork:). " +
    "Returns total_count, incomplete_results, the explicit query sent, and per-repo stars, forks, license, language, created and pushed dates, topics. " +
    "GitHub exposes at most 1,000 results per query; search has its own rate limit (30/min authenticated, 10/min anonymous). Uses GH_TOKEN, GITHUB_TOKEN, or gh auth token when available.",
  schema: githubSearchSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const query = asString(args.query);
      if (!query) return failed("query is required");
      if (/(?:^|[\s"'(])(?:-|NOT\s+)is:public\b|\bis:(?:private|internal)\b|\bvisibility:/i.test(query)) {
        return failed(
          "github_search reads public repositories only; remove is:private, is:internal, visibility:, and negated is:public from the query",
        );
      }
      const sort = args.sort ?? "best-match";
      if (!(SEARCH_SORT_VALUES as readonly string[]).includes(sort)) {
        return failed(`sort must be one of ${SEARCH_SORT_VALUES.join(", ")}`);
      }
      const order = args.order ?? "desc";
      if (!(SEARCH_ORDER_VALUES as readonly string[]).includes(order)) {
        return failed(`order must be one of ${SEARCH_ORDER_VALUES.join(", ")}`);
      }
      const perPage = clampInt(args.perPage, SEARCH_DEFAULT_PER_PAGE, 1, SEARCH_MAX_PER_PAGE);
      const page = clampInt(args.page, 1, 1, Number.MAX_SAFE_INTEGER);
      const lastPage = Math.ceil(SEARCH_RESULT_CAP / perPage);
      if (page > lastPage) {
        return failed(
          `GitHub search exposes at most ${fmtNum(SEARCH_RESULT_CAP)} results per query; with perPage ${perPage} the last page is ${lastPage}`,
        );
      }

      const effectiveQuery = `${query} is:public`;
      const auth = yield* resolveAuth(ctx.signal);
      const req = yield* githubRequest(
        apiUrl("/search/repositories", {
          q: effectiveQuery,
          sort: sort === "best-match" ? undefined : sort,
          order: sort === "best-match" ? undefined : order,
          per_page: perPage,
          page,
        }),
        auth,
        ctx,
      );
      if (!req.ok) {
        return req.cancelled
          ? outcome("cancelled", "GitHub search cancelled")
          : failed(`GitHub search failed: ${req.error}`);
      }

      const { response } = req;
      const record = asRecord(response.payload);
      if (response.status !== 200 || !record) {
        return failed(describeFailure(response, "repository search"));
      }

      const total = asNumber(record.total_count);
      const incomplete = record.incomplete_results;
      if (total === null || typeof incomplete !== "boolean" || !Array.isArray(record.items)) {
        return failed(
          "GitHub search returned HTTP 200 without a search result envelope (numeric total_count, boolean incomplete_results, items array); no match count is available",
        );
      }

      const rawItems = record.items;
      const items = rawItems
        .map(normalizeSearchItem)
        .filter((item): item is SearchItem => item !== null);
      const withheld = rawItems.length - items.length;
      const retrievable = Math.min(total, SEARCH_RESULT_CAP);
      const firstIndex = (page - 1) * perPage + 1;
      const lastIndex = firstIndex + rawItems.length - 1;
      const hasMore = rawItems.length > 0 && lastIndex < retrievable;

      const header = [
        `GitHub repository search (${authLabel(auth)})`,
        `Query sent: ${effectiveQuery}`,
        `Sort: ${sort}${sort === "best-match" ? "" : ` ${order}`} | Page ${page} | Per page ${perPage}`,
        `Total matches reported by GitHub: ${fmtNum(total)} | incomplete_results: ${incomplete}${incomplete ? " (GitHub hit its query time limit; matches may be missing)" : ""}`,
        rawItems.length === 0
          ? "Showing 0 results."
          : `Showing results ${fmtNum(firstIndex)}–${fmtNum(lastIndex)} of ${fmtNum(retrievable)} retrievable${total > SEARCH_RESULT_CAP ? ` (GitHub caps retrieval at ${fmtNum(SEARCH_RESULT_CAP)} of ${fmtNum(total)})` : ""}. ${hasMore ? `More pages available (next page ${page + 1}).` : "No further pages."}`,
        withheld > 0
          ? `Withheld ${withheld} returned item(s) not explicitly marked public (private=false, visibility=public); they are not listed.`
          : null,
        "Ranking is GitHub's; relevance to the topic must still be judged per repository. Star counts are current totals, not growth.",
        response.rateLimit.remaining !== null
          ? `Search rate limit remaining: ${response.rateLimit.remaining}${response.rateLimit.resetAt ? ` (resets ${response.rateLimit.resetAt})` : ""}`
          : null,
        "",
      ]
        .filter((line): line is string => line !== null)
        .join("\n");

      const body =
        items.length === 0
          ? "No public repositories matched. Consider synonyms, in:readme, a topic: qualifier, or removing restrictive qualifiers."
          : items.map(formatSearchItem).join("\n\n");

      return outcome(incomplete ? "partial" : items.length ? "success" : "empty", header + body, {
        provider: "github",
        auth: auth?.source ?? null,
        query: effectiveQuery,
        sort,
        order: sort === "best-match" ? null : order,
        page,
        perPage,
        total,
        retrievable,
        incomplete_results: incomplete,
        shown: items.length,
        withheld,
        hasMore,
        rate_limit: response.rateLimit,
        repos: items.map((item) => item.fullName),
        items,
      });
    }),
});
