/**
 * TikHub-native Reddit research tool.
 *
 * This is intentionally separate from the baseline `reddit` tool. The public
 * Reddit tool is the cheap baseline; this tool exposes TikHub-only surfaces that
 * add discovery and context: typeahead, trending searches, subreddit metadata,
 * highlights/settings, author activity, batch post enrichment, and collapsed
 * reply completion.
 *
 * Environment variables:
 *   - TIKHUB_API_KEY (required)
 *   - TIKHUB_BASE_URL (optional; defaults to https://api.tikhub.io)
 */
import { outcome } from "../outcome.js"
import type { ToolContext, ToolSpec } from "../types.js"

/** Cancellation plus the raw-response capture of the tool call. */
type CallContext = Pick<ToolContext, "abort" | "keep">

/** Read per request, so a TIKHUB_BASE_URL loaded from keys.env after startup applies. */
const tikhubBaseUrl = () => process.env.TIKHUB_BASE_URL?.trim() || "https://api.tikhub.io"
const DEFAULT_TIKHUB_TIMEOUT_MS = 60_000
const DEFAULT_MAX_ITEMS = 10
const MAX_MAX_ITEMS = 25

const OPERATION_VALUES = [
  "discovery_bundle",
  "query_scout",
  "subreddit_context",
  "thread_intelligence",
  "deep_thread",
  "author_context",
  "batch_enrich",
  "feed_discovery",
] as const

const SEARCH_TYPE_VALUES = ["post", "community", "comment", "media", "people"] as const
const SEARCH_SORT_VALUES = ["RELEVANCE", "HOT", "TOP", "NEW", "COMMENTS"] as const
const TIME_RANGE_VALUES = ["all", "year", "month", "week", "day", "hour"] as const
const COMMENT_SORT_VALUES = ["CONFIDENCE", "NEW", "TOP", "HOT", "CONTROVERSIAL", "OLD", "RANDOM"] as const
const FEED_SORT_VALUES = ["BEST", "HOT", "NEW", "TOP", "RISING", "CONTROVERSIAL"] as const
const FEED_VALUES = ["popular", "news", "subreddit", "subreddit_channels"] as const

type Operation = (typeof OPERATION_VALUES)[number]
type ToolArgs = {
  operation: Operation
  query?: string
  searchType?: (typeof SEARCH_TYPE_VALUES)[number]
  sort?: string
  timeRange?: (typeof TIME_RANGE_VALUES)[number]
  subredditName?: string
  subredditId?: string
  postId?: string
  postIds?: string[]
  username?: string
  includeSettings?: boolean
  includeStyle?: boolean
  includeHighlights?: boolean
  includeSubredditContext?: boolean
  includeBatchEnrich?: boolean
  includeUserHistory?: boolean
  includeReplies?: boolean
  maxReplyCursors?: number
  feed?: (typeof FEED_VALUES)[number]
  after?: string
  afterTarget?: "user_posts" | "user_comments"
  allowNsfw?: boolean
  maxItems?: number
  needFormat?: boolean
}

type TikHubCall = {
  label: string
  endpoint: string
  params: Record<string, unknown>
  data?: unknown
  error?: string
  notes?: string[]
}

type ClassifiedCall = TikHubCall & {
  usefulRecords: number
  usefulCandidates: number
  usefulComments: number
}

type Candidate = {
  id: string | null
  title: string | null
  subreddit: string | null
  author: string | null
  score: number | null
  comments: number | null
  url: string | null
  snippet: string | null
  sourceUrl?: string | null
}

type CommentHighlight = {
  id: string | null
  author: string | null
  score: number | null
  text: string
  subreddit: string | null
  permalink: string | null
}

type CommunitySignal = {
  id: string | null
  name: string | null
  title: string | null
  subscribers: number | null
  description: string | null
  url: string | null
}

type QuerySignal = {
  text: string
  kind: string | null
  score: number | null
}

function tikhubHeaders(): Record<string, string> {
  const token = process.env.TIKHUB_API_KEY?.trim()
  if (!token) {
    throw new Error("TIKHUB_API_KEY not set")
  }

  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "opencode-tikhub-reddit-tool/1.0",
  }
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  return normalized || null
}

