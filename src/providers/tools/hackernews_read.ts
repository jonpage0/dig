import { keptJson, keptText } from "../http.js"
import { free, outcome } from "../outcome.js"
import type { ToolSpec } from "../types.js"

const text = (value: string) => value.replace(/<[^>]*>/g, "").replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => String.fromCodePoint(n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n))).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")

/** One exact item and a bounded page of its descendants; no query matching or ranking. */
export const read = free({
  description: "Read a specific Hacker News story or comment by item ID or news.ycombinator.com item URL, with unshortened text and a bounded page of comments in the provider's order. Use offset to continue. No account or key required.",
  async execute(args, ctx) {
    try {
      let id = String(args.item ?? "").trim()
      if (id.startsWith("https://")) {
        const url = new URL(id)
        if (url.hostname !== "news.ycombinator.com" || url.pathname !== "/item") throw new Error("Use a Hacker News item URL or numeric ID")
        id = url.searchParams.get("id") ?? ""
      }
      if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error("item must be a positive safe integer ID or a Hacker News item URL")
      const offset = args.offset ?? 0, limit = args.limit ?? 100
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("offset must be nonnegative and limit must be 1–500")
      const response = await fetch(`https://hn.algolia.com/api/v1/items/${id}`, { signal: ctx.abort, headers: { "User-Agent": "dig-hackernews" } })
      if (!response.ok) { await keptText(response, ctx.keep, `item ${id}`); throw new Error(`HN item read returned HTTP ${response.status}`) }
      const root = await keptJson(response, ctx.keep, `item ${id}`) as any
      if (root === null) return outcome("empty", `Hacker News returned no item for ${id}.`)
      if (!root || String(root.id) !== id || !Array.isArray(root.children)) throw new Error("HN returned an unexpected item payload")
      const comments: { item: any; parent: number }[] = []
      const stack = [...root.children].reverse().map(item => ({ item, parent: root.id }))
      let malformed = false
      while (stack.length) {
        const entry = stack.pop()!
        if (!entry.item || !Number.isSafeInteger(entry.item.id) || !Array.isArray(entry.item.children)) { malformed = true; continue }
        comments.push(entry)
        for (const child of [...entry.item.children].reverse()) stack.push({ item: child, parent: entry.item.id })
      }
      const show = (item: any, parent?: number) => [`## ${item.id}${parent ? ` (reply to ${parent})` : ""}${typeof item.title === "string" ? ` — ${text(item.title)}` : ""}`, `HN: https://news.ycombinator.com/item?id=${item.id}`, `Author: ${item.author ?? "unavailable/deleted"} | Date: ${item.created_at ?? "unavailable"}`, ...(typeof item.url === "string" ? [`Linked URL: ${item.url}`] : []), typeof item.text === "string" ? text(item.text) : "[No text returned]"].join("\n")
      const selected = comments.slice(offset, offset + limit)
      const more = offset + selected.length < comments.length
      const lines = [show(root), `\nComments: ${selected.length} shown of ${comments.length} returned; offset ${offset}.`, ...selected.map(entry => show(entry.item, entry.parent))]
      if (more) lines.push(`Continue with hackernews_read item=${id}, offset=${offset + selected.length}, limit=${limit}.`)
      if (malformed) lines.push("Some descendant records were malformed; comment coverage is incomplete.")
      return outcome(more || malformed ? "partial" : "success", lines.join("\n\n"))
    } catch (error) {
      ctx.abort.throwIfAborted()
      return `ERROR: ${error instanceof Error ? error.message : "HN item read failed"}`
    }
  },
} satisfies ToolSpec)
