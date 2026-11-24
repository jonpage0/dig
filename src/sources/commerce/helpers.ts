/**
 * Shared types, constants, Effect HTTP clients (`PaidHttp`), normalizers, and formatters
 * for the Amazon Commerce source plugin (Scrape.do + Nexscope).
 */
import { Effect, Result } from "effect";
import { paidRequest, type KeepRaw, type PaidHttp } from "../../core/http.ts";
import { meteredBilling, setOutsideChat } from "../../core/plugin.ts";
import { knownSecrets, redactText, redactValue } from "../../core/secrets.ts";

export const SCRAPE_DO_COST_UNIT = "Scrape.do credits";

export const scrapeDoBilling = meteredBilling(SCRAPE_DO_COST_UNIT, (_body, _status, headers) => {
  const value = headers?.["scrape.do-request-cost"];
  return value !== undefined && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;
});

export const AMAZON_DOMAIN_VALUES = [
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
] as const;

export const HISTORY_DOMAIN_VALUES = [
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
] as const;

export const REVIEW_DOMAIN_VALUES = [
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
] as const;

export const COMMERCE_PROVIDER_VALUES = ["auto", "scrape-do"] as const;
export const HISTORY_PROVIDER_VALUES = ["auto", "nexscope"] as const;
export const COMMERCE_HISTORY_SERIES_VALUES = [
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
] as const;
export const REVIEW_SORT_VALUES = ["recent", "helpful"] as const;
export const DISCOVER_KIND_VALUES = ["deals", "bestsellers", "new_releases", "seller"] as const;
export const DEALS_SORT_VALUES = [
  "relevance",
  "featured",
  "price_low_to_high",
  "price_high_to_low",
  "average_review",
  "most_recent",
  "newest_arrivals",
  "bestsellers",
  "bestseller_rankings",
] as const;

export type AmazonDomain = (typeof AMAZON_DOMAIN_VALUES)[number];
export type HistoryDomain = (typeof HISTORY_DOMAIN_VALUES)[number];
export type ReviewDomain = (typeof REVIEW_DOMAIN_VALUES)[number];
export type CommerceProviderId = (typeof COMMERCE_PROVIDER_VALUES)[number];
export type CommerceHistorySeries = (typeof COMMERCE_HISTORY_SERIES_VALUES)[number];
export type ReviewSort = (typeof REVIEW_SORT_VALUES)[number];
export type DiscoverKind = (typeof DISCOVER_KIND_VALUES)[number];
export type DealsSort = (typeof DEALS_SORT_VALUES)[number];
export type ScrapeDoEndpoint = "search" | "pdp" | "offer-listing" | "deals" | "bestsellers" | "seller";

export const DISCOVER_KIND_ARGS: Record<DiscoverKind, readonly string[]> = {
  deals: ["node", "low_price", "high_price", "refinement", "sort_by", "page", "limit", "language"],
  bestsellers: ["category", "node", "page", "limit", "language"],
  new_releases: ["category", "node", "page", "limit", "language"],
  seller: ["seller", "language"],
};
export const DISCOVER_COMMON_ARGS: readonly string[] = ["kind", "amazon_domain", "provider"];

export interface HistoryPoint {
  readonly time: string;
  readonly value: number;
  readonly carriedIntoWindow?: boolean;
}

export interface NormalizedHistorySeries {
  readonly key: CommerceHistorySeries;
  readonly label: string;
  readonly detail: string | null;
  readonly points: HistoryPoint[];
}

export interface Money {
  readonly value: number | null;
  readonly currency: string | null;
  readonly raw: string | null;
}

export interface ScrapeDoDelivery {
  readonly price: Money | null;
  readonly isFree: boolean | null;
  readonly date: string | null;
  readonly fastestDate: string | null;
  readonly rawText: string | null;
}

export interface ScrapeDoSearchItem {
  readonly position: number | null;
  readonly rank: number | null;
  readonly title: string;
  readonly asin: string | null;
  readonly link: string | null;
  readonly imageUrl: string | null;
  readonly price: Money | null;
  readonly priceBeforeDeal: Money | null;
  readonly rating: number | null;
  readonly ratingsTotal: number | null;
  readonly reviewCountLabel: string | null;
  readonly badge: string | null;
  readonly isPrime: boolean | null;
  readonly sponsored: boolean | null;
  readonly salesVolume: string | null;
  readonly delivery: ScrapeDoDelivery | null;
}

export interface ScrapeDoFilterGroup {
  readonly name: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly rh: string | null }>;
}

export interface ScrapeDoCategory {
  readonly name: string;
  readonly node: string | null;
}

export interface ScrapeDoOffer {
  readonly condition: string | null;
  readonly offerHeader: string | null;
  readonly sellerId: string | null;
  readonly merchantName: string | null;
  readonly deliveryDate: string | null;
  readonly listingPrice: Money | null;
  readonly listPrice: Money | null;
  readonly discountPercent: number | null;
  readonly shipping: Money | null;
  readonly shipsFrom: string | null;
  readonly isFulfilledByAmazon: boolean | null;
  readonly isPrime: boolean | null;
  readonly isBuyBoxWinner: boolean | null;
  readonly quantity: number | null;
}

export interface ScrapeDoProduct {
  readonly title: string;
  readonly brand: string | null;
  readonly asin: string | null;
  readonly parentAsin: string | null;
  readonly link: string | null;
  readonly thumbnail: string | null;
  readonly price: Money | null;
  readonly listPrice: Money | null;
  readonly rating: number | null;
  readonly ratingsTotal: number | null;
  readonly isPrime: boolean | null;
  readonly isSponsored: boolean | null;
  readonly inStock: boolean | null;
  readonly availabilityText: string | null;
  readonly badges: string[];
  readonly amazonChoice: boolean | null;
  readonly bestSeller: boolean | null;
  readonly description: string | null;
  readonly shippingInfo: string[];
  readonly bestSellerRankings: string[];
  readonly technicalDetails: string[];
  readonly moreBuyingChoices: string | null;
}

