/**
 * TikTok advertising research tools.
 *
 * Two providers, two different datasets:
 *
 *   - TikHub's TikTok Ads API fronts TikTok's Creative Center: a curated set of
 *     top-performing ads with CTR, likes, a cost tier, industry and objective,
 *     plus per-ad analytics (CTR percentile within the industry, second-by-second
 *     retention). It is a "what works" library, not a census of what any given
 *     advertiser is running.
 *   - ScrapeCreators' TikTok Ad Library endpoint fronts TikTok's public
 *     transparency library (library.tiktok.com): what an advertiser is actually
 *     running, with first/last shown dates and an estimated audience band.
 *
 * Environment variables:
 *   - TIKHUB_API_KEY (Creative Center tools)
 *   - TIKHUB_BASE_URL (optional; defaults to https://api.tikhub.io)
 *   - SCRAPECREATORS_API_KEY (ad library tool)
 *
 * Endpoint contracts were confirmed against live responses on 2026-09-10; the
 * TikHub docs' example payload for search_ads describes a different shape than
 * the API returns, so the normalizers here follow the observed shape.
 */
import { requestJson } from "../http.js"
import { outcome } from "../outcome.js"
import type { ToolContext, ToolSpec } from "../types.js"
import { TIKTOK_AD_INDUSTRIES } from "./tiktok_ads_industries.js"
import { creditMetered, type RequestContext } from "./scrapecreators.js"

/** Read per request, so a TIKHUB_BASE_URL loaded from keys.env after startup applies. */
const tikhubBaseUrl = () => process.env.TIKHUB_BASE_URL?.trim() || "https://api.tikhub.io"
const SCRAPECREATORS_BASE_URL = "https://api.scrapecreators.com"
const TIMEOUT_MS = 60_000
const MAX_LIMIT = 50
const DEFAULT_LIMIT = 20

const PERIOD_VALUES = [7, 30, 120, 180] as const
const OBJECTIVE_CODES = {
  traffic: 1,
  app_installs: 2,
  conversion: 3,
  video_views: 4,
  reach: 5,
  lead_generation: 6,
  product_sales: 7,
} as const
const PERFORMANCE_CODES = { top_20: 1, top_40: 2, top_60: 3, top_80: 4 } as const
const AD_FORMAT_CODES = { spark: 1, non_spark: 2 } as const
const ORDER_BY_VALUES = ["for_you", "likes"] as const

type Period = (typeof PERIOD_VALUES)[number]
type Objective = keyof typeof OBJECTIVE_CODES
type Performance = keyof typeof PERFORMANCE_CODES
type AdFormat = keyof typeof AD_FORMAT_CODES
type OrderBy = (typeof ORDER_BY_VALUES)[number]

type SearchArgs = {
  keyword?: string
  industry?: string
  country_code?: string
  period?: Period
  objective?: Objective
  performance?: Performance
  order_by?: OrderBy
  ad_format?: AdFormat
  ad_language?: string
  page?: number
  limit?: number
}

type TopArgs = {
  industry?: string
  page?: number
  limit?: number
}

type DetailArgs = {
  ad_id: string
  analytics?: boolean
  similar?: boolean
}

type LibraryArgs = {
  query?: string
  advertiser_name?: string
  adv_biz_ids?: string
  cursor?: string
  limit?: number
}

type CreativeCenterAd = {
  id: string
  title: string | null
  brand: string | null
  industryId: string | null
  industry: string | null
  objective: string | null
  costTier: number | null
  ctr: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  durationSeconds: number | null
  cover: string | null
  landingPage: string | null
  countries: string[]
  highlight: string | null
}

