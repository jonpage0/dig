/**
 * ScrapeCreators API tools for TikTok, Instagram, LinkedIn, and public Telegram.
 *
 * Multi-export: provides scrapecreators_tiktok, scrapecreators_instagram,
 * scrapecreators_linkedin, and scrapecreators_telegram tools, plus the shared
 * request helper that the ScrapeCreators-backed `reddit` tool reuses.
 * Requires SCRAPECREATORS_API_KEY env var. 100 free credits, then PAYG.
 *
 * Endpoint contracts follow https://docs.scrapecreators.com (read 2026-09-15):
 * - TikTok search: GET /v1/tiktok/search/keyword (date_posted, sort_by, region, cursor)
 * - TikTok transcript: GET /v1/tiktok/video/transcript (language, use_ai_as_fallback)
 * - Instagram Reels search: GET /v2/instagram/reels/search (date_posted, page 1-11).
 *   Since 2026-08-19 search results carry no view counts; views come only from
 *   GET /v1/instagram/post (include_play_count, cache_max_age), 1 credit per reel.
 * - Instagram native search: GET /v1/instagram/search (users/hashtags/places, one page, no posts)
 * - Instagram popular search: GET /v1/instagram/search/popular (cursor)
 * - Instagram transcript: GET /v2/instagram/media/transcript (cache_max_age)
 * - LinkedIn: GET /v1/linkedin/profile, /company, /company/posts (page<=7), /post,
 *   and keyword search GET /v1/linkedin/search/posts (date_posted, cursor 1-11)
 * - Telegram (public web preview only): GET /v1/telegram/channel, /channel/posts
 *   (cursor), /post (url); all accept cache_max_age
 *
 * cache_max_age (1d|3d|7d|14d|30d) is forwarded only where the endpoint documents
 * it; a cache hit returns "cached": true and credits_charged 0, a miss bills normally.
 * Metrics the provider omits stay absent: they are never rendered as 0.
 */
import { requestJson } from "../http.js"
import { metered } from "../outcome.js"
import type { ToolContext, ToolSpec } from "../types.js"

const SC_BASE = "https://api.scrapecreators.com"
const TIMEOUT_MS = 60_000
const USER_AGENT = "omp-scrapecreators-tool/2.0"

export const CACHE_MAX_AGE_VALUES = ["1d", "3d", "7d", "14d", "30d"] as const

const TIKTOK_DATE_POSTED_VALUES = ["yesterday", "this-week", "this-month", "last-3-months", "last-6-months", "all-time"] as const
const TIKTOK_SORT_VALUES = ["relevance", "most-liked", "date-posted"] as const
const INSTAGRAM_MODE_VALUES = ["reels", "native", "popular"] as const
const INSTAGRAM_DATE_POSTED_VALUES = ["last-week", "last-month", "last-year"] as const
const INSTAGRAM_MAX_PAGE = 11
const LINKEDIN_KIND_VALUES = ["profile", "company", "company_posts", "post", "search"] as const
const LINKEDIN_DATE_POSTED_VALUES = ["last-hour", "last-day", "last-week", "last-month", "last-year"] as const
const LINKEDIN_MAX_SEARCH_CURSOR = 11
const LINKEDIN_MAX_COMPANY_POSTS_PAGE = 7
const TELEGRAM_KIND_VALUES = ["channel", "posts", "post"] as const

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 40
const DEFAULT_TRANSCRIPT_LIMIT = 5
const MAX_TRANSCRIPT_LIMIT = 10
const DEFAULT_ENRICH_LIMIT = 5
const MAX_ENRICH_LIMIT = 10
const TRANSCRIPT_WORD_CAP = 500
const TIKTOK_AI_FALLBACK_CREDITS = 10
const INSTAGRAM_VIEWS_REMOVED_ON = "2026-08-19"

// ---------------------------------------------------------------------------
// Shared provider plumbing (also used by reddit.ts)
// ---------------------------------------------------------------------------

export function scrapecreatorsHeaders(): Record<string, string> | null {
  const key = process.env.SCRAPECREATORS_API_KEY?.trim()
  if (!key) return null
  return { "x-api-key": key, Accept: "application/json", "User-Agent": USER_AGENT }
}

export const MISSING_KEY_ERROR = "SCRAPECREATORS_API_KEY not set. Get a key at https://scrapecreators.com"

export type QueryParams = Record<string, string | number | boolean | undefined>
/** What a request needs from the tool call: cancellation and the raw-response capture. */
export type RequestContext = Pick<ToolContext, "abort" | "keep">

/**
 * A failed response keeps whatever JSON body the provider sent (or null when
 * there was none) so a credit tally can still ask whether it reported a charge.
 */
export type ScrapeCreatorsResponse =
  | { ok: true; payload: Record<string, unknown>; status: number }
  | { ok: false; cancelled: boolean; error: string; payload: Record<string, unknown> | null }

/** Strips the live API key out of any text that might echo it (provider messages, fetch errors). */
export function redactSecret(text: string): string {
  const key = process.env.SCRAPECREATORS_API_KEY?.trim()
  return key ? text.replaceAll(key, "[redacted]") : text
}

/** `ERROR:` text for a failed response; cancellations are named as such, never as provider failures. */
export function failText(response: { cancelled: boolean; error: string }): string {
  return response.cancelled ? `ERROR: Cancelled: ${response.error}` : `ERROR: ${response.error}`
}

/**
 * The array an endpoint documents at `key`. A missing or non-array field is an
 * unreadable payload, reported as such; only a real `[]` is a true empty result.
 */
export function expectArray(
  payload: Record<string, unknown>,
  key: string,
  label: string,
): { ok: true; items: unknown[] } | { ok: false; error: string } {
  const value = payload[key]
  if (Array.isArray(value)) return { ok: true, items: value }
  return { ok: false, error: `${label} returned an unexpected payload: \`${key}\` is ${value === undefined ? "missing" : `not an array (${typeof value})`}` }
}

/**
 * Sums `credits_charged` across responses without inventing zero for responses
 * that did not report one. Failed requests are added too: a failure body that
 * carries a charge is counted, and one without a body or charge stays unknown,
 * because nothing in the provider contract says a failed request is free.
 */
export class CreditTally {
  charged = 0
  unreported = 0
  add(payload: Record<string, unknown> | null): void {
    const credits = payload ? asNumber(payload.credits_charged) : null
    if (credits === null) this.unreported += 1
    else this.charged += credits
  }
  describe(): string {
    if (this.unreported === 0) return `Credits charged: ${this.charged}`
    return `Credits charged: ${this.charged} reported, plus ${this.unreported} request${this.unreported === 1 ? "" : "s"} that did not report a charge (total unknown)`
  }
  details(): { charged: number; unreported: number } {
    return { charged: this.charged, unreported: this.unreported }
  }
}

/** A ScrapeCreators tool's receipt cost: `credits_charged` summed over every response it received. */
export const creditMetered = (spec: ToolSpec): ToolSpec =>
  metered(spec, "credits", (body) => asNumber(asRecord(body)?.credits_charged))

/**
 * One GET against ScrapeCreators. Non-200 statuses and `success: false` bodies
 * become explicit errors carrying the provider's own message (with the key
 * redacted); an aborted signal is reported as a cancellation, not a failure.
 * Nothing is retried beyond the shared transient-status policy in http.ts.
 */
export async function scrapecreatorsRequest(
  path: string,
  params: QueryParams,
  headers: Record<string, string>,
  ctx: RequestContext,
  label: string,
): Promise<ScrapeCreatorsResponse> {
  const signal = ctx.abort
  if (signal.aborted) return { ok: false, cancelled: true, error: `${label} cancelled before the request was sent`, payload: null }
  const url = new URL(path, SC_BASE)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue
    url.searchParams.set(key, String(value))
  }
  let payload: unknown
  let status: number
  try {
    const response = await requestJson({ url, headers, signal, timeoutMs: TIMEOUT_MS, provider: "ScrapeCreators", keep: ctx.keep, label })
    payload = response.payload
    status = response.status
  } catch (error) {
    if (signal.aborted) return { ok: false, cancelled: true, error: `${label} cancelled while the request was in flight`, payload: null }
    return { ok: false, cancelled: false, error: redactSecret(`${label} request failed: ${error instanceof Error ? error.message : "Unknown error"}`), payload: null }
  }
  const record = asRecord(payload)
  const rawMessage = record ? (asString(record.error) ?? asString(record.message)) : null
  const providerMessage = rawMessage ? redactSecret(rawMessage) : null
  if (status !== 200) {
    return { ok: false, cancelled: false, error: `${label} returned HTTP ${status}${providerMessage ? `: ${providerMessage}` : ""}`, payload: record }
  }
  if (!record) return { ok: false, cancelled: false, error: `${label} returned a non-JSON or empty body`, payload: null }
  if (record.success === false) return { ok: false, cancelled: false, error: `${label}: ${providerMessage ?? "request not successful"}`, payload: record }
  return { ok: true, payload: record, status }
}

/** Credits/caching provenance for one response, as the provider reported it. */
export function provenanceLine(payload: Record<string, unknown>): string {
  const credits = asNumber(payload.credits_charged)
  if (payload.cached === true) {
    const cachedAt = asString(payload.cached_at)
    return `Served from ScrapeCreators cache${cachedAt ? ` (scraped ${cachedAt})` : ""}; credits charged: ${credits ?? "not reported"}`
  }
  return credits === null ? "Credits charged: not reported" : `Credits charged: ${credits}`
}

export function validateEnum<T extends string>(name: string, value: unknown, values: readonly T[]): string | null {
  if (value === undefined) return null
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    return `${name} must be one of ${values.join(", ")}`
  }
  return null
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), min), max)
}

export function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

export function fmtMetric(n: number | null): string {
  return n === null ? "n/a" : fmtNum(n)
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value)
  return null
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

export function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized || null
}

