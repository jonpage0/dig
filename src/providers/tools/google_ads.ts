/**
 * Google's Ads Transparency Center through ScrapeCreators (tool `google_ad_library`), one request per call.
 *
 * Endpoint contracts follow https://docs.scrapecreators.com/v1/google/<endpoint>.md (read 2026-11-10):
 * - action='advertisers': GET /v1/google/adLibrary/advertisers/search (query, region; region defaults to US) →
 *   advertisers [{name, advertiser_id, region, number_of_ads_estimate}] and websites [{domain}]
 * - action='ads': GET /v1/google/company/ads (domain or advertiser_id, region, start_date, end_date, format, cursor)
 *   → ads [{advertiserId, creativeId, format, adUrl, advertiserName, imageUrl, firstShown, lastShown}], cursor,
 *   number_of_ads_estimate. 1 credit per request.
 * - action='detail': GET /v1/google/ad (url) → one ad at the root: advertiserId, creativeId, url, format,
 *   firstShown, lastShown, overallImpressions {min, max}, spend {currency, lower, upper} and targeting where Google
 *   publishes political-ad data, creativeRegions, regionStats, variations (best-effort; text by OCR). firstShown can
 *   be null here when the list gave a date.
 *
 * Not sent: the ads endpoint's topic, platform and get_ad_details (25 credits per request), and the detail
 * endpoint's cache_max_age. Requests go through scrapecreatorsRequest, which repeats only a retryable HTTP status.
 *
 * The library shows that a verified advertiser ran an ad, its format and where and when it was shown; it reports
 * no clicks or results. Text is shown in full; the whole output is cut at OUTPUT_LIMIT with a pointer to the
 * retained original, keeping the next-page line.
 */
import { GOOGLE_AD_ACTION_VALUES, GOOGLE_AD_FORMAT_VALUES } from "../ad-library-schemas.js"
import type { OutcomeStatus } from "../outcome.js"
import type { ToolContext, ToolSpec } from "../types.js"
import {
  MISSING_KEY_ERROR,
  asArray,
  asNumber,
  asRecord,
  asString,
  continuesAfter,
  creditMetered,
  expectArray,
  failText,
  fmtNum,
  isoDate,
  knownCharge,
  provenanceLine,
  scrapecreatorsHeaders,
  scrapecreatorsRequest,
  validateEnum,
  type QueryParams,
  type RequestContext,
} from "./scrapecreators.js"

type Action = (typeof GOOGLE_AD_ACTION_VALUES)[number]
type Fields = Record<string, unknown>

interface GoogleAdArgs {
  action?: string
  query?: string
  domain?: string
  advertiser_id?: string
  country?: string
  start_date?: string
  end_date?: string
  format?: string
  cursor?: string
  url?: string
  limit?: number
}
type ArgumentName = Exclude<keyof GoogleAdArgs, "action">

const TRANSPARENCY = "https://adstransparency.google.com"
/** The model-facing text is cut here; the complete response stays in the call's retained original. */
const OUTPUT_LIMIT = 60_000
const TRUNCATION_NOTE = "The complete response is this call's original response when raw retention is on; read it with library_read using the receipt's raw file."
const ADVERTISER_ID = /^AR\d+$/
const CREATIVE_ID = /^CR\d+$/
const TWO_LETTER_CODE = /^[A-Z]{2}$/
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

const EVIDENCE_SCOPE =
  "Evidence scope: Google's Ads Transparency Center shows that a verified advertiser ran an ad, its format, and where and when Google says it was shown. It reports no clicks, conversions or other results; impressions, spend and targeting appear only where Google publishes them. How long an ad ran is not proof that it worked or that its claims are true."
const MEDIA_NOTE = "Media: addresses as returned; Dig has not viewed the images or watched the videos."