type LibraryAd = {
  id: string
  advertiserIds: string | null
  advertiser: string | null
  url: string | null
  firstShown: string | null
  lastShown: string | null
  estimatedAudience: string | null
  spent: string | null
  impressions: number | null
  videoCount: number
  imageCount: number
  cover: string | null
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const INDUSTRY_BY_ID = new Map(TIKTOK_AD_INDUSTRIES.map((entry) => [entry.id, entry]))
const INDUSTRY_BY_NAME = new Map(TIKTOK_AD_INDUSTRIES.map((entry) => [entry.name.toLowerCase(), entry]))

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed || null
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

function fmtNum(value: number | null): string {
  if (value === null) return "n/a"
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

function fmtPercent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`
}

function fmtDate(epochMs: number | null): string | null {
  if (epochMs === null) return null
  const date = new Date(epochMs)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

function truncate(value: string | null, maxLength: number): string | null {
  if (!value) return null
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`
}

function industryName(id: string | null): string | null {
  if (!id) return null
  const entry = INDUSTRY_BY_ID.get(id)
  if (!entry) return null
  return entry.parent ? `${entry.parent} > ${entry.name}` : entry.name
}

/**
 * TikHub's recommended-ads endpoint answers only for a top-level industry id;
 * a sub-industry id returns empty data. Ads carry sub-industry codes, so
 * climb to the parent before asking for similar ads.
 */
function topLevelIndustryId(id: string | null): string | null {
  if (!id) return null
  const entry = INDUSTRY_BY_ID.get(id)
  if (!entry) return id
  if (!entry.parent) return entry.id
  return INDUSTRY_BY_NAME.get(entry.parent.toLowerCase())?.id ?? entry.id
}

/**
 * Accepts a comma-separated mix of industry ids and names and returns the
 * comma-separated id list TikHub expects. Names are matched case-insensitively
 * against the published list; an unknown name is an error rather than a silent
 * drop, because a dropped filter changes the meaning of the result.
 */
function resolveIndustryIds(input: string | undefined): { ids: string | undefined; error?: string } {
  if (!input?.trim()) return { ids: undefined }
  const ids: string[] = []
  for (const raw of input.split(",")) {
    const token = raw.trim()
    if (!token) continue
    if (/^\d{11}$/.test(token)) {
      ids.push(token)
      continue
    }
    const entry = INDUSTRY_BY_NAME.get(token.toLowerCase())
    if (!entry) {
      return {
        ids: undefined,
        error: `Unknown TikTok ad industry "${token}". Pass an 11-digit industry id or one of the published names (top level: ${TIKTOK_AD_INDUSTRIES.filter((e) => !e.parent).map((e) => e.name).join(", ")}).`,
      }
    }
    ids.push(entry.id)
  }
  return { ids: ids.length ? ids.join(",") : undefined }
}

function objectiveLabel(key: unknown): string | null {
  const value = asString(key)
  return value ? value.replace(/^campaign_objective_/, "") : null
}

function tikhubHeaders(): Record<string, string> | null {
  const token = process.env.TIKHUB_API_KEY?.trim()
  if (!token) return null
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "omp-tiktok-ads-tool/1.0",
  }
}

function scrapecreatorsHeaders(): Record<string, string> | null {
  const key = process.env.SCRAPECREATORS_API_KEY?.trim()
  if (!key) return null
  return { "x-api-key": key, Accept: "application/json", "User-Agent": "omp-tiktok-ads-tool/1.0" }
}

function redactDiagnostics(text: string): string {
  for (const name of ["TIKHUB_API_KEY", "SCRAPECREATORS_API_KEY"]) {
    const key = process.env[name]?.trim()
    if (key) text = text.replaceAll(key, "[redacted]").replaceAll(encodeURIComponent(key), "[redacted]")
  }
  return text
}

/**
 * TikHub wraps every response twice: an outer envelope `{code, data}` and an
 * inner Creative Center envelope `{code, msg, data}`. Returns the inner data or
 * a diagnostic string.
 */
async function tikhubPost(
  endpoint: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  ctx: RequestContext,
): Promise<{ data: unknown } | { error: string }> {
  const response = await requestJson({
    url: new URL(endpoint, tikhubBaseUrl()),
    method: "POST",
    headers,
    body,
    signal: ctx.abort,
    timeoutMs: TIMEOUT_MS,
    provider: "TikHub",
    keep: ctx.keep,
    label: endpoint,
  })
  const outer = asRecord(response.payload)
  if (response.status !== 200 || !outer) {
    return { error: `TikHub ${endpoint} returned HTTP ${response.status}` }
  }
  const outerCode = asNumber(outer.code)
  if (outerCode !== 200) {
    return { error: redactDiagnostics(`TikHub ${endpoint} returned code ${outerCode ?? "unknown"}: ${asString(outer.message) ?? asString(outer.detail) ?? "no message"}`) }
  }
  const inner = asRecord(outer.data)
  if (!inner) return { data: null }
  const innerCode = asNumber(inner.code)
  if (innerCode !== null && innerCode !== 0) {
    return { error: redactDiagnostics(`TikTok Creative Center returned code ${innerCode}: ${asString(inner.msg) ?? "no message"}`) }
  }
  return { data: "data" in inner ? inner.data : inner }
}

