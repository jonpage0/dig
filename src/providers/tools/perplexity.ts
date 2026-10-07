/** Perplexity Agent API (low/medium/high presets) and separate Search API.
 * Direct HTTP keeps tools available to source-research subagents.
 * Requires PERPLEXITY_API_KEY; PERPLEXITY_TIMEOUT_MS bounds the entire response.
 */
import { keptJson, keptText } from "../http.js"
import { outcome } from "../outcome.js"
import type { SourceToolResult, ToolContext, ToolSpec } from "../types.js"

const PERPLEXITY_BASE = "https://api.perplexity.ai"
const VERSION = "0.9.0"
const RECENCY = ["hour", "day", "week", "month", "year"] as const
const CONTEXT_SIZES = ["low", "medium", "high"] as const
const DATE_FILTERS = [
  "search_after_date_filter", "search_before_date_filter",
  "last_updated_after_filter", "last_updated_before_filter",
] as const
const FILTER_FIELDS = ["search_domain_filter", "search_recency_filter", ...DATE_FILTERS] as const
const BUDGET_FIELDS = ["max_tokens", "max_tokens_per_page"] as const
const AGENT_FIELDS = ["messages", ...FILTER_FIELDS, "search_context_size", ...BUDGET_FIELDS] as const
const SEARCH_FIELDS = ["query", "max_results", "country", "search_type", "search_language_filter", ...FILTER_FIELDS, "search_context_size", ...BUDGET_FIELDS] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function argumentsObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Arguments must be an object")
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new Error("Unsupported Perplexity argument; use the current tool schema")
  }
  return value
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function strings(value: unknown, name: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || !value.every(nonempty)) {
    throw new Error(`${name} must be an array of at most ${max} nonempty strings`)
  }
  return value
}