/** The arguments each action takes; any other argument is refused rather than silently dropped. */
const ACTION_ARGUMENTS: Record<Action, readonly ArgumentName[]> = {
  advertisers: ["query", "country", "limit"],
  ads: ["domain", "advertiser_id", "country", "start_date", "end_date", "format", "cursor", "limit"],
  detail: ["url"],
}
const ARGUMENT_NAMES = [...new Set(Object.values(ACTION_ARGUMENTS).flat())]

const present = <T>(value: T | null | undefined | false | ""): value is T => value !== null && value !== undefined && value !== false && value !== ""
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
const records = (value: unknown): Fields[] => asArray(value).map(asRecord).filter(present)
const strings = (value: unknown): string[] => asArray(value).map(asString).filter(present)

function misplacedArgument(args: GoogleAdArgs, action: Action): string | null {
  const accepted = ACTION_ARGUMENTS[action]
  const stray = ARGUMENT_NAMES.find((name) => args[name] !== undefined && !accepted.includes(name))
  return stray ? `${stray} does not apply to action='${action}', which takes ${accepted.join(", ")}.` : null
}

/** A real calendar day in YYYY-MM-DD form; 2025-02-30 is refused rather than sent. */
function isCalendarDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function regionOf(args: GoogleAdArgs): { region?: string } | { error: string } {
  const region = args.country?.trim().toUpperCase() || undefined
  if (region && !TWO_LETTER_CODE.test(region)) return { error: "country must be one two-letter region code such as US." }
  return { region }
}

/** `{min, max}`, `{lower, upper}` or a plain figure, as Google gave it. */
function range(value: unknown): string | null {
  const plain = asNumber(value)
  if (plain !== null) return fmtNum(plain)
  const record = asRecord(value)
  if (!record) return asString(value)
  const low = asNumber(record.min ?? record.lower)
  const high = asNumber(record.max ?? record.upper)
  if (low === null && high === null) return null
  return `${low === null ? "?" : fmtNum(low)}–${high === null ? "?" : fmtNum(high)}`
}

function block(label: string, text: string, indent: string): string[] {
  return [`${indent}${label}:`, ...text.split("\n").map((line) => (line.trim() ? `${indent}  ${line}` : ""))]
}

const shownDates = (ad: Fields) => `Shown: ${isoDate(ad.firstShown) ?? "first date not returned"} → ${isoDate(ad.lastShown) ?? "last date not returned"}`

/** `tail` (the next-page line) is kept after a cut, so a shortened page still says how to continue. */
function result(status: OutcomeStatus, lines: string[], details: Fields, tail?: string) {
  const text = lines.join("\n")
  const truncated = text.length > OUTPUT_LIMIT
  const body = truncated ? `${text.slice(0, OUTPUT_LIMIT)}\n[Truncated at ${OUTPUT_LIMIT} of ${text.length} characters. ${TRUNCATION_NOTE}]` : text
  return {
    // Text cut by Dig's own limit is part of the answer not delivered: partial.
    status: truncated && status === "success" ? "partial" as const : status,
    text: tail ? `${body}\n\n${tail}` : body,
    details: { provider: "scrapecreators", ...details, truncated },
  }
}

