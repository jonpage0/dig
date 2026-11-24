/**
 * Commerce source plugin (Effect 4.1.5):
 * - commerce_search: Scrape.do Amazon search (`PaidHttp`, `scrapeDoBilling` from `scrape.do-request-cost` header)
 * - commerce_product: Scrape.do PDP + sequential offer-listing (`PaidHttp`, `scrapeDoBilling`)
 * - commerce_history: Nexscope retrospective price/BSR/seller/rating series (`PaidHttp`, unknown cost)
 * - commerce_reviews: Nexscope per-star sampled Amazon reviews (`PaidHttp`, unknown cost)
 * - commerce_discover: Scrape.do deals, bestsellers, new_releases, seller profiles (`PaidHttp`, `scrapeDoBilling`)
 */
import { Effect, Schema } from "effect";
import type { KeepRaw, PaidHttp } from "../../core/http.ts";
import {
  defineAction,
  defineSource,
  failed,
  outcome,
  type ActionOutcome,
  type SourcePlugin,
} from "../../core/plugin.ts";
import {
  AMAZON_DOMAIN_VALUES,
  BESTSELLERS_PAGE_SIZE,
  COMMERCE_HISTORY_SERIES_VALUES,
  COMMERCE_PROVIDER_VALUES,
  DEALS_SORT_VALUES,
  DEFAULT_AMAZON_DOMAIN,
  DEFAULT_DISCOVER_LIMIT,
  DEFAULT_HISTORY_DAYS,
  DEFAULT_HISTORY_MAX_POINTS,
  DEFAULT_HISTORY_SERIES,
  DEFAULT_REVIEWS_PER_STAR,
  DISCOVER_COMMON_ARGS,
  DISCOVER_KIND_ARGS,
  DISCOVER_KIND_VALUES,
  HISTORY_DOMAIN_VALUES,
  HISTORY_PROVIDER_VALUES,
  MAX_BESTSELLERS_PAGE,
  MAX_DEALS_PAGE,
  MAX_DISCOVER_LIMIT,
  MAX_HISTORY_DAYS,
  MAX_HISTORY_MAX_POINTS,
  MAX_REVIEW_KEYWORD_LENGTH,
  MAX_REVIEWS_PER_STAR,
  MAX_SEARCH_LIMIT,
  NEXSCOPE_PRICE_SERIES_ENDPOINT,
  NEXSCOPE_REVIEWS_ENDPOINT,
  REVIEW_DOMAIN_VALUES,
  REVIEW_SORT_VALUES,
  REVIEW_STAR_VALUES,
  boolLabel,
  checkPriceOrder,
  collectHistorySeries,
  extractAsinFromAmazonUrl,
  firstNumber,
  firstString,
  formatCount,
  formatMoney,
  formatPercent,
  formatShipping,
  historyValueLabel,
  inferAmazonDomainFromUrl,
  locationNote,
  nexscopeHistoryBody,
  nexscopeRequest,
  nexscopeReviewProductSummary,
  nexscopeReviewsBody,
  normalizeLanguage,
  normalizeNexscopeReviews,
  normalizePriceBound,
  normalizeScrapeDoCategories,
  normalizeScrapeDoChart,
  normalizeScrapeDoFilterGroups,
  normalizeScrapeDoOffer,
  normalizeScrapeDoProduct,
  normalizeScrapeDoSearchItems,
  normalizeScrapeDoSeller,
  normalizeRelatedSearches,
  normalizeWhitespace,
  optionalInteger,
  providerLabel,
  pushFilterLines,
  pushPaginationLine,
  pushSearchItemLines,
  requireArray,
  requireAsin,
  requireInteger,
  requireMarketplace,
  safeJsonSnippet,
  sampleHistoryPoints,
  scopeNote,
  scrapeDoBilling,
  scrapeDoRequest,
  summarizeHistoryPoints,
  type AmazonDomain,
  type CommerceHistorySeries,
  type DealsSort,
  type DiscoverKind,
  type HistoryPoint,
  type ProviderCallResult,
  type ReviewSort,
  type ScrapeDoOffer,
} from "./helpers.ts";

function searchProducts(args: {
  readonly query?: string;
  readonly amazonDomain: AmazonDomain;
  readonly page?: number;
  readonly seller?: string;
  readonly sort?: string;
  readonly refinement?: string;
  readonly node?: string;
  readonly lowPrice?: number;
  readonly highPrice?: number;
  readonly language?: string;
  readonly signal: AbortSignal;
  readonly keep: KeepRaw;
}): Effect.Effect<ProviderCallResult, never, PaidHttp> {
  return Effect.gen(function* () {
    const orderErr = checkPriceOrder(args.lowPrice, args.highPrice);
    if (orderErr) return { ok: false as const, cancelled: false, error: orderErr };
    const low = normalizePriceBound(args.lowPrice, "low_price");
    if (!low.ok) return { ok: false as const, cancelled: false, error: low.error };
    const high = normalizePriceBound(args.highPrice, "high_price");
    if (!high.ok) return { ok: false as const, cancelled: false, error: high.error };
    const lang = normalizeLanguage(args.language);
    if (!lang.ok) return { ok: false as const, cancelled: false, error: lang.error };

    return yield* scrapeDoRequest({
      endpoint: "search",
      amazonDomain: args.amazonDomain,
      params: {
        keyword: args.query,
        page: args.page ?? 1,
        seller: args.seller,
        s: args.sort,
        rh: args.refinement,
        node: args.node,
        low_price: low.value,
        high_price: high.value,
        language: lang.value,
      },
      signal: args.signal,
      keep: args.keep,
    });
  });
}

// ---------------------------------------------------------------------------
// Action 1: commerce_search
// ---------------------------------------------------------------------------

const CommerceSearchSchema = Schema.Struct({
  query: Schema.optionalKey(
    Schema.String.annotate({
      description: "Amazon product query, keyword, brand, or category. Optional only when seller is supplied.",
    }),
  ),
  amazon_domain: Schema.optionalKey(
    Schema.Literals(AMAZON_DOMAIN_VALUES).annotate({
      description: "Amazon marketplace (23 Scrape.do marketplaces). Default: amazon.com.",
    }),
  ),
  page: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Search results page. Default: 1." }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SEARCH_LIMIT })).annotate({
      description:
        "Max normalized results to show (default: every result on the page, max: 10); the next page starts after the whole page either way.",
    }),
  ),
  seller: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Amazon seller id (for example A2L77EE7U53NWQ). Restricts results to that seller's catalog; usable without query.",
    }),
  ),
  sort: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Raw Amazon sort key passed through as s (for example price-asc-rank, price-desc-rank, review-rank, date-desc-rank).",
    }),
  ),
  refinement: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Amazon refinement string passed through as rh (for example n:172282,p_72:1248915011); take values from a previous result's filter options.",
    }),
  ),
  node: Schema.optionalKey(
    Schema.String.annotate({ description: "Amazon category node id to scope the search." }),
  ),
  low_price: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Lower price bound in marketplace currency (at most two decimals).",
    }),
  ),
  high_price: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Upper price bound in marketplace currency (at most two decimals).",
    }),
  ),
  language: Schema.optionalKey(
    Schema.String.annotate({
      description: "Uppercase ISO 639-1 page language supported by the marketplace (for example EN, DE).",
    }),
  ),
  provider: Schema.optionalKey(
    Schema.Literals(COMMERCE_PROVIDER_VALUES).annotate({ description: "Provider choice." }),
  ),
});

