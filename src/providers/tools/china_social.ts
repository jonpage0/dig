/**
 * China-social research tools.
 *
 * One user-facing search tool with an internal provider-selection layer.
 * TikHub is the primary live backend. Just One API is a credential-gated
 * fallback using its cross-platform search endpoint.
 *
 * Search currently covers Xiaohongshu, Bilibili, Douyin, Weibo, Zhihu,
 * Kuaishou, and WeChat. Provider standing is reported from each run rather
 * than frozen in this prompt: endpoint, HTTP status, attempts, latency,
 * normalized count, and request id when supplied.
 *
 * Exported tool name:
 *   - china_social_search
 *
 * Environment variables:
 *   - TIKHUB_API_KEY (required for active TikHub backend)
 *   - TIKHUB_BASE_URL (optional; defaults to https://api.tikhub.io)
 *   - JUSTONE_API_KEY (required only when provider=justone)
 *   - JUSTONE_BASE_URL (optional; defaults to https://api.justoneapi.com)
 */
import { requestJson } from "../http.js"
import type { KeepRaw, ToolSpec } from "../types.js"

const CHINA_SOCIAL_PLATFORM_VALUES = [
  "xiaohongshu",
  "bilibili",
  "douyin",
  "weibo",
  "zhihu",
  "kuaishou",
  "wechat",
] as const
const CHINA_SOCIAL_PROVIDER_VALUES = ["auto", "tikhub", "justone"] as const
const WEIBO_SEARCH_TYPE_VALUES = ["normal", "realtime", "hot", "original", "verified", "media", "viewpoint", "image", "video", "user", "topic"] as const
const WECHAT_VERTICAL_VALUES = ["all", "account", "article", "video", "sticker", "live_stream", "moments", "news", "book", "listen", "image", "encyclopedia", "weixin_index"] as const

type ChinaSocialPlatform = (typeof CHINA_SOCIAL_PLATFORM_VALUES)[number]
type ChinaSocialProviderId = (typeof CHINA_SOCIAL_PROVIDER_VALUES)[number]
type ActiveChinaSocialProviderId = Exclude<ChinaSocialProviderId, "auto">
type ChinaSocialSort = "relevance" | "latest" | "hot"
type ChinaSocialTimeRange = "all" | "day" | "week" | "month" | "half_year"
type WeiboSearchType = (typeof WEIBO_SEARCH_TYPE_VALUES)[number]
type SearchCursor = string | { search_id: string; search_session_id: string } | { cursor: number; search_id: string; backtrace: string }
type WechatVertical = (typeof WECHAT_VERTICAL_VALUES)[number]

type SearchItem = {
  platform: ChinaSocialPlatform
  id?: string | null
  handles?: Record<string, string>
  title: string
  author: string | null
  summary: string | null
  url: string | null
  publishedAt: string | null
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  saves: number | null
  tags: string[]
}

type PlatformSearchResult = {
  platform: ChinaSocialPlatform
  provider: ActiveChinaSocialProviderId
  endpoint: string
  items: SearchItem[]
  notes: string[]
  rawCount: number | null
  rawFallback: string | null
  httpStatus: number
  attempts: number
  durationMs: number
  requestId: string | null
  nextCursor: SearchCursor | null
  availability?: Record<string, unknown>
}

type PlatformSearchFailure = {
  platform: ChinaSocialPlatform
  provider: ActiveChinaSocialProviderId
  message: string
}

type ProviderJsonResult = {
  payload: Record<string, unknown>
  httpStatus: number
  attempts: number
  durationMs: number
  requestId: string | null
}

type ProviderSearchArgs = {
  query: string
  platform: ChinaSocialPlatform
  limit: number
  page: number
  cursor: SearchCursor | null
  justoneStart?: string
  justoneEnd?: string
  sort: ChinaSocialSort
  timeRange: ChinaSocialTimeRange
  weiboSearchType: WeiboSearchType
  wechatVertical: WechatVertical
  signal: AbortSignal
  keep: KeepRaw
}

interface ChinaSocialProvider {
  id: ActiveChinaSocialProviderId
  label: string
  supports(platform: ChinaSocialPlatform): boolean
  search(args: ProviderSearchArgs): Promise<PlatformSearchResult>
}

// Read per request, so base URLs loaded from keys.env after startup apply.
const tikhubBaseUrl = () => process.env.TIKHUB_BASE_URL?.trim() || "https://api.tikhub.io"
const justoneBaseUrl = () => process.env.JUSTONE_BASE_URL?.trim() || "https://api.justoneapi.com"
const DEFAULT_PLATFORM_SLICE: ChinaSocialPlatform[] = ["xiaohongshu", "bilibili", "douyin"]
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 8
const DEFAULT_TIKHUB_TIMEOUT_MS = 60_000
const DEFAULT_PAGE = 1

function tikhubHeaders(): Record<string, string> {
  const token = process.env.TIKHUB_API_KEY?.trim()
  if (!token) {
    throw new Error("TIKHUB_API_KEY not set")
  }

  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "opencode-china-social-tool/1.0",
  }
}

function normalizeWhitespace(value: string | undefined | null): string | null {
  if (!value) {
    return null
  }

  const normalized = value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  return normalized || null
}

function truncateText(value: string | null, maxLength: number): string | null {
  if (!value) {
    return null
  }

  if (value.length <= maxLength) {
    return value
  }

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
    if (typeof value === "string") {
      const normalized = normalizeWhitespace(value)
      if (normalized) {
        return normalized
      }
    }
  }

  return null
}

function opaqueString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? null
}

// Tokenize strings as a whole before numbers, so digits inside text/URLs remain untouched.
// Quote large integer tokens before JSON.parse can round provider IDs.
function parseProviderJson(text: string): unknown {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) => {
    if (/^-?\d{16,}$/.test(token)) return JSON.stringify(token)
    return token
  }))
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

function uniqStrings(values: Array<string | null | undefined>): string[] {
  const deduped = new Set<string>()

  for (const value of values) {
    if (!value) {
      continue
    }

    const normalized = normalizeWhitespace(value)
    if (normalized) {
      deduped.add(normalized)
    }
  }

  return Array.from(deduped)
}

function toIsoDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1_000_000_000_000 ? value : value * 1000
    try {
      return new Date(millis).toISOString()
    } catch {
      return null
    }
  }

  if (typeof value !== "string") {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  if (/^\d{10,13}$/.test(trimmed)) {
    return toIsoDate(Number(trimmed))
  }

  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? trimmed : new Date(parsed).toISOString()
}

function formatNumber(value: number | null): string | null {
  if (value === null) {
    return null
  }

  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toString()
}

