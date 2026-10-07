/**
 * Reddit tool backed by ScrapeCreators' public Reddit endpoints.
 *
 * Replaces the old.reddit.com JSON scraping, which Reddit blocks for
 * unauthenticated programmatic access. Requires SCRAPECREATORS_API_KEY (the
 * same credential as the other ScrapeCreators tools); no Reddit login and no
 * browser session is used. TikHub's richer Reddit surface stays in the
 * separate `tikhub_reddit` tool.
 *
 * Endpoint contracts follow https://docs.scrapecreators.com (read 2026-09-15):
 * - GET /v1/reddit/search: all of Reddit; filter posts|comments; sort
 *   relevance|new|top|comment_count (comments: relevance|new|top only);
 *   timeframe all|day|week|month|year (posts only); `after` token pagination.
 * - GET /v1/reddit/subreddit/search: one subreddit; sort relevance|hot|top|new|
 *   comments (comments: relevance|top|new); timeframe adds `hour`; opaque cursor.
 * - GET /v1/reddit/post/comments: post + top-level comments with nested replies;
 *   `more.cursor` (top level) and `replies.more.cursor` (per comment) are the
 *   opaque continuation tokens, passed back one at a time as `cursor`.
 * Every request costs 1 credit; comment enrichment is one request per thread.
 *
 * Two modes: search (query, optional subreddits) and direct post comments
 * (postUrl, optional cursor) so comment evidence can be continued page by page.
 */
import type { OutcomeStatus } from "../outcome.js"
import type { ToolContext, ToolSpec } from "../types.js"
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  cleanText,
  clampInt,
  CreditTally,
  creditMetered,
  expectArray,
  failText,
  fmtMetric,
  isoDate,
  MISSING_KEY_ERROR,
  scrapecreatorsHeaders,
  scrapecreatorsRequest,
  truncate,
  validateEnum,
} from "./scrapecreators.js"

const FILTER_VALUES = ["posts", "comments"] as const
const SORT_VALUES = ["relevance", "hot", "top", "new", "comments"] as const
const TIMEFRAME_VALUES = ["all", "hour", "day", "week", "month", "year"] as const
const COMMENT_SORTS = new Set<string>(["relevance", "top", "new"])
const GLOBAL_SORT_MAP: Record<(typeof SORT_VALUES)[number], string | null> = {
  relevance: "relevance",
  new: "new",
  top: "top",
  comments: "comment_count",
  hot: null,
}
const DEFAULT_LIMIT = 15
const MAX_LIMIT = 40
const MAX_SUBREDDITS = 5
const DEFAULT_COMMENT_THREADS = 5
const MAX_COMMENT_THREADS = 10
const COMMENTS_PER_THREAD = 3
const REDDIT_ORIGIN = "https://www.reddit.com"
const POST_COMMENTS_LABEL = "ScrapeCreators Reddit post comments"

/** A search with failed requests is partial (all failing is an error earlier); a complete one with nothing shown is empty. */
function outcomeStatus(errors: readonly string[], shown: number): OutcomeStatus {
  return errors.length ? "partial" : shown ? "success" : "empty"
}

interface RedditArgs {
  query?: string
  postUrl?: string
  filter?: string
  sort?: string
  timeframe?: string
  subreddits?: string[]
  cursor?: string
  limit?: number
  includeComments?: boolean
  commentThreads?: number
  allowNsfw?: boolean
}

interface Thread {
  id: string
  title: string
  subreddit: string | null
  author: string | null
  score: number | null
  numComments: number | null
  upvoteRatio: number | null
  date: string | null
  url: string
  selftext: string | null
  flair: string | null
  nsfw: boolean
  stickied: boolean
  comments: string[]
  commentNote: string | null
}

interface CommentHit {
  id: string | null
  body: string
  author: string | null
  score: number | null
  date: string | null
  url: string | null
  subreddit: string | null
  postTitle: string | null
  postUrl: string | null
}

function redditUrl(permalink: string | null, url: string | null): string {
  if (permalink) return permalink.startsWith("http") ? permalink : `${REDDIT_ORIGIN}${permalink.startsWith("/") ? "" : "/"}${permalink}`
  return url ?? ""
}

