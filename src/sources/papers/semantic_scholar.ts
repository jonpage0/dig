import { Effect, Result, Schema } from "effect";
import * as Headers from "effect/http/Headers";
import { freeRequest, type FreeHttp } from "../../core/http.ts";
import {
  defineAction,
  failed,
  outcome,
  setOutsideChat,
  type ActionContext,
  type ActionOutcome,
} from "../../core/plugin.ts";
import { knownSecrets, redactText } from "../../core/secrets.ts";
import { USER_AGENT } from "../../version.ts";
import { providerKey } from "./openalex.ts";

const SEMANTIC_SCHOLAR_GRAPH_BASE = "https://api.semanticscholar.org/graph/v1";
const SEMANTIC_SCHOLAR_RECOMMENDATIONS_BASE = "https://api.semanticscholar.org/recommendations/v1";

const SEMANTIC_SCHOLAR_FIELDS = [
  "paperId",
  "title",
  "abstract",
  "year",
  "publicationDate",
  "url",
  "venue",
  "citationCount",
  "influentialCitationCount",
  "authors.name",
  "externalIds",
  "openAccessPdf",
  "fieldsOfStudy",
  "s2FieldsOfStudy",
  "publicationTypes",
] as const;

/** Relevance search returns a TLDR. Bulk search and recommendations refuse the field. */
const SEMANTIC_SCHOLAR_SEARCH_FIELDS = [...SEMANTIC_SCHOLAR_FIELDS, "tldr"].join(",");

interface SemanticScholarAuthor {
  readonly authorId?: string;
  readonly name?: string;
}

interface SemanticScholarPaper {
  readonly paperId?: string;
  readonly title?: string;
  readonly abstract?: string;
  readonly year?: number;
  readonly publicationDate?: string;
  readonly url?: string;
  readonly venue?: string;
  readonly citationCount?: number;
  readonly influentialCitationCount?: number;
  readonly authors?: readonly SemanticScholarAuthor[];
  readonly externalIds?: Record<string, string | undefined>;
  readonly openAccessPdf?: {
    readonly url?: string;
    readonly status?: string;
  };
  readonly fieldsOfStudy?: readonly string[];
  readonly s2FieldsOfStudy?: ReadonlyArray<{ readonly category?: string; readonly source?: string }>;
  readonly publicationTypes?: readonly string[];
  readonly tldr?: { readonly text?: string };
}

interface SemanticScholarSearchResponse {
  readonly total?: number;
  readonly offset?: number;
  readonly next?: number;
  readonly token?: string;
  readonly data?: readonly SemanticScholarPaper[];
}

