/**
 * Bluesky / ATProto public search, thread, and profile tools.
 *
 * Uses the official, free, keyless Bluesky public AppView XRPC API:
 *   https://public.api.bsky.app/xrpc/...
 *
 * Endpoints:
 *   - app.bsky.feed.searchPosts
 *   - app.bsky.feed.getPostThread (+ com.atproto.identity.resolveHandle for handle URLs)
 *   - app.bsky.actor.getProfile + app.bsky.feed.getAuthorFeed
 */
import { USER_AGENT } from "../../version.mjs"
import { keptJson, keptText } from "../http.js"
import { failed, free, outcome } from "../outcome.js"
import { knownSecrets, redactText } from "../secrets.js"
import type { ToolContext, ToolSpec } from "../types.js"

const BSKY_PUBLIC_API = "https://public.api.bsky.app/xrpc"
const TIMEOUT_MS = 45_000

const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 50
const DEFAULT_THREAD_DEPTH = 6
const MAX_THREAD_DEPTH = 20
const DEFAULT_PARENT_HEIGHT = 6
const MAX_PARENT_HEIGHT = 20
const MAX_THREAD_REPLIES = 150
const DEFAULT_PROFILE_LIMIT = 15
const MAX_PROFILE_LIMIT = 50

const SEARCH_SORTS = ["top", "latest"] as const
const FEED_FILTERS = [
  "posts_with_replies",
  "posts_no_replies",
  "posts_with_media",
  "posts_and_author_threads",
] as const

// ---------------------------------------------------------------------------
// Helpers & ATProto formatting
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stripAt(value: string): string {
  return value.trim().replace(/^@+/, "")
}

/** Convert an `at://<did>/app.bsky.feed.post/<rkey>` URI to a clickable `https://bsky.app/profile/.../post/...` URL. */
export function atUriToWebUrl(uri: string, handle?: string): string | null {
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)$/.exec(uri.trim())
  if (!m) return null
  const actor = handle?.trim() || m[1]
  return `https://bsky.app/profile/${actor}/post/${m[2]}`
}