export interface ScrapeDoChartEntry {
  readonly rank: number | null;
  readonly asin: string | null;
  readonly link: string | null;
}

export interface ScrapeDoSellerProfile {
  readonly sellerId: string | null;
  readonly name: string | null;
  readonly about: string | null;
  readonly positiveFeedbackPercent: number | null;
  readonly businessName: string | null;
  readonly businessType: string | null;
  readonly tradeRegisterNumber: string | null;
  readonly vatNumber: string | null;
  readonly phoneNumber: string | null;
  readonly email: string | null;
  readonly businessAddress: string[];
  readonly otherFields: string[];
}

export interface NexscopeReview {
  readonly id: string | null;
  readonly rating: number | null;
  readonly title: string | null;
  readonly text: string | null;
  readonly date: string | null;
  readonly userName: string | null;
  readonly verified: boolean | null;
  readonly vine: boolean | null;
  readonly helpful: number | null;
  readonly imageCount: number;
  readonly videoCount: number;
  readonly variation: string | null;
}

export interface NexscopeReviewProductSummary {
  readonly title: string | null;
  readonly rating: string | null;
  readonly ratingsCount: number | null;
  readonly reviewsCount: number | null;
}

interface AmazonMarketplaceProfile {
  readonly geocode: string;
  readonly zipcode?: string;
}

export const DEFAULT_AMAZON_DOMAIN: AmazonDomain = "amazon.com";
export const MAX_SEARCH_LIMIT = 10;
export const DEFAULT_DISCOVER_LIMIT = 20;
export const MAX_DISCOVER_LIMIT = 50;
export const MAX_DEALS_PAGE = 20;
export const MAX_BESTSELLERS_PAGE = 2;
export const BESTSELLERS_PAGE_SIZE = 50;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const SCRAPE_DO_AMAZON_BASE = "https://api.scrape.do/plugin/amazon/";
export const NEXSCOPE_PRICE_SERIES_ENDPOINT = "https://api.nexscope.ai/kp/productSeries";
export const NEXSCOPE_REVIEWS_ENDPOINT = "https://api.nexscope.ai/amazon/reviews/list";
export const DEFAULT_HISTORY_DAYS = 90;
export const MAX_HISTORY_DAYS = 365;
export const DEFAULT_HISTORY_MAX_POINTS = 60;
export const MAX_HISTORY_MAX_POINTS = 200;
export const DEFAULT_HISTORY_SERIES: readonly CommerceHistorySeries[] = [
  "market_price",
  "buy_box",
  "list_price",
  "deal_price",
  "prime_price",
  "coupon_price",
];
export const DEFAULT_REVIEWS_PER_STAR = 10;
export const MAX_REVIEWS_PER_STAR = 100;
export const MAX_REVIEW_KEYWORD_LENGTH = 1000;
export const REVIEW_TEXT_MAX_CHARS = 800;
export const DESCRIPTION_MAX_CHARS = 600;
export const REVIEW_STAR_VALUES = [1, 2, 3, 4, 5] as const;

const AMAZON_MARKETPLACE_PROFILES: Record<AmazonDomain, AmazonMarketplaceProfile> = {
  "amazon.com": { geocode: "us", zipcode: "10001" },
  "amazon.ca": { geocode: "ca", zipcode: "K1W 0C8" },
  "amazon.co.uk": { geocode: "gb", zipcode: "SW1A 1AA" },
  "amazon.de": { geocode: "de", zipcode: "10115" },
  "amazon.fr": { geocode: "fr", zipcode: "75001" },
  "amazon.it": { geocode: "it", zipcode: "00100" },
  "amazon.es": { geocode: "es", zipcode: "28001" },
  "amazon.co.jp": { geocode: "jp", zipcode: "100-0001" },
  "amazon.in": { geocode: "in", zipcode: "560001" },
  "amazon.ie": { geocode: "ie", zipcode: "D02 AF30" },
  "amazon.co.za": { geocode: "za", zipcode: "2000" },
  "amazon.com.mx": { geocode: "mx" },
  "amazon.com.br": { geocode: "br" },
  "amazon.com.au": { geocode: "au" },
  "amazon.com.tr": { geocode: "tr" },
  "amazon.nl": { geocode: "nl" },
  "amazon.com.be": { geocode: "be" },
  "amazon.pl": { geocode: "pl" },
  "amazon.se": { geocode: "se" },
  "amazon.ae": { geocode: "ae" },
  "amazon.sa": { geocode: "sa" },
  "amazon.sg": { geocode: "sg" },
  "amazon.eg": { geocode: "eg" },
};

const NEXSCOPE_DOMAIN_IDS: Record<HistoryDomain, string> = {
  "amazon.com": "1",
  "amazon.co.uk": "2",
  "amazon.de": "3",
  "amazon.fr": "4",
  "amazon.co.jp": "5",
  "amazon.ca": "6",
  "amazon.it": "8",
  "amazon.es": "9",
  "amazon.in": "10",
  "amazon.com.mx": "11",
  "amazon.com.br": "12",
};

const HISTORY_CURRENCIES: Record<HistoryDomain, string> = {
  "amazon.com": "USD",
  "amazon.ca": "CAD",
  "amazon.co.uk": "GBP",
  "amazon.de": "EUR",
  "amazon.fr": "EUR",
  "amazon.it": "EUR",
  "amazon.es": "EUR",
  "amazon.co.jp": "JPY",
  "amazon.com.mx": "MXN",
  "amazon.in": "INR",
  "amazon.com.br": "BRL",
};