interface SemanticScholarRecommendationsResponse {
  readonly recommendedPapers?: readonly SemanticScholarPaper[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function semanticScholarHeaders(): Record<string, string> {
  const apiKey = providerKey("SEMANTIC_SCHOLAR_API_KEY");
  return {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    ...(apiKey ? { "x-api-key": apiKey } : {}),
  };
}

function truncateText(value: string | undefined, maxLength: number): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatAuthors(authors: ReadonlyArray<{ readonly name?: string } | undefined> | undefined, max = 6): string | null {
  if (!authors?.length) return null;
  const names = authors.map((a) => a?.name?.trim()).filter((n): n is string => Boolean(n));
  if (names.length === 0) return null;
  const visible = names.slice(0, max);
  return names.length > max ? `${visible.join(", ")} +${names.length - max} more` : visible.join(", ");
}

function formatSemanticScholarFields(paper: SemanticScholarPaper): string | null {
  const fields = new Set<string>();
  for (const field of paper.fieldsOfStudy ?? []) {
    if (field?.trim()) fields.add(field.trim());
  }
  for (const field of paper.s2FieldsOfStudy ?? []) {
    if (field.category?.trim()) fields.add(field.category.trim());
  }
  const values = [...fields];
  return values.length > 0 ? values.slice(0, 5).join(", ") : null;
}

function normalizePaperDate(year?: number, publicationDate?: string): string | null {
  if (publicationDate?.trim()) return publicationDate.trim();
  return typeof year === "number" ? String(year) : null;
}

function toDoiUrl(doi: string | undefined): string | null {
  if (!doi?.trim()) return null;
  const normalized = doi.trim();
  return normalized.startsWith("http://") || normalized.startsWith("https://")
    ? normalized
    : `https://doi.org/${normalized.replace(/^doi:/i, "")}`;
}

function formatExternalIds(externalIds?: Record<string, string | undefined>): string[] {
  if (!externalIds) return [];
  const lines: string[] = [];
  const doiUrl = toDoiUrl(externalIds.DOI);
  if (doiUrl) lines.push(`DOI: ${doiUrl}`);
  if (externalIds.ArXiv) lines.push(`ArXiv: https://arxiv.org/abs/${externalIds.ArXiv}`);
  if (externalIds.PMID) lines.push(`PMID: ${externalIds.PMID}`);
  return lines;
}

function sortPapers(
  papers: readonly SemanticScholarPaper[],
  sort: "relevance" | "citationCount" | "publicationDate",
): SemanticScholarPaper[] {
  if (sort === "relevance") return [...papers];
  return [...papers].sort((left, right) => {
    if (sort === "citationCount") {
      return (right.citationCount ?? 0) - (left.citationCount ?? 0);
    }
    const rightDate = normalizePaperDate(right.year, right.publicationDate) ?? "";
    const leftDate = normalizePaperDate(left.year, left.publicationDate) ?? "";
    return rightDate.localeCompare(leftDate);
  });
}

function formatPapers(papers: readonly SemanticScholarPaper[], header: string): string {
  const formatted = papers.map((paper) => {
    const lines: string[] = [];
    const title = paper.title?.trim() || "(untitled paper)";
    const paperId = paper.paperId?.trim() || "unknown";
    const date = normalizePaperDate(paper.year, paper.publicationDate);
    const authors = formatAuthors(paper.authors);
    const tldr = truncateText(paper.tldr?.text, 240);
    const abstract = truncateText(paper.abstract, 320);
    const fields = formatSemanticScholarFields(paper);
    const externalIds = formatExternalIds(paper.externalIds);

    lines.push(`**${title}**`);
    lines.push(
      [
        `Paper ID: ${paperId}`,
        date ? `Published: ${date}` : null,
        paper.citationCount !== undefined ? `Citations: ${paper.citationCount}` : null,
        paper.influentialCitationCount !== undefined
          ? `Influential citations: ${paper.influentialCitationCount}`
          : null,
      ]
        .filter(Boolean)
        .join(" | "),
    );
    if (authors) lines.push(`  Authors: ${authors}`);
    if (paper.venue?.trim()) lines.push(`  Venue: ${paper.venue.trim()}`);
    if (paper.publicationTypes?.length) lines.push(`  Type: ${paper.publicationTypes.slice(0, 3).join(", ")}`);
    if (fields) lines.push(`  Fields: ${fields}`);
    if (tldr) lines.push(`  TLDR: ${tldr}`);
    if (abstract) lines.push(`  Abstract: ${abstract}`);
    for (const line of externalIds) lines.push(`  ${line}`);
    if (paper.openAccessPdf?.url) lines.push(`  Open access PDF: ${paper.openAccessPdf.url}`);
    if (paper.url) lines.push(`  Semantic Scholar: ${paper.url}`);
    return lines.join("\n");
  });
  return `${header}\n\n${formatted.join("\n\n")}`;
}

function semanticAccess(): string {
  return providerKey("SEMANTIC_SCHOLAR_API_KEY")
    ? "API key configured; introductory key limit is 1 request/second across endpoints."
    : `No Semantic Scholar API key configured: using the shared anonymous pool, which may be heavily throttled. SEMANTIC_SCHOLAR_API_KEY or PAPER_SEARCH_MCP_SEMANTIC_SCHOLAR_API_KEY in Dig's keys.env gives dedicated access. ${setOutsideChat()}`;
}

function numericHeader(headers: Headers.Headers, name: string): number | undefined {
  const raw = headers[name.toLowerCase()];
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function semanticFailure(status: number, headers: Headers.Headers): string {
  const retry = numericHeader(headers, "retry-after");
  const detail =
    status === 429
      ? "Provider throttled this request; this is not an empty search."
      : status === 401 || status === 403
        ? "Provider rejected access; check configured key and endpoint permissions."
        : "Provider request failed.";
  return `HTTP ${status}. ${detail} ${semanticAccess()}${retry === undefined ? "" : ` Retry-After: ${retry} seconds.`}`;
}

const SemanticScholarSearchSchema = Schema.Struct({
  token: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Continuation from an unsorted search; repeat the same query and filters. Refused with a non-relevance sort, which offers none.",
    }),
  ),
  query: Schema.String.annotate({ description: "Paper/literature query." }),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
      description: "Max papers (default: 10, max: 20).",
    }),
  ),
  yearFrom: Schema.optionalKey(Schema.Finite.annotate({ description: "Only papers in or after this year." })),
  yearTo: Schema.optionalKey(Schema.Finite.annotate({ description: "Only papers in or before this year." })),
  fieldsOfStudy: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({ description: "Semantic Scholar fields of study filter." }),
  ),
  minCitationCount: Schema.optionalKey(Schema.Finite.annotate({ description: "Minimum citation count." })),
  openAccessOnly: Schema.optionalKey(Schema.Boolean.annotate({ description: "Only include open-access PDFs." })),
  sort: Schema.optionalKey(
    Schema.Literals(["relevance", "citationCount", "publicationDate"]).annotate({ description: "Sort mode." }),
  ),
});

