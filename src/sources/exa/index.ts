import { Effect, Schema } from "effect";
import {
  defineAction,
  defineSource,
  failed,
  meteredBilling,
  outcome,
  type SourcePlugin,
} from "../../core/plugin.ts";
import { knownSecrets, redactText } from "../../core/secrets.ts";
import {
  apiKey,
  characterBudget,
  CONTENTS_TEXT_CHARACTERS,
  contentsPlan,
  costLine,
  DEFAULT_RESEARCH_MODE,
  DEFAULT_RESEARCH_VERBOSITY,
  DYNAMIC_HIGHLIGHTS_BETA,
  exaBaseUrl,
  exaPost,
  formatResults,
  formatSynthesis,
  HIGHLIGHT_VERBOSITIES,
  highlightPlan,
  isInvalid,
  MAX_ADDITIONAL_QUERIES,
  MAX_CHARACTERS,
  MAX_CONTENT_URLS,
  MAX_MAX_AGE_HOURS,
  MAX_RESULTS,
  maxAgeHours,
  MIN_MAX_AGE_HOURS,
  MISSING_EXA_KEY,
  optionalStringArray,
  optionalText,
  parseHighlightVerbosity,
  reportedDollars,
  requireText,
  RESEARCH_MODES,
  RESEARCH_TIMEOUT_MS,
  resultCount,
  resultDetails,
  SEARCH_TEXT_CHARACTERS,
  SEARCH_TIMEOUT_MS,
  SEARCH_TYPES,
  SIMILAR_TEXT_CHARACTERS,
  snapshotTime,
  userLocation,
  type ResearchMode,
  type SearchType,
} from "./client.ts";

const exaBilling = meteredBilling<unknown>("USD", (body) => reportedDollars(body) ?? null);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const highlightVerbosityField = Schema.optionalKey(
  Schema.Literals(HIGHLIGHT_VERBOSITIES).annotate({
    description:
      "Dynamic Highlights verbosity pool: low (~3k chars), medium (~6k chars), or high (~12k chars, Exa default). Enables Dynamic Highlights (sends Exa-Beta header).",
  }),
);

export const exaSearchSchema = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Natural-language Exa search query.",
  }),
  numResults: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_RESULTS })).annotate({
      description: "Results (default 10, max 100; >10 bill $1/1k each).",
    }),
  ),
  type: Schema.optionalKey(
    Schema.Literals(SEARCH_TYPES).annotate({
      description:
        "Mode: auto (default, $7/1k), lite ($4/1k cache-only; no maxAgeHours/summary), deep-lite/deep ($12/1k), or legacy fast/instant/deep-reasoning ($15/1k).",
    }),
  ),
  category: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Category focus: company, publication, news, personal site, financial report, people (other strings are hints). company/people reject dates and excludeDomains.",
    }),
  ),
  userLocation: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[A-Za-z]{2}$/)).annotate({
      description: "2-letter ISO country code (e.g. US) for local/places/events.",
    }),
  ),
  includeDomains: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "Only results from these domains or paths (wildcards like *.substack.com, paths like exa.ai/blog).",
    }),
  ),
  excludeDomains: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "Exclude results from these domains or paths.",
    }),
  ),
  startPublishedDate: Schema.optionalKey(
    Schema.String.annotate({
      description: "Only results published after this ISO 8601 date.",
    }),
  ),
  endPublishedDate: Schema.optionalKey(
    Schema.String.annotate({
      description: "Only results published before this ISO 8601 date.",
    }),
  ),
  contents: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Return page text and highlights per result (default: true).",
    }),
  ),
  summary: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Also return an AI summary per result (default false; +$1/1k pages).",
    }),
  ),
  highlightMaxCharacters: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CHARACTERS })).annotate({
      description: "Per-page highlight char budget (not with dynamicHighlights or highlightVerbosity).",
    }),
  ),
  dynamicHighlights: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Dynamic Highlights: shared excerpt budget across results, omits text (sends Exa-Beta header).",
    }),
  ),
  highlightVerbosity: highlightVerbosityField,
  snapshotAsOf: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "ISO cutoff for stored content (5-month window, paid plans; no historical ranking; not with maxAgeHours, category, deep, deep-reasoning).",
    }),
  ),
  maxAgeHours: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: MIN_MAX_AGE_HOURS, maximum: MAX_MAX_AGE_HOURS })).annotate({
      description:
        "Freshness: omit for cache+live fallback, 0 fresh, -1 cache only, N refetch if >N hours old.",
    }),
  ),
});