function truncate(value: string | null, maxLength: number): string | null {
  if (!value) return null
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1).trimEnd()}…`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeText(value)
    if (normalized) return normalized
  }
  return null
}

function recordValue(record: Record<string, unknown>, key: string): unknown {
  return asRecord(record[key.split(".")[0]]) && key.includes(".")
    ? key.split(".").reduce<unknown>((current, segment) => asRecord(current)?.[segment], record)
    : record[key]
}

function firstRecordString(record: Record<string, unknown>, ...keys: string[]): string | null {
  return firstString(...keys.map((key) => recordValue(record, key)))
}

function firstRecordNumber(record: Record<string, unknown>, ...keys: string[]): number | null {
  return firstNumber(...keys.map((key) => recordValue(record, key)))
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string") {
      const parsed = Number(value.replace(/[^\d.-]/g, ""))
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function safeJsonSnippet(value: unknown, maxLength = 1600): string {
  try {
    const serialized = redactDiagnostics(JSON.stringify(value, null, 2) ?? "")
    if (!serialized) return "{}"
    return serialized.length <= maxLength
      ? serialized
      : `${serialized.slice(0, maxLength - 1).trimEnd()}…`
  } catch {
    return "[unserializable response]"
  }
}

function collectRecords(value: unknown, maxDepth = 6): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  const seen = new Set<unknown>()

  function visit(node: unknown, depth: number) {
    if (depth > maxDepth || node === null || node === undefined) return
    if (typeof node !== "object") return
    if (seen.has(node)) return
    seen.add(node)

    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }

    const record = node as Record<string, unknown>
    records.push(record)
    for (const item of Object.values(record)) visit(item, depth + 1)
  }

  visit(value, 0)
  return records
}

function redactDiagnostics(text: string): string {
  for (const name of ["TIKHUB_API_KEY", "SCRAPECREATORS_API_KEY"]) {
    const key = process.env[name]?.trim()
    if (key) text = text.replaceAll(key, "[redacted]").replaceAll(encodeURIComponent(key), "[redacted]")
  }
  return text
}

function collectStringsByKey(value: unknown, keyPattern: RegExp, valuePattern: RegExp): string[] {
  const found = new Set<string>()
  const seen = new Set<unknown>()

  function visit(node: unknown, depth: number) {
    if (depth > 8 || node === null || node === undefined) return
    if (typeof node !== "object") return
    if (seen.has(node)) return
    seen.add(node)

    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }

    const record = node as Record<string, unknown>
    for (const [key, raw] of Object.entries(record)) {
      if (keyPattern.test(key) && typeof raw === "string" && valuePattern.test(raw)) {
        found.add(raw)
      }
      visit(raw, depth + 1)
    }
  }

  visit(value, 0)
  return Array.from(found)
}

function recordToCandidate(record: Record<string, unknown>): Candidate | null {
  const id = firstString(record.id, record.fullname, record.thing_id, record.name, record.groupId)
  const hasRedditThingId = !!id && /^t[13]_/.test(id)
  const hasEngagement = firstNumber(record.score, record.ups, record.upvotes, record.karma, record.num_comments, record.comment_count, record.comments, record.reply_count, record.commentCount) !== null
  const hasRedditContext = !!firstString(record.subreddit_name_prefixed, record.subreddit, record.community_name, record.subredditName, record.author, record.author_name, record.username, record.authorName)
  const hasLinkContext = !!firstString(record.permalink, record.url, record.link, record.outbound_link)

  // TikHub app payloads contain many non-content records such as sidebar widgets,
  // automod apps, button labels, and presentation metadata. Keep actual Reddit
  // things or records with clear engagement/community context.
  if (!hasRedditThingId && !hasEngagement && !hasRedditContext) return null
  if (id && !hasRedditThingId && !hasEngagement && !hasLinkContext) return null

  const title = firstString(
    record.title,
    record.link_title,
    record.post_title,
    record.display_name,
    record.displayName,
    record.public_description,
    record.name,
    record.body,
    record.selftext,
    record.text
  )
  const snippet = firstString(record.selftext, record.body, record.text, record.description, record.public_description)

  if (!title && !snippet) return null


  return {
    id,
    title: truncate(title, 180),
    subreddit: firstString(record.subreddit_name_prefixed, record.subreddit, record.community_name, record.subredditName),
    author: firstString(record.author, record.author_name, record.username, record.authorName),
    score: firstNumber(record.score, record.ups, record.upvotes, record.karma),
    comments: firstNumber(record.num_comments, record.comment_count, record.comments, record.reply_count, record.commentCount),
    url: firstString(record.permalink, record.url, record.link, record.outbound_link),
    snippet: truncate(snippet, 260),
  }
}

function collectCandidates(calls: TikHubCall[], maxItems: number): Candidate[] {
  const candidates: Candidate[] = []
  const seen = new Set<string>()

  for (const call of calls) {
    if (call.error) continue
    if (call.endpoint === "/api/v1/reddit/app/fetch_news_feed") {
      for (const candidate of collectNewsCandidates(call.data)) {
        if (!candidate.id || seen.has(candidate.id)) continue
        seen.add(candidate.id)
        candidates.push(candidate)
        if (candidates.length >= maxItems) return candidates
      }
      continue
    }
    for (const record of collectRecords(call.data)) {
      const candidate = recordToCandidate(record)
      if (!candidate) continue
      const key = candidate.id || `${candidate.title || ""}:${candidate.subreddit || ""}:${candidate.author || ""}`
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(candidate)
      if (candidates.length >= maxItems) return candidates
    }
  }

  return candidates
}

function collectNewsCandidates(payload: unknown): Candidate[] {
  const envelope = asRecord(payload)
  const elements = asRecord(envelope && recordValue(envelope, "data.newsfeed.newsV3.elements"))
  return asArray(elements?.edges).flatMap((edge): Candidate[] => {
    const node = asRecord(asRecord(edge)?.node)
    const id = firstString(node?.groupId)
    // Cells are presentation fragments, not independent posts. Only join one
    // organic t3 group at a time; ad groups/widgets must not become news evidence.
    if (!id || !/^t3_[A-Za-z0-9]+$/.test(id) || node?.adPayload) return []
    const cells = asArray(node?.cells).map(asRecord).filter((cell): cell is Record<string, unknown> => cell !== null)
    const title = cells.map((cell) => firstString(asRecord(cell.titleCell)?.title, cell.title)).find(Boolean) ?? null
    if (!title) return []
    const metadata = cells.find((cell) => firstString(cell.authorName, cell.detailsString) !== null)
    const actions = cells.find((cell) => cell.commentCount !== undefined || cell.score !== undefined)
    return [{
      id,
      title: truncate(title, 180),
      subreddit: firstString(metadata?.detailsString, metadata?.subredditName),
      author: firstString(metadata?.authorName),
      score: actions?.isScoreHidden === true ? null : firstNumber(actions?.score),
      comments: firstNumber(actions?.commentCount),
      url: `https://www.reddit.com/comments/${id.slice(3)}/`,
      sourceUrl: firstString(metadata?.mediaPath),
      snippet: null,
    }]
  })
}