function normalizeCreativeCenterAd(raw: unknown): CreativeCenterAd | null {
  const record = asRecord(raw)
  if (!record) return null
  const id = asString(record.id)
  if (!id) return null
  const video = asRecord(record.video_info)
  const industryId = asString(record.industry_key)?.replace(/^label_/, "") ?? null
  const countries = asArray(record.country_code).map(asString).filter((value): value is string => value !== null)
  return {
    id,
    title: asString(record.ad_title),
    brand: asString(record.brand_name),
    industryId,
    industry: industryName(industryId),
    objective: objectiveLabel(record.objective_key),
    costTier: asNumber(record.cost),
    ctr: asNumber(record.ctr),
    likes: asNumber(record.like),
    comments: asNumber(record.comment),
    shares: asNumber(record.share),
    durationSeconds: asNumber(video?.duration),
    cover: asString(video?.cover),
    landingPage: asString(record.landing_page),
    countries,
    highlight: asString(record.highlight) ?? asString(record.highlight_text),
  }
}

function formatCreativeCenterAd(ad: CreativeCenterAd, index: number): string {
  const lines: string[] = []
  const title = truncate(ad.title, 160) ?? "(untitled)"
  lines.push(`${index + 1}. ${title}`)
  lines.push(`   Ad id: ${ad.id}${ad.brand ? ` | Brand: ${ad.brand}` : ""}`)
  lines.push(
    `   CTR: ${fmtPercent(ad.ctr)} | Likes: ${fmtNum(ad.likes)}` +
      (ad.comments !== null ? ` | Comments: ${fmtNum(ad.comments)}` : "") +
      (ad.shares !== null ? ` | Shares: ${fmtNum(ad.shares)}` : "") +
      (ad.costTier !== null ? ` | Cost tier: ${ad.costTier}` : "") +
      (ad.durationSeconds !== null ? ` | Duration: ${ad.durationSeconds.toFixed(0)}s` : ""),
  )
  const context: string[] = []
  if (ad.industry) context.push(`Industry: ${ad.industry}`)
  else if (ad.industryId) context.push(`Industry id: ${ad.industryId}`)
  if (ad.objective) context.push(`Objective: ${ad.objective}`)
  if (ad.countries.length) context.push(`Countries: ${ad.countries.join(", ")}`)
  if (context.length) lines.push(`   ${context.join(" | ")}`)
  if (ad.landingPage) lines.push(`   Landing page: ${ad.landingPage}`)
  if (ad.highlight) lines.push(`   Why it works (TikTok): ${truncate(ad.highlight, 240)}`)
  if (ad.cover) lines.push(`   Cover: ${ad.cover}`)
  return lines.join("\n")
}

const CREATIVE_CENTER_CAVEAT =
  "TikTok's Creative Center is a curated set of popular ads, not a census; absence here does not mean an advertiser is not running ads. CTR and likes are TikTok-reported; cost tier is TikTok's relative bucket, not spend."

// ---------------------------------------------------------------------------
// tiktok_ads_search — Creative Center search
// ---------------------------------------------------------------------------

