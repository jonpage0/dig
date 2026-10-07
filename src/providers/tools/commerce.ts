/**
 * Commerce research tools.
 *
 * One Amazon-focused commerce surface with provider boundaries by data role:
 *   - Scrape.do for current-state search, PDP, offer-listing, deals,
 *     Best Sellers / New Releases charts, and seller profiles
 *   - Nexscope for retrospective price and marketplace event series
 *     (1-365 days) and for review text with reviewer metadata
 *
 * Provider contracts were read from the official documentation on
 * 2026-09-15:
 *   - https://scrape.do/documentation/amazon-scraper-api.md (+ search, pdp,
 *     offer-listing, deals, bestsellers, seller pages)
 *   - https://www.nexscope.ai/mcp-map/amazon-product-price-series
 *   - https://www.nexscope.ai/mcp-map/amazon-reviews-list
 *
 * Exported tool names:
 *   - commerce_search
 *   - commerce_product
 *   - commerce_history
 *   - commerce_reviews
 *   - commerce_discover
 */
import { requestJson } from "../http.js"
import { metered, outcome } from "../outcome.js"
import type { KeepRaw, SourceToolResult, ToolSpec } from "../types.js"

/** Scrape.do's own credit unit; never converted to dollars or merged with other providers' credits. */
const SCRAPE_DO_COST_UNIT = "Scrape.do credits"
/**
 * Scrape.do documents its `Scrape.do-Request-Cost` response header as the
 * authoritative charge for that request. Each captured response contributes
 * the header's nonnegative decimal value; a missing or unparseable header is
 * unknown, never a rate-card substitute.
 */
const scrapeDoMetered = (spec: ToolSpec): ToolSpec =>
  metered(spec, SCRAPE_DO_COST_UNIT, (_body, _status, headers) => {
    const value = headers?.["scrape.do-request-cost"]
    return value !== undefined && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null
  })

/**
 * Scrape.do Amazon Scraper API marketplaces. ZIP-level marketplaces carry a
 * documented example ZIP so prices and delivery are localized; country-level
 * marketplaces (Mexico included) send no location parameter because the docs
 * state that naming the marketplace's own country is unnecessary and ignored.
 */
const AMAZON_DOMAIN_VALUES = [
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
] as const

/** Nexscope amazon-product-price-series `domain` ids (11 documented markets). */
const HISTORY_DOMAIN_VALUES = [
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
] as const

/** Nexscope amazon-reviews-list `domainCode` markets (15 documented). */
const REVIEW_DOMAIN_VALUES = [
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
] as const

const COMMERCE_PROVIDER_VALUES = ["auto", "scrape-do"] as const
const COMMERCE_HISTORY_PROVIDER_VALUES = ["auto", "nexscope"] as const
const COMMERCE_REVIEW_PROVIDER_VALUES = ["auto", "nexscope"] as const
const COMMERCE_HISTORY_SERIES_VALUES = [
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
] as const
const REVIEW_SORT_VALUES = ["recent", "helpful"] as const
const DISCOVER_KIND_VALUES = ["deals", "bestsellers", "new_releases", "seller"] as const
/**
 * `commerce_discover` arguments each kind can actually send to its Scrape.do
 * route, matching the advertised schema ("Deals only", "Required for
 * bestsellers/new_releases", "Required for seller"). Anything supplied outside
 * the kind's list is rejected before the request rather than silently
 * dropped, because a dropped filter (a budget, a sort) would otherwise return
 * an unconstrained result that reads as if the filter had applied.
 */
const DISCOVER_KIND_ARGS: Record<DiscoverKind, readonly string[]> = {
  deals: ["node", "low_price", "high_price", "refinement", "sort_by", "page", "limit", "language"],
  bestsellers: ["category", "node", "page", "limit", "language"],
  new_releases: ["category", "node", "page", "limit", "language"],
  seller: ["seller", "language"],
}
/** Arguments every kind accepts. */
const DISCOVER_COMMON_ARGS: readonly string[] = ["kind", "amazon_domain", "provider"]
const DEALS_SORT_VALUES = [
  "relevance",
  "featured",
  "price_low_to_high",
  "price_high_to_low",
  "average_review",
  "most_recent",
  "newest_arrivals",
  "bestsellers",
  "bestseller_rankings",
] as const

type AmazonDomain = (typeof AMAZON_DOMAIN_VALUES)[number]
type HistoryDomain = (typeof HISTORY_DOMAIN_VALUES)[number]
type ReviewDomain = (typeof REVIEW_DOMAIN_VALUES)[number]
type CommerceProviderId = (typeof COMMERCE_PROVIDER_VALUES)[number]
type CommerceHistorySeries = (typeof COMMERCE_HISTORY_SERIES_VALUES)[number]
type ReviewSort = (typeof REVIEW_SORT_VALUES)[number]
type DiscoverKind = (typeof DISCOVER_KIND_VALUES)[number]
type DealsSort = (typeof DEALS_SORT_VALUES)[number]
type ScrapeDoEndpoint = "search" | "pdp" | "offer-listing" | "deals" | "bestsellers" | "seller"

type HistoryPoint = {
  time: string
  value: number
  carriedIntoWindow?: boolean
}

type NormalizedHistorySeries = {
  key: CommerceHistorySeries
  label: string
  detail: string | null
  points: HistoryPoint[]
}

type Money = {
  value: number | null
  currency: string | null
  raw: string | null
}

type ScrapeDoDelivery = {
  price: Money | null
  isFree: boolean | null
  date: string | null
  fastestDate: string | null
  rawText: string | null
}

type ScrapeDoSearchItem = {
  position: number | null
  rank: number | null
  title: string
  asin: string | null
  link: string | null
  imageUrl: string | null
  price: Money | null
  priceBeforeDeal: Money | null
  rating: number | null
  ratingsTotal: number | null
  reviewCountLabel: string | null
  badge: string | null
  isPrime: boolean | null
  sponsored: boolean | null
  salesVolume: string | null
  delivery: ScrapeDoDelivery | null
}

type ScrapeDoFilterGroup = {
  name: string
  options: Array<{ label: string; rh: string | null }>
}

type ScrapeDoCategory = {
  name: string
  node: string | null
}

type ScrapeDoOffer = {
  condition: string | null
  offerHeader: string | null
  sellerId: string | null
  merchantName: string | null
  deliveryDate: string | null
  listingPrice: Money | null
  listPrice: Money | null
  discountPercent: number | null
  shipping: Money | null
  shipsFrom: string | null
  isFulfilledByAmazon: boolean | null
  isPrime: boolean | null
  isBuyBoxWinner: boolean | null
  quantity: number | null
}

type ScrapeDoProduct = {
  title: string
  brand: string | null
  asin: string | null
  parentAsin: string | null
  link: string | null
  thumbnail: string | null
  price: Money | null
  listPrice: Money | null
  rating: number | null
  ratingsTotal: number | null
  isPrime: boolean | null
  isSponsored: boolean | null
  inStock: boolean | null
  availabilityText: string | null
  badges: string[]
  amazonChoice: boolean | null
  bestSeller: boolean | null
  description: string | null
  shippingInfo: string[]
  bestSellerRankings: string[]
  technicalDetails: string[]
  moreBuyingChoices: string | null
}

type ScrapeDoChartEntry = {
  rank: number | null
  asin: string | null
  link: string | null
}

type ScrapeDoSellerProfile = {
  sellerId: string | null
  name: string | null
  about: string | null
  positiveFeedbackPercent: number | null
  businessName: string | null
  businessType: string | null
  tradeRegisterNumber: string | null
  vatNumber: string | null
  phoneNumber: string | null
  email: string | null
  businessAddress: string[]
  otherFields: string[]
}

type NexscopeReview = {
  id: string | null
  rating: number | null
  title: string | null
  text: string | null
  date: string | null
  userName: string | null
  verified: boolean | null
  vine: boolean | null
  helpful: number | null
  imageCount: number
  videoCount: number
  variation: string | null
}

type NexscopeReviewProductSummary = {
  title: string | null
  rating: string | null
  ratingsCount: number | null
  reviewsCount: number | null
}

type AmazonMarketplaceProfile = {
  geocode: string
  zipcode?: string
}

const DEFAULT_AMAZON_DOMAIN: AmazonDomain = "amazon.com"
const DEFAULT_SEARCH_LIMIT = 5
const MAX_SEARCH_LIMIT = 10
const DEFAULT_DISCOVER_LIMIT = 20
const MAX_DISCOVER_LIMIT = 50
const MAX_DEALS_PAGE = 20
const MAX_BESTSELLERS_PAGE = 2
const BESTSELLERS_PAGE_SIZE = 50
const DEFAULT_TIMEOUT_MS = 60_000
const SCRAPE_DO_AMAZON_BASE = "https://api.scrape.do/plugin/amazon/"
const NEXSCOPE_PRICE_SERIES_ENDPOINT =
  "https://api.nexscope.ai/api/skill-api/v1/skills/amazon-product-price-series/run"
const NEXSCOPE_REVIEWS_ENDPOINT =
  "https://api.nexscope.ai/api/skill-api/v1/skills/amazon-reviews-list/run"