export const commerceSearchAction = defineAction({
  name: "commerce_search",
  description:
    "Search Amazon products through the unified commerce surface. " +
    "Scrape.do performs current-state keyword, category-node, refinement, price-bounded, and seller-catalog searches with normalized result signals. " +
    "Use this to identify promising ASINs before deeper product inspection.",
  schema: CommerceSearchSchema,
  billing: scrapeDoBilling,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const provider = args.provider ?? "auto";
      const query = normalizeWhitespace(args.query);
      const seller = normalizeWhitespace(args.seller);
      const sort = normalizeWhitespace(args.sort) ?? undefined;
      const refinement = normalizeWhitespace(args.refinement) ?? undefined;
      const node = normalizeWhitespace(args.node) ?? undefined;

      const market = requireMarketplace(args.amazon_domain ?? DEFAULT_AMAZON_DOMAIN, AMAZON_DOMAIN_VALUES, "Scrape.do");
      if (!market.ok) return failed(`Commerce search failed: ${market.error}`);
      const amazonDomain = market.value;

      const limitRes = optionalInteger(args.limit, "limit", 1, MAX_SEARCH_LIMIT, Number.POSITIVE_INFINITY);
      if (!limitRes.ok) return failed(`Commerce search failed: ${limitRes.error}`);
      const pageRes = optionalInteger(args.page, "page", 1, Number.POSITIVE_INFINITY, 1);
      if (!pageRes.ok) return failed(`Commerce search failed: ${pageRes.error}`);
      if (!query && !seller) return failed("Commerce search failed: Provide a query, a seller id, or both");

      const langRes = normalizeLanguage(args.language);
      if (!langRes.ok) return failed(`Commerce search failed: ${langRes.error}`);

      const res = yield* searchProducts({
        query: query ?? undefined,
        amazonDomain,
        page: pageRes.value,
        seller: seller ?? undefined,
        sort,
        refinement,
        node,
        lowPrice: args.low_price,
        highPrice: args.high_price,
        language: langRes.value,
        signal: ctx.signal,
        keep: ctx.keep,
      });
      if (!res.ok) {
        return res.cancelled
          ? outcome("cancelled", "Research call cancelled")
          : failed(`Commerce search failed: ${res.error}`);
      }

      const payload = res.payload;
      const rawProducts = requireArray(payload, "products", "Scrape.do search");
      if (!rawProducts.ok) return failed(`Commerce search failed: ${rawProducts.error}`);
      const allResults = normalizeScrapeDoSearchItems(rawProducts.items);
      const results = allResults.slice(0, limitRes.value);
      const filterGroups = normalizeScrapeDoFilterGroups(payload.filters);
      const categories = normalizeScrapeDoCategories(payload.categories);
      const relatedSearches = normalizeRelatedSearches(payload.related_searches);
      const totalResultsText = firstString(payload.totalResults);
      const totalResultsExtracted = firstNumber(payload.total_results_extracted);

      const lines: string[] = ["# Commerce Search", ""];
      if (query) lines.push(`Query: ${query}`);
      if (seller) lines.push(`Seller catalog: ${seller}`);
      lines.push(`Amazon domain: ${amazonDomain}`);
      lines.push(`Provider: ${providerLabel(provider === "auto" ? "scrape-do" : provider)}`);
      lines.push(`Page: ${pageRes.value}`);
      const applied = [
        sort ? `sort=${sort}` : null,
        refinement ? `rh=${refinement}` : null,
        node ? `node=${node}` : null,
        args.low_price !== undefined ? `low_price=${args.low_price}` : null,
        args.high_price !== undefined ? `high_price=${args.high_price}` : null,
        langRes.value ? `language=${langRes.value}` : null,
      ].filter((entry): entry is string => entry !== null);
      if (applied.length > 0) lines.push(`Requested filters: ${applied.join(", ")}`);
      if (totalResultsText) lines.push(`Amazon result count text: ${totalResultsText}`);
      if (totalResultsExtracted !== null) {
        lines.push(`Largest integer parsed from that text by the provider: ${formatCount(totalResultsExtracted)}`);
      }
      lines.push(
        `Normalized results: ${results.length}${allResults.length > results.length ? ` shown of ${allResults.length} returned; page ${pageRes.value + 1} continues after all ${allResults.length}, including the ${allResults.length - results.length} not shown` : ""}`,
      );
      lines.push(locationNote(amazonDomain), "", scopeNote(), "");

      if (results.length === 0) {
        lines.push("No normalized Amazon search results were extracted for this query.");
        const excerpt = safeJsonSnippet(payload);
        if (excerpt) lines.push("", "## Raw Response Excerpt", "```json", excerpt, "```");
        return outcome("empty", lines.join("\n"));
      }

      lines.push("## Results");
      for (const result of results) pushSearchItemLines(lines, result, { showRank: false });
      pushFilterLines(lines, filterGroups);

      if (categories.length > 0) {
        lines.push("", "## Department Picker (pass `node` back to scope a search)");
        for (const category of categories.slice(0, 10)) {
          lines.push(`- ${category.name}${category.node ? ` (node=${category.node})` : ""}`);
        }
        if (categories.length > 10) lines.push(`- ${categories.length - 10} more departments omitted`);
      }

      if (relatedSearches.length > 0) {
        lines.push("", "## Related Searches", relatedSearches.slice(0, 10).join(" | "));
      }

      return outcome("success", lines.join("\n"));
    }),
});

// ---------------------------------------------------------------------------
// Action 2: commerce_product
// ---------------------------------------------------------------------------

const CommerceProductSchema = Schema.Struct({
  asin: Schema.optionalKey(Schema.String.annotate({ description: "Amazon ASIN to inspect." })),
  gtin: Schema.optionalKey(
    Schema.String.annotate({ description: "GTIN / UPC / EAN / ISBN to resolve and inspect." }),
  ),
  url: Schema.optionalKey(Schema.String.annotate({ description: "Amazon product URL to inspect." })),
  amazon_domain: Schema.optionalKey(
    Schema.Literals(AMAZON_DOMAIN_VALUES).annotate({
      description: "Amazon marketplace (23 Scrape.do marketplaces). Default: amazon.com or inferred from url.",
    }),
  ),
  language: Schema.optionalKey(
    Schema.String.annotate({
      description: "Uppercase ISO 639-1 page language supported by the marketplace (for example EN, DE).",
    }),
  ),
  provider: Schema.optionalKey(
    Schema.Literals(COMMERCE_PROVIDER_VALUES).annotate({ description: "Provider choice." }),
  ),
});

function resolveProductTarget(args: {
  readonly asin?: string;
  readonly gtin?: string;
  readonly url?: string;
  readonly amazonDomain?: unknown;
  readonly signal: AbortSignal;
  readonly keep: KeepRaw;
}): Effect.Effect<
  | { readonly ok: true; readonly asin: string; readonly amazonDomain: AmazonDomain; readonly resolutionNotes: string[] }
  | { readonly ok: false; readonly cancelled: boolean; readonly error: string },
  never,
  PaidHttp