/** Parse either an `at://.../app.bsky.feed.post/<rkey>` URI or a `https://bsky.app/profile/<actor>/post/<rkey>` URL. */
export function parsePostTarget(input: string): { actor: string; rkey: string; isDid: boolean } | { error: string } {
  const raw = input.trim()
  if (!raw) return { error: "post is required (bsky.app post URL or at:// URI)." }

  const atMatch = /^at:\/\/([^/\s]+)\/app\.bsky\.feed\.post\/([^/?#\s]+)$/.exec(raw)
  if (atMatch) {
    const actor = stripAt(atMatch[1])
    if (!actor) return { error: "post URI is missing actor or post key." }
    return { actor, rkey: atMatch[2], isDid: actor.startsWith("did:") }
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { error: "post must be an at://.../app.bsky.feed.post/<rkey> URI or a https://bsky.app/profile/<handle>/post/<rkey> URL." }
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !/^(?:www\.)?bsky\.app$/i.test(url.hostname)) {
    return { error: "post URL must be on bsky.app (https://bsky.app/profile/<handle-or-did>/post/<rkey>) or an at:// URI." }
  }
  const pathMatch = /^\/profile\/([^/]+)\/post\/([^/]+)\/?$/.exec(url.pathname)
  if (!pathMatch) {
    return { error: "post URL must match https://bsky.app/profile/<handle-or-did>/post/<rkey>." }
  }
  let actor: string
  try {
    actor = stripAt(decodeURIComponent(pathMatch[1]))
  } catch {
    actor = stripAt(pathMatch[1])
  }
  const rkey = pathMatch[2]
  if (!actor || !rkey || /[/?#\s]/.test(actor)) return { error: "post URL is missing or has an invalid actor or post key." }
  return { actor, rkey, isDid: actor.startsWith("did:") }
}

async function xrpcGet(
  nsid: string,
  params: Record<string, string | number | undefined>,
  ctx: ToolContext,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; message: string }> {
  const url = new URL(`${BSKY_PUBLIC_API}/${nsid}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && String(v) !== "") url.searchParams.set(k, String(v))
  }
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.any([ctx.abort, AbortSignal.timeout(TIMEOUT_MS)]),
  })
  if (!response.ok) {
    const bodyText = await keptText(response, ctx.keep, nsid).catch(() => "")
    let detail = response.statusText || `HTTP ${response.status}`
    try {
      const parsed = asRecord(JSON.parse(bodyText))
      const errCode = asString(parsed?.error)
      const errMsg = asString(parsed?.message)
      if (errCode || errMsg) detail = [errCode, errMsg].filter(Boolean).join(": ")
    } catch {
      if (bodyText.trim()) detail = bodyText.trim().slice(0, 200)
    }
    return { ok: false, status: response.status, message: `Bluesky ${nsid} returned HTTP ${response.status}: ${detail}` }
  }
  const data = await keptJson(response, ctx.keep, nsid)
  ctx.abort.throwIfAborted()
  return { ok: true, data }
}

function summarizeRecordEmbed(rec: Record<string, unknown>): string {
  const type = asString(rec.$type) ?? ""
  if (type.includes("viewNotFound")) return "[Quoted post: not found]"
  if (type.includes("viewBlocked")) return "[Quoted post: blocked]"
  if (type.includes("viewDetached")) return "[Quoted post: detached]"
  const author = asRecord(rec.author)
  const handle = asString(author?.handle) ?? asString(author?.did) ?? "unknown"
  const value = asRecord(rec.value)
  const text = (asString(value?.text) ?? "").replace(/\s+/g, " ")
  const snippet = text.length > 180 ? `${text.slice(0, 180)}...` : text
  const uri = asString(rec.uri)
  const webUrl = uri ? atUriToWebUrl(uri, asString(author?.handle)) : null
  return `[Quote @${handle}${webUrl ? ` (${webUrl})` : ""}: ${snippet || "(no text)"}]`
}

function formatEmbedLines(embed: unknown, depth = 0): string[] {
  if (depth > 4) return []
  const rec = asRecord(embed)
  if (!rec) return []
  const lines: string[] = []

  // External link card
  const ext = asRecord(rec.external)
  if (ext) {
    const uri = asString(ext.uri)
    const title = asString(ext.title)
    const desc = asString(ext.description)?.replace(/\s+/g, " ")
    if (uri || title) {
      lines.push(`Link: ${title ? `${title} ` : ""}${uri ? `<${uri}>` : ""}`.trim())
      if (desc) lines.push(`Link description: ${desc.length > 180 ? `${desc.slice(0, 180)}...` : desc}`)
    }
  }

  // Images with alt text
  if (Array.isArray(rec.images) && rec.images.length > 0) {
    const alts = rec.images
      .map((img, idx) => {
        const alt = asString(asRecord(img)?.alt)?.replace(/\s+/g, " ")
        return alt ? `#${idx + 1}: "${alt.length > 160 ? `${alt.slice(0, 160)}...` : alt}"` : null
      })
      .filter(Boolean)
    lines.push(`Images: ${rec.images.length}${alts.length ? ` (alt: ${alts.join("; ")})` : ""}`)
  }

  // Video
  if (asString(rec.$type)?.includes("video")) {
    const alt = asString(rec.alt)?.replace(/\s+/g, " ")
    lines.push(`Video${alt ? ` (alt: "${alt.length > 160 ? `${alt.slice(0, 160)}...` : alt}")` : ""}`)
  }

  // Nested media inside recordWithMedia
  if (rec.media) {
    lines.push(...formatEmbedLines(rec.media, depth + 1))
  }

  // Quoted record (direct or inside recordWithMedia)
  const quoted = asRecord(rec.record)
  if (quoted) {
    const inner = asRecord(quoted.record) ?? quoted
    lines.push(summarizeRecordEmbed(inner))
  }

  return lines
}

function formatMetrics(post: Record<string, unknown>): string {
  const parts: string[] = []
  const likes = asNumber(post.likeCount)
  const reposts = asNumber(post.repostCount)
  const replies = asNumber(post.replyCount)
  const quotes = asNumber(post.quoteCount)
  if (likes !== undefined) parts.push(`${likes} likes`)
  if (reposts !== undefined) parts.push(`${reposts} reposts`)
  if (replies !== undefined) parts.push(`${replies} replies`)
  if (quotes !== undefined) parts.push(`${quotes} quotes`)
  return parts.join(" | ")
}

function formatPostBlock(post: Record<string, unknown>, options: { indent?: string; badge?: string } = {}): string {
  const indent = options.indent ?? ""
  const author = asRecord(post.author)
  const handle = asString(author?.handle) ?? asString(author?.did) ?? "unknown"
  const displayName = asString(author?.displayName)
  const record = asRecord(post.record)
  const createdAt = asString(record?.createdAt) ?? asString(post.indexedAt) ?? "unknown time"
  const text = typeof record?.text === "string" ? record.text.trim() : ""
  const uri = asString(post.uri) ?? ""
  const webUrl = uri ? atUriToWebUrl(uri, asString(author?.handle)) : null
  const metrics = formatMetrics(post)
  const embeds = formatEmbedLines(post.embed)

  const authorTitle = displayName && displayName !== handle ? `${displayName} (@${handle})` : `@${handle}`
  const header = `${indent}${options.badge ? `[${options.badge}] ` : ""}**${authorTitle}** · ${createdAt}`
  const out: string[] = [header]
  if (text) {
    for (const line of text.split(/\r?\n/)) out.push(`${indent}  ${line}`)
  } else {
    out.push(`${indent}  (no text)`)
  }
  for (const e of embeds) out.push(`${indent}  ${e}`)
  if (metrics) out.push(`${indent}  Stats: ${metrics}`)
  if (webUrl) out.push(`${indent}  URL: ${webUrl}`)
  if (uri) out.push(`${indent}  AT URI: ${uri}`)
  return out.join("\n")
}

function errorResult(operation: string, error: unknown, ctx: ToolContext): ReturnType<typeof failed> {
  ctx.abort.throwIfAborted()
  const message = error instanceof Error ? error.message : "Unknown error"
  return failed(`Bluesky ${operation} failed: ${redactText(message, knownSecrets())}`)
}

// ---------------------------------------------------------------------------
// bluesky_search — app.bsky.feed.searchPosts
// ---------------------------------------------------------------------------

export const search = free({
  description:
    "Search public Bluesky posts via the official keyless AppView API (app.bsky.feed.searchPosts). " +
    "Supports sort ('top' or 'latest'), author, since/until dates, language, limit (default 20, max 50), and cursor pagination. " +
    "Returns author handle, timestamp, text, engagement counts, embedded links/alt-text, AT URI, and clickable bsky.app URL. Free and keyless.",
  async execute(args, ctx: ToolContext) {
    ctx.abort.throwIfAborted()
    const q = typeof args.q === "string" ? args.q.trim() : ""
    if (!q) return failed("q is required for bluesky_search.")

    const sort = args.sort ?? "latest"
    if (typeof sort !== "string" || !(SEARCH_SORTS as readonly string[]).includes(sort)) {
      return failed(`sort must be one of: ${SEARCH_SORTS.join(", ")}.`)
    }

    let limit = DEFAULT_SEARCH_LIMIT
    if (args.limit !== undefined) {
      if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_SEARCH_LIMIT) {
        return failed(`limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}.`)
      }
      limit = args.limit
    }

    const author = typeof args.author === "string" && args.author.trim() ? stripAt(args.author) : undefined
    const since = asString(args.since)
    const until = asString(args.until)
    const lang = asString(args.lang)
    const cursor = asString(args.cursor)

    try {
      const res = await xrpcGet(
        "app.bsky.feed.searchPosts",
        { q, sort, author, since, until, lang, limit, cursor },
        ctx,
      )
      if (!res.ok) return failed(res.message)

      const data = asRecord(res.data)
      if (!data || !Array.isArray(data.posts)) {
        return failed("Bluesky searchPosts returned an unexpected payload: missing posts array.")
      }

      const posts = data.posts.map(asRecord).filter((p): p is Record<string, unknown> => p !== null)
      const nextCursor = asString(data.cursor)
      const hitsTotal = asNumber(data.hitsTotal)

      const details: Record<string, unknown> = {
        provider: "bluesky",
        query: q,
        sort,
        returned: posts.length,
        ...(hitsTotal !== undefined ? { hitsTotal } : {}),
        ...(nextCursor ? { cursor: nextCursor } : {}),
      }

      if (posts.length === 0) {
        return outcome("empty", `No Bluesky posts found for "${q}" (sort: ${sort}).`, details)
      }

      const header = [
        `Bluesky search for "${q}" (sort: ${sort}, showing ${posts.length}${hitsTotal !== undefined ? ` of ~${hitsTotal.toLocaleString("en-US")} hits` : ""}):`,
        "",
      ]
      const body = posts.map((post) => formatPostBlock(post)).join("\n\n")
      const footer = nextCursor ? `\n\nMore posts: pass cursor "${nextCursor}" to bluesky_search.` : ""

      return outcome("success", `${header.join("\n")}${body}${footer}`, details)
    } catch (error) {
      return errorResult("search", error, ctx)
    }
  },
} satisfies ToolSpec)

// ---------------------------------------------------------------------------
// bluesky_thread — app.bsky.feed.getPostThread
// ---------------------------------------------------------------------------

export const thread = free({
  description:
    "Read a public Bluesky post thread (ancestors, focal post, and nested replies) via app.bsky.feed.getPostThread. " +
    "Accepts either an at://.../app.bsky.feed.post/<rkey> URI or a https://bsky.app/profile/<handle>/post/<rkey> URL (resolving handles automatically). " +
    "Configurable reply depth (default 6, max 20) and parentHeight (default 6, max 20). Free and keyless.",
  async execute(args, ctx: ToolContext) {
    ctx.abort.throwIfAborted()
    const parsed = parsePostTarget(typeof args.post === "string" ? args.post : "")
    if ("error" in parsed) return failed(parsed.error)

    let depth = DEFAULT_THREAD_DEPTH
    if (args.depth !== undefined) {
      if (typeof args.depth !== "number" || !Number.isInteger(args.depth) || args.depth < 0 || args.depth > MAX_THREAD_DEPTH) {
        return failed(`depth must be an integer between 0 and ${MAX_THREAD_DEPTH}.`)
      }
      depth = args.depth
    }

    let parentHeight = DEFAULT_PARENT_HEIGHT
    if (args.parentHeight !== undefined) {
      if (typeof args.parentHeight !== "number" || !Number.isInteger(args.parentHeight) || args.parentHeight < 0 || args.parentHeight > MAX_PARENT_HEIGHT) {
        return failed(`parentHeight must be an integer between 0 and ${MAX_PARENT_HEIGHT}.`)
      }
      parentHeight = args.parentHeight
    }

    try {
      let did = parsed.actor
      if (!parsed.isDid) {
        const resolved = await xrpcGet("com.atproto.identity.resolveHandle", { handle: parsed.actor }, ctx)
        if (!resolved.ok) return failed(resolved.message)
        const resolvedDid = asString(asRecord(resolved.data)?.did)
        if (!resolvedDid || !resolvedDid.startsWith("did:")) {
          return failed(`Could not resolve Bluesky handle "${parsed.actor}" to a DID.`)
        }
        did = resolvedDid
      }

      const uri = `at://${did}/app.bsky.feed.post/${parsed.rkey}`
      const res = await xrpcGet("app.bsky.feed.getPostThread", { uri, depth, parentHeight }, ctx)
      if (!res.ok) return failed(res.message)

      const root = asRecord(asRecord(res.data)?.thread)
      if (!root) return failed("Bluesky getPostThread returned an unexpected payload: missing thread.")

      const rootType = asString(root.$type) ?? ""
      if (rootType.includes("notFoundPost")) {
        return outcome("empty", `Bluesky post not found: ${uri}`, { provider: "bluesky", uri, found: false })
      }
      if (rootType.includes("blockedPost")) {
        return outcome("empty", `Bluesky post is blocked or unavailable: ${uri}`, { provider: "bluesky", uri, blocked: true })
      }
      const focalPost = asRecord(root.post)
      if (!focalPost) return failed("Bluesky getPostThread returned an unexpected thread node without post data.")

      // Walk parent chain (root.parent -> ... -> oldest), honoring requested parentHeight
      const ancestors: string[] = []
      const seenParents = new Set<string>([uri])
      let cursorParent = parentHeight > 0 ? asRecord(root.parent) : null
      let guard = 0
      while (cursorParent && guard < parentHeight) {
        guard += 1
        const pType = asString(cursorParent.$type) ?? ""
        if (pType.includes("notFoundPost")) {
          ancestors.push("[Parent post not found]")
          break
        }
        if (pType.includes("blockedPost")) {
          ancestors.push("[Parent post blocked]")
          break
        }
        const pPost = asRecord(cursorParent.post)
        if (!pPost) break
        const pUri = asString(pPost.uri)
        if (pUri) {
          if (seenParents.has(pUri)) break
          seenParents.add(pUri)
        }
        ancestors.push(formatPostBlock(pPost, { badge: "Parent" }))
        cursorParent = asRecord(cursorParent.parent)
      }
      ancestors.reverse()

      // Walk reply tree (depth-first, bounded by depth, node limit, and cycle guard)
      const replyBlocks: string[] = []
      const seenReplies = new Set<string>([uri])
      let renderedReplies = 0
      let truncatedReplies = 0

      const walkReplies = (nodes: unknown, level: number): void => {
        if (level > depth || !Array.isArray(nodes)) return
        for (const item of nodes) {
          const node = asRecord(item)
          if (!node) continue
          if (renderedReplies >= MAX_THREAD_REPLIES) {
            truncatedReplies += 1
            continue
          }
          const indent = "  ".repeat(Math.min(level, 8))
          const nType = asString(node.$type) ?? ""
          if (nType.includes("notFoundPost")) {
            replyBlocks.push(`${indent}[Reply not found]`)
            renderedReplies += 1
            continue
          }
          if (nType.includes("blockedPost")) {
            replyBlocks.push(`${indent}[Reply blocked]`)
            renderedReplies += 1
            continue
          }
          const rPost = asRecord(node.post)
          if (!rPost) continue
          const rUri = asString(rPost.uri)
          if (rUri) {
            if (seenReplies.has(rUri)) continue
            seenReplies.add(rUri)
          }
          replyBlocks.push(formatPostBlock(rPost, { indent }))
          renderedReplies += 1
          walkReplies(node.replies, level + 1)
        }
      }
      walkReplies(root.replies, 1)

      const sections: string[] = [
        `Bluesky thread for ${atUriToWebUrl(uri, asString(asRecord(focalPost.author)?.handle)) ?? uri} (ancestors: ${ancestors.length}, replies shown: ${renderedReplies}):`,
        "",
      ]
      if (ancestors.length > 0) {
        sections.push("### Parent context", "", ancestors.join("\n\n"), "")
      }
      sections.push("### Focal post", "", formatPostBlock(focalPost, { badge: "Focal post" }), "")
      if (replyBlocks.length > 0) {
        sections.push(`### Replies (${renderedReplies}${truncatedReplies ? `, +${truncatedReplies} omitted at cap` : ""})`, "", replyBlocks.join("\n\n"))
      } else {
        sections.push("### Replies", "", "No public replies returned at this depth.")
      }

      return outcome("success", sections.join("\n").trim(), {
        provider: "bluesky",
        uri,
        ancestors: ancestors.length,
        replies: renderedReplies,
        truncatedReplies,
      })
    } catch (error) {
      return errorResult("thread", error, ctx)
    }
  },
} satisfies ToolSpec)

// ---------------------------------------------------------------------------
// bluesky_profile — app.bsky.actor.getProfile + optional getAuthorFeed
// ---------------------------------------------------------------------------

export const profile = free({
  description:
    "Inspect a public Bluesky account profile (app.bsky.actor.getProfile) and optionally its recent posts (app.bsky.feed.getAuthorFeed). " +
    "Accepts a handle (e.g. bsky.app) or DID. Configurable includePosts (default true), limit (default 15, max 50), filter, and cursor. Free and keyless.",
  async execute(args, ctx: ToolContext) {
    ctx.abort.throwIfAborted()
    const actorRaw = typeof args.actor === "string" ? stripAt(args.actor) : ""
    if (!actorRaw) return failed("actor is required (Bluesky handle or DID).")

    const includePosts = args.includePosts === undefined ? true : Boolean(args.includePosts)

    let limit = DEFAULT_PROFILE_LIMIT
    if (args.limit !== undefined) {
      if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_PROFILE_LIMIT) {
        return failed(`limit must be an integer between 1 and ${MAX_PROFILE_LIMIT}.`)
      }
      limit = args.limit
    }

    const filter = asString(args.filter)
    if (filter && !(FEED_FILTERS as readonly string[]).includes(filter)) {
      return failed(`filter must be one of: ${FEED_FILTERS.join(", ")}.`)
    }
    const cursor = asString(args.cursor)

    try {
      const profileRes = await xrpcGet("app.bsky.actor.getProfile", { actor: actorRaw }, ctx)
      if (!profileRes.ok) return failed(profileRes.message)

      const prof = asRecord(profileRes.data)
      if (!prof || (!asString(prof.handle) && !asString(prof.did))) {
        return failed("Bluesky getProfile returned an unexpected payload.")
      }

      const handle = asString(prof.handle) ?? actorRaw
      const did = asString(prof.did) ?? ""
      const displayName = asString(prof.displayName)
      const bio = typeof prof.description === "string" ? prof.description.trim() : ""
      const followers = asNumber(prof.followersCount)
      const follows = asNumber(prof.followsCount)
      const postsCount = asNumber(prof.postsCount)
      const createdAt = asString(prof.createdAt)

      const lines: string[] = [
        `# ${displayName ? `${displayName} (@${handle})` : `@${handle}`}`,
        [
          did ? `DID: ${did}` : null,
          `Profile: https://bsky.app/profile/${handle}`,
          createdAt ? `Joined: ${createdAt.split("T")[0]}` : null,
        ].filter(Boolean).join(" | "),
        [
          followers !== undefined ? `Followers: ${followers.toLocaleString("en-US")}` : null,
          follows !== undefined ? `Following: ${follows.toLocaleString("en-US")}` : null,
          postsCount !== undefined ? `Posts: ${postsCount.toLocaleString("en-US")}` : null,
        ].filter(Boolean).join(" | "),
      ]
      if (bio) lines.push("", bio)

      const details: Record<string, unknown> = {
        provider: "bluesky",
        handle,
        did,
        ...(followers !== undefined ? { followersCount: followers } : {}),
        ...(follows !== undefined ? { followsCount: follows } : {}),
        ...(postsCount !== undefined ? { postsCount } : {}),
      }

      if (!includePosts) {
        return outcome("success", lines.join("\n").trim(), details)
      }

      const feedRes = await xrpcGet(
        "app.bsky.feed.getAuthorFeed",
        { actor: did || handle, limit, filter, cursor },
        ctx,
      )
      if (!feedRes.ok) {
        const safeError = redactText(feedRes.message, knownSecrets())
        lines.push("", `Recent posts unavailable: ${safeError}`)
        return outcome("partial", lines.join("\n").trim(), { ...details, feedError: safeError })
      }

      const feedData = asRecord(feedRes.data)
      if (!feedData || !Array.isArray(feedData.feed)) {
        lines.push("", "Recent posts unavailable: Bluesky getAuthorFeed returned an unexpected payload.")
        return outcome("partial", lines.join("\n").trim(), details)
      }

      const feedItems = feedData.feed.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
      const nextCursor = asString(feedData.cursor)
      const blocks: string[] = []
      for (const item of feedItems) {
        const post = asRecord(item.post)
        if (!post) continue
        const reason = asRecord(item.reason)
        const isRepost = asString(reason?.$type)?.includes("reasonRepost")
        const repostBy = asString(asRecord(reason?.by)?.handle)
        const isReply = Boolean(asRecord(post.record)?.reply)
        const badge = isRepost
          ? `Repost${repostBy ? ` by @${repostBy}` : ""}`
          : isReply
            ? "Reply"
            : undefined
        blocks.push(formatPostBlock(post, { badge }))
      }

      lines.push("", `## Recent posts (${blocks.length}${filter ? `; filter: ${filter}` : ""})`, "")
      if (blocks.length === 0) {
        lines.push("No public posts returned in this feed view.")
      } else {
        lines.push(blocks.join("\n\n"))
      }
      if (nextCursor) {
        lines.push("", `More posts: pass cursor "${nextCursor}" to bluesky_profile.`)
      }

      return outcome("success", lines.join("\n").trim(), {
        ...details,
        returnedPosts: blocks.length,
        ...(nextCursor ? { cursor: nextCursor } : {}),
      })
    } catch (error) {
      return errorResult("profile", error, ctx)
    }
  },
} satisfies ToolSpec)