function integer(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`)
  }
  return value
}

function oneOf(value: unknown, name: string, choices: readonly string[]): string {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new Error(`${name} must be one of: ${choices.join(", ")}`)
  }
  return value
}

function searchFilters(args: Record<string, unknown>): Record<string, unknown> {
  const filters: Record<string, unknown> = {}
  if (args.search_domain_filter !== undefined) {
    const domains = strings(args.search_domain_filter, "search_domain_filter", 20)
    if (domains.some((domain) => domain.length > 253 || domain === "-")) {
      throw new Error("Domain filter entries must contain a domain or URL and at most 253 characters")
    }
    if (domains.some((domain) => domain.startsWith("-")) && domains.some((domain) => !domain.startsWith("-"))) {
      throw new Error("search_domain_filter cannot mix allowlist and denylist entries")
    }
    filters.search_domain_filter = domains
  }
  if (args.search_recency_filter !== undefined) {
    filters.search_recency_filter = oneOf(args.search_recency_filter, "search_recency_filter", RECENCY)
  }
  for (const field of DATE_FILTERS) {
    if (args[field] === undefined) continue
    const value = args[field]
    if (typeof value !== "string" || !/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
      throw new Error(`${field} must use MM/DD/YYYY`)
    }
    const [month, day, year] = value.split("/").map(Number)
    const date = new Date(`${value.slice(6)}-${value.slice(0, 2)}-${value.slice(3, 5)}T00:00:00Z`)
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
      throw new Error(`${field} must be a valid calendar date`)
    }
    filters[field] = value
  }
  return filters
}

function searchBudgets(args: Record<string, unknown>): Record<string, unknown> {
  const budgets: Record<string, unknown> = {}
  if (args.search_context_size !== undefined) {
    budgets.search_context_size = oneOf(args.search_context_size, "search_context_size", CONTEXT_SIZES)
  }
  for (const field of BUDGET_FIELDS) {
    if (args[field] !== undefined) budgets[field] = integer(args[field], field, 1_000_000)
  }
  return budgets
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown Perplexity error"
  const key = process.env.PERPLEXITY_API_KEY
  return key ? message.replaceAll(key, "[REDACTED]") : message
}

async function makeApiRequest(endpoint: string, body: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
  if (ctx.abort.aborted) throw new Error("Perplexity request cancelled by caller")
  const key = process.env.PERPLEXITY_API_KEY
  if (!key) throw new Error("PERPLEXITY_API_KEY not set. Get a key at https://docs.perplexity.ai")
  const timeoutMs = integer(Number(process.env.PERPLEXITY_TIMEOUT_MS ?? "300000"), "PERPLEXITY_TIMEOUT_MS", 2_147_483_647)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  const signal = AbortSignal.any([ctx.abort, controller.signal])
  try {
    let response: Response
    try {
      response = await fetch(`${PERPLEXITY_BASE}/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "User-Agent": `opencode-dig/${VERSION}`,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      // An issued request that never answered may still be billed: record it as an unknown-charge observation.
      ctx.keep(endpoint, "error", safeMessage(error))
      throw error
    }
    if (!response.ok) {
      // Provider bodies can echo credentials; redact before limiting error length.
      const detail = (await keptText(response, ctx.keep, endpoint)).replaceAll(key, "[REDACTED]").slice(0, 300)
      throw new Error(`Perplexity API error: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`)
    }
    const data: unknown = await keptJson(response, ctx.keep, endpoint)
    if (signal.aborted) throw new Error("Request interrupted")
    if (!isRecord(data)) throw new Error("Perplexity API returned a malformed response")
    return data
  } catch (error) {
    if (ctx.abort.aborted) throw new Error("Perplexity request cancelled by caller")
    if (controller.signal.aborted) throw new Error(`Perplexity request timed out after ${timeoutMs}ms; no completed result received`)
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

function sourceLines(source: Record<string, unknown>, label: string): string[] {
  if (!nonempty(source.url)) throw new Error("Perplexity returned a source without a URL")
  const lines = [`${label}${text(source.title) ? ` ${source.title}` : ""}`, `URL: ${source.url}`]
  if (text(source.date)) lines.push(`Published: ${source.date}`)
  if (text(source.last_updated)) lines.push(`Last updated: ${source.last_updated}`)
  if (text(source.source)) lines.push(`Source type: ${source.source}`)
  if (text(source.snippet)) lines.push(`Snippet: ${source.snippet}`)
  return lines
}

function formatAgent(data: Record<string, unknown>, preset: string): string {
  if (data.error || !["completed", "incomplete"].includes(String(data.status))) {
    const message = isRecord(data.error) ? text(data.error.message) : undefined
    throw new Error(`Perplexity Agent status: ${text(data.status) ?? "missing"}${message ? ` — ${message}` : ""}`)
  }
  if (!Array.isArray(data.output)) throw new Error("Perplexity Agent returned no output array")
  const answers: string[] = []
  const sources: string[] = []
  const annotations: string[] = []
  const sourceIds = new Set<number>()
  for (const item of data.output) {
    if (!isRecord(item)) throw new Error("Perplexity Agent returned a malformed output item")
    if (item.type === "message") {
      if (!Array.isArray(item.content)) throw new Error("Perplexity Agent returned malformed message content")
      for (const part of item.content) {
        if (!isRecord(part) || part.type !== "output_text") continue
        if (typeof part.text !== "string") throw new Error("Perplexity Agent returned malformed answer text")
        answers.push(part.text)
        if (Array.isArray(part.annotations)) {
          for (const annotation of part.annotations) {
            if (isRecord(annotation) && annotation.type === "url_citation") {
              annotations.push(...sourceLines(annotation, "URL citation:"), "")
            }
          }
        }
      }
    } else if (item.type === "search_results") {
      if (!Array.isArray(item.results)) throw new Error("Perplexity Agent returned malformed search results")
      for (const source of item.results) {
        if (!isRecord(source) || typeof source.id !== "number" || !Number.isSafeInteger(source.id)) {
          throw new Error("Perplexity Agent returned a source without a valid citation id")
        }
        sourceIds.add(source.id)
        // Citation IDs belong to the provider, not the array position or display order.
        sources.push(...sourceLines(source, `[web:${source.id}] (numeric marker [${source.id}])`), "")
      }
    } else if (item.type === "fetch_url_results") {
      if (!Array.isArray(item.contents)) throw new Error("Perplexity Agent returned malformed fetched sources")
      for (const source of item.contents) {
        if (!isRecord(source)) throw new Error("Perplexity Agent returned a malformed fetched source")
        sources.push(...sourceLines(source, "Fetched source (no citation id supplied):"), "")
      }
    }
  }
  // output_text is an SDK convenience; HTTP responses normally require output[].content[].text.
  const answer = answers.join("\n\n") || text(data.output_text)
  if (!answer?.trim()) throw new Error("Perplexity Agent returned no answer text")
  const unresolved = new Set<string>()
  for (const match of answer.matchAll(/\[(?:web:)?(\d+)\]/g)) {
    if (!sourceIds.has(Number(match[1]))) unresolved.add(match[0])
  }
  const lines = [
    ...(data.status === "incomplete" ? ["ERROR: Perplexity Agent returned incomplete output; partial evidence follows."] : []),
    `Perplexity Agent preset: ${preset} | Status: ${data.status}${text(data.model) ? ` | Model: ${data.model}` : ""}`,
    "", answer,
  ]
  if (sources.length) lines.push("", "Sources (provider IDs preserved):", ...sources)
  if (annotations.length) lines.push("", "Provider URL annotations (not numbered by this adapter):", ...annotations)
  if (!sources.length && !annotations.length) lines.push("", "Grounding warning: provider returned no source records; this answer is not verified web evidence.")
  if (unresolved.size) lines.push("", `Grounding warning: no returned source ID resolves ${[...unresolved].join(", ")}; do not treat those markers as verified citations.`)
  return lines.join("\n")
}

/** Preserve the Agent API's reported usage amount in its returned currency; omitted currency means USD. */
const agentMetered = (spec: ToolSpec): ToolSpec => ({
  ...spec,
  billing: {
    charge({ body }) {
      const cost = isRecord(body) && isRecord(body.usage) && isRecord(body.usage.cost) ? body.usage.cost : undefined
      if (!cost || typeof cost.total_cost !== "number") return { cost: null }
      return { cost: [{ amount: cost.total_cost, unit: cost.currency === undefined ? "USD" : cost.currency as string }] }
    },
  },
})

async function performAgent(value: unknown, preset: "low" | "medium" | "high", ctx: ToolContext): Promise<SourceToolResult> {
  try {
    const args = argumentsObject(value, AGENT_FIELDS)
    if (!Array.isArray(args.messages) || !args.messages.length) throw new Error("messages must be a nonempty array")
    const input = args.messages.map((message: unknown) => {
      if (!isRecord(message) || !nonempty(message.content)) throw new Error("Each message must contain nonempty text")
      return { type: "message", role: oneOf(message.role, "message role", ["system", "user", "assistant"]), content: message.content }
    })
    const filters = searchFilters(args)
    const budgets = searchBudgets(args)
    const data = await makeApiRequest("v1/agent", {
      preset,
      input,
      tools: [{ type: "web_search", ...(Object.keys(filters).length ? { filters } : {}), ...budgets }],
    }, ctx)
    const output = formatAgent(data, preset)
    return args.search_context_size !== undefined && BUDGET_FIELDS.every((field) => args[field] === undefined)
      ? `${output}\n\nSearch context note: named size was sent, but the preset's explicit token budgets take precedence. Use max_tokens and max_tokens_per_page to override preset search depth.`
      : output
  } catch (error) {
    return `ERROR: ${safeMessage(error)}`
  }
}

export const ask = agentMetered({
  description: "Answer narrow factual questions with Perplexity Agent API preset low. Returns provider answer and source IDs/URLs. Supports domain/date/recency filters and search context budgets. For deeper investigation use perplexity_research; for complex analysis use perplexity_reason.",
  execute: (args: unknown, ctx: ToolContext) => performAgent(args, "low", ctx),
} satisfies ToolSpec)

export const reason = agentMetered({
  description: "Analyze complex comparisons and multi-hop questions with Perplexity Agent API preset medium. Returns the answer and provider source IDs/URLs. Supports domain/date/recency filters and search context budgets.",
  execute: (args: unknown, ctx: ToolContext) => performAgent(args, "medium", ctx),
} satisfies ToolSpec)

export const research = agentMetered({
  description: "Conduct deep multi-source investigation with Perplexity Agent API preset high. Slower than ask/reason; returns the answer and provider source IDs/URLs. Supports domain/date/recency filters and search context budgets.",
  execute: (args: unknown, ctx: ToolContext) => performAgent(args, "high", ctx),
} satisfies ToolSpec)

export const search = {
  description: "Search the separate Perplexity Search API without AI synthesis. One query or up to five related queries; domain/date/language/recency/country filters. Preserves full URLs, snippets, publication and last-update dates. Named context size cannot be combined with token budgets.",
  async execute(value: unknown, ctx: ToolContext): Promise<SourceToolResult> {
    try {
      const args = argumentsObject(value, SEARCH_FIELDS)
      const query = typeof args.query === "string" ? args.query : strings(args.query, "query", 5)
      if (typeof query === "string" ? !nonempty(query) : !query.length) throw new Error("query must contain 1-5 nonempty queries")
      const searchType = oneOf(args.search_type ?? "web", "search_type", ["web", "people"])
      const budgets = searchBudgets(args)
      if (args.search_context_size !== undefined && BUDGET_FIELDS.some((field) => args[field] !== undefined)) {
        throw new Error("Search API search_context_size cannot be combined with max_tokens or max_tokens_per_page")
      }
      const body: Record<string, unknown> = {
        query,
        search_type: searchType,
        max_results: integer(args.max_results ?? 10, "max_results", searchType === "people" ? 50 : 20),
        ...searchFilters(args),
        ...budgets,
      }
      if (args.country !== undefined) {
        if (typeof args.country !== "string" || !/^[a-z]{2}$/i.test(args.country)) throw new Error("country must be a two-letter ISO code")
        body.country = args.country
      }
      if (args.search_language_filter !== undefined) {
        const languages = strings(args.search_language_filter, "search_language_filter", 20)
        if (languages.some((language) => !/^[a-z]{2}$/i.test(language))) throw new Error("Language filters must be two-letter ISO codes")
        body.search_language_filter = languages
      }
      const data = await makeApiRequest("search", body, ctx)
      if (data.error || !Array.isArray(data.results)) throw new Error("Perplexity Search returned an error or malformed results array")
      if (!data.results.length) return outcome("empty", `No search results found for ${JSON.stringify(query)}.`)
      const lines = [`Found ${data.results.length} search results for ${JSON.stringify(query)}:`, ""]
      for (const [index, result] of data.results.entries()) {
        if (!isRecord(result)) throw new Error("Perplexity Search returned a malformed result")
        lines.push(...sourceLines(result, `${index + 1}.`), "")
      }
      return lines.join("\n")
    } catch (error) {
      return `ERROR: ${safeMessage(error)}`
    }
  },
} satisfies ToolSpec