export const search = {
  description:
    "Search TikTok's Creative Center (via TikHub) for top-performing ads by keyword, industry, country, period, objective, and performance band. " +
    "Returns ad id, title, brand, industry, objective, CTR, likes, cost tier, duration, cover, and landing page. " +
    "Requires TIKHUB_API_KEY. The Creative Center is curated, not a census. Metered per request.",
  async execute(args: SearchArgs, ctx: ToolContext) {
    const headers = tikhubHeaders()
    if (!headers) return "ERROR: TIKHUB_API_KEY not set. Get a key at https://tikhub.io"

    const industry = resolveIndustryIds(args.industry)
    if (industry.error) return `ERROR: ${industry.error}`
    if (args.period !== undefined && !PERIOD_VALUES.includes(args.period)) {
      return `ERROR: period must be one of ${PERIOD_VALUES.join(", ")} days.`
    }
    if (args.objective !== undefined && !(args.objective in OBJECTIVE_CODES)) {
      return `ERROR: objective must be one of ${Object.keys(OBJECTIVE_CODES).join(", ")}.`
    }
    if (args.performance !== undefined && !(args.performance in PERFORMANCE_CODES)) {
      return `ERROR: performance must be one of ${Object.keys(PERFORMANCE_CODES).join(", ")}.`
    }
    if (args.ad_format !== undefined && !(args.ad_format in AD_FORMAT_CODES)) {
      return `ERROR: ad_format must be one of ${Object.keys(AD_FORMAT_CODES).join(", ")}.`
    }
    if (args.order_by !== undefined && !ORDER_BY_VALUES.includes(args.order_by)) {
      return `ERROR: order_by must be one of ${ORDER_BY_VALUES.join(", ")}.`
    }

    const limit = Math.min(Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)), MAX_LIMIT)
    const page = Math.max(1, Math.floor(args.page ?? 1))
    const countryCode = (args.country_code ?? "US").trim().toUpperCase()
    const period = args.period ?? 180
    const body: Record<string, unknown> = {
      period,
      page,
      limit,
      order_by: args.order_by ?? "for_you",
      country_code: countryCode,
    }
    if (args.keyword?.trim()) body.keyword = args.keyword.trim()
    if (industry.ids) body.industry = industry.ids
    if (args.objective) body.objective = OBJECTIVE_CODES[args.objective]
    if (args.performance) body.like = PERFORMANCE_CODES[args.performance]
    if (args.ad_format) body.ad_format = AD_FORMAT_CODES[args.ad_format]
    if (args.ad_language?.trim()) body.ad_language = args.ad_language.trim()

    let result: Awaited<ReturnType<typeof tikhubPost>>
    try {
      result = await tikhubPost("/api/v1/tiktok/ads/search_ads", body, headers, ctx)
    } catch (error) {
      return `ERROR: TikTok Creative Center search failed: ${redactDiagnostics(error instanceof Error ? error.message : "Unknown error")}`
    }
    if ("error" in result) return `ERROR: ${result.error}`

    const data = asRecord(result.data)
    if (!data || !Array.isArray(data.materials)) return "ERROR: TikTok Creative Center response has no materials array; response shape unavailable, not an empty search."
    const ads = asArray(data?.materials).map(normalizeCreativeCenterAd).filter((ad): ad is CreativeCenterAd => ad !== null)
    if (data.materials.length > 0 && ads.length === 0) return "ERROR: TikTok Creative Center returned materials but none could be normalized; not an empty search."
    const pagination = asRecord(data?.pagination)
    const total = asNumber(pagination?.total_count) ?? asNumber(pagination?.total)
    const hasMore = pagination?.has_more === true

    const filters: string[] = [`country ${countryCode}`, `period ${period}d`]
    if (args.keyword?.trim()) filters.unshift(`keyword "${args.keyword.trim()}"`)
    if (industry.ids) filters.push(`industry ${industry.ids.split(",").map((id) => industryName(id) ?? id).join(" + ")}`)
    if (args.objective) filters.push(`objective ${args.objective}`)
    if (args.performance) filters.push(`performance ${args.performance}`)
    if (args.ad_format) filters.push(`format ${args.ad_format}`)
    if (args.ad_language) filters.push(`language ${args.ad_language}`)
    const header = `TikTok Creative Center search (${filters.join(", ")}; order ${body.order_by}; page ${page})`

    if (ads.length === 0) {
      return {
        status: "empty",
        text: `${header}\n\nNo ads matched. ${CREATIVE_CENTER_CAVEAT} Try fewer filters or a broader period.`,
        details: { provider: "tikhub", ads: 0, total, hasMore: false, page, cost_note: "metered TikHub request" },
      }
    }

    const text = [
      header,
      `Showing ${ads.length} of ${total ?? "?"} ads${hasMore ? "; more pages available" : ""}.`,
      "",
      ...ads.map(formatCreativeCenterAd),
      "",
      CREATIVE_CENTER_CAVEAT,
    ].join("\n")
    return { text, details: { provider: "tikhub", ads: ads.length, total, hasMore, page, ad_ids: ads.map((ad) => ad.id) } }
  },
} satisfies ToolSpec

// ---------------------------------------------------------------------------
// tiktok_ads_top — Creative Center top-ads spotlight
// ---------------------------------------------------------------------------