function recordToCommentHighlight(record: Record<string, unknown>): CommentHighlight | null {
  const id = firstRecordString(record, "id", "fullname", "thing_id", "name", "commentId")
  const text = firstRecordString(
    record,
    "body",
    "bodyText",
    "text",
    "markdown",
    "content.markdown",
    "content.text",
    "comment.content.markdown",
    "comment.body",
    "node.content.markdown"
  )

  if (!text || text.length < 20) return null

  const looksLikeComment = !id || /^t1_/.test(id) || !!firstRecordString(record, "commentId", "parentId", "parent_id")
  if (!looksLikeComment) return null

  const author = firstRecordString(
    record,
    "author",
    "authorName",
    "author_name",
    "username",
    "user.name",
    "user.username",
    "authorInfo.name",
    "authorInfo.username",
    "comment.author",
    "comment.authorName"
  )

  return {
    id,
    author,
    score: firstRecordNumber(record, "score", "ups", "upvotes", "voteScore", "commentScore", "karma"),
    text: truncate(text, 360) || text,
    subreddit: firstRecordString(record, "subreddit", "subredditName", "subreddit_name_prefixed", "communityName"),
    permalink: firstRecordString(record, "permalink", "url", "link"),
  }
}

function collectCommentHighlights(calls: TikHubCall[], maxItems: number): CommentHighlight[] {
  const comments: CommentHighlight[] = []
  const seen = new Map<string, number>()

  for (const call of calls) {
    if (call.error) continue
    if (!/(^post comments|collapsed replies|dynamic comment search|user comments)/i.test(call.label)) continue
    for (const record of collectRecords(call.data, 8)) {
      const comment = recordToCommentHighlight(record)
      if (!comment) continue
      const key = comment.text.toLowerCase().replace(/\s+/g, " ").slice(0, 220)
      const existingIndex = seen.get(key)
      if (existingIndex !== undefined) {
        const existing = comments[existingIndex]
        const existingRichness = (existing.id ? 1 : 0) + (existing.author ? 1 : 0) + (existing.permalink ? 1 : 0)
        const newRichness = (comment.id ? 1 : 0) + (comment.author ? 1 : 0) + (comment.permalink ? 1 : 0)
        if (newRichness > existingRichness) comments[existingIndex] = comment
        continue
      }
      seen.set(key, comments.length)
      comments.push(comment)
      if (comments.length >= maxItems) return comments
    }
  }

  return comments
}