function safeJsonSnippet(value: unknown, maxLength = 1400): string | null {
  try {
    const serialized = redactDiagnostics(JSON.stringify(value, null, 2) ?? "")
    if (!serialized) {
      return null
    }

    return serialized.length <= maxLength
      ? serialized
      : `${serialized.slice(0, maxLength - 1).trimEnd()}…`
  } catch {
    return null
  }
}

function dedupeItems(items: SearchItem[]): SearchItem[] {
  const seen = new Set<string>()
  const deduped: SearchItem[] = []

  for (const item of items) {
    const key = item.id ? `${item.platform}:${item.id}` : item.url || `${item.platform}:${item.title}:${item.author || "unknown"}`
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    deduped.push(item)
  }

  return deduped
}

function redactDiagnostics(text: string): string {
  for (const name of ["TIKHUB_API_KEY", "SCRAPECREATORS_API_KEY", "JUSTONE_API_KEY"]) {
    const key = process.env[name]?.trim()
    if (key) text = text.replaceAll(key, "[redacted]").replaceAll(encodeURIComponent(key), "[redacted]")
  }
  return text
}

function collectRecords(value: unknown, maxDepth = 6): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []

  function visit(current: unknown, depth: number) {
    if (depth > maxDepth) {
      return
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item, depth + 1)
      }
      return
    }

    const record = asRecord(current)
    if (!record) {
      return
    }

    records.push(record)

    for (const nested of Object.values(record)) {
      if (Array.isArray(nested) || asRecord(nested)) {
        visit(nested, depth + 1)
      }
    }
  }

  visit(value, 0)
  return records
}

async function fetchTikHubJson(args: {
  endpoint: string
  method?: "GET" | "POST"
  query?: Record<string, string | number>
  body?: Record<string, unknown>
  signal: AbortSignal
  keep: KeepRaw
}): Promise<ProviderJsonResult> {
  const headers = {
    ...tikhubHeaders(),
    ...(args.body ? { "Content-Type": "application/json" } : {}),
  }
  const url = new URL(args.endpoint, tikhubBaseUrl())

  for (const [key, value] of Object.entries(args.query ?? {})) {
    url.searchParams.set(key, String(value))
  }

  const response = await requestJson({
    url,
    method: args.method ?? "GET",
    headers,
    body: args.body,
    signal: args.signal,
    timeoutMs: DEFAULT_TIKHUB_TIMEOUT_MS,
    provider: "TikHub",
    keep: args.keep,
    label: args.endpoint,
    parseJson: parseProviderJson,
  })
  const record = asRecord(response.payload)
  if (response.status < 200 || response.status >= 300) {
    const detail = asRecord(record?.detail)
    const message =
      firstString(detail?.message, detail?.message_zh, record?.message, record?.message_zh) ||
      "Unknown TikHub error"
    throw new Error(`TikHub returned ${response.status}: ${message}`)
  }
  if (!record) {
    throw new Error("TikHub returned a non-object JSON payload")
  }

  const code = firstNumber(record.code)
  if (code !== null && code >= 400) {
    const message = firstString(record.message, record.message_zh) || "Unknown TikHub error"
    throw new Error(message)
  }

  return {
    payload: record,
    httpStatus: response.status,
    attempts: response.attempts,
    durationMs: response.durationMs,
    requestId: firstString(record.request_id) ?? response.requestId ?? null,
  }
}

function normalizeXiaohongshuItems(payload: Record<string, unknown>, limit: number): SearchItem[] {
  const data = payload.data ?? payload
  const records = collectRecords(data)

  const items = records.flatMap((record): SearchItem[] => {
    const note = asRecord(record.note) || asRecord(record.note_card) || asRecord(record.noteCard) || record
    const user = asRecord(note.user) || asRecord(note.author)
    const interact = asRecord(note.interact_info) || asRecord(note.interactInfo)
    const noteId = firstString(note.note_id, note.noteId, note.id, record.note_id, record.id)
    const title = firstString(note.display_title, note.title, note.note_title)
    const summary = truncateText(firstString(note.desc, note.display_desc, note.content, title), 220)

    if (!noteId || !title) {
      return []
    }

    return [
      {
        platform: "xiaohongshu",
        title,
        author: firstString(user?.nickname, user?.nick_name, user?.name),
        summary,
        url: `https://www.xiaohongshu.com/explore/${noteId}`,
        publishedAt: toIsoDate(note.time ?? note.timestamp ?? note.publish_time ?? note.last_update_time ?? note.update_time),
        views: firstNumber(interact?.view_count, note.view_count),
        likes: firstNumber(interact?.liked_count, note.liked_count, note.like_count),
        comments: firstNumber(interact?.comment_count, note.comment_count, note.comments_count),
        shares: firstNumber(interact?.share_count, note.share_count, note.shared_count),
        saves: firstNumber(interact?.collected_count, note.collected_count, note.favorite_count),
        tags: uniqStrings([
          firstString(asRecord(note.tag_info)?.title),
          ...(asArray(note.tag_list).map((tag) => firstString(asRecord(tag)?.name, tag)) ?? []),
        ]),
      },
    ]
  })

  return dedupeItems(items).slice(0, limit)
}

function normalizeBilibiliItems(payload: Record<string, unknown>, limit: number): SearchItem[] {
  const data = payload.data ?? payload
  const records = collectRecords(data)

  const items = records.flatMap((record): SearchItem[] => {
    const title = firstString(record.title)
    const bvid = firstString(record.bvid)
    const url =
      firstString(record.arcurl, record.url, record.share_url) ||
      (bvid ? `https://www.bilibili.com/video/${bvid}` : null)

    if (!title || !url) {
      return []
    }

    return [
      {
        platform: "bilibili",
        title,
        author: firstString(record.author, record.up_name, record.uname),
        summary: truncateText(
          firstString(record.description, record.desc, asArray(record.hit_columns)[0]),
          220
        ),
        url,
        publishedAt: toIsoDate(record.pubdate ?? record.created),
        views: firstNumber(record.play, record.view),
        likes: firstNumber(record.like),
        comments: firstNumber(record.video_review, record.review, record.comment),
        shares: firstNumber(record.share),
        saves: firstNumber(record.favorite, record.favorites),
        tags: uniqStrings([
          firstString(record.tag),
          firstString(record.typename),
          ...(asArray(record.tags).map((tag) => firstString(asRecord(tag)?.tag_name, tag)) ?? []),
        ]),
      },
    ]
  })

  return dedupeItems(items).slice(0, limit)
}

