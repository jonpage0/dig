/**
 * Hacker News search tool.
 *
 * Hybrid approach:
 *   - Search: Algolia HN Search API (full-text search, filters, fast)
 *   - Comment trees: Algolia Items API (full recursive thread in one call)
 *   - Live feeds: Firebase HN API (top/new/best/show/ask stories)
 *
 * All free, public, no auth required.
 *
 * Algolia: https://hn.algolia.com/api — 10,000 req/hr/IP
 * Firebase: https://hacker-news.firebaseio.com/v0/ — no documented rate limits
 */
import { keptJson, keptText } from "../http.js"
import { free, outcome } from "../outcome.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HNHit {
  objectID: string
  title?: string
  url?: string
  author: string
  points?: number | null
  num_comments?: number | null
  story_text?: string | null
  comment_text?: string | null
  story_title?: string | null
  story_url?: string | null
  created_at: string
  created_at_i: number
  _tags?: string[]
}

interface HNSearchResponse {
  hits: HNHit[]
  nbHits: number
  page: number
  nbPages: number
  hitsPerPage: number
}

/** Algolia Items API — returns full comment tree recursively */
interface HNItem {
  id: number
  title?: string
  url?: string
  author: string | null
  text?: string | null
  points?: number | null
  type?: string
  created_at?: string
  created_at_i?: number
  children?: HNItem[]
}

// ---------------------------------------------------------------------------
// Main tool
// ---------------------------------------------------------------------------