const DEFAULT_HISTORY_DAYS = 90
const MAX_HISTORY_DAYS = 365
const DEFAULT_HISTORY_MAX_POINTS = 60
const MAX_HISTORY_MAX_POINTS = 200
const DEFAULT_HISTORY_SERIES: CommerceHistorySeries[] = [
  "market_price",
  "buy_box",
  "list_price",
  "deal_price",
  "prime_price",
  "coupon_price",
]
const DEFAULT_REVIEWS_PER_STAR = 10
const MAX_REVIEWS_PER_STAR = 100
const MAX_REVIEW_KEYWORD_LENGTH = 1000
const REVIEW_TEXT_MAX_CHARS = 800
const DESCRIPTION_MAX_CHARS = 600
const REVIEW_STAR_VALUES = [1, 2, 3, 4, 5] as const

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
}

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
}

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
}

function scrapeDoApiToken(): string {
  const token =
    process.env.SCRAPE_DO_API_KEY?.trim() || process.env.SCRAPEDO_API_TOKEN?.trim()
  if (!token) {
    throw new Error("SCRAPE_DO_API_KEY not set")
  }
  return token
}

function nexscopeApiKey(): string {
  const token = process.env.NEXSCOPE_API_KEY?.trim()
  if (!token) {
    throw new Error("NEXSCOPE_API_KEY not set")
  }
  return token
}

/**
 * Provider text (error echoes, raw payload excerpts) can carry the request
 * URL or body; the Scrape.do token travels in the query string, so strip any
 * configured credential before the text reaches tool output.
 */
function redactSecrets(text: string): string {
  let redacted = text
  for (const secret of [
    process.env.SCRAPE_DO_API_KEY?.trim(),
    process.env.SCRAPEDO_API_TOKEN?.trim(),
    process.env.NEXSCOPE_API_KEY?.trim(),
  ]) {
    if (secret) redacted = redacted.split(secret).join("[redacted]")
  }
  return redacted
}

function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : "Unknown error")
}

function requireInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(Number.isFinite(max) ? `${name} must be an integer from ${min} to ${max}` : `${name} must be an integer of at least ${min}`)
  }
  return value
}

function optionalInteger(value: unknown, name: string, min: number, max: number, fallback: number): number {
  return value === undefined ? fallback : requireInteger(value, name, min, max)
}

function requireMarketplace<Domain extends string>(value: unknown, allowed: readonly Domain[], label: string): Domain {
  if (typeof value !== "string" || !allowed.includes(value as Domain)) {
    throw new Error(`amazon_domain must be one of the ${label} marketplaces: ${allowed.join(", ")}`)
  }
  return value as Domain
}

/** Requires the array the provider documents for a successful response; a 200 without it is malformed, not empty. */
function requireArray(payload: Record<string, unknown>, field: string, provider: string): unknown[] {
  const value = payload[field]
  if (!Array.isArray(value)) {
    throw new Error(`${provider} returned a response without the documented \`${field}\` array`)
  }
  return value
}

function normalizeWhitespace(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }

  const normalized = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  return normalized || null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string") {
    return normalizeWhitespace(value)
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value)
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No"
  }

  return null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = scalarText(value)
    if (normalized) {
      return normalized
    }
  }

  return null
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase()
      if (normalized === "true") return true
      if (normalized === "false") return false
    }
  }

  return null
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }

    if (typeof value === "string") {
      const cleaned = value.replace(/[^\d.-]/g, "").trim()
      if (!cleaned) {
        continue
      }

      const parsed = Number(cleaned)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }

  return null
}

function parseCompactCount(value: unknown): number | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().replace(/[(),\s]/g, "").toUpperCase()
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)([KMB])?$/)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null
  const multiplier = match[2] === "K" ? 1_000 : match[2] === "M" ? 1_000_000 : match[2] === "B" ? 1_000_000_000 : 1
  return Math.round(amount * multiplier)
}

function uniqStrings(values: Array<string | null | undefined>): string[] {
  const deduped = new Set<string>()

  for (const value of values) {
    const normalized = normalizeWhitespace(value)
    if (normalized) {
      deduped.add(normalized)
    }
  }

  return Array.from(deduped)
}

function truncateText(value: string | null, maxChars: number): string | null {
  if (!value) return null
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1).trimEnd()}…`
}

function normalizeMoney(value: unknown, fallbackCurrency?: string | null): Money | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return {
      value,
      currency: fallbackCurrency ?? null,
      raw: null,
    }
  }

  const record = asRecord(value)
  if (!record) {
    return null
  }

  return {
    value: firstNumber(record.amount, record.value, record.price),
    currency: firstString(record.currencyCode, record.currency, record.currency_symbol) ?? fallbackCurrency ?? null,
    raw: firstString(record.raw, record.formatted, record.text),
  }
}

function formatCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "JPY" ? 0 : 2,
    }).format(value)
  } catch {
    return `${value} ${currency}`
  }
}

function formatMoney(value: Money | null): string {
  if (!value) {
    return "Unavailable"
  }

  if (value.raw) {
    return value.raw
  }

  if (value.value === null) {
    return value.currency || "Unavailable"
  }

  if (value.currency) {
    return formatCurrency(value.value, value.currency)
  }

  return String(value.value)
}

function formatCount(value: number | null): string {
  if (value === null) {
    return "Unavailable"
  }

  return new Intl.NumberFormat("en-US").format(value)
}

function formatPercent(value: number | null): string {
  if (value === null) return "Unavailable"
  return `${value.toFixed(1)}%`
}

function boolLabel(value: boolean | null): string {
  if (value === null) return "Unknown"
  return value ? "Yes" : "No"
}

/** Diagnostic excerpt of a raw provider payload; redacted because the payload is provider text. */
function safeJsonSnippet(value: unknown, maxLength = 1600): string | null {
  try {
    const raw = JSON.stringify(value, null, 2)
    if (!raw) {
      return null
    }

    const serialized = redactSecrets(raw)
    return serialized.length <= maxLength
      ? serialized
      : `${serialized.slice(0, maxLength - 1).trimEnd()}…`
  } catch {
    return null
  }
}

/**
 * Savings against a struck-through reference price. Scrape.do documents that
 * Amazon renders no savings percentage on deal grids and that the caller
 * computes `(1 - price / price_before_deal) × 100`; the result is labelled as
 * locally computed wherever it is printed.
 */
function computedSavingsPercent(price: Money | null, reference: Money | null): number | null {
  const current = price?.value ?? null
  const base = reference?.value ?? null
  if (current === null || base === null || base <= 0) return null
  if (price?.currency && reference?.currency && price.currency !== reference.currency) return null
  return Math.round((1 - current / base) * 1000) / 10
}

function historyCutoffDate(days: number): string {
  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() - days)
  return cutoff.toISOString().slice(0, 10)
}

/**
 * Nexscope returns state-change events, not daily rows, and some auxiliary
 * arrays ignore the requested `days` bound. Enforce the bound locally but
 * retain the last pre-window state as a carry-in; otherwise a price unchanged
 * throughout a short window incorrectly appears to have no history.
 */
function normalizeHistoryPoints(value: unknown, days: number): HistoryPoint[] {
  const cutoff = historyCutoffDate(days)
  const allPoints = asArray(value)
    .map((entry): HistoryPoint | null => {
      const record = asRecord(entry)
      const time = firstString(record?.time)
      const rawValue = firstNumber(record?.value)
      if (!time || rawValue === null) return null
      return {
        time,
        value: Math.round(rawValue * 10_000) / 10_000,
      }
    })
    .filter((point): point is HistoryPoint => point !== null)
    .sort((a, b) => a.time.localeCompare(b.time))

  const carryIn = allPoints.filter((point) => point.time.slice(0, 10) < cutoff).at(-1)
  const points: HistoryPoint[] = []
  if (carryIn && carryIn.value >= 0) {
    points.push({ ...carryIn, carriedIntoWindow: true })
  }
  points.push(
    ...allPoints.filter((point) => point.time.slice(0, 10) >= cutoff && point.value >= 0)
  )

  const deduped: HistoryPoint[] = []
  for (const point of points) {
    const previous = deduped.at(-1)
    if (previous?.time === point.time && previous.value === point.value) continue
    deduped.push(point)
  }
  return deduped
}

function collectHistorySeries(args: {
  payload: Record<string, unknown>
  selected: ReadonlySet<CommerceHistorySeries>
  days: number
}): NormalizedHistorySeries[] {
  const direct: Array<{
    key: CommerceHistorySeries
    label: string
    field: string
  }> = [
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
  ]

  const series = direct
    .filter((entry) => args.selected.has(entry.key))
    .map((entry): NormalizedHistorySeries => ({
      key: entry.key,
      label: entry.label,
      detail: null,
      points: normalizeHistoryPoints(args.payload[entry.field], args.days),
    }))

  if (args.selected.has("sales_rank")) {
    const ranks: NormalizedHistorySeries[] = []
    for (const field of ["bsrMain", "bsrSub"]) {
      for (const entry of asArray(args.payload[field])) {
        const record = asRecord(entry)
        const category = firstString(record?.categoryName) || "Unknown category"
        ranks.push({
          key: "sales_rank",
          label: field === "bsrMain" ? "Main-category sales rank" : "Subcategory sales rank",
          detail: category,
          points: normalizeHistoryPoints(record?.points, args.days),
        })
      }
    }
    if (ranks.length === 0) {
      ranks.push({
        key: "sales_rank",
        label: "Sales rank",
        detail: null,
        points: [],
      })
    }
    series.push(...ranks)
  }

  return series
}

function sampleHistoryPoints(points: HistoryPoint[], maxPoints: number): HistoryPoint[] {
  if (points.length <= maxPoints) return points
  const sampled: HistoryPoint[] = []
  for (let index = 0; index < maxPoints; index++) {
    const sourceIndex = Math.round((index * (points.length - 1)) / (maxPoints - 1))
    const point = points[sourceIndex]
    if (point && sampled.at(-1) !== point) sampled.push(point)
  }
  return sampled
}

function historyValueLabel(key: CommerceHistorySeries, value: number, amazonDomain: HistoryDomain): string {
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
    return formatCurrency(value, HISTORY_CURRENCIES[amazonDomain])
  }
  if (key === "rating") return value.toFixed(1)
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)
}

function summarizeHistoryPoints(points: HistoryPoint[]) {
  const first = points[0]
  if (!first) return null
  let minimum = first
  let maximum = first
  for (const point of points.slice(1)) {
    if (point.value < minimum.value) minimum = point
    if (point.value > maximum.value) maximum = point
  }
  const latest = points.at(-1) ?? first
  const changePercent = first.value === 0 ? null : ((latest.value - first.value) / first.value) * 100
  return { first, latest, minimum, maximum, changePercent }
}

function nexscopeRequestBody(args: {
  asin: string
  amazonDomain: HistoryDomain
  days: number
  selected: ReadonlySet<CommerceHistorySeries>
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
  }
}

async function nexscopeRequest(
  url: string,
  body: Record<string, string | number | undefined>,
  signal: AbortSignal,
  keep: KeepRaw
): Promise<Record<string, unknown>> {
  const response = await requestJson({
    url,
    method: "POST",
    headers: {
      Authorization: `Bearer ${nexscopeApiKey()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body,
    signal,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    provider: "Nexscope",
    keep,
    label: url,
  })
  const record = asRecord(response.payload)
  if (response.status < 200 || response.status >= 300) {
    const message = firstString(record?.errmsg, record?.message, record?.msg) || "Unknown error"
    throw new Error(`${response.status}: ${message}`)
  }
  if (!record) {
    throw new Error("Nexscope returned a non-object JSON payload")
  }
  // Two failure envelopes ride on HTTP 200: the documented upstream
  // `errcode`/`errmsg` pair, and the gateway's own `code`/`msg` pair observed
  // live on 2026-09-15 as {code:13011, msg:"Not enough credits…", data:null,
  // cost:"-1", traceId:"…"}. Either one is a provider failure, never "no data".
  const errcode = firstNumber(record.errcode)
  if (errcode !== null && errcode !== 0 && errcode !== 200) {
    throw new Error(firstString(record.errmsg, record.message, record.msg) || `Nexscope returned errcode ${errcode}`)
  }
  const gatewayCode = firstNumber(record.code)
  if (gatewayCode !== null && gatewayCode !== 0 && gatewayCode !== 200) {
    const traceId = firstString(record.traceId)
    throw new Error(
      `${firstString(record.msg, record.message, record.errmsg) || "Nexscope gateway rejected the request"} (Nexscope code ${gatewayCode}${traceId ? `, traceId ${traceId}` : ""})`
    )
  }
  return record
}