export const exaContentsSchema = Schema.Struct({
  urls: Schema.Array(Schema.String).check(Schema.isMinLength(1)).annotate({
    description: "URLs to extract (max 100; keep batches small, output is full text).",
  }),
  query: Schema.optionalKey(
    Schema.String.annotate({
      description: "Optional query guiding highlight (and summary) selection.",
    }),
  ),
  maxCharacters: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CHARACTERS })).annotate({
      description: "Max characters of page text per URL (default: 5000).",
    }),
  ),
  highlights: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Include highlights (default: true; false for text-only, $1/1k vs $2/1k).",
    }),
  ),
  summary: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Also return an AI summary per page (default false; +$1/1k pages).",
    }),
  ),
  highlightMaxCharacters: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CHARACTERS })).annotate({
      description: "Per-page highlight char budget (not with dynamicHighlights).",
    }),
  ),
  dynamicHighlights: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Dynamic Highlights: shared excerpt budget (sends Exa-Beta header).",
    }),
  ),
  snapshotAsOf: Schema.optionalKey(
    Schema.String.annotate({
      description: "ISO cutoff for stored content (5-month window, paid plans; not with maxAgeHours).",
    }),
  ),
  maxAgeHours: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: MIN_MAX_AGE_HOURS, maximum: MAX_MAX_AGE_HOURS })).annotate({
      description:
        "Freshness: omit for cache+live fallback, 0 fresh, -1 cache only, N refetch if >N hours old.",
    }),
  ),
});

export const exaSimilarSchema = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Reference URL.",
  }),
  numResults: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_RESULTS })).annotate({
      description: "Number of similar results (default: 10, max: 100).",
    }),
  ),
  excludeSourceDomain: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Exclude results from the reference URL's own domain.",
    }),
  ),
  includeDomains: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "Only include these domains or paths.",
    }),
  ),
  excludeDomains: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "Exclude these domains or paths.",
    }),
  ),
  startPublishedDate: Schema.optionalKey(
    Schema.String.annotate({
      description: "Only results published after this ISO 8601 date.",
    }),
  ),
  endPublishedDate: Schema.optionalKey(
    Schema.String.annotate({
      description: "Only results published before this ISO 8601 date.",
    }),
  ),
  category: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Data category focus (company, publication, news, personal site, financial report, people).",
    }),
  ),
  contents: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Return page text and highlights per result (default: true).",
    }),
  ),
  summary: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Also return an AI summary per result (default false; +$1/1k pages).",
    }),
  ),
  highlightMaxCharacters: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CHARACTERS })).annotate({
      description: "Per-page highlight char budget (not with dynamicHighlights).",
    }),
  ),
  dynamicHighlights: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Dynamic Highlights: shared excerpt budget, omits text (sends Exa-Beta header).",
    }),
  ),
  maxAgeHours: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: MIN_MAX_AGE_HOURS, maximum: MAX_MAX_AGE_HOURS })).annotate({
      description:
        "Freshness: omit for cache+live fallback, 0 fresh, -1 cache only, N refetch if >N hours old.",
    }),
  ),
});

