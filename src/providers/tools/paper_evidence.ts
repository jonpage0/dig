import { keptJson, keptText } from "../http.js"
import { free, outcome } from "../outcome.js"
import { knownSecrets, redactText } from "../secrets.js"
import type { ToolContext, ToolSpec } from "../types.js"

const base = "https://api.semanticscholar.org/graph/v1"
const required = (value: unknown, field: string) => { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`); return value.trim() }
function limit(value: unknown) { const n = value ?? 10; if (!Number.isSafeInteger(n) || Number(n) < 1 || Number(n) > 100) throw new Error("limit must be 1–100"); return Number(n) }
function tool(description: string, action: ToolSpec["execute"]): ToolSpec {
  return free({ description, async execute(args, ctx) { try { return await action(args, ctx) } catch (error) { ctx.abort.throwIfAborted(); return `ERROR: ${redactText(error instanceof Error ? error.message : "Paper retrieval failed", knownSecrets())}` } } })
}
async function get(path: string, params: Record<string, string | number | undefined>, ctx: ToolContext): Promise<any> {
  const url = new URL(base + path)
  for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, String(value))
  const key = process.env.PAPER_SEARCH_MCP_SEMANTIC_SCHOLAR_API_KEY?.trim() || process.env.SEMANTIC_SCHOLAR_API_KEY?.trim()
  const response = await fetch(url, { signal: ctx.abort, redirect: "error", headers: { Accept: "application/json", ...(key ? { "x-api-key": key } : {}) } })
  if (!response.ok) { await keptText(response, ctx.keep, path); throw new Error(`Semantic Scholar returned HTTP ${response.status}`) }
  const body = await keptJson(response, ctx.keep, path) as any
  if (!body || !Array.isArray(body.data) || body.error || body.message) throw new Error("Semantic Scholar returned an invalid data array")
  return body
}
function show(body: any, label: string) {
  const raw = JSON.stringify(body, null, 2), truncated = raw.length > 60000
  const more = body.next !== undefined && body.next !== null
  return outcome(truncated || more ? "partial" : body.data.length ? "success" : "empty", `${label}\n${more ? `Next offset: ${body.next}.` : ""}${truncated ? " Output shortened; read the retained original." : ""}\n\n${raw.slice(0, 60000)}`)
}
export const snippets = tool("Find Semantic Scholar passages matching a question, optionally restricted to known papers. Returns snippet text, section, offsets and paper identity. Snippets are partial paper evidence, not full text.", async (args, ctx) => {
  if (args.paperIds !== undefined && (!Array.isArray(args.paperIds) || args.paperIds.length > 100 || args.paperIds.some((id: unknown) => typeof id !== "string" || !id.trim() || id.includes(",")))) throw new Error("paperIds must contain at most 100 nonempty IDs")
  return show(await get("/snippet/search", { query: required(args.query, "query"), limit: limit(args.limit), paperIds: args.paperIds?.join(",") }, ctx), "Semantic Scholar matching passages")
})
export const relations = tool("Read one page of papers citing a known Semantic Scholar paper, or its references, with citation context and intent. Direction is citations or references. Preserve paper IDs and distinguish citation context from the paper's own conclusion.", async (args, ctx) => {
  if (!["citations", "references"].includes(args.direction)) throw new Error("direction must be citations or references")
  const offset = args.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 9999) throw new Error("offset must be 0–9999")
  const id = required(args.paperId, "paperId")
  return show(await get(`/paper/${encodeURIComponent(id)}/${args.direction}`, { fields: "contexts,intents,isInfluential,title,abstract,authors,year,url,externalIds", limit: limit(args.limit), offset }, ctx), `Semantic Scholar ${args.direction} for ${id}`)
})