async function fetchJson(url: URL, signal: AbortSignal, keep: KeepRaw, label: string): Promise<Record<string, unknown>> {
  const response = await requestJson({
    url,
    headers: { Accept: "application/json" },
    signal,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    provider: "Scrape.do",
    keep,
    label,
  })
  const record = asRecord(response.payload)

  if (response.status < 200 || response.status >= 300) {
    const message = firstString(record?.message, record?.errorMessage, record?.error) || "Unknown error"
    throw new Error(`${response.status}: ${message}`)
  }

  if (!record) {
    throw new Error("Provider returned a non-object JSON payload")
  }

  return record
}

function marketplaceProfile(amazonDomain: AmazonDomain): AmazonMarketplaceProfile {
  return AMAZON_MARKETPLACE_PROFILES[amazonDomain]
}

async function scrapeDoRequest(args: {
  endpoint: ScrapeDoEndpoint
  amazonDomain: AmazonDomain
  params: Record<string, string | number | boolean | undefined>
  signal: AbortSignal
  keep: KeepRaw
}): Promise<Record<string, unknown>> {
  const url = new URL(`${SCRAPE_DO_AMAZON_BASE}${args.endpoint}`)
  const profile = marketplaceProfile(args.amazonDomain)

  url.searchParams.set("token", scrapeDoApiToken())
  url.searchParams.set("geocode", profile.geocode)
  if (profile.zipcode) {
    url.searchParams.set("zipcode", profile.zipcode)
  }

  for (const [key, value] of Object.entries(args.params)) {
    if (value === undefined) {
      continue
    }
    url.searchParams.set(key, String(value))
  }

  const payload = await fetchJson(url, args.signal, args.keep, args.endpoint)
  const status = firstString(payload.status)?.toLowerCase()
  if (status && status !== "success") {
    throw new Error(firstString(payload.errorMessage, payload.message, payload.error) || "Scrape.do request failed")
  }

  return payload
}

/** Scrape.do requires uppercase ISO 639-1 codes and rejects unsupported ones per marketplace. */
function normalizeLanguage(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new Error("language must be a two-letter ISO 639-1 code (for example EN or DE)")
  }
  return normalized
}

/** Scrape.do validates price bounds as digits with at most two decimals and returns 400 otherwise; reject rather than silently reshape the user's filter. */
function normalizePriceBound(value: number | undefined, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) {
    throw new Error(`${name} must be a non-negative number with at most two decimals`)
  }
  return String(value)
}

function requirePriceOrder(lowPrice: number | undefined, highPrice: number | undefined): void {
  if (lowPrice !== undefined && highPrice !== undefined && lowPrice > highPrice) {
    throw new Error("low_price must not exceed high_price")
  }
}

function normalizeScrapeDoDelivery(value: unknown): ScrapeDoDelivery | null {
  const record = asRecord(value)
  if (!record) return null
  return {
    price: normalizeMoney(record.price),
    isFree: firstBoolean(record.isFree, record.is_free),
    date: firstString(record.date),
    fastestDate: firstString(record.fastestDate, record.fastest_date),
    rawText: firstString(record.rawText, record.raw_text, record.text),
  }
}

function formatDelivery(delivery: ScrapeDoDelivery | null): string | null {
  if (!delivery) return null
  if (delivery.rawText) return delivery.rawText
  const parts: string[] = []
  if (delivery.isFree === true) parts.push("Free")
  else if (delivery.price) parts.push(formatMoney(delivery.price))
  if (delivery.date) parts.push(delivery.date)
  if (delivery.fastestDate) parts.push(`fastest ${delivery.fastestDate}`)
  return parts.length > 0 ? parts.join(" | ") : null
}

function normalizeScrapeDoSearchItem(value: unknown): ScrapeDoSearchItem | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  const rating = asRecord(record.rating)
  const structuredRatingsTotal = firstNumber(rating?.count, record.total_ratings)
  const displayRatingsTotal = parseCompactCount(record.reviewCount)
  const currency = firstString(asRecord(record.price)?.currencyCode)

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
        : displayRatingsTotal ?? structuredRatingsTotal,
    reviewCountLabel: firstString(record.reviewCount),
    badge: firstString(record.badge),
    isPrime: firstBoolean(record.isPrime, record.is_prime),
    sponsored: firstBoolean(record.isSponsored, record.is_sponsored),
    salesVolume: firstString(record.sales_volume),
    delivery: normalizeScrapeDoDelivery(record.delivery),
  }
}

function normalizeScrapeDoSearchItems(value: unknown): ScrapeDoSearchItem[] {
  return asArray(value)
    .map(normalizeScrapeDoSearchItem)
    .filter((item): item is ScrapeDoSearchItem => item !== null)
}

/**
 * Scrape.do documents `filters` as left-rail groups whose options each carry an
 * `rh` refinement string, without naming the group/option keys. Read the
 * plausible label keys and keep only options that expose a label.
 */
function normalizeScrapeDoFilterGroups(value: unknown): ScrapeDoFilterGroup[] {
  return asArray(value)
    .map((entry): ScrapeDoFilterGroup | null => {
      const record = asRecord(entry)
      if (!record) return null
      const name = firstString(record.name, record.title, record.label, record.group)
      const options = asArray(record.options ?? record.values ?? record.items)
        .map((option) => {
          const optionRecord = asRecord(option)
          if (!optionRecord) return null
          const label = firstString(optionRecord.name, optionRecord.label, optionRecord.text, optionRecord.title, optionRecord.value)
          if (!label) return null
          return { label, rh: firstString(optionRecord.rh) }
        })
        .filter((option): option is { label: string; rh: string | null } => option !== null)
      if (!name && options.length === 0) return null
      return { name: name || "Filter", options }
    })
    .filter((group): group is ScrapeDoFilterGroup => group !== null)
}

function normalizeScrapeDoCategories(value: unknown): ScrapeDoCategory[] {
  return asArray(value)
    .map((entry): ScrapeDoCategory | null => {
      if (typeof entry === "string") {
        const name = normalizeWhitespace(entry)
        return name ? { name, node: null } : null
      }
      const record = asRecord(entry)
      if (!record) return null
      const name = firstString(record.name, record.title, record.label, record.text)
      if (!name) return null
      return { name, node: firstString(record.node, record.node_id, record.id) }
    })
    .filter((category): category is ScrapeDoCategory => category !== null)
}

function normalizeRelatedSearches(value: unknown): string[] {
  return uniqStrings(
    asArray(value).map((entry) => {
      if (typeof entry === "string") return entry
      const record = asRecord(entry)
      return firstString(record?.text, record?.keyword, record?.query, record?.title)
    })
  )
}