const shownCount = (shown: number, returned: number, noun: string, limit: number | undefined) =>
  `${noun}: ${returned}${shown < returned ? ` | ${shown} shown of ${returned} returned (limit=${limit})` : ""}`

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function advertisers(args: GoogleAdArgs, headers: Record<string, string>, ctx: RequestContext) {
  const query = args.query?.trim()
  if (!query) return "ERROR: query is required for action='advertisers'."
  const region = regionOf(args)
  if ("error" in region) return `ERROR: ${region.error}`
  const label = "ScrapeCreators Google Ad Library advertiser search"
  const response = await scrapecreatorsRequest("/v1/google/adLibrary/advertisers/search", { query, region: region.region }, headers, ctx, label)
  if (!response.ok) return failText(response)
  const listed = expectArray(response.payload, "advertisers", label)
  if (!listed.ok) return `ERROR: ${listed.error}`
  const found: Array<{ advertiser: Fields; id: string }> = []
  let unreadable = 0
  for (const entry of listed.items) {
    const advertiser = asRecord(entry)
    const id = asString(advertiser?.advertiser_id)
    if (advertiser && id) found.push({ advertiser, id })
    else unreadable += 1
  }
  if (!found.length && unreadable) return `ERROR: ${label} returned an unexpected payload: none of the ${plural(unreadable, "entry", "entries")} carried an advertiser_id`
  const shown = args.limit === undefined ? found : found.slice(0, args.limit)
  const websites = records(response.payload.websites).map((site) => asString(site.domain)).filter(present)
  const lines = [
    `Google Ad Library advertiser search: "${query}"`,
    `Region: ${region.region ?? "US (provider default)"}. One request; no paging documented. Several advertiser accounts can share a name: check the region and the ads before relying on one.`,
    provenanceLine(response.payload, response.charges),
    shownCount(shown.length, found.length, "Advertisers returned", args.limit),
  ]
  if (unreadable) lines.push(`Unreadable entries: ${plural(unreadable, "returned entry", "returned entries")} carried no advertiser_id and ${unreadable === 1 ? "was" : "were"} skipped; see the retained original.`)
  if (websites.length) lines.push(`Websites Google associates with this search: ${websites.join(", ")}`)
  const details = { action: "advertisers", query, region: region.region ?? null, returned: found.length, shown: shown.length, unreadable, advertiser_ids: shown.map(({ id }) => id), websites, credits_charged: knownCharge(response.charges) }
  if (!found.length) {
    lines.push("", "The Ads Transparency Center returned no advertisers for this name in this region.")
    return result("empty", lines, details)
  }
  for (const [index, { advertiser, id }] of shown.entries()) {
    const estimate = asNumber(advertiser.number_of_ads_estimate)
    const facts = [
      asString(advertiser.region) && `region ${advertiser.region}`,
      estimate !== null && `about ${fmtNum(estimate)} ads (Google's estimate)`,
    ].filter(present)
    lines.push("", `${index + 1}. ${asString(advertiser.name) ?? "(name not returned)"} — advertiser id ${id}`)
    if (facts.length) lines.push(`   ${facts.join(" | ")}`)
    lines.push(`   Ads Transparency: ${TRANSPARENCY}/advertiser/${id}`)
  }
  return result(unreadable ? "partial" : "success", lines, details)
}

