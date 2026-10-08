/**
 * Meta's public Ad Library through ScrapeCreators (tool `facebook_ad_library`), one request per call.
 *
 * Endpoint contracts follow https://docs.scrapecreators.com/v1/facebook/adLibrary/<endpoint>.md (read 2026-10-08):
 * - kind='search': GET /v1/facebook/adLibrary/search/ads (query, sort_by, search_type, ad_type, country, language,
 *   status, media_type, start_date, end_date, cursor) → searchResults, searchResultsCount, cursor
 * - kind='company': GET /v1/facebook/adLibrary/company/ads (pageId or companyName, country, status, media_type,
 *   language, sort_by, start_date, end_date, cursor) → results, cursor
 * - kind='ad': GET /v1/facebook/adLibrary/ad (id or url, cache_max_age) → one ad, camelCase, at the root; its
 *   creative is in snapshot (snapshot.cards for multi-version ads) and regulated ads may carry aaa_info
 * - kind='companies': GET /v1/facebook/adLibrary/search/companies (query) → searchResults of pages with page_id
 * - kind='transcript': GET /v1/facebook/adLibrary/ad/transcript (id or url, cache_max_age) → data.transcript, which
 *   is null, with no credit charged, when the ad has no video or no transcript is available
 *
 * The search and company endpoints also take POST with the same parameters as a JSON body, which the docs advise
 * once a cursor grows too large after extensive pagination; continuation pages are sent that way, first pages by
 * GET, the docs' normal request. `trim` is never sent: what it removes is undocumented. Requests go through
 * facebookRequest, which never retries or follows a redirect.
 *
 * The library shows that an ad ran and what it said; it reports no clicks, conversions or other performance, and
 * impressions, spend and reach appear only where Meta discloses them. Creative text is shown in full; the whole
 * output is cut at OUTPUT_LIMIT with a pointer to the retained original.
 */
import {
  FACEBOOK_AD_KIND_VALUES,
  FACEBOOK_AD_MEDIA_TYPE_VALUES,
  FACEBOOK_AD_SEARCH_TYPE_VALUES,
  FACEBOOK_AD_SORT_VALUES,
  FACEBOOK_AD_STATUS_VALUES,
  FACEBOOK_AD_TYPE_VALUES,
} from "../facebook-ads-schemas.js"
import type { OutcomeStatus } from "../outcome.js"
import type { ToolContext, ToolSpec } from "../types.js"
import { facebookRequest } from "./facebook_http.js"
import {
  CACHE_MAX_AGE_VALUES,
  MISSING_KEY_ERROR,
  asArray,
  asNumber,
  asRecord,
  asString,
  creditMetered,
  expectArray,
  failText,
  fmtNum,
  isoDate,
  provenanceLine,
  scrapecreatorsHeaders,
  validateEnum,
  type QueryParams,
  type RequestContext,
} from "./scrapecreators.js"

type Kind = (typeof FACEBOOK_AD_KIND_VALUES)[number]
type Fields = Record<string, unknown>

interface AdLibraryArgs {
  kind: string
  query?: string
  page_id?: string
  company_name?: string
  ad_id?: string
  url?: string
  country?: string
  status?: string
  media_type?: string
  language?: string
  sort_by?: string
  start_date?: string
  end_date?: string
  search_type?: string
  ad_type?: string
  cursor?: string
  cache_max_age?: string
}
type ArgumentName = Exclude<keyof AdLibraryArgs, "kind">

const BASE_PATH = "/v1/facebook/adLibrary"
const LIBRARY_AD_URL = "https://www.facebook.com/ads/library?id="
/** The model-facing text is cut here; the complete response stays in the call's retained original. */
const OUTPUT_LIMIT = 60_000
const TRUNCATION_NOTE = "The complete response is this call's original response when raw retention is on; read it with library_read using the receipt's raw file."
const NUMERIC_ID = /^\d+$/
const TWO_LETTER_CODE = /^[A-Z]{2}$/
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const ALL_COUNTRIES = "ALL"
const UNKNOWN_CATEGORY = "UNKNOWN"
const DYNAMIC_PLACEHOLDER = /\{\{[^{}]+\}\}/

const EVIDENCE_SCOPE =
  "Evidence scope: the Ad Library shows that an ad ran, what it said, when, where and on which platforms. It reports no clicks, conversions, sales or other performance; impressions, spend and reach appear only where Meta discloses them. Run length and impression ranking are not proof that an ad worked or that its claims are true."
const MEDIA_NOTE =
  "Media: links are the Facebook CDN URLs as returned and may expire; other variants (SD, resized, watermarked) are in the call's original response. Dig has not viewed the images or watched the videos."
const DELIVERY_SHARES_NOTE =
  "Values are as Meta reports them: political and issue ad delivery values are fractional shares (0.08 = 8%), while regional transparency data may be absolute reach counts."