export const exaResearchSchema = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      "What to research. One Exa /search synthesis call (default deep, $12/1k, 4-15s; or auto, $7/1k, ~3s quick synthesis).",
  }),
  mode: Schema.optionalKey(
    Schema.Literals(RESEARCH_MODES).annotate({
      description:
        "Mode: deep (default, $12/1k, ~4-15s thorough synthesis), auto ($7/1k, ~3s quick synthesis), deep-lite ($12/1k, faster ~2s but shorter synthesis at same price as deep), or legacy deep-reasoning ($15/1k).",
    }),
  ),
  systemPrompt: Schema.optionalKey(
    Schema.String.annotate({
      description: "Research guidance: source preferences, deduplication, and organization.",
    }),
  ),
  additionalQueries: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "Up to 10 meaningfully different search directions Exa should also cover.",
    }),
  ),
  numResults: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_RESULTS })).annotate({
      description: "Selected source pages to return (default: 10, max: 100).",
    }),
  ),
  dynamicHighlights: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Use Dynamic Highlights shared excerpt pool (default: true; sends Exa-Beta header). Set false for per-page highlights.",
    }),
  ),
  highlightVerbosity: Schema.optionalKey(
    Schema.Literals(HIGHLIGHT_VERBOSITIES).annotate({
      description:
        "Dynamic Highlights verbosity pool: low (~3k chars), medium (default, ~6k chars), or high (~12k chars).",
    }),
  ),
  highlightMaxCharacters: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CHARACTERS })).annotate({
      description: "Per-page highlight char budget (valid only when dynamicHighlights is false).",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const exaSearchAction = defineAction({
  name: "exa_search",
  description:
    "Search the web with Exa and get ranked documents with page text and query-relevant highlights. " +
    "Search modes: 'auto' (default, $7/1k), 'lite' ($4/1k low-cost cached retrieval), legacy 'fast'/'instant', and Deep modes 'deep-lite'/'deep' ($12/1k) " +
    "or legacy 'deep-reasoning' ($15/1k) for iterative research over selected pages. " +
    "Filters: domains/paths (wildcards like '*.substack.com'), publication dates, category, userLocation (ISO country code). " +
    "With dynamicHighlights: true or highlightVerbosity ('low' | 'medium' | 'high'), page text is omitted for token savings. Use exa_research when a synthesized, source-grounded answer is explicitly requested.",
  schema: exaSearchSchema,
  billing: exaBilling,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const key = apiKey();
      if (!key) return failed(MISSING_EXA_KEY);
      const baseUrl = exaBaseUrl();
      if (isInvalid(baseUrl)) return failed(baseUrl.error);
      const query = requireText(args.query, "query");
      if (isInvalid(query)) return failed(query.error);

      const type: SearchType = args.type ?? "auto";
      if (!(SEARCH_TYPES as readonly string[]).includes(type)) {
        return failed(`type must be one of ${SEARCH_TYPES.join(", ")}.`);
      }

      if (type === "lite" && (args.maxAgeHours !== undefined || args.summary !== undefined)) {
        return failed("lite is cache-only and does not accept maxAgeHours or summary; use auto.");
      }
      if (
        args.snapshotAsOf !== undefined &&
        (args.category !== undefined || type === "deep" || type === "deep-reasoning")
      ) {
        return failed("Snapshot does not support category, deep or deep-reasoning.");
      }
      const location = userLocation(args.userLocation);
      if (isInvalid(location)) return failed(location.error);
      const includeDomains = optionalStringArray(args.includeDomains, "includeDomains");
      if (isInvalid(includeDomains)) return failed(includeDomains.error);
      const excludeDomains = optionalStringArray(args.excludeDomains, "excludeDomains");
      if (isInvalid(excludeDomains)) return failed(excludeDomains.error);

      const { numResults, note } = resultCount(args.numResults);
      const plan = contentsPlan({ ...args, query }, SEARCH_TEXT_CHARACTERS, query);
      if (isInvalid(plan)) return failed(plan.error);

      const body: Record<string, unknown> = { query, numResults, type };
      if (args.category) body.category = args.category;
      if (location) body.userLocation = location;
      if (includeDomains) body.includeDomains = includeDomains;
      if (excludeDomains) body.excludeDomains = excludeDomains;
      if (args.startPublishedDate) body.startPublishedDate = args.startPublishedDate;
      if (args.endPublishedDate) body.endPublishedDate = args.endPublishedDate;
      if (plan.contents) body.contents = plan.contents;

      const posted = yield* exaPost("/search", body, {
        operation: "search",
        baseUrl,
        key,
        signal: ctx.signal,
        keep: ctx.keep,
        timeoutMs: SEARCH_TIMEOUT_MS,
        beta: plan.beta,
      });
      if (!posted.ok) {
        return posted.cancelled ? outcome("cancelled", posted.error) : failed(posted.error);
      }

      const response = posted.response;
      const notes = note ? [note] : [];
      if (args.snapshotAsOf) {
        notes.push(
          `Snapshot cutoff ${args.snapshotAsOf}: stored content only; current retrieval signals still rank candidate URLs. Availability depends on the Exa plan and stored coverage.`,
        );
      }
      if (type === "lite") {
        notes.push("Lite uses cached page content only; missing cached pages may be omitted.");
      }
      const results = response.results;
      if (results.length === 0) {
        return outcome(
          "empty",
          [`No Exa results found for "${query}" (type: ${type}).`, ...notes.map((n) => `Note: ${n}`)].join("\n"),
          resultDetails(response, { type }),
        );
      }

      return outcome(
        "success",
        formatResults(`Exa search "${query}" (type: ${type}; ${results.length} results)`, notes, response),
        resultDetails(response, {
          type,
          dynamicHighlights: plan.beta !== undefined,
          ...(args.highlightVerbosity ? { highlightVerbosity: args.highlightVerbosity } : {}),
        }),
      );
    }),
});