function recordToSummaryLines(value: unknown): string[] {
  const record = asRecord(value)
  if (!record) {
    return []
  }

  return Object.entries(record)
    .map(([key, item]) => {
      const direct = scalarText(item)
      if (direct) {
        return `${key}: ${direct}`
      }

      const items = uniqStrings(asArray(item).map((entry) => scalarText(entry)))
      if (items.length > 0) {
        return `${key}: ${items.join(", ")}`
      }

      return null
    })
    .filter((item): item is string => item !== null)
}

function normalizeScrapeDoProduct(payload: Record<string, unknown>): ScrapeDoProduct {
  const technicalDetails = recordToSummaryLines(payload.technical_details).slice(0, 8)
  const bestSellerRankings = asArray(payload.best_seller_rankings)
    .map((value) => {
      const record = asRecord(value)
      if (!record) {
        return null
      }

      const category = firstString(record.category)
      const rank = firstNumber(record.rank)
      if (!category || rank === null) {
        return null
      }

      return `${category}: #${rank}`
    })
    .filter((item): item is string => item !== null)

  const shippingInfo = uniqStrings(asArray(payload.shipping_info).map((item) => firstString(item))).slice(0, 6)
  const moreBuyingChoices = asRecord(payload.more_buying_choices)
  const currency = firstString(payload.currency)

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
          firstString(moreBuyingChoices.offer_text)
        )
      : null,
  }
}

function normalizeScrapeDoOffer(value: unknown): ScrapeDoOffer | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  const shippingTime = asRecord(record.shippingTime)
  const primeInformation = asRecord(record.primeInformation)
  const discount = asRecord(record.discount)

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
  }
}

function normalizeScrapeDoChart(value: unknown): ScrapeDoChartEntry[] {
  return asArray(value)
    .map((entry): ScrapeDoChartEntry | null => {
      const record = asRecord(entry)
      if (!record) return null
      return {
        rank: firstNumber(record.rank),
        asin: firstString(record.asin),
        link: firstString(record.url),
      }
    })
    .filter((entry): entry is ScrapeDoChartEntry => entry !== null)
}

function normalizeScrapeDoSeller(payload: Record<string, unknown>): ScrapeDoSellerProfile {
  const rating = asRecord(payload.rating)
  const details = asRecord(payload.business_details)
  const namedKeys = new Set([
    "business_name",
    "business_type",
    "trade_register_number",
    "vat_number",
    "phone_number",
    "email",
    "business_address",
    "fields",
  ])
  const otherFields = recordToSummaryLines(details?.fields).filter((line) => {
    const key = line.slice(0, line.indexOf(":")).trim().toLowerCase().replace(/\s+/g, "_")
    return !namedKeys.has(key)
  })

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
  }
}

/**
 * Nexscope documents the review object under `columns[]` while describing
 * `data` as "Review list"; its example carries the review inside `columns`.
 * Read both arrays, keep review-shaped records, and dedupe by review id so the
 * adapter is correct whichever array the live response populates.
 */
function normalizeNexscopeReviews(payload: Record<string, unknown>): NexscopeReview[] {
  const seen = new Set<string>()
  const reviews: NexscopeReview[] = []
  for (const entry of [...asArray(payload.data), ...asArray(payload.columns)]) {
    const record = asRecord(entry)
    if (!record) continue
    const id = firstString(record.reviewId, record.review_id, record.id)
    const text = firstString(record.text, record.content, record.body)
    const title = firstString(record.title)
    if (!id && !text && !title) continue
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
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
    })
  }
  return reviews
}

function nexscopeReviewProductSummary(payload: Record<string, unknown>): NexscopeReviewProductSummary {
  for (const entry of [...asArray(payload.data), ...asArray(payload.columns)]) {
    const record = asRecord(entry)
    if (!record) continue
    const title = firstString(record.productTitle)
    const rating = firstString(record.productRating)
    const ratingsCount = firstNumber(record.countRatings)
    const reviewsCount = firstNumber(record.countReviews)
    if (title || rating || ratingsCount !== null || reviewsCount !== null) {
      return { title, rating, ratingsCount, reviewsCount }
    }
  }
  return { title: null, rating: null, ratingsCount: null, reviewsCount: null }
}

function extractAsinFromAmazonUrl(value: string): string | null {
  try {
    const url = new URL(value)
    const match = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i)
    return match?.[1]?.toUpperCase() || null
  } catch {
    return null
  }
}

function inferAmazonDomainFromUrl(value: string): AmazonDomain | null {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    const knownDomain = AMAZON_DOMAIN_VALUES.find((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
    return knownDomain ?? null
  } catch {
    return null
  }
}

function normalizeAsin(value: string): string {
  return value.trim().toUpperCase()
}

function requireAsin(value: string): string {
  const asin = normalizeAsin(value)
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    throw new Error("ASIN must contain exactly 10 letters or digits")
  }
  return asin
}

function providerLabel(provider: CommerceProviderId): string {
  switch (provider) {
    case "auto":
      return "Auto"
    case "scrape-do":
      return "Scrape.do"
  }
}

function scopeNote(): string {
  return (
    "This `commerce` surface is currently Amazon-only. " +
    "Scrape.do handles current-state search, PDP detail, offer-listing context, and `commerce_discover` (deals, Best Sellers / New Releases charts, seller profiles); " +
    "Nexscope provides retrospective trend series through `commerce_history` and review text through `commerce_reviews`."
  )
}

function locationNote(amazonDomain: AmazonDomain): string {
  const profile = marketplaceProfile(amazonDomain)
  return profile.zipcode
    ? `Localized to ZIP ${profile.zipcode} (${profile.geocode}); prices, stock, and delivery reflect that location.`
    : `Country-level marketplace (${profile.geocode}); Scrape.do applies no ZIP localization here.`
}

function formatShipping(offer: ScrapeDoOffer): string | null {
  const parts: string[] = []

  if (offer.shipping && (offer.shipping.value !== null || offer.shipping.raw || offer.shipping.currency)) {
    parts.push(`Shipping: ${formatMoney(offer.shipping)}`)
  }

  if (offer.deliveryDate) {
    parts.push(`Delivery: ${offer.deliveryDate}`)
  }

  return parts.length > 0 ? parts.join(" | ") : null
}

function pushSearchItemLines(lines: string[], result: ScrapeDoSearchItem, options: { showRank: boolean }): void {
  const heading = options.showRank && result.rank !== null ? `#${result.rank} ` : ""
  lines.push(`- ${heading}**${result.title}**`)
  if (result.asin) lines.push(`  - ASIN: ${result.asin}`)
  if (!options.showRank && result.position !== null) lines.push(`  - Position: ${result.position}`)
  if (result.badge) lines.push(`  - Badge: ${result.badge}`)
  if (result.price) lines.push(`  - Current price: ${formatMoney(result.price)}`)
  if (result.priceBeforeDeal) {
    lines.push(
      `  - Struck-through reference price: ${formatMoney(result.priceBeforeDeal)} | Savings vs. reference (computed locally): ${formatPercent(computedSavingsPercent(result.price, result.priceBeforeDeal))}`
    )
  }
  lines.push(`  - Rating: ${result.rating ?? "Unavailable"} | Ratings: ${formatCount(result.ratingsTotal)}`)
  if (result.reviewCountLabel) lines.push(`  - Review count label: ${result.reviewCountLabel}`)
  if (result.salesVolume) lines.push(`  - Sales volume text: ${result.salesVolume}`)
  lines.push(`  - Prime: ${boolLabel(result.isPrime)} | Sponsored: ${boolLabel(result.sponsored)}`)
  const delivery = formatDelivery(result.delivery)
  if (delivery) lines.push(`  - Delivery: ${delivery}`)
  if (result.imageUrl) lines.push(`  - Image: ${result.imageUrl}`)
  if (result.link) lines.push(`  - URL: ${result.link}`)
}

function pushFilterLines(lines: string[], groups: ScrapeDoFilterGroup[]): void {
  if (groups.length === 0) return
  lines.push("")
  lines.push("## Refinement Filters (pass an `rh` value back via `refinement`)")
  for (const group of groups.slice(0, 8)) {
    const options = group.options
      .slice(0, 6)
      .map((option) => (option.rh ? `${option.label} (rh=${option.rh})` : option.label))
    lines.push(`- ${group.name}: ${options.length > 0 ? options.join("; ") : "No labelled options"}`)
    if (group.options.length > 6) lines.push(`  - ${group.options.length - 6} more options omitted`)
  }
  if (groups.length > 8) lines.push(`- ${groups.length - 8} more filter groups omitted`)
}

async function searchProducts(args: {
  query?: string
  amazonDomain: AmazonDomain
  page?: number
  seller?: string
  sort?: string
  refinement?: string
  node?: string
  lowPrice?: number
  highPrice?: number
  language?: string
  signal: AbortSignal
  keep: KeepRaw
}): Promise<Record<string, unknown>> {
  requirePriceOrder(args.lowPrice, args.highPrice)
  return scrapeDoRequest({
    endpoint: "search",
    amazonDomain: args.amazonDomain,
    params: {
      keyword: args.query,
      page: args.page ?? 1,
      seller: args.seller,
      s: args.sort,
      rh: args.refinement,
      node: args.node,
      low_price: normalizePriceBound(args.lowPrice, "low_price"),
      high_price: normalizePriceBound(args.highPrice, "high_price"),
      language: normalizeLanguage(args.language),
    },
    signal: args.signal,
    keep: args.keep,
  })
}