export const unansweredCost = (provider: string) =>
  `${provider} may have received and charged this request, but no complete response arrived; its cost is unknown.`;

export function errorMessage(error: unknown): string {
  return redactText(error instanceof Error ? error.message : "Unknown error", knownSecrets());
}

export function scrapeDoApiToken(): string | null {
  return process.env.SCRAPE_DO_API_KEY?.trim() || process.env.SCRAPEDO_API_TOKEN?.trim() || null;
}

export function nexscopeApiKey(): string | null {
  return process.env.NEXSCOPE_API_KEY?.trim() || null;
}

export const MISSING_SCRAPEDO_KEY = `SCRAPE_DO_API_KEY is not set in Dig's keys.env. ${setOutsideChat()}`;
export const MISSING_NEXSCOPE_KEY = `NEXSCOPE_API_KEY is not set in Dig's keys.env. ${setOutsideChat()}`;

export function requireInteger(value: unknown, name: string, min: number, max: number): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return {
      ok: false,
      error: Number.isFinite(max)
        ? `${name} must be an integer from ${min} to ${max}`
        : `${name} must be an integer of at least ${min}`,
    };
  }
  return { ok: true, value };
}

export function optionalInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
  fallback: number,
): { ok: true; value: number } | { ok: false; error: string } {
  return value === undefined ? { ok: true, value: fallback } : requireInteger(value, name, min, max);
}

export function requireMarketplace<Domain extends string>(
  value: unknown,
  allowed: readonly Domain[],
  label: string,
): { ok: true; value: Domain } | { ok: false; error: string } {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    return { ok: false, error: `amazon_domain must be one of the ${label} marketplaces: ${allowed.join(", ")}` };
  }
  return { ok: true, value: value as Domain };
}

export function requireArray(
  payload: Record<string, unknown>,
  field: string,
  provider: string,
): { ok: true; items: unknown[] } | { ok: false; error: string } {
  const value = payload[field];
  if (!Array.isArray(value)) {
    return { ok: false, error: `${provider} returned a response without the documented \`${field}\` array` };
  }
  return { ok: true, items: value };
}

export function normalizeWhitespace(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return normalized || null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function scalarText(value: unknown): string | null {
  if (typeof value === "string") return normalizeWhitespace(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return null;
}

export function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = scalarText(value);
    if (normalized) return normalized;
  }
  return null;
}

export function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }
  }
  return null;
}

export function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const cleaned = value.replace(/[^\d.-]/g, "").trim();
      if (!cleaned) continue;
      const parsed = Number(cleaned);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function parseCompactCount(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[(),\s]/g, "").toUpperCase();
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)([KMB])?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const multiplier = match[2] === "K" ? 1_000 : match[2] === "M" ? 1_000_000 : match[2] === "B" ? 1_000_000_000 : 1;
  return Math.round(amount * multiplier);
}

export function uniqStrings(values: readonly (string | null | undefined)[]): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (normalized) deduped.add(normalized);
  }
  return Array.from(deduped);
}

export function truncateText(value: string | null, maxChars: number): string | null {
  if (!value) return null;
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

export function normalizeMoney(value: unknown, fallbackCurrency?: string | null): Money | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { value, currency: fallbackCurrency ?? null, raw: null };
  }
  const record = asRecord(value);
  if (!record) return null;
  return {
    value: firstNumber(record.amount, record.value, record.price),
    currency: firstString(record.currencyCode, record.currency, record.currency_symbol) ?? fallbackCurrency ?? null,
    raw: firstString(record.raw, record.formatted, record.text),
  };
}

export function formatCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "JPY" ? 0 : 2,
    }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

export function formatMoney(value: Money | null): string {
  if (!value) return "Unavailable";
  if (value.raw) return value.raw;
  if (value.value === null) return value.currency || "Unavailable";
  if (value.currency) return formatCurrency(value.value, value.currency);
  return String(value.value);
}

export function formatCount(value: number | null): string {
  return value === null ? "Unavailable" : new Intl.NumberFormat("en-US").format(value);
}

export function formatPercent(value: number | null): string {
  return value === null ? "Unavailable" : `${value.toFixed(1)}%`;
}

export function boolLabel(value: boolean | null): string {
  return value === null ? "Unknown" : value ? "Yes" : "No";
}

export function safeJsonSnippet(value: unknown, maxLength = 1600): string | null {
  try {
    const serialized = JSON.stringify(redactValue(value, knownSecrets()), null, 2);
    if (!serialized) return null;
    return serialized.length <= maxLength ? serialized : `${serialized.slice(0, maxLength - 1).trimEnd()}…`;
  } catch {
    return null;
  }
}

export function computedSavingsPercent(price: Money | null, reference: Money | null): number | null {
  const current = price?.value ?? null;
  const base = reference?.value ?? null;
  if (current === null || base === null || base <= 0) return null;
  if (price?.currency && reference?.currency && price.currency !== reference.currency) return null;
  return Math.round((1 - current / base) * 1000) / 10;
}

function historyCutoffDate(days: number): string {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return cutoff.toISOString().slice(0, 10);
}