> {
  return Effect.gen(function* () {
    const resolutionNotes: string[] = [];
    if (args.url && args.amazonDomain == null && !inferAmazonDomainFromUrl(args.url)) {
      let host = args.url;
      try {
        host = new URL(args.url).hostname;
      } catch {
        // leave raw string
      }
      return {
        ok: false as const,
        cancelled: false,
        error: `url host ${host} is not a listed Amazon marketplace; pass amazon_domain to choose one (${AMAZON_DOMAIN_VALUES.join(", ")})`,
      };
    }
    const market = requireMarketplace(
      args.amazonDomain ?? (args.url ? inferAmazonDomainFromUrl(args.url) : null) ?? DEFAULT_AMAZON_DOMAIN,
      AMAZON_DOMAIN_VALUES,
      "Scrape.do",
    );
    if (!market.ok) return { ok: false as const, cancelled: false, error: market.error };
    const amazonDomain = market.value;

    if (args.asin) {
      const checked = requireAsin(args.asin);
      if (!checked.ok) return { ok: false as const, cancelled: false, error: checked.error };
      return { ok: true as const, asin: checked.asin, amazonDomain, resolutionNotes };
    }
    if (args.url) {
      const asin = extractAsinFromAmazonUrl(args.url);
      if (!asin) {
        return {
          ok: false as const,
          cancelled: false,
          error: "Could not extract a valid ASIN from the supplied Amazon URL",
        };
      }
      resolutionNotes.push(`Resolved ASIN ${asin} from the supplied Amazon URL.`);
      return { ok: true as const, asin, amazonDomain, resolutionNotes };
    }
    if (!args.gtin) {
      return { ok: false as const, cancelled: false, error: "Provide at least one of: asin, gtin, or url" };
    }

    const searchRes = yield* searchProducts({
      query: args.gtin,
      amazonDomain,
      page: 1,
      signal: args.signal,
      keep: args.keep,
    });
    if (!searchRes.ok) return searchRes;

    const rawProducts = requireArray(searchRes.payload, "products", "Scrape.do search");
    if (!rawProducts.ok) return { ok: false as const, cancelled: false, error: rawProducts.error };
    const candidates = normalizeScrapeDoSearchItems(rawProducts.items).filter((item) => item.asin);
    const match = candidates.find((item) => item.sponsored !== true) ?? candidates[0];
    if (!match?.asin) {
      return {
        ok: false as const,
        cancelled: false,
        error: `Could not resolve GTIN ${args.gtin} to an Amazon ASIN with the current Scrape.do slice`,
      };
    }
    resolutionNotes.push(
      `Resolved GTIN ${args.gtin} to ASIN ${match.asin} using Amazon search results. Verify the match if the product family has close duplicates.`,
    );
    if (match.sponsored === true) {
      resolutionNotes.push(
        "The search returned only sponsored results, so the first sponsored result was used; verify that it is the product the GTIN names.",
      );
    }
    return { ok: true as const, asin: match.asin, amazonDomain, resolutionNotes };
  });
}

export const commerceProductAction = defineAction({
  name: "commerce_product",
  description:
    "Inspect a specific Amazon product through the unified commerce surface. " +
    "Scrape.do PDP and offer-listing endpoints supply current-state product, stock, badge, seller, and Buy Box context. " +
    "Use this once you know an ASIN, GTIN, or Amazon product URL.",
  schema: CommerceProductSchema,
  billing: scrapeDoBilling,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const provider = args.provider ?? "auto";
      const target = yield* resolveProductTarget({
        asin: args.asin,
        gtin: args.gtin,
        url: args.url,
        amazonDomain: args.amazon_domain,
        signal: ctx.signal,
        keep: ctx.keep,
      });
      if (!target.ok) {
        return target.cancelled
          ? outcome("cancelled", "Research call cancelled")
          : failed(`Commerce product lookup failed: ${target.error}`);
      }
      const langRes = normalizeLanguage(args.language);
      if (!langRes.ok) return failed(`Commerce product lookup failed: ${langRes.error}`);

      // Keep PDP and offer-listing sequential to respect Scrape.do concurrency limits.
      const pdpRes = yield* scrapeDoRequest({
        endpoint: "pdp",
        amazonDomain: target.amazonDomain,
        params: { asin: target.asin, language: langRes.value },
        signal: ctx.signal,
        keep: ctx.keep,
      });
      if (!pdpRes.ok) {
        return pdpRes.cancelled
          ? outcome("cancelled", "Research call cancelled")
          : failed(`Commerce product lookup failed: ${pdpRes.error}`);
      }
      const productPayload = pdpRes.payload;
      if (!firstString(productPayload.asin, productPayload.name, productPayload.title)) {
        return failed(
          "Commerce product lookup failed: Scrape.do returned a PDP response without the documented `asin`/`name` fields",
        );
      }

      let offers: ScrapeDoOffer[] = [];
      let offersError: string | null = null;
      const offersRes = yield* scrapeDoRequest({
        endpoint: "offer-listing",
        amazonDomain: target.amazonDomain,
        params: { asin: target.asin },
        signal: ctx.signal,
        keep: ctx.keep,
      });
      if (!offersRes.ok) {
        if (offersRes.cancelled || ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
        offersError = offersRes.error;
      } else {
        const rawOffers = requireArray(offersRes.payload, "offers", "Scrape.do offer-listing");
        if (!rawOffers.ok) offersError = rawOffers.error;
        else {
          offers = rawOffers.items
            .map(normalizeScrapeDoOffer)
            .filter((item): item is ScrapeDoOffer => item !== null);
        }
      }

      const product = normalizeScrapeDoProduct(productPayload);
      const buyBoxOffer = offers.find((offer) => offer.isBuyBoxWinner === true) ?? null;

      const lines: string[] = [
        "# Commerce Product",
        "",
        `Provider: ${providerLabel(provider === "auto" ? "scrape-do" : provider)}`,
        `Amazon domain: ${target.amazonDomain}`,
        `ASIN: ${target.asin}`,
        locationNote(target.amazonDomain),
        "",
        scopeNote(),
        "",
      ];

      if (offersError) {
        lines.push(`Offers: the offer-listing request failed (${offersError}), so no Buy Box or seller offers are shown.`, "");
      }
      if (target.resolutionNotes.length > 0) {
        lines.push("## Resolution Notes");
        for (const note of target.resolutionNotes) lines.push(`- ${note}`);
        lines.push("");
      }

      lines.push("## Summary");
      lines.push(`- Title: ${product.title}`);
      if (product.brand) lines.push(`- Brand: ${product.brand}`);
      if (product.asin) lines.push(`- ASIN: ${product.asin}`);
      if (product.parentAsin) {
        lines.push(
          `- Parent ASIN: ${product.parentAsin}${product.asin && product.parentAsin === product.asin ? " (no variation family)" : " (variation family; siblings share it)"}`,
        );
      }
      if (product.link) lines.push(`- URL: ${product.link}`);
      if (product.thumbnail) lines.push(`- Thumbnail: ${product.thumbnail}`);
      lines.push(`- Current price: ${formatMoney(product.price)}`);
      if (product.listPrice) lines.push(`- List price: ${formatMoney(product.listPrice)}`);
      lines.push(`- Rating: ${product.rating ?? "Unavailable"} | Ratings: ${formatCount(product.ratingsTotal)}`);
      lines.push(`- Prime: ${boolLabel(product.isPrime)} | Sponsored listing: ${boolLabel(product.isSponsored)}`);
      lines.push(
        `- In stock: ${product.inStock === null ? "Unknown (page shows no stock signal)" : boolLabel(product.inStock)}${product.availabilityText ? ` | Availability text: ${product.availabilityText}` : ""}`,
      );
      lines.push(
        `- Amazon's Choice: ${boolLabel(product.amazonChoice)} | #1 Best Seller badge: ${boolLabel(product.bestSeller)}`,
      );
      if (product.badges.length > 0) lines.push(`- Badges shown: ${product.badges.join(" | ")}`);

      if (product.description) {
        lines.push("", "## Description (provider-parsed, truncated)", product.description);
      }

      if (buyBoxOffer) {
        lines.push("", "## Buy Box / Seller Context");
        lines.push(`- Seller: ${buyBoxOffer.merchantName || "Unavailable"}`);
        if (buyBoxOffer.sellerId) {
          lines.push(`- Seller ID: ${buyBoxOffer.sellerId} (inspect with \`commerce_discover\` kind=seller)`);
        }
        if (buyBoxOffer.offerHeader) lines.push(`- Offer header: ${buyBoxOffer.offerHeader}`);
        if (buyBoxOffer.condition) lines.push(`- Condition: ${buyBoxOffer.condition}`);
        lines.push(`- Buy Box price: ${formatMoney(buyBoxOffer.listingPrice)}`);
        if (buyBoxOffer.listPrice) lines.push(`- Seller list price: ${formatMoney(buyBoxOffer.listPrice)}`);
        if (buyBoxOffer.discountPercent !== null) {
          lines.push(`- Provider-reported discount: ${formatPercent(buyBoxOffer.discountPercent)}`);
        }
        const shipping = formatShipping(buyBoxOffer);
        if (shipping) lines.push(`- ${shipping}`);
        if (buyBoxOffer.shipsFrom) lines.push(`- Ships from: ${buyBoxOffer.shipsFrom}`);
        lines.push(`- Fulfilled by Amazon: ${boolLabel(buyBoxOffer.isFulfilledByAmazon)}`);
        lines.push(`- Prime: ${boolLabel(buyBoxOffer.isPrime)}`);
        if (buyBoxOffer.quantity !== null) lines.push(`- Quantity shown: ${formatCount(buyBoxOffer.quantity)}`);
      } else if (offers.length > 0) {
        lines.push(
          "",
          "## Seller / Offer Context",
          "- No explicit Buy Box winner flag was returned, but seller offers were available.",
        );
      }

      if (offers.length > 0) {
        lines.push("", `## Additional Offers (${Math.min(offers.length, 3)} of ${offers.length} shown)`);
        for (const offer of offers.slice(0, 3)) {
          lines.push(`- **${offer.merchantName || offer.offerHeader || "Seller offer"}**`);
          if (offer.condition) lines.push(`  - Condition: ${offer.condition}`);
          lines.push(`  - Price: ${formatMoney(offer.listingPrice)}`);
          if (offer.discountPercent !== null) {
            lines.push(`  - Provider-reported discount: ${formatPercent(offer.discountPercent)}`);
          }
          if (offer.sellerId) lines.push(`  - Seller ID: ${offer.sellerId}`);
          const shipping = formatShipping(offer);
          if (shipping) lines.push(`  - ${shipping}`);
          if (offer.shipsFrom) lines.push(`  - Ships from: ${offer.shipsFrom}`);
          lines.push(
            `  - Buy Box winner: ${boolLabel(offer.isBuyBoxWinner)} | Fulfilled by Amazon: ${boolLabel(offer.isFulfilledByAmazon)} | Prime: ${boolLabel(offer.isPrime)}`,
          );
        }
      }

      lines.push("", "## Review / Demand Signal");
      lines.push(`- Aggregate rating: ${product.rating ?? "Unavailable"}`);
      lines.push(`- Ratings count: ${formatCount(product.ratingsTotal)}`);
      if (product.bestSellerRankings.length > 0) {
        lines.push(`- Best seller rankings: ${product.bestSellerRankings.join(" | ")}`);
      }
      if (product.moreBuyingChoices) lines.push(`- ${product.moreBuyingChoices}`);
      lines.push(
        "- Current product-page signal is aggregate-only. Use `commerce_history` for retrospective price, rank, seller-count, rating, and review-count series, and `commerce_reviews` for review text with reviewer metadata.",
      );

      if (product.shippingInfo.length > 0) {
        lines.push("", "## Shipping Snapshot");
        for (const entry of product.shippingInfo) lines.push(`- ${entry}`);
      }
      if (product.technicalDetails.length > 0) {
        lines.push("", "## Technical Details");
        for (const detail of product.technicalDetails) lines.push(`- ${detail}`);
      }

      return outcome(offersError ? "partial" : "success", lines.join("\n"));
    }),
});