function recordToCommunitySignal(record: Record<string, unknown>): CommunitySignal | null {
  const id = firstRecordString(record, "id", "name", "subredditId", "subreddit_id", "thing_id")
  const name = firstRecordString(
    record,
    "display_name_prefixed",
    "subreddit_name_prefixed",
    "display_name",
    "subreddit",
    "subredditName",
    "community_name",
    "name"
  )
  const normalizedName = name?.replace(/^r\//, "") || null
  const title = firstRecordString(record, "title", "public_description", "description", "displayName")
  const description = firstRecordString(record, "public_description", "description", "subreddit.description", "communityDescription")
  const subscribers = firstRecordNumber(record, "subscribers", "subscriber_count", "members", "memberCount", "active_user_count")
  const hasCommunitySignal =
    (!!id && /^t5_/.test(id)) ||
    !!firstRecordString(record, "display_name", "display_name_prefixed", "subredditName", "subreddit_name_prefixed") ||
    subscribers !== null

  if (!hasCommunitySignal || !normalizedName) return null

  return {
    id: id && /^t5_/.test(id) ? id : null,
    name: normalizedName,
    title: truncate(title, 160),
    subscribers,
    description: truncate(description, 260),
    url: firstRecordString(record, "url", "permalink") || `/r/${normalizedName}`,
  }
}

function collectCommunitySignals(calls: TikHubCall[], maxItems: number): CommunitySignal[] {
  const communities: CommunitySignal[] = []
  const seen = new Set<string>()

  for (const call of calls) {
    if (call.error) continue
    for (const record of collectRecords(call.data, 8)) {
      const community = recordToCommunitySignal(record)
      if (!community) continue
      const key = community.id || community.name?.toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      communities.push(community)
      if (communities.length >= maxItems) return communities
    }
  }

  return communities
}

function recordToQuerySignal(record: Record<string, unknown>): QuerySignal | null {
  const text = firstRecordString(record, "query", "term", "text", "title", "name", "displayText", "display_text")
  if (!text || text.length < 2 || /^t[135]_/.test(text)) return null
  const kind = firstRecordString(record, "type", "kind", "search_type", "result_type")
  const score = firstRecordNumber(record, "score", "rank", "count", "popularity")
  const looksLikeSuggestion =
    !!firstRecordString(record, "query", "term", "displayText", "display_text") ||
    /search|trend|suggest|typeahead|query/i.test(kind || "")

  if (!looksLikeSuggestion) return null

  return { text: truncate(text, 140) || text, kind, score }
}

function collectQuerySignals(calls: TikHubCall[], maxItems: number): QuerySignal[] {
  const signals: QuerySignal[] = []
  const seen = new Set<string>()

  for (const call of calls) {
    if (call.error) continue
    for (const record of collectRecords(call.data, 8)) {
      const signal = recordToQuerySignal(record)
      if (!signal) continue
      const key = signal.text.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      signals.push(signal)
      if (signals.length >= maxItems) return signals
    }
  }

  return signals
}

function formatCommentHighlight(comment: CommentHighlight, index: number): string {
  const parts = [
    comment.id ? `ID: ${comment.id}` : null,
    comment.author ? `u/${comment.author.replace(/^u\//, "")}` : null,
    comment.subreddit ? `r/${comment.subreddit.replace(/^r\//, "")}` : null,
    comment.score !== null ? `${comment.score} pts` : null,
  ].filter(Boolean)

  const lines = [`${index}. ${parts.length ? `${parts.join(" | ")} — ` : ""}"${comment.text}"`]
  if (comment.permalink) lines.push(`   URL: ${comment.permalink.startsWith("http") ? comment.permalink : `https://reddit.com${comment.permalink}`}`)
  return lines.join("\n")
}

function formatCommunitySignal(community: CommunitySignal, index: number): string {
  const parts = [
    community.id ? `ID: ${community.id}` : null,
    community.subscribers !== null ? `${community.subscribers} subscribers` : null,
  ].filter(Boolean)
  const name = community.name ? `r/${community.name.replace(/^r\//, "")}` : "unknown subreddit"
  const lines = [`${index}. **${name}**${parts.length ? ` — ${parts.join(" | ")}` : ""}`]
  if (community.title) lines.push(`   Title: ${community.title}`)
  if (community.description) lines.push(`   Description: ${community.description}`)
  if (community.url) lines.push(`   URL: ${community.url.startsWith("http") ? community.url : `https://reddit.com${community.url.startsWith("/") ? community.url : `/${community.url}`}`}`)
  return lines.join("\n")
}

function formatQuerySignal(signal: QuerySignal, index: number): string {
  const parts = [signal.kind ? `kind: ${signal.kind}` : null, signal.score !== null ? `score/count: ${signal.score}` : null].filter(Boolean)
  return `${index}. ${signal.text}${parts.length ? ` (${parts.join("; ")})` : ""}`
}

function classifyCalls(calls: TikHubCall[]): ClassifiedCall[] {
  return calls.map((call) => {
    const usefulCandidates = call.error ? 0 : collectCandidates([call], 5).length
    const usefulComments = call.error ? 0 : collectCommentHighlights([call], 5).length
    const communities = call.error ? 0 : collectCommunitySignals([call], 5).length
    const queries = call.error ? 0 : collectQuerySignals([call], 5).length
    return {
      ...call,
      usefulRecords: usefulCandidates + usefulComments + communities + queries,
      usefulCandidates,
      usefulComments,
    }
  })
}

function extractSubredditId(calls: TikHubCall[]): string | null {
  for (const call of calls) {
    if (call.error) continue
    const ids = collectStringsByKey(call.data, /(^id$|subreddit.*id|name)/i, /^t5_[A-Za-z0-9_]+$/)
    if (ids.length > 0) return ids[0]
  }
  return null
}

function extractReplyCursors(calls: TikHubCall[], maxCursors: number): string[] {
  const cursors = new Set<string>()
  for (const call of calls) {
    if (call.error) continue
    if (!/(^post comments|collapsed replies)/i.test(call.label)) continue
    for (const cursor of collectStringsByKey(call.data, /cursor/i, /[A-Za-z0-9:_-]{8,}/)) {
      cursors.add(cursor)
      if (cursors.size >= maxCursors) return Array.from(cursors)
    }
  }
  return Array.from(cursors)
}

function formatCandidate(candidate: Candidate, index: number): string {
  const parts = [
    candidate.subreddit ? `r/${candidate.subreddit.replace(/^r\//, "")}` : null,
    candidate.author ? `u/${candidate.author.replace(/^u\//, "")}` : null,
    candidate.score !== null ? `${candidate.score} pts` : null,
    candidate.comments !== null ? `${candidate.comments} comments` : null,
  ].filter(Boolean)

  const lines = [`${index}. **${candidate.title || candidate.id || "Untitled item"}**${parts.length ? ` — ${parts.join(" | ")}` : ""}`]
  if (candidate.id) lines.push(`   ID: ${candidate.id}`)
  if (candidate.url) lines.push(`   URL: ${candidate.url.startsWith("http") ? candidate.url : `https://reddit.com${candidate.url}`}`)
  if (candidate.sourceUrl) lines.push(`   Linked source: ${candidate.sourceUrl}`)
  if (candidate.snippet && candidate.snippet !== candidate.title) lines.push(`   Snippet: ${candidate.snippet}`)
  return lines.join("\n")
}

async function tikhubGet(endpoint: string, params: Record<string, unknown>, ctx: CallContext): Promise<unknown> {
  const url = new URL(endpoint, tikhubBaseUrl())

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item))
    } else {
      url.searchParams.set(key, String(value))
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIKHUB_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: tikhubHeaders(),
      signal: AbortSignal.any([ctx.abort, controller.signal]),
    })

    const text = await response.text()
    let data: unknown = text
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      // Keep text response for diagnostics.
    }
    ctx.keep(endpoint, response.status, data)

    if (!response.ok) {
      throw new Error(`TikHub ${response.status}: ${safeJsonSnippet(data, 500)}`)
    }
    const envelope = asRecord(data)
    if (!envelope) throw new Error("TikHub returned a non-object JSON response")
    if (envelope.code !== undefined && envelope.code !== 200 && envelope.code !== 0) {
      throw new Error(`TikHub returned code ${String(envelope.code)}: ${firstString(envelope.message) ?? "request failed"}`)
    }

    return data
  } finally {
    clearTimeout(timeout)
  }
}