/** Search HN stories and comments, with optional full comment tree enrichment. Keyless and free. */
export default free({
  description:
    "Search Hacker News for stories, Show HN posts, Ask HN threads, and comments. " +
    "Uses the Algolia HN Search API (free, no auth). " +
    "Returns results with points, comment counts, authors, and URLs. " +
    "Can fetch full comment trees for top stories (recursive, single API call). " +
    "Best for tech community sentiment, startup news, and developer sentiment.",
  async execute(args, context) {
    context.abort.throwIfAborted()
    const days = args.days ?? 30
    const limit = Math.min(args.limit ?? 20, 50)
    const type = args.type ?? "story"
    const sortBy = args.sort ?? "relevance"

    // Calculate the timestamp for the recency window
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - days * 86400

    // Build tag filters based on type
    let tagFilter = ""
    if (type === "story") {
      tagFilter = "&tags=story"
    } else if (type === "comment") {
      tagFilter = "&tags=comment"
    }

    // Choose endpoint: search (relevance) or search_by_date (date)
    const endpoint =
      sortBy === "date"
        ? "https://hn.algolia.com/api/v1/search_by_date"
        : "https://hn.algolia.com/api/v1/search"

    // points>2 filters out low-engagement noise
    const pointsFilter = type === "comment" ? "" : ",points>2"

    const url =
      `${endpoint}?query=${encodeURIComponent(args.query)}` +
      `&numericFilters=created_at_i>${cutoffTimestamp}${pointsFilter}` +
      `&hitsPerPage=${limit}` +
      tagFilter

    try {
      const response = await fetch(url, {
        signal: context.abort,
        headers: { "User-Agent": "opencode-hackernews-tool/1.0" },
      })

      if (!response.ok) {
        await keptText(response, context.keep, "search").catch(() => "")
        return `ERROR: HN API returned ${response.status}: ${response.statusText}`
      }

      context.abort.throwIfAborted()
      const data = (await keptJson(response, context.keep, "search")) as HNSearchResponse

      if (data.hits.length === 0) {
        return outcome("empty", `No Hacker News results found for "${args.query}" in the last ${days} days.`)
      }

      // For story results with high engagement, fetch full comment trees
      // via Algolia Items API (returns entire thread in one call)
      const commentTrees = new Map<string, HNItem>()
      if (type === "story" || type === "all") {
        const highEngagement = data.hits
          .filter((h) => h._tags?.includes("story") && (h.num_comments ?? 0) >= 5)
          .sort((a, b) => (b.num_comments ?? 0) - (a.num_comments ?? 0))
          .slice(0, 5) // Fetch comment trees for top 5 most-discussed stories

        // Fetch in parallel
        const treePromises = highEngagement.map(async (hit) => {
          try {
            const itemResp = await fetch(
              `https://hn.algolia.com/api/v1/items/${hit.objectID}`,
              {
                signal: context.abort,
                headers: { "User-Agent": "opencode-hackernews-tool/1.0" },
              }
            )
            if (itemResp.ok) {
              const item = (await keptJson(itemResp, context.keep, `item ${hit.objectID}`)) as HNItem
              commentTrees.set(hit.objectID, item)
            } else await keptText(itemResp, context.keep, `item ${hit.objectID}`)
          } catch {
            context.abort.throwIfAborted()
            // Skip failed fetches — we still have the search results
          }
        })
        await Promise.all(treePromises)
      }

      // Format results
      const results = data.hits.map((hit) => {
        const isComment = hit._tags?.includes("comment")

        if (isComment) {
          const text = hit.comment_text
            ? stripHtml(hit.comment_text).slice(0, 300)
            : "(no text)"
          return [
            `**${hit.objectID}** (comment) by ${hit.author} on "${hit.story_title || "unknown"}"`,
            `  ${text}${hit.comment_text && stripHtml(hit.comment_text).length > 300 ? "..." : ""}`,
            hit.story_url ? `  Story: ${hit.story_url}` : null,
            `  HN: https://news.ycombinator.com/item?id=${hit.objectID}`,
            `  Date: ${hit.created_at.split("T")[0]}`,
          ]
            .filter(Boolean)
            .join("\n")
        }

        // Format story result
        const tags: string[] = []
        if (hit._tags?.includes("show_hn")) tags.push("Show HN")
        if (hit._tags?.includes("ask_hn")) tags.push("Ask HN")

        const lines = [
          `**${hit.objectID}** ${tags.length > 0 ? `[${tags.join(", ")}] ` : ""}${hit.title || "(no title)"}`,
          `  Points: ${hit.points ?? "unavailable"} | Comments: ${hit.num_comments ?? "unavailable"} | Author: ${hit.author}`,
          hit.url ? `  URL: ${hit.url}` : null,
          `  HN: https://news.ycombinator.com/item?id=${hit.objectID}`,
          `  Date: ${hit.created_at.split("T")[0]}`,
          hit.story_text ? `  Text: ${stripHtml(hit.story_text).slice(0, 200)}...` : null,
        ]

        // Append top comments from the full comment tree (if fetched)
        const tree = commentTrees.get(hit.objectID)
        if (tree && tree.children && tree.children.length > 0) {
          lines.push(`  Top comments:`)

          // Get top-level comments sorted by child count (proxy for engagement)
          const topComments = tree.children
            .filter((c) => c.author && c.text && c.author !== "[deleted]")
            .sort((a, b) => (b.children?.length ?? 0) - (a.children?.length ?? 0))
            .slice(0, 5)

          for (const comment of topComments) {
            const text = stripHtml(comment.text || "").slice(0, 250)
            const replyCount = comment.children?.length ?? 0
            const truncated = (comment.text || "").length > 250 ? "..." : ""
            lines.push(
              `    💬 ${comment.author} (${replyCount} replies): ${text}${truncated}`
            )
          }
        }

        return lines.filter(Boolean).join("\n")
      })

      const enrichedCount = commentTrees.size
      const header = [
        `Hacker News results for "${args.query}" (last ${days} days, ${data.nbHits} total matches):`,
        `Showing ${data.hits.length} results sorted by ${sortBy}.` +
          (enrichedCount > 0 ? ` Comment trees fetched for ${enrichedCount} top stories.` : ""),
        "",
      ].join("\n")

      return header + results.join("\n\n")
    } catch (err) {
      context.abort.throwIfAborted()
      return `ERROR: Failed to search Hacker News: ${err instanceof Error ? err.message : "Unknown error"}`
    }
  },
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip HTML tags from a string */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ")
    .trim()
}