async function resolveProductTarget(args: {
  asin?: string
  gtin?: string
  url?: string
  amazonDomain?: unknown
  signal: AbortSignal
  keep: KeepRaw
}): Promise<{ asin: string; amazonDomain: AmazonDomain; resolutionNotes: string[] }> {
  const resolutionNotes: string[] = []
  const amazonDomain = requireMarketplace(
    args.amazonDomain ?? (args.url ? inferAmazonDomainFromUrl(args.url) : null) ?? DEFAULT_AMAZON_DOMAIN,
    AMAZON_DOMAIN_VALUES,
    "Scrape.do"
  )

  if (args.asin) {
    return {
      asin: requireAsin(args.asin),
      amazonDomain,
      resolutionNotes,
    }
  }

  if (args.url) {
    const asin = extractAsinFromAmazonUrl(args.url)
    if (!asin) {
      throw new Error("Could not extract a valid ASIN from the supplied Amazon URL")
    }

    resolutionNotes.push(`Resolved ASIN ${asin} from the supplied Amazon URL.`)
    return { asin, amazonDomain, resolutionNotes }
  }

  if (!args.gtin) {
    throw new Error("Provide at least one of: asin, gtin, or url")
  }

  const payload = await searchProducts({
    query: args.gtin,
    amazonDomain,
    page: 1,
    signal: args.signal,
    keep: args.keep,
  })

  const match = normalizeScrapeDoSearchItems(requireArray(payload, "products", "Scrape.do search")).find((item) => item.asin)

  if (!match?.asin) {
    throw new Error(`Could not resolve GTIN ${args.gtin} to an Amazon ASIN with the current Scrape.do slice`)
  }

  resolutionNotes.push(
    `Resolved GTIN ${args.gtin} to ASIN ${match.asin} using Amazon search results. Verify the match if the product family has close duplicates.`
  )

  return {
    asin: match.asin,
    amazonDomain,
    resolutionNotes,
  }
}

export const search = scrapeDoMetered({
  description:
    "Search Amazon products through the unified commerce surface. " +
    "Scrape.do performs current-state keyword, category-node, refinement, price-bounded, and seller-catalog searches with normalized result signals. " +
    "Use this to identify promising ASINs before deeper product inspection.",
  async execute(args, context) {
    const provider = args.provider ?? "auto"
    const query = normalizeWhitespace(args.query)
    const seller = normalizeWhitespace(args.seller)
    const sort = normalizeWhitespace(args.sort) ?? undefined
    const refinement = normalizeWhitespace(args.refinement) ?? undefined
    const node = normalizeWhitespace(args.node) ?? undefined

    try {
      const amazonDomain = requireMarketplace(args.amazon_domain ?? DEFAULT_AMAZON_DOMAIN, AMAZON_DOMAIN_VALUES, "Scrape.do")
      const limit = optionalInteger(args.limit, "limit", 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT)
      const page = optionalInteger(args.page, "page", 1, Number.POSITIVE_INFINITY, 1)
      if (!query && !seller) {
        throw new Error("Provide a query, a seller id, or both")
      }
      const language = normalizeLanguage(args.language)

      const payload = await searchProducts({
        query: query ?? undefined,
        amazonDomain,
        page,
        seller: seller ?? undefined,
        sort,
        refinement,
        node,
        lowPrice: args.low_price,
        highPrice: args.high_price,
        language,
        signal: context.abort,
        keep: context.keep,
      })

      const allResults = normalizeScrapeDoSearchItems(requireArray(payload, "products", "Scrape.do search"))
      const results = allResults.slice(0, limit)
      const filterGroups = normalizeScrapeDoFilterGroups(payload.filters)
      const categories = normalizeScrapeDoCategories(payload.categories)
      const relatedSearches = normalizeRelatedSearches(payload.related_searches)
      const totalResultsText = firstString(payload.totalResults)
      const totalResultsExtracted = firstNumber(payload.total_results_extracted)

      const lines: string[] = []
      lines.push("# Commerce Search")
      lines.push("")
      if (query) lines.push(`Query: ${query}`)
      if (seller) lines.push(`Seller catalog: ${seller}`)
      lines.push(`Amazon domain: ${amazonDomain}`)
      lines.push(`Provider: ${providerLabel(provider === "auto" ? "scrape-do" : provider)}`)
      lines.push(`Page: ${page}`)
      const applied = [
        sort ? `sort=${sort}` : null,
        refinement ? `rh=${refinement}` : null,
        node ? `node=${node}` : null,
        args.low_price !== undefined ? `low_price=${args.low_price}` : null,
        args.high_price !== undefined ? `high_price=${args.high_price}` : null,
        language ? `language=${language}` : null,
      ].filter((entry): entry is string => entry !== null)
      if (applied.length > 0) lines.push(`Requested filters: ${applied.join(", ")}`)
      if (totalResultsText) {
        lines.push(`Amazon result count text: ${totalResultsText}`)
      }
      if (totalResultsExtracted !== null) {
        lines.push(`Largest integer parsed from that text by the provider: ${formatCount(totalResultsExtracted)}`)
      }
      lines.push(`Normalized results: ${results.length}${allResults.length > results.length ? ` (of ${allResults.length} on this page)` : ""}`)
      lines.push(locationNote(amazonDomain))
      lines.push("")
      lines.push(scopeNote())
      lines.push("")

      if (results.length === 0) {
        lines.push("No normalized Amazon search results were extracted for this query.")
        const excerpt = safeJsonSnippet(payload)
        if (excerpt) {
          lines.push("")
          lines.push("## Raw Response Excerpt")
          lines.push("```json")
          lines.push(excerpt)
          lines.push("```")
        }
        return lines.join("\n")
      }

      lines.push("## Results")
      for (const result of results) {
        pushSearchItemLines(lines, result, { showRank: false })
      }

      pushFilterLines(lines, filterGroups)

      if (categories.length > 0) {
        lines.push("")
        lines.push("## Department Picker (pass `node` back to scope a search)")
        for (const category of categories.slice(0, 10)) {
          lines.push(`- ${category.name}${category.node ? ` (node=${category.node})` : ""}`)
        }
        if (categories.length > 10) lines.push(`- ${categories.length - 10} more departments omitted`)
      }

      if (relatedSearches.length > 0) {
        lines.push("")
        lines.push("## Related Searches")
        lines.push(relatedSearches.slice(0, 10).join(" | "))
      }

      return lines.join("\n")
    } catch (error) {
      return `ERROR: Commerce search failed: ${errorMessage(error)}`
    }
  },
} satisfies ToolSpec)