export function normalizeHistoryPoints(value: unknown, days: number): HistoryPoint[] {
  const cutoff = historyCutoffDate(days);
  const allPoints = asArray(value)
    .map((entry): HistoryPoint | null => {
      const record = asRecord(entry);
      const time = firstString(record?.time);
      const rawValue = firstNumber(record?.value);
      if (!time || rawValue === null) return null;
      return { time, value: Math.round(rawValue * 10_000) / 10_000 };
    })
    .filter((point): point is HistoryPoint => point !== null)
    .sort((a, b) => a.time.localeCompare(b.time));

  const carryIn = allPoints.filter((point) => point.time.slice(0, 10) < cutoff).at(-1);
  const points: HistoryPoint[] = [];
  if (carryIn && carryIn.value >= 0) points.push({ ...carryIn, carriedIntoWindow: true });
  points.push(...allPoints.filter((point) => point.time.slice(0, 10) >= cutoff && point.value >= 0));

  const deduped: HistoryPoint[] = [];
  for (const point of points) {
    const previous = deduped.at(-1);
    if (previous?.time === point.time && previous.value === point.value) continue;
    deduped.push(point);
  }
  return deduped;
}

export function collectHistorySeries(args: {
  readonly payload: Record<string, unknown>;
  readonly selected: ReadonlySet<CommerceHistorySeries>;
  readonly days: number;
}): NormalizedHistorySeries[] {
  const direct: ReadonlyArray<{ readonly key: CommerceHistorySeries; readonly label: string; readonly field: string }> = [
    { key: "market_price", label: "Lowest new market price", field: "price" },
    { key: "buy_box", label: "Buy Box price", field: "buyboxPrice" },
    { key: "list_price", label: "List / strikethrough price", field: "priceList" },
    { key: "deal_price", label: "Deal / flash-sale price", field: "priceDeal" },
    { key: "prime_price", label: "Prime-exclusive price", field: "pricePrime" },
    { key: "fba_price", label: "Third-party FBA price", field: "priceFba" },
    { key: "fbm_price", label: "Third-party FBM price", field: "priceFbm" },
    { key: "coupon_price", label: "Coupon-applied Buy Box price", field: "priceCoupon" },
    { key: "seller_count", label: "Seller count", field: "sellerCount" },
    { key: "rating", label: "Rating", field: "rating" },
    { key: "review_count", label: "Review count", field: "ratingCount" },
    { key: "monthly_sold", label: "Monthly sold signal", field: "monthlySold" },
  ];

  const series = direct
    .filter((entry) => args.selected.has(entry.key))
    .map(
      (entry): NormalizedHistorySeries => ({
        key: entry.key,
        label: entry.label,
        detail: null,
        points: normalizeHistoryPoints(args.payload[entry.field], args.days),
      }),
    );

  if (args.selected.has("sales_rank")) {
    const ranks: NormalizedHistorySeries[] = [];
    for (const field of ["bsrMain", "bsrSub"] as const) {
      for (const entry of asArray(args.payload[field])) {
        const record = asRecord(entry);
        const category = firstString(record?.categoryName) || "Unknown category";
        ranks.push({
          key: "sales_rank",
          label: field === "bsrMain" ? "Main-category sales rank" : "Subcategory sales rank",
          detail: category,
          points: normalizeHistoryPoints(record?.points, args.days),
        });
      }
    }
    if (ranks.length === 0) ranks.push({ key: "sales_rank", label: "Sales rank", detail: null, points: [] });
    series.push(...ranks);
  }
  return series;
}

export function sampleHistoryPoints(points: readonly HistoryPoint[], maxPoints: number): HistoryPoint[] {
  if (points.length <= maxPoints) return [...points];
  const sampled: HistoryPoint[] = [];
  for (let index = 0; index < maxPoints; index++) {
    const sourceIndex = Math.round((index * (points.length - 1)) / (maxPoints - 1));
    const point = points[sourceIndex];
    if (point && sampled.at(-1) !== point) sampled.push(point);
  }
  return sampled;
}

export function historyValueLabel(key: CommerceHistorySeries, value: number, amazonDomain: HistoryDomain): string {
  if (
    key === "market_price" ||
    key === "buy_box" ||
    key === "list_price" ||
    key === "deal_price" ||
    key === "prime_price" ||
    key === "fba_price" ||
    key === "fbm_price" ||
    key === "coupon_price"
  ) {
    return formatCurrency(value, HISTORY_CURRENCIES[amazonDomain]);
  }
  if (key === "rating") return value.toFixed(1);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

export function summarizeHistoryPoints(points: readonly HistoryPoint[]) {
  const first = points[0];
  if (!first) return null;
  let minimum = first;
  let maximum = first;
  for (const point of points.slice(1)) {
    if (point.value < minimum.value) minimum = point;
    if (point.value > maximum.value) maximum = point;
  }
  const latest = points.at(-1) ?? first;
  const changePercent = first.value === 0 ? null : ((latest.value - first.value) / first.value) * 100;
  return { first, latest, minimum, maximum, changePercent };
}

export function nexscopeHistoryBody(args: {
  readonly asin: string;
  readonly amazonDomain: HistoryDomain;
  readonly days: number;
  readonly selected: ReadonlySet<CommerceHistorySeries>;
}): Record<string, string | number> {
  return {
    asin: args.asin,
    domain: NEXSCOPE_DOMAIN_IDS[args.amazonDomain],
    days: args.days,
    showPrice: args.selected.has("market_price") ? 1 : 0,
    showPriceList: args.selected.has("list_price") ? 1 : 0,
    showPriceDeal: args.selected.has("deal_price") ? 1 : 0,
    showPricePrime: args.selected.has("prime_price") ? 1 : 0,
    showPriceFba: args.selected.has("fba_price") ? 1 : 0,
    showPriceFbm: args.selected.has("fbm_price") ? 1 : 0,
    showPriceCoupon: args.selected.has("coupon_price") ? 1 : 0,
    showBsrMain: args.selected.has("sales_rank") ? 1 : 0,
    showSellerCount: args.selected.has("seller_count") ? 1 : 0,
  };
}

export function nexscopeReviewsBody(args: {
  readonly asin: string;
  readonly amazonDomain: ReviewDomain;
  readonly perStar: number;
  readonly stars: ReadonlySet<number>;
  readonly keyword?: string;
  readonly sort: ReviewSort;
  readonly verifiedOnly: boolean;
  readonly mediaOnly: boolean;
  readonly currentFormatOnly: boolean;
}): Record<string, string | number | undefined> {
  const count = (star: number) => (args.stars.has(star) ? args.perStar : 0);
  return {
    asin: args.asin,
    domainCode: args.amazonDomain.replace(/^amazon\./, ""),
    star1Num: count(1),
    star2Num: count(2),
    star3Num: count(3),
    star4Num: count(4),
    star5Num: count(5),
    filterByKeyword: args.keyword,
    sortBy: args.sort,
    reviewerType: args.verifiedOnly ? "avp_only_reviews" : "all_reviews",
    mediaType: args.mediaOnly ? "media_reviews_only" : "all_contents",
    formatType: args.currentFormatOnly ? "current_format" : "all_formats",
  };
}

export type ProviderCallResult =
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly cancelled: boolean; readonly error: string };