async function companyAds(args: GoogleAdArgs, headers: Record<string, string>, ctx: RequestContext) {
  const domain = args.domain?.trim().toLowerCase() || undefined
  const advertiserId = args.advertiser_id?.trim() || undefined
  if (domain && advertiserId) return "ERROR: Provide domain or advertiser_id for action='ads', not both."
  if (!domain && !advertiserId) return "ERROR: action='ads' needs domain or advertiser_id."
  if (domain && !DOMAIN.test(domain)) return "ERROR: domain must be a website domain such as lululemon.com, without https:// or a path."
  if (advertiserId && !ADVERTISER_ID.test(advertiserId)) return "ERROR: advertiser_id must be Google's advertiser id, AR followed by digits; find it with action='advertisers'."
  const region = regionOf(args)
  if ("error" in region) return `ERROR: ${region.error}`
  const start = args.start_date?.trim() || undefined
  const end = args.end_date?.trim() || undefined
  if (start && !isCalendarDay(start)) return "ERROR: start_date must be a date in YYYY-MM-DD form."
  if (end && !isCalendarDay(end)) return "ERROR: end_date must be a date in YYYY-MM-DD form."
  if (start && end && start > end) return "ERROR: start_date must not be after end_date."
  const cursor = args.cursor?.trim() || undefined
  const label = "ScrapeCreators Google Ad Library company ads"
  const params: QueryParams = { domain, advertiser_id: advertiserId, region: region.region, start_date: start, end_date: end, format: args.format, cursor }
  const response = await scrapecreatorsRequest("/v1/google/company/ads", params, headers, ctx, label)
  if (!response.ok) return failText(response)
  const payload = response.payload
  const listed = expectArray(payload, "ads", label)
  if (!listed.ok) return `ERROR: ${listed.error}`
  const ads: Array<{ ad: Fields; id: string }> = []
  let unreadable = 0
  for (const entry of listed.items) {
    const ad = asRecord(entry)
    const id = asString(ad?.creativeId)
    if (ad && id) ads.push({ ad, id })
    else unreadable += 1
  }
  if (!ads.length && unreadable) return `ERROR: ${label} returned an unexpected payload: none of the ${plural(unreadable, "entry", "entries")} carried a creativeId`
  const shown = args.limit === undefined ? ads : ads.slice(0, args.limit)
  const next = asString(payload.cursor)
  const estimate = asNumber(payload.number_of_ads_estimate)
  const filters = [`region=${region.region ?? "anywhere (provider default)"}`, start && `start_date=${start}`, end && `end_date=${end}`, args.format && `format=${args.format}`].filter(present)
  const lines = [
    `Google Ad Library ads for ${domain ? `domain ${domain}` : `advertiser id ${advertiserId}`}`,
    `Filters: ${filters.join(" | ")} | ${cursor ? "continuation page" : "first page"}`,
    provenanceLine(payload, response.charges),
    `${shownCount(shown.length, ads.length, "Ads returned", args.limit)}${estimate !== null ? ` | Google's estimate of this advertiser's ads: ${fmtNum(estimate)}` : ""}`,
  ]
  if (unreadable) lines.push(`Unreadable entries: ${plural(unreadable, "returned entry", "returned entries")} carried no creativeId and ${unreadable === 1 ? "was" : "were"} skipped; see the retained original.`)
  lines.push(EVIDENCE_SCOPE)
  const details = {
    action: "ads",
    domain: domain ?? null,
    advertiser_id: advertiserId ?? null,
    filters,
    returned: ads.length,
    shown: shown.length,
    unreadable,
    cursor: next,
    creative_ids: shown.map(({ id }) => id),
    advertiser_ids: [...new Set(shown.map(({ ad }) => asString(ad.advertiserId)).filter(present))],
    credits_charged: knownCharge(response.charges),
  }
  if (!ads.length) {
    lines.push("", "The Ads Transparency Center returned no ads for this advertiser and filter set. Ads that need a Google login to view are not available here.")
    return result("empty", lines, details)
  }
  lines.push("The list gives no ad text or regions; read action='detail' for the ads the answer rests on.")
  if (shown.some(({ ad }) => asString(ad.imageUrl))) lines.push(MEDIA_NOTE)
  for (const [index, { ad, id }] of shown.entries()) {
    lines.push(
      "",
      `${index + 1}. ${asString(ad.advertiserName) ?? "(advertiser not returned)"} — creative ${id} — ${asString(ad.format) ?? "format not returned"}`,
      `   ${shownDates(ad)}`,
    )
    const image = asString(ad.imageUrl)
    if (image) lines.push(`   Preview image: ${image}`)
    const advertiser = asString(ad.advertiserId)
    lines.push(`   Ads Transparency: ${asString(ad.adUrl) ?? (advertiser ? `${TRANSPARENCY}/advertiser/${advertiser}/creative/${id}` : "(address not returned)")}`)
  }
  const tail = next
    ? `Next page: pass cursor="${next}" with the same other arguments${continuesAfter(shown.length, ads.length, "ads")}.`
    : "Next page: no cursor returned; the provider gave no further page."
  return result(unreadable ? "partial" : "success", lines, details, tail)
}