async function runCall(label: string, endpoint: string, params: Record<string, unknown>, ctx: CallContext): Promise<TikHubCall> {
  const signal = ctx.abort
  const notes: string[] = []
  if (endpoint.endsWith("/fetch_news_feed")) notes.push("Organic news post groups only; promoted ad groups and presentation widgets are excluded.")
  if (endpoint.endsWith("/fetch_dynamic_search")) {
    const type = params.search_type
    if (type !== "post" && type !== "media" && params.time_range !== undefined) {
      notes.push(`Unsupported time_range=${params.time_range} for ${type}; not sent.`)
      delete params.time_range
    }
    if ((type === "community" || type === "people") && params.sort !== undefined) {
      notes.push(`Unsupported sort=${params.sort} for ${type}; not sent.`)
      delete params.sort
    } else if (type !== "post" && params.sort === "COMMENTS") {
      notes.push(`Unsupported COMMENTS sort for ${type}; not sent (provider default ordering).`)
      delete params.sort
    }
  }
  try {
    signal.throwIfAborted()
    const data = await tikhubGet(endpoint, params, ctx)
    return { label, endpoint, params, data, notes }
  } catch (err) {
    signal.throwIfAborted()
    return {
      label,
      endpoint,
      params,
      notes,
      error: redactDiagnostics(err instanceof Error ? err.message : "Unknown TikHub error"),
    }
  }
}

function need(value: string | undefined, message: string): string {
  const trimmed = value?.trim()
  if (!trimmed) throw new Error(message)
  return trimmed
}

function normalizeSort<T extends readonly string[]>(value: string | undefined, allowed: T, fallback: T[number]): T[number] {
  const normalized = value?.trim().toUpperCase()
  if (normalized && !allowed.includes(normalized)) throw new Error(`Unsupported sort ${value}; expected ${allowed.join(", ")}`)
  return normalized || fallback
}

function normalizeSearchSort(value: string | undefined): (typeof SEARCH_SORT_VALUES)[number] {
  return normalizeSort(value, SEARCH_SORT_VALUES, "RELEVANCE")
}

function normalizeCommentSort(value: string | undefined): (typeof COMMENT_SORT_VALUES)[number] {
  return normalizeSort(value, COMMENT_SORT_VALUES, "CONFIDENCE")
}

function normalizeFeedSort(value: string | undefined, fallback: (typeof FEED_SORT_VALUES)[number] = "BEST"): (typeof FEED_SORT_VALUES)[number] {
  return normalizeSort(value, FEED_SORT_VALUES, fallback)
}