// ---------------------------------------------------------------------------
// Action 3: commerce_history (Nexscope, unknown cost)
// ---------------------------------------------------------------------------

const CommerceHistorySchema = Schema.Struct({
  asin: Schema.String.annotate({ description: "Amazon ASIN to inspect." }),
  amazon_domain: Schema.optionalKey(
    Schema.Literals(HISTORY_DOMAIN_VALUES).annotate({
      description: "Amazon marketplace (11 Nexscope history markets). Default: amazon.com.",
    }),
  ),
  days: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_HISTORY_DAYS })).annotate({
      description: "Historical window in days (default: 90, max: 365).",
    }),
  ),
  series: Schema.optionalKey(
    Schema.Array(Schema.Literals(COMMERCE_HISTORY_SERIES_VALUES)).annotate({
      description: "Series to include.",
    }),
  ),
  max_points: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 4, maximum: MAX_HISTORY_MAX_POINTS })).annotate({
      description: "Maximum displayed observations per series after full-series statistics are computed.",
    }),
  ),
  provider: Schema.optionalKey(
    Schema.Literals(HISTORY_PROVIDER_VALUES).annotate({ description: "Provider choice." }),
  ),
});

export const commerceHistoryAction = defineAction({
  name: "commerce_history",
  description:
    "Retrieve retrospective Amazon price and marketplace trend series for a known ASIN. " +
    "The active backend is Nexscope and supports event histories up to 365 days. " +
    "Use commerce_search or commerce_product first when the ASIN is unknown.",
  schema: CommerceHistorySchema,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const asinRes = requireAsin(args.asin);
      if (!asinRes.ok) return failed(`Commerce history lookup failed: ${asinRes.error}`);
      const asin = asinRes.asin;
      const market = requireMarketplace(
        args.amazon_domain ?? DEFAULT_AMAZON_DOMAIN,
        HISTORY_DOMAIN_VALUES,
        "Nexscope history",
      );
      if (!market.ok) return failed(`Commerce history lookup failed: ${market.error}`);
      const amazonDomain = market.value;
      const daysRes = optionalInteger(args.days, "days", 1, MAX_HISTORY_DAYS, DEFAULT_HISTORY_DAYS);
      if (!daysRes.ok) return failed(`Commerce history lookup failed: ${daysRes.error}`);
      const maxPointsRes = optionalInteger(
        args.max_points,
        "max_points",
        4,
        MAX_HISTORY_MAX_POINTS,
        DEFAULT_HISTORY_MAX_POINTS,
      );
      if (!maxPointsRes.ok) return failed(`Commerce history lookup failed: ${maxPointsRes.error}`);

      const selectedValues: CommerceHistorySeries[] = args.series?.length
        ? Array.from(new Set(args.series))
        : [...DEFAULT_HISTORY_SERIES];
      const unknownSeries = selectedValues.find(
        (entry) => !(COMMERCE_HISTORY_SERIES_VALUES as readonly string[]).includes(entry),
      );
      if (unknownSeries !== undefined) {
        return failed(
          `Commerce history lookup failed: series must contain only: ${COMMERCE_HISTORY_SERIES_VALUES.join(", ")} (received ${String(unknownSeries)})`,
        );
      }
      const selected = new Set<CommerceHistorySeries>(selectedValues);

      const res = yield* nexscopeRequest(
        NEXSCOPE_PRICE_SERIES_ENDPOINT,
        nexscopeHistoryBody({ asin, amazonDomain, days: daysRes.value, selected }),
        ctx.signal,
        ctx.keep,
      );
      if (!res.ok) {
        return res.cancelled
          ? outcome("cancelled", "Research call cancelled")
          : failed(`Commerce history lookup failed: ${res.error}`);
      }
      const payload = res.payload;
      const seriesFields = [
        "price",
        "buyboxPrice",
        "priceList",
        "priceDeal",
        "pricePrime",
        "priceFba",
        "priceFbm",
        "priceCoupon",
        "sellerCount",
        "rating",
        "ratingCount",
        "monthlySold",
        "bsrMain",
        "bsrSub",
      ];
      if (!seriesFields.some((key) => Array.isArray(payload[key]))) {
        return failed("Commerce history lookup failed: Nexscope returned no completed history series");
      }

      const series = collectHistorySeries({ payload, selected, days: daysRes.value });
      const usableSeries = series.filter((entry) => entry.points.length > 0);
      const costToken = firstNumber(payload.costToken);
      const lines: string[] = [
        "# Commerce Price History",
        "",
        "Provider: Nexscope",
        `Amazon domain: ${amazonDomain}`,
        `ASIN: ${asin}`,
        `Requested window: ${daysRes.value} days`,
        `Captured at: ${new Date().toISOString()}`,
        `Nexscope costToken (token consumption, not documented as charged credits): ${costToken === null ? "Not returned" : costToken}`,
        "",
        "Nexscope returns event histories rather than daily snapshots. Provider timestamps do not include a timezone; they are preserved verbatim. Unavailable `-1` values are omitted. When the last value before the requested window remained active, one carry-in event is retained to establish the window's starting state.",
        "",
        "## Series Summary",
        "| Series | Observations | First | Latest | Minimum | Maximum | Change |",
        "|---|---:|---|---|---|---|---:|",
      ];

      for (const entry of series) {
        const summary = summarizeHistoryPoints(entry.points);
        const label = `${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}`.replace(/\|/g, "\\|");
        if (!summary) {
          lines.push(`| ${label} | 0 | — | — | — | — | — |`);
          continue;
        }
        const value = (point: HistoryPoint) =>
          `${historyValueLabel(entry.key, point.value, amazonDomain)} (${point.time}${point.carriedIntoWindow ? ", carry-in" : ""})`;
        const change =
          summary.changePercent === null
            ? "—"
            : `${summary.changePercent >= 0 ? "+" : ""}${summary.changePercent.toFixed(1)}%`;
        lines.push(
          `| ${label} | ${entry.points.length} | ${value(summary.first)} | ${value(summary.latest)} | ${value(summary.minimum)} | ${value(summary.maximum)} | ${change} |`,
        );
      }

      if (usableSeries.length === 0) {
        lines.push(
          "",
          "No usable observations were returned for the selected series and requested window. This can mean the ASIN is unavailable, unsupported, or not covered by the provider.",
        );
        return outcome("empty", lines.join("\n"));
      }

      for (const entry of usableSeries) {
        const sampled = sampleHistoryPoints(entry.points, maxPointsRes.value);
        lines.push(
          "",
          `## ${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}`,
          `Full observations: ${entry.points.length}. Displayed observations: ${sampled.length}.`,
          "",
          "| Provider timestamp (timezone unspecified) | Value |",
          "|---|---:|",
        );
        for (const point of sampled) {
          lines.push(
            `| ${point.time}${point.carriedIntoWindow ? " (carry-in)" : ""} | ${historyValueLabel(entry.key, point.value, amazonDomain)} |`,
          );
        }
      }

      return outcome("success", lines.join("\n"));
    }),
});