export const exaContentsAction = defineAction({
  name: "exa_contents",
  description:
    "Extract clean markdown text and optional highlights from specific URLs via Exa's cache " +
    "with live-fetch fallback. Reports per-URL fetch status so a failed page is never silently dropped. " +
    "Bills $1/1k pages per content type (text, highlights, summary); set highlights: false for text-only at half cost.",
  schema: exaContentsSchema,
  billing: exaBilling,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const key = apiKey();
      if (!key) return failed(MISSING_EXA_KEY);
      const baseUrl = exaBaseUrl();
      if (isInvalid(baseUrl)) return failed(baseUrl.error);
      const urls = optionalStringArray(args.urls, "urls");
      if (isInvalid(urls)) return failed(urls.error);
      if (!urls || urls.length === 0) return failed("urls must be a non-empty array of URLs.");

      const notes: string[] = [];
      const requested = urls.slice(0, MAX_CONTENT_URLS);
      if (urls.length > MAX_CONTENT_URLS) {
        notes.push(
          `${urls.length - MAX_CONTENT_URLS} URLs beyond Exa's ${MAX_CONTENT_URLS}-URL limit were not requested.`,
        );
      }

      const textCharacters = characterBudget(args.maxCharacters, "maxCharacters");
      if (isInvalid(textCharacters)) return failed(textCharacters.error);
      if (args.highlights !== undefined && typeof args.highlights !== "boolean") {
        return failed("highlights must be a boolean.");
      }
      const wantHighlights = args.highlights !== false;
      if (
        !wantHighlights &&
        (args.dynamicHighlights === true ||
          (args.highlightMaxCharacters !== undefined && args.highlightMaxCharacters !== null))
      ) {
        return failed("highlights: false cannot be combined with dynamicHighlights or highlightMaxCharacters.");
      }
      const highlights = wantHighlights ? highlightPlan(args) : undefined;
      if (isInvalid(highlights)) return failed(highlights.error);
      const age = maxAgeHours(args.maxAgeHours);
      if (isInvalid(age)) return failed(age.error);

      const snapshot = snapshotTime(args.snapshotAsOf);
      if (isInvalid(snapshot)) return failed(snapshot.error);
      if (snapshot !== undefined && args.maxAgeHours !== undefined) {
        return failed("snapshotAsOf cannot be combined with maxAgeHours.");
      }
      if (snapshot !== undefined) {
        notes.push(
          `Snapshot cutoff ${snapshot}: newest stored content at or before this date; coverage and plan limits apply.`,
        );
      }
      const focus = optionalText(args.query);
      const body: Record<string, unknown> = {
        urls: requested,
        text: { maxCharacters: textCharacters ?? CONTENTS_TEXT_CHARACTERS },
      };
      if (highlights) body.highlights = highlights.highlights;
      if (args.summary === true) body.summary = focus ? { query: focus } : {};
      if (age !== undefined) body.maxAgeHours = age;
      if (snapshot !== undefined) body.snapshotAsOf = snapshot;

      const posted = yield* exaPost("/contents", body, {
        operation: "contents extraction",
        baseUrl,
        key,
        signal: ctx.signal,
        keep: ctx.keep,
        timeoutMs: SEARCH_TIMEOUT_MS,
        beta: highlights?.beta,
      });
      if (!posted.ok) {
        return posted.cancelled ? outcome("cancelled", posted.error) : failed(posted.error);
      }

      const response = posted.response;
      const results = response.results;
      const statuses = response.statuses;
      const failures = statuses.filter((s) => s.status === "error");
      const secrets = knownSecrets();
      const returned = new Set(results.map((r) => redactText(r.id ?? r.url, secrets)));
      const reported = new Set(statuses.map((s) => redactText(s.id, secrets)));
      const unaccounted = requested
        .map((u) => redactText(u, secrets))
        .filter((u) => !returned.has(u) && !reported.has(u));
      const sources = { cached: 0, crawled: 0 };
      for (const s of statuses) {
        if (s.status === "success" && s.source) sources[s.source] += 1;
      }

      const lines: string[] = [];
      lines.push(`Content extracted for ${results.length} of ${requested.length} requested URLs`);
      const cost = costLine(response);
      if (cost) lines.push(`(${cost})`);
      if (sources.cached || sources.crawled) {
        lines.push(`Sources: ${sources.cached} cached, ${sources.crawled} freshly crawled`);
      }
      for (const note of notes) lines.push(`Note: ${note}`);
      if (failures.length > 0) {
        lines.push("Fetch failures (per-URL status from Exa):");
        for (const f of failures) {
          const tag = f.error?.tag ?? "ERROR";
          const http = typeof f.error?.httpStatusCode === "number" ? ` (HTTP ${f.error.httpStatusCode})` : "";
          lines.push(redactText(`- ${f.id} — ${tag}${http}`, knownSecrets()));
        }
      }
      if (unaccounted.length > 0) {
        lines.push("Not returned and no status reported by Exa:");
        for (const u of unaccounted) lines.push(`- ${u}`);
      }
      lines.push("");

      for (const r of results) {
        lines.push(`## ${r.title || r.url}`);
        lines.push(`URL: ${r.url}`);
        if (r.publishedDate) lines.push(`Published: ${r.publishedDate.split("T")[0]}`);
        if (r.author) lines.push(`Author: ${r.author}`);
        lines.push("");
        if (r.entities?.length) lines.push(`Structured entities: ${JSON.stringify(r.entities)}`, "");
        if (r.summary) {
          lines.push(`**Summary:** ${r.summary}`);
          lines.push("");
        }
        if (r.highlights && r.highlights.length > 0) {
          lines.push("**Key passages:**");
          for (const h of r.highlights) lines.push(`> ${h}`);
          lines.push("");
        }
        if (r.text) {
          lines.push(
            `**Page text (${r.text.length} characters returned against a ${textCharacters ?? CONTENTS_TEXT_CHARACTERS}-character request; ` +
              "completeness not established):**",
          );
          lines.push(r.text);
          lines.push("");
        }
        lines.push("---");
        lines.push("");
      }

      return outcome(
        results.length === 0 ? "empty" : failures.length || unaccounted.length ? "partial" : "success",
        lines.join("\n"),
        resultDetails(response, {
          requested: requested.length,
          failed: failures.map((f) => redactText(f.id, knownSecrets())),
          unaccounted,
          dynamicHighlights: highlights?.beta !== undefined,
        }),
      );
    }),
});