export const top = {
  description:
    "List TikTok's Creative Center top-ads spotlight (via TikHub): the ads TikTok itself highlights, optionally within one industry, each with TikTok's own note on why it works plus CTR, likes, and cost tier. " +
    "Requires TIKHUB_API_KEY. Metered per request.",
  async execute(args: TopArgs, ctx: ToolContext) {
    const headers = tikhubHeaders()
    if (!headers) return "ERROR: TIKHUB_API_KEY not set. Get a key at https://tikhub.io"
    const industry = resolveIndustryIds(args.industry)
    if (industry.error) return `ERROR: ${industry.error}`
    if (industry.ids?.includes(",")) return "ERROR: tiktok_ads_top accepts one industry at a time."

    const limit = Math.min(Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)), MAX_LIMIT)
    const page = Math.max(1, Math.floor(args.page ?? 1))
    const body: Record<string, unknown> = { page, limit }
    if (industry.ids) body.industry = industry.ids

    let result: Awaited<ReturnType<typeof tikhubPost>>
    try {
      result = await tikhubPost("/api/v1/tiktok/ads/get_top_ads_spotlight", body, headers, ctx)
    } catch (error) {
      return `ERROR: TikTok Creative Center spotlight failed: ${redactDiagnostics(error instanceof Error ? error.message : "Unknown error")}`
    }
    if ("error" in result) return `ERROR: ${result.error}`

    const data = asRecord(result.data)
    if (!data || !Array.isArray(data.materials)) return "ERROR: TikTok Creative Center spotlight response has no materials array; response shape unavailable, not an empty spotlight."
    const ads = asArray(data?.materials).map(normalizeCreativeCenterAd).filter((ad): ad is CreativeCenterAd => ad !== null)
    if (data.materials.length > 0 && ads.length === 0) return "ERROR: TikTok Creative Center returned spotlight materials but none could be normalized."
    const pagination = asRecord(data?.pagination)
    const total = asNumber(pagination?.total) ?? asNumber(pagination?.total_count)
    const hasMore = pagination?.has_more === true
    const scope = industry.ids ? industryName(industry.ids) ?? industry.ids : "all industries"
    const header = `TikTok Creative Center top-ads spotlight (${scope}; page ${page})`

    if (ads.length === 0) {
      return {
        status: "empty",
        text: `${header}\n\nNo spotlight ads returned. TikTok curates spotlight lists for only some industries; omit industry for the cross-industry list, or use tiktok_ads_search with an industry filter. ${CREATIVE_CENTER_CAVEAT}`,
        details: { provider: "tikhub", ads: 0, total, hasMore: false, page },
      }
    }
    const text = [
      header,
      `Showing ${ads.length} of ${total ?? "?"} spotlight ads${hasMore ? "; more pages available" : ""}. Spotlight rows carry TikTok's note but no title; call tiktok_ads_detail on an ad id for its title, objective, and landing page.`,
      "",
      ...ads.map(formatCreativeCenterAd),
      "",
      CREATIVE_CENTER_CAVEAT,
    ].join("\n")
    return { text, details: { provider: "tikhub", ads: ads.length, total, hasMore, page, ad_ids: ads.map((ad) => ad.id) } }
  },
} satisfies ToolSpec

// ---------------------------------------------------------------------------
// tiktok_ads_detail — one Creative Center ad with analytics
// ---------------------------------------------------------------------------

type Retention = { seconds: number; points: Array<{ second: number; value: number }>; highlightSeconds: number[] }

function normalizeRetention(raw: unknown): Retention | null {
  const record = asRecord(raw)
  if (!record) return null
  const points = asArray(record.analysis)
    .map((entry) => {
      const point = asRecord(entry)
      const second = asNumber(point?.second)
      const value = asNumber(point?.value)
      return second === null || value === null ? null : { second, value }
    })
    .filter((point): point is { second: number; value: number } => point !== null)
  if (points.length === 0) return null
  return {
    seconds: asNumber(record.duration) ?? points[points.length - 1]!.second + 1,
    points,
    highlightSeconds: asArray(record.highlight).map(asNumber).filter((value): value is number => value !== null),
  }
}

function formatRetention(retention: Retention): string {
  const sample = retention.points
    .filter((point) => point.second <= 30 && (point.second < 8 || point.second % 5 === 0))
    .map((point) => `${point.second}s ${fmtPercent(point.value)}`)
    .join(", ")
  const drop = retention.points.reduce<{ second: number; delta: number } | null>((worst, point, index) => {
    if (index === 0) return worst
    const delta = retention.points[index - 1]!.value - point.value
    return !worst || delta > worst.delta ? { second: point.second, delta } : worst
  }, null)
  const lines = [`   Retention curve (${retention.seconds}s, share of viewers still watching, CTR-weighted): ${sample}`]
  if (drop && drop.delta > 0) lines.push(`   Largest drop: ${fmtPercent(drop.delta)} at second ${drop.second}`)
  if (retention.highlightSeconds.length) lines.push(`   TikTok-flagged key frames: second ${retention.highlightSeconds.join(", ")}`)
  return lines.join("\n")
}