export function truncate(value: string | null, maxLength: number): string {
  if (!value) return ""
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 3).trimEnd()}...`
}

export function isoDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value * 1000)
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10)
    return value.length >= 10 ? value.slice(0, 10) : null
  }
  return null
}

function displayScalar(value: unknown): string | null {
  if (typeof value === "string") return cleanText(value)
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return null
}

function capWords(text: string): string {
  const words = text.split(/\s+/)
  return words.length > TRANSCRIPT_WORD_CAP ? `${words.slice(0, TRANSCRIPT_WORD_CAP).join(" ")}...` : words.join(" ")
}

function hashtagsIn(text: string): string[] {
  return (text.match(/#(\w+)/g) || []).map((h) => h.slice(1))
}

// ---------------------------------------------------------------------------
// TikTok
// ---------------------------------------------------------------------------

interface TikTokArgs {
  query: string
  date_posted?: string
  sort_by?: string
  region?: string
  cursor?: number
  limit?: number
  transcripts?: boolean
  transcript_limit?: number
  transcript_language?: string
  transcript_ai_fallback?: boolean
}

interface TikTokItem {
  id: string
  text: string
  url: string
  author: string | null
  date: string | null
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  hashtags: string[]
  durationSeconds: number | null
  transcript: string | null
  transcriptNote: string | null
}

function normalizeTikTok(raw: Record<string, unknown>): TikTokItem | null {
  const stats = asRecord(raw.statistics) ?? {}
  const authorRecord = asRecord(raw.author)
  const author = asString(authorRecord?.unique_id)
  const id = asString(raw.aweme_id) ?? (asNumber(raw.aweme_id) !== null ? String(raw.aweme_id) : null) ?? asString(raw.id)
  if (!id) return null
  const text = asString(raw.desc) ?? ""
  const shareUrl = asString(raw.share_url)?.split("?")[0] ?? null
  const url = shareUrl ?? (author ? `https://www.tiktok.com/@${author}/video/${id}` : "")
  const hashtags = asArray(raw.text_extra)
    .map((entry) => asString(asRecord(entry)?.hashtag_name))
    .filter((value): value is string => value !== null)
  const video = asRecord(raw.video)
  // Live responses (2026-09-15) carry video.duration in milliseconds.
  const durationMs = asNumber(video?.duration)
  return {
    id,
    text,
    url,
    author,
    date: isoDate(asNumber(raw.create_time)),
    views: asNumber(stats.play_count),
    likes: asNumber(stats.digg_count),
    comments: asNumber(stats.comment_count),
    shares: asNumber(stats.share_count),
    hashtags,
    durationSeconds: durationMs === null ? null : durationMs / 1000,
    transcript: null,
    transcriptNote: null,
  }
}