export const exaSimilarAction = defineAction({
  name: "exa_similar",
  description:
    "Find web pages semantically similar to a reference URL ('more papers like this one', " +
    "'competitors to this company'). Exa marks /findSimilar deprecated in favor of /search with a " +
    "query describing the source; it is still served. Supports domain, date, and category filters.",
  schema: exaSimilarSchema,
  billing: exaBilling,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const key = apiKey();
      if (!key) return failed(MISSING_EXA_KEY);
      const baseUrl = exaBaseUrl();
      if (isInvalid(baseUrl)) return failed(baseUrl.error);

      const url = requireText(args.url, "url");
      if (isInvalid(url)) return failed(url.error);

      const includeDomains = optionalStringArray(args.includeDomains, "includeDomains");
      if (isInvalid(includeDomains)) return failed(includeDomains.error);
      const excludeDomains = optionalStringArray(args.excludeDomains, "excludeDomains");
      if (isInvalid(excludeDomains)) return failed(excludeDomains.error);

      const { numResults, note } = resultCount(args.numResults);
      const plan = contentsPlan(args, SIMILAR_TEXT_CHARACTERS);
      if (isInvalid(plan)) return failed(plan.error);

      const body: Record<string, unknown> = { url, numResults };
      if (args.excludeSourceDomain === true) body.excludeSourceDomain = true;
      if (includeDomains) body.includeDomains = includeDomains;
      if (excludeDomains) body.excludeDomains = excludeDomains;
      if (args.startPublishedDate) body.startPublishedDate = args.startPublishedDate;
      if (args.endPublishedDate) body.endPublishedDate = args.endPublishedDate;
      if (args.category) body.category = args.category;
      if (plan.contents) body.contents = plan.contents;

      const posted = yield* exaPost("/findSimilar", body, {
        operation: "findSimilar",
        baseUrl,
        key,
        signal: ctx.signal,
        keep: ctx.keep,
        timeoutMs: SEARCH_TIMEOUT_MS,
        beta: plan.beta,
      });
      if (!posted.ok) {
        return posted.cancelled ? outcome("cancelled", posted.error) : failed(posted.error);
      }

      const response = posted.response;
      const notes = note ? [note] : [];
      const results = response.results;
      if (results.length === 0) {
        return outcome(
          "empty",
          [`No similar pages found for "${url}".`, ...notes.map((n) => `Note: ${n}`)].join("\n"),
          resultDetails(response, {}),
        );
      }

      return outcome(
        "success",
        formatResults(`Pages similar to ${url} (${results.length} results)`, notes, response),
        resultDetails(response, { dynamicHighlights: plan.beta !== undefined }),
      );
    }),
});

