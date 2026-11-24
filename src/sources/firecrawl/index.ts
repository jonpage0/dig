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
  asRecord,
  DEFAULT_MAP_LIMIT,
  DEFAULT_MAX_CHARACTERS,
  FIRECRAWL_COST_UNIT,
  firecrawlPost,
  formatCreditsNote,
  MAX_MAP_LIMIT,
  MAX_MAX_CHARACTERS,
  MAX_WAIT_FOR_MS,
  MIN_MAX_CHARACTERS,
  MISSING_FIRECRAWL_KEY,
  optionalNumber,
  optionalString,
  PROVIDER_TIMEOUT_MS,
  reportedFirecrawlCredits,
  SCRAPE_FORMATS,
  SITEMAP_MODES,
  validatePublicHttpUrl,
  type ScrapeFormat,
  type SitemapMode,
} from "./client.ts";

export { reportedFirecrawlCredits, validatePublicHttpUrl } from "./client.ts";

const firecrawlBilling = meteredBilling<unknown>(FIRECRAWL_COST_UNIT, (body) =>
  reportedFirecrawlCredits(body),
);

export const firecrawlScrapeSchema = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Public http(s) URL to scrape.",
  }),
  formats: Schema.optionalKey(
    Schema.Array(Schema.Literals(SCRAPE_FORMATS)).check(Schema.isMinLength(1)).annotate({
      description: "Output formats (default: ['markdown']).",
    }),
  ),
  onlyMainContent: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Strip nav, headers and footers (default: true).",
    }),
  ),
  maxAge: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Cache max age in ms; 0 forces fresh fetch.",
    }),
  ),
  waitFor: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_WAIT_FOR_MS })).annotate({
      description: "Extra JS render wait in ms (0-10000).",
    }),
  ),
  maxCharacters: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: MIN_MAX_CHARACTERS, maximum: MAX_MAX_CHARACTERS }),
    ).annotate({
      description: "Max output characters (default: 40000).",
    }),
  ),
});

export const firecrawlMapSchema = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Public http(s) site or section URL to map.",
  }),
  search: Schema.optionalKey(
    Schema.String.annotate({
      description: "Filter and rank URLs by relevance.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_MAP_LIMIT })).annotate({
      description: "Max URLs (default: 50, max: 200).",
    }),
  ),
  includeSubdomains: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Include subdomains (default: false).",
    }),
  ),
  sitemap: Schema.optionalKey(
    Schema.Literals(SITEMAP_MODES).annotate({
      description: "Sitemap mode (default: include).",
    }),
  ),
});