/** The arguments each kind takes; any other argument is refused rather than silently dropped. */
const LIST_FILTERS: readonly ArgumentName[] = ["country", "status", "media_type", "language", "sort_by", "start_date", "end_date", "cursor"]
const KIND_ARGUMENTS: Record<Kind, readonly ArgumentName[]> = {
  search: ["query", "search_type", "ad_type", ...LIST_FILTERS],
  company: ["page_id", "company_name", ...LIST_FILTERS],
  ad: ["ad_id", "url", "cache_max_age"],
  companies: ["query"],
  transcript: ["ad_id", "url", "cache_max_age"],
}
const ARGUMENT_NAMES = [...new Set(Object.values(KIND_ARGUMENTS).flat())]

// ---------------------------------------------------------------------------
// Argument handling
// ---------------------------------------------------------------------------

function misplacedArgument(args: AdLibraryArgs, kind: Kind): string | null {
  const accepted = KIND_ARGUMENTS[kind]
  const stray = ARGUMENT_NAMES.find((name) => args[name] !== undefined && !accepted.includes(name))
  return stray ? `${stray} does not apply to kind='${kind}', which takes ${accepted.join(", ")}.` : null
}

/** A real calendar day in YYYY-MM-DD form; 2025-02-30 is refused rather than sent. */
function isCalendarDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

interface ListFilters {
  params: QueryParams
  shown: string[]
}

/** The filters search and company share, validated and uppercased as the docs spell them, plus their display line. */
function listFilters(args: AdLibraryArgs): ListFilters | { error: string } {
  const country = args.country?.trim().toUpperCase() || undefined
  if (country && country !== ALL_COUNTRIES && !TWO_LETTER_CODE.test(country)) {
    return { error: "country must be one two-letter country code such as US, or ALL." }
  }
  const language = args.language?.trim().toUpperCase() || undefined
  if (language && !TWO_LETTER_CODE.test(language)) return { error: "language must be a two-letter language code such as EN or ES." }
  const start = args.start_date?.trim() || undefined
  const end = args.end_date?.trim() || undefined
  if (start && !isCalendarDay(start)) return { error: "start_date must be a date in YYYY-MM-DD form." }
  if (end && !isCalendarDay(end)) return { error: "end_date must be a date in YYYY-MM-DD form." }
  if (start && end && start > end) return { error: "start_date must not be after end_date." }
  const shown = [
    `status=${args.status ?? "ACTIVE (provider default)"}`,
    `country=${country ?? "ALL (provider default)"}`,
    `media_type=${args.media_type ?? "ALL (provider default)"}`,
    `sort_by=${args.sort_by ?? "total_impressions (provider default)"}`,
  ]
  if (language) shown.push(`language=${language}`)
  if (start) shown.push(`start_date=${start}`)
  if (end) shown.push(`end_date=${end}`)
  return {
    params: { country, status: args.status, media_type: args.media_type, language, sort_by: args.sort_by, start_date: start, end_date: end },
    shown,
  }
}

interface AdTarget {
  params: QueryParams
  id: string | null
  shown: string
}

/** One ad by numeric id or by its Ad Library URL (sent as given, after checking it names one ad). */
function adTarget(args: AdLibraryArgs, kind: Kind): AdTarget | { error: string } {
  const id = args.ad_id?.trim()
  const url = args.url?.trim()
  if (id && url) return { error: "Provide ad_id or url, not both." }
  if (!id && !url) return { error: `kind='${kind}' needs ad_id or an Ad Library url.` }
  if (id) {
    if (!NUMERIC_ID.test(id)) return { error: "ad_id must be the numeric Ad Library id (ad_archive_id)." }
    return { params: { id }, id, shown: `ad_id=${id}` }
  }
  const urlError = "url must be an Ad Library URL naming one ad, such as https://www.facebook.com/ads/library?id=702369045530963."
  let parsed: URL
  try {
    parsed = new URL(url!)
  } catch {
    return { error: urlError }
  }
  const named = parsed.searchParams.get("id")
  if (
    !/^https?:$/.test(parsed.protocol) ||
    !/(^|\.)facebook\.com$/i.test(parsed.hostname) ||
    !/^\/ads\/library\/?$/.test(parsed.pathname) ||
    parsed.username !== "" || parsed.password !== "" || parsed.port !== "" ||
    !named ||
    !NUMERIC_ID.test(named)
  ) {
    return { error: urlError }
  }
  return { params: { url: url! }, id: named, shown: `url=${url}` }
}

// ---------------------------------------------------------------------------
// Reading provider records
// ---------------------------------------------------------------------------

/** List results spell fields in snake_case; the single-ad endpoint uses camelCase. */
const field = (record: Fields, snake: string, camel: string): unknown => (record[snake] !== undefined ? record[snake] : record[camel])