function normalizeDouyinItems(payload: Record<string, unknown>, limit: number): SearchItem[] {
  const data = payload.data ?? payload
  const records = collectRecords(data)

  const items = records.flatMap((record): SearchItem[] => {
    const aweme = asRecord(record.aweme_info) || asRecord(record.awemeInfo) || record
    const author = asRecord(aweme.author)
    const statistics = asRecord(aweme.statistics)
    const awemeId = firstString(aweme.aweme_id, aweme.awemeId, record.aweme_id, record.id)
    const title = firstString(aweme.desc, aweme.title, aweme.text)

    if (!awemeId || !title) {
      return []
    }

    return [
      {
        platform: "douyin",
        title,
        author: firstString(author?.nickname, author?.unique_id, author?.short_id),
        summary: truncateText(firstString(aweme.desc, aweme.preview_title, aweme.text), 220),
        url: `https://www.douyin.com/video/${awemeId}`,
        publishedAt: toIsoDate(aweme.create_time ?? aweme.publish_time),
        views: firstNumber(statistics?.play_count, aweme.play_count),
        likes: firstNumber(statistics?.digg_count, statistics?.like_count, aweme.like_count),
        comments: firstNumber(statistics?.comment_count, aweme.comment_count),
        shares: firstNumber(statistics?.share_count, aweme.share_count),
        saves: firstNumber(statistics?.collect_count, aweme.collect_count),
        tags: uniqStrings([
          ...(asArray(aweme.text_extra)
            .map((tag) => firstString(asRecord(tag)?.hashtag_name, asRecord(tag)?.tag_name))
            .filter(Boolean) as string[]),
        ]),
      },
    ]
  })

  return dedupeItems(items).slice(0, limit)
}

function normalizeWeiboItems(payload: Record<string, unknown>, limit: number): SearchItem[] {
  const data = payload.data ?? payload
  const records = collectRecords(data)

  const items = records.flatMap((record): SearchItem[] => {
    const post = asRecord(record.mblog) || asRecord(record.blog) || record
    const user = asRecord(post.user) || asRecord(post.author)
    const pageInfo = asRecord(post.page_info) || asRecord(post.pageInfo)
    const rawText = firstString(post.text_raw, post.text, post.content, record.text_raw, record.text)
    const title = truncateText(firstString(record.title, post.title, rawText), 120)
    const postId = firstString(post.idstr, post.mblogid, post.mid, post.weibo_id, post.id, record.idstr, record.mblogid, record.mid, record.id)
    const hasPostSignal =
      !!firstString(post.created_at, post.createdAt) ||
      firstNumber(post.attitudes_count, post.comments_count, post.reposts_count, pageInfo?.play_count) !== null

    if (!postId || !title || (!hasPostSignal && !rawText)) {
      return []
    }

    return [
      {
        platform: "weibo",
        title,
        author: firstString(user?.screen_name, user?.screenName, user?.name),
        summary: truncateText(rawText ?? firstString(post.source, record.desc), 220),
        url:
          firstString(post.scheme, post.url, pageInfo?.page_url, pageInfo?.url, record.url) ||
          `https://weibo.com/status/${postId}`,
        publishedAt: toIsoDate(post.created_at ?? post.createdAt),
        views: firstNumber(pageInfo?.play_count, pageInfo?.page_views, post.read_count, record.read_count),
        likes: firstNumber(post.attitudes_count, post.like_count),
        comments: firstNumber(post.comments_count, post.comment_count),
        shares: firstNumber(post.reposts_count, post.repost_count, post.share_count),
        saves: firstNumber(post.favorited_count, post.favorite_count),
        tags: uniqStrings([
          firstString(pageInfo?.object_type),
          ...(asArray(post.topic_struct).map((topic) =>
            firstString(
              asRecord(topic)?.topic_title,
              asRecord(topic)?.title,
              asRecord(topic)?.topic_name,
              topic
            )
          ) ?? []),
        ]),
      },
    ]
  })

  return dedupeItems(items).slice(0, limit)
}

function buildZhihuUrl(args: {
  itemType: string | null
  itemId: string | null
  questionId: string | null
  explicitUrl: string | null
}): string | null {
  if (args.explicitUrl) {
    return args.explicitUrl
  }

  switch (args.itemType) {
    case "article":
      return args.itemId ? `https://zhuanlan.zhihu.com/p/${args.itemId}` : null
    case "answer":
      return args.itemId && args.questionId
        ? `https://www.zhihu.com/question/${args.questionId}/answer/${args.itemId}`
        : args.questionId
          ? `https://www.zhihu.com/question/${args.questionId}`
          : null
    case "question":
      return args.questionId || args.itemId
        ? `https://www.zhihu.com/question/${args.questionId ?? args.itemId}`
        : null
    case "zvideo":
      return args.itemId ? `https://www.zhihu.com/zvideo/${args.itemId}` : null
    default:
      return args.questionId
        ? `https://www.zhihu.com/question/${args.questionId}`
        : args.itemId
          ? `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(args.itemId)}`
          : null
  }
}

function normalizeZhihuItems(payload: Record<string, unknown>, limit: number): SearchItem[] {
  const data = payload.data ?? payload
  const records = collectRecords(data)
  const supportedTypes = new Set(["answer", "article", "question", "zvideo"])

  const items = records.flatMap((record): SearchItem[] => {
    const target = asRecord(record.object) || asRecord(record.target) || record
    const question = asRecord(target.question) || asRecord(record.question)
    const author = asRecord(target.author) || asRecord(record.author)
    const itemType = firstString(target.type, target.object_type, record.type, record.object_type)?.toLowerCase() || null

    if (itemType && !supportedTypes.has(itemType)) {
      return []
    }

    const itemId = firstString(
      target.id,
      target.answer_id,
      target.article_id,
      target.zvideo_id,
      target.url_token,
      record.id,
      record.answer_id,
      record.article_id
    )
    const questionId = firstString(question?.id, question?.question_id, target.question_id, record.question_id)
    const title =
      firstString(target.title, question?.name, question?.title, record.title, record.name) ||
      truncateText(firstString(target.excerpt, target.description, record.excerpt), 120)
    const explicitUrl = firstString(target.url, target.share_url, record.url)
    const url = buildZhihuUrl({ itemType, itemId, questionId, explicitUrl })

    if (!title || (!itemId && !url)) {
      return []
    }

    return [
      {
        platform: "zhihu",
        title,
        author: firstString(author?.name, author?.headline),
        summary: truncateText(
          firstString(target.excerpt, target.description, target.content, record.excerpt, record.content),
          220
        ),
        url,
        publishedAt: toIsoDate(target.created_time ?? target.created ?? target.updated_time ?? record.created_time),
        views: firstNumber(target.read_count, target.view_count, target.visits_count, record.read_count),
        likes: firstNumber(target.voteup_count, target.likes_count, target.like_count, record.voteup_count),
        comments: firstNumber(target.comment_count, target.comments_count, record.comment_count),
        shares: firstNumber(target.share_count, record.share_count),
        saves: firstNumber(target.favlists_count, target.favorite_count, record.favlists_count),
        tags: uniqStrings([
          itemType,
          ...(asArray(target.topics ?? question?.topics ?? record.topics).map((topic) =>
            firstString(asRecord(topic)?.name, asRecord(topic)?.title, asRecord(topic)?.topic_name, topic)
          ) ?? []),
        ]),
      },
    ]
  })

  return dedupeItems(items).slice(0, limit)
}