export const exaResearchAction = defineAction({
  name: "exa_research",
  description:
    "Opt-in grounded research: one Exa /search call with synthesis (default 'deep' $12/1k ~4–15s; 'auto' $7/1k ~3s quick synthesis; 'deep-lite' $12/1k shorter/faster; legacy 'deep-reasoning' $15/1k). " +
    "Returns a synthesized text answer with field-level grounding (citations + Exa-reported confidence) and selected source pages using Dynamic Highlights (default verbosity 'medium', ~6k shared chars). " +
    "Call only when the user or parent explicitly asks for Exa research.",
  schema: exaResearchSchema,
  billing: exaBilling,
  slow: true,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const key = apiKey();
      if (!key) return failed(MISSING_EXA_KEY);
      const baseUrl = exaBaseUrl();
      if (isInvalid(baseUrl)) return failed(baseUrl.error);

      const query = requireText(args.query, "query");
      if (isInvalid(query)) return failed(query.error);

      const rawMode = args.mode ?? DEFAULT_RESEARCH_MODE;
      if (typeof rawMode !== "string" || !(RESEARCH_MODES as readonly string[]).includes(rawMode)) {
        return failed(`mode must be one of ${RESEARCH_MODES.join(", ")}.`);
      }
      const mode = rawMode as ResearchMode;

      const additionalQueries = optionalStringArray(args.additionalQueries, "additionalQueries");
      if (isInvalid(additionalQueries)) return failed(additionalQueries.error);
      if (additionalQueries && additionalQueries.length > MAX_ADDITIONAL_QUERIES) {
        return failed(`additionalQueries accepts at most ${MAX_ADDITIONAL_QUERIES} entries.`);
      }

      const useDynamic = args.dynamicHighlights !== false;
      const requestedVerbosity = parseHighlightVerbosity(args.highlightVerbosity);
      if (isInvalid(requestedVerbosity)) return failed(requestedVerbosity.error);
      const maxChars = characterBudget(args.highlightMaxCharacters, "highlightMaxCharacters");
      if (isInvalid(maxChars)) return failed(maxChars.error);

      if (useDynamic && maxChars !== undefined) {
        return failed(
          "highlightMaxCharacters cannot be combined with dynamicHighlights (Exa allocates one shared budget).",
        );
      }
      if (!useDynamic && requestedVerbosity !== undefined) {
        return failed("highlightVerbosity requires dynamicHighlights (omit dynamicHighlights: false).");
      }

      const verbosity = useDynamic ? (requestedVerbosity ?? DEFAULT_RESEARCH_VERBOSITY) : undefined;
      const { numResults, note } = resultCount(args.numResults);
      const systemPrompt = optionalText(args.systemPrompt);

      const highlightsPayload: Record<string, unknown> = useDynamic
        ? { dynamic: true, verbosity }
        : maxChars !== undefined
          ? { query, maxCharacters: maxChars }
          : { query };

      const body: Record<string, unknown> = {
        query,
        type: mode,
        numResults,
        outputSchema: { type: "text" },
        contents: { highlights: highlightsPayload },
      };
      if (systemPrompt) body.systemPrompt = systemPrompt;
      if (additionalQueries && additionalQueries.length > 0) {
        body.additionalQueries = additionalQueries;
      }

      ctx.progress({ progress: 0, total: 2, message: `Starting Exa research (${mode})...` });

      const posted = yield* exaPost("/search", body, {
        operation: "deep research",
        baseUrl,
        key,
        signal: ctx.signal,
        keep: ctx.keep,
        timeoutMs: RESEARCH_TIMEOUT_MS,
        ...(useDynamic ? { beta: DYNAMIC_HIGHLIGHTS_BETA } : {}),
      });
      if (!posted.ok) {
        return posted.cancelled ? outcome("cancelled", posted.error) : failed(posted.error);
      }

      const response = posted.response;
      const results = response.results;
      const output = response.output;

      ctx.progress({
        progress: 1,
        total: 2,
        message: `Exa research response received (${results.length} sources, ${output?.grounding.length ?? 0} grounding entries)`,
      });

      const lines: string[] = [];
      lines.push(`## Exa Deep Research (${mode})`);
      const cost = costLine(response);
      if (cost) lines.push(`(${cost})`);
      if (note) lines.push(`Note: ${note}`);
      lines.push("");

      if (output) {
        lines.push(...formatSynthesis(output.content));
        lines.push("");
        lines.push("### Grounding (Exa field-level citations; confidence is Exa-reported)");
        if (output.grounding.length === 0) {
          lines.push("Exa returned no grounding entries for this output; treat the synthesis as unsupported.");
        }
        for (const g of output.grounding) {
          const cites = g.citations.map((c) => `${c.title || "(no title)"} <${c.url}>`).join("; ");
          lines.push(`- \`${g.field}\` — confidence ${g.confidence}: ${cites || "no citations"}`);
        }
      } else {
        lines.push(
          "Exa returned no synthesized output for this request; the selected pages below are the only evidence.",
        );
      }
      lines.push("");

      lines.push(`### Selected sources (${results.length})`);
      lines.push("");
      if (results.length === 0) lines.push("Exa selected no source pages.");
      results.forEach((r, index) => {
        lines.push(`${index + 1}. **${r.title || "(no title)"}**`);
        lines.push(
          `   URL: ${r.url}` +
            (r.publishedDate ? ` | Published: ${r.publishedDate.split("T")[0]}` : "") +
            (r.author ? ` | Author: ${r.author}` : ""),
        );
        for (const h of r.highlights ?? []) lines.push(`   > ${h}`);
        lines.push("");
      });

      ctx.progress({ progress: 2, total: 2, message: `Exa research complete (${mode})` });

      return outcome(
        !output && results.length === 0 ? "empty" : "success",
        lines.join("\n"),
        resultDetails(response, {
          type: mode,
          dynamicHighlights: useDynamic,
          ...(verbosity ? { highlightVerbosity: verbosity } : {}),
          synthesized: output !== undefined,
          grounding: output?.grounding.length ?? 0,
          citations: [...new Set((output?.grounding ?? []).flatMap((g) => g.citations.map((c) => c.url)))],
        }),
      );
    }),
});

export const exaSource: SourcePlugin = defineSource({
  id: "exa",
  group: "web",
  label: "Exa",
  description: "Web documents, extraction and similarity",
  about:
    "Web search that returns ranked pages with their text, plus clean extraction of pages you name and discovery of similar pages. Exa's deep research runs only when explicitly asked for.",
  providers: [{ name: "Exa", url: "https://exa.ai" }],
  billing: "Paid per request in US dollars from your Exa account. Dig records the cost Exa reports.",
  logo: "exa",
  env: ["EXA_API_KEY", "EXA_BASE_URL"],
  keys: ["EXA_API_KEY"],
  credential: "EXA_API_KEY",
  envSettings: [
    {
      name: "EXA_BASE_URL",
      label: "Exa API endpoint",
      purpose:
        "Optional HTTPS API base URL (defaults to https://api.exa.ai). Set https://api.eu.exa.ai in keys.env for EU data-residency API keys.",
    },
  ],
  actions: [exaSearchAction, exaContentsAction, exaSimilarAction, exaResearchAction],
});

export default exaSource;