export const detail = {
  description:
    "Fetch one TikTok Creative Center ad by id (via TikHub) with its title, brand, objective, landing page, countries, CTR, likes, comments, shares, and cost tier; by default also its CTR percentile within the industry and second-by-second retention curve, and optionally TikTok's recommended similar ads. " +
    "Requires TIKHUB_API_KEY. Each analytics block is a separate metered request.",
  async execute(args: DetailArgs, ctx: ToolContext) {
    const headers = tikhubHeaders()
    if (!headers) return "ERROR: TIKHUB_API_KEY not set. Get a key at https://tikhub.io"
    const adId = args.ad_id?.trim()
    if (!adId) return "ERROR: ad_id is required."
    const withAnalytics = args.analytics ?? true
    const withSimilar = args.similar ?? false

    let detailResult: Awaited<ReturnType<typeof tikhubPost>>
    try {
      detailResult = await tikhubPost("/api/v1/tiktok/ads/get_ads_detail", { ads_id: adId }, headers, ctx)
    } catch (error) {
      return `ERROR: TikTok Creative Center detail failed: ${redactDiagnostics(error instanceof Error ? error.message : "Unknown error")}`
    }
    if ("error" in detailResult) return `ERROR: ${detailResult.error}`
    const ad = normalizeCreativeCenterAd(detailResult.data)
    if (!ad) return outcome("empty", `No Creative Center ad found for id ${adId}. Ids come from tiktok_ads_search or tiktok_ads_top; the library only covers ads TikTok has featured.`)

    const detailRecord = asRecord(detailResult.data)
    const objectives = asArray(detailRecord?.objectives)
      .map((entry) => objectiveLabel(asRecord(entry)?.label))
      .filter((value): value is string => value !== null)
    const source = asString(detailRecord?.source)
    const voiceOver = detailRecord?.voice_over === true
    const patternLabels = asArray(detailRecord?.pattern_label).map(asString).filter((value): value is string => value !== null)

    const notes: string[] = []
    let percentile: number | null = null
    let retention: Retention | null = null
    if (withAnalytics) {
      const [percentileResult, retentionResult] = await Promise.all([
        tikhubPost("/api/v1/tiktok/ads/get_ad_percentile", { material_id: adId, metric: "ctr_percentile" }, headers, ctx).catch(
          (error: unknown) => ({ error: redactDiagnostics(error instanceof Error ? error.message : "request failed") }),
        ),
        tikhubPost("/api/v1/tiktok/ads/get_ad_keyframe_analysis", { material_id: adId, metric: "retain_ctr" }, headers, ctx).catch(
          (error: unknown) => ({ error: redactDiagnostics(error instanceof Error ? error.message : "request failed") }),
        ),
      ])
      if ("error" in percentileResult) notes.push(`CTR percentile unavailable: ${percentileResult.error}`)
      else percentile = asNumber(asRecord(percentileResult.data)?.ctr_percentile)
      if ("error" in retentionResult) notes.push(`Retention curve unavailable: ${retentionResult.error}`)
      else retention = normalizeRetention(retentionResult.data)
    }

    let similar: CreativeCenterAd[] = []
    if (withSimilar && !ad.industryId) {
      // TikHub substitutes a default (Games) industry when none is sent, which
      // would return unrelated ads; say so instead of guessing.
      notes.push("Similar ads skipped: the ad carries no industry code, and TikHub would default to Games.")
    } else if (withSimilar) {
      const body: Record<string, unknown> = { material_id: adId, country_code: ad.countries[0] ?? "US", industry: topLevelIndustryId(ad.industryId) }
      const similarResult = await tikhubPost("/api/v1/tiktok/ads/get_recommended_ads", body, headers, ctx).catch(
        (error: unknown) => ({ error: redactDiagnostics(error instanceof Error ? error.message : "request failed") }),
      )
      if ("error" in similarResult) notes.push(`Similar ads unavailable: ${similarResult.error}`)
      else similar = asArray(asRecord(similarResult.data)?.materials).map(normalizeCreativeCenterAd).filter((entry): entry is CreativeCenterAd => entry !== null)
    }

    const lines: string[] = [`TikTok Creative Center ad ${ad.id}`, "", formatCreativeCenterAd(ad, 0)]
    const extra: string[] = []
    if (objectives.length > 1) extra.push(`All objectives: ${objectives.join(", ")}`)
    if (source) extra.push(`Source: ${source}`)
    if (voiceOver) extra.push("Voice-over: yes")
    if (patternLabels.length) extra.push(`Creative patterns: ${patternLabels.join(", ")}`)
    if (extra.length) lines.push(`   ${extra.join(" | ")}`)
    if (withAnalytics) {
      lines.push("")
      lines.push(percentile === null ? "   CTR percentile: unavailable" : `   CTR percentile within industry (180d): ${fmtPercent(percentile)} — beats that share of peer ads`)
      if (retention) lines.push(formatRetention(retention))
      else lines.push("   Retention curve: unavailable")
    }
    if (withSimilar) {
      lines.push("", `Similar ads (TikTok recommended, ${similar.length}):`)
      if (similar.length) lines.push(...similar.map(formatCreativeCenterAd))
      else lines.push("   none returned")
    }
    if (notes.length) lines.push("", ...notes.map((note) => `Note: ${note}`))
    lines.push("", CREATIVE_CENTER_CAVEAT)
    return {
      text: lines.join("\n"),
      details: {
        provider: "tikhub",
        ad_id: ad.id,
        ctr: ad.ctr,
        ctr_percentile: percentile,
        likes: ad.likes,
        industry: ad.industry,
        objective: ad.objective,
        similar: similar.map((entry) => entry.id),
        requests: 1 + (withAnalytics ? 2 : 0) + (withSimilar ? 1 : 0),
      },
    }
  },
} satisfies ToolSpec