export const papersSemanticScholarSearchAction = defineAction({
  name: "papers_semantic_scholar_search",
  description:
    "Search scholarly papers via Semantic Scholar's Academic Graph API. " +
    "Best for citation-heavy ranking, Semantic Scholar TLDRs, seminal-paper discovery, and related-work seeding. " +
    "Supports year, field-of-study, citation, and open-access filtering.",
  schema: SemanticScholarSearchSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
      const requestedLimit = Math.min(args.limit ?? 10, 20);
      const sort = args.sort ?? "relevance";
      const bulk = sort !== "relevance" || args.token !== undefined;
      if (sort !== "relevance" && args.token !== undefined) {
        return failed(
          `token cannot be combined with sort "${sort}": a sorted Semantic Scholar search returns no continuation, because its token resumes after the provider's whole batch, past papers never shown. Narrow the sorted search instead (yearFrom/yearTo, fieldsOfStudy, minCitationCount or a tighter query).`,
        );
      }

      const url = new URL(`${SEMANTIC_SCHOLAR_GRAPH_BASE}/paper/search${bulk ? "/bulk" : ""}`);
      url.searchParams.set("query", args.query);
      if (!bulk) url.searchParams.set("limit", String(requestedLimit));
      if (bulk && sort !== "relevance") url.searchParams.set("sort", `${sort}:desc`);
      if (args.token) url.searchParams.set("token", args.token);
      url.searchParams.set("fields", bulk ? SEMANTIC_SCHOLAR_FIELDS.join(",") : SEMANTIC_SCHOLAR_SEARCH_FIELDS);
      if (args.yearFrom || args.yearTo) url.searchParams.set("year", `${args.yearFrom ?? ""}-${args.yearTo ?? ""}`);
      if (args.fieldsOfStudy?.length) url.searchParams.set("fieldsOfStudy", args.fieldsOfStudy.join(","));
      if (args.minCitationCount !== undefined) url.searchParams.set("minCitationCount", String(args.minCitationCount));
      if (args.openAccessOnly) url.searchParams.set("openAccessPdf", "true");

      const res = yield* Effect.result(
        freeRequest({
          url: url.href,
          method: "GET",
          headers: semanticScholarHeaders(),
          timeoutMs: 60_000,
          signal: ctx.signal,
          label: "paper/search",
          keep: ctx.keep,
        }),
      );

      if (Result.isFailure(res)) {
        if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
        return failed(
          "Semantic Scholar search failed during transport or response decoding; not evidence of no matches.",
        );
      }

      const { status, headers, isJson, payload } = res.success;
      if (status < 200 || status >= 300) {
        return failed(`Semantic Scholar search failed: ${semanticFailure(status, headers)}`);
      }
      if (
        !isJson ||
        !isRecord(payload) ||
        !Array.isArray(payload.data) ||
        "error" in payload ||
        "errors" in payload ||
        "message" in payload
      ) {
        return failed("Semantic Scholar returned an invalid search payload; not evidence of no matches.");
      }

      const data = payload as unknown as SemanticScholarSearchResponse;
      const papers = sortPapers(data.data ?? [], sort).slice(0, requestedLimit);
      if (papers.length === 0) {
        return outcome("empty", `No Semantic Scholar papers found for "${args.query}".\n${semanticAccess()}`);
      }

      const header = [
        `Semantic Scholar papers for "${args.query}" (${papers.length} shown${data.total ? `, ${data.total} total matches` : ""}):`,
        `Sorted by ${sort}${bulk ? " by the provider across matching papers" : ""}.`,
        ...(sort !== "relevance"
          ? [
              `These are the first ${papers.length} of the provider's batch for this sort; no continuation is offered. Reach more by narrowing the search (yearFrom/yearTo, fieldsOfStudy, minCitationCount or a tighter query).`,
            ]
          : data.token
            ? [`Next token: ${data.token}. Use the same query and filters to continue.`]
            : []),
        semanticAccess(),
      ].join("\n");

      return outcome("success", formatPapers(papers, header));
    }),
});