export function nexscopeRequest(
  url: string,
  body: Record<string, string | number | undefined>,
  signal: AbortSignal,
  keep: KeepRaw,
): Effect.Effect<ProviderCallResult, never, PaidHttp> {
  return Effect.gen(function* () {
    const key = nexscopeApiKey();
    if (!key) return { ok: false as const, cancelled: false, error: MISSING_NEXSCOPE_KEY };
    const res = yield* Effect.result(
      paidRequest({
        url,
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        signal,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        keep,
        label: url,
      }),
    );
    if (Result.isFailure(res)) {
      if (signal.aborted) return { ok: false as const, cancelled: true, error: "cancelled" };
      return { ok: false as const, cancelled: false, error: `${errorMessage(res.failure)}. ${unansweredCost("Nexscope")}` };
    }
    const { status, payload } = res.success;
    const record = asRecord(payload);
    if (status < 200 || status >= 300) {
      const msg = firstString(record?.errmsg, record?.message, record?.msg) || "Unknown error";
      return { ok: false as const, cancelled: false, error: `${status}: ${msg}` };
    }
    if (!record) return { ok: false as const, cancelled: false, error: "Nexscope returned a non-object JSON payload" };
    if (record.code !== 0) {
      return {
        ok: false as const,
        cancelled: false,
        error: `${firstString(record.msg, record.message) || "Nexscope rejected the request"} (Nexscope code ${String(record.code)}${firstString(record.traceId) ? `, traceId ${record.traceId}` : ""})`,
      };
    }
    const business = asRecord(record.data);
    if (!business) return { ok: false as const, cancelled: false, error: "Nexscope returned no completed business result" };
    const errcode = firstNumber(business.errcode);
    if (errcode !== null && errcode !== 0 && errcode !== 200) {
      return {
        ok: false as const,
        cancelled: false,
        error: firstString(business.errmsg, business.message) || `Nexscope returned errcode ${errcode}`,
      };
    }
    return { ok: true as const, payload: business };
  });
}

export function marketplaceProfile(amazonDomain: AmazonDomain): AmazonMarketplaceProfile {
  return AMAZON_MARKETPLACE_PROFILES[amazonDomain];
}

export function scrapeDoRequest(args: {
  readonly endpoint: ScrapeDoEndpoint;
  readonly amazonDomain: AmazonDomain;
  readonly params: Record<string, string | number | boolean | undefined>;
  readonly signal: AbortSignal;
  readonly keep: KeepRaw;
}): Effect.Effect<ProviderCallResult, never, PaidHttp> {
  return Effect.gen(function* () {
    const token = scrapeDoApiToken();
    if (!token) return { ok: false as const, cancelled: false, error: MISSING_SCRAPEDO_KEY };
    const url = new URL(`${SCRAPE_DO_AMAZON_BASE}${args.endpoint}`);
    const profile = marketplaceProfile(args.amazonDomain);
    url.searchParams.set("token", token);
    url.searchParams.set("geocode", profile.geocode);
    if (profile.zipcode) url.searchParams.set("zipcode", profile.zipcode);
    for (const [key, value] of Object.entries(args.params)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }

    const res = yield* Effect.result(
      paidRequest({
        url: url.href,
        method: "GET",
        headers: { Accept: "application/json" },
        signal: args.signal,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        keep: args.keep,
        label: args.endpoint,
      }),
    );
    if (Result.isFailure(res)) {
      if (args.signal.aborted) return { ok: false as const, cancelled: true, error: "cancelled" };
      return { ok: false as const, cancelled: false, error: `${errorMessage(res.failure)}. ${unansweredCost("Scrape.do")}` };
    }
    const { status, payload } = res.success;
    const record = asRecord(payload);
    if (status < 200 || status >= 300) {
      const msg = firstString(record?.message, record?.errorMessage, record?.error) || "Unknown error";
      return { ok: false as const, cancelled: false, error: `${status}: ${msg}` };
    }
    if (!record) return { ok: false as const, cancelled: false, error: "Provider returned a non-object JSON payload" };
    const apiStatus = firstString(record.status)?.toLowerCase();
    if (apiStatus && apiStatus !== "success") {
      return {
        ok: false as const,
        cancelled: false,
        error: firstString(record.errorMessage, record.message, record.error) || "Scrape.do request failed",
      };
    }
    return { ok: true as const, payload: record };
  });
}

export function normalizeLanguage(value: string | undefined): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    return { ok: false, error: "language must be a two-letter ISO 639-1 code (for example EN or DE)" };
  }
  return { ok: true, value: normalized };
}