// ---------------------------------------------------------------------------
// Action 4: commerce_reviews (Nexscope, unknown cost)
// ---------------------------------------------------------------------------

const CommerceReviewsSchema = Schema.Struct({
  asin: Schema.String.annotate({ description: "Amazon ASIN whose reviews to fetch." }),
  amazon_domain: Schema.optionalKey(
    Schema.Literals(REVIEW_DOMAIN_VALUES).annotate({
      description: "Amazon marketplace (15 Nexscope review markets). Default: amazon.com.",
    }),
  ),
  stars: Schema.optionalKey(
    Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))).annotate({
      description:
        "Star ratings to fetch (1-5). Default: all five; unselected ratings are requested with a count of 0.",
    }),
  ),
  per_star_limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_REVIEWS_PER_STAR })).annotate({
      description: "Reviews requested per selected star rating (default: 10, max: 100).",
    }),
  ),
  keyword: Schema.optionalKey(
    Schema.String.annotate({ description: "Provider-side keyword filter on review text (max 1000 characters)." }),
  ),
  sort: Schema.optionalKey(
    Schema.Literals(REVIEW_SORT_VALUES).annotate({ description: "Review order. Default: recent." }),
  ),
  verified_only: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Only verified-purchase reviews. Default: false." }),
  ),
  media_only: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Only reviews carrying images or video. Default: false." }),
  ),
  current_format_only: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Only reviews for the current format/variation. Default: false." }),
  ),
  provider: Schema.optionalKey(
    Schema.Literals(HISTORY_PROVIDER_VALUES).annotate({ description: "Provider choice." }),
  ),
});