/** An id as text. A number past 2^53 has already lost digits in JSON parsing, so it is not trusted. */
function idOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null
}

function libraryUrlId(value: unknown): string | null {
  const url = asString(value)
  if (!url) return null
  try {
    const id = new URL(url).searchParams.get("id")
    return id && NUMERIC_ID.test(id) ? id : null
  } catch {
    return null
  }
}

const adIdOf = (ad: Fields): string | null => idOf(field(ad, "ad_archive_id", "adArchiveID")) ?? libraryUrlId(ad.url)

const present = <T>(value: T | null | undefined | false | ""): value is T => value !== null && value !== undefined && value !== false && value !== ""

/** Strings in an array, or the values of a map such as the single-ad endpoint's `page_categories` ({id: name}). */
function strings(value: unknown): string[] {
  const record = asRecord(value)
  const items = Array.isArray(value) ? value : record ? Object.values(record) : []
  return items.map(asString).filter(present)
}

/** Ad text: a plain string (with `<br />` line breaks on the single-ad endpoint) or `{ text }` in list results. */
function creativeText(value: unknown): string | null {
  const raw = typeof value === "string" ? value : asString(asRecord(value)?.text)
  if (!raw?.trim()) return null
  return raw.replace(/<br\s*\/?>/gi, "\n")
}

function block(label: string, text: string, indent: string): string[] {
  return [`${indent}${label}:`, ...text.split("\n").map((line) => (line.trim() ? `${indent}  ${line}` : ""))]
}

/** A disclosed delivery figure as Meta gave it: text, a number, or a `{lower_bound, upper_bound}` range. */
function disclosed(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "string") return value.trim() || null
  const record = asRecord(value)
  if (!record) return null
  const lower = asNumber(record.lower_bound)
  const upper = asNumber(record.upper_bound)
  if (lower !== null || upper !== null) return `${lower ?? "?"}–${upper ?? "?"}`
  return Object.keys(record).length ? JSON.stringify(record) : null
}

const imageUrl = (media: Fields) =>
  asString(media.original_image_url) ?? asString(media.resized_image_url) ?? asString(media.watermarked_resized_image_url)
const videoUrl = (media: Fields) =>
  asString(media.video_hd_url) ?? asString(media.video_sd_url) ?? asString(media.watermarked_video_hd_url) ?? asString(media.watermarked_video_sd_url)

function mediaLines(images: Fields[], videos: Fields[], indent: string): string[] {
  return [
    ...images.map((image, index) => `${indent}Image ${index + 1}: ${imageUrl(image) ?? "(no URL returned)"}`),
    ...videos.map((video, index) => {
      const preview = asString(video.video_preview_image_url)
      return `${indent}Video ${index + 1}: ${videoUrl(video) ?? "(no URL returned)"}${preview ? ` (preview image ${preview})` : ""}`
    }),
  ]
}

const records = (...values: unknown[]): Fields[] => values.flatMap((value) => asArray(value).map(asRecord).filter(present))

interface Creative {
  lines: string[]
  media: number
  dynamic: boolean
}

/** A snapshot's or card's text, headline, link, call to action and media. */
function creativeLines(source: Fields, indent: string): Creative {
  const lines: string[] = []
  const body = creativeText(source.body)
  if (body) lines.push(...block("Text", body, indent))
  const headline = [asString(source.title) && `Headline: ${source.title}`, asString(source.link_description) && `Link description: ${source.link_description}`].filter(present)
  if (headline.length) lines.push(`${indent}${headline.join(" | ")}`)
  const link = asString(source.link_url)
  const caption = asString(source.caption)
  const cta = asString(source.cta_text)
  const action = [link && `Link: ${link}`, caption && `Caption: ${caption}`, cta && `Call to action: ${cta}`].filter(present)
  if (action.length) lines.push(`${indent}${action.join(" | ")}`)
  const images = records(source.images, source.extra_images)
  const videos = records(source.videos, source.extra_videos)
  // A card carries its own media fields rather than images/videos lists.
  if (!images.length && imageUrl(source)) images.push(source)
  if (!videos.length && videoUrl(source)) videos.push(source)
  lines.push(...mediaLines(images, videos, indent))
  return { lines, media: images.length + videos.length, dynamic: DYNAMIC_PLACEHOLDER.test(`${body ?? ""} ${asString(source.title) ?? ""}`) }
}

interface FormattedAd {
  lines: string[]
  media: number
}