export const product = scrapeDoMetered({
  description:
    "Inspect a specific Amazon product through the unified commerce surface. " +
    "Scrape.do PDP and offer-listing endpoints supply current-state product, stock, badge, seller, and Buy Box context. " +
    "Use this once you know an ASIN, GTIN, or Amazon product URL.",
  async execute(args, context) {
    const provider = args.provider ?? "auto"

    try {
      const target = await resolveProductTarget({
        asin: args.asin,
        gtin: args.gtin,
        url: args.url,
        amazonDomain: args.amazon_domain,
        signal: context.abort,
        keep: context.keep,
      })
      const language = normalizeLanguage(args.language)

      // Scrape.do documents a 429 "concurrent limit exceeded" error for
      // simultaneous requests, so keep the PDP and offer-listing lookups
      // sequential even though both are needed.
      const productPayload = await scrapeDoRequest({
        endpoint: "pdp",
        amazonDomain: target.amazonDomain,
        params: { asin: target.asin, language },
        signal: context.abort,
        keep: context.keep,
      })
      const offersPayload = await scrapeDoRequest({
        endpoint: "offer-listing",
        amazonDomain: target.amazonDomain,
        params: { asin: target.asin },
        signal: context.abort,
        keep: context.keep,
      })

      if (!firstString(productPayload.asin, productPayload.name, productPayload.title)) {
        throw new Error("Scrape.do returned a PDP response without the documented `asin`/`name` fields")
      }
      const product = normalizeScrapeDoProduct(productPayload)
      const offers = requireArray(offersPayload, "offers", "Scrape.do offer-listing")
        .map(normalizeScrapeDoOffer)
        .filter((item): item is ScrapeDoOffer => item !== null)
      const buyBoxOffer = offers.find((offer) => offer.isBuyBoxWinner === true) ?? null

      const lines: string[] = []
      lines.push("# Commerce Product")
      lines.push("")
      lines.push(`Provider: ${providerLabel(provider === "auto" ? "scrape-do" : provider)}`)
      lines.push(`Amazon domain: ${target.amazonDomain}`)
      lines.push(`ASIN: ${target.asin}`)
      lines.push(locationNote(target.amazonDomain))
      lines.push("")
      lines.push(scopeNote())
      lines.push("")

      if (target.resolutionNotes.length > 0) {
        lines.push("## Resolution Notes")
        for (const note of target.resolutionNotes) {
          lines.push(`- ${note}`)
        }
        lines.push("")
      }

      lines.push("## Summary")
      lines.push(`- Title: ${product.title}`)
      if (product.brand) lines.push(`- Brand: ${product.brand}`)
      if (product.asin) lines.push(`- ASIN: ${product.asin}`)
      if (product.parentAsin) {
        lines.push(
          `- Parent ASIN: ${product.parentAsin}${product.asin && product.parentAsin === product.asin ? " (no variation family)" : " (variation family; siblings share it)"}`
        )
      }
      if (product.link) lines.push(`- URL: ${product.link}`)
      if (product.thumbnail) lines.push(`- Thumbnail: ${product.thumbnail}`)
      lines.push(`- Current price: ${formatMoney(product.price)}`)
      if (product.listPrice) lines.push(`- List price: ${formatMoney(product.listPrice)}`)
      lines.push(`- Rating: ${product.rating ?? "Unavailable"} | Ratings: ${formatCount(product.ratingsTotal)}`)
      lines.push(`- Prime: ${boolLabel(product.isPrime)} | Sponsored listing: ${boolLabel(product.isSponsored)}`)
      lines.push(
        `- In stock: ${product.inStock === null ? "Unknown (page shows no stock signal)" : boolLabel(product.inStock)}${product.availabilityText ? ` | Availability text: ${product.availabilityText}` : ""}`
      )
      lines.push(`- Amazon's Choice: ${boolLabel(product.amazonChoice)} | #1 Best Seller badge: ${boolLabel(product.bestSeller)}`)
      if (product.badges.length > 0) lines.push(`- Badges shown: ${product.badges.join(" | ")}`)

      if (product.description) {
        lines.push("")
        lines.push("## Description (provider-parsed, truncated)")
        lines.push(product.description)
      }

      if (buyBoxOffer) {
        lines.push("")
        lines.push("## Buy Box / Seller Context")
        lines.push(`- Seller: ${buyBoxOffer.merchantName || "Unavailable"}`)
        if (buyBoxOffer.sellerId) lines.push(`- Seller ID: ${buyBoxOffer.sellerId} (inspect with \`commerce_discover\` kind=seller)`)
        if (buyBoxOffer.offerHeader) lines.push(`- Offer header: ${buyBoxOffer.offerHeader}`)
        if (buyBoxOffer.condition) lines.push(`- Condition: ${buyBoxOffer.condition}`)
        lines.push(`- Buy Box price: ${formatMoney(buyBoxOffer.listingPrice)}`)
        if (buyBoxOffer.listPrice) lines.push(`- Seller list price: ${formatMoney(buyBoxOffer.listPrice)}`)
        if (buyBoxOffer.discountPercent !== null) lines.push(`- Provider-reported discount: ${formatPercent(buyBoxOffer.discountPercent)}`)
        const shipping = formatShipping(buyBoxOffer)
        if (shipping) lines.push(`- ${shipping}`)
        if (buyBoxOffer.shipsFrom) lines.push(`- Ships from: ${buyBoxOffer.shipsFrom}`)
        lines.push(`- Fulfilled by Amazon: ${boolLabel(buyBoxOffer.isFulfilledByAmazon)}`)
        lines.push(`- Prime: ${boolLabel(buyBoxOffer.isPrime)}`)
        if (buyBoxOffer.quantity !== null) lines.push(`- Quantity shown: ${formatCount(buyBoxOffer.quantity)}`)
      } else if (offers.length > 0) {
        lines.push("")
        lines.push("## Seller / Offer Context")
        lines.push("- No explicit Buy Box winner flag was returned, but seller offers were available.")
      }

      if (offers.length > 0) {
        lines.push("")
        lines.push(`## Additional Offers (${Math.min(offers.length, 3)} of ${offers.length} shown)`)
        for (const offer of offers.slice(0, 3)) {
          lines.push(`- **${offer.merchantName || offer.offerHeader || "Seller offer"}**`)
          if (offer.condition) lines.push(`  - Condition: ${offer.condition}`)
          lines.push(`  - Price: ${formatMoney(offer.listingPrice)}`)
          if (offer.discountPercent !== null) lines.push(`  - Provider-reported discount: ${formatPercent(offer.discountPercent)}`)
          if (offer.sellerId) lines.push(`  - Seller ID: ${offer.sellerId}`)
          const shipping = formatShipping(offer)
          if (shipping) lines.push(`  - ${shipping}`)
          if (offer.shipsFrom) lines.push(`  - Ships from: ${offer.shipsFrom}`)
          lines.push(
            `  - Buy Box winner: ${boolLabel(offer.isBuyBoxWinner)} | Fulfilled by Amazon: ${boolLabel(offer.isFulfilledByAmazon)} | Prime: ${boolLabel(offer.isPrime)}`
          )
        }
      }

      lines.push("")
      lines.push("## Review / Demand Signal")
      lines.push(`- Aggregate rating: ${product.rating ?? "Unavailable"}`)
      lines.push(`- Ratings count: ${formatCount(product.ratingsTotal)}`)
      if (product.bestSellerRankings.length > 0) {
        lines.push(`- Best seller rankings: ${product.bestSellerRankings.join(" | ")}`)
      }
      if (product.moreBuyingChoices) {
        lines.push(`- ${product.moreBuyingChoices}`)
      }
      lines.push(
        "- Current product-page signal is aggregate-only. Use `commerce_history` for retrospective price, rank, seller-count, rating, and review-count series, and `commerce_reviews` for review text with reviewer metadata."
      )

      if (product.shippingInfo.length > 0) {
        lines.push("")
        lines.push("## Shipping Snapshot")
        for (const entry of product.shippingInfo) {
          lines.push(`- ${entry}`)
        }
      }

      if (product.technicalDetails.length > 0) {
        lines.push("")
        lines.push("## Technical Details")
        for (const detail of product.technicalDetails) {
          lines.push(`- ${detail}`)
        }
      }

      return lines.join("\n")
    } catch (error) {
      return `ERROR: Commerce product lookup failed: ${errorMessage(error)}`
    }
  },
} satisfies ToolSpec)

/**
 * Nexscope's run response reports `costToken`, documented only as token
 * consumption, not as charged credits; the call's cost stays unknown and the
 * value is shown under Nexscope's own term.
 */
export const history = {
  description:
    "Retrieve retrospective Amazon price and marketplace trend series for a known ASIN. " +
    "The active backend is Nexscope and supports event histories up to 365 days. " +
    "Use commerce_search or commerce_product first when the ASIN is unknown.",
  async execute(args, context) {
    try {
      const asin = requireAsin(args.asin)

      const amazonDomain = requireMarketplace(args.amazon_domain ?? DEFAULT_AMAZON_DOMAIN, HISTORY_DOMAIN_VALUES, "Nexscope history")
      const days = optionalInteger(args.days, "days", 1, MAX_HISTORY_DAYS, DEFAULT_HISTORY_DAYS)
      const maxPoints = optionalInteger(args.max_points, "max_points", 4, MAX_HISTORY_MAX_POINTS, DEFAULT_HISTORY_MAX_POINTS)
      const selectedValues: CommerceHistorySeries[] = args.series?.length
        ? (Array.from(new Set(args.series)) as CommerceHistorySeries[])
        : DEFAULT_HISTORY_SERIES
      const unknownSeries = selectedValues.find((entry) => !COMMERCE_HISTORY_SERIES_VALUES.includes(entry))
      if (unknownSeries !== undefined) {
        throw new Error(`series must contain only: ${COMMERCE_HISTORY_SERIES_VALUES.join(", ")} (received ${String(unknownSeries)})`)
      }
      const selected = new Set<CommerceHistorySeries>(selectedValues)
      const payload = await nexscopeRequest(
        NEXSCOPE_PRICE_SERIES_ENDPOINT,
        nexscopeRequestBody({ asin, amazonDomain, days, selected }),
        context.abort,
        context.keep
      )
      const series = collectHistorySeries({ payload, selected, days })
      const usableSeries = series.filter((entry) => entry.points.length > 0)
      const costToken = firstNumber(payload.costToken)
      const lines: string[] = [
        "# Commerce Price History",
        "",
        "Provider: Nexscope",
        `Amazon domain: ${amazonDomain}`,
        `ASIN: ${asin}`,
        `Requested window: ${days} days`,
        `Captured at: ${new Date().toISOString()}`,
        `Nexscope costToken (token consumption, not documented as charged credits): ${costToken === null ? "Not returned" : costToken}`,
        "",
        "Nexscope returns event histories rather than daily snapshots. Provider timestamps do not include a timezone; they are preserved verbatim. Unavailable `-1` values are omitted. When the last value before the requested window remained active, one carry-in event is retained to establish the window's starting state.",
        "",
        "## Series Summary",
        "| Series | Observations | First | Latest | Minimum | Maximum | Change |",
        "|---|---:|---|---|---|---|---:|",
      ]

      for (const entry of series) {
        const summary = summarizeHistoryPoints(entry.points)
        const label = `${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}`.replace(/\|/g, "\\|")
        if (!summary) {
          lines.push(`| ${label} | 0 | — | — | — | — | — |`)
          continue
        }
        const value = (point: HistoryPoint) =>
          `${historyValueLabel(entry.key, point.value, amazonDomain)} (${point.time}${point.carriedIntoWindow ? ", carry-in" : ""})`
        const change =
          summary.changePercent === null
            ? "—"
            : `${summary.changePercent >= 0 ? "+" : ""}${summary.changePercent.toFixed(1)}%`
        lines.push(
          `| ${label} | ${entry.points.length} | ${value(summary.first)} | ${value(summary.latest)} | ${value(summary.minimum)} | ${value(summary.maximum)} | ${change} |`
        )
      }

      if (usableSeries.length === 0) {
        lines.push(
          "",
          "No usable observations were returned for the selected series and requested window. This can mean the ASIN is unavailable, unsupported, or not covered by the provider."
        )
        return outcome("empty", lines.join("\n"))
      }

      for (const entry of usableSeries) {
        const sampled = sampleHistoryPoints(entry.points, maxPoints)
        lines.push(
          "",
          `## ${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}`,
          `Full observations: ${entry.points.length}. Displayed observations: ${sampled.length}.`,
          "",
          "| Provider timestamp (timezone unspecified) | Value |",
          "|---|---:|"
        )
        for (const point of sampled) {
          lines.push(
            `| ${point.time}${point.carriedIntoWindow ? " (carry-in)" : ""} | ${historyValueLabel(entry.key, point.value, amazonDomain)} |`
          )
        }
      }

      return lines.join("\n")
    } catch (error) {
      return `ERROR: Commerce history lookup failed: ${errorMessage(error)}`
    }
  },
} satisfies ToolSpec