function extractRawCount(payload: Record<string, unknown>): number | null {
  const data = asRecord(payload.data)
  const paging = asRecord(data?.paging)
  const cardlistInfo = asRecord(data?.cardlistInfo)

  return firstNumber(
    payload.total,
    payload.total_number,
    data?.total,
    data?.count,
    data?.item_count,
    data?.cursor_count,
    paging?.totals,
    paging?.total,
    cardlistInfo?.total
  )
}

function normalizeKuaishouItems(payload: Record<string, unknown>, limit: number): SearchItem[] {
  const data = asRecord(payload.data)
  const items = asArray(data?.mixFeeds).flatMap((entry): SearchItem[] => {
    const feed = asRecord(asRecord(entry)?.feed)
    if (!feed) return []
    const shareInfo = firstString(feed.share_info)
    const shareParams = shareInfo ? new URLSearchParams(shareInfo) : null
    const photoId = shareParams?.get("photoId") || firstString(feed.photo_id)
    const title = firstString(feed.caption, feed.captionToComment)
    if (!photoId || !title) return []
    return [
      {
        platform: "kuaishou",
        title,
        author: firstString(feed.user_name),
        summary: truncateText(firstString(feed.caption, feed.captionToComment), 220),
        url: `https://www.kuaishou.com/short-video/${encodeURIComponent(photoId)}`,
        publishedAt: toIsoDate(feed.timestamp ?? feed.time),
        views: firstNumber(feed.view_count),
        likes: firstNumber(feed.like_count),
        comments: firstNumber(feed.comment_count),
        shares: firstNumber(feed.share_count),
        saves: null,
        tags: uniqStrings((title.match(/#[^#\s]+/g) ?? []).map((tag) => tag.slice(1))),
      },
    ]
  })
  return dedupeItems(items).slice(0, limit)
}

function normalizeCommonItems(
  payload: Record<string, unknown>,
  platform: ChinaSocialPlatform,
  limit: number
): SearchItem[] {
  const records = collectRecords(payload.data ?? payload)
  const items = records.flatMap((record): SearchItem[] => {
    const author = asRecord(record.author ?? record.user ?? record.owner ?? record.account)
    const jump = asRecord(record.jumpInfo)
    const statistics = asRecord(record.statistics ?? record.stats ?? record.metrics)
    const title = firstString(
      record.title,
      record.name,
      record.nickname,
      record.screen_name,
      record.desc,
      record.description,
      record.text,
      record.content
    )
    const id = opaqueString(record.docID, record.exportId, record.uid, record.id, record.note_id, record.aweme_id, record.aid, record.bvid, record.mid)
    const url = firstString(record.url, record.link, record.share_url, record.web_url, record.jump_url, jump?.url)
    if (!title || (!id && !url)) return []
    return [
      {
        platform,
        id,
        handles: Object.fromEntries(
          Object.entries({
            userName: opaqueString(jump?.userName),
            exportId: opaqueString(record.exportId),
            feedNonceId: opaqueString(asRecord(jump?.extInfo)?.feedNonceId),
          }).filter((entry): entry is [string, string] => entry[1] !== null)
        ),
        title,
        author: firstString(author?.name, author?.nickname, author?.screen_name, record.author_name, record.author, jump?.nickName, jump?.userName),
        summary: truncateText(
          firstString(record.summary, record.desc, record.description, record.text, record.content),
          220
        ),
        url,
        publishedAt: toIsoDate(record.published_at ?? record.publish_time ?? record.created_at ?? record.create_time),
        views: firstNumber(statistics?.views, statistics?.view_count, record.views, record.view_count),
        likes: firstNumber(statistics?.likes, statistics?.like_count, record.likes, record.like_count),
        comments: firstNumber(
          statistics?.comments,
          statistics?.comment_count,
          record.comments,
          record.comment_count
        ),
        shares: firstNumber(statistics?.shares, statistics?.share_count, record.shares, record.share_count),
        saves: firstNumber(
          statistics?.saves,
          statistics?.collect_count,
          record.saves,
          record.collect_count,
          record.favorite_count
        ),
        tags: uniqStrings([
          firstString(record.accTypeName),
          ...asArray(record.tags ?? record.hashtags).map((tag) =>
            firstString(asRecord(tag)?.name, asRecord(tag)?.title, tag)
          ),
        ]),
      },
    ]
  })
  return dedupeItems(items).slice(0, limit)
}

function normalizePlatformItems(
  payload: Record<string, unknown>,
  platform: ChinaSocialPlatform,
  limit: number
): SearchItem[] {
  switch (platform) {
    case "xiaohongshu":
      return normalizeXiaohongshuItems(payload, limit)
    case "bilibili":
      return normalizeBilibiliItems(payload, limit)
    case "douyin":
      return normalizeDouyinItems(payload, limit)
    case "weibo":
      return normalizeWeiboItems(payload, limit)
    case "zhihu":
      return normalizeZhihuItems(payload, limit)
    case "kuaishou":
      return normalizeKuaishouItems(payload, limit)
    case "wechat":
      return normalizeCommonItems(payload, platform, limit)
  }
}

function extractNextCursor(payload: Record<string, unknown>, search: ProviderSearchArgs, provider: ActiveChinaSocialProviderId): SearchCursor | null {
  const data = asRecord(payload.data)
  const nested = asRecord(data?.data)
  const business = asRecord(data?.business_config)
  const paging = asRecord(data?.paging)
  if (provider === "justone") return opaqueString(data?.nextCursor, payload.nextCursor)
  if (data?.has_more === false || data?.has_more === 0 || nested?.has_more === false || nested?.has_more === 0 || business?.has_more === false || business?.has_more === 0) return null
  if (search.platform === "xiaohongshu") {
    const prior = asRecord(search.cursor)
    const search_id = opaqueString(nested?.search_id, data?.search_id, prior?.search_id)
    const search_session_id = opaqueString(nested?.search_session_id, data?.search_session_id, prior?.search_session_id)
    return search_id && search_session_id ? { search_id, search_session_id } : null
  }
  if (search.platform === "douyin") {
    // Current V2 live response (2026-09-15) places continuation in business_config.
    const nextPage = asRecord(business?.next_page)
    const cursor = nextPage?.cursor ?? nested?.cursor ?? data?.cursor
    const search_id = opaqueString(nextPage?.search_id, nested?.search_id, data?.search_id)
    const backtrace = business?.backtrace ?? nested?.backtrace ?? data?.backtrace
    return typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor >= 0 && search_id && typeof backtrace === "string"
      ? { cursor, search_id, backtrace } : null
  }
  if (search.platform === "wechat" && data?.continue_flag !== true && data?.continue_flag !== 1) return null
  return opaqueString(
    data?.cursor,
    data?.pcursor,
    data?.recoPcursor,
    data?.next_cursor,
    data?.search_hash_id,
    paging?.next,
    paging?.next_cursor,
    payload.cursor,
    payload.pcursor
  )
}

function platformResult(args: {
  search: ProviderSearchArgs
  provider: ActiveChinaSocialProviderId
  endpoint: string
  response: ProviderJsonResult
  notes: string[]
}): PlatformSearchResult {
  const data = asRecord(args.response.payload.data)
  let items = args.provider === "justone"
    ? normalizeCommonItems(args.response.payload, args.search.platform, args.search.limit)
    : normalizePlatformItems(args.response.payload, args.search.platform, args.search.limit)
  if (args.provider === "tikhub" && args.search.platform === "weibo" && ["user", "topic"].includes(args.search.weiboSearchType)) {
    items = normalizeCommonItems(args.response.payload, "weibo", args.search.limit)
  }
  const nextCursor = extractNextCursor(args.response.payload, args.search, args.provider)
  const notes = [...args.notes, `Output capped at ${args.search.limit} normalized items; this is not a complete result census.`]
  if (!items.length && !data?.no_more && extractRawCount(args.response.payload) !== 0) {
    notes.push("No items normalized; response-shape coverage is uncertain, not evidence of no matching content. See raw excerpt.")
  }
  const nested = asRecord(data?.data)
  const business = asRecord(data?.business_config)
  if (!nextCursor && (data?.has_more === true || data?.has_more === 1 || nested?.has_more === true || nested?.has_more === 1 || business?.has_more === true || business?.has_more === 1 || data?.continue_flag === true || data?.continue_flag === 1)) {
    notes.push("Provider reports more results but complete reusable pagination state was not returned; pagination unavailable.")
  }
  return {
    platform: args.search.platform,
    provider: args.provider,
    endpoint: args.endpoint,
    items,
    notes,
    rawCount: extractRawCount(args.response.payload),
    rawFallback: safeJsonSnippet(args.response.payload.data ?? args.response.payload),
    httpStatus: args.response.httpStatus,
    attempts: args.response.attempts,
    durationMs: args.response.durationMs,
    requestId: args.response.requestId,
    nextCursor,
    ...(args.search.platform === "wechat" && args.provider === "tikhub" ? {
      availability: {
        categories: data?.categories ?? null,
        no_more: data?.no_more ?? null,
        continue_flag: data?.continue_flag ?? null,
        business_type: data?.business_type ?? null,
      },
    } : {}),
  }
}

function parseJustOnePayload(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof value.data !== "string") return value
  try {
    const parsed = parseProviderJson(value.data)
    return {
      ...value,
      data: asRecord(parsed) ?? parsed,
    }
  } catch {
    return value
  }
}

async function fetchJustOneJson(args: ProviderSearchArgs): Promise<ProviderJsonResult> {
  const token = process.env.JUSTONE_API_KEY?.trim()
  if (!token) throw new Error("JUSTONE_API_KEY not set")
  if (!args.cursor && (!args.justoneStart || !args.justoneEnd)) {
    throw new Error("Just One initial requests require justone_start and justone_end (yyyy-MM-dd HH:mm:ss); official prose requires them despite optional OpenAPI flags.")
  }
  const url = new URL("/api/search/v1", justoneBaseUrl())
  url.searchParams.set("token", token)
  url.searchParams.set("keyword", args.query)
  url.searchParams.set("source", args.platform === "wechat" ? "WEIXIN" : args.platform.toUpperCase())
  if (args.justoneStart) url.searchParams.set("start", args.justoneStart)
  if (args.justoneEnd) url.searchParams.set("end", args.justoneEnd)
  if (typeof args.cursor === "string") url.searchParams.set("nextCursor", args.cursor)
  // Do not return provider/transport diagnostics that may echo the token-bearing URL.
  const response = await requestJson({
    url,
    headers: { Accept: "application/json" },
    signal: args.signal,
    timeoutMs: DEFAULT_TIKHUB_TIMEOUT_MS,
    provider: "Just One API",
    keep: args.keep,
    label: "search/v1",
    parseJson: parseProviderJson,
  }).catch(() => {
    if (args.signal.aborted) throw new Error("Just One API request cancelled")
    throw new Error("Just One API transport failed (token-bearing diagnostics withheld)")
  })
  const record = asRecord(response.payload)
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Just One API returned HTTP ${response.status}`
    )
  }
  if (!record) throw new Error("Just One API returned a non-object JSON payload")
  const code = firstNumber(record.code)
  if (code !== 0) {
    throw new Error(`Just One API returned code ${code ?? "unknown"}`)
  }
  const payload = parseJustOnePayload(record)
  return {
    payload,
    httpStatus: response.status,
    attempts: response.attempts,
    durationMs: response.durationMs,
    requestId: firstString(record.requestId, record.request_id) ?? response.requestId ?? null,
  }
}

const tikHubProvider: ChinaSocialProvider = {
  id: "tikhub",
  label: "TikHub",
  supports(platform) {
    return CHINA_SOCIAL_PLATFORM_VALUES.includes(platform)
  },
  async search(args) {
    switch (args.platform) {
      case "xiaohongshu": {
        const endpoint = "/api/v1/xiaohongshu/app_v2/search_notes"
        const state = asRecord(args.cursor)
        if (args.cursor && (!opaqueString(state?.search_id) || !opaqueString(state?.search_session_id))) {
          throw new Error("Xiaohongshu cursor must contain search_id and search_session_id from the first response.")
        }
        if (args.page > 1 && !state) throw new Error("Xiaohongshu page > 1 requires the returned cursor object; session IDs cannot be guessed.")
        const response = await fetchTikHubJson({
          endpoint,
          query: {
            keyword: args.query,
            page: args.page,
            ...(state ? { search_id: String(state.search_id), search_session_id: String(state.search_session_id) } : {}),
            sort_type:
              args.sort === "latest"
                ? "time_descending"
                : args.sort === "hot"
                  ? "popularity_descending"
                  : "general",
            note_type: "不限",
            time_filter:
              args.timeRange === "day"
                ? "一天内"
                : args.timeRange === "week"
                  ? "一周内"
                  : args.timeRange === "half_year"
                      ? "半年内"
                      : "不限",
            source: "explore_feed",
            ai_mode: 0,
          },
          signal: args.signal,
          keep: args.keep,
        })
        return platformResult({
          search: args,
          provider: "tikhub",
          endpoint,
          response,
          notes: ["TikHub Xiaohongshu App V2 search-notes endpoint", ...(args.timeRange === "month" ? ["Unsupported month filter; used all time, not an undocumented month value."] : [])],
        })
      }
      case "bilibili": {
        const endpoint = "/api/v1/bilibili/web/fetch_general_search"
        const end = Math.floor(Date.now() / 1000)
        const days = { all: 0, day: 1, week: 7, month: 30, half_year: 180 }[args.timeRange]
        const response = await fetchTikHubJson({
          endpoint,
          query: {
            keyword: args.query,
            order: args.sort === "latest" ? "pubdate" : args.sort === "hot" ? "click" : "totalrank",
            page: args.page,
            page_size: Math.max(args.limit, 4),
            ...(days ? { pubtime_begin_s: end - days * 86400, pubtime_end_s: end } : {}),
          },
          signal: args.signal,
          keep: args.keep,
        })
        return platformResult({
          search: args,
          provider: "tikhub",
          endpoint,
          response,
          notes: [
            "TikHub Bilibili general search endpoint",
            days ? `Publication window sent: ${end - days * 86400}–${end} Unix seconds (${days} days)` : "No time filter requested",
          ],
        })
      }
      case "douyin": {
        const endpoint = "/api/v1/douyin/search/fetch_video_search_v2"
        const state = asRecord(args.cursor)
        if (args.cursor && (!state || typeof state.cursor !== "number" || !Number.isSafeInteger(state.cursor) || state.cursor < 0 || !opaqueString(state.search_id) || typeof state.backtrace !== "string")) {
          throw new Error("Douyin cursor must contain the returned integer cursor, search_id, and backtrace.")
        }
        if (args.page !== 1) throw new Error("Douyin uses returned cursor state, not page numbers; omit page and pass cursor.")
        const response = await fetchTikHubJson({
          endpoint,
          method: "POST",
          body: {
            keyword: args.query,
            cursor: state?.cursor ?? 0,
            sort_type: args.sort === "latest" ? "2" : args.sort === "hot" ? "1" : "0",
            publish_time:
              args.timeRange === "day"
                ? "1"
                : args.timeRange === "week"
                  ? "7"
                  : args.timeRange === "half_year"
                      ? "180"
                      : "0",
            filter_duration: "0",
            content_type: "0",
            search_id: state?.search_id ?? "",
            backtrace: state?.backtrace ?? "",
          },
          signal: args.signal,
          keep: args.keep,
        })
        return platformResult({
          search: args,
          provider: "tikhub",
          endpoint,
          response,
          notes: ["TikHub Douyin dedicated video-search V2 endpoint", ...(args.timeRange === "month" ? ["Unsupported month filter; used all time, not an undocumented 30-day value."] : [])],
        })
      }
      case "weibo": {
        const vertical = args.weiboSearchType === "normal" && args.sort === "latest" ? "realtime" : args.weiboSearchType
        const routes: Partial<Record<WeiboSearchType, string>> = {
          realtime: "fetch_realtime_search", image: "fetch_pic_search", video: "fetch_video_search",
          user: "fetch_user_search", topic: "fetch_topic_search",
        }
        const route = routes[vertical] ?? "fetch_advanced_search"
        const endpoint = `/api/v1/weibo/web_v2/${route}`
        const query: Record<string, string | number> = { page: args.page }
        const notes = [`TikHub Weibo Web V2 ${vertical} search`]
        if (route === "fetch_advanced_search") {
          query.q = args.query
          query.search_type = vertical === "normal" ? (args.sort === "hot" ? "hot" : "all") : vertical
          if (args.sort === "latest") notes.push("Unsupported latest sort for this advanced vertical; vertical retained.")
          if (args.sort === "hot" && vertical !== "normal" && vertical !== "hot") notes.push("Unsupported hot sort alongside this advanced vertical; vertical retained.")
          if (args.timeRange !== "all") {
            const end = new Date()
            const days = { day: 1, week: 7, month: 30, half_year: 180 }[args.timeRange]
            const start = new Date(end.getTime() - days * 86400000)
            const hour = (date: Date) => date.toISOString().slice(0, 13).replace("T", "-")
            query.timescope = `custom:${hour(start)}:${hour(end)}`
            notes.push(`Time scope sent at UTC hour precision: ${query.timescope}; provider timezone interpretation not verified.`)
          }
        } else {
          query.query = args.query
          if (vertical === "video") query.mode = args.sort === "hot" ? "hot" : "all"
          if (args.timeRange !== "all") notes.push("Unsupported time filter for this Weibo vertical; no time filter sent.")
          if (args.sort !== "relevance" && !(vertical === "realtime" && args.sort === "latest") && !(vertical === "video" && args.sort === "hot")) notes.push(`Unsupported ${args.sort} sort for this Weibo vertical.`)
        }
        const response = await fetchTikHubJson({
          endpoint,
          query,
          signal: args.signal,
          keep: args.keep,
        })
        return platformResult({
          search: args,
          provider: "tikhub",
          endpoint,
          response,
          notes,
        })
      }
      case "zhihu": {
        const endpoint = "/api/v1/zhihu/web/fetch_article_search_v3"
        const response = await fetchTikHubJson({
          endpoint,
          query: {
            keyword: args.query,
            offset: Math.max(0, (args.page - 1) * Math.max(args.limit, 5)),
            limit: Math.max(args.limit, 5),
            show_all_topics: 0,
            search_source: args.sort !== "relevance" || args.timeRange !== "all" ? "Filter" : "Normal",
            search_hash_id: typeof args.cursor === "string" ? args.cursor : "",
            vertical: "",
            sort: args.sort === "latest" ? "created_time" : args.sort === "hot" ? "upvoted_count" : "",
            time_interval: { all: "", day: "a_day", week: "a_week", month: "a_month", half_year: "half_a_year" }[args.timeRange],
            vertical_info: "",
          },
          signal: args.signal,
          keep: args.keep,
        })
        return platformResult({
          search: args,
          provider: "tikhub",
          endpoint,
          response,
          notes: [
            "TikHub Zhihu article-search V3 endpoint",
            "Requested sort/time intent mapped to documented native filters",
          ],
        })
      }
      case "kuaishou": {
        const endpoint = "/api/v1/kuaishou/app/search_comprehensive"
        const response = await fetchTikHubJson({
          endpoint,
          query: {
            keyword: args.query,
            pcursor: typeof args.cursor === "string" ? args.cursor : "",
            sort_type: args.sort === "latest" ? "newest" : args.sort === "hot" ? "most_likes" : "all",
            publish_time:
              args.timeRange === "day"
                ? "one_day"
                : args.timeRange === "week"
                  ? "one_week"
                  : args.timeRange === "month"
                    ? "one_month"
                    : "all",
            duration: "all",
          },
          signal: args.signal,
          keep: args.keep,
        })
        return platformResult({
          search: args,
          provider: "tikhub",
          endpoint,
          response,
          notes: [
            "TikHub Kuaishou comprehensive-search endpoint",
            args.timeRange === "half_year" ? "Kuaishou endpoint cannot apply a half-year filter; used all time" : "Requested native filters sent",
          ],
        })
      }
      case "wechat": {
        const endpoint = "/api/v1/wechat_search/v2/fetch_search"
        const response = await fetchTikHubJson({
          endpoint,
          method: "POST",
          body: {
            keyword: args.query,
            business_type: args.wechatVertical,
            sort: args.sort === "latest" ? "latest" : args.sort === "hot" ? "hot" : "default",
            publish_time:
              args.timeRange === "day"
                ? "day"
                : args.timeRange === "week"
                  ? "week"
                  : args.timeRange === "half_year"
                    ? "half_year"
                    : "all",
            offset: 0,
            cursor: typeof args.cursor === "string" ? args.cursor : null,
            raw: false,
          },
          signal: args.signal,
          keep: args.keep,
        })
        return platformResult({
          search: args,
          provider: "tikhub",
          endpoint,
          response,
          notes: [
            "TikHub WeChat universal-search V2 endpoint with simplified parsing",
            "Provider price is $0.01 per request",
            ...(!["all", "account", "article", "video", "sticker"].includes(args.wechatVertical)
              ? ["This vertical is account/region gated and documented as currently empty; a billed empty response is not evidence that content is absent. Inspect categories from an all search."] : []),
            args.timeRange === "month" ? "WeChat endpoint cannot apply a one-month filter; used all time" : "Requested native filters sent",
          ],
        })
      }
    }
  },
}

const justOneProvider: ChinaSocialProvider = {
  id: "justone",
  label: "Just One API",
  supports(platform) {
    return CHINA_SOCIAL_PLATFORM_VALUES.includes(platform)
  },
  async search(args) {
    const endpoint = "/api/search/v1"
    const response = await fetchJustOneJson(args)
    return platformResult({
      search: args,
      provider: "justone",
      endpoint,
      response,
      notes: [
        "Just One API cached cross-platform search endpoint",
        "Cached results may be incomplete for uncommon queries",
        "Common sort/time intent and platform-specific verticals are unsupported; only explicit justone_start/end filters apply",
      ],
    })
  },
}

const PROVIDERS: Record<ActiveChinaSocialProviderId, ChinaSocialProvider> = {
  tikhub: tikHubProvider,
  justone: justOneProvider,
}

function resolveProvider(
  requestedProvider: ChinaSocialProviderId,
  platform: ChinaSocialPlatform
): ChinaSocialProvider {
  const provider = requestedProvider === "auto" ? PROVIDERS.tikhub : PROVIDERS[requestedProvider]

  if (!provider.supports(platform)) {
    throw new Error(`${provider.label} does not support platform '${platform}'.`)
  }

  return provider
}

function formatPlatformResult(result: PlatformSearchResult): string {
  const lines: string[] = []
  lines.push(`## ${platformLabel(result.platform)}`)
  lines.push(`Provider: ${providerLabel(result.provider)} | Endpoint: ${result.endpoint}`)
  lines.push(
    `Run evidence: HTTP ${result.httpStatus} | Attempts ${result.attempts} | ${result.durationMs}ms | Normalized ${result.items.length}${result.requestId ? ` | Request ${result.requestId}` : ""}`
  )
  if (result.nextCursor) {
    lines.push(`Next cursor: ${typeof result.nextCursor === "string" ? result.nextCursor : JSON.stringify(result.nextCursor)}`)
  }
  if (result.availability) lines.push(`WeChat availability: ${JSON.stringify(result.availability)}`)

  if (result.rawCount !== null) {
    lines.push(`Reported result count: ${result.rawCount}`)
  }

  if (result.notes.length > 0) {
    lines.push(`Notes: ${result.notes.join("; ")}`)
  }

  lines.push("")

  if (result.items.length === 0) {
    lines.push(`No normalized ${platformLabel(result.platform)} results were extracted for this query.`)

    if (result.rawFallback) {
      lines.push("")
      lines.push("Raw data excerpt:")
      lines.push("```json")
      lines.push(result.rawFallback)
      lines.push("```")
    }

    return lines.join("\n")
  }

  lines.push(`Top normalized results: ${result.items.length}`)
  lines.push("")

  for (const item of result.items) {
    const stats = [
      item.views !== null ? `Views ${formatNumber(item.views)}` : null,
      item.likes !== null ? `Likes ${formatNumber(item.likes)}` : null,
      item.comments !== null ? `Comments ${formatNumber(item.comments)}` : null,
      item.shares !== null ? `Shares ${formatNumber(item.shares)}` : null,
      item.saves !== null ? `Saves ${formatNumber(item.saves)}` : null,
    ].filter(Boolean)

    lines.push(`- **${item.title}**`)
    if (item.id) lines.push(`  - ID: ${item.id}`)
    if (item.handles && Object.keys(item.handles).length) lines.push(`  - Follow-up handles: ${JSON.stringify(item.handles)}`)
    if (item.author) lines.push(`  - Author: ${item.author}`)
    if (item.publishedAt) lines.push(`  - Published: ${item.publishedAt}`)
    if (stats.length > 0) lines.push(`  - Engagement: ${stats.join(" | ")}`)
    if (item.url) lines.push(`  - URL: ${item.url}`)
    if (item.tags.length > 0) lines.push(`  - Tags: ${item.tags.slice(0, 8).join(", ")}`)
    if (item.summary) lines.push(`  - Summary: ${item.summary}`)
  }

  return lines.join("\n")
}

function platformLabel(platform: ChinaSocialPlatform): string {
  switch (platform) {
    case "xiaohongshu":
      return "Xiaohongshu"
    case "bilibili":
      return "Bilibili"
    case "douyin":
      return "Douyin"
    case "weibo":
      return "Weibo"
    case "zhihu":
      return "Zhihu"
    case "kuaishou":
      return "Kuaishou"
    case "wechat":
      return "WeChat"
  }
}

function providerLabel(provider: ActiveChinaSocialProviderId): string {
  switch (provider) {
    case "tikhub":
      return "TikHub"
    case "justone":
      return "Just One API"
  }
}

function formatPlatformFailure(failure: PlatformSearchFailure): string {
  return `- ${platformLabel(failure.platform)} (${providerLabel(failure.provider)}): ${failure.message}`
}

export const search = {
  description:
    "Search Xiaohongshu, Bilibili, Douyin, Weibo, Zhihu, Kuaishou, and WeChat through TikHub, " +
    "or use the credential-gated Just One API cross-platform backend. Results include live per-request provider evidence.",
  async execute(args, context) {
    const platforms: ChinaSocialPlatform[] = args.platforms?.length
      ? Array.from(new Set(args.platforms)) as ChinaSocialPlatform[]
      : DEFAULT_PLATFORM_SLICE
    const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const providerChoice: ChinaSocialProviderId = args.provider ?? "auto"
    const requestedProvider: ActiveChinaSocialProviderId =
      providerChoice === "auto" ? "tikhub" : providerChoice

    try {
      if (!args.query?.trim()) throw new Error("query is required")
      if (!CHINA_SOCIAL_PROVIDER_VALUES.includes(providerChoice)) throw new Error("Unknown provider")
      if (platforms.some((platform) => !CHINA_SOCIAL_PLATFORM_VALUES.includes(platform))) throw new Error("Unknown platform")
      if (args.page !== undefined && (!Number.isSafeInteger(args.page) || args.page < 1)) throw new Error("page must be a positive integer")
      if (args.sort !== undefined && !["relevance", "latest", "hot"].includes(args.sort)) throw new Error("Unsupported sort")
      if (args.time_range !== undefined && !["all", "day", "week", "month", "half_year"].includes(args.time_range)) throw new Error("Unsupported time_range")
      if (args.weibo_search_type !== undefined && !WEIBO_SEARCH_TYPE_VALUES.includes(args.weibo_search_type)) throw new Error("Unsupported Weibo vertical; article search is not offered by the current Web V2 search contract")
      if (args.wechat_vertical !== undefined && !WECHAT_VERTICAL_VALUES.includes(args.wechat_vertical)) throw new Error("Unsupported WeChat vertical")
      if (args.weibo_search_type !== undefined && !platforms.includes("weibo")) throw new Error("weibo_search_type requires the weibo platform")
      if (args.wechat_vertical !== undefined && !platforms.includes("wechat")) throw new Error("wechat_vertical requires the wechat platform")
      if (args.cursor !== undefined && platforms.length !== 1) throw new Error("Pagination cursor must be scoped to exactly one platform")
      if (args.cursor !== undefined && typeof args.cursor !== "string" && !asRecord(args.cursor)) throw new Error("cursor must be an opaque string or returned state object")
      if (requestedProvider === "justone" || !["xiaohongshu", "douyin"].includes(platforms[0] ?? "")) {
        if (args.cursor !== undefined && typeof args.cursor !== "string") throw new Error("This endpoint requires an opaque string cursor")
      }
      if (args.cursor !== undefined && ["bilibili", "weibo"].includes(platforms[0] ?? "") && requestedProvider === "tikhub") throw new Error("This endpoint uses page, not cursor")
      if ((args.page ?? 1) > 1 && (requestedProvider === "justone" || platforms.some((platform) => ["douyin", "kuaishou", "wechat"].includes(platform)))) throw new Error("Cursor-only endpoints do not support page; pass the returned cursor and omit page")
      if (requestedProvider !== "justone" && (args.justone_start !== undefined || args.justone_end !== undefined)) throw new Error("justone_start/end only apply to provider=justone")
      for (const boundary of [args.justone_start, args.justone_end]) {
        if (boundary !== undefined && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(boundary)) throw new Error("Just One dates must use yyyy-MM-dd HH:mm:ss")
      }
      if (args.justone_start && args.justone_end && args.justone_start >= args.justone_end) throw new Error("justone_start must precede justone_end")
      const results: PlatformSearchResult[] = []
      const failures: PlatformSearchFailure[] = []

      for (const platform of platforms) {
        let provider: ChinaSocialProvider | null = null
        try {
          provider = resolveProvider(providerChoice, platform)
          results.push(
            await provider.search({
              query: args.query,
              platform,
              limit,
              page: Math.max(args.page ?? DEFAULT_PAGE, 1),
              cursor: args.cursor ?? null,
              justoneStart: args.justone_start,
              justoneEnd: args.justone_end,
              sort: args.sort ?? "relevance",
              timeRange: args.time_range ?? "all",
              weiboSearchType: args.weibo_search_type ?? "normal",
              wechatVertical: args.wechat_vertical ?? "all",
              signal: context.abort,
              keep: context.keep,
            })
          )
        } catch (error) {
          if (context.abort.aborted) return "ERROR: China-social search cancelled; cancellation is not provider failure or evidence absence."
          failures.push({
            platform,
            provider: provider?.id ?? requestedProvider,
            message: redactDiagnostics(error instanceof Error ? error.message : "Unknown error"),
          })
        }
      }

      if (results.length === 0) {
        throw new Error(
          failures.length > 0
            ? `All requested platforms failed: ${failures
                .map((failure) => `${platformLabel(failure.platform)} (${providerLabel(failure.provider)}): ${failure.message}`)
                .join("; ")}`
            : "No platform requests completed successfully"
        )
      }

      const totalItems = results.reduce((sum, result) => sum + result.items.length, 0)
      const lines: string[] = []
      lines.push("# China Social Search")
      lines.push("")
      lines.push(`Query: ${args.query}`)
      lines.push(`Platforms: ${platforms.map(platformLabel).join(", ")}`)
      lines.push(`Provider mode: ${providerChoice}`)
      lines.push(`Normalized results: ${totalItems}`)
      lines.push("")
      lines.push(
        "Provider standing below is evidence from this run, not a permanent platform-health claim. TikHub is the automatic primary; Just One API is an explicit credential-gated alternative."
      )
      lines.push("")

      if (failures.length > 0) {
        lines.push("## Warnings")
        lines.push(
          "Some requested platforms failed in this run, so successful platforms are returned as partial results. A run failure is provider evidence, not proof that the platform itself is unavailable."
        )
        for (const failure of failures) {
          lines.push(formatPlatformFailure(failure))
        }
        lines.push("")
      }

      for (const result of results) {
        lines.push(formatPlatformResult(result))
        lines.push("")
      }

      return {
        status: failures.length > 0 ? "partial" : "success",
        text: lines.join("\n").trim(),
        details: {
          source: "china-social",
          providerMode: providerChoice,
          totalItems,
          successfulPlatforms: results.map((result) => result.platform),
          failedPlatforms: failures.map((failure) => failure.platform),
          runs: results.map((result) => ({
            platform: result.platform,
            provider: result.provider,
            endpoint: result.endpoint,
            httpStatus: result.httpStatus,
            attempts: result.attempts,
            durationMs: result.durationMs,
            requestId: result.requestId,
            normalizedItems: result.items.length,
            nextCursor: result.nextCursor,
            availability: result.availability,
            notes: result.notes,
            items: result.items,
          })),
        },
      }
    } catch (error) {
      return `ERROR: China-social search failed: ${redactDiagnostics(error instanceof Error ? error.message : "Unknown error")}`
    }
  },
} satisfies ToolSpec