const SemanticScholarRecommendationsSchema = Schema.Struct({
  positivePaperIds: Schema.Array(Schema.String).annotate({
    description: "Semantic Scholar paper IDs to seed recommendations.",
  }),
  negativePaperIds: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({ description: "Optional paper IDs to steer away from." }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
      description: "Max recommendations (default: 10, max: 20).",
    }),
  ),
});

export const papersSemanticScholarRecommendationsAction = defineAction({
  name: "papers_semantic_scholar_recommendations",
  description:
    "Get related-paper recommendations from Semantic Scholar using one or more seed paper IDs. " +
    "Best for related-work expansion after you've identified a few anchor papers. " +
    "Use paper IDs surfaced by papers_semantic_scholar_search.",
  schema: SemanticScholarRecommendationsSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
      const limit = Math.min(args.limit ?? 10, 20);
      const url = new URL(`${SEMANTIC_SCHOLAR_RECOMMENDATIONS_BASE}/papers`);
      url.searchParams.set("fields", SEMANTIC_SCHOLAR_FIELDS.join(","));
      url.searchParams.set("limit", String(limit));

      const res = yield* Effect.result(
        freeRequest({
          url: url.href,
          method: "POST",
          headers: {
            ...semanticScholarHeaders(),
            "Content-Type": "application/json",
          },
          body: {
            positivePaperIds: args.positivePaperIds,
            negativePaperIds: args.negativePaperIds,
          },
          timeoutMs: 60_000,
          signal: ctx.signal,
          label: "recommendations",
          keep: ctx.keep,
        }),
      );

      if (Result.isFailure(res)) {
        if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
        return failed(
          "Semantic Scholar recommendations failed during transport or response decoding; not evidence of no matches.",
        );
      }

      const { status, headers, isJson, payload } = res.success;
      if (status < 200 || status >= 300) {
        return failed(`Semantic Scholar recommendations failed: ${semanticFailure(status, headers)}`);
      }
      if (
        !isJson ||
        !isRecord(payload) ||
        !Array.isArray(payload.recommendedPapers) ||
        "error" in payload ||
        "errors" in payload ||
        "message" in payload
      ) {
        return failed("Semantic Scholar returned an invalid recommendations payload; not evidence of no matches.");
      }

      const data = payload as unknown as SemanticScholarRecommendationsResponse;
      const papers = data.recommendedPapers ?? [];
      if (papers.length === 0) {
        return outcome(
          "empty",
          `No Semantic Scholar recommendations were returned for the provided seed papers.\n${semanticAccess()}`,
        );
      }

      const seedList = args.positivePaperIds.join(", ");
      return outcome(
        "success",
        formatPapers(
          papers,
          `Semantic Scholar related-work recommendations seeded by: ${seedList}\n${semanticAccess()}`,
        ),
      );
    }),
});

function graphEvidenceGet(
  path: string,
  params: Record<string, string | number | undefined>,
  ctx: Pick<ActionContext, "keep" | "signal">,
): Effect.Effect<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly cancelled: boolean; readonly error: string },
  never,
  FreeHttp