export const firecrawlScrapeAction = defineAction({
  name: "firecrawl_scrape",
  description:
    "Scrape a single public web page into clean Markdown (and optional HTML or page links) via Firecrawl v2. " +
    "Handles JavaScript-rendered pages, strips navigation chrome by default, and supports bounded render waits (up to 10s). " +
    "Single URL only; never retries paid requests. Bills Firecrawl credits per request.",
  schema: firecrawlScrapeSchema,
  billing: firecrawlBilling,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const key = apiKey();
      if (!key) return failed(MISSING_FIRECRAWL_KEY);

      const target = validatePublicHttpUrl(args.url);
      if ("error" in target) return failed(target.error);

      let formats: ScrapeFormat[] = ["markdown"];
      if (args.formats !== undefined) {
        if (!Array.isArray(args.formats) || args.formats.length === 0) {
          return failed("formats must be a non-empty array of 'markdown', 'html', or 'links'.");
        }
        const unique: ScrapeFormat[] = [];
        for (const item of args.formats) {
          if (typeof item !== "string" || !(SCRAPE_FORMATS as readonly string[]).includes(item)) {
            return failed(`formats entries must be one of: ${SCRAPE_FORMATS.join(", ")}.`);
          }
          if (!unique.includes(item as ScrapeFormat)) unique.push(item as ScrapeFormat);
        }
        formats = unique;
      }

      const onlyMainContent = args.onlyMainContent === undefined ? true : Boolean(args.onlyMainContent);

      let maxAge: number | undefined;
      if (args.maxAge !== undefined) {
        if (typeof args.maxAge !== "number" || !Number.isInteger(args.maxAge) || args.maxAge < 0) {
          return failed("maxAge must be a non-negative integer (milliseconds).");
        }
        maxAge = args.maxAge;
      }

      let waitFor: number | undefined;
      if (args.waitFor !== undefined) {
        if (
          typeof args.waitFor !== "number" ||
          !Number.isInteger(args.waitFor) ||
          args.waitFor < 0 ||
          args.waitFor > MAX_WAIT_FOR_MS
        ) {
          return failed(`waitFor must be an integer between 0 and ${MAX_WAIT_FOR_MS} milliseconds.`);
        }
        waitFor = args.waitFor;
      }

      let maxCharacters = DEFAULT_MAX_CHARACTERS;
      if (args.maxCharacters !== undefined) {
        if (
          typeof args.maxCharacters !== "number" ||
          !Number.isInteger(args.maxCharacters) ||
          args.maxCharacters < MIN_MAX_CHARACTERS ||
          args.maxCharacters > MAX_MAX_CHARACTERS
        ) {
          return failed(
            `maxCharacters must be an integer between ${MIN_MAX_CHARACTERS} and ${MAX_MAX_CHARACTERS}.`,
          );
        }
        maxCharacters = args.maxCharacters;
      }

      const body: Record<string, unknown> = {
        url: target.href,
        formats,
        onlyMainContent,
        timeout: PROVIDER_TIMEOUT_MS,
      };
      if (maxAge !== undefined) body.maxAge = maxAge;
      if (waitFor !== undefined) body.waitFor = waitFor;

      const posted = yield* firecrawlPost("/v2/scrape", body, {
        operation: "scrape",
        key,
        signal: ctx.signal,
        keep: ctx.keep,
      });
      if (!posted.ok) {
        return posted.cancelled ? outcome("cancelled", posted.error) : failed(posted.error);
      }

      const payload = posted.payload;
      const data = asRecord(payload.data);
      if (!data) {
        return failed("Firecrawl /v2/scrape returned an unexpected payload: missing data object.");
      }

      const metadata = asRecord(data.metadata);
      const creditsUsed = reportedFirecrawlCredits(payload);
      const title = optionalString(metadata?.title)?.trim();
      const description = optionalString(metadata?.description)?.trim();
      const sourceURL = optionalString(metadata?.sourceURL) ?? target.href;
      const resolvedUrl = optionalString(metadata?.url) ?? sourceURL;
      const statusCode = optionalNumber(metadata?.statusCode);
      const cacheState = optionalString(metadata?.cacheState);
      const pageError = optionalString(metadata?.error)?.trim();

      const markdown = optionalString(data.markdown)?.trim() ?? "";
      const html = optionalString(data.html)?.trim() ?? "";
      const links = Array.isArray(data.links)
        ? data.links.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        : [];

      const details: Record<string, unknown> = {
        provider: "firecrawl",
        url: sourceURL,
        ...(resolvedUrl !== sourceURL ? { resolvedUrl } : {}),
        ...(statusCode !== undefined ? { statusCode } : {}),
        ...(cacheState ? { cacheState } : {}),
        creditsUsed,
        formats,
      };

      const hasRequestedContent =
        (formats.includes("markdown") && Boolean(markdown)) ||
        (formats.includes("html") && Boolean(html)) ||
        (formats.includes("links") && links.length > 0);

      if (!hasRequestedContent) {
        if (pageError) {
          return failed(
            `Firecrawl scrape returned no content for ${target.href}: ${redactText(pageError, knownSecrets())}`,
          );
        }
        return outcome(
          "empty",
          `Firecrawl scraped ${target.href} (${formatCreditsNote(creditsUsed)}${statusCode !== undefined ? `; target HTTP ${statusCode}` : ""}) but returned no readable content.`,
          details,
        );
      }

      const header: string[] = [`# ${title || resolvedUrl}`];
      const metaParts: string[] = [`URL: ${resolvedUrl}`];
      if (resolvedUrl !== sourceURL) metaParts.push(`Requested: ${sourceURL}`);
      if (statusCode !== undefined) metaParts.push(`Target HTTP: ${statusCode}`);
      if (cacheState) metaParts.push(`Cache: ${cacheState}`);
      metaParts.push(`Usage: ${formatCreditsNote(creditsUsed)}`);
      header.push(metaParts.join(" | "));
      if (description) header.push(`Description: ${description}`);
      if (pageError) header.push(`Warning from target page: ${redactText(pageError, knownSecrets())}`);
      header.push("");

      const sections: string[] = [];
      let truncated = false;
      let remaining = maxCharacters;

      const pushBudgeted = (heading: string | null, content: string): void => {
        if (!content) return;
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        const slice = content.length > remaining ? content.slice(0, remaining) : content;
        if (content.length > remaining) truncated = true;
        remaining -= slice.length;
        if (heading) sections.push(heading, "");
        sections.push(slice);
        if (content.length > slice.length) {
          sections.push(
            `\n[Truncated at ${maxCharacters} characters; full response is in the retained original when keep_raw is enabled.]`,
          );
        }
        sections.push("");
      };

      if (formats.includes("markdown") && markdown) {
        pushBudgeted(formats.length > 1 ? "## Markdown" : null, markdown);
      }
      if (formats.includes("html") && html) {
        pushBudgeted("## HTML", html);
      }
      if (formats.includes("links") && links.length > 0) {
        const shown = links.slice(0, MAX_MAP_LIMIT);
        const listText =
          shown.map((link) => `- ${link}`).join("\n") +
          (links.length > shown.length
            ? `\n(${links.length - shown.length} more links in retained original)`
            : "");
        pushBudgeted(`## Links (${links.length})`, listText);
      }

      const totalCharacters = markdown.length + html.length;
      return outcome("success", `${header.join("\n")}\n${sections.join("\n").trim()}`, {
        ...details,
        totalCharacters,
        truncated,
        ...(links.length > 0 ? { linksCount: links.length } : {}),
      });
    }),
});

interface MapEntry {
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
}