export function normalizePriceBound(
  value: number | undefined,
  name: string,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value) || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) {
    return { ok: false, error: `${name} must be a non-negative number with at most two decimals` };
  }
  return { ok: true, value: String(value) };
}

export function checkPriceOrder(lowPrice: number | undefined, highPrice: number | undefined): string | null {
  if (lowPrice !== undefined && highPrice !== undefined && lowPrice > highPrice) {
    return "low_price must not exceed high_price";
  }
  return null;
}

export function normalizeScrapeDoDelivery(value: unknown): ScrapeDoDelivery | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    price: normalizeMoney(record.price),
    isFree: firstBoolean(record.isFree, record.is_free),
    date: firstString(record.date),
    fastestDate: firstString(record.fastestDate, record.fastest_date),
    rawText: firstString(record.rawText, record.raw_text, record.text),
  };
}

export function formatDelivery(delivery: ScrapeDoDelivery | null): string | null {
  if (!delivery) return null;
  if (delivery.rawText) return delivery.rawText;
  const parts: string[] = [];
  if (delivery.isFree === true) parts.push("Free");
  else if (delivery.price) parts.push(formatMoney(delivery.price));
  if (delivery.date) parts.push(delivery.date);
  if (delivery.fastestDate) parts.push(`fastest ${delivery.fastestDate}`);
  return parts.length > 0 ? parts.join(" | ") : null;
}

export function normalizeScrapeDoSearchItem(value: unknown): ScrapeDoSearchItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const rating = asRecord(record.rating);
  const structuredRatingsTotal = firstNumber(rating?.count, record.total_ratings);
  const displayRatingsTotal = parseCompactCount(record.reviewCount);
  const currency = firstString(asRecord(record.price)?.currencyCode);
  return {
    position: firstNumber(record.position),
    rank: firstNumber(record.rank),
    title: firstString(record.title, record.name) || "Untitled Amazon result",
    asin: firstString(record.asin),
    link: firstString(record.url),
    imageUrl: firstString(record.imageUrl, record.thumbnail),
    price: normalizeMoney(record.price, currency),
    priceBeforeDeal: normalizeMoney(record.price_before_deal, currency),
    rating: firstNumber(record.rating, rating?.value),
    ratingsTotal:
      structuredRatingsTotal !== null && structuredRatingsTotal > 0
        ? structuredRatingsTotal
        : (displayRatingsTotal ?? structuredRatingsTotal),
    reviewCountLabel: firstString(record.reviewCount),
    badge: firstString(record.badge),
    isPrime: firstBoolean(record.isPrime, record.is_prime),
    sponsored: firstBoolean(record.isSponsored, record.is_sponsored),
    salesVolume: firstString(record.sales_volume),
    delivery: normalizeScrapeDoDelivery(record.delivery),
  };
}

export function normalizeScrapeDoSearchItems(value: unknown): ScrapeDoSearchItem[] {
  return asArray(value)
    .map(normalizeScrapeDoSearchItem)
    .filter((item): item is ScrapeDoSearchItem => item !== null);
}

export function normalizeScrapeDoFilterGroups(value: unknown): ScrapeDoFilterGroup[] {
  return asArray(value)
    .map((entry): ScrapeDoFilterGroup | null => {
      const record = asRecord(entry);
      if (!record) return null;
      const name = firstString(record.name, record.title, record.label, record.group);
      const options = asArray(record.options ?? record.values ?? record.items)
        .map((option) => {
          const optionRecord = asRecord(option);
          if (!optionRecord) return null;
          const label = firstString(
            optionRecord.name,
            optionRecord.label,
            optionRecord.text,
            optionRecord.title,
            optionRecord.value,
          );
          if (!label) return null;
          return { label, rh: firstString(optionRecord.rh) };
        })
        .filter((option): option is { label: string; rh: string | null } => option !== null);
      if (!name && options.length === 0) return null;
      return { name: name || "Filter", options };
    })
    .filter((group): group is ScrapeDoFilterGroup => group !== null);
}

export function normalizeScrapeDoCategories(value: unknown): ScrapeDoCategory[] {
  return asArray(value)
    .map((entry): ScrapeDoCategory | null => {
      if (typeof entry === "string") {
        const name = normalizeWhitespace(entry);
        return name ? { name, node: null } : null;
      }
      const record = asRecord(entry);
      if (!record) return null;
      const name = firstString(record.name, record.title, record.label, record.text);
      if (!name) return null;
      return { name, node: firstString(record.node, record.node_id, record.id) };
    })
    .filter((category): category is ScrapeDoCategory => category !== null);
}

export function normalizeRelatedSearches(value: unknown): string[] {
  return uniqStrings(
    asArray(value).map((entry) => {
      if (typeof entry === "string") return entry;
      const record = asRecord(entry);
      return firstString(record?.text, record?.keyword, record?.query, record?.title);
    }),
  );
}

export function recordToSummaryLines(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record)
    .map(([key, item]) => {
      const direct = scalarText(item);
      if (direct) return `${key}: ${direct}`;
      const items = uniqStrings(asArray(item).map((entry) => scalarText(entry)));
      return items.length > 0 ? `${key}: ${items.join(", ")}` : null;
    })
    .filter((item): item is string => item !== null);
}