> {
  return Effect.gen(function* () {
    const url = new URL(SEMANTIC_SCHOLAR_GRAPH_BASE + path);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const res = yield* Effect.result(
      freeRequest({
        url: url.href,
        method: "GET",
        headers: semanticScholarHeaders(),
        timeoutMs: 60_000,
        signal: ctx.signal,
        label: path,
        keep: ctx.keep,
      }),
    );
    if (Result.isFailure(res)) {
      if (ctx.signal.aborted) return { ok: false as const, cancelled: true, error: "Research call cancelled" };
      const msg = res.failure instanceof Error ? res.failure.message : "Paper retrieval failed";
      return { ok: false as const, cancelled: false, error: redactText(msg, knownSecrets()) };
    }
    const { status, isJson, payload } = res.success;
    if (status < 200 || status >= 300) {
      return { ok: false as const, cancelled: false, error: `Semantic Scholar returned HTTP ${status}` };
    }
    if (
      !isJson ||
      !isRecord(payload) ||
      !Array.isArray(payload.data) ||
      payload.error !== undefined ||
      payload.message !== undefined
    ) {
      return { ok: false as const, cancelled: false, error: "Semantic Scholar returned an invalid data array" };
    }
    return { ok: true as const, body: payload };
  });
}

function showEvidence(body: Record<string, unknown>, label: string): ActionOutcome {
  const raw = JSON.stringify(body, null, 2);
  const truncated = raw.length > 60_000;
  const more = body.next !== undefined && body.next !== null;
  const data = Array.isArray(body.data) ? body.data : [];
  return outcome(
    truncated ? "partial" : data.length ? "success" : "empty",
    `${label}\n${more ? `Next offset: ${String(body.next)}.` : ""}${
      truncated ? " Output shortened; read the retained original." : ""
    }\n\n${raw.slice(0, 60_000)}`,
  );
}

const SemanticScholarSnippetsSchema = Schema.Struct({
  query: Schema.String.annotate({ description: "Passage search query." }),
  paperIds: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({ description: "Optional known paper IDs, max 100." }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({ description: "Max snippets (1–100)." }),
  ),
});

export const papersSemanticScholarSnippetsAction = defineAction({
  name: "papers_semantic_scholar_snippets",
  description:
    "Find Semantic Scholar passages matching a question, optionally restricted to known papers. Returns snippet text, section, offsets and paper identity. Snippets are partial paper evidence, not full text.",
  schema: SemanticScholarSnippetsSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return failed("query is required");
      const limit = args.limit ?? 10;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return failed("limit must be 1–100");
      if (
        args.paperIds !== undefined &&
        (!Array.isArray(args.paperIds) ||
          args.paperIds.length > 100 ||
          args.paperIds.some((id) => typeof id !== "string" || !id.trim() || id.includes(",")))
      ) {
        return failed("paperIds must contain at most 100 nonempty IDs");
      }

      const res = yield* graphEvidenceGet(
        "/snippet/search",
        { query, limit, paperIds: args.paperIds?.join(",") },
        ctx,
      );
      if (!res.ok) return res.cancelled ? outcome("cancelled", "Research call cancelled") : failed(res.error);
      return showEvidence(res.body, "Semantic Scholar matching passages");
    }),
});

const SemanticScholarRelationsSchema = Schema.Struct({
  paperId: Schema.String.annotate({ description: "Seed paper identifier." }),
  direction: Schema.Literals(["citations", "references"]).annotate({
    description: "Direction from the seed paper.",
  }),
  offset: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9999 })).annotate({ description: "Paging offset (0–9999)." }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({ description: "Max items (1–100)." }),
  ),
});

export const papersSemanticScholarRelationsAction = defineAction({
  name: "papers_semantic_scholar_relations",
  description:
    "Read one page of papers citing a known Semantic Scholar paper, or its references, with citation context and intent. Direction is citations or references. Preserve paper IDs and distinguish citation context from the paper's own conclusion.",
  schema: SemanticScholarRelationsSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
      if (args.direction !== "citations" && args.direction !== "references") {
        return failed("direction must be citations or references");
      }
      const offset = args.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 9999) return failed("offset must be 0–9999");
      const limit = args.limit ?? 10;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return failed("limit must be 1–100");
      const id = typeof args.paperId === "string" ? args.paperId.trim() : "";
      if (!id) return failed("paperId is required");

      const res = yield* graphEvidenceGet(
        `/paper/${encodeURIComponent(id)}/${args.direction}`,
        {
          fields: "contexts,intents,isInfluential,title,abstract,authors,year,url,externalIds",
          limit,
          offset,
        },
        ctx,
      );
      if (!res.ok) return res.cancelled ? outcome("cancelled", "Research call cancelled") : failed(res.error);
      return showEvidence(res.body, `Semantic Scholar ${args.direction} for ${id}`);
    }),
});