// ---------------------------------------------------------------------------
// tiktok_ad_library — public Ad Library search via ScrapeCreators
// ---------------------------------------------------------------------------

function normalizeLibraryAd(raw: unknown): LibraryAd | null {
  const record = asRecord(raw)
  if (!record) return null
  const id = asString(record.id)
  if (!id) return null
  const videos = asArray(record.videos)
  const images = asArray(record.image_urls)
  const firstVideo = asRecord(videos[0])
  return {
    id,
    advertiserIds: asString(record.adv_biz_ids),
    advertiser: asString(record.name),
    url: asString(record.url) ?? `https://library.tiktok.com/ads/detail/?ad_id=${id}`,
    firstShown: fmtDate(asNumber(record.first_shown_date)),
    lastShown: fmtDate(asNumber(record.last_shown_date)),
    estimatedAudience: asString(record.estimated_audience),
    spent: asString(record.spent),
    impressions: (() => {
      const value = asNumber(record.impression)
      return value === null || value === 0 ? null : value
    })(),
    videoCount: videos.length,
    imageCount: images.length,
    cover: asString(firstVideo?.cover_img) ?? asString(images[0]),
  }
}

function formatLibraryAd(ad: LibraryAd, index: number): string {
  const lines = [`${index + 1}. ${ad.advertiser ?? "(advertiser unknown)"} — ad ${ad.id}`]
  if (ad.advertiserIds) lines.push(`   Advertiser business IDs: ${ad.advertiserIds}`)
  const run =
    ad.firstShown && ad.lastShown
      ? ad.firstShown === ad.lastShown
        ? `Shown: ${ad.firstShown}`
        : `Shown: ${ad.firstShown} → ${ad.lastShown}`
      : ad.firstShown
        ? `First shown: ${ad.firstShown}`
        : null
  const facts: string[] = []
  if (run) facts.push(run)
  if (ad.estimatedAudience) facts.push(`Audience: ${ad.estimatedAudience}`)
  if (ad.impressions !== null) facts.push(`Impressions: ${fmtNum(ad.impressions)}`)
  if (ad.spent) facts.push(`Spent: ${ad.spent}`)
  facts.push(`Media: ${ad.videoCount} video${ad.videoCount === 1 ? "" : "s"}, ${ad.imageCount} image${ad.imageCount === 1 ? "" : "s"}`)
  lines.push(`   ${facts.join(" | ")}`)
  if (ad.url) lines.push(`   Library page: ${ad.url}`)
  if (ad.cover) lines.push(`   Cover: ${ad.cover}`)
  return lines.join("\n")
}