export function normalizeScrapeDoProduct(payload: Record<string, unknown>): ScrapeDoProduct {
  const technicalDetails = recordToSummaryLines(payload.technical_details).slice(0, 8);
  const bestSellerRankings = asArray(payload.best_seller_rankings)
    .map((value) => {
      const record = asRecord(value);
      if (!record) return null;
      const category = firstString(record.category);
      const rank = firstNumber(record.rank);
      return !category || rank === null ? null : `${category}: #${rank}`;
    })
    .filter((item): item is string => item !== null);
  const shippingInfo = uniqStrings(asArray(payload.shipping_info).map((item) => firstString(item))).slice(0, 6);
  const moreBuyingChoices = asRecord(payload.more_buying_choices);
  const currency = firstString(payload.currency);

  return {
    title: firstString(payload.name, payload.title) || "Untitled Amazon product",
    brand: firstString(payload.brand),
    asin: firstString(payload.asin),
    parentAsin: firstString(payload.parent_asin),
    link: firstString(payload.url),
    thumbnail: firstString(payload.thumbnail, asRecord(asArray(payload.images)[0])?.url),
    price: normalizeMoney(payload.price, currency),
    listPrice: normalizeMoney(payload.list_price, currency),
    rating: firstNumber(payload.rating),
    ratingsTotal: firstNumber(payload.total_ratings),
    isPrime: firstBoolean(payload.is_prime, payload.isPrime),
    isSponsored: firstBoolean(payload.is_sponsored),
    inStock: firstBoolean(payload.in_stock),
    availabilityText: firstString(payload.availability_text),
    badges: uniqStrings(asArray(payload.all_badges).map((item) => firstString(item))).slice(0, 6),
    amazonChoice: firstBoolean(payload.amazon_choice),
    bestSeller: firstBoolean(payload.best_seller),
    description: truncateText(firstString(payload.description), DESCRIPTION_MAX_CHARS),
    shippingInfo,
    bestSellerRankings: uniqStrings(bestSellerRankings).slice(0, 6),
    technicalDetails,
    moreBuyingChoices: moreBuyingChoices
      ? firstString(
          `${firstString(moreBuyingChoices.heading) || "More Buying Choices"}: ${firstString(moreBuyingChoices.offer_text) || "Available"}`,
        )
      : null,
  };
}

export function normalizeScrapeDoOffer(value: unknown): ScrapeDoOffer | null {
  const record = asRecord(value);
  if (!record) return null;
  const shippingTime = asRecord(record.shippingTime);
  const primeInformation = asRecord(record.primeInformation);
  const discount = asRecord(record.discount);
  return {
    condition: firstString(record.condition),
    offerHeader: firstString(record.offerHeader),
    sellerId: firstString(record.sellerId),
    merchantName: firstString(record.merchantName),
    deliveryDate: firstString(shippingTime?.deliveryDate),
    listingPrice: normalizeMoney(record.listingPrice),
    listPrice: normalizeMoney(record.listPrice),
    discountPercent: firstNumber(discount?.percentage),
    shipping: normalizeMoney(record.shipping),
    shipsFrom: firstString(record.shipsFrom),
    isFulfilledByAmazon: firstBoolean(record.isFulfilledByAmazon),
    isPrime: firstBoolean(primeInformation?.isPrime),
    isBuyBoxWinner: firstBoolean(record.isBuyBoxWinner),
    quantity: firstNumber(record.quantity),
  };
}

export function normalizeScrapeDoChart(value: unknown): ScrapeDoChartEntry[] {
  return asArray(value)
    .map((entry): ScrapeDoChartEntry | null => {
      const record = asRecord(entry);
      if (!record) return null;
      return { rank: firstNumber(record.rank), asin: firstString(record.asin), link: firstString(record.url) };
    })
    .filter((entry): entry is ScrapeDoChartEntry => entry !== null);
}

export function normalizeScrapeDoSeller(payload: Record<string, unknown>): ScrapeDoSellerProfile {
  const rating = asRecord(payload.rating);
  const details = asRecord(payload.business_details);
  const namedKeys = new Set([
    "business_name",
    "business_type",
    "trade_register_number",
    "vat_number",
    "phone_number",
    "email",
    "business_address",
    "fields",
  ]);
  const otherFields = recordToSummaryLines(details?.fields).filter((line) => {
    const key = line.slice(0, line.indexOf(":")).trim().toLowerCase().replace(/\s+/g, "_");
    return !namedKeys.has(key);
  });
  return {
    sellerId: firstString(payload.seller_id),
    name: firstString(payload.name),
    about: truncateText(firstString(payload.about), DESCRIPTION_MAX_CHARS),
    positiveFeedbackPercent: firstNumber(rating?.positive_percentage),
    businessName: firstString(details?.business_name),
    businessType: firstString(details?.business_type),
    tradeRegisterNumber: firstString(details?.trade_register_number),
    vatNumber: firstString(details?.vat_number),
    phoneNumber: firstString(details?.phone_number),
    email: firstString(details?.email),
    businessAddress: uniqStrings(asArray(details?.business_address).map((item) => firstString(item))),
    otherFields: otherFields.slice(0, 10),
  };
}

export function normalizeNexscopeReviews(payload: Record<string, unknown>): NexscopeReview[] {
  const seen = new Set<string>();
  const reviews: NexscopeReview[] = [];
  for (const entry of [...asArray(payload.data), ...asArray(payload.columns)]) {
    const record = asRecord(entry);
    if (!record) continue;
    const id = firstString(record.reviewId, record.review_id, record.id);
    const text = firstString(record.text, record.content, record.body);
    const title = firstString(record.title);
    if (!id && !text && !title) continue;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    reviews.push({
      id,
      rating: firstNumber(record.rating),
      title,
      text: truncateText(text, REVIEW_TEXT_MAX_CHARS),
      date: firstString(record.date),
      userName: firstString(record.userName, record.user_name),
      verified: firstBoolean(record.verified),
      vine: firstBoolean(record.vine),
      helpful: firstNumber(record.numberOfHelpful, record.helpful),
      imageCount: asArray(record.imageUrlList).length,
      videoCount: asArray(record.videoUrlList).length,
      variation: firstString(record.variationId),
    });
  }
  return reviews;
}

