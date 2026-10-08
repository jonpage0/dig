/**
 * Public Facebook pages, posts, groups, video search and events via ScrapeCreators.
 *
 * Two tools for one catalog source: scrapecreators_facebook (pages, their posts, reels and photos,
 * native video search, one post, its transcript, comments and replies, groups and their posts) and
 * scrapecreators_facebook_events (a page's events, event search, a city's events, one event).
 * Every call is exactly one request for one page, through facebookRequest (never retried, never
 * redirected); continuation tokens are returned whole for the next call, so nothing crawls on its
 * own. No login is used: private and gated content stays unavailable.
 *
 * Endpoint contracts follow https://docs.scrapecreators.com/v1/facebook/<endpoint>.md (read 2026-10-08):
 * - GET /v1/facebook/profile (url, get_business_hours, include_gated_profile, cache_max_age). A
 *   private or 18+ gated page answers 200 with isPrivate: true and account_status "private" or
 *   "age-restricted"; a missing page answers 404 with accountDoesNotExist: true.
 * - GET /v1/facebook/profile/posts (url or pageId, cursor): 3 posts per page.
 * - GET /v1/facebook/profile/reels (up to 10 per page) and /profile/photos (url; cursor and
 *   next_page_id are only valid together).
 * - GET /v1/facebook/search/videos (query, cursor; has_more): Facebook's native public video and
 *   Reels search, not text or photo post search.
 * - GET /v1/facebook/post (url, cache_max_age) and /post/transcript (url, cache_max_age; videos
 *   under 2 minutes). The post page's description mentions get_comments and get_transcript, but its
 *   parameter list does not document them, so they are never sent; comments and transcripts are
 *   their own kinds.
 * - GET /v1/facebook/post/comments (url or feedback_id, cursor; has_next_page) and
 *   /post/comment/replies (feedback_id and expansion_token of a comment, cursor; has_next_page).
 * - GET /v1/facebook/group (url or group_id) and /group/posts (url or group_id, sort_by, cursor):
 *   3 posts per page from a public group.
 * - GET /v1/facebook/profile/events (url, cursor; has_next_page, total_count),
 *   /events/search (query, cursor), /events (a city's events URL, time, cursor) and
 *   /event/details (id or url).
 *
 * Provider content is untrusted evidence: text is kept verbatim (line breaks included) and the
 * whole result is cut only past OUTPUT_LIMIT, with a pointer to the retained original. Counts the
 * provider omits are "not reported", never 0. Media are links and metadata; nothing here watches a
 * video or looks at an image.
 */
import {
  FACEBOOK_CACHE_MAX_AGE_VALUES,
  FACEBOOK_EVENT_KINDS,
  FACEBOOK_EVENT_TIME_VALUES,
  FACEBOOK_GROUP_SORT_VALUES,
  FACEBOOK_KINDS,
} from "../facebook-schemas.js"
import type { OutcomeStatus } from "../outcome.js"
import type { SourceToolOutput, SourceToolResult, ToolContext, ToolSpec } from "../types.js"
import { facebookRequest } from "./facebook_http.js"
import {
  MISSING_KEY_ERROR,
  asArray,
  asNumber,
  asRecord,
  asString,
  creditMetered,
  expectArray,
  failText,
  fmtNum,
  provenanceLine,
  scrapecreatorsHeaders,
  validateEnum,
  type QueryParams,
  type ScrapeCreatorsResponse,
} from "./scrapecreators.js"

type Json = Record<string, unknown>
type FacebookKind = (typeof FACEBOOK_KINDS)[number]
type EventKind = (typeof FACEBOOK_EVENT_KINDS)[number]

/** The model-facing text is cut here; the complete response stays in the call's retained original. */
const OUTPUT_LIMIT = 60_000
const TRUNCATION_NOTE = "The complete response is this call's original response when raw retention is on; read it with library_read using the receipt's raw file."
const MEDIA_NOTE = "Media: links and metadata as Facebook returned them; Dig does not watch videos or look at images, and alt text is Facebook's automatic description."
const INDENT = "   "
const POSTS_PER_PAGE = 3
const REELS_PER_PAGE = 10
/** account_status values the profile endpoint documents for a gated page. */
const GATED_ACCOUNT_STATUSES = new Set(["private", "age-restricted"])
const NUMERIC_ID = /^\d+$/

interface FacebookArgs {
  kind: string
  url?: string
  page_id?: string
  group_id?: string
  feedback_id?: string
  expansion_token?: string
  query?: string
  cursor?: string
  next_page_id?: string
  sort_by?: string
  business_hours?: boolean
  include_gated_profile?: boolean
  cache_max_age?: string
}

interface FacebookEventsArgs {
  kind: string
  url?: string
  event_id?: string
  query?: string
  time?: string
  cursor?: string
}

interface KindSpec {
  path: string
  label: string
  /** Every argument the kind takes besides `kind`; any other argument given is refused before a request. */
  accepts: readonly string[]
}

const KINDS: Record<FacebookKind, KindSpec> = {
  profile: { path: "/v1/facebook/profile", label: "ScrapeCreators Facebook profile", accepts: ["url", "business_hours", "include_gated_profile", "cache_max_age"] },
  profile_posts: { path: "/v1/facebook/profile/posts", label: "ScrapeCreators Facebook profile posts", accepts: ["url", "page_id", "cursor"] },
  profile_reels: { path: "/v1/facebook/profile/reels", label: "ScrapeCreators Facebook profile reels", accepts: ["url", "cursor", "next_page_id"] },
  profile_photos: { path: "/v1/facebook/profile/photos", label: "ScrapeCreators Facebook profile photos", accepts: ["url", "cursor", "next_page_id"] },
  search_videos: { path: "/v1/facebook/search/videos", label: "ScrapeCreators Facebook video search", accepts: ["query", "cursor"] },
  post: { path: "/v1/facebook/post", label: "ScrapeCreators Facebook post", accepts: ["url", "cache_max_age"] },
  transcript: { path: "/v1/facebook/post/transcript", label: "ScrapeCreators Facebook transcript", accepts: ["url", "cache_max_age"] },
  comments: { path: "/v1/facebook/post/comments", label: "ScrapeCreators Facebook comments", accepts: ["url", "feedback_id", "cursor"] },
  replies: { path: "/v1/facebook/post/comment/replies", label: "ScrapeCreators Facebook comment replies", accepts: ["feedback_id", "expansion_token", "cursor"] },
  group: { path: "/v1/facebook/group", label: "ScrapeCreators Facebook group", accepts: ["url", "group_id"] },
  group_posts: { path: "/v1/facebook/group/posts", label: "ScrapeCreators Facebook group posts", accepts: ["url", "group_id", "sort_by", "cursor"] },
}