function stripKind(id: string | null): string | null {
  return id ? id.replace(/^t[135]_/, "") : null
}

function subredditName(value: unknown): string | null {
  if (typeof value === "string") return value.replace(/^r\//, "") || null
  const record = asRecord(value)
  return asString(record?.name) ?? asString(record?.display_name) ?? null
}

/** Global search returns Reddit's t3 listing fields; subreddit search returns a compact post shape. */
function normalizePost(raw: Record<string, unknown>): Thread | null {
  const id = stripKind(asString(raw.id) ?? asString(raw.post_id) ?? asString(raw.name))
  const title = cleanText(raw.title)
  if (!id || !title) return null
  return {
    id,
    title,
    subreddit: subredditName(raw.subreddit) ?? (asString(raw.subreddit_name_prefixed)?.replace(/^r\//, "") ?? null),
    author: asString(raw.author),
    score: asNumber(raw.score) ?? asNumber(raw.ups) ?? asNumber(raw.votes),
    numComments: asNumber(raw.num_comments),
    upvoteRatio: asNumber(raw.upvote_ratio),
    date: isoDate(raw.created_at_iso) ?? isoDate(asNumber(raw.created_utc)) ?? isoDate(raw.created_at),
    url: redditUrl(asString(raw.permalink), asString(raw.url)),
    selftext: cleanText(raw.selftext),
    flair: cleanText(raw.link_flair_text),
    nsfw: raw.over_18 === true || raw.nsfw === true,
    stickied: raw.stickied === true,
    comments: [],
    commentNote: null,
  }
}

function normalizeCommentHit(raw: Record<string, unknown>): CommentHit | null {
  const body = cleanText(raw.body)
  if (!body) return null
  const post = asRecord(raw.post)
  return {
    id: stripKind(asString(raw.id) ?? asString(raw.name)),
    body,
    author: asString(raw.author),
    score: asNumber(raw.score) ?? asNumber(raw.ups) ?? asNumber(raw.votes),
    date: isoDate(raw.created_at_iso) ?? isoDate(asNumber(raw.created_utc)) ?? isoDate(raw.created_at),
    url: asString(raw.url) ?? (asString(raw.permalink) ? redditUrl(asString(raw.permalink), null) : null),
    subreddit: subredditName(raw.subreddit) ?? asString(raw.subreddit_name_prefixed)?.replace(/^r\//, "") ?? null,
    postTitle: cleanText(post?.title) ?? cleanText(raw.link_title) ?? cleanText(raw.post_title),
    postUrl: asString(post?.url) ?? (asString(post?.permalink) ? redditUrl(asString(post?.permalink), null) : null) ?? asString(raw.link_url),
  }
}

/**
 * Splits a comment list three ways so an entry the adapter cannot read is never
 * described as moderation: `unreadable` entries are not records or carry no body
 * text; `quotable` entries are readable and neither stickied, moderator-
 * distinguished, nor posted by AutoModerator.
 */
function partitionComments(comments: unknown[]): { unreadable: number; quotable: Record<string, unknown>[] } {
  const readable = comments
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => record !== null && cleanText(record.body) !== null)
  const quotable = readable.filter((record) => record.stickied !== true && record.distinguished !== "moderator" && asString(record.author) !== "AutoModerator")
  return { unreadable: comments.length - readable.length, quotable }
}

function commentLine(record: Record<string, unknown>, indent: string): string {
  const body = truncate(cleanText(record.body), 200)
  const score = asNumber(record.score) ?? asNumber(record.ups)
  const author = asString(record.author) ?? "[unavailable]"
  return `${indent}u/${author} (${score !== null ? `${score} pts` : "score n/a"}): ${body}`
}

/** The opaque continuation token nested under a comment's `replies.more`, when the provider reports one. */
function replyCursor(record: Record<string, unknown>): string | null {
  const more = asRecord(asRecord(record.replies)?.more)
  return more?.has_more === true ? asString(more.cursor) : null
}

function formatThread(thread: Thread, index: number): string {
  const lines: string[] = []
  lines.push(`${index + 1}. **${thread.id}** ${thread.subreddit ? `r/${thread.subreddit}` : "(subreddit unknown)"} — ${thread.title}${thread.stickied ? " [stickied]" : ""}${thread.nsfw ? " [NSFW]" : ""}`)
  lines.push(
    `   Score: ${fmtMetric(thread.score)} | Comments: ${fmtMetric(thread.numComments)} | Author: ${thread.author ? `u/${thread.author}` : "not returned"} | Date: ${thread.date ?? "unknown"}` +
      `${thread.upvoteRatio !== null ? ` | Upvote ratio: ${thread.upvoteRatio}` : ""}${thread.flair ? ` | Flair: ${thread.flair}` : ""}`,
  )
  if (thread.url) lines.push(`   URL: ${thread.url}`)
  if (thread.selftext) lines.push(`   Preview: ${truncate(thread.selftext, 200)}`)
  if (thread.comments.length) {
    lines.push("   Top comments:")
    lines.push(...thread.comments)
  } else if (thread.commentNote) {
    lines.push(`   Comments: ${thread.commentNote}`)
  }
  return lines.join("\n")
}

function formatCommentHit(hit: CommentHit, index: number): string {
  const lines: string[] = []
  lines.push(`${index + 1}. ${hit.author ? `u/${hit.author}` : "(author not returned)"}${hit.subreddit ? ` in r/${hit.subreddit}` : ""} — ${truncate(hit.body, 300)}`)
  lines.push(`   Score: ${fmtMetric(hit.score)} | Date: ${hit.date ?? "unknown"}${hit.postTitle ? ` | Thread: ${truncate(hit.postTitle, 120)}` : ""}`)
  if (hit.url) lines.push(`   URL: ${hit.url}`)
  else if (hit.postUrl) lines.push(`   Thread URL: ${hit.postUrl}`)
  return lines.join("\n")
}

function normalizeRedditPostUrl(value: string): { url: string } | { error: string } {
  let parsed: URL
  try {
    parsed = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`)
  } catch {
    return { error: "postUrl must be a Reddit post URL such as https://www.reddit.com/r/<subreddit>/comments/<id>/<slug>/." }
  }
  if (!/(^|\.)(reddit\.com|redd\.it)$/i.test(parsed.hostname)) return { error: "postUrl must be a reddit.com (or redd.it share) URL." }
  return { url: parsed.toString() }
}

/** Direct post-comments mode: one page of a thread's comments plus every continuation token the provider exposed. */
async function postComments(
  postUrl: string,
  cursor: string | undefined,
  limit: number,
  headers: Record<string, string>,
  ctx: ToolContext,
) {
  const response = await scrapecreatorsRequest("/v1/reddit/post/comments", { url: postUrl, cursor }, headers, ctx, POST_COMMENTS_LABEL)
  if (!response.ok) return failText(response)
  const listed = expectArray(response.payload, "comments", POST_COMMENTS_LABEL)
  if (!listed.ok) return `ERROR: ${listed.error}`
  const credits = new CreditTally()
  credits.add(response.payload)
  const post = asRecord(response.payload.post)
  const thread = post ? normalizePost(post) : null
  const { unreadable, quotable } = partitionComments(listed.items)
  const all = listed.items.length
  const shown = quotable.slice(0, limit)
  const more = asRecord(response.payload.more)
  const nextCursor = more?.has_more === true ? asString(more.cursor) : null
  const replyTokens = shown
    .map((record) => {
      const token = replyCursor(record)
      return token ? { id: stripKind(asString(record.id) ?? asString(record.name)), author: asString(record.author), cursor: token } : null
    })
    .filter((entry): entry is { id: string | null; author: string | null; cursor: string } => entry !== null)

  const header = [
    `Reddit post comments via ScrapeCreators: ${postUrl}${cursor ? ` (continuation page)` : ""}`,
    thread
      ? `Post: **${thread.id}**${thread.subreddit ? ` r/${thread.subreddit}` : ""} — ${thread.title} | Score: ${fmtMetric(thread.score)} | Comments: ${fmtMetric(thread.numComments)} | Author: ${thread.author ? `u/${thread.author}` : "not returned"} | Date: ${thread.date ?? "unknown"}`
      : cursor
        ? "Post: not repeated on continuation pages"
        : "Post: provider returned no post record",
    credits.describe(),
    `Comments: ${shown.length} shown of ${quotable.length} quotable top-level comments (${all} returned on this page; stickied/moderator/AutoModerator excluded${unreadable ? `; ${unreadable} without a readable body skipped` : ""}); provider order, no local re-ranking`,
    more?.has_more === true
      ? nextCursor
        ? `More top-level comments: pass postUrl with cursor="${nextCursor}"`
        : "More top-level comments: provider reports more but returned no cursor"
      : more?.has_more === false
        ? "More top-level comments: provider reports none"
        : "More top-level comments: not reported by the provider",
    replyTokens.length
      ? `Collapsed replies: ${replyTokens.length} comment${replyTokens.length === 1 ? "" : "s"} shown carry a replies cursor (listed under each; pass one at a time as cursor with the same postUrl)`
      : "Collapsed replies: none reported on the shown comments",
  ]
  if (thread?.selftext) header.push(`Post text: ${truncate(thread.selftext, 400)}`)

  const body = shown.map((record, index) => {
    const lines = [commentLine(record, `${index + 1}. `)]
    const date = isoDate(record.created_at_iso) ?? isoDate(asNumber(record.created_utc))
    const url = asString(record.url) ?? (asString(record.permalink) ? redditUrl(asString(record.permalink), null) : null)
    lines.push(`   Date: ${date ?? "unknown"}${url ? ` | URL: ${url}` : ""}`)
    const replies = asArray(asRecord(record.replies)?.items)
    const nestedQuotable = partitionComments(replies).quotable.slice(0, 2)
    for (const reply of nestedQuotable) lines.push(commentLine(reply, "     ↳ "))
    if (replies.length > nestedQuotable.length) lines.push(`     (${replies.length} direct repl${replies.length === 1 ? "y" : "ies"} returned; ${nestedQuotable.length} shown)`)
    const token = replyCursor(record)
    if (token) lines.push(`     Replies cursor: "${token}"`)
    return lines.join("\n")
  })
  if (shown.length === 0) {
    body.push(
      all === 0
        ? "The provider returned an empty comment list for this page."
        : unreadable === all
          ? `None of the ${all} returned comment${all === 1 ? "" : "s"} carried a readable body; this page is unreadable, not moderated or empty.`
          : "Every returned comment with a readable body was stickied, a moderator notice, or AutoModerator.",
    )
  }

  return {
    text: [header.join("\n"), ...body].join("\n\n"),
    details: {
      provider: "scrapecreators",
      mode: "post_comments",
      post_url: postUrl,
      post_id: thread?.id ?? null,
      returned: all,
      unreadable,
      quotable: quotable.length,
      shown: shown.length,
      cursor: nextCursor,
      has_more: typeof more?.has_more === "boolean" ? more.has_more : null,
      reply_cursors: replyTokens,
      credits: credits.details(),
    },
  }
}

/** Search Reddit threads or comments, enrich threads with their first top-level comments, or page a thread's comments directly */
export default creditMetered({
  description:
    "Public Reddit via ScrapeCreators. Search mode (query): /v1/reddit/search across Reddit or /v1/reddit/subreddit/search inside named subreddits, posts or comment text, with Reddit's own sort/timeframe and pagination tokens. " +
    "Post-comments mode (postUrl): one page of a thread's comments from /v1/reddit/post/comments with the provider's continuation cursors for more top-level comments and collapsed replies. " +
    "Requires SCRAPECREATORS_API_KEY; 1 credit per request (search page, comment page, or enriched thread). Results keep Reddit's order. For TikHub-only Reddit surfaces use tikhub_reddit.",
  async execute(args: RedditArgs, ctx: ToolContext) {
    const headers = scrapecreatorsHeaders()
    if (!headers) return `ERROR: Reddit lookup failed: ${MISSING_KEY_ERROR}`
    const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
    const cursor = args.cursor?.trim() || undefined

    const postUrlInput = args.postUrl?.trim()
    if (postUrlInput) {
      for (const [name, value] of Object.entries({ query: args.query, filter: args.filter, sort: args.sort, timeframe: args.timeframe, subreddits: args.subreddits, includeComments: args.includeComments, commentThreads: args.commentThreads, allowNsfw: args.allowNsfw })) {
        if (value !== undefined) return `ERROR: ${name} applies to search mode; postUrl mode takes only postUrl, cursor, and limit.`
      }
      const normalized = normalizeRedditPostUrl(postUrlInput)
      if ("error" in normalized) return `ERROR: ${normalized.error}`
      return postComments(normalized.url, cursor, limit, headers, ctx)
    }

    const query = cleanText(args.query)
    if (!query) return "ERROR: query is required (or pass postUrl for post-comments mode)."
    const invalid =
      validateEnum("filter", args.filter, FILTER_VALUES) ??
      validateEnum("sort", args.sort, SORT_VALUES) ??
      validateEnum("timeframe", args.timeframe, TIMEFRAME_VALUES)
    if (invalid) return `ERROR: ${invalid}`
    const filter = (args.filter ?? "posts") as (typeof FILTER_VALUES)[number]
    const sort = (args.sort ?? "relevance") as (typeof SORT_VALUES)[number]
    const timeframe = args.timeframe
    const subreddits = [
      ...new Set(
        asArray(args.subreddits)
          .filter((name): name is string => typeof name === "string")
          .map((name) => name.trim().replace(/^r\//i, ""))
          .filter(Boolean),
      ),
    ]
    if (subreddits.length > MAX_SUBREDDITS) return `ERROR: at most ${MAX_SUBREDDITS} subreddits per call.`
    const scoped = subreddits.length > 0

    if (filter === "comments" && !COMMENT_SORTS.has(sort)) return `ERROR: comment searches accept sort relevance, top, or new (got '${sort}').`
    if (!scoped) {
      if (sort === "hot") return "ERROR: sort 'hot' is only available inside subreddits; pass subreddits or choose relevance, new, top, or comments."
      if (timeframe === "hour") return "ERROR: timeframe 'hour' is only available inside subreddits; all-Reddit search accepts all, day, week, month, year."
      if (filter === "comments" && timeframe !== undefined) return "ERROR: timeframe applies to post searches only when searching all of Reddit."
    }
    if (cursor && subreddits.length > 1) return "ERROR: cursor pagination works with all-Reddit search or exactly one subreddit."
    const includeComments = args.includeComments ?? true
    const commentThreads = clampInt(args.commentThreads, DEFAULT_COMMENT_THREADS, 0, MAX_COMMENT_THREADS)
    const allowNsfw = args.allowNsfw === true

    const credits = new CreditTally()
    const requestErrors: string[] = []
    const nextTokens: string[] = []
    const rawPosts: Record<string, unknown>[] = []
    const rawComments: Record<string, unknown>[] = []
    const bucketKey = filter === "comments" ? "comments" : "posts"

    if (scoped) {
      for (const subreddit of subreddits) {
        if (ctx.abort.aborted) return `ERROR: Cancelled: Reddit subreddit search stopped before r/${subreddit}.`
        const label = `ScrapeCreators Reddit r/${subreddit} search`
        const response = await scrapecreatorsRequest("/v1/reddit/subreddit/search", { subreddit, query, sort, timeframe, cursor }, headers, ctx, label)
        if (!response.ok) {
          if (response.cancelled) return failText(response)
          credits.add(response.payload)
          requestErrors.push(response.error)
          continue
        }
        credits.add(response.payload)
        const listed = expectArray(response.payload, bucketKey, label)
        if (!listed.ok) {
          requestErrors.push(listed.error)
          continue
        }
        const next = asString(response.payload.cursor)
        if (next) nextTokens.push(`r/${subreddit}: cursor="${next}"`)
        for (const entry of listed.items) {
          const record = asRecord(entry)
          if (record) (filter === "comments" ? rawComments : rawPosts).push(record)
        }
      }
      if (requestErrors.length === subreddits.length) return `ERROR: Reddit search failed: ${requestErrors.join("; ")}`
    } else {
      const label = "ScrapeCreators Reddit search"
      const response = await scrapecreatorsRequest(
        "/v1/reddit/search",
        { query, filter, sort: GLOBAL_SORT_MAP[sort] ?? undefined, timeframe, after: cursor },
        headers,
        ctx,
        label,
      )
      if (!response.ok) return response.cancelled ? failText(response) : `ERROR: Reddit search failed: ${response.error}`
      credits.add(response.payload)
      // The docs name `posts` for post results; the comment-result array key is
      // not shown in the docs example, so accept `comments` and fall back to
      // `posts`, but never treat an absent array as an empty result.
      const key = filter === "comments" && !Array.isArray(response.payload.comments) && Array.isArray(response.payload.posts) ? "posts" : bucketKey
      const listed = expectArray(response.payload, key, label)
      if (!listed.ok) return `ERROR: Reddit search failed: ${listed.error}`
      const after = asString(response.payload.after)
      if (after) nextTokens.push(`after="${after}"`)
      for (const entry of listed.items) {
        const record = asRecord(entry)
        if (record) (filter === "comments" ? rawComments : rawPosts).push(record)
      }
    }

    const scopeLine = scoped ? `Scope: ${subreddits.map((s) => `r/${s}`).join(", ")} (one request each)` : "Scope: all of Reddit"
    const filterLine = `Filters: filter=${filter} | sort=${sort}${!scoped && sort === "comments" ? " (sent as comment_count)" : ""} | timeframe=${timeframe ?? "all (provider default)"}${cursor ? ` | cursor=${cursor}` : ""}`
    const pagingLine = nextTokens.length ? `Next page: pass cursor with ${nextTokens.join("; ")}` : "Next page: no pagination token returned"
    const orderLine = `Order: as returned by Reddit for sort=${sort}; no local re-ranking${scoped && subreddits.length > 1 ? " (subreddit results listed in the order requested)" : ""}.`

    if (filter === "comments") {
      const seen = new Set<string>()
      const hits: CommentHit[] = []
      for (const raw of rawComments) {
        const hit = normalizeCommentHit(raw)
        if (!hit) continue
        const key = hit.id ?? hit.url ?? `${hit.author}:${hit.body}`
        if (seen.has(key)) continue
        seen.add(key)
        hits.push(hit)
      }
      const shown = hits.slice(0, limit)
      const header = [
        `Reddit comment search via ScrapeCreators: "${query}"`,
        scopeLine,
        filterLine,
        orderLine,
        `Results: ${shown.length} comments shown of ${hits.length} returned${rawComments.length > hits.length ? ` (${rawComments.length - hits.length} returned entries had no readable body or were duplicates)` : ""}`,
        pagingLine,
        credits.describe(),
      ]
      if (requestErrors.length) header.push(`Partial: ${requestErrors.join("; ")}`)
      if (args.includeComments !== undefined || args.commentThreads !== undefined) header.push("includeComments/commentThreads apply to post searches; comment results are already comments.")
      const body = shown.length ? shown.map(formatCommentHit) : ["The provider returned an empty comment list for this query and filter set."]
      return {
        status: outcomeStatus(requestErrors, shown.length),
        text: [header.join("\n"), ...body].join("\n\n"),
        details: {
          provider: "scrapecreators",
          mode: "search",
          filter,
          query,
          subreddits,
          returned: hits.length,
          shown: shown.length,
          next_tokens: nextTokens,
          credits: credits.details(),
          errors: requestErrors,
        },
      }
    }

    const seen = new Set<string>()
    const threads: Thread[] = []
    let nsfwExcluded = 0
    let unreadable = 0
    for (const raw of rawPosts) {
      const thread = normalizePost(raw)
      if (!thread) {
        unreadable += 1
        continue
      }
      if (seen.has(thread.id)) continue
      seen.add(thread.id)
      if (thread.nsfw && !allowNsfw) {
        nsfwExcluded += 1
        continue
      }
      threads.push(thread)
    }
    const shown = threads.slice(0, limit)

    let commentsFetched = 0
    let commentsRequested = 0
    const commentFailures: string[] = []
    if (includeComments && commentThreads > 0) {
      for (const thread of shown.slice(0, commentThreads)) {
        if (ctx.abort.aborted) return `ERROR: Cancelled: Reddit comment enrichment stopped after ${commentsFetched} of ${commentsRequested} threads; the search itself completed.`
        if (!thread.url) {
          thread.commentNote = "no URL to fetch comments for"
          continue
        }
        commentsRequested += 1
        const response = await scrapecreatorsRequest("/v1/reddit/post/comments", { url: thread.url }, headers, ctx, POST_COMMENTS_LABEL)
        if (!response.ok) {
          if (response.cancelled) return `ERROR: Cancelled: ${response.error} (${commentsFetched} threads enriched before cancellation)`
          credits.add(response.payload)
          thread.commentNote = `fetch failed: ${response.error}`
          commentFailures.push(`${thread.url}: ${response.error}`)
          continue
        }
        credits.add(response.payload)
        const listed = expectArray(response.payload, "comments", POST_COMMENTS_LABEL)
        if (!listed.ok) {
          thread.commentNote = `unreadable: ${listed.error}`
          commentFailures.push(`${thread.url}: ${listed.error}`)
          continue
        }
        commentsFetched += 1
        const { unreadable, quotable } = partitionComments(listed.items)
        const total = listed.items.length
        thread.comments = quotable.slice(0, COMMENTS_PER_THREAD).map((record) => commentLine(record, "     "))
        const more = asRecord(response.payload.more)
        const moreCursor = more?.has_more === true ? asString(more.cursor) : null
        if (thread.comments.length === 0) {
          thread.commentNote =
            total === 0
              ? "provider returned an empty comment list"
              : unreadable === total
                ? `${total} returned, none with a readable body (unreadable page, not moderation)`
                : `${total} returned, none quotable after excluding stickied/moderator/AutoModerator${unreadable ? ` (${unreadable} without a readable body)` : ""}`
        } else if (moreCursor || total > thread.comments.length) {
          thread.comments.push(
            `     (first ${thread.comments.length} of ${total} top-level comments on this page${moreCursor ? `; continue with postUrl="${thread.url}" cursor="${moreCursor}"` : `; more via postUrl="${thread.url}"`})`,
          )
        }
      }
    }

    const header = [
      `Reddit post search via ScrapeCreators: "${query}"`,
      scopeLine,
      filterLine,
      orderLine,
      `Results: ${shown.length} threads shown of ${threads.length} returned${nsfwExcluded ? ` (${nsfwExcluded} NSFW excluded; pass allowNsfw=true to include)` : ""}${unreadable ? ` (${unreadable} returned entries lacked an id or title and were skipped)` : ""}`,
      pagingLine,
      credits.describe(),
      includeComments
        ? `Comments: fetched for ${commentsFetched} of ${commentsRequested} requested threads (first ${COMMENTS_PER_THREAD} top-level comments as returned, stickied/moderator/AutoModerator excluded)${commentFailures.length ? `; ${commentFailures.length} failed` : ""}`
        : "Comments: not requested",
    ]
    if (requestErrors.length) header.push(`Partial: ${requestErrors.join("; ")}`)
    if (commentFailures.length) header.push(`Comment failures: ${commentFailures.join("; ")}`)
    const body = shown.length
      ? shown.map(formatThread)
      : [`The provider returned an empty post list for this query and filter set${nsfwExcluded ? " after NSFW exclusion" : ""}.`]

    return {
      status: outcomeStatus([...requestErrors, ...commentFailures], shown.length),
      text: [header.join("\n"), ...body].join("\n\n"),
      details: {
        provider: "scrapecreators",
        mode: "search",
        filter,
        query,
        subreddits,
        returned: threads.length,
        shown: shown.length,
        nsfw_excluded: nsfwExcluded,
        unreadable,
        next_tokens: nextTokens,
        credits: credits.details(),
        comments: { requested: commentsRequested, fetched: commentsFetched, failed: commentFailures.length },
        errors: requestErrors,
        thread_ids: shown.map((thread) => thread.id),
      },
    }
  },
} satisfies ToolSpec)