export const commerceReviewsAction = defineAction({
  name: "commerce_reviews",
  description:
    "Fetch Amazon review text with reviewer metadata for a known ASIN through Nexscope (amazon-reviews-list). " +
    "Returns per-star review samples (default 10 per star, max 100 per star) with title, text, date, verified-purchase and Vine flags, and helpful counts; " +
    "supports keyword, recent/helpful ordering, verified-only, media-only, and current-format filters across 15 marketplaces. " +
    "This is a sampled review list, not a complete review history.",
  schema: CommerceReviewsSchema,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const asinRes = requireAsin(args.asin);
      if (!asinRes.ok) return failed(`Commerce reviews lookup failed: ${asinRes.error}`);
      const asin = asinRes.asin;
      const market = requireMarketplace(
        args.amazon_domain ?? DEFAULT_AMAZON_DOMAIN,
        REVIEW_DOMAIN_VALUES,
        "Nexscope reviews",
      );
      if (!market.ok) return failed(`Commerce reviews lookup failed: ${market.error}`);
      const amazonDomain = market.value;
      const perStarRes = optionalInteger(
        args.per_star_limit,
        "per_star_limit",
        1,
        MAX_REVIEWS_PER_STAR,
        DEFAULT_REVIEWS_PER_STAR,
      );
      if (!perStarRes.ok) return failed(`Commerce reviews lookup failed: ${perStarRes.error}`);

      if (args.stars !== undefined && !Array.isArray(args.stars)) {
        return failed("Commerce reviews lookup failed: stars must be an array of integers from 1 to 5");
      }
      const requestedStars: unknown[] = args.stars?.length ? Array.from(new Set<unknown>(args.stars)) : [...REVIEW_STAR_VALUES];
      const stars = new Set<number>();
      for (const star of requestedStars) {
        const checked = requireInteger(star, "stars", 1, 5);
        if (!checked.ok) return failed(`Commerce reviews lookup failed: ${checked.error}`);
        stars.add(checked.value);
      }

      const keyword = normalizeWhitespace(args.keyword) ?? undefined;
      if (keyword && keyword.length > MAX_REVIEW_KEYWORD_LENGTH) {
        return failed(`Commerce reviews lookup failed: keyword must be at most ${MAX_REVIEW_KEYWORD_LENGTH} characters`);
      }
      const sort: ReviewSort = args.sort ?? "recent";
      if (!(REVIEW_SORT_VALUES as readonly string[]).includes(sort)) {
        return failed(`Commerce reviews lookup failed: sort must be one of: ${REVIEW_SORT_VALUES.join(", ")}`);
      }
      const verifiedOnly = args.verified_only === true;
      const mediaOnly = args.media_only === true;
      const currentFormatOnly = args.current_format_only === true;

      const res = yield* nexscopeRequest(
        NEXSCOPE_REVIEWS_ENDPOINT,
        nexscopeReviewsBody({
          asin,
          amazonDomain,
          perStar: perStarRes.value,
          stars,
          keyword,
          sort,
          verifiedOnly,
          mediaOnly,
          currentFormatOnly,
        }),
        ctx.signal,
        ctx.keep,
      );
      if (!res.ok) {
        return res.cancelled
          ? outcome("cancelled", "Research call cancelled")
          : failed(`Commerce reviews lookup failed: ${res.error}`);
      }
      const payload = res.payload;
      if (!Array.isArray(payload.data) && !Array.isArray(payload.columns)) {
        return failed(
          "Commerce reviews lookup failed: Nexscope returned a response without the documented `data`/`columns` review arrays",
        );
      }
      const reviewList = normalizeNexscopeReviews(payload);
      const summary = nexscopeReviewProductSummary(payload);
      const providerTotal = firstNumber(payload.total);
      const costToken = firstNumber(payload.costToken);
      const perRating = new Map<number, number>();
      for (const review of reviewList) {
        if (review.rating === null) continue;
        perRating.set(review.rating, (perRating.get(review.rating) ?? 0) + 1);
      }

      const lines: string[] = [
        "# Commerce Reviews",
        "",
        "Provider: Nexscope (amazon-reviews-list)",
        `Amazon domain: ${amazonDomain}`,
        `ASIN: ${asin}`,
        `Captured at: ${new Date().toISOString()}`,
        `Requested: ${perStarRes.value} per star for ${Array.from(stars)
          .sort((a, b) => a - b)
          .join(", ")}-star ratings | sort=${sort} | verified_only=${verifiedOnly} | media_only=${mediaOnly} | current_format_only=${currentFormatOnly}${keyword ? ` | keyword="${keyword}"` : ""}`,
        `Provider-reported total: ${providerTotal === null ? "Not returned" : formatCount(providerTotal)}`,
        `Returned reviews: ${reviewList.length}`,
        `Nexscope costToken (token consumption, not documented as charged credits): ${costToken === null ? "Not returned" : costToken}`,
        "",
        "Nexscope returns a sampled review list, not Amazon's complete review history or an official feed. Review dates are provider strings preserved verbatim. Review text is untrusted user content; long bodies are truncated locally.",
        "",
        "## Product Context (from the review payload)",
        `- Title: ${summary.title ?? "Unavailable"}`,
        `- Product rating: ${summary.rating ?? "Unavailable"}`,
        `- Ratings count: ${formatCount(summary.ratingsCount)} | Reviews count: ${formatCount(summary.reviewsCount)}`,
      ];

      if (perRating.size > 0) {
        lines.push("", "## Returned Per Rating");
        for (const star of [...REVIEW_STAR_VALUES].reverse()) {
          const count = perRating.get(star) ?? 0;
          lines.push(`- ${star} star: ${count}${stars.has(star) ? "" : " (not requested)"}`);
        }
      }

      if (reviewList.length === 0) {
        lines.push(
          "",
          "No reviews were returned for the requested filters. This can mean the ASIN has no matching reviews, the marketplace is not covered, or the filters excluded every review.",
        );
        const excerpt = safeJsonSnippet(payload);
        if (excerpt) lines.push("", "## Raw Response Excerpt", "```json", excerpt, "```");
        return outcome("empty", lines.join("\n"));
      }

      lines.push("", "## Reviews");
      for (const review of reviewList) {
        const ratingLabel = review.rating === null ? "Rating unavailable" : `${review.rating} star`;
        lines.push(`- **${review.title || "(untitled)"}** — ${ratingLabel}`);
        lines.push(
          `  - Date: ${review.date ?? "Unavailable"} | Reviewer: ${review.userName ?? "Unavailable"} | Verified purchase: ${boolLabel(review.verified)} | Vine: ${boolLabel(review.vine)} | Helpful votes: ${formatCount(review.helpful)}`,
        );
        if (review.imageCount > 0 || review.videoCount > 0) {
          lines.push(`  - Media: ${review.imageCount} image(s), ${review.videoCount} video(s)`);
        }
        if (review.variation) lines.push(`  - Variation: ${review.variation}`);
        if (review.id) lines.push(`  - Review ID: ${review.id}`);
        lines.push(`  - Text: ${review.text ?? "Unavailable"}`);
      }

      return outcome("success", lines.join("\n"));
    }),
});

// ---------------------------------------------------------------------------
// Action 5: commerce_discover (Scrape.do, scrapeDoBilling)
// ---------------------------------------------------------------------------

const CommerceDiscoverSchema = Schema.Struct({
  kind: Schema.Literals(DISCOVER_KIND_VALUES).annotate({
    description: "What to discover: deals, bestsellers, new_releases, or seller.",
  }),
  amazon_domain: Schema.optionalKey(
    Schema.Literals(AMAZON_DOMAIN_VALUES).annotate({
      description:
        "Amazon marketplace (23 Scrape.do marketplaces; deals are documented for amazon.com only). Default: amazon.com.",
    }),
  ),
  category: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Required for bestsellers/new_releases: marketplace-specific category slug from the chart URL (for example electronics on amazon.com, ce-de on amazon.de).",
    }),
  ),
  node: Schema.optionalKey(
    Schema.String.annotate({
      description: "Category node id: scopes deals to a category or narrows a chart to a sub-category.",
    }),
  ),
  seller: Schema.optionalKey(
    Schema.String.annotate({
      description: "Required for seller: Amazon seller id (for example A2L77EE7U53NWQ).",
    }),
  ),
  low_price: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Deals only: lower price bound (at most two decimals).",
    }),
  ),
  high_price: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Deals only: upper price bound (at most two decimals).",
    }),
  ),
  refinement: Schema.optionalKey(
    Schema.String.annotate({ description: "Deals only: additional Amazon refinement string (rh)." }),
  ),
  sort_by: Schema.optionalKey(
    Schema.Literals(DEALS_SORT_VALUES).annotate({
      description: "Deals only: sort order. Default: Amazon's own order.",
    }),
  ),
  page: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_DEALS_PAGE })).annotate({
      description:
        "Page: deals 1-20; bestsellers/new_releases 1 (positions 1-50) or 2 (positions 51-100). Default: 1.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_DISCOVER_LIMIT })).annotate({
      description: "Max product cards to print for deals and charts (default: 20, max: 50).",
    }),
  ),
  language: Schema.optionalKey(
    Schema.String.annotate({
      description: "Uppercase ISO 639-1 page language supported by the marketplace (for example EN, DE).",
    }),
  ),
  provider: Schema.optionalKey(
    Schema.Literals(COMMERCE_PROVIDER_VALUES).annotate({ description: "Provider choice." }),
  ),
});

function checkDiscoverArgs(kind: DiscoverKind, args: Record<string, unknown>): string | null {
  const accepted = DISCOVER_KIND_ARGS[kind];
  const inapplicable = Object.keys(args)
    .filter((name) => args[name] !== undefined && !accepted.includes(name) && !DISCOVER_COMMON_ARGS.includes(name))
    .sort();
  if (inapplicable.length === 0) return null;
  const verb = inapplicable.length === 1 ? "does" : "do";
  return `${inapplicable.join(", ")} ${verb} not apply to kind=${kind} and would not be sent to the provider; kind=${kind} accepts ${[...DISCOVER_COMMON_ARGS, ...accepted].join(", ")}`;
}

