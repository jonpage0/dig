// Type-only: the host supplies the builder (`Type`), so this module adds no
// runtime schema dependency of its own.
import type { Type, TSchema } from "@sinclair/typebox";
import { REPORT_STATUSES, TOPIC_VOLATILITIES } from "./library/files.js";
import { ALL_MODULES } from "./modules.js";
import { createFacebookSchemas } from "./facebook-schemas.js";
import { createFacebookAdsSchemas } from "./facebook-ads-schemas.js";
type Typebox = typeof Type;
type Schema = TSchema;

function enumSchema(
  T: Typebox,
  values: readonly string[],
  description: string,
) {
  return T.Optional(
    T.Union(
      values.map((value) => T.Literal(value)),
      { description },
    ),
  );
}

function requiredEnumSchema(
  T: Typebox,
  values: readonly string[],
  description: string,
) {
  return T.Union(
    values.map((value) => T.Literal(value)),
    { description },
  );
}

function stringArray(T: Typebox, description: string) {
  return T.Optional(T.Array(T.String(), { description }));
}

function messageArraySchema(T: Typebox) {
  return T.Array(
    T.Object({
      role: requiredEnumSchema(
        T,
        ["system", "user", "assistant"],
        "Role of the message sender",
      ),
      content: T.String({ description: "The content of the message" }),
    }),
    { description: "Array of conversation messages" },
  );
}