/** One ad by its Ads Transparency Center address, sent as given after checking it names one ad. */
function adTarget(value: string | undefined): { url: string; advertiser: string; creative: string } | { error: string } {
  const url = value?.trim()
  if (!url) return { error: "url is required for action='detail'." }
  const error = `url must be an Ads Transparency Center address naming one ad, such as ${TRANSPARENCY}/advertiser/AR07541154843046445057/creative/CR17778900238552006657.`
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { error }
  }
  const match = /^\/advertiser\/(AR\d+)\/creative\/(CR\d+)\/?$/.exec(parsed.pathname)
  if (parsed.protocol !== "https:" || parsed.hostname !== "adstransparency.google.com" || parsed.username || parsed.password || parsed.port || !match) return { error }
  return { url, advertiser: match[1]!, creative: match[2]! }
}

function targetingLines(targeting: Fields): string[] {
  const lines: string[] = []
  for (const [name, value] of Object.entries(targeting)) {
    const criterion = asRecord(value)
    if (!criterion) continue
    const names = (list: unknown) => [...strings(list), ...records(list).map((place) => {
      const codes = strings(place.countryCodes)
      return `${asString(place.fullName) ?? asString(place.name) ?? "?"}${codes.length ? ` (${codes.join(", ")})` : ""}`
    })]
    const included = names(criterion.included)
    const excluded = names(criterion.excluded)
    if (included.length || excluded.length) lines.push(`  ${name}: ${included.length ? `included ${included.join("; ")}` : "no inclusions listed"}${excluded.length ? `; excluded ${excluded.join("; ")}` : ""}`)
  }
  return lines
}

const VARIATION_FIELDS: ReadonlyArray<[string, string]> = [["headline", "Headline"], ["description", "Description"], ["allText", "All text (OCR)"], ["destinationUrl", "Destination"]]

async function adDetail(args: GoogleAdArgs, headers: Record<string, string>, ctx: RequestContext) {
  const target = adTarget(args.url)
  if ("error" in target) return `ERROR: ${target.error}`
  const label = "ScrapeCreators Google Ad Library ad"
  const response = await scrapecreatorsRequest("/v1/google/ad", { url: target.url }, headers, ctx, label)
  if (!response.ok) return failText(response)
  const ad = response.payload
  const creative = asString(ad.creativeId)
  if (!creative) return `ERROR: ${label} returned an unexpected payload: an ad with a creativeId is required`
  if (creative !== target.creative) return `ERROR: ${label} returned creative ${creative} instead of requested creative ${target.creative}`
  const advertiser = asString(ad.advertiserId) ?? target.advertiser
  const lines = [
    `Google Ad Library ad ${creative}`,
    `Ads Transparency: ${asString(ad.url) ?? target.url}`,
    provenanceLine(ad, response.charges),
    EVIDENCE_SCOPE,
    "",
    `Advertiser id: ${advertiser} | Format: ${asString(ad.format) ?? "not returned"}`,
    `${shownDates(ad)}${ad.firstShown === null ? " (Google left the first date out of this record; an ads list may still give it)" : ""}`,
  ]
  const impressions = range(ad.overallImpressions)
  if (impressions) lines.push(`Impressions (Google's range): ${impressions}`)
  const spend = asRecord(ad.spend)
  const spent = spend && range(spend)
  if (spent) lines.push(`Spend (Google's range): ${spent}${asString(spend?.currency) ? ` ${spend?.currency}` : ""}`)
  const targeting = asRecord(ad.targeting)
  const targeted = targeting ? targetingLines(targeting) : []
  if (targeted.length) lines.push("Targeting (as Google publishes it):", ...targeted)
  const creativeRegions = records(ad.creativeRegions).map((region) => `${asString(region.regionName) ?? "?"}${asString(region.regionCode) ? ` (${region.regionCode})` : ""}`)
  if (creativeRegions.length) lines.push(`Regions: ${creativeRegions.join(", ")}`)
  for (const stat of records(ad.regionStats)) {
    const shown = range(stat.impressions)
    const platforms = records(stat.platformImpressions).map((platform) => `${asString(platform.platform) ?? asString(platform.name) ?? "?"} ${range(platform.impressions) ?? range(platform) ?? "?"}`)
    lines.push(
      `Region ${asString(stat.regionName) ?? asString(stat.regionCode) ?? "?"}: ${isoDate(stat.firstShown) ?? "?"} → ${isoDate(stat.lastShown) ?? "?"}${shown ? ` | impressions ${shown}` : ""}${platforms.length ? ` | by platform: ${platforms.join(", ")}` : ""}`,
    )
  }
  const variations = records(ad.variations)
  let media = 0
  for (const [index, variation] of variations.entries()) {
    lines.push("", `Variation ${index + 1}:`)
    for (const [key, name] of VARIATION_FIELDS) {
      const value = asString(variation[key])
      if (value) lines.push(...(value.includes("\n") ? block(name, value, "  ") : [`  ${name}: ${value}`]))
    }
    const images = [asString(variation.imageUrl), ...strings(variation.images), ...records(variation.images).map((image) => asString(image.url) ?? asString(image.imageUrl))].filter(present)
    const videos = [asString(variation.videoUrl), ...strings(variation.videos)].filter(present)
    images.forEach((image, number) => lines.push(`  Image ${number + 1}: ${image}`))
    videos.forEach((video, number) => lines.push(`  Video ${number + 1}: ${video}`))
    media += images.length + videos.length
    for (const [key, value] of Object.entries(variation)) {
      if (["imageUrl", "images", "videoUrl", "videos", ...VARIATION_FIELDS.map(([field]) => field)].includes(key)) continue
      const shown = asString(value) ?? (typeof value === "number" || typeof value === "boolean" ? String(value) : null)
      if (shown) lines.push(`  ${key}: ${shown}`)
    }
  }
  if (!variations.length) lines.push("", "Variations: none returned (ScrapeCreators omits variations it cannot read).")
  else lines.push("", "Variation text is read from the creative by OCR and may contain errors; check the Ads Transparency address before quoting.")
  if (media) lines.push(MEDIA_NOTE)
  return result("success", lines, {
    action: "detail",
    advertiser_id: advertiser,
    creative_id: creative,
    variations: variations.length,
    political_data: spend !== null || targeted.length > 0,
    cached: ad.cached === true,
    credits_charged: knownCharge(response.charges),
  })
}