async function buildCalls(args: ToolArgs, ctx: CallContext): Promise<TikHubCall[]> {
  const needFormat = args.needFormat ?? true
  const allowNsfw = args.allowNsfw ? 1 : 0
  const calls: TikHubCall[] = []
  const call = (label: string, endpoint: string, params: Record<string, unknown>) => runCall(label, endpoint, params, ctx)

  if (args.operation === "discovery_bundle") {
    const query = need(args.query, "query is required for discovery_bundle")
    calls.push(await call("typeahead", "/api/v1/reddit/app/fetch_search_typeahead", {
      query,
      safe_search: "unset",
      allow_nsfw: allowNsfw,
      need_format: needFormat,
    }))
    calls.push(await call("dynamic post search", "/api/v1/reddit/app/fetch_dynamic_search", {
      query,
      search_type: "post",
      sort: normalizeSearchSort(args.sort),
      time_range: args.timeRange ?? "month",
      safe_search: "unset",
      allow_nsfw: allowNsfw,
      after: args.after,
      need_format: needFormat,
    }))
    calls.push(await call("dynamic community search", "/api/v1/reddit/app/fetch_dynamic_search", {
      query,
      search_type: "community",
      sort: "RELEVANCE",
      time_range: args.timeRange ?? "month",
      safe_search: "unset",
      allow_nsfw: allowNsfw,
      need_format: needFormat,
    }))
    calls.push(await call("dynamic comment search", "/api/v1/reddit/app/fetch_dynamic_search", {
      query,
      search_type: "comment",
      sort: normalizeSearchSort(args.sort),
      time_range: args.timeRange ?? "month",
      safe_search: "unset",
      allow_nsfw: allowNsfw,
      need_format: needFormat,
    }))
    calls.push(await call("trending searches", "/api/v1/reddit/app/fetch_trending_searches", {
      need_format: needFormat,
    }))

    if (args.includeSubredditContext ?? true) {
      for (const community of collectCommunitySignals(calls, 3)) {
        if (!community.name) continue
        calls.push(await call(`context r/${community.name}`, "/api/v1/reddit/app/fetch_subreddit_info", {
          subreddit_name: community.name,
          need_format: needFormat,
        }))
        calls.push(await call(`feed r/${community.name}`, "/api/v1/reddit/app/fetch_subreddit_feed", {
          subreddit_name: community.name,
          sort: "BEST",
          need_format: needFormat,
        }))
      }
    }

    if (args.includeBatchEnrich ?? true) {
      const postIds = Array.from(new Set(calls.flatMap((call) => collectStringsByKey(call.data, /(^id$|name|post.*id|thing_id)/i, /^t3_[A-Za-z0-9_]+$/)))).slice(0, 5)
      if (postIds.length > 0) {
        calls.push(await call("discovery batch post details", "/api/v1/reddit/app/fetch_post_details_batch", {
          post_ids: postIds.join(","),
          need_format: needFormat,
        }))
      }
    }

    return calls
  }

  if (args.operation === "query_scout") {
    const query = need(args.query, "query is required for query_scout")
    calls.push(await call("typeahead", "/api/v1/reddit/app/fetch_search_typeahead", {
      query,
      safe_search: "unset",
      allow_nsfw: allowNsfw,
      need_format: needFormat,
    }))
    calls.push(await call("dynamic search", "/api/v1/reddit/app/fetch_dynamic_search", {
      query,
      search_type: args.searchType ?? "post",
      sort: normalizeSearchSort(args.sort),
      time_range: args.timeRange ?? "month",
      safe_search: "unset",
      allow_nsfw: allowNsfw,
      after: args.after,
      need_format: needFormat,
    }))
    calls.push(await call("trending searches", "/api/v1/reddit/app/fetch_trending_searches", {
      need_format: needFormat,
    }))
    return calls
  }

  if (args.operation === "subreddit_context") {
    const subredditName = need(args.subredditName, "subredditName is required for subreddit_context").replace(/^r\//, "")
    calls.push(await call("subreddit info", "/api/v1/reddit/app/fetch_subreddit_info", {
      subreddit_name: subredditName,
      need_format: needFormat,
    }))
    if (args.includeStyle ?? true) {
      calls.push(await call("subreddit style/rules", "/api/v1/reddit/app/fetch_subreddit_style", {
        subreddit_name: subredditName,
        need_format: needFormat,
      }))
    }
    calls.push(await call("subreddit feed", "/api/v1/reddit/app/fetch_subreddit_feed", {
      subreddit_name: subredditName,
      sort: normalizeFeedSort(args.sort),
      after: args.after,
      need_format: needFormat,
    }))
    const subredditId = args.subredditId || extractSubredditId(calls)
    if (subredditId && (args.includeSettings ?? true)) {
      calls.push(await call("subreddit settings", "/api/v1/reddit/app/fetch_subreddit_settings", {
        subreddit_id: subredditId,
        need_format: needFormat,
      }))
    }
    if (subredditId && (args.includeHighlights ?? true)) {
      calls.push(await call("community highlights", "/api/v1/reddit/app/fetch_community_highlights", {
        subreddit_id: subredditId,
        need_format: needFormat,
      }))
    }
    return calls
  }

  if (args.operation === "deep_thread") {
    const postId = need(args.postId, "postId is required for deep_thread")
    const sortType = normalizeCommentSort(args.sort)
    calls.push(await call("post details", "/api/v1/reddit/app/fetch_post_details", {
      post_id: postId,
      need_format: needFormat,
    }))
    calls.push(await call("post comments", "/api/v1/reddit/app/fetch_post_comments", {
      post_id: postId,
      sort_type: sortType,
      after: args.after,
      need_format: needFormat,
    }))
    if (args.includeReplies ?? true) {
      const maxReplyCursors = Math.min(Math.max(args.maxReplyCursors ?? 3, 0), 8)
      for (const cursor of extractReplyCursors(calls, maxReplyCursors)) {
        calls.push(await call(`collapsed replies ${calls.length}`, "/api/v1/reddit/app/fetch_comment_replies", {
          post_id: postId,
          cursor,
          sort_type: sortType,
          need_format: needFormat,
        }))
      }
    }
    return calls
  }

  if (args.operation === "thread_intelligence") {
    const postIds = (args.postIds && args.postIds.length > 0 ? args.postIds : args.postId ? [args.postId] : [])
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 5)
    if (postIds.length === 0) throw new Error("postIds or postId is required for thread_intelligence")
    const sortType = normalizeCommentSort(args.sort)
    const maxReplyCursors = Math.min(Math.max(args.maxReplyCursors ?? 2, 0), 5)

    for (const postId of postIds) {
      const before = calls.length
      calls.push(await call(`post details ${postId}`, "/api/v1/reddit/app/fetch_post_details", {
        post_id: postId,
        need_format: needFormat,
      }))
      calls.push(await call(`post comments ${postId}`, "/api/v1/reddit/app/fetch_post_comments", {
        post_id: postId,
        sort_type: sortType,
        need_format: needFormat,
      }))
      if (args.includeReplies ?? true) {
        const postCalls = calls.slice(before)
        for (const cursor of extractReplyCursors(postCalls, maxReplyCursors)) {
          calls.push(await call(`collapsed replies ${postId}`, "/api/v1/reddit/app/fetch_comment_replies", {
            post_id: postId,
            cursor,
            sort_type: sortType,
            need_format: needFormat,
          }))
        }
      }
    }

    return calls
  }

  if (args.operation === "author_context") {
    const username = need(args.username, "username is required for author_context").replace(/^u\//, "")
    calls.push(await call("user profile", "/api/v1/reddit/app/fetch_user_profile", {
      username,
      need_format: needFormat,
    }))
    calls.push(await call("active subreddits", "/api/v1/reddit/app/fetch_user_active_subreddits", {
      username,
      need_format: needFormat,
    }))
    if (args.includeUserHistory ?? true) {
      calls.push(await call("user posts", "/api/v1/reddit/app/fetch_user_posts", {
        username,
        sort: normalizeSort(args.sort, ["NEW", "TOP", "HOT", "CONTROVERSIAL"], "NEW"),
        after: args.afterTarget === "user_posts" ? args.after : undefined,
        need_format: needFormat,
      }))
      calls.push(await call("user comments", "/api/v1/reddit/app/fetch_user_comments", {
        username,
        sort: normalizeSort(args.sort, ["NEW", "TOP", "HOT", "CONTROVERSIAL"], "NEW"),
        page_size: 25,
        after: args.afterTarget === "user_comments" ? args.after : undefined,
        need_format: needFormat,
      }))
    }
    return calls
  }

  if (args.operation === "batch_enrich") {
    const postIds = (args.postIds || []).map((id) => id.trim()).filter(Boolean)
    if (postIds.length === 0) throw new Error("postIds is required for batch_enrich")
    const endpoint = postIds.length > 5
      ? "/api/v1/reddit/app/fetch_post_details_batch_large"
      : "/api/v1/reddit/app/fetch_post_details_batch"
    calls.push(await call(postIds.length > 5 ? "large batch post details" : "batch post details", endpoint, {
      post_ids: postIds.slice(0, 30).join(","),
      need_format: needFormat,
    }))
    return calls
  }

  if (args.operation === "feed_discovery") {
    const feed = args.feed ?? "popular"
    if (feed === "popular") {
      calls.push(await call("popular feed", "/api/v1/reddit/app/fetch_popular_feed", {
        sort: normalizeFeedSort(args.sort),
        time: args.timeRange?.toUpperCase() ?? "ALL",
        after: args.after,
        need_format: needFormat,
      }))
    } else if (feed === "news") {
      calls.push(await call("news feed", "/api/v1/reddit/app/fetch_news_feed", {
        subtopic_ids: ["all"],
        after: args.after,
        need_format: needFormat,
      }))
    } else if (feed === "subreddit") {
      const subredditName = need(args.subredditName, "subredditName is required for subreddit feed discovery").replace(/^r\//, "")
      calls.push(await call("subreddit feed", "/api/v1/reddit/app/fetch_subreddit_feed", {
        subreddit_name: subredditName,
        sort: normalizeFeedSort(args.sort),
        after: args.after,
        need_format: needFormat,
      }))
    } else {
      calls.push(await call("subreddit post channels", "/api/v1/reddit/app/fetch_subreddit_post_channels", {
        subreddit_name: args.subredditName?.replace(/^r\//, ""),
        sort: normalizeFeedSort(args.sort, "HOT"),
        range: args.timeRange?.toUpperCase() ?? "DAY",
        need_format: needFormat,
      }))
    }
    return calls
  }

  return calls
}

function formatOutput(args: ToolArgs, calls: TikHubCall[]): string {
  const maxItems = Math.min(Math.max(args.maxItems ?? DEFAULT_MAX_ITEMS, 1), MAX_MAX_ITEMS)
  const classified = classifyCalls(calls)
  const querySignals = collectQuerySignals(calls, maxItems)
  const communities = collectCommunitySignals(calls, maxItems)
  const candidates = collectCandidates(calls, maxItems)
  const commentHighlights = collectCommentHighlights(calls, Math.min(maxItems, 12))
  const successCount = calls.filter((call) => !call.error).length
  const failed = calls.filter((call) => call.error)
  const thin = classified.filter((call) => !call.error && call.usefulRecords === 0)
  const postIds = Array.from(new Set(calls.flatMap((call) => collectStringsByKey(call.data, /(^id$|name|post.*id|thing_id)/i, /^t3_[A-Za-z0-9_]+$/)))).slice(0, 20)
  const subredditIds = Array.from(new Set(calls.flatMap((call) => collectStringsByKey(call.data, /(^id$|name|subreddit.*id)/i, /^t5_[A-Za-z0-9_]+$/)))).slice(0, 12)
  const replyCursors = extractReplyCursors(calls, 10)

  const lines: string[] = []
  if (successCount === 0) lines.push("ERROR: All TikHub Reddit endpoint calls failed; see per-call diagnostics below.", "")
  lines.push(`# TikHub Reddit ${args.operation}`)
  lines.push("")
  lines.push(`Calls: ${successCount}/${calls.length} succeeded`)
  lines.push(`Useful records: ${classified.reduce((total, call) => total + call.usefulRecords, 0)} extracted (${thin.length} thin successful calls)`)
  lines.push(`TikHub base: ${tikhubBaseUrl()}`)
  lines.push(`Display cap: ${maxItems} per evidence section; raw excerpts are truncated, not a complete dataset.`)
  lines.push("")
  const notes = calls.flatMap((call) => (call.notes ?? []).map((note) => `${call.label}: ${note}`))
  if (args.timeRange !== undefined && !calls.some((call) => ["time_range", "time", "range"].some((key) => call.params[key] !== undefined))) notes.push(`Unsupported timeRange for ${args.operation}/${args.feed ?? ""}; not applied.`)
  if (args.sort !== undefined && !calls.some((call) => call.params.sort !== undefined || call.params.sort_type !== undefined)) notes.push(`Unsupported sort for ${args.operation}/${args.feed ?? ""}; not applied.`)
  if (args.after !== undefined && !calls.some((call) => call.params.after === args.after)) notes.push("Unsupported after cursor for this operation; not applied.")
  if (args.allowNsfw !== undefined && !calls.some((call) => call.params.allow_nsfw !== undefined)) notes.push("Unsupported allowNsfw for this operation; not applied.")
  if (args.searchType !== undefined && args.operation !== "query_scout") notes.push("searchType applies only to query_scout; not applied.")
  if (args.afterTarget !== undefined && args.operation !== "author_context") notes.push("afterTarget applies only to author_context; not applied.")
  const optionOperations: Partial<Record<keyof ToolArgs, Operation[]>> = {
    includeSettings: ["subreddit_context"],
    includeStyle: ["subreddit_context"],
    includeHighlights: ["subreddit_context"],
    includeSubredditContext: ["discovery_bundle"],
    includeBatchEnrich: ["discovery_bundle"],
    includeUserHistory: ["author_context"],
    includeReplies: ["deep_thread", "thread_intelligence"],
    maxReplyCursors: ["deep_thread", "thread_intelligence"],
    feed: ["feed_discovery"],
  }
  for (const [option, operations] of Object.entries(optionOperations)) {
    if (Object.prototype.hasOwnProperty.call(args, option) && !operations.includes(args.operation)) notes.push(`${option} is unsupported for ${args.operation}; not applied.`)
  }
  if (args.operation === "thread_intelligence" && (args.maxReplyCursors ?? 0) > 5) notes.push("thread_intelligence caps maxReplyCursors at 5 per post.")
  if (args.operation === "discovery_bundle") notes.push("Bundle filters/cursor apply to post search; comment/community searches and contextual feeds have separate coverage.")
  if (notes.length) lines.push("## Filter / Coverage Notes", ...notes.map((note) => `- ${note}`), "")

  lines.push("## Endpoint Calls")
  lines.push("| Label | Endpoint | Status | Key Params |")
  lines.push("|---|---|---|---|")
  for (const call of calls) {
    const params = Object.entries(call.params)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`)
      .join("; ")
    lines.push(`| ${call.label} | \`${call.endpoint}\` | ${call.error ? "failed" : "ok"} | ${params.replace(/\|/g, "\\|")} |`)
  }
  lines.push("")

  if (failed.length > 0) {
    lines.push("## Call Failures")
    for (const call of failed) {
      lines.push(`- ${call.label}: ${call.error}`)
    }
    lines.push("")
  }

  if (thin.length > 0) {
    lines.push("## Thin Successful Calls")
    for (const call of thin) {
      lines.push(`- ${call.label}: request succeeded but no query/community/post/comment records were confidently extracted.`)
    }
    lines.push("")
  }

  if (querySignals.length > 0) {
    lines.push("## Query Suggestions")
    querySignals.forEach((signal, index) => lines.push(formatQuerySignal(signal, index + 1)))
    lines.push("")
  }

  if (communities.length > 0) {
    lines.push("## Candidate Communities")
    communities.forEach((community, index) => lines.push(formatCommunitySignal(community, index + 1)))
    lines.push("")
  }

  if (candidates.length > 0) {
    lines.push("## Candidate Posts / Items")
    candidates.forEach((candidate, index) => lines.push(formatCandidate(candidate, index + 1)))
    lines.push("")
  }

  if (commentHighlights.length > 0) {
    lines.push("## Comment Highlights")
    commentHighlights.forEach((comment, index) => lines.push(formatCommentHighlight(comment, index + 1)))
    lines.push("")
  }

  lines.push("## Follow-Up Handles")
  const followUpPostIds = Array.from(new Set([...postIds, ...candidates.flatMap((candidate) => candidate.id?.startsWith("t3_") ? [candidate.id] : [])]))
  lines.push(`- Post IDs: ${followUpPostIds.length ? followUpPostIds.map((id) => `\`${id}\``).join(", ") : "none surfaced"}`)
  lines.push(`- Subreddit IDs: ${subredditIds.length ? subredditIds.map((id) => `\`${id}\``).join(", ") : "none surfaced"}`)
  lines.push(`- Reply cursors: ${replyCursors.length ? replyCursors.slice(0, 5).map((cursor) => `\`${cursor}\``).join(", ") : "none surfaced"}`)
  for (const call of calls) {
    if (call.error) continue
    const envelope = asRecord(call.data)
    const cursors = collectStringsByKey(envelope?.data ?? call.data, /^(after|endCursor|end_cursor|next_cursor|nextCursor)$/i, /[\s\S]+/)
    if (cursors.length) lines.push(`- Listing pagination for ${call.label} (${call.endpoint}): ${JSON.stringify(cursors)}. Reuse only for this listing, keeping its query/filter context.`)
  }
  lines.push("- Collapsed replies are bounded by maxReplyCursors; surfaced cursors do not prove the entire tree was completed.")
  lines.push("")

  lines.push("## Raw Response Samples")
  for (const call of calls.filter((item) => !item.error).slice(0, 6)) {
    lines.push(`### ${call.label}`)
    lines.push("```json")
    lines.push(safeJsonSnippet(call.data, 2200))
    lines.push("```")
  }

  return lines.join("\n")
}