/** One ad from any endpoint: identity, run, page, delivery disclosure and the creative in full. */
function adLines(ad: Fields, id: string, index: number | null): FormattedAd {
  const indent = index === null ? "" : "   "
  const snapshot = asRecord(ad.snapshot) ?? {}
  const pageName = asString(field(ad, "page_name", "pageName"))
  const pageId = idOf(field(ad, "page_id", "pageID"))
  const shownName = asString(snapshot.page_name)
  const shownId = idOf(snapshot.page_id)
  const active = field(ad, "is_active", "isActive")
  const lines = [
    `${index === null ? "" : `${index + 1}. `}${pageName ?? shownName ?? "(page name not returned)"} — ad ${id} — ${active === true ? "active" : active === false ? "inactive" : "status not reported"}`,
    `${indent}Ad Library: ${asString(ad.url) ?? `${LIBRARY_AD_URL}${id}`}`,
  ]

  const start = isoDate(field(ad, "start_date", "startDate"))
  const end = isoDate(field(ad, "end_date", "endDate"))
  const platforms = strings(field(ad, "publisher_platform", "publisherPlatform"))
  const format = asString(snapshot.display_format)
  lines.push(
    `${indent}${[`Ran: ${start ?? "start not reported"} → ${end ?? "end not reported"}`, platforms.length > 0 && `Platforms: ${platforms.join(", ")}`, format && `Format: ${format}`].filter(present).join(" | ")}`,
  )

  // The ad's page and the page the creative is shown as can differ (branded content, agencies); both are kept.
  const differs = pageName !== null && shownName !== null && (shownName !== pageName || (shownId !== null && pageId !== null && shownId !== pageId))
  const headId = pageId ?? (differs ? null : shownId)
  lines.push(
    `${indent}Page: ${pageName ?? shownName ?? "(not returned)"}${headId ? ` (page id ${headId})` : ""}${differs ? `; shown as ${shownName}${shownId ? ` (page id ${shownId})` : ""}` : ""}`,
  )
  const likes = asNumber(snapshot.page_like_count)
  const pageCategories = strings(snapshot.page_categories)
  const profile = [asString(snapshot.page_profile_uri), likes !== null && `${fmtNum(likes)} page likes`, pageCategories.length > 0 && pageCategories.join(", ")].filter(present)
  if (profile.length) lines.push(`${indent}${differs ? "Shown-as page profile" : "Profile"}: ${profile.join(" | ")}`)
  const branded = asRecord(snapshot.branded_content)
  const brandedName = asString(branded?.page_name)
  if (brandedName) lines.push(`${indent}Branded content with: ${brandedName}${asString(branded?.page_profile_uri) ? ` (${branded?.page_profile_uri})` : ""}`)
  const sponsor = asString(asRecord(snapshot.instagram_branded_content)?.instagram_bc_sponsor_name)
  if (sponsor) lines.push(`${indent}Instagram branded-content sponsor: ${sponsor}`)
  const disclaimer = [asString(snapshot.disclaimer_label) && `Disclaimer: ${snapshot.disclaimer_label}`, asString(snapshot.byline) && `Byline: ${snapshot.byline}`].filter(present)
  if (disclaimer.length) lines.push(`${indent}${disclaimer.join(" | ")}`)

  const categories = strings(ad.categories).filter((category) => category !== UNKNOWN_CATEGORY)
  if (categories.length) lines.push(`${indent}Categories: ${categories.join(", ")}`)
  const collationCount = asNumber(field(ad, "collation_count", "collationCount"))
  const collationId = idOf(field(ad, "collation_id", "collationID"))
  if (collationCount !== null && collationCount > 1) lines.push(`${indent}Related ads: ${collationCount} in Meta's group ${collationId ?? "(id not returned)"}`)
  const reached = strings(field(ad, "targeted_or_reached_countries", "targetedOrReachedCountries"))
  if (reached.length) lines.push(`${indent}Targeted or reached countries: ${reached.join(", ")}`)
  const political = strings(field(ad, "political_countries", "politicalCountries"))
  if (political.length) lines.push(`${indent}Political ad countries: ${political.join(", ")}`)
  if (field(ad, "contains_digital_created_media", "containsDigitallyCreatedMedia") === true) lines.push(`${indent}Meta label: contains digitally created or altered media`)
  if (field(ad, "page_is_deleted", "pageIsDeleted") === true) lines.push(`${indent}Page deleted`)

  const impressions = asString(field(asRecord(field(ad, "impressions_with_index", "impressionsWithIndex")) ?? {}, "impressions_text", "impressionsText"))
  const spend = disclosed(ad.spend)
  const reach = disclosed(field(ad, "reach_estimate", "reachEstimate"))
  const currency = asString(ad.currency)
  const delivery = [impressions && `impressions ${impressions}`, spend && `spend ${spend}${currency ? ` ${currency}` : ""}`, reach && `estimated audience ${reach}`].filter(present)
  lines.push(`${indent}${delivery.length ? `Delivery (Meta's disclosure): ${delivery.join(" | ")}` : "Delivery: no impressions, spend or reach disclosed in this record"}`)

  // Multi-version ads carry their creative in snapshot.cards rather than snapshot.body.
  const creative = creativeLines(snapshot, indent)
  const cards = records(snapshot.cards)
  let media = creative.media
  let dynamic = creative.dynamic
  lines.push(...creative.lines)
  for (const [cardIndex, card] of cards.entries()) {
    const cardCreative = creativeLines(card, `${indent}  `)
    lines.push(`${indent}Card ${cardIndex + 1}:`, ...cardCreative.lines)
    media += cardCreative.media
    dynamic ||= cardCreative.dynamic
  }
  const extraTexts = asArray(snapshot.extra_texts).map(creativeText).filter(present)
  for (const [textIndex, text] of extraTexts.entries()) lines.push(...block(`Extra text ${textIndex + 1}`, text, indent))
  const extraLinks = strings(snapshot.extra_links)
  if (extraLinks.length) lines.push(`${indent}Extra links: ${extraLinks.join(" | ")}`)
  if (!creativeText(snapshot.body) && !cards.length && !extraTexts.length) lines.push(`${indent}Text: none returned for this ad`)
  if (dynamic) lines.push(`${indent}Dynamic template: Meta fills the {{…}} placeholders per viewer; the text above is the template.`)
  return { lines, media }
}

/** Meta's regulated-ad transparency block (`aaa_info`) on the single-ad endpoint, values as reported. */
function transparencyLines(info: Fields): string[] {
  const lines = ["Transparency (Meta's regulated-ad data):", `  ${DELIVERY_SHARES_NOTE}`]
  const reach = asNumber(info.eu_total_reach)
  const scope = [typeof info.targets_eu === "boolean" && `Targets EU: ${info.targets_eu ? "yes" : "no"}`, reach !== null && `EU total reach: ${reach}`].filter(present)
  if (scope.length) lines.push(`  ${scope.join(" | ")}`)
  const ages = asRecord(info.age_audience)
  const audience = [
    asString(info.gender_audience) && `gender ${info.gender_audience}`,
    ages && (asNumber(ages.min) !== null || asNumber(ages.max) !== null) && `ages ${asNumber(ages.min) ?? "?"}–${asNumber(ages.max) ?? "?"}`,
  ].filter(present)
  if (audience.length) lines.push(`  Audience: ${audience.join(", ")}`)
  const locations = records(info.location_audience).map((location) => {
    const name = asString(location.name) ?? "(unnamed)"
    const extra = [asString(location.type), location.excluded === true && "excluded", asNumber(location.reach) !== null && `reach ${asNumber(location.reach)}`].filter(present)
    return `${name}${extra.length ? ` (${extra.join(", ")})` : ""}`
  })
  if (locations.length) lines.push(`  Locations: ${locations.join("; ")}`)
  for (const country of records(info.age_country_gender_reach_breakdown)) {
    const rows = records(country.age_gender_breakdowns).map((row) => {
      const values = (["male", "female", "unknown"] as const).flatMap((sex) => (asNumber(row[sex]) === null ? [] : [`${sex} ${asNumber(row[sex])}`]))
      return `${asString(row.age_range) ?? "?"}: ${values.length ? values.join(", ") : "no values"}`
    })
    if (rows.length) lines.push(`  Reach by age and gender, ${asString(country.country) ?? "country not named"}: ${rows.join("; ")}`)
  }
  const payers = records(info.payer_beneficiary_data).map((entry) => `payer ${asString(entry.payer) ?? "?"}, beneficiary ${asString(entry.beneficiary) ?? "?"}`)
  if (payers.length) lines.push(`  Payer and beneficiary: ${payers.join("; ")}`)
  if (info.has_violating_payer_beneficiary === true) lines.push("  Meta flags the payer or beneficiary as violating its rules")
  if (info.is_ad_taken_down === true) lines.push("  Meta reports the ad as taken down")
  return lines
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function result(status: OutcomeStatus, lines: string[], details: Fields) {
  const text = lines.join("\n")
  const truncated = text.length > OUTPUT_LIMIT
  return {
    status,
    text: truncated ? `${text.slice(0, OUTPUT_LIMIT)}\n[Truncated at ${OUTPUT_LIMIT} of ${text.length} characters. ${TRUNCATION_NOTE}]` : text,
    details: { provider: "scrapecreators", ...details, truncated },
  }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

async function listAds(kind: "search" | "company", args: AdLibraryArgs, headers: Record<string, string>, ctx: RequestContext) {
  const filters = listFilters(args)
  if ("error" in filters) return `ERROR: ${filters.error}`
  let target: QueryParams
  let subject: string
  if (kind === "search") {
    const query = args.query?.trim()
    if (!query) return "ERROR: query is required for kind='search'."
    target = { query, search_type: args.search_type, ad_type: args.ad_type }
    subject = `Facebook Ad Library search: "${query}"`
    if (args.search_type) filters.shown.push(`search_type=${args.search_type}`)
    if (args.ad_type) filters.shown.push(`ad_type=${args.ad_type}`)
  } else {
    const pageId = args.page_id?.trim()
    const companyName = args.company_name?.trim()
    if (pageId && companyName) return "ERROR: Provide page_id or company_name for kind='company', not both."
    if (!pageId && !companyName) return "ERROR: kind='company' needs page_id (exact) or company_name."
    if (pageId && !NUMERIC_ID.test(pageId)) return "ERROR: page_id must be the numeric Ad Library page id; find it with kind='companies'."
    target = pageId ? { pageId } : { companyName }
    subject = pageId
      ? `Facebook Ad Library ads for page id ${pageId}`
      : `Facebook Ad Library ads for company name "${companyName}" (resolved by the provider; check the advertiser pages below, or pass page_id for an exact advertiser)`
  }
  const cursor = args.cursor?.trim() || undefined
  const method = cursor ? "POST" : "GET"
  const label = kind === "search" ? "ScrapeCreators Facebook Ad Library search" : "ScrapeCreators Facebook Ad Library company ads"
  const response = await facebookRequest(
    kind === "search" ? `${BASE_PATH}/search/ads` : `${BASE_PATH}/company/ads`,
    { ...target, ...filters.params, cursor },
    headers,
    ctx,
    label,
    method,
  )
  if (!response.ok) return failText(response)
  const payload = response.payload
  const listed = expectArray(payload, kind === "search" ? "searchResults" : "results", label)
  if (!listed.ok) return `ERROR: ${listed.error}`

  const ads: Array<{ ad: Fields; id: string }> = []
  let unreadable = 0
  for (const entry of listed.items) {
    const ad = asRecord(entry)
    const id = ad ? adIdOf(ad) : null
    if (ad && id) ads.push({ ad, id })
    else unreadable += 1
  }
  // Entries without an ad id are unreadable, not absent: a page of only those is a payload the adapter cannot read.
  if (!ads.length && unreadable) {
    return `ERROR: ${label} returned an unexpected payload: none of the ${plural(unreadable, "entry", "entries")} carried an ad id (ad_archive_id)`
  }
  const nextCursor = asString(payload.cursor)
  const total = kind === "search" ? asNumber(payload.searchResultsCount) : null
  const pages = [...new Map(ads.map(({ ad }) => {
    const name = asString(ad.page_name) ?? "(name not returned)"
    const id = idOf(ad.page_id)
    return [`${name}|${id}`, { name, id }] as const
  })).values()]
  const formatted = ads.map(({ ad, id }, index) => adLines(ad, id, index))

  const lines = [
    subject,
    `Filters: ${filters.shown.join(" | ")}`,
    cursor ? "Page: continuation page (cursor sent by POST, as ScrapeCreators documents for long cursors)" : "Page: first page",
    `Order: as returned for ${args.sort_by ?? "total_impressions"}; no local re-ranking. One page per call; no further pages were fetched.`,
    provenanceLine(payload),
    `Ads on this page: ${ads.length}${total !== null ? ` | Ad Library result count reported: ${total}` : ""}`,
    nextCursor ? `Next page: pass cursor="${nextCursor}" with the same other arguments` : "Next page: no cursor returned; the provider gave no further page.",
  ]
  if (unreadable) lines.push(`Unreadable entries: ${plural(unreadable, "returned entry", "returned entries")} carried no ad id and ${unreadable === 1 ? "was" : "were"} skipped; see the retained original.`)
  if (kind === "company" && pages.length) lines.push(`Advertiser pages in these results: ${pages.map((page) => `${page.name}${page.id ? ` (${page.id})` : ""}`).join("; ")}`)
  lines.push(EVIDENCE_SCOPE)
  if (formatted.some((ad) => ad.media > 0)) lines.push(MEDIA_NOTE)

  const details = {
    kind,
    ...(kind === "search" ? { query: target.query } : { page_id: target.pageId ?? null, company_name: target.companyName ?? null }),
    filters: filters.shown,
    transport: method,
    returned: ads.length,
    unreadable,
    result_count: total,
    cursor: nextCursor,
    ad_ids: ads.map(({ id }) => id),
    page_ids: pages.map((page) => page.id).filter(present),
    credits_charged: asNumber(payload.credits_charged),
  }
  if (!ads.length) {
    lines.push(
      "",
      `The Ad Library returned no ads for this ${kind === "search" ? "query" : "advertiser"} and filter set.${args.status ? "" : " status defaults to ACTIVE, so inactive ads are not included unless status=ALL or INACTIVE."}`,
    )
    return result("empty", lines, details)
  }
  for (const ad of formatted) lines.push("", ...ad.lines)
  return result(unreadable ? "partial" : "success", lines, details)
}

async function adDetail(args: AdLibraryArgs, headers: Record<string, string>, ctx: RequestContext) {
  const target = adTarget(args, "ad")
  if ("error" in target) return `ERROR: ${target.error}`
  const label = "ScrapeCreators Facebook Ad Library ad"
  const response = await facebookRequest(`${BASE_PATH}/ad`, { ...target.params, cache_max_age: args.cache_max_age }, headers, ctx, label)
  if (!response.ok) return failText(response)
  const ad = response.payload
  const returnedId = adIdOf(ad)
  if (!returnedId || !asRecord(ad.snapshot) || !Object.keys(ad.snapshot as Fields).length) {
    return `ERROR: ${label} returned an unexpected payload: an identified ad with a nonempty snapshot is required`
  }
  if (returnedId !== target.id) return `ERROR: ${label} returned ad ${returnedId} instead of requested ad ${target.id}`
  const id = returnedId
  const formatted = adLines(ad, id, null)
  const lines = [`Facebook Ad Library ad ${id}`, `Requested: ${target.shown}`, provenanceLine(ad), EVIDENCE_SCOPE]
  if (formatted.media) lines.push(MEDIA_NOTE)
  lines.push("", ...formatted.lines)
  const info = asRecord(ad.aaa_info)
  if (info) lines.push("", ...transparencyLines(info))
  return result("success", lines, {
    kind: "ad",
    ad_id: returnedId ?? target.id,
    page_id: idOf(ad.pageID),
    active: typeof ad.isActive === "boolean" ? ad.isActive : null,
    transparency: info !== null,
    cached: ad.cached === true,
    credits_charged: asNumber(ad.credits_charged),
  })
}

async function adTranscript(args: AdLibraryArgs, headers: Record<string, string>, ctx: RequestContext) {
  const target = adTarget(args, "transcript")
  if ("error" in target) return `ERROR: ${target.error}`
  const label = "ScrapeCreators Facebook Ad Library transcript"
  const response = await facebookRequest(`${BASE_PATH}/ad/transcript`, { ...target.params, cache_max_age: args.cache_max_age }, headers, ctx, label)
  if (!response.ok) return failText(response)
  const payload = response.payload
  const data = asRecord(payload.data)
  if (!data) return `ERROR: ${label} returned an unexpected payload: \`data\` is ${payload.data === undefined ? "missing" : "not an object"}`
  const transcript = data.transcript
  if (transcript !== null && typeof transcript !== "string") {
    return `ERROR: ${label} returned an unexpected payload: \`data.transcript\` is ${transcript === undefined ? "missing" : `neither text nor null (${typeof transcript})`}`
  }
  const id = idOf(data.ad_id) ?? target.id
  const available = typeof data.transcript_available === "boolean" ? data.transcript_available : null
  const lines = [
    `Facebook ad transcript: ad ${id ?? "(id not returned)"}`,
    `Ad Library: ${asString(data.url) ?? (id ? `${LIBRARY_AD_URL}${id}` : target.shown)}`,
    provenanceLine(payload),
  ]
  const details = { kind: "transcript", ad_id: id, transcript_available: available, cached: payload.cached === true, credits_charged: asNumber(payload.credits_charged) }
  if (transcript === null || !transcript.trim()) {
    lines.push(
      "",
      `No transcript: the provider returned ${transcript === null ? "none (transcript: null" : "an empty transcript (transcript: \"\""}${available === null ? "" : `, transcript_available: ${available}`}). This does not show that the ad has no spoken words. The response's reported charge is shown above; a missing charge stays unknown.`,
    )
    return result("empty", lines, details)
  }
  lines.push(
    "Source: Facebook's captions when it exposes them, otherwise ScrapeCreators' transcription of the public video; the response does not say which. Dig has not watched the video.",
    "",
    ...block("Transcript", transcript, ""),
  )
  return result("success", lines, details)
}

async function companySearch(args: AdLibraryArgs, headers: Record<string, string>, ctx: RequestContext) {
  const query = args.query?.trim()
  if (!query) return "ERROR: query is required for kind='companies'."
  const label = "ScrapeCreators Facebook Ad Library company search"
  const response = await facebookRequest(`${BASE_PATH}/search/companies`, { query }, headers, ctx, label)
  if (!response.ok) return failText(response)
  const listed = expectArray(response.payload, "searchResults", label)
  if (!listed.ok) return `ERROR: ${listed.error}`
  const pages: Array<{ page: Fields; id: string }> = []
  let unreadable = 0
  for (const entry of listed.items) {
    const page = asRecord(entry)
    const id = page ? idOf(page.page_id) : null
    if (page && id) pages.push({ page, id })
    else unreadable += 1
  }
  if (!pages.length && unreadable) {
    return `ERROR: ${label} returned an unexpected payload: none of the ${plural(unreadable, "entry", "entries")} carried a page_id`
  }
  const lines = [
    `Facebook Ad Library advertiser search: "${query}"`,
    "Source: the Ad Library's page lookup; one request, no paging documented. A page listed here may have no ads running; pass its page_id to kind='company' for its ads.",
    provenanceLine(response.payload),
    `Pages returned: ${pages.length}`,
  ]
  if (unreadable) lines.push(`Unreadable entries: ${plural(unreadable, "returned entry", "returned entries")} carried no page_id and ${unreadable === 1 ? "was" : "were"} skipped; see the retained original.`)
  const details = {
    kind: "companies",
    query,
    returned: pages.length,
    unreadable,
    page_ids: pages.map(({ id }) => id),
    credits_charged: asNumber(response.payload.credits_charged),
  }
  if (!pages.length) {
    lines.push("", "The Ad Library returned no advertiser pages for this name.")
    return result("empty", lines, details)
  }
  for (const [index, { page, id }] of pages.entries()) {
    const likes = asNumber(page.likes)
    const facts = [
      asString(page.category),
      likes !== null && `${fmtNum(likes)} Facebook likes`,
      asString(page.verification) && `verification ${page.verification}`,
      asString(page.country) && `country ${page.country}`,
      page.page_is_deleted === true && "page deleted",
    ].filter(present)
    lines.push("", `${index + 1}. ${asString(page.name) ?? "(name not returned)"} — page id ${id}`)
    if (facts.length) lines.push(`   ${facts.join(" | ")}`)
    const alias = asString(page.page_alias)
    if (alias) lines.push(`   Facebook: https://www.facebook.com/${alias}`)
    const instagram = asString(page.ig_username)
    if (instagram) {
      const followers = asNumber(page.ig_followers)
      lines.push(`   Instagram: @${instagram}${followers !== null ? ` (${fmtNum(followers)} followers)` : ""}${page.ig_verification === true ? ", verified" : ""}`)
    }
  }
  return result(unreadable ? "partial" : "success", lines, details)
}

// ---------------------------------------------------------------------------
// facebook_ad_library
// ---------------------------------------------------------------------------

/** Meta Ad Library search, advertiser ads, ad details, advertiser lookup and ad transcripts; one request per call. */
export const library = creditMetered({
  description:
    "Read Meta's public Ad Library via ScrapeCreators, one request per call. " +
    "kind='search': ads matching a keyword, with status (provider default ACTIVE), country, media_type, language, date range, sort_by, exact-phrase search_type and political ad_type filters. " +
    "kind='company': one advertiser's ads by page_id (exact) or company_name (resolved by the provider), with the same filters. kind='companies': find advertiser pages and their page_id by name. " +
    "kind='ad': one ad's details by ad_id or Ad Library url, including Meta's EU and political transparency data when present. kind='transcript': one video ad's transcript (null, and free, when there is none). " +
    "search and company return one page and a cursor for the next. Creative text is shown in full with links, run dates, platforms and media URLs. " +
    "The library does not report performance; impressions, spend and reach appear only when Meta discloses them. " +
    "Requires SCRAPECREATORS_API_KEY; 1 credit per request, a transcript only when returned, ad and transcript cache hits free with cache_max_age.",
  async execute(args: AdLibraryArgs, ctx: ToolContext) {
    const headers = scrapecreatorsHeaders()
    if (!headers) return `ERROR: ${MISSING_KEY_ERROR}`
    const invalid =
      validateEnum("kind", args.kind ?? "", FACEBOOK_AD_KIND_VALUES) ??
      validateEnum("status", args.status, FACEBOOK_AD_STATUS_VALUES) ??
      validateEnum("media_type", args.media_type, FACEBOOK_AD_MEDIA_TYPE_VALUES) ??
      validateEnum("sort_by", args.sort_by, FACEBOOK_AD_SORT_VALUES) ??
      validateEnum("search_type", args.search_type, FACEBOOK_AD_SEARCH_TYPE_VALUES) ??
      validateEnum("ad_type", args.ad_type, FACEBOOK_AD_TYPE_VALUES) ??
      validateEnum("cache_max_age", args.cache_max_age, CACHE_MAX_AGE_VALUES)
    if (invalid) return `ERROR: ${invalid}`
    const kind = args.kind as Kind
    const misplaced = misplacedArgument(args, kind)
    if (misplaced) return `ERROR: ${misplaced}`
    switch (kind) {
      case "search":
      case "company":
        return listAds(kind, args, headers, ctx)
      case "ad":
        return adDetail(args, headers, ctx)
      case "transcript":
        return adTranscript(args, headers, ctx)
      case "companies":
        return companySearch(args, headers, ctx)
    }
  },
} satisfies ToolSpec)