function nexscopeReviewsRequestBody(args: {
  asin: string
  amazonDomain: ReviewDomain
  perStar: number
  stars: ReadonlySet<number>
  keyword?: string
  sort: ReviewSort
  verifiedOnly: boolean
  mediaOnly: boolean
  currentFormatOnly: boolean
}): Record<string, string | number | undefined> {
  const count = (star: number) => (args.stars.has(star) ? args.perStar : 0)
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
  }
}

export const reviews = {
  description:
    "Fetch Amazon review text with reviewer metadata for a known ASIN through Nexscope (amazon-reviews-list). " +
    "Returns per-star review samples (default 10 per star, max 100 per star) with title, text, date, verified-purchase and Vine flags, and helpful counts; " +
    "supports keyword, recent/helpful ordering, verified-only, media-only, and current-format filters across 15 marketplaces. " +
    "This is a sampled review list, not a complete review history.",
  async execute(args, context) {
    try {
      const asin = requireAsin(args.asin)
      const amazonDomain = requireMarketplace(args.amazon_domain ?? DEFAULT_AMAZON_DOMAIN, REVIEW_DOMAIN_VALUES, "Nexscope reviews")
      const perStar = optionalInteger(args.per_star_limit, "per_star_limit", 1, MAX_REVIEWS_PER_STAR, DEFAULT_REVIEWS_PER_STAR)
      if (args.stars !== undefined && !Array.isArray(args.stars)) {
        throw new Error("stars must be an array of integers from 1 to 5")
      }
      const requestedStars: unknown[] = args.stars?.length ? Array.from(new Set<unknown>(args.stars)) : [...REVIEW_STAR_VALUES]
      const stars = new Set<number>(requestedStars.map((star) => requireInteger(star, "stars", 1, 5)))
      const keyword = normalizeWhitespace(args.keyword) ?? undefined
      if (keyword && keyword.length > MAX_REVIEW_KEYWORD_LENGTH) {
        throw new Error(`keyword must be at most ${MAX_REVIEW_KEYWORD_LENGTH} characters`)
      }
      const sort: ReviewSort = args.sort ?? "recent"
      if (!REVIEW_SORT_VALUES.includes(sort)) {
        throw new Error(`sort must be one of: ${REVIEW_SORT_VALUES.join(", ")}`)
      }
      const verifiedOnly = args.verified_only === true
      const mediaOnly = args.media_only === true
      const currentFormatOnly = args.current_format_only === true

      const payload = await nexscopeRequest(
        NEXSCOPE_REVIEWS_ENDPOINT,
        nexscopeReviewsRequestBody({
          asin,
          amazonDomain,
          perStar,
          stars,
          keyword,
          sort,
          verifiedOnly,
          mediaOnly,
          currentFormatOnly,
        }),
        context.abort,
        context.keep
      )

      if (!Array.isArray(payload.data) && !Array.isArray(payload.columns)) {
        throw new Error("Nexscope returned a response without the documented `data`/`columns` review arrays")
      }
      const reviewList = normalizeNexscopeReviews(payload)
      const summary = nexscopeReviewProductSummary(payload)
      const providerTotal = firstNumber(payload.total)
      const costToken = firstNumber(payload.costToken)
      const perRating = new Map<number, number>()
      for (const review of reviewList) {
        if (review.rating === null) continue
        perRating.set(review.rating, (perRating.get(review.rating) ?? 0) + 1)
      }

      const lines: string[] = [
        "# Commerce Reviews",
        "",
        "Provider: Nexscope (amazon-reviews-list)",
        `Amazon domain: ${amazonDomain}`,
        `ASIN: ${asin}`,
        `Captured at: ${new Date().toISOString()}`,
        `Requested: ${perStar} per star for ${Array.from(stars)
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
      ]

      if (perRating.size > 0) {
        lines.push("")
        lines.push("## Returned Per Rating")
        for (const star of [...REVIEW_STAR_VALUES].reverse()) {
          const count = perRating.get(star) ?? 0
          lines.push(`- ${star} star: ${count}${stars.has(star) ? "" : " (not requested)"}`)
        }
      }

      if (reviewList.length === 0) {
        lines.push("")
        lines.push("No reviews were returned for the requested filters. This can mean the ASIN has no matching reviews, the marketplace is not covered, or the filters excluded every review.")
        const excerpt = safeJsonSnippet(payload)
        if (excerpt) {
          lines.push("")
          lines.push("## Raw Response Excerpt")
          lines.push("```json")
          lines.push(excerpt)
          lines.push("```")
        }
        return outcome("empty", lines.join("\n"))
      }

      lines.push("")
      lines.push("## Reviews")
      for (const review of reviewList) {
        const ratingLabel = review.rating === null ? "Rating unavailable" : `${review.rating} star`
        lines.push(`- **${review.title || "(untitled)"}** — ${ratingLabel}`)
        lines.push(
          `  - Date: ${review.date ?? "Unavailable"} | Reviewer: ${review.userName ?? "Unavailable"} | Verified purchase: ${boolLabel(review.verified)} | Vine: ${boolLabel(review.vine)} | Helpful votes: ${formatCount(review.helpful)}`
        )
        if (review.imageCount > 0 || review.videoCount > 0) {
          lines.push(`  - Media: ${review.imageCount} image(s), ${review.videoCount} video(s)`)
        }
        if (review.variation) lines.push(`  - Variation: ${review.variation}`)
        if (review.id) lines.push(`  - Review ID: ${review.id}`)
        lines.push(`  - Text: ${review.text ?? "Unavailable"}`)
      }

      return lines.join("\n")
    } catch (error) {
      return `ERROR: Commerce reviews lookup failed: ${errorMessage(error)}`
    }
  },
} satisfies ToolSpec

function requirePage(value: unknown, max: number, label: string): number {
  return optionalInteger(value, `${label} page`, 1, max, 1)
}

function rejectInapplicableDiscoverArgs(kind: DiscoverKind, args: Record<string, unknown>): void {
  const accepted = DISCOVER_KIND_ARGS[kind]
  const inapplicable = Object.keys(args)
    .filter((name) => args[name] !== undefined && !accepted.includes(name) && !DISCOVER_COMMON_ARGS.includes(name))
    .sort()
  if (inapplicable.length === 0) return
  const verb = inapplicable.length === 1 ? "does" : "do"
  throw new Error(
    `${inapplicable.join(", ")} ${verb} not apply to kind=${kind} and would not be sent to the provider; kind=${kind} accepts ${[...DISCOVER_COMMON_ARGS, ...accepted].join(", ")}`
  )
}

function pushPaginationLine(lines: string[], payload: Record<string, unknown>, page: number): void {
  const pagination = asRecord(payload.pagination)
  const hasNext = firstBoolean(pagination?.has_next)
  const currentPage = firstNumber(pagination?.current_page) ?? page
  lines.push(`Page: ${currentPage} | Next page available: ${hasNext === null ? "Unknown (provider returned no pagination block)" : boolLabel(hasNext)}`)
}

async function discoverDeals(args: {
  amazonDomain: AmazonDomain
  node?: string
  lowPrice?: number
  highPrice?: number
  refinement?: string
  sortBy?: DealsSort
  page: number
  limit: number
  language?: string
  signal: AbortSignal
  keep: KeepRaw
}): Promise<SourceToolResult> {
  requirePriceOrder(args.lowPrice, args.highPrice)
  const payload = await scrapeDoRequest({
    endpoint: "deals",
    amazonDomain: args.amazonDomain,
    params: {
      node: args.node,
      low_price: normalizePriceBound(args.lowPrice, "low_price"),
      high_price: normalizePriceBound(args.highPrice, "high_price"),
      rh: args.refinement,
      sort_by: args.sortBy,
      page: args.page,
      language: normalizeLanguage(args.language),
    },
    signal: args.signal,
    keep: args.keep,
  })
  const allProducts = normalizeScrapeDoSearchItems(requireArray(payload, "products", "Scrape.do deals"))
  const products = allProducts.slice(0, args.limit)
  const filterGroups = normalizeScrapeDoFilterGroups(payload.filters)

  const lines: string[] = ["# Commerce Discover — Deals", "", "Provider: Scrape.do (/plugin/amazon/deals)"]
  lines.push(`Amazon domain: ${args.amazonDomain}`)
  const applied = [
    args.node ? `node=${args.node}` : null,
    args.lowPrice !== undefined ? `low_price=${args.lowPrice}` : null,
    args.highPrice !== undefined ? `high_price=${args.highPrice}` : null,
    args.refinement ? `rh=${args.refinement}` : null,
    args.sortBy ? `sort_by=${args.sortBy}` : null,
  ].filter((entry): entry is string => entry !== null)
  lines.push(`Scope: ${applied.length > 0 ? applied.join(", ") : "whole marketplace, Amazon default order"}`)
  pushPaginationLine(lines, payload, args.page)
  lines.push(`Products on page: ${allProducts.length} | Shown: ${products.length}`)
  lines.push(`Captured at: ${new Date().toISOString()}`)
  lines.push(locationNote(args.amazonDomain))
  lines.push("")
  lines.push(
    "Deal membership turns over quickly; two requests minutes apart can differ. Amazon renders no savings percentage on deal grids, so any percentage below is computed locally from the current and struck-through prices. An empty list is a valid result when filters match nothing."
  )
  lines.push("")

  if (products.length === 0) {
    lines.push("No deal products were returned for this scope.")
    pushFilterLines(lines, filterGroups)
    return outcome("empty", lines.join("\n"))
  }

  lines.push("## Deals")
  for (const product of products) {
    pushSearchItemLines(lines, product, { showRank: false })
  }
  pushFilterLines(lines, filterGroups)
  return lines.join("\n")
}