// ---------------------------------------------------------------------------
// google_ad_library
// ---------------------------------------------------------------------------

/** Google Ads Transparency Center advertiser search, an advertiser's ads and one ad's details; one request per call. */
export const library = creditMetered({
  description:
    "Read Google's Ads Transparency Center via ScrapeCreators, one request per call. " +
    "action='advertisers': advertisers and their advertiser_id matching a name, in one region (provider default US). " +
    "action='ads': one advertiser's ads by domain or advertiser_id, with country (region), start_date, end_date and format filters; one page and a cursor for the next. " +
    "action='detail': one ad by its Ads Transparency Center url, with its text variations (OCR), destination, media addresses, regions, dates, and impressions, spend and targeting where Google publishes them. " +
    "The whole returned page is shown unless limit narrows the display. The library reports no clicks or results. " +
    "Requires SCRAPECREATORS_API_KEY; 1 credit per request.",
  async execute(args: GoogleAdArgs, ctx: ToolContext) {
    const headers = scrapecreatorsHeaders()
    if (!headers) return `ERROR: ${MISSING_KEY_ERROR}`
    const invalid = validateEnum("action", args.action ?? "", GOOGLE_AD_ACTION_VALUES) ?? validateEnum("format", args.format, GOOGLE_AD_FORMAT_VALUES)
    if (invalid) return `ERROR: ${invalid}`
    const action = args.action as Action
    const misplaced = misplacedArgument(args, action)
    if (misplaced) return `ERROR: ${misplaced}`
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) return "ERROR: limit must be a positive whole number."
    switch (action) {
      case "advertisers":
        return advertisers(args, headers, ctx)
      case "ads":
        return companyAds(args, headers, ctx)
      case "detail":
        return adDetail(args, headers, ctx)
    }
  },
} satisfies ToolSpec)