const EVENT_KINDS: Record<EventKind, KindSpec> = {
  profile: { path: "/v1/facebook/profile/events", label: "ScrapeCreators Facebook page events", accepts: ["url", "cursor"] },
  search: { path: "/v1/facebook/events/search", label: "ScrapeCreators Facebook event search", accepts: ["query", "cursor"] },
  city: { path: "/v1/facebook/events", label: "ScrapeCreators Facebook city events", accepts: ["url", "time", "cursor"] },
  details: { path: "/v1/facebook/event/details", label: "ScrapeCreators Facebook event details", accepts: ["url", "event_id"] },
}

// ---------------------------------------------------------------------------
// Arguments: every check runs before any request
// ---------------------------------------------------------------------------

interface PreparedRequest {
  params: QueryParams
  /** What the call reads, for the heading: a URL, an id or a quoted query. */
  target: string
}

type UrlShape = "page" | "post" | "group" | "city" | "event"

/** A trimmed nonblank string, or undefined. */
function given(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

/** A false boolean is the default, not a misplaced argument. */
function misplacedArgument(args: object, kind: string, accepts: readonly string[]): string | null {
  for (const [name, value] of Object.entries(args)) {
    if (name === "kind" || value === undefined || value === false || accepts.includes(name)) continue
    return `${name} does not apply to kind='${kind}'; it takes ${accepts.join(", ")}.`
  }
  return null
}

function shapeProblem(segments: string[], shape: UrlShape): string | null {
  const [first, second] = segments
  switch (shape) {
    case "page":
      if (first === "groups") return "url is a Facebook group; read it with kind='group' or 'group_posts'."
      if (first === "events") return "url is a Facebook event or events page; read it with scrapecreators_facebook_events kind='details' or 'city'."
      return first ? null : "url must name a Facebook page, not the facebook.com home page."
    case "post":
      return first ? null : "url must be a Facebook post or reel URL."
    case "group":
      return first === "groups" && second ? null : "url must be a Facebook group URL such as https://www.facebook.com/groups/<id or name>."
    case "city":
      return first === "events" && second === "explore" ? null : "url must be a city's Facebook Events page such as https://www.facebook.com/events/explore/<city>/<id>."
    case "event":
      return first === "events" && second && second !== "explore" ? null : "url must be a Facebook event URL such as https://www.facebook.com/events/<id>/."
  }
}

function facebookUrl(url: string | undefined, kind: string, shape: UrlShape): { url: string } | { error: string } {
  if (!url) return { error: `url is required for kind='${kind}'.` }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { error: "url must be a full facebook.com URL starting with https://." }
  }
  if (!/^https?:$/.test(parsed.protocol) || !/(^|\.)facebook\.com$/i.test(parsed.hostname) || parsed.username || parsed.password || parsed.port) return { error: "url must be a facebook.com URL." }
  const problem = shapeProblem(parsed.pathname.split("/").filter(Boolean), shape)
  return problem ? { error: problem } : { url }
}

/** Kinds that take a URL or an id: exactly one of them. */
function urlOrId(
  url: string | undefined,
  id: string | undefined,
  idName: string,
  kind: string,
  shape: UrlShape,
  numeric: boolean,
): { url?: string; id?: string; target: string } | { error: string } {
  if (url && id) return { error: `pass url or ${idName} for kind='${kind}', not both.` }
  if (id) {
    if (numeric && !NUMERIC_ID.test(id)) return { error: `${idName} must be the numeric Facebook id.` }
    return { id, target: `${idName} ${id}` }
  }
  if (!url) return { error: `url or ${idName} is required for kind='${kind}'.` }
  const checked = facebookUrl(url, kind, shape)
  return "error" in checked ? checked : { url: checked.url, target: checked.url }
}

function prepareFacebook(kind: FacebookKind, args: FacebookArgs): PreparedRequest | { error: string } {
  const url = given(args.url)
  const cursor = given(args.cursor)
  switch (kind) {
    case "profile": {
      const page = facebookUrl(url, kind, "page")
      if ("error" in page) return page
      return {
        params: {
          url: page.url,
          get_business_hours: args.business_hours === true ? "true" : undefined,
          include_gated_profile: args.include_gated_profile === true ? "true" : undefined,
          cache_max_age: args.cache_max_age,
        },
        target: page.url,
      }
    }
    case "profile_posts": {
      const source = urlOrId(url, given(args.page_id), "page_id", kind, "page", true)
      if ("error" in source) return source
      return { params: { url: source.url, pageId: source.id, cursor }, target: source.target }
    }
    case "profile_reels":
    case "profile_photos": {
      const page = facebookUrl(url, kind, "page")
      if ("error" in page) return page
      const nextPageId = given(args.next_page_id)
      if (Boolean(cursor) !== Boolean(nextPageId)) {
        return { error: `cursor and next_page_id go together for kind='${kind}': pass both from the previous page, or neither for the first page.` }
      }
      return { params: { url: page.url, cursor, next_page_id: nextPageId }, target: page.url }
    }
    case "search_videos": {
      const query = given(args.query)
      if (!query) return { error: "query is required for kind='search_videos'." }
      return { params: { query, cursor }, target: `"${query}"` }
    }
    case "post":
    case "transcript": {
      const post = facebookUrl(url, kind, "post")
      if ("error" in post) return post
      return { params: { url: post.url, cache_max_age: args.cache_max_age }, target: post.url }
    }
    case "comments": {
      const source = urlOrId(url, given(args.feedback_id), "feedback_id", kind, "post", false)
      if ("error" in source) return source
      return { params: { url: source.url, feedback_id: source.id, cursor }, target: source.target }
    }
    case "replies": {
      const feedbackId = given(args.feedback_id)
      const expansionToken = given(args.expansion_token)
      if (!feedbackId || !expansionToken) {
        return { error: "kind='replies' needs both feedback_id and expansion_token, as a comments page gives them for each comment (feedback_id is not the comment id)." }
      }
      return { params: { feedback_id: feedbackId, expansion_token: expansionToken, cursor }, target: `the comment with feedback_id ${feedbackId}` }
    }
    case "group":
    case "group_posts": {
      const source = urlOrId(url, given(args.group_id), "group_id", kind, "group", true)
      if ("error" in source) return source
      return { params: { url: source.url, group_id: source.id, sort_by: args.sort_by, cursor }, target: source.target }
    }
  }
}