export function createSchemas(
  T: Typebox,
  sources: readonly string[] = ALL_MODULES,
): Record<string, TSchema> {
  const schemas: Record<string, Schema> = {
    ...createFacebookSchemas(T),
    ...createFacebookAdsSchemas(T),
    hackernews: T.Object({
      query: T.String({ description: "Search query." }),
      days: T.Optional(
        T.Number({ description: "Look back N days (default: 30)." }),
      ),
      limit: T.Optional(
        T.Number({ description: "Max results (default: 20, max: 50)." }),
      ),
      type: enumSchema(
        T,
        ["story", "comment", "all"],
        "Filter by result type.",
      ),
      sort: enumSchema(
        T,
        ["relevance", "date"],
        "Sort by relevance or newest first.",
      ),
    }),
    polymarket: T.Object({
      query: T.String({
        description: "Prediction-market topic, entity, event, or question.",
      }),
      limit: T.Optional(
        T.Number({ description: "Max events (default: 10, max: 30)." }),
      ),
      page: T.Optional(
        T.Number({ description: "Pagination page (default: 1)." }),
      ),
    }),
    reddit: T.Object(
      {
        query: T.Optional(
          T.String({
            description: "Search query. Required unless postUrl is given.",
          }),
        ),
        postUrl: T.Optional(
          T.String({
            description:
              "Reddit post URL to read comments from directly (post-comments mode); combine with cursor to continue.",
          }),
        ),
        filter: enumSchema(
          T,
          ["posts", "comments"],
          "Search posts (default) or comment text.",
        ),
        sort: enumSchema(
          T,
          ["relevance", "hot", "top", "new", "comments"],
          "Sort order. 'hot' works only inside subreddits; comment searches accept relevance, top, new.",
        ),
        timeframe: enumSchema(
          T,
          ["all", "hour", "day", "week", "month", "year"],
          "Post-search time window. 'hour' works only inside subreddits.",
        ),
        subreddits: stringArray(
          T,
          "Optional subreddits to search (max 5, names without r/), one request each.",
        ),
        cursor: T.Optional(
          T.String({
            description:
              "Continuation token from a previous response: `after` for all-Reddit search, the cursor for a single-subreddit search, or a comments/replies cursor with postUrl.",
          }),
        ),
        limit: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 40,
            description: "Max results to display (default: 15, max: 40).",
          }),
        ),
        includeComments: T.Optional(
          T.Boolean({
            description:
              "Post searches only. Fetch the first top-level comments for the leading threads (default: true; 1 credit per thread).",
          }),
        ),
        commentThreads: T.Optional(
          T.Integer({
            minimum: 0,
            maximum: 10,
            description:
              "How many threads to fetch comments for (default: 5, max: 10).",
          }),
        ),
        allowNsfw: T.Optional(
          T.Boolean({
            description:
              "Keep posts Reddit marks NSFW (default: false; exclusions are counted in the header).",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    tikhub_reddit: T.Object(
      {
        operation: requiredEnumSchema(
          T,
          [
            "discovery_bundle",
            "query_scout",
            "subreddit_context",
            "thread_intelligence",
            "deep_thread",
            "author_context",
            "batch_enrich",
            "feed_discovery",
          ],
          "High-level TikHub Reddit operation.",
        ),
        query: T.Optional(
          T.String({
            description: "Search query for query_scout/discovery_bundle.",
          }),
        ),
        searchType: enumSchema(
          T,
          ["post", "community", "comment", "media", "people"],
          "Dynamic search type; query_scout only.",
        ),
        sort: T.Optional(
          T.String({
            description:
              "Operation-specific sort: search RELEVANCE/HOT/TOP/NEW/COMMENTS (COMMENTS posts only); feeds include BEST/RISING/CONTROVERSIAL; comments CONFIDENCE/NEW/TOP/HOT/CONTROVERSIAL/OLD/RANDOM.",
          }),
        ),
        timeRange: enumSchema(
          T,
          ["all", "year", "month", "week", "day", "hour"],
          "Time range for post/media search and popular/channel feeds; unsupported combinations are reported.",
        ),
        subredditName: T.Optional(
          T.String({ description: "Subreddit name, with or without r/." }),
        ),
        subredditId: T.Optional(
          T.String({ description: "Reddit subreddit fullname like t5_abc." }),
        ),
        postId: T.Optional(
          T.String({
            description: "Reddit post fullname/id, usually t3_... .",
          }),
        ),
        postIds: stringArray(
          T,
          "Post IDs: max 5 for thread_intelligence, max 30 for batch_enrich.",
        ),
        username: T.Optional(
          T.String({ description: "Reddit username, with or without u/." }),
        ),
        includeSettings: T.Optional(
          T.Boolean({
            description: "Fetch subreddit settings when available.",
          }),
        ),
        includeStyle: T.Optional(
          T.Boolean({ description: "Fetch subreddit rules/style." }),
        ),
        includeHighlights: T.Optional(
          T.Boolean({ description: "Fetch community highlights." }),
        ),
        includeSubredditContext: T.Optional(
          T.Boolean({
            description:
              "Fetch lightweight context/feed for surfaced communities.",
          }),
        ),
        includeBatchEnrich: T.Optional(
          T.Boolean({
            description: "Batch-enrich surfaced post IDs when available.",
          }),
        ),
        includeUserHistory: T.Optional(
          T.Boolean({ description: "Fetch recent user posts/comments." }),
        ),
        includeReplies: T.Optional(
          T.Boolean({
            description:
              "Fetch bounded collapsed-reply cursors from the first comment page.",
          }),
        ),
        maxReplyCursors: T.Optional(
          T.Integer({
            minimum: 0,
            maximum: 8,
            description:
              "Max collapsed reply cursors to complete (thread_intelligence caps at 5 per post).",
          }),
        ),
        feed: enumSchema(
          T,
          ["popular", "news", "subreddit", "subreddit_channels"],
          "Feed type for feed_discovery.",
        ),
        after: T.Optional(
          T.String({
            description:
              "Exact cursor returned for this listing; never reuse across independent listings.",
          }),
        ),
        afterTarget: enumSchema(
          T,
          ["user_posts", "user_comments"],
          "Required with after for author_context: select which independent listing owns the cursor.",
        ),
        allowNsfw: T.Optional(
          T.Boolean({
            description: "Allow NSFW results where TikHub supports it.",
          }),
        ),
        maxItems: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 25,
            description:
              "Max candidate items to format, not a complete dataset.",
          }),
        ),
        needFormat: T.Optional(
          T.Boolean({ description: "Pass TikHub need_format flag." }),
        ),
      },
      { additionalProperties: false },
    ),
    youtube: T.Object({
      query: T.String({ description: "YouTube search query." }),
      days: T.Optional(
        T.Number({ description: "Prefer videos from the last N days." }),
      ),
      limit: T.Optional(
        T.Number({ description: "Max videos (default: 15, max: 25)." }),
      ),
      transcripts: T.Optional(
        T.Boolean({
          description: "Fetch and save full transcripts via yt-dlp.",
        }),
      ),
    }),
    papers_semantic_scholar_search: T.Object({
      query: T.String({ description: "Paper/literature query." }),
      limit: T.Optional(
        T.Number({ description: "Max papers (default: 10, max: 20)." }),
      ),
      yearFrom: T.Optional(
        T.Number({ description: "Only papers in or after this year." }),
      ),
      yearTo: T.Optional(
        T.Number({ description: "Only papers in or before this year." }),
      ),
      fieldsOfStudy: stringArray(T, "Semantic Scholar fields of study filter."),
      minCitationCount: T.Optional(
        T.Number({ description: "Minimum citation count." }),
      ),
      openAccessOnly: T.Optional(
        T.Boolean({ description: "Only include open-access PDFs." }),
      ),
      sort: enumSchema(
        T,
        ["relevance", "citationCount", "publicationDate"],
        "Sort mode.",
      ),
    }),
    papers_semantic_scholar_recommendations: T.Object({
      positivePaperIds: T.Array(T.String(), {
        description: "Semantic Scholar paper IDs to seed recommendations.",
      }),
      negativePaperIds: stringArray(
        T,
        "Optional paper IDs to steer away from.",
      ),
      limit: T.Optional(
        T.Number({
          description: "Max recommendations (default: 10, max: 20).",
        }),
      ),
    }),
    papers_openalex_search: T.Object({
      query: T.String({ description: "Paper/literature query." }),
      limit: T.Optional(
        T.Number({ description: "Max works (default: 10, max: 25)." }),
      ),
      page: T.Optional(T.Number({ description: "Pagination page." })),
      yearFrom: T.Optional(
        T.Number({ description: "Only works in or after this year." }),
      ),
      yearTo: T.Optional(
        T.Number({ description: "Only works in or before this year." }),
      ),
      openAccessOnly: T.Optional(
        T.Boolean({ description: "Only include open-access works." }),
      ),
      sort: enumSchema(
        T,
        ["relevance", "cited_by_count", "publication_date"],
        "Sort mode.",
      ),
    }),
    papers_multi_search: T.Object(
      {
        query: T.String({
          description:
            "Paper/literature query for federated multi-source search.",
        }),
        sources: T.Optional(
          T.Union([T.String(), T.Array(T.String())], {
            description:
              "Comma-separated string or array of sources (arxiv, pubmed, biorxiv, medrxiv, pmc, europepmc, crossref, openalex, semantic, dblp, doaj, zenodo, hal, iacr, core, openaire, ssrn, unpaywall, google_scholar). Default: all 19 enabled connectors (slower), not a guarantee of availability. base/citeseerx are disabled; unknown/disabled requests fail explicitly. Inspect per-source health before treating zero counts as no matches.",
          }),
        ),
        maxResults: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 20,
            description:
              "Bounded results per source (default: 5, max: 20), not provider totals.",
          }),
        ),
        year: T.Optional(
          T.String({
            description:
              "Year filter applied only to Semantic Scholar, e.g. '2020' or '2018-2022'. Other sources' omission is reported in coverage.year_not_applied_to.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    papers_fulltext_read: T.Object({
      source: T.String({
        description:
          "Source platform the paper_id belongs to (e.g. arxiv, biorxiv, medrxiv, pmc, europepmc, semantic, zenodo, hal, core). IACR read is Cloudflare-blocked; SSRN is metadata-only.",
      }),
      paperId: T.String({
        description:
          "Paper identifier exactly as reported by search results for that source.",
      }),
    }),
    papers_pdf_download: T.Object({
      source: T.String({
        description:
          "Source platform the paper_id belongs to (e.g. arxiv, biorxiv, medrxiv, pmc, europepmc, iacr, semantic, zenodo, hal).",
      }),
      paperId: T.String({
        description:
          "Paper identifier exactly as reported by search results for that source.",
      }),
      savePath: T.Optional(
        T.String({
          description:
            "Directory to save the PDF (default: the library's papers/ folder).",
        }),
      ),
    }),
    china_social_search: T.Object(
      {
        query: T.String({
          minLength: 1,
          description: "China social search query.",
        }),
        platforms: T.Optional(
          T.Array(
            requiredEnumSchema(
              T,
              [
                "xiaohongshu",
                "bilibili",
                "douyin",
                "weibo",
                "zhihu",
                "kuaishou",
                "wechat",
              ],
              "China social platform",
            ),
            {
              description:
                "Platforms to search. A cursor requires exactly one platform. WeChat costs $0.01 per TikHub request.",
            },
          ),
        ),
        limit: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 8,
            description:
              "Max normalized items per platform, not provider page size.",
          }),
        ),
        provider: enumSchema(
          T,
          ["auto", "tikhub", "justone"],
          "Provider choice. auto selects TikHub; Just One is explicit and credential-gated.",
        ),
        page: T.Optional(
          T.Integer({
            minimum: 1,
            description:
              "Page for Bilibili/Weibo/Zhihu/XHS. XHS page 2+ also needs both session IDs. Omit for cursor-only providers.",
          }),
        ),
        cursor: T.Optional(
          T.Union(
            [
              T.String({
                description:
                  "Exact opaque cursor for Kuaishou/WeChat/Just One or Zhihu search hash.",
              }),
              T.Object(
                {
                  search_id: T.String({ minLength: 1 }),
                  search_session_id: T.String({ minLength: 1 }),
                },
                {
                  additionalProperties: false,
                  description:
                    "XHS session state from first response; also set page.",
                },
              ),
              T.Object(
                {
                  cursor: T.Integer({ minimum: 0 }),
                  search_id: T.String({ minLength: 1 }),
                  backtrace: T.String(),
                },
                {
                  additionalProperties: false,
                  description:
                    "Douyin state from prior response; never derive cursor from page.",
                },
              ),
            ],
            {
              description:
                "Returned pagination state, scoped to exactly one platform. Preserve values verbatim.",
            },
          ),
        ),
        justone_start: T.Optional(
          T.String({
            pattern: "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$",
            description:
              "Just One initial start date yyyy-MM-dd HH:mm:ss; required with justone_end on first call.",
          }),
        ),
        justone_end: T.Optional(
          T.String({
            pattern: "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$",
            description:
              "Just One end date yyyy-MM-dd HH:mm:ss. Common time_range does not substitute for this boundary.",
          }),
        ),
        sort: enumSchema(
          T,
          ["relevance", "latest", "hot"],
          "Common sort intent. Unsupported combinations are reported.",
        ),
        time_range: enumSchema(
          T,
          ["all", "day", "week", "month", "half_year"],
          "Publication-time intent. XHS/Douyin/WeChat month and Kuaishou half_year are unsupported.",
        ),
        weibo_search_type: enumSchema(
          T,
          [
            "normal",
            "realtime",
            "hot",
            "original",
            "verified",
            "media",
            "viewpoint",
            "image",
            "video",
            "user",
            "topic",
          ],
          "Weibo Web V2 vertical. Retired article vertical is unsupported. Separate verticals have separate filter support.",
        ),
        wechat_vertical: enumSchema(
          T,
          [
            "all",
            "account",
            "article",
            "video",
            "sticker",
            "live_stream",
            "moments",
            "news",
            "book",
            "listen",
            "image",
            "encyclopedia",
            "weixin_index",
          ],
          "WeChat vertical; all/account/article/video/sticker are documented usable. Others are account/region-gated and may be billed empty; inspect returned categories.",
        ),
      },
      { additionalProperties: false },
    ),
    commerce_search: T.Object(
      {
        query: T.Optional(
          T.String({
            description:
              "Amazon product query, keyword, brand, or category. Optional only when seller is supplied.",
          }),
        ),
        amazon_domain: enumSchema(
          T,
          [
            "amazon.com",
            "amazon.ca",
            "amazon.co.uk",
            "amazon.de",
            "amazon.fr",
            "amazon.it",
            "amazon.es",
            "amazon.co.jp",
            "amazon.in",
            "amazon.ie",
            "amazon.co.za",
            "amazon.com.mx",
            "amazon.com.br",
            "amazon.com.au",
            "amazon.com.tr",
            "amazon.nl",
            "amazon.com.be",
            "amazon.pl",
            "amazon.se",
            "amazon.ae",
            "amazon.sa",
            "amazon.sg",
            "amazon.eg",
          ],
          "Amazon marketplace (23 Scrape.do marketplaces). Default: amazon.com.",
        ),
        page: T.Optional(
          T.Integer({
            minimum: 1,
            description: "Search results page. Default: 1.",
          }),
        ),
        limit: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 10,
            description: "Max normalized results (default: 5, max: 10).",
          }),
        ),
        seller: T.Optional(
          T.String({
            description:
              "Amazon seller id (for example A2L77EE7U53NWQ). Restricts results to that seller's catalog; usable without query.",
          }),
        ),
        sort: T.Optional(
          T.String({
            description:
              "Raw Amazon sort key passed through as s (for example price-asc-rank, price-desc-rank, review-rank, date-desc-rank).",
          }),
        ),
        refinement: T.Optional(
          T.String({
            description:
              "Amazon refinement string passed through as rh (for example n:172282,p_72:1248915011); take values from a previous result's filter options.",
          }),
        ),
        node: T.Optional(
          T.String({
            description: "Amazon category node id to scope the search.",
          }),
        ),
        low_price: T.Optional(
          T.Number({
            minimum: 0,
            description:
              "Lower price bound in marketplace currency (at most two decimals).",
          }),
        ),
        high_price: T.Optional(
          T.Number({
            minimum: 0,
            description:
              "Upper price bound in marketplace currency (at most two decimals).",
          }),
        ),
        language: T.Optional(
          T.String({
            description:
              "Uppercase ISO 639-1 page language supported by the marketplace (for example EN, DE).",
          }),
        ),
        provider: enumSchema(T, ["auto", "scrape-do"], "Provider choice."),
      },
      { additionalProperties: false },
    ),
    commerce_product: T.Object(
      {
        asin: T.Optional(T.String({ description: "Amazon ASIN to inspect." })),
        gtin: T.Optional(
          T.String({
            description: "GTIN / UPC / EAN / ISBN to resolve and inspect.",
          }),
        ),
        url: T.Optional(
          T.String({ description: "Amazon product URL to inspect." }),
        ),
        amazon_domain: enumSchema(
          T,
          [
            "amazon.com",
            "amazon.ca",
            "amazon.co.uk",
            "amazon.de",
            "amazon.fr",
            "amazon.it",
            "amazon.es",
            "amazon.co.jp",
            "amazon.in",
            "amazon.ie",
            "amazon.co.za",
            "amazon.com.mx",
            "amazon.com.br",
            "amazon.com.au",
            "amazon.com.tr",
            "amazon.nl",
            "amazon.com.be",
            "amazon.pl",
            "amazon.se",
            "amazon.ae",
            "amazon.sa",
            "amazon.sg",
            "amazon.eg",
          ],
          "Amazon marketplace (23 Scrape.do marketplaces). Default: amazon.com or inferred from url.",
        ),
        language: T.Optional(
          T.String({
            description:
              "Uppercase ISO 639-1 page language supported by the marketplace (for example EN, DE).",
          }),
        ),
        provider: enumSchema(T, ["auto", "scrape-do"], "Provider choice."),
      },
      { additionalProperties: false },
    ),
    commerce_history: T.Object(
      {
        asin: T.String({ description: "Amazon ASIN to inspect." }),
        amazon_domain: enumSchema(
          T,
          [
            "amazon.com",
            "amazon.ca",
            "amazon.co.uk",
            "amazon.de",
            "amazon.fr",
            "amazon.it",
            "amazon.es",
            "amazon.co.jp",
            "amazon.com.mx",
            "amazon.in",
            "amazon.com.br",
          ],
          "Amazon marketplace (11 Nexscope history markets). Default: amazon.com.",
        ),
        days: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 365,
            description: "Historical window in days (default: 90, max: 365).",
          }),
        ),
        series: T.Optional(
          T.Array(
            requiredEnumSchema(
              T,
              [
                "market_price",
                "buy_box",
                "list_price",
                "deal_price",
                "prime_price",
                "fba_price",
                "fbm_price",
                "coupon_price",
                "sales_rank",
                "seller_count",
                "rating",
                "review_count",
                "monthly_sold",
              ],
              "Historical series",
            ),
            { description: "Series to include." },
          ),
        ),
        max_points: T.Optional(
          T.Integer({
            minimum: 4,
            maximum: 200,
            description:
              "Maximum displayed observations per series after full-series statistics are computed.",
          }),
        ),
        provider: enumSchema(T, ["auto", "nexscope"], "Provider choice."),
      },
      { additionalProperties: false },
    ),
    exa_search: T.Object(
      {
        query: T.String({ description: "Natural-language Exa search query." }),
        numResults: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 100,
            description:
              "Number of results (default: 10, max: 100; results above 10 bill $1/1k each).",
          }),
        ),
        type: enumSchema(
          T,
          ["instant", "fast", "auto", "deep-lite", "deep", "deep-reasoning"],
          "Search mode: auto (default), fast/instant for latency, deep-lite/deep/deep-reasoning for opt-in iterative research ($12-15/1k).",
        ),
        category: T.Optional(
          T.String({
            description:
              "Data category focus: company, publication, news, personal site, financial report, people; other strings are hints. company/people reject date filters and excludeDomains.",
          }),
        ),
        includeDomains: stringArray(
          T,
          "Only results from these domains or paths (wildcards like *.substack.com, paths like exa.ai/blog).",
        ),
        excludeDomains: stringArray(
          T,
          "Exclude results from these domains or paths.",
        ),
        startPublishedDate: T.Optional(
          T.String({
            description: "Only results published after this ISO 8601 date.",
          }),
        ),
        endPublishedDate: T.Optional(
          T.String({
            description: "Only results published before this ISO 8601 date.",
          }),
        ),
        contents: T.Optional(
          T.Boolean({
            description:
              "Return page text and highlights per result (default: true).",
          }),
        ),
        summary: T.Optional(
          T.Boolean({
            description:
              "Also return an Exa AI summary per result (default: false; bills $1/1k pages).",
          }),
        ),
        highlightMaxCharacters: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 10000,
            description:
              "Per-page highlight character budget; not compatible with dynamicHighlights.",
          }),
        ),
        dynamicHighlights: T.Optional(
          T.Boolean({
            description:
              "Opt in to Exa Dynamic Highlights (research preview, shared budget across the result set; sends the Exa-Beta header).",
          }),
        ),
        maxAgeHours: T.Optional(
          T.Integer({
            minimum: -1,
            maximum: 720,
            description:
              "Content freshness: omit for cache with live fallback, 0 always fresh, -1 cache only, N refetch if older than N hours.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    exa_contents: T.Object(
      {
        urls: T.Array(T.String(), {
          description:
            "URLs to extract (max 100; keep batches small, output is full text).",
        }),
        query: T.Optional(
          T.String({
            description:
              "Optional query guiding highlight (and summary) selection.",
          }),
        ),
        maxCharacters: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 10000,
            description: "Max characters of page text per URL (default: 5000).",
          }),
        ),
        summary: T.Optional(
          T.Boolean({
            description:
              "Also return an Exa AI summary per page (default: false; bills an extra content type).",
          }),
        ),
        highlightMaxCharacters: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 10000,
            description:
              "Per-page highlight character budget; not compatible with dynamicHighlights.",
          }),
        ),
        dynamicHighlights: T.Optional(
          T.Boolean({
            description:
              "Opt in to Exa Dynamic Highlights (research preview; sends the Exa-Beta header).",
          }),
        ),
        maxAgeHours: T.Optional(
          T.Integer({
            minimum: -1,
            maximum: 720,
            description:
              "Content freshness: omit for cache with live fallback, 0 always fresh, -1 cache only, N refetch if older than N hours.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    exa_similar: T.Object(
      {
        url: T.String({ description: "Reference URL." }),
        numResults: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 100,
            description: "Number of similar results (default: 10, max: 100).",
          }),
        ),
        excludeSourceDomain: T.Optional(
          T.Boolean({
            description: "Exclude results from the reference URL's own domain.",
          }),
        ),
        includeDomains: stringArray(T, "Only include these domains or paths."),
        excludeDomains: stringArray(T, "Exclude these domains or paths."),
        startPublishedDate: T.Optional(
          T.String({
            description: "Only results published after this ISO 8601 date.",
          }),
        ),
        endPublishedDate: T.Optional(
          T.String({
            description: "Only results published before this ISO 8601 date.",
          }),
        ),
        category: T.Optional(
          T.String({
            description:
              "Data category focus (company, publication, news, personal site, financial report, people).",
          }),
        ),
        contents: T.Optional(
          T.Boolean({
            description:
              "Return page text and highlights per result (default: true).",
          }),
        ),
        summary: T.Optional(
          T.Boolean({
            description:
              "Also return an Exa AI summary per result (default: false; bills $1/1k pages).",
          }),
        ),
        highlightMaxCharacters: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 10000,
            description:
              "Per-page highlight character budget; not compatible with dynamicHighlights.",
          }),
        ),
        dynamicHighlights: T.Optional(
          T.Boolean({
            description:
              "Opt in to Exa Dynamic Highlights (research preview; sends the Exa-Beta header).",
          }),
        ),
        maxAgeHours: T.Optional(
          T.Integer({
            minimum: -1,
            maximum: 720,
            description:
              "Content freshness: omit for cache with live fallback, 0 always fresh, -1 cache only, N refetch if older than N hours.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    exa_research: T.Object(
      {
        query: T.String({
          description:
            "What to research (natural-language question or task). One deep-reasoning /search call, $15/1k, 12-40s.",
        }),
        systemPrompt: T.Optional(
          T.String({
            description:
              "How to conduct and present the research: source preferences, novelty/deduplication constraints, organization.",
          }),
        ),
        additionalQueries: stringArray(
          T,
          "Up to 10 meaningfully different search directions Exa should also cover.",
        ),
        numResults: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 100,
            description:
              "Selected source pages to return (default: 10, max: 100).",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    perplexity_ask: T.Object(
      {
        messages: messageArraySchema(T),
        search_domain_filter: T.Optional(
          T.Array(T.String({ minLength: 1, maxLength: 253 }), {
            maxItems: 20,
            description:
              "Up to 20 domains/URLs, all allowlist or all '-' prefixed denylist.",
          }),
        ),
        search_recency_filter: enumSchema(
          T,
          ["hour", "day", "week", "month", "year"],
          "Publication recency.",
        ),
        search_after_date_filter: T.Optional(
          T.String({
            pattern: "^\\d{2}/\\d{2}/\\d{4}$",
            description: "Published after MM/DD/YYYY.",
          }),
        ),
        search_before_date_filter: T.Optional(
          T.String({
            pattern: "^\\d{2}/\\d{2}/\\d{4}$",
            description: "Published before MM/DD/YYYY.",
          }),
        ),
        last_updated_after_filter: T.Optional(
          T.String({
            pattern: "^\\d{2}/\\d{2}/\\d{4}$",
            description: "Updated after MM/DD/YYYY.",
          }),
        ),
        last_updated_before_filter: T.Optional(
          T.String({
            pattern: "^\\d{2}/\\d{2}/\\d{4}$",
            description: "Updated before MM/DD/YYYY.",
          }),
        ),
        search_context_size: enumSchema(
          T,
          ["low", "medium", "high"],
          "Named search context budget. Agent preset token budgets take precedence; Search API forbids combining this with explicit budgets.",
        ),
        max_tokens: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 1000000,
            description: "Total search context token budget.",
          }),
        ),
        max_tokens_per_page: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 1000000,
            description: "Search context tokens per page.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    perplexity_search: T.Object(
      {
        query: T.Union(
          [
            T.String({ minLength: 1 }),
            T.Array(T.String({ minLength: 1 }), { minItems: 1, maxItems: 5 }),
          ],
          {
            description:
              "One search query or 1-5 related queries; results are combined, not attributed to each query.",
          },
        ),
        search_type: enumSchema(
          T,
          ["web", "people"],
          "Web search (default) or people search.",
        ),
        max_results: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 50,
            description:
              "1-20 for web, 1-50 for people; default 10. Runtime enforces the search-type limit.",
          }),
        ),
        country: T.Optional(
          T.String({
            pattern: "^[A-Za-z]{2}$",
            description: "ISO 3166-1 alpha-2 country code.",
          }),
        ),
        search_language_filter: T.Optional(
          T.Array(T.String({ pattern: "^[A-Za-z]{2}$" }), {
            maxItems: 20,
            description:
              "ISO 639-1 language codes; API reference allows 20, quickstart recommends at most 10.",
          }),
        ),
        search_domain_filter: T.Optional(
          T.Array(T.String({ minLength: 1, maxLength: 253 }), {
            maxItems: 20,
            description:
              "Up to 20 domains/URLs, all allowlist or all '-' prefixed denylist.",
          }),
        ),
        search_recency_filter: enumSchema(
          T,
          ["hour", "day", "week", "month", "year"],
          "Publication recency.",
        ),
        search_after_date_filter: T.Optional(
          T.String({
            pattern: "^\\d{2}/\\d{2}/\\d{4}$",
            description: "Published after MM/DD/YYYY.",
          }),
        ),
        search_before_date_filter: T.Optional(
          T.String({
            pattern: "^\\d{2}/\\d{2}/\\d{4}$",
            description: "Published before MM/DD/YYYY.",
          }),
        ),
        last_updated_after_filter: T.Optional(
          T.String({
            pattern: "^\\d{2}/\\d{2}/\\d{4}$",
            description: "Updated after MM/DD/YYYY.",
          }),
        ),
        last_updated_before_filter: T.Optional(
          T.String({
            pattern: "^\\d{2}/\\d{2}/\\d{4}$",
            description: "Updated before MM/DD/YYYY.",
          }),
        ),
        search_context_size: enumSchema(
          T,
          ["low", "medium", "high"],
          "Named search context budget. Agent preset token budgets take precedence; Search API forbids combining this with explicit budgets.",
        ),
        max_tokens: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 1000000,
            description: "Total search context token budget.",
          }),
        ),
        max_tokens_per_page: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 1000000,
            description: "Search context tokens per page.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    perplexity_research: T.Object(
      {
        messages: messageArraySchema(T),
        search_domain_filter: T.Optional(
          T.Array(T.String({ minLength: 1, maxLength: 253 }), {
            maxItems: 20,
            description:
              "Up to 20 domains/URLs, all allowlist or all '-' prefixed denylist.",
          }),
        ),
        search_recency_filter: enumSchema(
          T,
          ["hour", "day", "week", "month", "year"],
          "Publication recency.",
        ),
        search_after_date_filter: T.Optional(
          T.String({
            pattern: "^\\d{2}/\\d{2}/\\d{4}$",
            description: "Published after MM/DD/YYYY.",
          }),
        ),
        search_before_date_filter: T.Optional(
          T.String({
            pattern: "^\\d{2}/\\d{2}/\\d{4}$",
            description: "Published before MM/DD/YYYY.",
          }),
        ),
        last_updated_after_filter: T.Optional(
          T.String({
            pattern: "^\\d{2}/\\d{2}/\\d{4}$",
            description: "Updated after MM/DD/YYYY.",
          }),
        ),
        last_updated_before_filter: T.Optional(
          T.String({
            pattern: "^\\d{2}/\\d{2}/\\d{4}$",
            description: "Updated before MM/DD/YYYY.",
          }),
        ),
        search_context_size: enumSchema(
          T,
          ["low", "medium", "high"],
          "Named search context budget. Agent preset token budgets take precedence; Search API forbids combining this with explicit budgets.",
        ),
        max_tokens: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 1000000,
            description: "Total search context token budget.",
          }),
        ),
        max_tokens_per_page: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 1000000,
            description: "Search context tokens per page.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    perplexity_reason: T.Object(
      {
        messages: messageArraySchema(T),
        search_domain_filter: T.Optional(
          T.Array(T.String({ minLength: 1, maxLength: 253 }), {
            maxItems: 20,
            description:
              "Up to 20 domains/URLs, all allowlist or all '-' prefixed denylist.",
          }),
        ),
        search_recency_filter: enumSchema(
          T,
          ["hour", "day", "week", "month", "year"],
          "Publication recency.",
        ),
        search_after_date_filter: T.Optional(
          T.String({
            pattern: "^\\d{2}/\\d{2}/\\d{4}$",
            description: "Published after MM/DD/YYYY.",
          }),
        ),
        search_before_date_filter: T.Optional(
          T.String({
            pattern: "^\\d{2}/\\d{2}/\\d{4}$",
            description: "Published before MM/DD/YYYY.",
          }),
        ),
        last_updated_after_filter: T.Optional(
          T.String({
            pattern: "^\\d{2}/\\d{2}/\\d{4}$",
            description: "Updated after MM/DD/YYYY.",
          }),
        ),
        last_updated_before_filter: T.Optional(
          T.String({
            pattern: "^\\d{2}/\\d{2}/\\d{4}$",
            description: "Updated before MM/DD/YYYY.",
          }),
        ),
        search_context_size: enumSchema(
          T,
          ["low", "medium", "high"],
          "Named search context budget. Agent preset token budgets take precedence; Search API forbids combining this with explicit budgets.",
        ),
        max_tokens: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 1000000,
            description: "Total search context token budget.",
          }),
        ),
        max_tokens_per_page: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 1000000,
            description: "Search context tokens per page.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    xsearch: T.Object({
      query: T.String({ description: "What to search for on X.com." }),
      passLabel: T.Optional(
        T.String({ description: "Optional lowercase label prefix." }),
      ),
      previousResponseId: T.Optional(
        T.String({ description: "Previous response id for chaining." }),
      ),
      handles: stringArray(T, "Limit to handles, without @."),
      excludeHandles: stringArray(T, "Exclude handles, without @."),
      fromDate: T.Optional(T.String({ description: "Start date YYYY-MM-DD." })),
      toDate: T.Optional(T.String({ description: "End date YYYY-MM-DD." })),
      depth: enumSchema(
        T,
        ["quick", "standard", "max", "ultra"],
        "Research depth. Omit it to use the depth in the user's Dig settings ([x] depth).",
      ),
      enableWebSearch: T.Optional(
        T.Boolean({ description: "Add web search alongside X search for this pass. Omit it to use the user's Dig setting ([x] web_search, off unless they turned it on)." }),
      ),
    }),
    x_post: T.Object(
      {
        posts: T.Array(T.String(), {
          minItems: 1,
          maxItems: 100,
          description:
            "1-100 X posts: x.com or twitter.com status links, or numeric post ids.",
        }),
        thread: T.Optional(
          T.Boolean({
            description:
              "Also read the author's own posts in each post's conversation (default false).",
          }),
        ),
        replies: T.Optional(
          T.Integer({
            minimum: 0,
            maximum: 100,
            description:
              "Replies to read from each post's conversation, newest first (default 0, max 100).",
          }),
        ),
        quotes: T.Optional(
          T.Integer({
            minimum: 0,
            maximum: 100,
            description: "Quote posts of each post to read (default 0, max 100).",
          }),
        ),
        reposters: T.Optional(
          T.Integer({
            minimum: 0,
            maximum: 100,
            description: "Accounts that reposted each post (default 0, max 100).",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    x_search_posts: T.Object(
      {
        query: T.String({
          minLength: 1,
          description:
            "X search query; every X search operator passes through (from:, to:, conversation_id:, is:reply, -is:retweet, has:media, lang:, min_likes: …).",
        }),
        archive: T.Optional(
          T.Boolean({
            description:
              "false (default): the last 7 days. true: the full archive, at one request per second.",
          }),
        ),
        start_time: T.Optional(
          T.String({
            description:
              "Earliest post time, ISO 8601 (e.g. 2026-10-01T00:00:00Z); within the last 7 days unless archive is true.",
          }),
        ),
        end_time: T.Optional(
          T.String({ description: "Latest post time, ISO 8601." }),
        ),
        sort: enumSchema(
          T,
          ["recency", "relevancy"],
          "Order of results (default recency).",
        ),
        limit: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 500,
            description:
              "Posts to return, paged internally (default 25, max 500).",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    x_count_posts: T.Object(
      {
        query: T.String({
          minLength: 1,
          description: "X search query whose matching posts to count.",
        }),
        archive: T.Optional(
          T.Boolean({
            description:
              "false (default): the last 7 days. true: the full archive.",
          }),
        ),
        start_time: T.Optional(
          T.String({ description: "Start of the counted window, ISO 8601." }),
        ),
        end_time: T.Optional(
          T.String({ description: "End of the counted window, ISO 8601." }),
        ),
        granularity: enumSchema(
          T,
          ["minute", "hour", "day"],
          "Bucket size (default day).",
        ),
      },
      { additionalProperties: false },
    ),
    x_users: T.Object(
      {
        handles: T.Optional(
          T.Array(T.String(), {
            minItems: 1,
            maxItems: 100,
            description:
              "1-100 X handles, with or without @. Pass this or query.",
          }),
        ),
        query: T.Optional(
          T.String({
            description:
              "People search (needs X sign-in): letters, digits, underscores, apostrophes and spaces, up to 50 characters. Pass this or handles.",
          }),
        ),
        posts: T.Optional(
          T.Integer({
            minimum: 0,
            maximum: 100,
            description: "Each account's most recent posts (default 0, max 100).",
          }),
        ),
        mentions: T.Optional(
          T.Integer({
            minimum: 0,
            maximum: 100,
            description:
              "Recent posts mentioning each account (default 0, max 100).",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    x_news: T.Object(
      {
        query: T.Optional(
          T.String({
            description: "Search X News stories. Pass this or id.",
          }),
        ),
        id: T.Optional(
          T.String({ description: "One X News story id. Pass this or query." }),
        ),
        max_age_hours: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 720,
            description:
              "With query: only stories updated within this many hours (X's default 168).",
          }),
        ),
        limit: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 100,
            description: "With query: stories to return (X's default 10).",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    x_explore: T.Object(
      {
        kind: requiredEnumSchema(
          T,
          ["trends", "spaces", "communities", "list"],
          "trends (woeid, limit), spaces (query, state, limit), communities (query, limit) or list (list, limit).",
        ),
        woeid: T.Optional(
          T.Integer({
            description:
              "trends: Yahoo! Where On Earth ID of the place (default 1, worldwide).",
          }),
        ),
        query: T.Optional(
          T.String({ description: "spaces or communities: what to search for (communities runs signed in, or through TikHub without sign-in)." }),
        ),
        state: enumSchema(
          T,
          ["live", "scheduled", "all"],
          "spaces: which Spaces (default all).",
        ),
        list: T.Optional(
          T.String({
            description: "list: an X List id or link (https://x.com/i/lists/<id>).",
          }),
        ),
        limit: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 100,
            description:
              "Items to return: trends up to 50 (default 20); spaces, communities and list default 25.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    x_bookmarks: T.Object(
      {
        folder: T.Optional(
          T.String({
            minLength: 1,
            description:
              "One bookmark folder: its name (case-insensitive, exact) or its numeric id. Without it, all bookmarks.",
          }),
        ),
        limit: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 800,
            description: "Posts to read, newest first (default 50, max 800).",
          }),
        ),
        match: T.Optional(
          T.String({
            minLength: 1,
            description:
              "Keep only posts in which every word starts a word (case-insensitive; ai matches AI and #AI, not brainstorm) in their text, author, links or the post they quote or repost.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    x_likes: T.Object(
      {
        limit: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 800,
            description: "Liked posts to read, newest first (default 50, max 800).",
          }),
        ),
        match: T.Optional(
          T.String({
            minLength: 1,
            description:
              "Keep only posts in which every word starts a word (case-insensitive; ai matches AI and #AI, not brainstorm) in their text, author, links or the post they quote or repost.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    x_community: T.Object(
      {
        community: T.String({
          minLength: 1,
          description:
            "An X Community id or link (https://x.com/i/communities/<id>).",
        }),
        posts: T.Optional(
          T.Integer({
            minimum: 0,
            maximum: 500,
            description:
              "The Community's posts to read through TikHub (default 25, max 500; 0 reads details only).",
          }),
        ),
        sort: enumSchema(
          T,
          ["recent", "relevant"],
          "recent (default): TikHub's Recency ranking, shown newest first (not strictly by time across pages); relevant: TikHub's Relevance ranking, in its order.",
        ),
      },
      { additionalProperties: false },
    ),
    scrapecreators_tiktok: T.Object(
      {
        query: T.String({ description: "TikTok search query." }),
        date_posted: enumSchema(
          T,
          [
            "yesterday",
            "this-week",
            "this-month",
            "last-3-months",
            "last-6-months",
            "all-time",
          ],
          "TikTok publish-window filter; omit for TikTok's default.",
        ),
        sort_by: enumSchema(
          T,
          ["relevance", "most-liked", "date-posted"],
          "TikTok sort order (default: relevance).",
        ),
        region: T.Optional(
          T.String({
            description:
              "Two-letter country code that places the proxy (e.g. US). Not a content filter.",
          }),
        ),
        cursor: T.Optional(
          T.Integer({
            minimum: 0,
            description:
              "Numeric cursor from a previous response for the next page.",
          }),
        ),
        limit: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 40,
            description:
              "Max videos to display from the page (default: 20, max: 40).",
          }),
        ),
        transcripts: T.Optional(
          T.Boolean({
            description:
              "Fetch existing captions/subtitles for the first videos (default: true; 1 credit each).",
          }),
        ),
        transcript_limit: T.Optional(
          T.Integer({
            minimum: 0,
            maximum: 10,
            description:
              "How many videos to fetch transcripts for (default: 5, max: 10).",
          }),
        ),
        transcript_language: T.Optional(
          T.String({
            description: "Two-letter transcript language code (e.g. en).",
          }),
        ),
        transcript_ai_fallback: T.Optional(
          T.Boolean({
            description:
              "AI transcription when no caption exists (default: false; videos up to 2 minutes; 10 extra credits per video).",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    scrapecreators_instagram: T.Object(
      {
        query: T.String({
          description:
            "Instagram search query, topic, hashtag, username, or place.",
        }),
        mode: enumSchema(
          T,
          ["reels", "native", "popular"],
          "reels (default): Google-indexed Reels search; native: Instagram's own users/hashtags/places lookup, no posts; popular: Instagram's curated Popular topic page.",
        ),
        date_posted: enumSchema(
          T,
          ["last-week", "last-month", "last-year"],
          "mode='reels' only. Google-indexed date window.",
        ),
        page: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 11,
            description: "mode='reels' only. Page 1-11 (default: 1).",
          }),
        ),
        cursor: T.Optional(
          T.String({
            description:
              "mode='popular' only. Opaque cursor from the previous popular response.",
          }),
        ),
        limit: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 40,
            description:
              "Max items to display (default: 20, max: 40); per list in native mode.",
          }),
        ),
        transcripts: T.Optional(
          T.Boolean({
            description:
              "reels/popular modes. Fetch AI transcripts for the first reels (default: true; 1 credit each, cache hits free).",
          }),
        ),
        transcript_limit: T.Optional(
          T.Integer({
            minimum: 0,
            maximum: 10,
            description:
              "How many reels to fetch transcripts for (default: 5, max: 10).",
          }),
        ),
        enrich_views: T.Optional(
          T.Boolean({
            description:
              "mode='reels' only. Look up current play counts per reel via /v1/instagram/post (default: false; 1 credit each, cache hits free). Search results carry no view counts since 2026-08-19.",
          }),
        ),
        enrich_limit: T.Optional(
          T.Integer({
            minimum: 0,
            maximum: 10,
            description:
              "How many reels to look up when enrich_views=true (default: 5, max: 10).",
          }),
        ),
        cache_max_age: enumSchema(
          T,
          ["1d", "3d", "7d", "14d", "30d"],
          "Accept cached post lookups/transcripts this old or newer (cache hits cost 0 credits). Not applied to search requests.",
        ),
      },
      { additionalProperties: false },
    ),
    scrapecreators_linkedin: T.Object(
      {
        kind: requiredEnumSchema(
          T,
          ["profile", "company", "company_posts", "post", "search"],
          "LinkedIn resource kind; search finds public posts by keyword.",
        ),
        url: T.Optional(
          T.String({
            description:
              "Public LinkedIn URL. Required for every kind except search.",
          }),
        ),
        query: T.Optional(
          T.String({
            description:
              "kind='search' only. Keyword or phrase for Google-indexed public LinkedIn posts.",
          }),
        ),
        page: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 7,
            description:
              "kind='company_posts' only. Company posts page (default: 1, max: 7).",
          }),
        ),
        date_posted: enumSchema(
          T,
          ["last-hour", "last-day", "last-week", "last-month", "last-year"],
          "kind='search' only. Google-indexed date window.",
        ),
        cursor: T.Optional(
          T.String({
            description:
              "kind='search' only. Cursor from the previous search response (pages 1-11).",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    tiktok_ads_search: T.Object({
      keyword: T.Optional(
        T.String({
          description:
            "Search keyword; omit to browse under the other filters.",
        }),
      ),
      industry: T.Optional(
        T.String({
          description:
            "Published industry names or 11-digit ids, comma-separated (e.g. 'Travel', 'Live Events').",
        }),
      ),
      country_code: T.Optional(
        T.String({ description: "Two-letter country code (default: US)." }),
      ),
      period: T.Optional(
        T.Union([T.Literal(7), T.Literal(30), T.Literal(120), T.Literal(180)], {
          description: "Lookback window in days (default: 180).",
        }),
      ),
      objective: enumSchema(
        T,
        [
          "traffic",
          "app_installs",
          "conversion",
          "video_views",
          "reach",
          "lead_generation",
          "product_sales",
        ],
        "Campaign objective.",
      ),
      performance: enumSchema(
        T,
        ["top_20", "top_40", "top_60", "top_80"],
        "Performance band by CTR percentile.",
      ),
      order_by: enumSchema(
        T,
        ["for_you", "likes"],
        "for_you (TikTok's ranking, default) or likes.",
      ),
      ad_format: enumSchema(
        T,
        ["spark", "non_spark"],
        "Spark Ads or non-Spark ads.",
      ),
      ad_language: T.Optional(
        T.String({ description: "Ad language code, e.g. en." }),
      ),
      page: T.Optional(
        T.Number({ minimum: 1, description: "Page number (default: 1)." }),
      ),
      limit: T.Optional(
        T.Number({
          minimum: 1,
          maximum: 50,
          description: "Ads per page (default: 20, max: 50).",
        }),
      ),
    }),
    tiktok_ads_top: T.Object({
      industry: T.Optional(
        T.String({
          description:
            "One published industry name or 11-digit id; omit for the cross-industry list.",
        }),
      ),
      page: T.Optional(
        T.Number({ minimum: 1, description: "Page number (default: 1)." }),
      ),
      limit: T.Optional(
        T.Number({
          minimum: 1,
          maximum: 50,
          description: "Ads per page (default: 20, max: 50).",
        }),
      ),
    }),
    tiktok_ads_detail: T.Object({
      ad_id: T.String({
        description:
          "Creative Center ad id from tiktok_ads_search or tiktok_ads_top.",
      }),
      analytics: T.Optional(
        T.Boolean({
          description:
            "Also fetch CTR percentile and retention curve (default: true; two extra requests).",
        }),
      ),
      similar: T.Optional(
        T.Boolean({
          description:
            "Also fetch TikTok's recommended similar ads (default: false; one extra request).",
        }),
      ),
    }),
    tiktok_ad_library: T.Object(
      {
        advertiser_name: T.Optional(
          T.String({
            description:
              "Advertiser to look up in TikTok's public Ad Library. Use either this or query.",
          }),
        ),
        adv_biz_ids: T.Optional(
          T.String({
            minLength: 1,
            description:
              "Exact TikTok advertiser business ID from returned ads or See all ads link. Requires advertiser_name; ID-only searches are unsupported.",
          }),
        ),
        query: T.Optional(
          T.String({
            description:
              "Free-text library search. Use either this or advertiser_name.",
          }),
        ),
        cursor: T.Optional(
          T.String({ description: "Opaque cursor from a previous call." }),
        ),
        limit: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 50,
            description:
              "Max ads to display from the page (default: 20, max: 50).",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    deepwiki_read_wiki_structure: T.Object({
      repoName: T.String({
        description: "GitHub repository in owner/repo format.",
      }),
    }),
    deepwiki_read_wiki_contents: T.Object({
      repoName: T.String({
        description: "GitHub repository in owner/repo format.",
      }),
    }),
    deepwiki_ask_question: T.Object({
      repoName: T.String({
        description: "GitHub repository in owner/repo format.",
      }),
      question: T.String({
        description: "Focused structural question about the repository.",
      }),
    }),
    dataforseo_docs_sections: T.Object({}),
    dataforseo_docs_index: T.Object({
      section: T.Optional(
        T.String({
          description:
            'Top-level documentation section, e.g. "SERP API" or "DataForSEO Labs API" (case-insensitive part of the name).',
        }),
      ),
      query: T.Optional(
        T.String({
          description:
            "Words that must all appear in a page's title, path, heading trail or summary.",
        }),
      ),
      offset: T.Optional(
        T.Integer({ minimum: 0, description: "Matches to skip (default: 0)." }),
      ),
      limit: T.Optional(
        T.Integer({
          minimum: 1,
          maximum: 200,
          description: "Matches to return (default: 50, max: 200).",
        }),
      ),
    }),
    dataforseo_docs_read: T.Object({
      path: T.String({
        description:
          "Documentation path such as serp/google/organic/live/advanced, or its full docs.dataforseo.com URL.",
      }),
      offset: T.Optional(
        T.Integer({
          minimum: 0,
          description: "Character offset to continue from (default: 0).",
        }),
      ),
      limit: T.Optional(
        T.Integer({
          minimum: 1,
          maximum: 100000,
          description: "Characters to return (default: 40000, max: 100000).",
        }),
      ),
    }),
    dataforseo_request: T.Object({
      path: T.String({
        description:
          "Endpoint path after /v3/, exactly as documented, e.g. serp/google/organic/live/advanced or serp/google/locations/us. Full responses only: no .ai suffix.",
      }),
      method: enumSchema(
        T,
        ["GET", "POST"],
        "HTTP method from the endpoint's documentation. Default: POST when tasks are given, otherwise GET.",
      ),
      tasks: T.Optional(
        T.Array(T.Object({}, { additionalProperties: true }), {
          minItems: 1,
          maxItems: 100,
          description:
            "POST body: the documented array of task objects (a Live endpoint takes one task).",
        }),
      ),
      sandbox: T.Optional(
        T.Boolean({
          description:
            "Use DataForSEO's free sandbox, which returns dummy data in the real response shape. For checking a request, never as evidence.",
        }),
      ),
    }),
    commerce_reviews: T.Object(
      {
        asin: T.String({ description: "Amazon ASIN whose reviews to fetch." }),
        amazon_domain: enumSchema(
          T,
          [
            "amazon.com",
            "amazon.ca",
            "amazon.co.uk",
            "amazon.in",
            "amazon.de",
            "amazon.fr",
            "amazon.it",
            "amazon.es",
            "amazon.co.jp",
            "amazon.com.au",
            "amazon.com.br",
            "amazon.nl",
            "amazon.se",
            "amazon.com.mx",
            "amazon.ae",
          ],
          "Amazon marketplace (15 Nexscope review markets). Default: amazon.com.",
        ),
        stars: T.Optional(
          T.Array(T.Integer({ minimum: 1, maximum: 5 }), {
            description:
              "Star ratings to fetch (1-5). Default: all five; unselected ratings are requested with a count of 0.",
          }),
        ),
        per_star_limit: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 100,
            description:
              "Reviews requested per selected star rating (default: 10, max: 100).",
          }),
        ),
        keyword: T.Optional(
          T.String({
            description:
              "Provider-side keyword filter on review text (max 1000 characters).",
          }),
        ),
        sort: enumSchema(
          T,
          ["recent", "helpful"],
          "Review order. Default: recent.",
        ),
        verified_only: T.Optional(
          T.Boolean({
            description: "Only verified-purchase reviews. Default: false.",
          }),
        ),
        media_only: T.Optional(
          T.Boolean({
            description:
              "Only reviews carrying images or video. Default: false.",
          }),
        ),
        current_format_only: T.Optional(
          T.Boolean({
            description:
              "Only reviews for the current format/variation. Default: false.",
          }),
        ),
        provider: enumSchema(T, ["auto", "nexscope"], "Provider choice."),
      },
      { additionalProperties: false },
    ),
    commerce_discover: T.Object(
      {
        kind: requiredEnumSchema(
          T,
          ["deals", "bestsellers", "new_releases", "seller"],
          "What to discover: deals, bestsellers, new_releases, or seller.",
        ),
        amazon_domain: enumSchema(
          T,
          [
            "amazon.com",
            "amazon.ca",
            "amazon.co.uk",
            "amazon.de",
            "amazon.fr",
            "amazon.it",
            "amazon.es",
            "amazon.co.jp",
            "amazon.in",
            "amazon.ie",
            "amazon.co.za",
            "amazon.com.mx",
            "amazon.com.br",
            "amazon.com.au",
            "amazon.com.tr",
            "amazon.nl",
            "amazon.com.be",
            "amazon.pl",
            "amazon.se",
            "amazon.ae",
            "amazon.sa",
            "amazon.sg",
            "amazon.eg",
          ],
          "Amazon marketplace (23 Scrape.do marketplaces; deals are documented for amazon.com only). Default: amazon.com.",
        ),
        category: T.Optional(
          T.String({
            description:
              "Required for bestsellers/new_releases: marketplace-specific category slug from the chart URL (for example electronics on amazon.com, ce-de on amazon.de).",
          }),
        ),
        node: T.Optional(
          T.String({
            description:
              "Category node id: scopes deals to a category or narrows a chart to a sub-category.",
          }),
        ),
        seller: T.Optional(
          T.String({
            description:
              "Required for seller: Amazon seller id (for example A2L77EE7U53NWQ).",
          }),
        ),
        low_price: T.Optional(
          T.Number({
            minimum: 0,
            description:
              "Deals only: lower price bound (at most two decimals).",
          }),
        ),
        high_price: T.Optional(
          T.Number({
            minimum: 0,
            description:
              "Deals only: upper price bound (at most two decimals).",
          }),
        ),
        refinement: T.Optional(
          T.String({
            description:
              "Deals only: additional Amazon refinement string (rh).",
          }),
        ),
        sort_by: enumSchema(
          T,
          [
            "relevance",
            "featured",
            "price_low_to_high",
            "price_high_to_low",
            "average_review",
            "most_recent",
            "newest_arrivals",
            "bestsellers",
            "bestseller_rankings",
          ],
          "Deals only: sort order. Default: Amazon's own order.",
        ),
        page: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 20,
            description:
              "Page: deals 1-20; bestsellers/new_releases 1 (positions 1-50) or 2 (positions 51-100). Default: 1.",
          }),
        ),
        limit: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 50,
            description:
              "Max product cards to print for deals and charts (default: 20, max: 50).",
          }),
        ),
        language: T.Optional(
          T.String({
            description:
              "Uppercase ISO 639-1 page language supported by the marketplace (for example EN, DE).",
          }),
        ),
        provider: enumSchema(T, ["auto", "scrape-do"], "Provider choice."),
      },
      { additionalProperties: false },
    ),
    scrapecreators_telegram: T.Object(
      {
        kind: requiredEnumSchema(
          T,
          ["channel", "posts", "post"],
          "channel details, one page of channel posts, or one public post.",
        ),
        handle: T.Optional(
          T.String({
            description:
              "kind='channel' or 'posts'. Public handle, @handle, or t.me channel URL. Private/invite-only channels are unsupported.",
          }),
        ),
        url: T.Optional(
          T.String({
            description:
              "kind='post'. Public post URL such as https://t.me/durov/543.",
          }),
        ),
        cursor: T.Optional(
          T.String({
            description:
              "kind='posts'. Numeric cursor from the previous page; omit for the latest posts.",
          }),
        ),
        limit: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 40,
            description:
              "kind='posts'. Max posts to display from the page (default: 20, max: 40).",
          }),
        ),
        cache_max_age: enumSchema(
          T,
          ["1d", "3d", "7d", "14d", "30d"],
          "Accept a cached response this old or newer; cache hits cost 0 credits.",
        ),
      },
      { additionalProperties: false },
    ),
    github_search: T.Object(
      {
        query: T.String({
          description:
            "Repository search query with optional GitHub qualifiers (in:name,description,readme, topic:, language:, created:, pushed:, stars:, archived:false, fork:). is:public is always appended; is:private, is:internal, visibility:, and negated is:public are rejected.",
        }),
        sort: enumSchema(
          T,
          ["best-match", "stars", "forks", "help-wanted-issues", "updated"],
          "Sort order (default: best-match).",
        ),
        order: enumSchema(
          T,
          ["desc", "asc"],
          "Sort direction (default: desc); ignored for best-match.",
        ),
        page: T.Optional(
          T.Integer({
            minimum: 1,
            description:
              "Result page (default: 1). page * perPage may not exceed GitHub's 1,000-result cap.",
          }),
        ),
        perPage: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 100,
            description: "Results per page (default: 20, max: 100).",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    github_inspect: T.Object(
      {
        repo: T.String({
          description: "Public repository as owner/repo or a github.com URL.",
        }),
        days: T.Optional(
          T.Integer({
            minimum: 7,
            maximum: 365,
            description:
              "Evidence window in days (default: 90). Use the same value across candidates being compared.",
          }),
        ),
        samples: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 20,
            description:
              "Merged-PR and issue sample size for the GraphQL section (default: 5).",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    github_read: T.Object(
      {
        repo: T.String({
          description: "Public repository as owner/repo or a github.com URL.",
        }),
        path: T.Optional(
          T.String({
            description:
              "Repository-relative file or directory path; omit for the root directory.",
          }),
        ),
        ref: T.Optional(
          T.String({
            description:
              "Branch, tag, or commit SHA (default: the repository's default branch).",
          }),
        ),
        startLine: T.Optional(
          T.Integer({
            minimum: 1,
            description: "First line to return for files (default: 1).",
          }),
        ),
        maxLines: T.Optional(
          T.Integer({
            minimum: 1,
            maximum: 2000,
            description: "Maximum lines to return (default: 400).",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    research_save: T.Object({
      source: requiredEnumSchema(
        T,
        sources,
        "Dig source (catalog id) the report came from; the front-matter `source`.",
      ),
      content: T.String({
        description:
          "Full Markdown report as the source skill specifies, without YAML front matter.",
      }),
      topic: T.Optional(
        T.String({
          description: "Short lowercase hyphenated topic, at most 50 characters.",
        }),
      ),
      topic_volatility: enumSchema(
        T,
        TOPIC_VOLATILITIES,
        "How fast the topic changes, when known.",
      ),
      dig: T.Optional(
        T.String({
          description:
            "Dig id from dig_start or your assignment. Omit to save a single-source dig.",
        }),
      ),
      question: T.Optional(
        T.String({
          description:
            "The research question as asked. Pass it when you omit `dig`: it names the new single-source dig.",
        }),
      ),
      agent: T.Optional(
        T.String({
          description:
            "Agent (method) that produced the report, e.g. x-judge; the file is <agent>.md. Defaults to source.",
        }),
      ),
      supersedes: T.Optional(
        T.String({
          description:
            "Report file in the same dig that this report corrects, e.g. x-judge.md.",
        }),
      ),
    }),
    dig_start: T.Object({
      question: T.String({
        minLength: 1,
        description: "The question this dig researches, in the user's terms.",
      }),
      planned: stringArray(
        T,
        "Source agents you plan to run, e.g. [x-judge, x-breadth].",
      ),
      refreshes: T.Optional(
        T.String({
          description:
            "Id of an earlier dig in this project that this one re-researches.",
        }),
      ),
    }),
    dig_finish: T.Object({
      dig: T.String({ description: "Dig id from dig_start." }),
      answer: T.String({
        minLength: 1,
        description: "Your final answer in Markdown, with citations.",
      }),
      status: requiredEnumSchema(
        T,
        REPORT_STATUSES,
        "complete, partial, or failed.",
      ),
      reports: stringArray(
        T,
        "Report files the answer relied on, e.g. [x-judge.md, x-breadth.md].",
      ),
    }),
  };

  // Host builders may be opaque (callable schema values, not TypeBox objects).
  // Only tighten plain JSON-Schema objects (the TypeBox host).
  for (const schema of Object.values(schemas))
    if (typeof schema === "object") schema.additionalProperties ??= false;
  return schemas;
}