export const reddit = {
  description:
    "Use TikHub's native Reddit API surface for advanced Reddit discovery and enrichment: " +
    "discovery bundles with typeahead/search/trending/context, subreddit context cards, thread intelligence with collapsed replies, " +
    "author activity context, batch post enrichment, and feed/trend discovery. Requires TIKHUB_API_KEY.",
  async execute(args, context) {
    try {
      const typedArgs = args as ToolArgs
      if (!OPERATION_VALUES.includes(typedArgs.operation)) throw new Error("Unknown operation")
      if (!process.env.TIKHUB_API_KEY?.trim()) throw new Error("TIKHUB_API_KEY not set")
      if (typedArgs.searchType !== undefined && !SEARCH_TYPE_VALUES.includes(typedArgs.searchType)) throw new Error("Unknown searchType")
      if (typedArgs.timeRange !== undefined && !TIME_RANGE_VALUES.includes(typedArgs.timeRange)) throw new Error("Unknown timeRange")
      if (typedArgs.feed !== undefined && !FEED_VALUES.includes(typedArgs.feed)) throw new Error("Unknown feed")
      if (typedArgs.afterTarget !== undefined && !["user_posts", "user_comments"].includes(typedArgs.afterTarget)) throw new Error("Unknown afterTarget")
      if (typedArgs.after && typedArgs.operation === "author_context" && !typedArgs.afterTarget) throw new Error("author_context pagination requires afterTarget=user_posts or user_comments; their cursors are not interchangeable")
      if (typedArgs.postIds && typedArgs.postIds.length > (typedArgs.operation === "thread_intelligence" ? 5 : 30)) throw new Error("Too many postIds; thread_intelligence supports 5 and batch_enrich supports 30")
      const calls = await buildCalls(typedArgs, context)
      const text = redactDiagnostics(formatOutput(typedArgs, calls))
      // All calls failing is reported as an ERROR by formatOutput; some failing is partial.
      const failedCalls = calls.filter((call) => call.error).length
      return failedCalls > 0 && failedCalls < calls.length ? outcome("partial", text) : text
    } catch (err) {
      if (context.abort.aborted) return "ERROR: TikHub Reddit cancelled; cancellation is not provider failure or evidence absence."
      return `ERROR: TikHub Reddit failed: ${redactDiagnostics(err instanceof Error ? err.message : "Unknown error")}`
    }
  },
} satisfies ToolSpec