function parseMapLink(entry: unknown): MapEntry | null {
  if (typeof entry === "string" && entry.trim()) return { url: entry.trim() };
  const record = asRecord(entry);
  const url = optionalString(record?.url)?.trim();
  if (!url) return null;
  return {
    url,
    title: optionalString(record?.title)?.trim() || undefined,
    description: optionalString(record?.description)?.trim() || undefined,
  };
}

export const firecrawlMapAction = defineAction({
  name: "firecrawl_map",
  description:
    "Discover URLs on a public website via Firecrawl v2 /v2/map with optional relevance search filtering. " +
    "Returns up to 200 discovered URLs (default 50) without scraping page bodies, so you can pick specific pages for firecrawl_scrape. " +
    "Never retries paid requests. Bills Firecrawl credits per request.",
  schema: firecrawlMapSchema,
  billing: firecrawlBilling,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const key = apiKey();
      if (!key) return failed(MISSING_FIRECRAWL_KEY);

      const target = validatePublicHttpUrl(args.url);
      if ("error" in target) return failed(target.error);

      const search = typeof args.search === "string" ? args.search.trim() : "";

      let limit = DEFAULT_MAP_LIMIT;
      if (args.limit !== undefined) {
        if (
          typeof args.limit !== "number" ||
          !Number.isInteger(args.limit) ||
          args.limit < 1 ||
          args.limit > MAX_MAP_LIMIT
        ) {
          return failed(`limit must be an integer between 1 and ${MAX_MAP_LIMIT}.`);
        }
        limit = args.limit;
      }

      let sitemap: SitemapMode | undefined;
      if (args.sitemap !== undefined) {
        if (typeof args.sitemap !== "string" || !(SITEMAP_MODES as readonly string[]).includes(args.sitemap)) {
          return failed(`sitemap must be one of: ${SITEMAP_MODES.join(", ")}.`);
        }
        sitemap = args.sitemap as SitemapMode;
      }

      const body: Record<string, unknown> = {
        url: target.href,
        limit,
        timeout: PROVIDER_TIMEOUT_MS,
      };
      if (search) body.search = search;
      if (args.includeSubdomains !== undefined) body.includeSubdomains = Boolean(args.includeSubdomains);
      if (sitemap) body.sitemap = sitemap;

      const posted = yield* firecrawlPost("/v2/map", body, {
        operation: "map",
        key,
        signal: ctx.signal,
        keep: ctx.keep,
      });
      if (!posted.ok) {
        return posted.cancelled ? outcome("cancelled", posted.error) : failed(posted.error);
      }

      const payload = posted.payload;
      if (!Array.isArray(payload.links)) {
        return failed("Firecrawl /v2/map returned an unexpected payload: missing links array.");
      }

      const creditsUsed = reportedFirecrawlCredits(payload);
      const parsed = payload.links
        .map(parseMapLink)
        .filter((item): item is MapEntry => item !== null);
      const shown = parsed.slice(0, limit);

      const details: Record<string, unknown> = {
        provider: "firecrawl",
        url: target.href,
        ...(search ? { search } : {}),
        count: shown.length,
        totalReturned: parsed.length,
        creditsUsed,
      };

      if (shown.length === 0) {
        return outcome(
          "empty",
          `Firecrawl map found no URLs for ${target.href}${search ? ` matching "${search}"` : ""} (${formatCreditsNote(creditsUsed)}).`,
          details,
        );
      }

      const lines: string[] = [
        `Firecrawl map for ${target.href}${search ? ` (filter: "${search}")` : ""}: ${shown.length} URL${shown.length === 1 ? "" : "s"} (${formatCreditsNote(creditsUsed)})`,
        "",
      ];
      for (let i = 0; i < shown.length; i++) {
        const item = shown[i];
        const suffix = item.title ? ` — ${item.title}` : "";
        lines.push(`${i + 1}. ${item.url}${suffix}`);
        if (item.description) {
          const desc = item.description.replace(/\s+/g, " ");
          lines.push(`   ${desc.length > 200 ? `${desc.slice(0, 200)}...` : desc}`);
        }
      }
      if (parsed.length > shown.length) {
        lines.push(
          "",
          `Showing first ${shown.length} of ${parsed.length} returned URLs (capped at limit ${limit}).`,
        );
      }

      return outcome("success", lines.join("\n"), details);
    }),
});

export const firecrawlSource: SourcePlugin = defineSource({
  id: "firecrawl",
  group: "web",
  label: "Firecrawl",
  description: "Single-page Markdown scraping and site URL mapping",
  about:
    "Turns a single public web page into clean Markdown (including JavaScript-rendered pages) and maps discovered URLs on a site with optional relevance filtering. Bounded to single-page scrapes and URL maps without multi-page crawls.",
  providers: [{ name: "Firecrawl", url: "https://firecrawl.dev" }],
  billing:
    "Firecrawl credits per request, from your Firecrawl account. Dig records the credits each response reports, and shows cost as unknown when a response omits them.",
  env: ["FIRECRAWL_API_KEY"],
  keys: ["FIRECRAWL_API_KEY"],
  credential: "FIRECRAWL_API_KEY",
  actions: [firecrawlScrapeAction, firecrawlMapAction],
});

export default firecrawlSource;
