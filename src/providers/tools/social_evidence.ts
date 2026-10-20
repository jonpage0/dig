import { requestJson } from "../http.js"
import { outcome } from "../outcome.js"
import { knownSecrets, redactText } from "../secrets.js"
import { creditMetered, scrapecreatorsHeaders, MISSING_KEY_ERROR, provenanceLine } from "./scrapecreators.js"
import type { ToolContext, ToolSpec } from "../types.js"

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value)
function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}
function publicUrl(value: unknown, hosts: string[]): string {
  const url = new URL(required(value, "url"))
  if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.includes(url.hostname)) throw new Error("Use a public HTTPS URL on the requested platform")
  return url.href
}
function cacheAge(value: unknown) {
  if (value !== undefined && !["1d", "3d", "7d", "14d", "30d"].includes(String(value))) throw new Error("Unsupported cacheMaxAge")
  return value
}
async function read(path: string, params: Record<string, any>, array: string | null, label: string, ctx: ToolContext, note = "") {
  const headers = scrapecreatorsHeaders()
  if (!headers) throw new Error(MISSING_KEY_ERROR)
  const url = new URL(path, "https://api.scrapecreators.com")
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value))
  const response = await requestJson({ url, headers, retries: 0, timeoutMs: 60000, signal: ctx.abort, provider: "ScrapeCreators", keep: ctx.keep, label })
  const body = response.payload
  if (response.status !== 200 || !object(body) || body.success !== true) throw new Error(`${label} failed (HTTP ${response.status})`)
  if (array && !Array.isArray(body[array])) throw new Error(`${label} did not return its ${array} array`)
  if (!array && (!object(body.post) || !(body.post.id || body.post.pk))) throw new Error("Threads returned no identifiable post")
  let malformed = false
  const view = { ...body }; delete view.credits_remaining
  if (array) {
    const seen = new Set<string>()
    view[array] = body[array].filter((item: unknown) => {
      if (!object(item)) { malformed = true; return false }
      const id = item.id ?? item.cid ?? item.pk
      if (typeof id !== "string" && !(typeof id === "number" && Number.isSafeInteger(id))) { malformed = true; return false }
      const key = String(id); if (seen.has(key)) return false; seen.add(key); return true
    })
  }
  const json = JSON.stringify(view, null, 2)
  const truncated = json.length > 60000
  const hasMore = body.has_more === true || body.has_more === 1 || body.hasMore === true || (body.cursor !== undefined && body.cursor !== null && body.cursor !== "" && body.cursor !== 0 && body.cursor !== "0")
  const count = array ? view[array].length : 1
  const status = malformed || truncated || hasMore ? "partial" : count ? "success" : "empty"
  return outcome(status, `${label}\n${provenanceLine(body)}\n${note}\nOne provider page; not a complete platform archive.${hasMore ? " More data may exist; use the returned continuation on the same operation." : ""}${malformed ? " Malformed records were omitted." : ""}${truncated ? " Output shortened; read the retained original for the rest." : ""}\n\n${json.slice(0, 60000)}`)
}
function tool(description: string, execute: ToolSpec["execute"]): ToolSpec {
  return creditMetered({ description, async execute(args, ctx) { try { return await execute(args, ctx) } catch (error) { ctx.abort.throwIfAborted(); return `ERROR: ${redactText(error instanceof Error ? error.message : "Social read failed", knownSecrets())}` } } })
}

export const tiktok_top = tool("Search TikTok's Top tab for videos and photo carousels. One page, with content types, media and continuation retained; duplicates by ID removed. Region sets the proxy location, not a content-country filter.", async (args, ctx) => {
  if (args.sort !== undefined && !["relevance", "most-liked", "date-posted"].includes(args.sort)) throw new Error("Unsupported sort")
  if (args.period !== undefined && !["yesterday", "this-week", "this-month", "last-3-months", "last-6-months", "all-time"].includes(args.period)) throw new Error("Unsupported period")
  if (args.region !== undefined && !/^[A-Z]{2}$/.test(args.region)) throw new Error("region must be a two-letter uppercase country code")
  if (args.cursor !== undefined && (!Number.isSafeInteger(args.cursor) || args.cursor < 0)) throw new Error("cursor must be a nonnegative integer")
  return read("/v1/tiktok/search/top", { query: required(args.query, "query"), sort_by: args.sort, publish_time: args.period, region: args.region, cursor: args.cursor }, "items", "TikTok Top search", ctx, "Photo carousels are image evidence, not spoken transcripts.")
})
export const tiktok_comments = tool("Read one page of comments on a public TikTok video with the provider continuation. Uses ScrapeCreators; no login and no automatic crawl.", async (args, ctx) => read("/v1/tiktok/video/comments", { url: publicUrl(args.url, ["tiktok.com", "www.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"]), cursor: args.cursor }, "comments", "TikTok comments", ctx))
export const instagram_comments = tool("Read one page of comments on a public Instagram post or reel. Bulk replies are explicit opt-in: 15 credits for a nonempty page even if no replies are returned (empty pages 0). For selected replies use instagram_read kind replies; bulk reads can be slow. Provider availability is imperfect; failure is not evidence of no comments.", async (args, ctx) => read("/v2/instagram/post/comments", { url: publicUrl(args.url, ["instagram.com", "www.instagram.com"]), cursor: args.cursor, include_replies: args.includeReplies === true }, "comments", "Instagram comments", ctx))
export const threads = tool("Read a public Threads post with comments/continuations or one account's returned posts. Supply kind post with url, or kind posts with handle. No login; posts listing has no documented pagination and is not a complete history.", async (args, ctx) => {
  if (args.kind === "post") return read("/v1/threads/post", { url: publicUrl(args.url, ["threads.com", "www.threads.com", "threads.net", "www.threads.net"]), cache_max_age: cacheAge(args.cacheMaxAge) }, null, "Threads post", ctx)
  if (args.kind !== "posts") throw new Error("kind must be post or posts")
  if (args.url !== undefined || args.cacheMaxAge !== undefined) throw new Error("url and cacheMaxAge belong to kind post")
  const handle = required(args.handle, "handle").replace(/^@/, "")
  if (!/^[A-Za-z0-9_.]{1,64}$/.test(handle)) throw new Error("Invalid Threads handle")
  return read("/v1/threads/user/posts", { handle }, "posts", `Threads @${handle} posts`, ctx, "This endpoint provides no documented pagination.")
})