/** Ad Library search bills ScrapeCreators credits, reported per response. */
export const library = creditMetered({
  description:
    "Search TikTok's public Ad Library (via ScrapeCreators) for the ads an advertiser is actually running: advertiser, first/last shown dates, estimated audience band, and creative media. " +
    "Search by advertiser_name (resolved to a TikTok advertiser entity when one matches) or by free-text query, not both. " +
    "Requires SCRAPECREATORS_API_KEY. 1 credit per request. No spend or targeting is disclosed for ordinary ads.",
  async execute(args: LibraryArgs, ctx: ToolContext) {
    const headers = scrapecreatorsHeaders()
    if (!headers) return "ERROR: SCRAPECREATORS_API_KEY not set. Get a key at https://scrapecreators.com"
    const advertiser = args.advertiser_name?.trim()
    const query = args.query?.trim()
    const advertiserIds = args.adv_biz_ids?.trim()
    if (args.adv_biz_ids !== undefined && (!advertiserIds || !advertiser)) return "ERROR: adv_biz_ids requires a nonempty advertiser_name and business ID; ID-only searches are unsupported."
    if (!advertiser && !query) return "ERROR: Provide advertiser_name or query."
    if (advertiser && query) return "ERROR: Provide either advertiser_name or query, not both."
    const limit = Math.min(Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)), MAX_LIMIT)

    const url = new URL("/v1/tiktok/ad-library/search", SCRAPECREATORS_BASE_URL)
    if (advertiser) url.searchParams.set("advertiser_name", advertiser)
    if (advertiserIds) url.searchParams.set("adv_biz_ids", advertiserIds)
    if (query) url.searchParams.set("query", query)
    if (args.cursor?.trim()) url.searchParams.set("cursor", args.cursor.trim())

    let payload: Record<string, unknown> | null
    let status: number
    try {
      const response = await requestJson({ url, headers, signal: ctx.abort, timeoutMs: TIMEOUT_MS, provider: "ScrapeCreators", keep: ctx.keep, label: "ad-library/search" })
      payload = asRecord(response.payload)
      status = response.status
    } catch (error) {
      return `ERROR: TikTok Ad Library search failed: ${redactDiagnostics(error instanceof Error ? error.message : "Unknown error")}`
    }
    if (status !== 200 || !payload) return `ERROR: ScrapeCreators TikTok Ad Library returned HTTP ${status}`
    if (payload.success === false) return `ERROR: ScrapeCreators TikTok Ad Library: ${redactDiagnostics(asString(payload.error) ?? asString(payload.message) ?? "request not successful")}`
    if (!Array.isArray(payload.ads)) return "ERROR: TikTok Ad Library response did not contain an ads array; response shape unavailable, not an empty search."

    const allAds = asArray(payload.ads).map(normalizeLibraryAd).filter((ad): ad is LibraryAd => ad !== null)
    if (payload.ads.length > 0 && allAds.length === 0) return "ERROR: TikTok Ad Library returned ads but none could be normalized; not an empty search."
    const ads = allAds.slice(0, limit)
    const matches = asArray(payload.advertiser_matches)
      .map((entry) => {
        const record = asRecord(entry)
        const name = asString(record?.name)
        const ids = asString(record?.ids)
        return name ? `${name}${ids ? ` (${ids})` : ""}` : null
      })
      .filter((value): value is string => value !== null)
    const resolved = asString(payload.resolved_advertiser_name)
    const total = asNumber(payload.total)
    const cursor = asString(payload.cursor)
    const hasMore = payload.has_more === true
    const credits = asNumber(payload.credits_charged)

    const header = advertiser ? `TikTok Ad Library: advertiser "${advertiser}"` : `TikTok Ad Library: query "${query}"`
    const scope: string[] = []
    if (advertiser) {
      scope.push(
        advertiserIds
          ? `Requested exact advertiser business IDs: ${advertiserIds}, with name "${advertiser}". Returned per-ad IDs remain the evidence of identity.`
          : matches.length
          ? `Resolved advertiser entity: ${matches.join("; ")}. Results are that entity's ads.`
          : `No advertiser entity matched "${advertiser}"; TikTok fell back to a name search, so results may be unrelated advertisers whose ads mention those words.`,
      )
      if (resolved && resolved !== advertiser) scope.push(`TikTok resolved the name as "${resolved}".`)
    }

    if (ads.length === 0) {
      return {
        status: "empty",
        text: [header, ...scope, "", "No ads returned. An empty library result means no public ad matched this search, not that the advertiser has never advertised."].join("\n"),
        details: { provider: "scrapecreators", ads: 0, total, hasMore, cursor, requested_adv_biz_ids: advertiserIds ?? null, entityMatched: matches.length > 0, credits_charged: credits },
      }
    }
    const text = [
      header,
      ...scope,
      ...(allAds.length < payload.ads.length ? [`Partial normalization: ${allAds.length} of ${payload.ads.length} returned ads could be read.`] : []),
      `Showing ${ads.length}${allAds.length > ads.length ? ` of ${allAds.length} on this page` : ""}${total !== null ? `; library reports ${fmtNum(total)} total` : ""}${hasMore && cursor ? "; pass cursor for the next page" : ""}.`,
      "",
      ...ads.map(formatLibraryAd),
      "",
      "Dates and audience bands are TikTok's disclosures; the library shows no spend or targeting for ordinary commercial ads.",
    ].join("\n")
    return {
      text,
      details: {
        provider: "scrapecreators",
        ads: ads.length,
        total,
        hasMore,
        cursor: hasMore ? cursor : null,
        entityMatched: matches.length > 0,
        resolved_advertiser: resolved,
        requested_adv_biz_ids: advertiserIds ?? null,
        advertiser_ids: Array.from(new Set(ads.flatMap((ad) => ad.advertiserIds ? [ad.advertiserIds] : []))),
        credits_charged: credits,
        ad_ids: ads.map((ad) => ad.id),
      },
    }
  },
} satisfies ToolSpec)