function prepareEvents(kind: EventKind, args: FacebookEventsArgs): PreparedRequest | { error: string } {
  const url = given(args.url)
  const cursor = given(args.cursor)
  switch (kind) {
    case "profile": {
      const page = facebookUrl(url, kind, "page")
      if ("error" in page) return page
      return { params: { url: page.url, cursor }, target: page.url }
    }
    case "search": {
      const query = given(args.query)
      if (!query) return { error: "query is required for kind='search'." }
      return { params: { query, cursor }, target: `"${query}"` }
    }
    case "city": {
      const city = facebookUrl(url, kind, "city")
      if ("error" in city) return city
      return { params: { url: city.url, time: args.time, cursor }, target: city.url }
    }
    case "details": {
      const source = urlOrId(url, given(args.event_id), "event_id", kind, "event", true)
      if ("error" in source) return source
      return { params: { url: source.url, id: source.id }, target: source.target }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared reading and display
// ---------------------------------------------------------------------------

function idText(value: unknown): string | null {
  return asString(value) ?? (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null)
}

/** Unix seconds as an ISO timestamp; a provider string as written. */
function when(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value * 1000)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  return asString(value)
}

function count(value: unknown): string {
  const n = asNumber(value)
  return n === null ? "not reported" : fmtNum(n)
}

function seconds(ms: unknown): string | null {
  const n = asNumber(ms)
  return n === null ? null : `${(n / 1000).toFixed(1)}s`
}

/** A field of unknown shape, kept whole: strings as written, numbers, or JSON for anything else. */
function shown(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value : null
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (value === null || value === undefined) return null
  if (Array.isArray(value) && value.length === 0) return null
  return JSON.stringify(value)
}

function name(value: unknown): string | null {
  return asString(value)?.trim() ?? null
}

/** Multi-line provider text kept verbatim, each line indented under its item. */
function indented(text: string, indent: string = INDENT): string[] {
  return text.split(/\r?\n/).map((line) => (line ? `${indent}${line}` : ""))
}

function pushField(lines: string[], label: string, value: unknown, indent = ""): void {
  const text = shown(value)
  if (text !== null) lines.push(`${indent}${label}: ${text}`)
}

/** Nonzero reaction types as reported, e.g. "like 79, wow 11". */
function reactionBreakdown(value: unknown): string {
  const reactions = asRecord(value)
  if (!reactions) return ""
  return Object.entries(reactions)
    .map(([type, n]) => [type, asNumber(n)] as const)
    .filter((entry): entry is readonly [string, number] => entry[1] !== null && entry[1] > 0)
    .map(([type, n]) => `${type} ${fmtNum(n)}`)
    .join(", ")
}

interface Entries {
  entries: Json[]
  /** Each entry's identity, as readEntries decided it. */
  ids: string[]
  unreadable: number
}

/**
 * The records of a documented array. An entry with no id or URL is unreadable, never a result;
 * a page made only of such entries is an unreadable payload, not an empty page.
 */
function readEntries(
  payload: Json,
  key: string,
  label: string,
  identity: (entry: Json) => string | null,
): ({ ok: true } & Entries) | { ok: false; error: string } {
  const listed = expectArray(payload, key, label)
  if (!listed.ok) return listed
  const entries: Json[] = []
  const ids: string[] = []
  let unreadable = 0
  for (const item of listed.items) {
    const record = asRecord(item)
    const id = record ? identity(record) : null
    if (record && id) {
      entries.push(record)
      ids.push(id)
    } else unreadable += 1
  }
  if (entries.length === 0 && unreadable > 0) {
    return { ok: false, error: `${label} returned an unexpected payload: none of the ${unreadable} \`${key}\` entr${unreadable === 1 ? "y" : "ies"} carried an id or URL` }
  }
  return { ok: true, entries, ids, unreadable }
}

const byIdOrUrl = (entry: Json) => idText(entry.id) ?? asString(entry.url)

interface Continuation {
  line: string
  details: Json
}

/** One opaque cursor, with the page's has_more/has_next_page flag when the endpoint documents one. */
function cursorContinuation(payload: Json, same: string, flag?: "has_more" | "has_next_page"): Continuation {
  const cursor = asString(payload.cursor)
  const reported = flag ? payload[flag] : undefined
  const more = typeof reported === "boolean" ? reported : null
  const details = { cursor: more === false ? null : cursor, ...(flag ? { [flag]: more } : {}) }
  if (more === false) return { line: `Next page: none; the provider reports ${flag} false.`, details }
  if (cursor) return { line: `Next page: pass cursor="${cursor}" with ${same}${flag && more === null ? ` (${flag} not reported)` : ""}.`, details }
  return {
    line: more === true ? `Next page: ${flag} is true but no cursor came back; continuation unavailable.` : "Next page: no cursor returned; this is the last page or continuation is unavailable.",
    details,
  }
}

/** Reels and photos page only with both tokens of the previous page. */
function pairedContinuation(payload: Json): Continuation {
  const cursor = asString(payload.cursor)
  const nextPageId = asString(payload.next_page_id)
  const details = { cursor, next_page_id: nextPageId, continuation: Boolean(cursor && nextPageId) }
  if (cursor && nextPageId) return { line: `Next page: pass cursor="${cursor}" and next_page_id="${nextPageId}" with the same url.`, details }
  if (cursor || nextPageId) {
    return { line: `Next page: the provider returned only ${cursor ? "cursor" : "next_page_id"}; this endpoint needs both, so continuation is unavailable.`, details }
  }
  return { line: "Next page: no cursor or next_page_id returned; this is the last page or continuation is unavailable.", details }
}

interface ListPage {
  heading: string
  notes: string[]
  payload: Json
  noun: string
  read: Entries
  continuation: Continuation
  media: boolean
  render: (entry: Json, index: number) => string[]
  details: Json
}

function listResult(page: ListPage): SourceToolOutput {
  const { entries, ids, unreadable } = page.read
  const lines = [page.heading, ...page.notes, provenanceLine(page.payload)]
  lines.push(`${page.noun}: ${entries.length} on this page${unreadable ? `; ${unreadable} entr${unreadable === 1 ? "y" : "ies"} without an id or URL skipped` : ""}`)
  lines.push(page.continuation.line)
  if (page.media && entries.length) lines.push(MEDIA_NOTE)
  if (entries.length === 0) lines.push("", `The provider returned an empty ${page.noun.toLowerCase()} list for this page.`)
  for (const [index, entry] of entries.entries()) lines.push("", ...page.render(entry, index))
  return {
    status: unreadable ? "partial" : entries.length ? "success" : "empty",
    text: lines.join("\n"),
    details: {
      ...page.details,
      ...page.continuation.details,
      returned: entries.length,
      unreadable,
      cached: page.payload.cached === true,
      credits_charged: asNumber(page.payload.credits_charged),
      ids,
    },
  }
}

function bounded(result: SourceToolOutput): SourceToolOutput {
  const truncated = result.text.length > OUTPUT_LIMIT
  return {
    ...result,
    text: truncated ? `${result.text.slice(0, OUTPUT_LIMIT)}\n[Truncated at ${OUTPUT_LIMIT} of ${result.text.length} characters. ${TRUNCATION_NOTE}]` : result.text,
    details: { ...result.details, truncated },
  }
}

// ---------------------------------------------------------------------------
// scrapecreators_facebook
// ---------------------------------------------------------------------------

function profileResult(response: ScrapeCreatorsResponse, target: string, includeGated: boolean, base: Json): SourceToolResult {
  if (!response.ok) {
    if (!response.cancelled && response.payload?.accountDoesNotExist === true) {
      return {
        status: "empty",
        text: [`Facebook page: ${target}`, provenanceLine(response.payload), "Not found: the provider reports that this page does not exist (accountDoesNotExist)."].join("\n"),
        details: { ...base, available: false, not_found: true, credits_charged: asNumber(response.payload.credits_charged) },
      }
    }
    return failText(response)
  }
  const data = response.payload
  const accountStatus = asString(data.account_status)
  const gated = data.isPrivate === true || (accountStatus !== null && GATED_ACCOUNT_STATUSES.has(accountStatus))
  const id = idText(data.id)
  const pageName = name(data.name)
  if (!gated && !id && !pageName) return "ERROR: ScrapeCreators Facebook profile returned an unexpected payload: no id, name or gate status"
  const limited = gated && Boolean(id || pageName)
  const status: OutcomeStatus = !gated ? "success" : limited ? "partial" : "failed"

  const lines = [`Facebook page: ${pageName ?? "(name not returned)"}${id ? ` (id ${id})` : ""}`, `URL: ${asString(data.url) ?? target}`, provenanceLine(data)]
  if (gated) {
    const gate = accountStatus === "age-restricted" ? "an 18+ content gate" : "a private content gate"
    lines.push(
      `Access: gated (account_status: ${accountStatus ?? "not reported"}; isPrivate: ${data.isPrivate === true}). Facebook shows ${gate}, so the page's content is unavailable without a login, which Dig does not use. ` +
        (limited
          ? "Only the limited public fields below came back."
          : `No page fields came back${includeGated ? "" : "; include_gated_profile=true asks for the limited public fields Facebook still shows"}.`),
    )
  } else {
    lines.push(`Access: public${accountStatus ? ` (account_status: ${accountStatus})` : ""}; no login used.`)
  }
  pushField(lines, "Category", data.category)
  pushField(lines, "Intro", data.pageIntro)
  pushField(lines, "Created", data.creationDate)
  pushField(lines, "Address", data.address)
  pushField(lines, "Email", data.email)
  pushField(lines, "Phone", data.phone)
  pushField(lines, "Website", data.website)
  pushField(lines, "Services", data.services)
  pushField(lines, "Price range", data.priceRange)
  const ratingCount = asNumber(data.ratingCount)
  if (asString(data.rating)) lines.push(`Rating: ${asString(data.rating)}${ratingCount !== null ? ` (${fmtNum(ratingCount)} ratings)` : ""}`)
  if (!gated || limited) lines.push(`Likes: ${count(data.likeCount)} | Followers: ${count(data.followerCount)} | Talking about: ${count(data.talkingAboutCount)}`)
  const adLibrary = asRecord(data.adLibrary)
  if (adLibrary) {
    const adPageId = idText(adLibrary.pageId)
    lines.push(`Ad Library: ${asString(adLibrary.adStatus) ?? "status not reported"}${adPageId ? ` (Ad Library page id ${adPageId})` : ""}`)
  }
  const links = asArray(data.links).map(shown).filter((value): value is string => value !== null)
  if (links.length) lines.push("Links:", ...links.map((link) => `- ${link}`))
  const picture = asString(data.profilePicLarge) ?? asString(data.profilePicMedium) ?? asString(data.profilePicSmall)
  if (picture) lines.push(`Profile picture: ${picture}`)
  const coverPhoto = asRecord(asRecord(data.coverPhoto)?.photo)
  const coverImage = asString(asRecord(coverPhoto?.image)?.uri)
  if (coverImage) lines.push(`Cover photo: ${coverImage}${asString(coverPhoto?.url) ? ` (photo page ${asString(coverPhoto?.url)})` : ""}`)
  const hours = asArray(data.businessHours).flatMap((entry) =>
    Object.entries(asRecord(entry) ?? {}).map(([day, value]) => `- ${day}: ${asString(asRecord(value)?.fullText) ?? "(no hours text)"}`),
  )
  if (hours.length) lines.push("Business hours:", ...hours)
  if (picture || coverImage) lines.push(MEDIA_NOTE)

  return {
    status,
    text: lines.join("\n"),
    details: {
      ...base,
      id,
      name: pageName,
      available: !gated,
      gate: gated ? { account_status: accountStatus, is_private: data.isPrivate === true, limited_fields: limited } : null,
      cached: data.cached === true,
      credits_charged: asNumber(data.credits_charged),
    },
  }
}

/** A post from a page's or group's feed, with its video links and the top comments returned beside it. */
function feedPostLines(post: Json, index: number): string[] {
  const author = asRecord(post.author)
  const authorId = idText(author?.id)
  const published = when(post.publishTime)
  const lines = [`${index + 1}. ${name(author?.name) ?? "(author not returned)"}${authorId ? ` (id ${authorId})` : ""} — ${published ?? "publish time not reported"}`]
  const text = asString(post.text)
  lines.push(...(text ? indented(text) : [`${INDENT}(no text)`]))
  lines.push(`${INDENT}Reactions: ${count(post.reactionCount)} | Comments: ${count(post.commentCount)} | Video views: ${count(post.videoViewCount)}`)
  pushField(lines, "URL", post.url, INDENT)
  if (asString(post.permalink) && post.permalink !== post.url) pushField(lines, "Permalink", post.permalink, INDENT)
  pushField(lines, "Post id", idText(post.id), INDENT)
  const video = asRecord(post.videoDetails)
  if (video) {
    pushField(lines, "Video (SD)", video.sdUrl, INDENT)
    pushField(lines, "Video (HD)", video.hdUrl, INDENT)
    pushField(lines, "Video thumbnail", video.thumbnailUrl, INDENT)
  }
  const comments = asArray(post.topComments).map(asRecord).filter((comment): comment is Json => comment !== null)
  if (comments.length) {
    lines.push(`${INDENT}Top comments returned with the post:`)
    for (const comment of comments) {
      const commenter = asRecord(comment.author)
      const commentUrl = asString(commenter?.url)
      lines.push(`${INDENT}- ${name(commenter?.name) ?? "(author not returned)"}${commentUrl ? ` (${commentUrl})` : ""}, ${when(comment.publishTime) ?? "time not reported"}:`)
      const body = asString(comment.text)
      lines.push(...(body ? indented(body, `${INDENT}  `) : [`${INDENT}  (no text)`]))
    }
  }
  return lines
}

function reelLines(reel: Json, index: number): string[] {
  const author = asRecord(reel.author)
  const lines = [`${index + 1}. ${name(author?.name) ?? "(author not returned)"}${author?.is_verified === true ? " (verified)" : ""} — ${when(reel.creation_time) ?? "creation time not reported"}`]
  const description = asString(reel.description)
  lines.push(...(description ? indented(description) : [`${INDENT}(no description)`]))
  const duration = seconds(reel.play_time_in_ms)
  lines.push(`${INDENT}Views: ${count(reel.view_count)}${duration ? ` | Duration: ${duration}` : ""}`)
  pushField(lines, "URL", reel.url, INDENT)
  pushField(lines, "Video", reel.video_url, INDENT)
  pushField(lines, "Thumbnail", reel.thumbnail, INDENT)
  const music = asRecord(reel.music)
  if (asString(music?.track_title)) lines.push(`${INDENT}Music: ${asString(music?.track_title)}`)
  pushField(lines, "Post id", idText(reel.post_id), INDENT)
  pushField(lines, "Video id", idText(reel.video_id), INDENT)
  const feedbackId = asString(reel.feedback_id)
  if (feedbackId) lines.push(`${INDENT}Feedback id: ${feedbackId} (pass as feedback_id to kind='comments')`)
  return lines
}

function photoLines(photo: Json, index: number): string[] {
  const lines = [`${index + 1}. Photo ${idText(photo.photo_id) ?? idText(photo.id) ?? "(id not returned)"}`]
  pushField(lines, "URL", photo.url, INDENT)
  const image = asRecord(photo.viewer_image)
  if (asString(image?.uri)) {
    const width = asNumber(image?.width)
    const height = asNumber(image?.height)
    lines.push(`${INDENT}Image: ${asString(image?.uri)}${width !== null && height !== null ? ` (${width}×${height})` : ""}`)
  }
  pushField(lines, "Thumbnail", photo.thumbnail, INDENT)
  pushField(lines, "Alt text (Facebook's automatic description)", photo.accessibility_caption, INDENT)
  return lines
}

function searchVideoLines(video: Json, index: number): string[] {
  const author = asRecord(video.author)
  const lines = [`${index + 1}. ${name(video.title) ?? "(no title)"} — ${name(author?.name) ?? "(author not returned)"}`]
  const description = asString(video.description)
  if (description) lines.push(...indented(description))
  const published = when(video.publish_time)
  const created = when(video.creation_time)
  lines.push(`${INDENT}Published: ${published ?? "not reported"}${created && created !== published ? ` | Created: ${created}` : ""}`)
  pushField(lines, "Facebook's display text (not a normalized time)", video.relative_time_text, INDENT)
  const duration = seconds(video.duration_ms) ?? asString(video.duration_text)
  if (duration) lines.push(`${INDENT}Duration: ${duration}`)
  pushField(lines, "URL", video.url, INDENT)
  pushField(lines, "Author URL", author?.url, INDENT)
  pushField(lines, "Thumbnail", video.thumbnail_url, INDENT)
  pushField(lines, "Video id", idText(video.id), INDENT)
  return lines
}

function postResult(data: Json, target: string, base: Json): SourceToolResult {
  const postId = idText(data.post_id)
  const url = asString(data.url)
  if (!postId && !url) return "ERROR: ScrapeCreators Facebook post returned an unexpected payload: no post_id or url"
  const author = asRecord(data.author)
  const video = asRecord(data.video)
  const lines = [`Facebook post: ${url ?? target}`, provenanceLine(data)]
  if (author) {
    const handle = asString(author.handle)
    const authorUrl = asString(author.url)
    const authorId = idText(author.id)
    lines.push(
      `Author: ${name(author.name) ?? "(name not returned)"}${handle ? ` (@${handle})` : ""}${author.is_verified === true ? " (verified)" : ""}${authorUrl ? ` — ${authorUrl}` : ""}${authorId ? ` (id ${authorId})` : ""}`,
    )
  }
  lines.push(`Published: ${when(data.creation_time) ?? "not reported"}`)
  lines.push(`Likes: ${count(data.like_count)} | Comments: ${count(data.comment_count)} | Shares: ${count(data.share_count)} | Views: ${count(data.view_count)}`)
  if (video) {
    lines.push("Views note: for some reels this count is null or lower than the public badge on the page's Reels grid; kind='profile_reels' returns the badge count (match the reel by post id).")
  }
  pushField(lines, "Post id", postId)
  const feedbackId = asString(data.feedback_id)
  if (feedbackId) lines.push(`Feedback id: ${feedbackId} (pass as feedback_id to kind='comments' for a faster comments read)`)
  const description = asString(data.description)
  lines.push("Text:", ...(description ? indented(description) : [`${INDENT}(no text)`]))
  if (video) {
    lines.push("Video:")
    pushField(lines, "Video id", idText(video.id), INDENT)
    pushField(lines, "SD", video.sd_url, INDENT)
    pushField(lines, "HD", video.hd_url, INDENT)
    const width = asNumber(video.width)
    const height = asNumber(video.height)
    if (width !== null && height !== null) lines.push(`${INDENT}Size: ${width}×${height}`)
    const length = asNumber(video.length_in_second)
    if (length !== null) lines.push(`${INDENT}Length: ${length}s`)
    pushField(lines, "Thumbnail", video.thumbnail, INDENT)
    pushField(lines, "Captions file (not fetched)", video.captions_url, INDENT)
  }
  pushField(lines, "Image", data.image_url)
  const music = asRecord(data.music)
  if (asString(music?.track_title)) lines.push(`Music: ${asString(music?.track_title)}${asString(music?.type) ? ` (${asString(music?.type)})` : ""}`)
  if (video || asString(data.image_url)) lines.push(MEDIA_NOTE)
  return {
    status: "success",
    text: lines.join("\n"),
    details: {
      ...base,
      post_id: postId,
      url,
      feedback_id: feedbackId,
      is_video: video !== null,
      cached: data.cached === true,
      credits_charged: asNumber(data.credits_charged),
    },
  }
}

function transcriptResult(data: Json, target: string, base: Json): SourceToolResult {
  if (!("transcript" in data)) return "ERROR: ScrapeCreators Facebook transcript returned an unexpected payload: `transcript` is missing"
  const transcript = data.transcript
  if (transcript !== null && typeof transcript !== "string") {
    return `ERROR: ScrapeCreators Facebook transcript returned an unexpected payload: \`transcript\` is not a string (${typeof transcript})`
  }
  const lines = [
    `Facebook transcript: ${target}`,
    provenanceLine(data),
    "Source: the transcript ScrapeCreators returns for the video, as written; its docs limit transcripts to videos under 2 minutes.",
    "",
  ]
  const text = transcript?.trim() ? transcript : null
  if (text) lines.push(text)
  else lines.push(`No transcript came back (transcript: ${transcript === null ? "null" : "empty"}). ScrapeCreators documents transcripts only for videos under 2 minutes.`)
  return {
    status: text ? "success" : "empty",
    text: lines.join("\n"),
    details: { ...base, characters: text?.length ?? 0, cached: data.cached === true, credits_charged: asNumber(data.credits_charged) },
  }
}

function commentLines(comment: Json, index: number): string[] {
  const author = asRecord(comment.author)
  const lines = [`${index + 1}. ${name(author?.name) ?? "(author not returned)"} — ${when(comment.created_at) ?? "time not reported"}`]
  const text = asString(comment.text)
  lines.push(...(text ? indented(text) : [`${INDENT}(no text)`]))
  const breakdown = reactionBreakdown(comment.reactions)
  const replies = asNumber(comment.reply_count)
  lines.push(`${INDENT}Reactions: ${count(comment.reaction_count)}${breakdown ? ` (${breakdown})` : ""} | Replies: ${count(comment.reply_count)}`)
  const feedbackId = asString(comment.feedback_id)
  const expansionToken = asString(comment.expansion_token)
  if (feedbackId && expansionToken) {
    lines.push(`${INDENT}Read replies with kind='replies', feedback_id="${feedbackId}", expansion_token="${expansionToken}"`)
  } else if (replies !== null && replies > 0) {
    lines.push(`${INDENT}Replies cannot be read from here: this comment came back without the feedback_id and expansion_token they need.`)
  }
  pushField(lines, "Comment id", idText(comment.id), INDENT)
  return lines
}

function groupResult(data: Json, target: string, base: Json): SourceToolResult {
  const id = idText(data.id)
  const groupName = name(data.name)
  if (!id && !groupName) return "ERROR: ScrapeCreators Facebook group returned an unexpected payload: no id or name"
  const privacy = asRecord(data.privacy)
  const visibility = asRecord(data.visibility)
  const privacyLabel = asString(privacy?.label)
  const lines = [`Facebook group: ${groupName ?? "(name not returned)"}${id ? ` (id ${id})` : ""}`, `URL: ${asString(data.url) ?? target}`, provenanceLine(data)]
  lines.push(`Privacy: ${privacyLabel ?? "not reported"}${asString(privacy?.description) ? ` — ${asString(privacy?.description)}` : ""}`)
  if (privacyLabel && privacyLabel !== "Public") lines.push("Note: ScrapeCreators documents group posts for public groups only; this About page is what Facebook shows publicly.")
  if (visibility) lines.push(`Visibility: ${asString(visibility.label) ?? "not reported"}${asString(visibility.description) ? ` — ${asString(visibility.description)}` : ""}`)
  const categories = asArray(data.categories)
    .map((entry) => name(asRecord(entry)?.name) ?? shown(entry))
    .filter((value): value is string => value !== null)
  if (categories.length) lines.push(`Categories: ${categories.join(", ")}`)
  pushField(lines, "Created", data.created_at)
  pushField(lines, "History", data.history_summary)
  lines.push(`Members: ${count(data.member_count)}${asString(data.member_count_text) ? ` (${asString(data.member_count_text)})` : ""}`)
  lines.push(`Administrators: ${count(data.administrator_count)} | Moderators: ${count(data.moderator_count)}`)
  const activity = asRecord(data.activity)
  if (activity) {
    lines.push(`Activity: ${count(activity.posts_last_day)} posts in the last day | ${count(activity.posts_last_month)} posts in the last month${asString(activity.new_members_text) ? ` | ${asString(activity.new_members_text)}` : ""}`)
  }
  const description = asString(data.description)
  if (description) lines.push("Description:", ...indented(description))
  for (const [label, key] of [["Administrators listed", "administrators"], ["Moderators listed", "moderators"]] as const) {
    const people = asArray(data[key]).map(asRecord).filter((person): person is Json => person !== null)
    if (!people.length) continue
    lines.push(`${label}:`)
    for (const person of people) lines.push(`- ${name(person.name) ?? "(name not returned)"}${asString(person.url) ? ` — ${asString(person.url)}` : ""}`)
  }
  const rules = asArray(data.rules).map(asRecord).filter((rule): rule is Json => rule !== null)
  if (rules.length) {
    lines.push("Rules:")
    for (const [index, rule] of rules.entries()) {
      lines.push(`${index + 1}. ${name(rule.title) ?? "(untitled rule)"}`)
      const ruleText = asString(rule.description)
      if (ruleText) lines.push(...indented(ruleText))
    }
  }
  return {
    status: "success",
    text: lines.join("\n"),
    details: { ...base, id, name: groupName, privacy: privacyLabel, member_count: asNumber(data.member_count), credits_charged: asNumber(data.credits_charged) },
  }
}

function facebookResult(kind: FacebookKind, response: ScrapeCreatorsResponse, request: PreparedRequest, args: FacebookArgs): SourceToolResult {
  const label = KINDS[kind].label
  const base: Json = { provider: "scrapecreators", kind, target: request.target }
  if (kind === "profile") return profileResult(response, request.target, args.include_gated_profile === true, base)
  if (!response.ok) return failText(response)
  const payload = response.payload
  const continued = request.params.cursor !== undefined
  const pageWord = continued ? "continued page" : "first page"

  switch (kind) {
    case "profile_posts":
    case "group_posts": {
      const read = readEntries(payload, "posts", label, byIdOrUrl)
      if (!read.ok) return `ERROR: ${read.error}`
      const group = kind === "group_posts"
      return listResult({
        heading: `Facebook ${group ? "group" : "page"} posts: ${request.target} (${pageWord})`,
        notes: [
          `Source: ${group ? "a public group's feed" : "a page's publicly visible posts"}; the provider returns at most ${POSTS_PER_PAGE} posts per page, in its order.`,
          ...(group ? [`Sort: ${args.sort_by ?? "CHRONOLOGICAL (provider default)"}`] : []),
        ],
        payload,
        noun: "Posts",
        read,
        continuation: cursorContinuation(payload, group ? "the same group and sort_by" : "the same url or page_id"),
        media: true,
        render: feedPostLines,
        details: { ...base, ...(group ? { sort_by: args.sort_by ?? null } : {}) },
      })
    }
    case "profile_reels":
    case "profile_photos": {
      const reels = kind === "profile_reels"
      const read = reels
        ? readEntries(payload, "reels", label, (entry) => idText(entry.id) ?? idText(entry.video_id) ?? asString(entry.url))
        : readEntries(payload, "photos", label, (entry) => idText(entry.photo_id) ?? idText(entry.id) ?? asString(entry.url))
      if (!read.ok) return `ERROR: ${read.error}`
      return listResult({
        heading: `Facebook page ${reels ? "reels" : "photos"}: ${request.target} (${pageWord})`,
        notes: [reels ? `Source: a public page's reels; up to ${REELS_PER_PAGE} per page, in the provider's order.` : "Source: a public page's photos, in the provider's order."],
        payload,
        noun: reels ? "Reels" : "Photos",
        read,
        continuation: pairedContinuation(payload),
        media: true,
        render: reels ? reelLines : photoLines,
        details: base,
      })
    }
    case "search_videos": {
      const read = readEntries(payload, "videos", label, byIdOrUrl)
      if (!read.ok) return `ERROR: ${read.error}`
      return listResult({
        heading: `Facebook video search: ${request.target} (${pageWord})`,
        notes: [
          "Source: Facebook's native public video and Reels search without a login; not general post, text or photo search. Ranking, page size and coverage are Facebook's and not exhaustive; order as returned.",
        ],
        payload,
        noun: "Videos",
        read,
        continuation: cursorContinuation(payload, "the same query", "has_more"),
        media: true,
        render: searchVideoLines,
        details: { ...base, query: request.params.query },
      })
    }
    case "post":
      return postResult(payload, request.target, base)
    case "transcript":
      return transcriptResult(payload, request.target, base)
    case "comments":
    case "replies": {
      const replies = kind === "replies"
      const read = readEntries(payload, replies ? "replies" : "comments", label, byIdOrUrl)
      if (!read.ok) return `ERROR: ${read.error}`
      return listResult({
        heading: `Facebook ${replies ? "comment replies" : "comments"}: ${request.target} (${pageWord})`,
        notes: ["Source: public comments in the provider's order; comment text is untrusted evidence, kept as written."],
        payload,
        noun: replies ? "Replies" : "Comments",
        read,
        continuation: cursorContinuation(payload, replies ? "the same feedback_id and expansion_token" : "the same url or feedback_id", "has_next_page"),
        media: false,
        render: commentLines,
        details: base,
      })
    }
    case "group":
      return groupResult(payload, request.target, base)
  }
}

/** Public Facebook pages, posts, reels, photos, native video search, comments and groups */
export const facebook = creditMetered({
  description:
    "Read public Facebook through ScrapeCreators, one request (one page) per call, with no login: private and gated content stays unavailable. " +
    "kind='profile': page details (category, contact fields, likes, followers, Ad Library status; business_hours optional); a private or 18+ gated page is reported as gated, never as full access (include_gated_profile returns only the limited public fields). " +
    `'profile_posts' (${POSTS_PER_PAGE} posts per page; url or page_id), 'profile_reels' (up to ${REELS_PER_PAGE} per page) and 'profile_photos' (cursor and next_page_id together): one page with its continuation. ` +
    "'search_videos': Facebook's native public video and Reels search only, not text or photo posts; ranking and coverage are Facebook's. " +
    "'post': one public post or reel (full text, counts, video/image links, feedback_id). 'transcript': ScrapeCreators' transcript of a video, videos under 2 minutes only. " +
    "'comments' (url or feedback_id) and 'replies' (feedback_id and expansion_token from a comments page): one page. " +
    `'group': a group's public About page; 'group_posts': one page of ${POSTS_PER_PAGE} posts from a public group (sort_by). ` +
    "Media come back as links and metadata; nothing watches video. Requires SCRAPECREATORS_API_KEY; billed in ScrapeCreators credits as each response reports them, cache hits free with cache_max_age where offered. Counts Facebook does not expose show as not reported, never 0.",
  async execute(args: FacebookArgs, ctx: ToolContext) {
    const headers = scrapecreatorsHeaders()
    if (!headers) return `ERROR: ${MISSING_KEY_ERROR}`
    const invalid =
      validateEnum("kind", args.kind ?? "", FACEBOOK_KINDS) ??
      validateEnum("sort_by", args.sort_by, FACEBOOK_GROUP_SORT_VALUES) ??
      validateEnum("cache_max_age", args.cache_max_age, FACEBOOK_CACHE_MAX_AGE_VALUES)
    if (invalid) return `ERROR: ${invalid}`
    const kind = args.kind as FacebookKind
    const spec = KINDS[kind]
    const misplaced = misplacedArgument(args, kind, spec.accepts)
    if (misplaced) return `ERROR: ${misplaced}`
    const request = prepareFacebook(kind, args)
    if ("error" in request) return `ERROR: ${request.error}`
    const response = await facebookRequest(spec.path, request.params, headers, ctx, spec.label)
    const result = facebookResult(kind, response, request, args)
    return typeof result === "string" ? result : bounded(result)
  },
} satisfies ToolSpec)

// ---------------------------------------------------------------------------
// scrapecreators_facebook_events
// ---------------------------------------------------------------------------

function eventUrl(event: Json): string | null {
  return asString(event.url) ?? asString(event.event_url) ?? asString(event.eventUrl)
}

function eventFlags(event: Json): string {
  const flags = [
    event.is_canceled === true ? "canceled" : null,
    event.is_past === true ? "past" : null,
    event.is_happening_now === true ? "happening now" : null,
    event.is_online === true || event.is_online_or_detected_online === true ? "online" : null,
  ].filter((flag): flag is string => flag !== null)
  return flags.length ? ` [${flags.join(", ")}]` : ""
}

/** Event lists carry their cover in one of two documented shapes: search's and the city page's. */
function eventCover(event: Json): { uri: string; caption: string | null } | null {
  const cover = asRecord(event.cover_photo)
  const photo = asRecord(cover?.photo)
  const uri = asString(asRecord(cover?.eventImage)?.uri) ?? asString(asRecord(photo?.image)?.uri)
  if (!uri) return null
  return { uri, caption: asString(cover?.accessibility_caption) ?? asString(photo?.accessibility_caption) }
}

function eventListLines(event: Json, index: number): string[] {
  const lines = [`${index + 1}. ${name(event.name) ?? "(name not returned)"}${eventFlags(event)}`]
  const start = when(event.start_timestamp)
  lines.push(`${INDENT}When: ${asString(event.day_time_sentence) ?? "not reported"}${start ? ` (starts ${start})` : ""}`)
  const place = asRecord(event.event_place)
  const city = asString(asRecord(asRecord(place?.location)?.reverse_geocode)?.city)
  const where = [asString(place?.contextual_name) ?? asString(place?.name), city].filter((part): part is string => part !== null)
  if (where.length) lines.push(`${INDENT}Where: ${where.join(", ")}`)
  const creator = asRecord(event.event_creator)
  if (creator) lines.push(`${INDENT}Created by: ${name(creator.name) ?? "(name not returned)"}${asString(creator.url) ? ` — ${asString(creator.url)}` : ""}`)
  const social = asRecord(event.social_context)
  if (social) {
    const went = asNumber(social.went_count)
    lines.push(
      `${INDENT}Interested: ${count(social.interested_count)} | Going: ${count(social.going_count)}${went !== null ? ` | Went: ${fmtNum(went)}` : ""}${asString(social.text) ? ` (Facebook shows "${asString(social.text)}")` : ""}`,
    )
  }
  pushField(lines, "Price", asRecord(event.ticketing_context_row)?.price_range_text, INDENT)
  pushField(lines, "Kind", event.event_kind, INDENT)
  pushField(lines, "URL", eventUrl(event), INDENT)
  pushField(lines, "Event id", idText(event.id), INDENT)
  const cover = eventCover(event)
  if (cover) {
    lines.push(`${INDENT}Cover: ${cover.uri}`)
    if (cover.caption) lines.push(`${INDENT}Cover alt text (Facebook's automatic description): ${cover.caption}`)
  }
  return lines
}

function eventDetailsResult(data: Json, target: string, base: Json): SourceToolResult {
  const id = idText(data.id)
  const eventName = name(data.name)
  if (!id && !eventName) return "ERROR: ScrapeCreators Facebook event details returned an unexpected payload: no id or name"
  const lines = [`Facebook event: ${eventName ?? "(name not returned)"}${eventFlags(data)}`, `URL: ${eventUrl(data) ?? target}`, provenanceLine(data)]
  pushField(lines, "Event id", id)
  const start = when(data.start_timestamp) ?? when(data.current_start_timestamp)
  lines.push(`When: ${asString(data.day_time_sentence) ?? "not reported"}${start ? ` (starts ${start})` : ""}`)
  pushField(lines, "Start time", data.start_time)
  pushField(lines, "End time", data.end_time)
  pushField(lines, "Time text", data.time_text)
  pushField(lines, "Duration", data.duration)
  const place = asRecord(data.event_place)
  const where = [asString(data.location_name) ?? asString(place?.contextual_name), asString(data.address), asString(data.city)].filter((part): part is string => part !== null)
  if (where.length) lines.push(`Where: ${where.join(" | ")}`)
  const latitude = asNumber(data.latitude)
  const longitude = asNumber(data.longitude)
  if (latitude !== null && longitude !== null) lines.push(`Coordinates: ${latitude}, ${longitude}`)
  pushField(lines, "Online", typeof data.is_online === "boolean" ? data.is_online : null)
  pushField(lines, "Privacy", data.privacy)
  pushField(lines, "Kind", data.event_kind)
  pushField(lines, "Host line", data.host_context_text)
  const hosts = asArray(data.hosts).map(asRecord).filter((host): host is Json => host !== null)
  if (hosts.length) {
    lines.push("Hosts:")
    for (const host of hosts) {
      lines.push(`- ${name(host.name) ?? "(name not returned)"}${host.is_verified === true ? " (verified)" : ""}${asString(host.url) ? ` — ${asString(host.url)}` : ""}`)
    }
  }
  lines.push(`Interested: ${count(data.interested_count)} | Going: ${count(data.going_count)} | Attendance count (as the provider reports it): ${count(data.attendance_count)}`)
  pushField(lines, "Price", data.price)
  pushField(lines, "Price info", data.price_info)
  pushField(lines, "Tickets", data.ticket_url)
  pushField(lines, "Ticket provider", data.ticket_provider)
  pushField(lines, "Ticket source", data.ticket_source)
  const categories = [shown(data.category), ...asArray(data.categories).map((entry) => name(asRecord(entry)?.name) ?? shown(entry))].filter(
    (value): value is string => value !== null,
  )
  if (categories.length) lines.push(`Categories: ${categories.join(", ")}`)
  const description = asString(data.description)
  lines.push("Description:", ...(description ? indented(description) : [`${INDENT}(no description)`]))
  const links = asArray(data.description_links).map(shown).filter((value): value is string => value !== null)
  if (links.length) lines.push("Description links:", ...links.map((link) => `- ${link}`))
  const cover = asString(data.cover_photo_url)
  if (cover) lines.push(`Cover photo: ${cover}`, MEDIA_NOTE)
  return {
    status: "success",
    text: lines.join("\n"),
    details: { ...base, id, name: eventName, url: eventUrl(data), start: start ?? null, credits_charged: asNumber(data.credits_charged) },
  }
}

function eventsResult(kind: EventKind, response: ScrapeCreatorsResponse, request: PreparedRequest, args: FacebookEventsArgs): SourceToolResult {
  if (!response.ok) return failText(response)
  const payload = response.payload
  const base: Json = { provider: "scrapecreators", kind, target: request.target }
  if (kind === "details") return eventDetailsResult(payload, request.target, base)
  const read = readEntries(payload, "events", EVENT_KINDS[kind].label, (entry) => idText(entry.id) ?? eventUrl(entry))
  if (!read.ok) return `ERROR: ${read.error}`
  const pageWord = request.params.cursor !== undefined ? "continued page" : "first page"
  const shared = { payload, noun: "Events", read, media: true, render: eventListLines }
  switch (kind) {
    case "profile": {
      const total = asNumber(payload.total_count)
      return listResult({
        ...shared,
        heading: `Facebook page events: ${request.target} (${pageWord})`,
        notes: [`Source: the page's public events as Facebook lists them, in the provider's order.${total !== null ? ` The provider reports ${fmtNum(total)} events in total.` : ""}`],
        continuation: cursorContinuation(payload, "the same url", "has_next_page"),
        details: { ...base, total_count: total },
      })
    }
    case "search":
      return listResult({
        ...shared,
        heading: `Facebook event search: ${request.target} (${pageWord})`,
        notes: ["Source: Facebook's public event search by name, without a login; ranking and coverage are Facebook's, order as returned."],
        continuation: cursorContinuation(payload, "the same query"),
        details: { ...base, query: request.params.query },
      })
    case "city":
      return listResult({
        ...shared,
        heading: `Facebook city events: ${request.target} (${pageWord})`,
        notes: [`Source: the city's public Facebook Events page, in the provider's order. Time: ${args.time ?? "all time (provider default)"}`],
        continuation: cursorContinuation(payload, "the same url and time"),
        details: { ...base, time: args.time ?? null },
      })
  }
}

/** Public Facebook events: a page's events, event search, a city's events, one event */
export const facebook_events = creditMetered({
  description:
    "Read public Facebook events through ScrapeCreators, one request (one page) per call, with no login. " +
    "kind='profile': one page of a public page's events (url, cursor). 'search': Facebook's public event search by name (query, cursor). " +
    "'city': one page of a city's Facebook Events page by its https://www.facebook.com/events/explore/<city>/<id> URL, optional time today|this_week|next_week (default all time). " +
    "'details': one event by url or event_id: description, time, place, hosts, ticket link, interested/going counts. " +
    "Cover images come back as links with Facebook's automatic alt text. Requires SCRAPECREATORS_API_KEY; billed in ScrapeCreators credits as each response reports them.",
  async execute(args: FacebookEventsArgs, ctx: ToolContext) {
    const headers = scrapecreatorsHeaders()
    if (!headers) return `ERROR: ${MISSING_KEY_ERROR}`
    const invalid = validateEnum("kind", args.kind ?? "", FACEBOOK_EVENT_KINDS) ?? validateEnum("time", args.time, FACEBOOK_EVENT_TIME_VALUES)
    if (invalid) return `ERROR: ${invalid}`
    const kind = args.kind as EventKind
    const spec = EVENT_KINDS[kind]
    const misplaced = misplacedArgument(args, kind, spec.accepts)
    if (misplaced) return `ERROR: ${misplaced}`
    const request = prepareEvents(kind, args)
    if ("error" in request) return `ERROR: ${request.error}`
    const response = await facebookRequest(spec.path, request.params, headers, ctx, spec.label)
    const result = eventsResult(kind, response, request, args)
    return typeof result === "string" ? result : bounded(result)
  },
} satisfies ToolSpec)