export function nexscopeReviewProductSummary(payload: Record<string, unknown>): NexscopeReviewProductSummary {
  for (const entry of [...asArray(payload.data), ...asArray(payload.columns)]) {
    const record = asRecord(entry);
    if (!record) continue;
    const title = firstString(record.productTitle);
    const rating = firstString(record.productRating);
    const ratingsCount = firstNumber(record.countRatings);
    const reviewsCount = firstNumber(record.countReviews);
    if (title || rating || ratingsCount !== null || reviewsCount !== null) {
      return { title, rating, ratingsCount, reviewsCount };
    }
  }
  return { title: null, rating: null, ratingsCount: null, reviewsCount: null };
}

export function extractAsinFromAmazonUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
    return match?.[1]?.toUpperCase() || null;
  } catch {
    return null;
  }
}

export function inferAmazonDomainFromUrl(value: string): AmazonDomain | null {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return AMAZON_DOMAIN_VALUES.find((domain) => hostname === domain || hostname.endsWith(`.${domain}`)) ?? null;
  } catch {
    return null;
  }
}

export function requireAsin(value: string): { ok: true; asin: string } | { ok: false; error: string } {
  const asin = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) return { ok: false, error: "ASIN must contain exactly 10 letters or digits" };
  return { ok: true, asin };
}

export function providerLabel(provider: CommerceProviderId): string {
  return provider === "auto" ? "Auto" : "Scrape.do";
}

export function scopeNote(): string {
  return (
    "This `commerce` surface is currently Amazon-only. " +
    "Scrape.do handles current-state search, PDP detail, offer-listing context, and `commerce_discover` (deals, Best Sellers / New Releases charts, seller profiles); " +
    "Nexscope provides retrospective trend series through `commerce_history` and review text through `commerce_reviews`."
  );
}

export function locationNote(amazonDomain: AmazonDomain): string {
  const profile = marketplaceProfile(amazonDomain);
  return profile.zipcode
    ? `Localized to ZIP ${profile.zipcode} (${profile.geocode}); prices, stock, and delivery reflect that location.`
    : `Country-level marketplace (${profile.geocode}); Scrape.do applies no ZIP localization here.`;
}

export function formatShipping(offer: ScrapeDoOffer): string | null {
  const parts: string[] = [];
  if (offer.shipping && (offer.shipping.value !== null || offer.shipping.raw || offer.shipping.currency)) {
    parts.push(`Shipping: ${formatMoney(offer.shipping)}`);
  }
  if (offer.deliveryDate) parts.push(`Delivery: ${offer.deliveryDate}`);
  return parts.length > 0 ? parts.join(" | ") : null;
}

export function pushSearchItemLines(
  lines: string[],
  result: ScrapeDoSearchItem,
  options: { readonly showRank: boolean },
): void {
  const heading = options.showRank && result.rank !== null ? `#${result.rank} ` : "";
  lines.push(`- ${heading}**${result.title}**`);
  if (result.asin) lines.push(`  - ASIN: ${result.asin}`);
  if (!options.showRank && result.position !== null) lines.push(`  - Position: ${result.position}`);
  if (result.badge) lines.push(`  - Badge: ${result.badge}`);
  if (result.price) lines.push(`  - Current price: ${formatMoney(result.price)}`);
  if (result.priceBeforeDeal) {
    lines.push(
      `  - Struck-through reference price: ${formatMoney(result.priceBeforeDeal)} | Savings vs. reference (computed locally): ${formatPercent(computedSavingsPercent(result.price, result.priceBeforeDeal))}`,
    );
  }
  lines.push(`  - Rating: ${result.rating ?? "Unavailable"} | Ratings: ${formatCount(result.ratingsTotal)}`);
  if (result.reviewCountLabel) lines.push(`  - Review count label: ${result.reviewCountLabel}`);
  if (result.salesVolume) lines.push(`  - Sales volume text: ${result.salesVolume}`);
  lines.push(`  - Prime: ${boolLabel(result.isPrime)} | Sponsored: ${boolLabel(result.sponsored)}`);
  const delivery = formatDelivery(result.delivery);
  if (delivery) lines.push(`  - Delivery: ${delivery}`);
  if (result.imageUrl) lines.push(`  - Image: ${result.imageUrl}`);
  if (result.link) lines.push(`  - URL: ${result.link}`);
}

export function pushFilterLines(lines: string[], groups: readonly ScrapeDoFilterGroup[]): void {
  if (groups.length === 0) return;
  lines.push("");
  lines.push("## Refinement Filters (pass an `rh` value back via `refinement`)");
  for (const group of groups.slice(0, 8)) {
    const options = group.options
      .slice(0, 6)
      .map((option) => (option.rh ? `${option.label} (rh=${option.rh})` : option.label));
    lines.push(`- ${group.name}: ${options.length > 0 ? options.join("; ") : "No labelled options"}`);
    if (group.options.length > 6) lines.push(`  - ${group.options.length - 6} more options omitted`);
  }
  if (groups.length > 8) lines.push(`- ${groups.length - 8} more filter groups omitted`);
}

export function pushPaginationLine(lines: string[], payload: Record<string, unknown>, page: number): void {
  const pagination = asRecord(payload.pagination);
  const hasNext = firstBoolean(pagination?.has_next);
  const currentPage = firstNumber(pagination?.current_page) ?? page;
  lines.push(
    `Page: ${currentPage} | Next page available: ${hasNext === null ? "Unknown (provider returned no pagination block)" : boolLabel(hasNext)}`,
  );
}