function discoverDeals(args: {
  readonly amazonDomain: AmazonDomain;
  readonly node?: string;
  readonly lowPrice?: number;
  readonly highPrice?: number;
  readonly refinement?: string;
  readonly sortBy?: DealsSort;
  readonly page: number;
  readonly limit: number;
  readonly language?: string;
  readonly signal: AbortSignal;
  readonly keep: KeepRaw;
}): Effect.Effect<ActionOutcome, never, PaidHttp> {
  return Effect.gen(function* () {
    const orderErr = checkPriceOrder(args.lowPrice, args.highPrice);
    if (orderErr) return failed(`Commerce discover failed: ${orderErr}`);
    const low = normalizePriceBound(args.lowPrice, "low_price");
    if (!low.ok) return failed(`Commerce discover failed: ${low.error}`);
    const high = normalizePriceBound(args.highPrice, "high_price");
    if (!high.ok) return failed(`Commerce discover failed: ${high.error}`);
    const lang = normalizeLanguage(args.language);
    if (!lang.ok) return failed(`Commerce discover failed: ${lang.error}`);

    const res = yield* scrapeDoRequest({
      endpoint: "deals",
      amazonDomain: args.amazonDomain,
      params: {
        node: args.node,
        low_price: low.value,
        high_price: high.value,
        rh: args.refinement,
        sort_by: args.sortBy,
        page: args.page,
        language: lang.value,
      },
      signal: args.signal,
      keep: args.keep,
    });
    if (!res.ok) {
      return res.cancelled
        ? outcome("cancelled", "Research call cancelled")
        : failed(`Commerce discover failed: ${res.error}`);
    }
    const payload = res.payload;
    const rawProducts = requireArray(payload, "products", "Scrape.do deals");
    if (!rawProducts.ok) return failed(`Commerce discover failed: ${rawProducts.error}`);
    const allProducts = normalizeScrapeDoSearchItems(rawProducts.items);
    const products = allProducts.slice(0, args.limit);
    const filterGroups = normalizeScrapeDoFilterGroups(payload.filters);

    const lines: string[] = ["# Commerce Discover — Deals", "", "Provider: Scrape.do (/plugin/amazon/deals)"];
    lines.push(`Amazon domain: ${args.amazonDomain}`);
    const applied = [
      args.node ? `node=${args.node}` : null,
      args.lowPrice !== undefined ? `low_price=${args.lowPrice}` : null,
      args.highPrice !== undefined ? `high_price=${args.highPrice}` : null,
      args.refinement ? `rh=${args.refinement}` : null,
      args.sortBy ? `sort_by=${args.sortBy}` : null,
    ].filter((entry): entry is string => entry !== null);
    lines.push(`Scope: ${applied.length > 0 ? applied.join(", ") : "whole marketplace, Amazon default order"}`);
    pushPaginationLine(lines, payload, args.page);
    lines.push(`Products on page: ${allProducts.length} | Shown: ${products.length}`);
    lines.push(`Captured at: ${new Date().toISOString()}`);
    lines.push(locationNote(args.amazonDomain), "");
    lines.push(
      "Deal membership turns over quickly; two requests minutes apart can differ. Amazon renders no savings percentage on deal grids, so any percentage below is computed locally from the current and struck-through prices. An empty list is a valid result when filters match nothing.",
      "",
    );

    if (products.length === 0) {
      lines.push("No deal products were returned for this scope.");
      pushFilterLines(lines, filterGroups);
      return outcome("empty", lines.join("\n"));
    }

    lines.push("## Deals");
    for (const product of products) pushSearchItemLines(lines, product, { showRank: false });
    pushFilterLines(lines, filterGroups);
    return outcome("success", lines.join("\n"));
  });
}

function discoverChart(args: {
  readonly kind: "bestsellers" | "new_releases";
  readonly amazonDomain: AmazonDomain;
  readonly category: string;
  readonly node?: string;
  readonly page: number;
  readonly limit: number;
  readonly language?: string;
  readonly signal: AbortSignal;
  readonly keep: KeepRaw;
}): Effect.Effect<ActionOutcome, never, PaidHttp> {
  return Effect.gen(function* () {
    const lang = normalizeLanguage(args.language);
    if (!lang.ok) return failed(`Commerce discover failed: ${lang.error}`);
    const chartType = args.kind === "new_releases" ? "new-releases" : "bestsellers";
    const res = yield* scrapeDoRequest({
      endpoint: "bestsellers",
      amazonDomain: args.amazonDomain,
      params: { category: args.category, type: chartType, node: args.node, page: args.page, language: lang.value },
      signal: args.signal,
      keep: args.keep,
    });
    if (!res.ok) {
      return res.cancelled
        ? outcome("cancelled", "Research call cancelled")
        : failed(`Commerce discover failed: ${res.error}`);
    }
    const payload = res.payload;
    const rawRanking = requireArray(payload, "ranking", "Scrape.do bestsellers");
    if (!rawRanking.ok) return failed(`Commerce discover failed: ${rawRanking.error}`);
    const rawProducts = requireArray(payload, "products", "Scrape.do bestsellers");
    if (!rawProducts.ok) return failed(`Commerce discover failed: ${rawProducts.error}`);

    const ranking = normalizeScrapeDoChart(rawRanking.items);
    const products = normalizeScrapeDoSearchItems(rawProducts.items);
    const productAsins = new Set(
      products
        .slice(0, args.limit)
        .map((product) => product.asin)
        .filter((asin): asin is string => asin !== null),
    );
    const cardlessEntries = ranking.filter((entry) => !entry.asin || !productAsins.has(entry.asin));
    const rankingCount = firstNumber(payload.ranking_count) ?? ranking.length;
    const productsCount = firstNumber(payload.products_count) ?? products.length;
    const firstPosition = (args.page - 1) * BESTSELLERS_PAGE_SIZE + 1;
    const lastPosition = args.page * BESTSELLERS_PAGE_SIZE;
    const chartLabel = args.kind === "new_releases" ? "New Releases" : "Best Sellers";

    const lines: string[] = [
      `# Commerce Discover — ${chartLabel}`,
      "",
      "Provider: Scrape.do (/plugin/amazon/bestsellers)",
      `Amazon domain: ${args.amazonDomain}`,
      `Category slug: ${firstString(payload.category) ?? args.category}${args.node ? ` | node=${args.node}` : ""}`,
      `Chart type: ${firstString(payload.type) ?? chartType}`,
    ];
    pushPaginationLine(lines, payload, args.page);
    lines.push(`Positions covered by this page: ${firstPosition}-${lastPosition}`);
    lines.push(
      `Chart entries returned: ${formatCount(rankingCount)} | Entries with full product cards: ${formatCount(productsCount)} | Cards shown: ${Math.min(products.length, args.limit)}`,
    );
    lines.push(`Captured at: ${new Date().toISOString()}`);
    lines.push(locationNote(args.amazonDomain), "");
    lines.push(
      "Amazon renders full product cards for only the first 30 positions of each 50-position page; the remaining positions carry rank, ASIN, and URL only. Chart membership changes hourly. Category slugs are marketplace-specific.",
      "",
    );

    if (ranking.length === 0 && products.length === 0) {
      lines.push(
        "The provider returned an empty chart for this category and page (a successful response with no entries, not an error).",
      );
      return outcome("empty", lines.join("\n"));
    }

    if (products.length > 0) {
      lines.push("## Ranked Products (full cards)");
      for (const product of products.slice(0, args.limit)) pushSearchItemLines(lines, product, { showRank: true });
      if (products.length > args.limit) {
        lines.push(`- ${products.length - args.limit} more product cards omitted by limit`);
      }
    }
    if (cardlessEntries.length > 0) {
      lines.push("", "## Remaining Chart Positions (rank and ASIN only)");
      for (const entry of cardlessEntries) {
        lines.push(`- #${entry.rank ?? "?"} ${entry.asin ?? "ASIN unavailable"}${entry.link ? ` (${entry.link})` : ""}`);
      }
    }
    return outcome("success", lines.join("\n"));
  });
}