function cleanWebVtt(transcript: string): string {
  return transcript
    .replace(/^WEBVTT.*$/gm, "")
    .replace(/^\d{2}:\d{2}.*-->.*$/gm, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function sumAvailable(values: Array<number | null>): { total: number; counted: number } {
  let total = 0
  let counted = 0
  for (const value of values) {
    if (value === null) continue
    total += value
    counted += 1
  }
  return { total, counted }
}

/** Search TikTok videos by keyword with the provider's own date/sort/cursor controls */
export const tiktok = creditMetered({
  description:
    "Search TikTok for videos on any topic via ScrapeCreators (/v1/tiktok/search/keyword). " +
    "Requires SCRAPECREATORS_API_KEY; 1 credit per search page, 1 per transcript (10 more per video when transcript_ai_fallback is on). " +
    "Uses TikTok's real date_posted, sort_by, and cursor controls and keeps the provider's ordering; metrics TikTok omits are reported as n/a, never 0. " +
    "Best for viral trends, short-form creator takes, pop culture, consumer products.",
  async execute(args: TikTokArgs, ctx: ToolContext) {
    const headers = scrapecreatorsHeaders()
    if (!headers) return `ERROR: ${MISSING_KEY_ERROR}`
    const query = cleanText(args.query)
    if (!query) return "ERROR: query is required."
    const invalid =
      validateEnum("date_posted", args.date_posted, TIKTOK_DATE_POSTED_VALUES) ??
      validateEnum("sort_by", args.sort_by, TIKTOK_SORT_VALUES)
    if (invalid) return `ERROR: ${invalid}`
    const region = args.region?.trim().toUpperCase()
    if (region && !/^[A-Z]{2}$/.test(region)) return "ERROR: region must be a two-letter country code such as US."
    if (args.cursor !== undefined && (typeof args.cursor !== "number" || !Number.isFinite(args.cursor) || args.cursor < 0)) {
      return "ERROR: cursor must be the non-negative number returned by a previous response."
    }
    const language = args.transcript_language?.trim().toLowerCase()
    if (language && !/^[a-z]{2}$/.test(language)) return "ERROR: transcript_language must be a two-letter language code such as en."
    const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
    const fetchTranscripts = args.transcripts ?? true
    const transcriptLimit = clampInt(args.transcript_limit, DEFAULT_TRANSCRIPT_LIMIT, 0, MAX_TRANSCRIPT_LIMIT)
    const aiFallback = args.transcript_ai_fallback === true

    const search = await scrapecreatorsRequest(
      "/v1/tiktok/search/keyword",
      { query, date_posted: args.date_posted, sort_by: args.sort_by, region, cursor: args.cursor },
      headers,
      ctx,
      "ScrapeCreators TikTok search",
    )
    if (!search.ok) return failText(search)
    const listed = expectArray(search.payload, "search_item_list", "ScrapeCreators TikTok search")
    if (!listed.ok) return `ERROR: ${listed.error}`

    const seen = new Set<string>()
    let duplicates = 0
    let unreadable = 0
    const returned: TikTokItem[] = []
    for (const entry of listed.items) {
      const record = asRecord(entry)
      const raw = asRecord(record?.aweme_info) ?? record
      const item = raw ? normalizeTikTok(raw) : null
      if (!item) {
        unreadable += 1
        continue
      }
      if (seen.has(item.id)) {
        duplicates += 1
        continue
      }
      seen.add(item.id)
      returned.push(item)
    }
    // Entries without a video id are unreadable, not absent: a page made only of
    // them is a payload the adapter cannot read, never a provider-empty result.
    if (returned.length === 0 && unreadable > 0) {
      return `ERROR: ScrapeCreators TikTok search returned an unexpected payload: none of the ${unreadable} search_item_list entr${unreadable === 1 ? "y" : "ies"} carried a readable video record (missing aweme_id)`
    }
    const items = returned.slice(0, limit)
    const nextCursor = asNumber(search.payload.cursor)
    const hasMore = typeof search.payload.has_more === "boolean" ? search.payload.has_more : null
    const credits = new CreditTally()
    credits.add(search.payload)
    const filters = [
      `date_posted=${args.date_posted ?? "(TikTok default)"}`,
      `sort_by=${args.sort_by ?? "relevance (TikTok default)"}`,
      region ? `region=${region} (proxy placement, not a content filter)` : null,
      args.cursor !== undefined ? `cursor=${args.cursor}` : null,
    ].filter((value): value is string => value !== null)

    if (items.length === 0) {
      return {
        status: "empty",
        text: [
          `TikTok keyword search: "${query}"`,
          `Filters: ${filters.join(" | ")}`,
          provenanceLine(search.payload),
          "",
          "TikTok returned an empty result list for this query and filter set.",
        ].join("\n"),
        details: { provider: "scrapecreators", query, filters, returned: 0, shown: 0, cursor: nextCursor, has_more: hasMore, credits: credits.details() },
      }
    }

    let transcriptsRequested = 0
    let transcriptsFetched = 0
    const transcriptFailures: string[] = []
    if (fetchTranscripts && transcriptLimit > 0) {
      for (const item of items.slice(0, transcriptLimit)) {
        if (ctx.abort.aborted) return `ERROR: Cancelled: TikTok transcript enrichment stopped after ${transcriptsFetched} of ${transcriptsRequested} transcripts; the search page itself completed.`
        if (!item.url) {
          item.transcriptNote = "no URL to fetch a transcript for"
          continue
        }
        transcriptsRequested += 1
        const response = await scrapecreatorsRequest(
          "/v1/tiktok/video/transcript",
          { url: item.url, language, use_ai_as_fallback: aiFallback ? "true" : undefined },
          headers,
          ctx,
          "ScrapeCreators TikTok transcript",
        )
        if (!response.ok) {
          if (response.cancelled) return `ERROR: Cancelled: ${response.error} (${transcriptsFetched} transcripts fetched before cancellation)`
          credits.add(response.payload)
          item.transcriptNote = `transcript failed: ${response.error}`
          transcriptFailures.push(`${item.url}: ${response.error}`)
          continue
        }
        credits.add(response.payload)
        const rawTranscript = response.payload.transcript
        const joined = Array.isArray(rawTranscript) ? rawTranscript.filter((v): v is string => typeof v === "string").join(" ") : asString(rawTranscript)
        const cleaned = joined ? cleanWebVtt(joined) : ""
        if (cleaned) {
          item.transcript = capWords(cleaned)
          transcriptsFetched += 1
        } else {
          item.transcriptNote = aiFallback ? "no transcript returned even with AI fallback" : "no existing transcript (set transcript_ai_fallback for AI transcription)"
        }
      }
    }

    const views = sumAvailable(items.map((i) => i.views))
    const likes = sumAvailable(items.map((i) => i.likes))
    const results = items.map((item, index) => {
      const lines: string[] = []
      lines.push(`${index + 1}. ${item.author ? `@${item.author}` : "(author unknown)"} — ${truncate(cleanText(item.text), 150) || "(no caption)"}`)
      lines.push(
        `   Views: ${fmtMetric(item.views)} | Likes: ${fmtMetric(item.likes)} | Comments: ${fmtMetric(item.comments)} | Shares: ${fmtMetric(item.shares)}` +
          ` | Date: ${item.date ?? "unknown"}${item.durationSeconds !== null ? ` | Duration: ${item.durationSeconds.toFixed(1)}s` : ""}`,
      )
      if (item.url) lines.push(`   URL: ${item.url}`)
      if (item.hashtags.length > 0) lines.push(`   Tags: ${item.hashtags.map((h) => `#${h}`).join(" ")}`)
      if (item.transcript) lines.push(`   Transcript: ${item.transcript}`)
      else if (item.transcriptNote) lines.push(`   Transcript: ${item.transcriptNote}`)
      return lines.join("\n")
    })

    const header = [
      `TikTok keyword search: "${query}" (${items.length} shown of ${returned.length} unique returned${duplicates ? `; ${duplicates} duplicate${duplicates === 1 ? "" : "s"} dropped` : ""})`,
      `Filters: ${filters.join(" | ")}`,
      "Order: as returned by TikTok for the chosen sort_by; no local re-ranking.",
      nextCursor !== null
        ? `Next page: pass cursor=${nextCursor}${hasMore === false ? " (provider reports no more results)" : ""}`
        : "Next page: no cursor returned.",
      `${credits.describe()}${aiFallback ? ` (AI fallback adds up to ${TIKTOK_AI_FALLBACK_CREDITS} per video)` : ""}`,
      fetchTranscripts
        ? `Transcripts: ${transcriptsFetched} fetched of ${transcriptsRequested} requested${transcriptFailures.length ? `; ${transcriptFailures.length} failed` : ""}`
        : "Transcripts: not requested",
      views.counted > 0 || likes.counted > 0
        ? `Totals over videos reporting metrics: ${views.counted > 0 ? `${fmtNum(views.total)} views (${views.counted}/${items.length})` : "no views reported"} | ${likes.counted > 0 ? `${fmtNum(likes.total)} likes (${likes.counted}/${items.length})` : "no likes reported"}`
        : "Totals: no video reported a view or like count.",
    ]
    if (unreadable) header.push(`Unreadable entries: ${unreadable} returned entr${unreadable === 1 ? "y" : "ies"} lacked a readable video record and ${unreadable === 1 ? "was" : "were"} skipped.`)
    if (transcriptFailures.length) header.push(`Transcript failures: ${transcriptFailures.join("; ")}`)

    return {
      // Failed transcript requests leave the enrichment incomplete.
      status: transcriptFailures.length ? "partial" : "success",
      text: [header.join("\n"), ...results].join("\n\n"),
      details: {
        provider: "scrapecreators",
        query,
        filters,
        returned: returned.length,
        shown: items.length,
        duplicates_dropped: duplicates,
        unreadable,
        cursor: nextCursor,
        has_more: hasMore,
        credits: credits.details(),
        transcripts: { requested: transcriptsRequested, fetched: transcriptsFetched, failed: transcriptFailures.length, ai_fallback: aiFallback },
        video_ids: items.map((i) => i.id),
      },
    }
  },
} satisfies ToolSpec)

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

interface InstagramArgs {
  query: string
  mode?: string
  date_posted?: string
  page?: number
  cursor?: string
  limit?: number
  transcripts?: boolean
  transcript_limit?: number
  enrich_views?: boolean
  enrich_limit?: number
  cache_max_age?: string
}

interface InstagramReel {
  id: string
  shortcode: string | null
  url: string
  text: string
  author: string | null
  authorFollowers: number | null
  verified: boolean
  date: string | null
  views: number | null
  viewsSource: "post lookup" | "search result" | null
  likes: number | null
  comments: number | null
  duration: number | null
  paidPartnership: boolean
  location: string | null
  hashtags: string[]
  commentPreviews: string[]
  transcript: string | null
  transcriptNote: string | null
  viewsNote: string | null
}

function normalizeReel(raw: Record<string, unknown>): InstagramReel | null {
  const shortcode = asString(raw.shortcode) ?? asString(raw.code)
  const id = asString(raw.id) ?? asString(raw.pk) ?? shortcode
  if (!id) return null
  const captionValue = raw.caption
  const text = typeof captionValue === "string" ? captionValue : (asString(asRecord(captionValue)?.text) ?? "")
  const owner = asRecord(raw.owner) ?? asRecord(raw.user)
  const url = asString(raw.url) ?? (shortcode ? `https://www.instagram.com/reel/${shortcode}/` : "")
  const previews = asArray(raw.comments)
    .map((entry) => {
      const comment = asRecord(entry)
      const body = cleanText(comment?.text)
      const username = asString(asRecord(comment?.owner)?.username)
      return body ? `${username ? `@${username}: ` : ""}${truncate(body, 140)}` : null
    })
    .filter((value): value is string => value !== null)
    .slice(0, 2)
  return {
    id,
    shortcode,
    url,
    text,
    author: asString(owner?.username),
    authorFollowers: asNumber(owner?.follower_count),
    verified: owner?.is_verified === true,
    date: isoDate(raw.taken_at),
    views: null,
    viewsSource: null,
    likes: asNumber(raw.like_count),
    comments: asNumber(raw.comment_count),
    duration: asNumber(raw.video_duration),
    paidPartnership: raw.is_paid_partnership === true,
    location: asString(asRecord(raw.location)?.name),
    hashtags: hashtagsIn(text),
    commentPreviews: previews,
    transcript: null,
    transcriptNote: null,
    viewsNote: null,
  }
}

/**
 * One transcript lookup. Documented contract: `transcripts` is an array (one entry
 * per carousel item) or null when no one is speaking. `text` is the joined
 * transcript; `note` explains an absent text without asserting anything the
 * response did not say. A missing `transcripts` field is an unreadable payload.
 */
async function fetchInstagramTranscript(
  url: string,
  cacheMaxAge: string | undefined,
  headers: Record<string, string>,
  ctx: RequestContext,
): Promise<
  | { text: string; note: null; payload: Record<string, unknown> }
  | { text: null; note: string; payload: Record<string, unknown> }
  | { error: string; cancelled: boolean; payload: Record<string, unknown> | null }
> {
  const response = await scrapecreatorsRequest(
    "/v2/instagram/media/transcript",
    { url, cache_max_age: cacheMaxAge },
    headers,
    ctx,
    "ScrapeCreators Instagram transcript",
  )
  if (!response.ok) return { error: response.error, cancelled: response.cancelled, payload: response.payload }
  const transcripts = response.payload.transcripts
  if (transcripts === null) return { text: null, note: "provider reported no speech (transcripts: null)", payload: response.payload }
  if (!Array.isArray(transcripts)) {
    return {
      error: `ScrapeCreators Instagram transcript returned an unexpected payload: \`transcripts\` is ${transcripts === undefined ? "missing" : `not an array (${typeof transcripts})`}`,
      cancelled: false,
      payload: response.payload,
    }
  }
  const combined = transcripts
    .map((entry) => asString(asRecord(entry)?.text))
    .filter((value): value is string => value !== null)
    .join(" ")
    .trim()
  if (!combined) {
    return {
      text: null,
      note: transcripts.length === 0 ? "provider returned an empty transcript list" : `provider returned ${transcripts.length} transcript entr${transcripts.length === 1 ? "y" : "ies"} without text`,
      payload: response.payload,
    }
  }
  return { text: capWords(combined.replace(/\s+/g, " ")), note: null, payload: response.payload }
}

function reelLine(item: InstagramReel, index: number): string {
  const lines: string[] = []
  const who = item.author ? `@${item.author}${item.verified ? " (verified)" : ""}` : "(owner unknown)"
  lines.push(`${index + 1}. ${who} — ${truncate(cleanText(item.text), 150) || "(no caption)"}`)
  const views = item.views !== null ? `${fmtNum(item.views)} (${item.viewsSource})` : "unavailable"
  lines.push(
    `   Views: ${views} | Likes: ${fmtMetric(item.likes)} | Comments: ${fmtMetric(item.comments)} | Date: ${item.date ?? "unknown"}` +
      `${item.duration !== null ? ` | Duration: ${item.duration}s` : ""}${item.authorFollowers !== null ? ` | Followers: ${fmtNum(item.authorFollowers)}` : ""}`,
  )
  if (item.viewsNote) lines.push(`   Views note: ${item.viewsNote}`)
  if (item.url) lines.push(`   URL: ${item.url}`)
  if (item.paidPartnership) lines.push("   Paid partnership: yes")
  if (item.location) lines.push(`   Location: ${item.location}`)
  if (item.hashtags.length > 0) lines.push(`   Tags: ${item.hashtags.map((h) => `#${h}`).join(" ")}`)
  if (item.commentPreviews.length > 0) lines.push(`   Comment previews: ${item.commentPreviews.join(" || ")}`)
  if (item.transcript) lines.push(`   Transcript: ${item.transcript}`)
  else if (item.transcriptNote) lines.push(`   Transcript: ${item.transcriptNote}`)
  return lines.join("\n")
}

/** Instagram discovery: Google-indexed Reels search, Instagram-native search, or Popular topic pages */
export const instagram = creditMetered({
  description:
    "Search Instagram via ScrapeCreators in one of three modes. mode='reels' (default): Google-indexed Reels keyword search (/v2/instagram/reels/search) with date_posted and page 1-11; " +
    "view counts are no longer part of search results (removed 2026-08-19) and are only fetched when enrich_views=true (1 credit per reel via /v1/instagram/post). " +
    "mode='native': Instagram's own ranked users, hashtags, places, and keyword suggestions (/v1/instagram/search; one page, no posts). " +
    "mode='popular': Instagram's curated Popular topic page (/v1/instagram/search/popular) with description, suggested terms, posts with play counts, and an opaque cursor. " +
    "Requires SCRAPECREATORS_API_KEY; 1 credit per request, 1 per transcript. Metrics the provider omits are reported as unavailable, never 0.",
  async execute(args: InstagramArgs, ctx: ToolContext) {
    const headers = scrapecreatorsHeaders()
    if (!headers) return `ERROR: ${MISSING_KEY_ERROR}`
    const query = cleanText(args.query)
    if (!query) return "ERROR: query is required."
    const invalid =
      validateEnum("mode", args.mode, INSTAGRAM_MODE_VALUES) ??
      validateEnum("date_posted", args.date_posted, INSTAGRAM_DATE_POSTED_VALUES) ??
      validateEnum("cache_max_age", args.cache_max_age, CACHE_MAX_AGE_VALUES)
    if (invalid) return `ERROR: ${invalid}`
    const mode = (args.mode ?? "reels") as (typeof INSTAGRAM_MODE_VALUES)[number]
    const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)

    if (mode !== "reels") {
      if (args.date_posted !== undefined) return "ERROR: date_posted applies to mode='reels' only."
      if (args.page !== undefined) return "ERROR: page applies to mode='reels' only."
      if (args.enrich_views === true) {
        return mode === "popular"
          ? "ERROR: enrich_views applies to mode='reels' only; popular posts already include play_count."
          : "ERROR: enrich_views applies to mode='reels' only; native search returns no posts."
      }
    }
    if (mode !== "popular" && args.cursor !== undefined) return "ERROR: cursor applies to mode='popular' only; use page for reels."
    if (mode === "native" && args.transcripts === true) return "ERROR: transcripts apply to reels/popular modes only; native search returns no posts."

    const fetchTranscripts = args.transcripts ?? true
    const transcriptLimit = clampInt(args.transcript_limit, DEFAULT_TRANSCRIPT_LIMIT, 0, MAX_TRANSCRIPT_LIMIT)
    const cacheMaxAge = args.cache_max_age

    if (mode === "native") return instagramNative(query, limit, headers, ctx)
    if (mode === "popular") return instagramPopular(query, args.cursor?.trim() || undefined, limit, fetchTranscripts, transcriptLimit, cacheMaxAge, headers, ctx)

    if (args.page !== undefined && (typeof args.page !== "number" || !Number.isInteger(args.page) || args.page < 1 || args.page > INSTAGRAM_MAX_PAGE)) {
      return `ERROR: page must be an integer from 1 to ${INSTAGRAM_MAX_PAGE}; the provider rejects page 12 or greater.`
    }
    const page = args.page ?? 1
    const enrichViews = args.enrich_views === true
    const enrichLimit = clampInt(args.enrich_limit, DEFAULT_ENRICH_LIMIT, 0, MAX_ENRICH_LIMIT)

    const search = await scrapecreatorsRequest(
      "/v2/instagram/reels/search",
      { query, date_posted: args.date_posted, page },
      headers,
      ctx,
      "ScrapeCreators Instagram Reels search",
    )
    if (!search.ok) return failText(search)
    const listed = expectArray(search.payload, "reels", "ScrapeCreators Instagram Reels search")
    if (!listed.ok) return `ERROR: ${listed.error}`

    let unreadable = 0
    const returned: InstagramReel[] = []
    for (const entry of listed.items) {
      const record = asRecord(entry)
      const item = record ? normalizeReel(record) : null
      if (item) returned.push(item)
      else unreadable += 1
    }
    // A page made only of entries without an id/shortcode is unreadable, not empty.
    if (returned.length === 0 && unreadable > 0) {
      return `ERROR: ScrapeCreators Instagram Reels search returned an unexpected payload: none of the ${unreadable} reels entr${unreadable === 1 ? "y" : "ies"} carried a readable reel record (missing id and shortcode)`
    }
    const items = returned.slice(0, limit)
    const credits = new CreditTally()
    credits.add(search.payload)
    const filters = [`date_posted=${args.date_posted ?? "(none; Google-indexed default)"}`, `page=${page}`]
    const viewsPolicy = enrichViews
      ? `View counts: not included in search results since ${INSTAGRAM_VIEWS_REMOVED_ON}; looked up via /v1/instagram/post for the first ${Math.min(enrichLimit, items.length)} reel(s).`
      : `View counts: not included in search results since ${INSTAGRAM_VIEWS_REMOVED_ON}; set enrich_views=true to look them up (1 credit per reel).`

    if (items.length === 0) {
      return {
        status: "empty",
        text: [
          `Instagram Reels search: "${query}"`,
          `Filters: ${filters.join(" | ")}`,
          provenanceLine(search.payload),
          "",
          "The provider returned an empty reels list. Reels search is Google-indexed and best-effort, so an empty page is thin coverage, not proof of absence on Instagram.",
        ].join("\n"),
        details: { provider: "scrapecreators", mode, query, filters, returned: 0, shown: 0, credits: credits.details() },
      }
    }

    // Search results carry likes/comments but no view counts; any view figure
    // must come from an explicit post lookup so the credit cost stays visible.
    let enrichRequested = 0
    let enrichFetched = 0
    const enrichFailures: string[] = []
    if (enrichViews && enrichLimit > 0) {
      for (const item of items.slice(0, enrichLimit)) {
        if (ctx.abort.aborted) return `ERROR: Cancelled: Instagram view lookups stopped after ${enrichFetched} of ${enrichRequested}; the search page itself completed.`
        if (!item.url) {
          item.viewsNote = "no URL for a post lookup"
          continue
        }
        enrichRequested += 1
        const response = await scrapecreatorsRequest(
          "/v1/instagram/post",
          { url: item.url, include_play_count: "true", cache_max_age: cacheMaxAge },
          headers,
          ctx,
          "ScrapeCreators Instagram post lookup",
        )
        if (!response.ok) {
          if (response.cancelled) return `ERROR: Cancelled: ${response.error} (${enrichFetched} view lookups completed before cancellation)`
          credits.add(response.payload)
          item.viewsNote = `post lookup failed: ${response.error}`
          enrichFailures.push(`${item.url}: ${response.error}`)
          continue
        }
        credits.add(response.payload)
        const media = asRecord(asRecord(response.payload.data)?.xdt_shortcode_media)
        if (!media) {
          item.viewsNote = "post lookup returned an unexpected payload (no data.xdt_shortcode_media)"
          enrichFailures.push(`${item.url}: unexpected post payload`)
          continue
        }
        const plays = asNumber(media?.video_play_count) ?? asNumber(media?.video_view_count)
        if (plays !== null) {
          item.views = plays
          item.viewsSource = "post lookup"
          enrichFetched += 1
          if (response.payload.cached === true) item.viewsNote = `from cached post lookup${asString(response.payload.cached_at) ? ` scraped ${asString(response.payload.cached_at)}` : ""}`
        } else {
          item.viewsNote = "post lookup returned no play count (not a video, or Instagram hides it)"
        }
        const likes = asNumber(asRecord(media?.edge_media_preview_like)?.count)
        if (item.likes === null && likes !== null) item.likes = likes
      }
    }

    let transcriptsRequested = 0
    let transcriptsFetched = 0
    const transcriptFailures: string[] = []
    if (fetchTranscripts && transcriptLimit > 0) {
      for (const item of items.slice(0, transcriptLimit)) {
        if (ctx.abort.aborted) return `ERROR: Cancelled: Instagram transcript enrichment stopped after ${transcriptsFetched} of ${transcriptsRequested}; the search page itself completed.`
        if (!item.url) {
          item.transcriptNote = "no URL to fetch a transcript for"
          continue
        }
        transcriptsRequested += 1
        const result = await fetchInstagramTranscript(item.url, cacheMaxAge, headers, ctx)
        if ("error" in result) {
          if (result.cancelled) return `ERROR: Cancelled: ${result.error} (${transcriptsFetched} transcripts fetched before cancellation)`
          credits.add(result.payload)
          item.transcriptNote = `transcript failed: ${result.error}`
          transcriptFailures.push(`${item.url}: ${result.error}`)
          continue
        }
        credits.add(result.payload)
        if (result.text !== null) {
          item.transcript = result.text
          transcriptsFetched += 1
        } else {
          item.transcriptNote = result.note
        }
      }
    }

    const likes = sumAvailable(items.map((i) => i.likes))
    const views = sumAvailable(items.map((i) => i.views))
    const header = [
      `Instagram Reels search: "${query}" (${items.length} shown of ${returned.length} returned on page ${page})`,
      `Filters: ${filters.join(" | ")}`,
      "Source: Google-indexed reels, best-effort rather than Instagram-native search; order as returned, no local re-ranking.",
      viewsPolicy,
      `Next page: ${page < INSTAGRAM_MAX_PAGE ? `pass page=${page + 1}` : "page 11 is the provider's last page"}`,
      credits.describe(),
      enrichViews
        ? `View lookups: ${enrichFetched} with play counts of ${enrichRequested} requested${enrichFailures.length ? `; ${enrichFailures.length} failed` : ""}`
        : "View lookups: not requested",
      fetchTranscripts
        ? `Transcripts: ${transcriptsFetched} fetched of ${transcriptsRequested} requested${transcriptFailures.length ? `; ${transcriptFailures.length} failed` : ""}`
        : "Transcripts: not requested",
      `Totals over reels reporting metrics: ${likes.counted ? `${fmtNum(likes.total)} likes (${likes.counted}/${items.length})` : "no likes reported"}` +
        `${views.counted ? ` | ${fmtNum(views.total)} views (${views.counted}/${items.length}, from post lookups)` : " | views: none available"}`,
    ]
    if (unreadable) header.push(`Unreadable entries: ${unreadable} returned entr${unreadable === 1 ? "y" : "ies"} lacked a readable reel record and ${unreadable === 1 ? "was" : "were"} skipped.`)
    if (enrichFailures.length) header.push(`View lookup failures: ${enrichFailures.join("; ")}`)
    if (transcriptFailures.length) header.push(`Transcript failures: ${transcriptFailures.join("; ")}`)

    return {
      status: enrichFailures.length || transcriptFailures.length ? "partial" : "success",
      text: [header.join("\n"), ...items.map(reelLine)].join("\n\n"),
      details: {
        provider: "scrapecreators",
        mode,
        query,
        filters,
        page,
        returned: returned.length,
        shown: items.length,
        unreadable,
        credits: credits.details(),
        views: { requested: enrichRequested, fetched: enrichFetched, failed: enrichFailures.length },
        transcripts: { requested: transcriptsRequested, fetched: transcriptsFetched, failed: transcriptFailures.length },
        reel_ids: items.map((i) => i.id),
      },
    }
  },
} satisfies ToolSpec)

async function instagramNative(query: string, limit: number, headers: Record<string, string>, ctx: RequestContext) {
  const response = await scrapecreatorsRequest("/v1/instagram/search", { query }, headers, ctx, "ScrapeCreators Instagram native search")
  if (!response.ok) return failText(response)
  const label = "ScrapeCreators Instagram native search"
  // The docs example nests the lists under `data`; the live response
  // (2026-09-15) carries users/hashtags/places/keywords at the root.
  const data = asRecord(response.payload.data) ?? response.payload
  const userList = expectArray(data, "users", label)
  const hashtagList = expectArray(data, "hashtags", label)
  const placeList = expectArray(data, "places", label)
  const keywordList = expectArray(data, "keywords", label)
  if (!userList.ok) return `ERROR: ${userList.error}`
  if (!hashtagList.ok) return `ERROR: ${hashtagList.error}`
  if (!placeList.ok) return `ERROR: ${placeList.error}`
  if (!keywordList.ok) return `ERROR: ${keywordList.error}`
  const users = userList.items.map(asRecord).filter((r): r is Record<string, unknown> => r !== null)
  const hashtags = hashtagList.items.map(asRecord).filter((r): r is Record<string, unknown> => r !== null)
  const places = placeList.items.map(asRecord).filter((r): r is Record<string, unknown> => r !== null)
  const keywords = keywordList.items
    .map((entry) => (typeof entry === "string" ? entry : asString(asRecord(entry)?.name) ?? asString(asRecord(entry)?.keyword)))
    .filter((value): value is string => value !== null)

  const lines = [
    `Instagram native search: "${query}"`,
    "Source: Instagram's own ranked search (not Google-indexed); one page only; returns accounts, hashtags, places, and keyword suggestions, not posts.",
    provenanceLine(response.payload),
    `Returned: ${users.length} users | ${hashtags.length} hashtags | ${places.length} places | ${keywords.length} keywords (showing up to ${limit} per list)`,
  ]
  if (users.length) {
    lines.push("", "Users:")
    for (const user of users.slice(0, limit)) {
      const username = asString(user.username) ?? "(unknown)"
      const fullName = cleanText(user.full_name)
      lines.push(`- @${username}${fullName ? ` — ${fullName}` : ""}${user.is_verified === true ? " (verified)" : ""} — https://www.instagram.com/${username}/`)
    }
  }
  if (hashtags.length) {
    lines.push("", "Hashtags:")
    for (const tag of hashtags.slice(0, limit)) {
      const name = asString(tag.name) ?? "(unknown)"
      const count = asNumber(tag.media_count)
      lines.push(`- #${name}${count !== null ? ` — ${fmtNum(count)} posts` : ""}`)
    }
  }
  if (places.length) {
    lines.push("", "Places:")
    for (const place of places.slice(0, limit)) {
      const name = asString(place.title) ?? asString(place.name) ?? "(unknown)"
      const subtitle = cleanText(place.subtitle)
      lines.push(`- ${name}${subtitle ? ` — ${subtitle}` : ""}${asString(place.id) ? ` (place id ${asString(place.id)})` : ""}`)
    }
  }
  if (keywords.length) lines.push("", `Keyword suggestions: ${keywords.slice(0, limit).join(", ")}`)
  if (!users.length && !hashtags.length && !places.length && !keywords.length) lines.push("", "Instagram returned empty user, hashtag, place, and keyword lists for this query.")

  return {
    text: lines.join("\n"),
    details: {
      provider: "scrapecreators",
      mode: "native",
      query,
      users: users.length,
      hashtags: hashtags.length,
      places: places.length,
      keywords: keywords.length,
      credits_charged: asNumber(response.payload.credits_charged),
    },
  }
}

async function instagramPopular(
  query: string,
  cursor: string | undefined,
  limit: number,
  fetchTranscripts: boolean,
  transcriptLimit: number,
  cacheMaxAge: string | undefined,
  headers: Record<string, string>,
  ctx: RequestContext,
) {
  const response = await scrapecreatorsRequest("/v1/instagram/search/popular", { query, cursor }, headers, ctx, "ScrapeCreators Instagram popular search")
  if (!response.ok) return failText(response)
  const payload = response.payload
  const listed = expectArray(payload, "posts", "ScrapeCreators Instagram popular search")
  if (!listed.ok) return `ERROR: ${listed.error}`
  const posts = listed.items.map(asRecord).filter((r): r is Record<string, unknown> => r !== null)
  const shown = posts.slice(0, limit)
  const nextCursor = asString(payload.cursor)
  const hasMore = typeof payload.has_more === "boolean" ? payload.has_more : null
  const credits = new CreditTally()
  credits.add(payload)
  const description = asRecord(payload.description)
  const suggested = asArray(payload.suggested_terms).filter((v): v is string => typeof v === "string")
  const totalMedia = asNumber(payload.total_media_count)

  const lines = [
    `Instagram popular topic: "${query}"${asString(payload.title) ? ` — ${asString(payload.title)}` : ""}${cursor ? " (continued page)" : ""}`,
    "Source: Instagram's curated public /popular page; posts are Instagram's own selection, not a keyword ranking.",
    `Posts: ${shown.length} shown of ${posts.length} returned${totalMedia !== null ? `; Instagram reports ${fmtNum(totalMedia)} total media for the topic` : ""}`,
    hasMore === false
      ? "Next page: provider reports no more posts"
      : nextCursor
        ? `Next page: pass cursor="${nextCursor}" with the same query`
        : "Next page: no cursor returned and has_more not reported; continuation unavailable",
  ]
  const plain = cleanText(description?.plain_text)
  if (plain) {
    lines.push(`Instagram description: ${truncate(plain, 400)}`)
    const sources = asArray(description?.source_uris).filter((v): v is string => typeof v === "string")
    if (sources.length) lines.push(`Description sources: ${sources.join(", ")}`)
  }
  if (suggested.length) lines.push(`Suggested terms: ${suggested.slice(0, 10).join(", ")}`)

  let transcriptsRequested = 0
  let transcriptsFetched = 0
  const transcriptFailures: string[] = []
  const transcripts = new Map<number, string>()
  const transcriptNotes = new Map<number, string>()
  if (fetchTranscripts && transcriptLimit > 0) {
    for (const [index, post] of shown.entries()) {
      if (transcriptsRequested >= transcriptLimit) break
      if (ctx.abort.aborted) return `ERROR: Cancelled: Instagram popular transcript enrichment stopped after ${transcriptsFetched} of ${transcriptsRequested}; the topic page itself completed.`
      const url = asString(post.url)
      const type = asString(post.type)
      if (!url || (type && type !== "reel" && type !== "video")) continue
      transcriptsRequested += 1
      const result = await fetchInstagramTranscript(url, cacheMaxAge, headers, ctx)
      if ("error" in result) {
        if (result.cancelled) return `ERROR: Cancelled: ${result.error} (${transcriptsFetched} transcripts fetched before cancellation)`
        credits.add(result.payload)
        transcriptFailures.push(`${url}: ${result.error}`)
        continue
      }
      credits.add(result.payload)
      if (result.text !== null) {
        transcripts.set(index, result.text)
        transcriptsFetched += 1
      } else {
        transcriptNotes.set(index, result.note)
      }
    }
  }
  lines.push(credits.describe())
  lines.push(
    fetchTranscripts
      ? `Transcripts: ${transcriptsFetched} fetched of ${transcriptsRequested} requested (reels/videos only)${transcriptFailures.length ? `; ${transcriptFailures.length} failed` : ""}`
      : "Transcripts: not requested",
  )
  if (transcriptFailures.length) lines.push(`Transcript failures: ${transcriptFailures.join("; ")}`)

  if (shown.length === 0) lines.push("", "The provider returned an empty post list for this topic page.")
  for (const [index, post] of shown.entries()) {
    const owner = asRecord(post.owner)
    const username = asString(owner?.username)
    const caption = truncate(cleanText(post.caption), 150) || "(no caption)"
    const plays = asNumber(post.play_count)
    lines.push("", `${index + 1}. ${username ? `@${username}${owner?.is_verified === true ? " (verified)" : ""}` : "(owner unknown)"} — ${caption}`)
    lines.push(`   Type: ${asString(post.type) ?? "unknown"} | Plays: ${fmtMetric(plays)}${plays === null ? " (Instagram did not expose a play count)" : ""}`)
    if (asString(post.url)) lines.push(`   URL: ${asString(post.url)}`)
    const tags = hashtagsIn(asString(post.caption) ?? "")
    if (tags.length) lines.push(`   Tags: ${tags.map((h) => `#${h}`).join(" ")}`)
    const transcript = transcripts.get(index)
    if (transcript) lines.push(`   Transcript: ${transcript}`)
    else if (transcriptNotes.has(index)) lines.push(`   Transcript: ${transcriptNotes.get(index)}`)
  }

  return {
    text: lines.join("\n"),
    details: {
      provider: "scrapecreators",
      mode: "popular",
      query,
      returned: posts.length,
      shown: shown.length,
      cursor: hasMore === false ? null : nextCursor,
      has_more: hasMore,
      credits: credits.details(),
      transcripts: { requested: transcriptsRequested, fetched: transcriptsFetched, failed: transcriptFailures.length },
    },
  }
}

// ---------------------------------------------------------------------------
// LinkedIn
// ---------------------------------------------------------------------------

interface LinkedInArgs {
  kind: string
  url?: string
  query?: string
  page?: number
  date_posted?: string
  cursor?: string
}

/** Fetch public LinkedIn profiles, pages, posts, company posts by URL, or search public posts by keyword */
export const linkedin = creditMetered({
  description:
    "Fetch public LinkedIn data via ScrapeCreators. kind='profile' | 'company' | 'company_posts' | 'post' take an exact public URL. " +
    "kind='search' finds public posts and Pulse articles by keyword through Google-indexed results (/v1/linkedin/search/posts) with date_posted and cursor pages 1-11; " +
    "it is best-effort, not a complete LinkedIn-native search. Requires SCRAPECREATORS_API_KEY; 1 credit per request. No login is used and only public data is returned.",
  async execute(args: LinkedInArgs, ctx: ToolContext) {
    const headers = scrapecreatorsHeaders()
    if (!headers) return `ERROR: ${MISSING_KEY_ERROR}`
    const invalid =
      validateEnum("kind", args.kind, LINKEDIN_KIND_VALUES) ??
      validateEnum("date_posted", args.date_posted, LINKEDIN_DATE_POSTED_VALUES)
    if (invalid) return `ERROR: ${invalid}`
    const kind = args.kind as (typeof LINKEDIN_KIND_VALUES)[number]

    if (kind === "search") {
      if (args.url !== undefined) return "ERROR: url applies to profile/company/company_posts/post; kind='search' takes query."
      if (args.page !== undefined) return "ERROR: page applies to kind='company_posts' only; search paginates with cursor."
      const query = cleanText(args.query)
      if (!query) return "ERROR: query is required for kind='search'."
      const cursor = args.cursor?.trim()
      if (cursor) {
        const numeric = Number(cursor)
        if (!Number.isInteger(numeric) || numeric < 1 || numeric > LINKEDIN_MAX_SEARCH_CURSOR) {
          return `ERROR: cursor must be the value returned by the previous search (1-${LINKEDIN_MAX_SEARCH_CURSOR}); the provider rejects cursor 12 or greater.`
        }
      }
      const response = await scrapecreatorsRequest(
        "/v1/linkedin/search/posts",
        { query, date_posted: args.date_posted, cursor },
        headers,
        ctx,
        "ScrapeCreators LinkedIn post search",
      )
      if (!response.ok) return failText(response)
      return formatLinkedInSearch(response.payload, query, args.date_posted, cursor)
    }

    if (args.query !== undefined) return "ERROR: query applies to kind='search' only."
    if (args.date_posted !== undefined || args.cursor !== undefined) return "ERROR: date_posted and cursor apply to kind='search' only."
    const url = args.url?.trim()
    if (!url) return `ERROR: url is required for kind='${kind}'.`
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return "ERROR: url must be a full public LinkedIn URL."
    }
    if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) return "ERROR: url must be a linkedin.com URL."
    if (kind !== "company_posts" && args.page !== undefined) return "ERROR: page applies to kind='company_posts' only."
    if (args.page !== undefined && (!Number.isInteger(args.page) || args.page < 1 || args.page > LINKEDIN_MAX_COMPANY_POSTS_PAGE)) {
      return `ERROR: page must be an integer from 1 to ${LINKEDIN_MAX_COMPANY_POSTS_PAGE}.`
    }
    const page = args.page ?? 1

    const path =
      kind === "profile" ? "/v1/linkedin/profile" : kind === "company" ? "/v1/linkedin/company" : kind === "company_posts" ? "/v1/linkedin/company/posts" : "/v1/linkedin/post"
    const response = await scrapecreatorsRequest(
      path,
      { url, page: kind === "company_posts" ? page : undefined },
      headers,
      ctx,
      `ScrapeCreators LinkedIn ${kind.replace("_", " ")}`,
    )
    if (!response.ok) return failText(response)
    const data = response.payload

    switch (kind) {
      case "profile":
        return formatLinkedInProfile(data, url)
      case "company":
        return formatLinkedInCompany(data, url)
      case "company_posts":
        return formatLinkedInCompanyPosts(data, url, page)
      case "post":
        return formatLinkedInPost(data, url)
    }
  },
} satisfies ToolSpec)

function formatLinkedInSearch(data: Record<string, unknown>, query: string, datePosted: string | undefined, cursor: string | undefined) {
  const listed = expectArray(data, "posts", "ScrapeCreators LinkedIn post search")
  if (!listed.ok) return `ERROR: ${listed.error}`
  const posts = listed.items.map(asRecord).filter((r): r is Record<string, unknown> => r !== null)
  const nextCursor = asString(data.cursor)
  const lines = [
    `LinkedIn public post search: "${query}"`,
    `Filters: date_posted=${datePosted ?? "(none)"} | cursor=${cursor ?? "1 (first page)"}`,
    "Source: Google-indexed public posts and Pulse articles; best-effort, not a complete LinkedIn-native search. Order as returned.",
    provenanceLine(data),
    nextCursor ? `Next page: pass cursor="${nextCursor}"${Number(nextCursor) > LINKEDIN_MAX_SEARCH_CURSOR ? " (beyond the provider's page-11 cap)" : ""}` : "Next page: no cursor returned",
    `Posts returned: ${posts.length}`,
  ]
  if (posts.length === 0) lines.push("", "The provider returned an empty post list for this query and window; Google-indexed coverage is thin here, which is not proof that LinkedIn holds nothing.")
  for (const [index, post] of posts.entries()) {
    const author = asRecord(post.author)
    const authorName = cleanText(author?.name)
    const followers = asNumber(author?.followers)
    const likeCount = asNumber(post.likeCount)
    const commentCount = asNumber(post.commentCount)
    const comments = asArray(post.comments)
    lines.push("", `${index + 1}. ${authorName ?? "Unknown author"}${followers !== null ? ` (${fmtNum(followers)} followers)` : ""}`)
    if (cleanText(post.description)) lines.push(`   ${truncate(cleanText(post.description), 400)}`)
    lines.push(
      `   Published: ${cleanText(post.datePublished) ?? "unknown"} | Likes: ${fmtMetric(likeCount)} | Comments: ${fmtMetric(commentCount)}${comments.length ? ` (${comments.length} returned inline)` : ""}`,
    )
    if (cleanText(post.url)) lines.push(`   URL: ${cleanText(post.url)}`)
    if (cleanText(author?.url)) lines.push(`   Author URL: ${cleanText(author?.url)}`)
    const preview = comments
      .map((entry) => {
        const comment = asRecord(entry)
        const text = cleanText(comment?.text)
        return text ? `${cleanText(comment?.author) ?? "Unknown"}: ${truncate(text, 140)}` : null
      })
      .filter((value): value is string => value !== null)
      .slice(0, 2)
    if (preview.length) lines.push(`   Comment previews: ${preview.join(" || ")}`)
  }
  return {
    text: lines.join("\n"),
    details: {
      provider: "scrapecreators",
      kind: "search",
      query,
      date_posted: datePosted ?? null,
      cursor: nextCursor,
      posts: posts.length,
      credits_charged: asNumber(data.credits_charged),
      urls: posts.map((post) => asString(post.url)).filter((value): value is string => value !== null),
    },
  }
}

function formatLinkedInProfile(data: Record<string, unknown>, sourceUrl: string): string {
  const lines: string[] = []
  const name = cleanText(data.name) || "Unknown profile"
  const followers = asNumber(data.followers)
  const recentPosts = asArray(data.recentPosts).slice(0, 5)
  const activity = asArray(data.activity).slice(0, 5)
  const articles = asArray(data.articles).slice(0, 3)
  const experience = asArray(data.experience).slice(0, 5)
  const education = asArray(data.education).slice(0, 3)
  const publications = asArray(data.publications).slice(0, 5)
  const projects = asArray(data.projects).slice(0, 3)
  const recommendations = asArray(data.recommendations).slice(0, 3)
  const similarProfiles = asArray(data.similarProfiles).slice(0, 5)

  lines.push(`LinkedIn profile: ${name}`)
  lines.push(`URL: ${sourceUrl}`)
  lines.push(provenanceLine(data))
  if (cleanText(data.location)) lines.push(`Location: ${cleanText(data.location)}`)
  if (followers !== null) lines.push(`Followers: ${fmtNum(followers)}`)
  if (cleanText(data.connections)) lines.push(`Connections: ${cleanText(data.connections)}`)
  if (cleanText(data.about)) lines.push("")
  if (cleanText(data.about)) lines.push(`About: ${truncate(cleanText(data.about), 500)}`)

  if (recentPosts.length > 0) {
    lines.push("")
    lines.push("Recent Posts:")
    for (const item of recentPosts) {
      const record = asRecord(item)
      if (!record) continue
      const title = cleanText(record.title) || "Untitled post"
      lines.push(`- ${truncate(title, 220)}`)
      if (cleanText(record.activityType)) lines.push(`  Activity: ${cleanText(record.activityType)}`)
      if (cleanText(record.link)) lines.push(`  URL: ${cleanText(record.link)}`)
    }
  }

  if (activity.length > 0) {
    lines.push("")
    lines.push("Recent Activity:")
    for (const item of activity) {
      const record = asRecord(item)
      if (!record) continue
      const title = cleanText(record.title) || "Untitled activity"
      lines.push(`- ${truncate(title, 220)}`)
      if (cleanText(record.activityType)) lines.push(`  Activity: ${cleanText(record.activityType)}`)
      if (cleanText(record.link)) lines.push(`  URL: ${cleanText(record.link)}`)
    }
  }

  if (articles.length > 0) {
    lines.push("")
    lines.push("Articles:")
    for (const item of articles) {
      const record = asRecord(item)
      if (!record) continue
      const headline = cleanText(record.headline) || "Untitled article"
      lines.push(`- ${truncate(headline, 220)}`)
      if (cleanText(record.datePublished)) lines.push(`  Published: ${cleanText(record.datePublished)}`)
      if (cleanText(record.articleBody)) lines.push(`  Excerpt: ${truncate(cleanText(record.articleBody), 220)}`)
    }
  }

  if (experience.length > 0) {
    lines.push("")
    lines.push("Experience:")
    for (const item of experience) {
      const record = asRecord(item)
      if (!record) continue
      const orgName = cleanText(record.name) || "Unknown organization"
      lines.push(`- ${orgName}`)
      if (cleanText(record.url)) lines.push(`  URL: ${cleanText(record.url)}`)
      if (cleanText(record.location)) lines.push(`  Location: ${cleanText(record.location)}`)
      const member = asRecord(record.member)
      const roleDescription = member ? cleanText(member.description) : null
      const startDate = member ? displayScalar(member.startDate) : null
      const endDate = member ? displayScalar(member.endDate) : null
      if (startDate || endDate) {
        lines.push(`  Dates: ${startDate || "?"} - ${endDate || "Present"}`)
      }
      if (roleDescription) lines.push(`  Role: ${truncate(roleDescription, 180)}`)
    }
  }

  if (education.length > 0) {
    lines.push("")
    lines.push("Education:")
    for (const item of education) {
      const record = asRecord(item)
      if (!record) continue
      const schoolName = cleanText(record.name) || "Unknown school"
      lines.push(`- ${schoolName}`)
      if (cleanText(record.url)) lines.push(`  URL: ${cleanText(record.url)}`)
      const member = asRecord(record.member)
      const startDate = member ? displayScalar(member.startDate) : null
      const endDate = member ? displayScalar(member.endDate) : null
      if (startDate || endDate) {
        lines.push(`  Dates: ${startDate || "?"} - ${endDate || "Present"}`)
      }
    }
  }

  if (publications.length > 0) {
    lines.push("")
    lines.push("Publications:")
    for (const item of publications) {
      const record = asRecord(item)
      if (!record) continue
      const publicationName = cleanText(record.name) || "Untitled publication"
      lines.push(`- ${publicationName}`)
      if (cleanText(record.url)) lines.push(`  URL: ${cleanText(record.url)}`)
    }
  }

  if (projects.length > 0) {
    lines.push("")
    lines.push("Projects:")
    for (const item of projects) {
      const record = asRecord(item)
      if (!record) continue
      const projectName = cleanText(record.name) || "Untitled project"
      lines.push(`- ${projectName}`)
      if (cleanText(record.url)) lines.push(`  URL: ${cleanText(record.url)}`)
      if (cleanText(record.dateRange)) lines.push(`  Date Range: ${cleanText(record.dateRange)}`)
      if (cleanText(record.description)) lines.push(`  Description: ${truncate(cleanText(record.description), 220)}`)

      const contributors = asArray(record.contributors).slice(0, 4)
      if (contributors.length > 0) {
        lines.push(`  Contributors: ${contributors
          .map((contributor) => cleanText(asRecord(contributor)?.name))
          .filter((value): value is string => Boolean(value))
          .join(", ")}`)
      }
    }
  }

  if (recommendations.length > 0) {
    lines.push("")
    lines.push("Recommendations:")
    for (const item of recommendations) {
      const record = asRecord(item)
      if (!record) continue
      const recommender = cleanText(record.name) || "Unknown recommender"
      lines.push(`- ${recommender}`)
      if (cleanText(record.link)) lines.push(`  URL: ${cleanText(record.link)}`)
      if (cleanText(record.text)) lines.push(`  Text: ${truncate(cleanText(record.text), 240)}`)
    }
  }

  if (similarProfiles.length > 0) {
    lines.push("")
    lines.push("Similar Profiles:")
    for (const item of similarProfiles) {
      const record = asRecord(item)
      if (!record) continue
      const profileName = cleanText(record.name) || "Unknown profile"
      lines.push(`- ${profileName}`)
      if (cleanText(record.link)) lines.push(`  URL: ${cleanText(record.link)}`)
    }
  }

  return lines.join("\n")
}

function formatLinkedInCompany(data: Record<string, unknown>, sourceUrl: string): string {
  const lines: string[] = []
  const name = cleanText(data.name) || "Unknown company"
  const employeeCount = asNumber(data.employeeCount)
  const posts = asArray(data.posts).slice(0, 5)
  const employees = asArray(data.employees).slice(0, 5)
  const specialties = asArray(data.specialties)
    .map((value) => cleanText(value))
    .filter((value): value is string => Boolean(value))
    .slice(0, 12)

  lines.push(`LinkedIn company page: ${name}`)
  lines.push(`URL: ${sourceUrl}`)
  lines.push(provenanceLine(data))
  if (cleanText(data.website)) lines.push(`Website: ${cleanText(data.website)}`)
  if (cleanText(data.industry)) lines.push(`Industry: ${cleanText(data.industry)}`)
  if (cleanText(data.size)) lines.push(`Size: ${cleanText(data.size)}`)
  if (employeeCount !== null) lines.push(`Employee count: ${fmtNum(employeeCount)}`)
  if (cleanText(data.headquarters)) lines.push(`Headquarters: ${cleanText(data.headquarters)}`)
  if (cleanText(data.type)) lines.push(`Type: ${cleanText(data.type)}`)
  if (asNumber(data.founded) !== null) lines.push(`Founded: ${asNumber(data.founded)}`)
  if (cleanText(data.slogan)) lines.push(`Slogan: ${cleanText(data.slogan)}`)
  if (cleanText(data.description)) {
    lines.push("")
    lines.push(`Description: ${truncate(cleanText(data.description), 700)}`)
  }

  if (specialties.length > 0) {
    lines.push("")
    lines.push(`Specialties: ${specialties.join(", ")}`)
  }

  if (employees.length > 0) {
    lines.push("")
    lines.push("Notable Employees:")
    for (const item of employees) {
      const record = asRecord(item)
      if (!record) continue
      const employeeName = cleanText(record.name) || "Unknown employee"
      lines.push(`- ${employeeName}`)
      if (cleanText(record.title)) lines.push(`  Title: ${cleanText(record.title)}`)
      if (cleanText(record.link)) lines.push(`  URL: ${cleanText(record.link)}`)
    }
  }

  if (posts.length > 0) {
    lines.push("")
    lines.push("Recent Posts Embedded In Company Page:")
    for (const item of posts) {
      const record = asRecord(item)
      if (!record) continue
      const text = cleanText(record.text) || "Untitled post"
      lines.push(`- ${truncate(text, 260)}`)
      if (cleanText(record.datePublished)) lines.push(`  Published: ${cleanText(record.datePublished)}`)
      if (cleanText(record.url)) lines.push(`  URL: ${cleanText(record.url)}`)
    }
  }

  return lines.join("\n")
}

function formatLinkedInCompanyPosts(data: Record<string, unknown>, sourceUrl: string, page: number): string {
  const lines: string[] = []
  const listed = expectArray(data, "posts", "ScrapeCreators LinkedIn company posts")
  if (!listed.ok) return `ERROR: ${listed.error}`
  const posts = listed.items.slice(0, 10)

  lines.push(`LinkedIn company posts: ${sourceUrl}`)
  lines.push(`Page: ${page} of at most ${LINKEDIN_MAX_COMPANY_POSTS_PAGE}`)
  lines.push(provenanceLine(data))

  if (posts.length === 0) {
    lines.push("")
    lines.push("The provider returned an empty post list for this page.")
    return lines.join("\n")
  }

  lines.push("")
  lines.push(`Posts returned: ${posts.length}`)
  lines.push("")

  for (const item of posts) {
    const record = asRecord(item)
    if (!record) continue
    const text = cleanText(record.text) || "Untitled post"
    lines.push(`- ${truncate(text, 320)}`)
    if (cleanText(record.datePublished)) lines.push(`  Published: ${cleanText(record.datePublished)}`)
    if (cleanText(record.url)) lines.push(`  URL: ${cleanText(record.url)}`)
    if (cleanText(record.id)) lines.push(`  Post ID: ${cleanText(record.id)}`)
  }

  return lines.join("\n")
}

function formatLinkedInPost(data: Record<string, unknown>, sourceUrl: string): string {
  const lines: string[] = []
  const comments = asArray(data.comments).slice(0, 5)
  const moreArticles = asArray(data.moreArticles).slice(0, 3)
  const likeCount = asNumber(data.likeCount)
  const commentCount = asNumber(data.commentCount)
  const author = asRecord(data.author)

  lines.push(`LinkedIn post: ${cleanText(data.name) || cleanText(data.headline) || "Untitled post"}`)
  lines.push(`URL: ${sourceUrl}`)
  lines.push(provenanceLine(data))
  if (cleanText(data.headline)) lines.push(`Headline: ${truncate(cleanText(data.headline), 260)}`)
  if (cleanText(data.datePublished)) lines.push(`Published: ${cleanText(data.datePublished)}`)
  if (likeCount !== null || commentCount !== null) {
    lines.push(
      `Engagement: ${likeCount !== null ? `${fmtNum(likeCount)} likes` : "likes unknown"} | ${commentCount !== null ? `${fmtNum(commentCount)} comments` : "comments unknown"}`
    )
  }

  if (author) {
    lines.push("")
    lines.push("Author:")
    if (cleanText(author.name)) lines.push(`- Name: ${cleanText(author.name)}`)
    if (cleanText(author.url)) lines.push(`- URL: ${cleanText(author.url)}`)
    const authorFollowers = asNumber(author.followers)
    if (authorFollowers !== null) lines.push(`- Followers: ${fmtNum(authorFollowers)}`)
  }

  if (cleanText(data.description)) {
    lines.push("")
    lines.push(`Description: ${truncate(cleanText(data.description), 700)}`)
  }

  if (comments.length > 0) {
    lines.push("")
    lines.push("Comments:")
    for (const item of comments) {
      const record = asRecord(item)
      if (!record) continue
      const authorName = cleanText(record.author) || "Unknown commenter"
      const text = cleanText(record.text) || ""
      lines.push(`- ${authorName}: ${truncate(text, 220)}`)
      if (cleanText(record.linkedinUrl)) lines.push(`  URL: ${cleanText(record.linkedinUrl)}`)
    }
  }

  if (moreArticles.length > 0) {
    lines.push("")
    lines.push("Related Articles:")
    for (const item of moreArticles) {
      const record = asRecord(item)
      if (!record) continue
      const title = cleanText(record.title) || "Untitled article"
      lines.push(`- ${truncate(title, 220)}`)
      if (cleanText(record.datePublished)) lines.push(`  Published: ${cleanText(record.datePublished)}`)
      if (cleanText(record.link)) lines.push(`  URL: ${cleanText(record.link)}`)
      const reactions = asNumber(record.reactionCount)
      const commentsCount = asNumber(record.commentCount)
      if (reactions !== null || commentsCount !== null) {
        lines.push(
          `  Engagement: ${reactions !== null ? `${fmtNum(reactions)} reactions` : "reactions unknown"} | ${commentsCount !== null ? `${fmtNum(commentsCount)} comments` : "comments unknown"}`
        )
      }
    }
  }

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Telegram (public web preview only)
// ---------------------------------------------------------------------------

interface TelegramArgs {
  kind: string
  handle?: string
  url?: string
  cursor?: string
  limit?: number
  cache_max_age?: string
}

const TELEGRAM_HANDLE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{3,}$/

/**
 * Accepts `durov`, `@durov`, `https://t.me/durov`, or `t.me/s/durov`; rejects
 * invite links, numeric ids, and anything else the public preview cannot show.
 */
function normalizeTelegramHandle(value: string): { handle: string } | { error: string } {
  let raw = value.trim()
  const asUrl = raw.includes("/") ? raw : null
  if (asUrl) {
    let parsed: URL
    try {
      parsed = new URL(/^https?:\/\//i.test(asUrl) ? asUrl : `https://${asUrl}`)
    } catch {
      return { error: "handle must be a public Telegram handle, @handle, or t.me channel URL." }
    }
    if (!/^(t\.me|telegram\.me|telegram\.dog)$/i.test(parsed.hostname)) return { error: "Telegram URLs must be on t.me." }
    const segments = parsed.pathname.split("/").filter(Boolean)
    if (segments[0] === "s") segments.shift()
    raw = segments[0] ?? ""
  }
  if (raw.startsWith("@")) raw = raw.slice(1)
  if (raw.startsWith("+") || /^joinchat$/i.test(raw)) return { error: "private or invite-only Telegram channels and groups are not supported; only public handles with a web preview work." }
  if (/^\d+$/.test(raw)) return { error: "numeric Telegram ids are not supported; use the public handle." }
  if (!TELEGRAM_HANDLE_PATTERN.test(raw)) return { error: "handle must be a public Telegram handle (letters, digits, underscores), @handle, or t.me channel URL." }
  return { handle: raw }
}

function normalizeTelegramPostUrl(value: string): { url: string } | { error: string } {
  let parsed: URL
  try {
    parsed = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`)
  } catch {
    return { error: "url must be a public Telegram post URL such as https://t.me/durov/543." }
  }
  if (!/^(t\.me|telegram\.me|telegram\.dog)$/i.test(parsed.hostname)) return { error: "Telegram post URLs must be on t.me." }
  const segments = parsed.pathname.split("/").filter(Boolean)
  if (segments[0] === "s") segments.shift()
  const [handle, postId] = segments
  if (!handle || handle.startsWith("+") || /^joinchat$/i.test(handle)) return { error: "private or invite-only Telegram posts are not supported." }
  if (!TELEGRAM_HANDLE_PATTERN.test(handle) || !postId || !/^\d+$/.test(postId)) {
    return { error: "url must be a public Telegram post URL of the form https://t.me/<handle>/<post id>." }
  }
  return { url: `https://t.me/${handle}/${postId}` }
}

function telegramChannelLines(channel: Record<string, unknown>): string[] {
  const lines: string[] = []
  const name = cleanText(channel.name) ?? "(name unavailable)"
  const handle = asString(channel.handle)
  lines.push(`Channel: ${name}${handle ? ` (@${handle})` : ""}${channel.is_verified === true ? " — verified" : ""}`)
  if (asString(channel.url)) lines.push(`URL: ${asString(channel.url)}`)
  const subscribers = asNumber(channel.subscriber_count)
  const members = asNumber(channel.member_count)
  const audience: string[] = []
  if (subscribers !== null) audience.push(`${fmtNum(subscribers)} subscribers${asString(channel.subscriber_count_text) ? ` (${asString(channel.subscriber_count_text)})` : ""}`)
  if (members !== null) audience.push(`${fmtNum(members)} members${asString(channel.member_count_text) ? ` (${asString(channel.member_count_text)})` : ""}`)
  lines.push(`Audience: ${audience.length ? audience.join(" | ") : "not exposed by the public preview"}`)
  const counters = (["photo_count", "video_count", "file_count", "link_count"] as const)
    .map((key) => {
      const count = asNumber(channel[key])
      return count === null ? null : `${key.replace("_count", "s")}: ${fmtNum(count)}`
    })
    .filter((value): value is string => value !== null)
  if (counters.length) lines.push(`Public media counters: ${counters.join(" | ")}`)
  if (cleanText(channel.description)) lines.push(`Description: ${truncate(cleanText(channel.description), 500)}`)
  return lines
}

function telegramPostLines(post: Record<string, unknown>, index: number | null): string[] {
  const lines: string[] = []
  const id = asString(post.id) ?? (asNumber(post.id) !== null ? String(post.id) : null)
  const prefix = index === null ? "" : `${index + 1}. `
  const author = cleanText(post.author_name)
  lines.push(`${prefix}${author ? `${author} — ` : ""}${truncate(cleanText(post.text), 300) || "(no text; media-only or unavailable in the preview)"}`)
  const views = asNumber(post.view_count)
  const reactionTotal = asNumber(post.reaction_count)
  const reactions = asArray(post.reactions)
    .map((entry) => {
      const reaction = asRecord(entry)
      const count = asNumber(reaction?.count)
      if (count === null) return null
      const label = asString(reaction?.emoji) ?? (asString(reaction?.emoji_id) ? `custom emoji ${asString(reaction?.emoji_id)}` : "reaction")
      return `${label} ${fmtNum(count)}`
    })
    .filter((value): value is string => value !== null)
    .slice(0, 6)
  lines.push(
    `${index === null ? "" : "   "}Published: ${asString(post.published_at) ?? "unknown"} | Views: ${views !== null ? fmtNum(views) : "not exposed"} | Reactions: ${reactionTotal !== null ? fmtNum(reactionTotal) : "not exposed"}${reactions.length ? ` (${reactions.join(", ")})` : ""}`,
  )
  const indent = index === null ? "" : "   "
  if (asString(post.url)) lines.push(`${indent}URL: ${asString(post.url)}${id ? ` (post ${id})` : ""}`)
  const forwarded = asRecord(post.forwarded_from)
  if (forwarded) {
    const from = cleanText(forwarded.name) ?? cleanText(forwarded.author_name) ?? asString(forwarded.handle) ?? asString(forwarded.url)
    if (from) lines.push(`${indent}Forwarded from: ${from}${asString(forwarded.url) && asString(forwarded.url) !== from ? ` (${asString(forwarded.url)})` : ""}`)
  } else if (typeof post.forwarded_from === "string" && post.forwarded_from.trim()) {
    lines.push(`${indent}Forwarded from: ${post.forwarded_from.trim()}`)
  }
  const media = asArray(post.media)
  if (media.length) {
    const kinds = media.map((entry) => asString(asRecord(entry)?.type) ?? "media")
    lines.push(`${indent}Media: ${media.length} item${media.length === 1 ? "" : "s"} (${kinds.join(", ")}); previews only, downloadable URLs may be absent`)
  }
  const preview = asRecord(post.link_preview)
  if (preview) {
    const title = cleanText(preview.title) ?? cleanText(preview.site_name)
    const link = asString(preview.url)
    if (title || link) lines.push(`${indent}Link preview: ${title ?? ""}${title && link ? " — " : ""}${link ?? ""}`)
  }
  return lines
}

/** Public Telegram channel details, channel posts, or one post */
export const telegram = creditMetered({
  description:
    "Read public Telegram channels and groups via ScrapeCreators using Telegram's public web preview (no Telegram account or login). " +
    "kind='channel': name, description, verification, subscriber/member counts, media counters. kind='posts': one page of public posts (text, date, views, reactions when exposed, forwards, media previews, link previews) with a cursor for older pages. " +
    "kind='post': one public post by URL. Private and invite-only channels, groups, and posts are not supported. Requires SCRAPECREATORS_API_KEY; 1 credit per request, cache hits free with cache_max_age.",
  async execute(args: TelegramArgs, ctx: ToolContext) {
    const headers = scrapecreatorsHeaders()
    if (!headers) return `ERROR: ${MISSING_KEY_ERROR}`
    const invalid =
      validateEnum("kind", args.kind, TELEGRAM_KIND_VALUES) ??
      validateEnum("cache_max_age", args.cache_max_age, CACHE_MAX_AGE_VALUES)
    if (invalid) return `ERROR: ${invalid}`
    const kind = args.kind as (typeof TELEGRAM_KIND_VALUES)[number]
    const cacheMaxAge = args.cache_max_age

    if (kind === "post") {
      if (args.handle !== undefined) return "ERROR: handle applies to kind='channel' or 'posts'; kind='post' takes url."
      if (args.cursor !== undefined || args.limit !== undefined) return "ERROR: cursor and limit apply to kind='posts' only."
      if (!args.url?.trim()) return "ERROR: url is required for kind='post'."
      const normalized = normalizeTelegramPostUrl(args.url)
      if ("error" in normalized) return `ERROR: ${normalized.error}`
      const response = await scrapecreatorsRequest(
        "/v1/telegram/post",
        { url: normalized.url, cache_max_age: cacheMaxAge },
        headers,
        ctx,
        "ScrapeCreators Telegram post",
      )
      if (!response.ok) return failText(response)
      const lines = [`Telegram post: ${normalized.url}`, "Source: Telegram public post widget; fields Telegram does not expose are reported as such.", provenanceLine(response.payload), "", ...telegramPostLines(response.payload, null)]
      return {
        text: lines.join("\n"),
        details: {
          provider: "scrapecreators",
          kind,
          url: normalized.url,
          post_id: asString(response.payload.id),
          channel_handle: asString(response.payload.channel_handle),
          cached: response.payload.cached === true,
          credits_charged: asNumber(response.payload.credits_charged),
        },
      }
    }

    if (args.url !== undefined) return "ERROR: url applies to kind='post'; use handle for channels."
    if (!args.handle?.trim()) return `ERROR: handle is required for kind='${kind}'.`
    const normalized = normalizeTelegramHandle(args.handle)
    if ("error" in normalized) return `ERROR: ${normalized.error}`
    const handle = normalized.handle

    if (kind === "channel") {
      if (args.cursor !== undefined || args.limit !== undefined) return "ERROR: cursor and limit apply to kind='posts' only."
      const response = await scrapecreatorsRequest(
        "/v1/telegram/channel",
        { handle, cache_max_age: cacheMaxAge },
        headers,
        ctx,
        "ScrapeCreators Telegram channel",
      )
      if (!response.ok) return failText(response)
      const lines = [`Telegram channel lookup: @${handle}`, "Source: Telegram public web preview; no logged-in account.", provenanceLine(response.payload), "", ...telegramChannelLines(response.payload)]
      return {
        text: lines.join("\n"),
        details: {
          provider: "scrapecreators",
          kind,
          handle,
          subscriber_count: asNumber(response.payload.subscriber_count),
          member_count: asNumber(response.payload.member_count),
          cached: response.payload.cached === true,
          credits_charged: asNumber(response.payload.credits_charged),
        },
      }
    }

    const cursor = args.cursor?.trim()
    if (cursor && !/^\d+$/.test(cursor)) return "ERROR: cursor must be the numeric cursor returned by the previous posts page."
    const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
    const response = await scrapecreatorsRequest(
      "/v1/telegram/channel/posts",
      { handle, cursor: cursor || undefined, cache_max_age: cacheMaxAge },
      headers,
      ctx,
      "ScrapeCreators Telegram channel posts",
    )
    if (!response.ok) return failText(response)
    const listed = expectArray(response.payload, "posts", "ScrapeCreators Telegram channel posts")
    if (!listed.ok) return `ERROR: ${listed.error}`
    const posts = listed.items.map(asRecord).filter((r): r is Record<string, unknown> => r !== null)
    // The live page (2026-09-15) arrives in ascending chronology, so the display
    // cap must apply after ordering newest-first; posts without a parseable
    // published_at are kept but listed last, explicitly unranked.
    const dated = posts
      .map((post) => ({ post, at: Date.parse(asString(post.published_at) ?? "") }))
    const ordered = [
      ...dated.filter((entry) => !Number.isNaN(entry.at)).sort((a, b) => b.at - a.at).map((entry) => entry.post),
      ...dated.filter((entry) => Number.isNaN(entry.at)).map((entry) => entry.post),
    ]
    const undated = dated.filter((entry) => Number.isNaN(entry.at)).length
    const shown = ordered.slice(0, limit)
    const nextCursor = asString(response.payload.cursor) ?? (asNumber(response.payload.cursor) !== null ? String(response.payload.cursor) : null)
    const hasMore = typeof response.payload.has_more === "boolean" ? response.payload.has_more : null
    const channel = asRecord(response.payload.channel)
    const lines = [
      `Telegram channel posts: @${handle}${cursor ? ` (page before cursor ${cursor})` : " (latest page)"}`,
      "Source: Telegram public web preview; one page per request; reactions and media URLs are absent when Telegram does not expose them.",
      `Order: newest first by published_at within this page (the provider delivers the page oldest-first)${undated ? `; ${undated} post${undated === 1 ? "" : "s"} without a parseable date listed last, unranked` : ""}.`,
      provenanceLine(response.payload),
      `Posts: ${shown.length} shown of ${posts.length} returned on this page`,
      hasMore === false
        ? "Older posts: provider reports this is the terminal page"
        : nextCursor
          ? `Older posts: pass cursor="${nextCursor}"${hasMore === null ? " (has_more not reported)" : ""}`
          : "Older posts: no cursor returned and has_more not reported; continuation unavailable",
    ]
    if (channel) lines.push("", ...telegramChannelLines(channel))
    if (shown.length === 0) lines.push("", "The provider returned an empty post list for this page.")
    for (const [index, post] of shown.entries()) lines.push("", ...telegramPostLines(post, index))
    return {
      text: lines.join("\n"),
      details: {
        provider: "scrapecreators",
        kind,
        handle,
        returned: posts.length,
        shown: shown.length,
        undated,
        cursor: hasMore === false ? null : nextCursor,
        has_more: hasMore,
        cached: response.payload.cached === true,
        credits_charged: asNumber(response.payload.credits_charged),
        post_ids: shown.map((post) => asString(post.id) ?? (asNumber(post.id) !== null ? String(post.id) : null)).filter((value): value is string => value !== null),
      },
    }
  },
} satisfies ToolSpec)