async function discoverChart(args: {
  kind: "bestsellers" | "new_releases"
  amazonDomain: AmazonDomain
  category: string
  node?: string
  page: number
  limit: number
  language?: string
  signal: AbortSignal
  keep: KeepRaw
}): Promise<SourceToolResult> {
  const chartType = args.kind === "new_releases" ? "new-releases" : "bestsellers"
  const payload = await scrapeDoRequest({
    endpoint: "bestsellers",
    amazonDomain: args.amazonDomain,
    params: {
      category: args.category,
      type: chartType,
      node: args.node,
      page: args.page,
      language: normalizeLanguage(args.language),
    },
    signal: args.signal,
    keep: args.keep,
  })
  const ranking = normalizeScrapeDoChart(requireArray(payload, "ranking", "Scrape.do bestsellers"))
  const products = normalizeScrapeDoSearchItems(requireArray(payload, "products", "Scrape.do bestsellers"))
  const productAsins = new Set(products.map((product) => product.asin).filter((asin): asin is string => asin !== null))
  const cardlessEntries = ranking.filter((entry) => !entry.asin || !productAsins.has(entry.asin))
  const rankingCount = firstNumber(payload.ranking_count) ?? ranking.length
  const productsCount = firstNumber(payload.products_count) ?? products.length
  const firstPosition = (args.page - 1) * BESTSELLERS_PAGE_SIZE + 1
  const lastPosition = args.page * BESTSELLERS_PAGE_SIZE
  const chartLabel = args.kind === "new_releases" ? "New Releases" : "Best Sellers"

  const lines: string[] = [`# Commerce Discover — ${chartLabel}`, "", "Provider: Scrape.do (/plugin/amazon/bestsellers)"]
  lines.push(`Amazon domain: ${args.amazonDomain}`)
  lines.push(`Category slug: ${firstString(payload.category) ?? args.category}${args.node ? ` | node=${args.node}` : ""}`)
  lines.push(`Chart type: ${firstString(payload.type) ?? chartType}`)
  pushPaginationLine(lines, payload, args.page)
  lines.push(`Positions covered by this page: ${firstPosition}-${lastPosition}`)
  lines.push(`Chart entries returned: ${formatCount(rankingCount)} | Entries with full product cards: ${formatCount(productsCount)} | Cards shown: ${Math.min(products.length, args.limit)}`)
  lines.push(`Captured at: ${new Date().toISOString()}`)
  lines.push(locationNote(args.amazonDomain))
  lines.push("")
  lines.push(
    "Amazon renders full product cards for only the first 30 positions of each 50-position page; the remaining positions carry rank, ASIN, and URL only. Chart membership changes hourly. Category slugs are marketplace-specific."
  )
  lines.push("")

  if (ranking.length === 0 && products.length === 0) {
    lines.push("The provider returned an empty chart for this category and page (a successful response with no entries, not an error).")
    return outcome("empty", lines.join("\n"))
  }

  if (products.length > 0) {
    lines.push("## Ranked Products (full cards)")
    for (const product of products.slice(0, args.limit)) {
      pushSearchItemLines(lines, product, { showRank: true })
    }
    if (products.length > args.limit) lines.push(`- ${products.length - args.limit} more product cards omitted by limit`)
  }

  if (cardlessEntries.length > 0) {
    lines.push("")
    lines.push("## Remaining Chart Positions (rank and ASIN only)")
    for (const entry of cardlessEntries) {
      lines.push(`- #${entry.rank ?? "?"} ${entry.asin ?? "ASIN unavailable"}${entry.link ? ` (${entry.link})` : ""}`)
    }
  }

  return lines.join("\n")
}

async function discoverSeller(args: {
  amazonDomain: AmazonDomain
  seller: string
  language?: string
  signal: AbortSignal
  keep: KeepRaw
}): Promise<string> {
  const payload = await scrapeDoRequest({
    endpoint: "seller",
    amazonDomain: args.amazonDomain,
    params: {
      seller: args.seller,
      language: normalizeLanguage(args.language),
    },
    signal: args.signal,
    keep: args.keep,
  })
  if (!firstString(payload.seller_id, payload.name)) {
    throw new Error("Scrape.do returned a seller response without the documented `seller_id`/`name` fields")
  }
  const profile = normalizeScrapeDoSeller(payload)

  const lines: string[] = ["# Commerce Discover — Seller Profile", "", "Provider: Scrape.do (/plugin/amazon/seller)"]
  lines.push(`Amazon domain: ${args.amazonDomain}`)
  lines.push(`Seller ID: ${profile.sellerId ?? args.seller}`)
  lines.push("")
  lines.push(
    "Seller profiles carry only the headline positive-feedback percentage; feedback and rating history are not included. EU marketplaces publish the trader-transparency block; other marketplaces often publish little beyond the display name, so every field below is optional."
  )
  lines.push("")
  lines.push("## Profile")
  lines.push(`- Display name: ${profile.name ?? "Unavailable"}`)
  lines.push(`- Positive feedback: ${profile.positiveFeedbackPercent === null ? "Not shown on seller page" : formatPercent(profile.positiveFeedbackPercent)}`)
  if (profile.about) lines.push(`- About (seller's own text, truncated): ${profile.about}`)
  lines.push("")
  lines.push("## Business Details")
  const details: Array<[string, string | null]> = [
    ["Business name", profile.businessName],
    ["Business type", profile.businessType],
    ["Trade register number", profile.tradeRegisterNumber],
    ["VAT number", profile.vatNumber],
    ["Phone", profile.phoneNumber],
    ["Email", profile.email],
    ["Address", profile.businessAddress.length > 0 ? profile.businessAddress.join(", ") : null],
  ]
  const present = details.filter((entry): entry is [string, string] => entry[1] !== null)
  if (present.length === 0 && profile.otherFields.length === 0) {
    lines.push("- No business details were published for this seller on this marketplace.")
  } else {
    for (const [label, value] of present) lines.push(`- ${label}: ${value}`)
    for (const line of profile.otherFields) lines.push(`- ${line}`)
  }
  lines.push("")
  lines.push("Use `commerce_search` with `seller` set to this id to list the seller's catalog.")
  return lines.join("\n")
}

export const discover = scrapeDoMetered({
  description:
    "Discover Amazon inventory beyond keyword search through Scrape.do: `deals` (discounted grid with current and struck-through prices; currently documented for amazon.com only, pages 1-20), " +
    "`bestsellers` and `new_releases` (Top 100 chart for a marketplace-specific category slug, two pages of 50 with full cards for the first 30 of each), " +
    "and `seller` (public seller profile: display name, positive-feedback percentage, published business details). " +
    "Use commerce_product for a specific ASIN and commerce_search with `seller` for a seller's catalog.",
  async execute(args, context) {
    try {
      const kind: DiscoverKind = args.kind
      if (!DISCOVER_KIND_VALUES.includes(kind)) {
        throw new Error(`kind must be one of: ${DISCOVER_KIND_VALUES.join(", ")}`)
      }
      rejectInapplicableDiscoverArgs(kind, args)
      const amazonDomain = requireMarketplace(args.amazon_domain ?? DEFAULT_AMAZON_DOMAIN, AMAZON_DOMAIN_VALUES, "Scrape.do")
      const limit = optionalInteger(args.limit, "limit", 1, MAX_DISCOVER_LIMIT, DEFAULT_DISCOVER_LIMIT)
      if (args.sort_by !== undefined && !DEALS_SORT_VALUES.includes(args.sort_by)) {
        throw new Error(`sort_by must be one of: ${DEALS_SORT_VALUES.join(", ")}`)
      }
      switch (kind) {
        case "deals":
          return await discoverDeals({
            amazonDomain,
            node: normalizeWhitespace(args.node) ?? undefined,
            lowPrice: args.low_price,
            highPrice: args.high_price,
            refinement: normalizeWhitespace(args.refinement) ?? undefined,
            sortBy: args.sort_by,
            page: requirePage(args.page, MAX_DEALS_PAGE, "Deals"),
            limit,
            language: args.language,
            signal: context.abort,
            keep: context.keep,
          })
        case "bestsellers":
        case "new_releases": {
          const category = normalizeWhitespace(args.category)
          if (!category) {
            throw new Error(`category is required for kind=${kind} (marketplace-specific chart slug, for example electronics)`)
          }
          return await discoverChart({
            kind,
            amazonDomain,
            category,
            node: normalizeWhitespace(args.node) ?? undefined,
            page: requirePage(args.page, MAX_BESTSELLERS_PAGE, "Chart"),
            limit,
            language: args.language,
            signal: context.abort,
            keep: context.keep,
          })
        }
        case "seller": {
          const seller = normalizeWhitespace(args.seller)
          if (!seller) {
            throw new Error("seller is required for kind=seller (Amazon seller id such as A2L77EE7U53NWQ)")
          }
          return await discoverSeller({
            amazonDomain,
            seller,
            language: args.language,
            signal: context.abort,
            keep: context.keep,
          })
        }
      }
    } catch (error) {
      return `ERROR: Commerce discover failed: ${errorMessage(error)}`
    }
  },
} satisfies ToolSpec)