function discoverSeller(args: {
  readonly amazonDomain: AmazonDomain;
  readonly seller: string;
  readonly language?: string;
  readonly signal: AbortSignal;
  readonly keep: KeepRaw;
}): Effect.Effect<ActionOutcome, never, PaidHttp> {
  return Effect.gen(function* () {
    const lang = normalizeLanguage(args.language);
    if (!lang.ok) return failed(`Commerce discover failed: ${lang.error}`);
    const res = yield* scrapeDoRequest({
      endpoint: "seller",
      amazonDomain: args.amazonDomain,
      params: { seller: args.seller, language: lang.value },
      signal: args.signal,
      keep: args.keep,
    });
    if (!res.ok) {
      return res.cancelled
        ? outcome("cancelled", "Research call cancelled")
        : failed(`Commerce discover failed: ${res.error}`);
    }
    const payload = res.payload;
    if (!firstString(payload.seller_id, payload.name)) {
      return failed(
        "Commerce discover failed: Scrape.do returned a seller response without the documented `seller_id`/`name` fields",
      );
    }
    const profile = normalizeScrapeDoSeller(payload);
    const lines: string[] = [
      "# Commerce Discover — Seller Profile",
      "",
      "Provider: Scrape.do (/plugin/amazon/seller)",
      `Amazon domain: ${args.amazonDomain}`,
      `Seller ID: ${profile.sellerId ?? args.seller}`,
      "",
      "Seller profiles carry only the headline positive-feedback percentage; feedback and rating history are not included. EU marketplaces publish the trader-transparency block; other marketplaces often publish little beyond the display name, so every field below is optional.",
      "",
      "## Profile",
      `- Display name: ${profile.name ?? "Unavailable"}`,
      `- Positive feedback: ${profile.positiveFeedbackPercent === null ? "Not shown on seller page" : formatPercent(profile.positiveFeedbackPercent)}`,
    ];
    if (profile.about) lines.push(`- About (seller's own text, truncated): ${profile.about}`);
    lines.push("", "## Business Details");
    const details: ReadonlyArray<readonly [string, string | null]> = [
      ["Business name", profile.businessName],
      ["Business type", profile.businessType],
      ["Trade register number", profile.tradeRegisterNumber],
      ["VAT number", profile.vatNumber],
      ["Phone", profile.phoneNumber],
      ["Email", profile.email],
      ["Address", profile.businessAddress.length > 0 ? profile.businessAddress.join(", ") : null],
    ];
    const present = details.filter((entry): entry is readonly [string, string] => entry[1] !== null);
    if (present.length === 0 && profile.otherFields.length === 0) {
      lines.push("- No business details were published for this seller on this marketplace.");
    } else {
      for (const [label, value] of present) lines.push(`- ${label}: ${value}`);
      for (const line of profile.otherFields) lines.push(`- ${line}`);
    }
    lines.push("", "Use `commerce_search` with `seller` set to this id to list the seller's catalog.");
    return outcome("success", lines.join("\n"));
  });
}

export const commerceDiscoverAction = defineAction({
  name: "commerce_discover",
  description:
    "Discover Amazon inventory beyond keyword search through Scrape.do: `deals` (discounted grid with current and struck-through prices; currently documented for amazon.com only, pages 1-20), " +
    "`bestsellers` and `new_releases` (Top 100 chart for a marketplace-specific category slug, two pages of 50 with full cards for the first 30 of each), " +
    "and `seller` (public seller profile: display name, positive-feedback percentage, published business details). " +
    "Use commerce_product for a specific ASIN and commerce_search with `seller` for a seller's catalog.",
  schema: CommerceDiscoverSchema,
  billing: scrapeDoBilling,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const kind = args.kind;
      if (!(DISCOVER_KIND_VALUES as readonly string[]).includes(kind)) {
        return failed(`Commerce discover failed: kind must be one of: ${DISCOVER_KIND_VALUES.join(", ")}`);
      }
      const inapplicable = checkDiscoverArgs(kind, args as unknown as Record<string, unknown>);
      if (inapplicable) return failed(`Commerce discover failed: ${inapplicable}`);
      const market = requireMarketplace(args.amazon_domain ?? DEFAULT_AMAZON_DOMAIN, AMAZON_DOMAIN_VALUES, "Scrape.do");
      if (!market.ok) return failed(`Commerce discover failed: ${market.error}`);
      const amazonDomain = market.value;
      const limitRes = optionalInteger(args.limit, "limit", 1, MAX_DISCOVER_LIMIT, DEFAULT_DISCOVER_LIMIT);
      if (!limitRes.ok) return failed(`Commerce discover failed: ${limitRes.error}`);
      if (args.sort_by !== undefined && !(DEALS_SORT_VALUES as readonly string[]).includes(args.sort_by)) {
        return failed(`Commerce discover failed: sort_by must be one of: ${DEALS_SORT_VALUES.join(", ")}`);
      }

      switch (kind) {
        case "deals": {
          const pageRes = optionalInteger(args.page, "Deals page", 1, MAX_DEALS_PAGE, 1);
          if (!pageRes.ok) return failed(`Commerce discover failed: ${pageRes.error}`);
          return yield* discoverDeals({
            amazonDomain,
            node: normalizeWhitespace(args.node) ?? undefined,
            lowPrice: args.low_price,
            highPrice: args.high_price,
            refinement: normalizeWhitespace(args.refinement) ?? undefined,
            sortBy: args.sort_by,
            page: pageRes.value,
            limit: limitRes.value,
            language: args.language,
            signal: ctx.signal,
            keep: ctx.keep,
          });
        }
        case "bestsellers":
        case "new_releases": {
          const category = normalizeWhitespace(args.category);
          if (!category) {
            return failed(
              `Commerce discover failed: category is required for kind=${kind} (marketplace-specific chart slug, for example electronics)`,
            );
          }
          const pageRes = optionalInteger(args.page, "Chart page", 1, MAX_BESTSELLERS_PAGE, 1);
          if (!pageRes.ok) return failed(`Commerce discover failed: ${pageRes.error}`);
          return yield* discoverChart({
            kind,
            amazonDomain,
            category,
            node: normalizeWhitespace(args.node) ?? undefined,
            page: pageRes.value,
            limit: limitRes.value,
            language: args.language,
            signal: ctx.signal,
            keep: ctx.keep,
          });
        }
        case "seller": {
          const seller = normalizeWhitespace(args.seller);
          if (!seller) {
            return failed(
              "Commerce discover failed: seller is required for kind=seller (Amazon seller id such as A2L77EE7U53NWQ)",
            );
          }
          return yield* discoverSeller({
            amazonDomain,
            seller,
            language: args.language,
            signal: ctx.signal,
            keep: ctx.keep,
          });
        }
      }
    }),
});

export const commerceSource: SourcePlugin = defineSource({
  id: "commerce",
  group: "markets",
  label: "Commerce",
  description: "Amazon products, reviews and price history",
  about:
    "Amazon products, search results, deals, Best Sellers and seller pages through Scrape.do, plus review samples and up to a year of price and rank history through Nexscope.",
  providers: [
    { name: "Scrape.do", url: "https://scrape.do" },
    { name: "Nexscope", url: "https://www.nexscope.ai" },
  ],
  billing:
    "Scrape.do credits per request, which Dig records. Nexscope is paid from its own account and does not report a per-request amount, so those calls show as unknown.",
  env: ["SCRAPE_DO_API_KEY", "SCRAPEDO_API_TOKEN", "NEXSCOPE_API_KEY"],
  keys: [["SCRAPE_DO_API_KEY", "SCRAPEDO_API_TOKEN"]],
  credential: "SCRAPE_DO_API_KEY or SCRAPEDO_API_TOKEN; NEXSCOPE_API_KEY for reviews/history",
  actions: [
    commerceSearchAction,
    commerceProductAction,
    commerceHistoryAction,
    commerceReviewsAction,
    commerceDiscoverAction,
  ],
});

export default commerceSource;
