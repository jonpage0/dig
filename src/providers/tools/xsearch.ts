/**
 * X.com Search Tool via xAI Agent Tools API
 *
 * Self-contained xsearch tool for the dig plugin. Ported from opencode-xsearch.
 * Uses the xAI Responses API with x_search agent tool for real-time X.com data.
 * Model and depth come from the [x] table in Dig's native config.toml; reasoning
 * effort is sent when the model supports it, and dropped if the API rejects it.
 * Supports handle filtering, date ranges, image/video understanding,
 * multi-turn chaining via previous_response_id, and prompt caching.
 */
import type { KeepRaw, ToolSpec } from "../types.js"
import { loadConfig } from "../runtime-config.js"
import { keptJson, keptText } from "../http.js"
import { metered } from "../outcome.js"

const API_BASE = "https://api.x.ai/v1"
/** xAI reports cost in ticks of 1e-10 USD. */
const USD_TICKS_PER_DOLLAR = 10_000_000_000
const RAW_LABEL = "x_search"

// -- Types --

interface XSearchToolConfig {
  type: "x_search"
  allowed_x_handles?: string[]
  excluded_x_handles?: string[]
  from_date?: string
  to_date?: string
  enable_image_understanding?: boolean
  enable_video_understanding?: boolean
}

interface WebSearchToolConfig {
  type: "web_search"
}

interface CodeInterpreterToolConfig {
  type: "code_interpreter"
}

type ToolConfig = XSearchToolConfig | WebSearchToolConfig | CodeInterpreterToolConfig

interface InputMessage {
  role: "system" | "user" | "assistant"
  content: string
}

interface ResponsesRequest {
  model: string
  input: InputMessage[]
  tools: ToolConfig[]
  store?: boolean
  reasoning?: {
    effort: ReasoningEffort
  }
  previous_response_id?: string
}

interface MessageOutput {
  type: "message"
  id: string
  role: string
  content: Array<{
    type: "output_text"
    text: string
    annotations?: Array<{
      type: "url_citation"
      url: string
      title?: string
      start_index: number
      end_index: number
    }>
  }>
  status?: string
}

interface ResponsesResponse {
  id: string
  output: Array<MessageOutput | { type: string; [key: string]: unknown }>
  citations?: string[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    reasoning_tokens?: number
    output_tokens_details?: {
      reasoning_tokens?: number
    }
    total_tokens: number
    cost_in_usd_ticks?: number
    num_sources_used?: number
    num_server_side_tools_used?: number
    server_side_tool_usage_details?: Record<string, number>
  }
  server_side_tool_usage?: Record<string, number>
  error?: {
    message: string
    code?: string
  }
}

// -- Helpers --

function buildSystemMessage(options: {
  fromDate?: string
  toDate?: string
  webSearchEnabled: boolean
}): string {
  const today = new Date().toISOString().split("T")[0]

  let message = `You are an X.com search specialist. Current Date: ${today} (UTC).

Your job:
1. Use the x_search tool to find relevant X.com posts
2. Analyze the posts you find
3. Report findings with inline citations when available
4. If no results, state clearly "No results found" and explain why

Response Format:
- Summary (1-3 sentences)
- Key Findings with citations
- Claims vs Discourse: distinguish corroborated facts from social-media claims or vibes
- Evidence Table or Timeline when it materially improves clarity
- Sentiment/Discourse (if applicable)
- Negative Evidence: note material handles, time windows, or query angles that produced weak/no signal

Never fabricate posts. If search returns empty, say so clearly.`

  if (options.webSearchEnabled) {
    message += `\n\nYou also have web_search available. Prioritize X.com posts — they are the primary source. Use web search only to verify claims or add context from official sources.`
  }

  if (options.fromDate || options.toDate) {
    message += `\n\nDate constraints: ${options.fromDate ? `from ${options.fromDate}` : ""}${options.fromDate && options.toDate ? " " : ""}${options.toDate ? `to ${options.toDate}` : ""}`
  }

  return message
}

function parseError(status: number, errorText: string): string {
  try {
    const errorJson = JSON.parse(errorText)
    if (errorJson.error?.message) return errorJson.error.message
  } catch {}

  if (status === 401 || status === 403) return `AUTH_ERROR: ${errorText || "Authentication failed - check XAI_API_KEY"}`
  if (status === 429) return `RATE_LIMIT: ${errorText || "Too many requests - try again later"}`
  if (status === 402) return `PAYMENT_REQUIRED: ${errorText || "Insufficient credits - add funds at console.x.ai"}`
  if (status === 410) return `API_DEPRECATED: ${errorText || "This API endpoint has been deprecated"}`
  if (status >= 500) return `SERVER_ERROR: ${errorText || "xAI API server error - try again later"}`
  return errorText || `HTTP ${status}`
}

function extractContent(response: ResponsesResponse): { text: string; sources: Array<{ url: string; title?: string }> } {
  let text = ""
  const sources: Array<{ url: string; title?: string }> = []
  const seenUrls = new Set<string>()

  for (const item of response.output) {
    if (item.type === "message") {
      const messageItem = item as MessageOutput
      for (const content of messageItem.content) {
        if (content.type === "output_text") {
          text += content.text
          if (content.annotations) {
            for (const annotation of content.annotations) {
              if (annotation.type === "url_citation" && !seenUrls.has(annotation.url)) {
                seenUrls.add(annotation.url)
                sources.push({ url: annotation.url, title: annotation.title })
              }
            }
          }
        }
      }
    }
  }

  for (const url of response.citations ?? []) {
    if (!seenUrls.has(url)) {
      seenUrls.add(url)
      sources.push({ url })
    }
  }

  return { text, sources }
}

type XSearchDepth = "quick" | "standard" | "max" | "ultra"
type ReasoningEffort = "low" | "medium" | "high"

function reasoningEffortForDepth(depth: XSearchDepth): ReasoningEffort {
  if (depth === "quick") return "low"
  if (depth === "max" || depth === "ultra") return "high"
  return "medium"
}

// Explicitly supported model families. Unlisted models use their provider default;
// the response names that omission rather than claiming depth was applied.
function supportsReasoningEffort(model: string): boolean {
  return model === "grok-4.3" || /^grok-4\.[5-9](?:-|$)/.test(model) || model.includes("reasoning")
}

async function callResponsesApi(apiKey: string, requestBody: ResponsesRequest, signal: AbortSignal, keep: KeepRaw): Promise<Response> {
  try {
    return await fetch(`${API_BASE}/responses`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    })
  } catch (error) {
    // An issued request that never answered may still be billed: record it as an unknown-charge observation.
    keep(RAW_LABEL, "error", error instanceof Error ? error.message : String(error))
    throw error
  }
}

function shouldRetryWithoutStorage(status: number, errorText: string): boolean {
  return status === 400 && errorText.includes("Response is too large to store")
}

// A model that does not accept `reasoning.effort` rejects it with a 400 naming the
// parameter. Retrying without it beats hard-coding every model xAI ships, and keeps
// a model swap in config.toml ([x] model) from silently turning `depth` into a no-op.
function shouldRetryWithoutReasoning(status: number, errorText: string, sentReasoning: boolean): boolean {
  return sentReasoning && status === 400 && /reasoning|effort/i.test(errorText)
}

/** xAI's own charge on one response body, in ticks; null when the body reports none. */
function reportedTicks(body: unknown): number | null {
  if (!body || typeof body !== "object" || !("usage" in body)) return null
  const usage = body.usage
  if (!usage || typeof usage !== "object" || !("cost_in_usd_ticks" in usage)) return null
  return typeof usage.cost_in_usd_ticks === "number" && Number.isFinite(usage.cost_in_usd_ticks) ? usage.cost_in_usd_ticks : null
}

/** One response's reported charge converted from ticks to USD. */
function reportedUsd(body: unknown): number | null {
  const ticks = reportedTicks(body)
  return ticks === null ? null : ticks / USD_TICKS_PER_DOLLAR
}

function getReasoningTokens(usage: NonNullable<ResponsesResponse["usage"]>): number | undefined {
  return usage.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens
}

function getServerSideToolUsage(response: ResponsesResponse): Record<string, number> | undefined {
  return response.server_side_tool_usage ?? response.usage?.server_side_tool_usage_details
}

// -- Tool --

export const search = metered({
  description:
    "Search X.com (Twitter) for real-time posts and discussions using xAI Agent Tools API. " +
    "Returns synthesized findings with citations to X posts, and can report per-post public " +
    "metrics (likes, reposts, quotes, replies, bookmarks, views) when asked for them. " +
    "Supports X search operators in the query, handle filtering, date ranges, multimedia " +
    "understanding, and multi-turn chaining via previousResponseId.",
  async execute(args, context) {
    const xConfig = loadConfig().x

    // A retried pass is charged for every attempt. The receipt's cost comes
    // from the billing reader; this tally only lets the text state a total
    // when every attempt reported one.
    let attempts = 0
    let ticks = 0
    let unreported = 0
    const keep: KeepRaw = (label, status, body) => {
      attempts += 1
      const charged = reportedTicks(body)
      if (charged === null) unreported += 1
      else ticks += charged
      context.keep(label, status, body)
    }
    const passUsd = () => (attempts && !unreported ? ticks / USD_TICKS_PER_DOLLAR : null)
    const fail = (message: string) => `ERROR: ${message}`

    const apiKey = process.env.XAI_API_KEY
    if (!apiKey) {
      return "ERROR: XAI_API_KEY is not set in Dig's keys.env. The user adds it outside the chat (Dig Settings → Edit keys.env), or copies one Codex's environment already has (Dig Settings → X → Use existing key)."
    }

    if (args.handles?.length && args.excludeHandles?.length) {
      return "ERROR: Cannot use both 'handles' and 'excludeHandles' - choose one"
    }

    // Build tools array
    const xSearchTool: XSearchToolConfig = { type: "x_search" }
    if (args.handles?.length) {
      xSearchTool.allowed_x_handles = args.handles.map((h: string) => h.replace(/^@/, "")).slice(0, 20)
    }
    if (args.excludeHandles?.length) {
      xSearchTool.excluded_x_handles = args.excludeHandles.map((h: string) => h.replace(/^@/, "")).slice(0, 20)
    }
    if (args.fromDate) xSearchTool.from_date = args.fromDate
    if (args.toDate) xSearchTool.to_date = args.toDate
    xSearchTool.enable_image_understanding = true
    xSearchTool.enable_video_understanding = true

    const tools: ToolConfig[] = [xSearchTool]

    const webSearchEnabled = args.enableWebSearch ?? xConfig.webSearch
    if (webSearchEnabled) {
      tools.push({ type: "web_search" })
    }
    if (xConfig.codeExecution) {
      tools.push({ type: "code_interpreter" })
    }

    // Build query with date context
    let queryWithContext = args.query
    if (args.fromDate || args.toDate) {
      const dateContext = []
      if (args.fromDate) dateContext.push(`from ${args.fromDate}`)
      if (args.toDate) dateContext.push(`to ${args.toDate}`)
      queryWithContext = `${args.query} (Date range: ${dateContext.join(" ")})`
    }
    // Build input messages
    const input: InputMessage[] = []
    if (!args.previousResponseId) {
      input.push({
        role: "system",
        content: buildSystemMessage({ fromDate: args.fromDate, toDate: args.toDate, webSearchEnabled }),
      })
    }
    input.push({ role: "user", content: queryWithContext })

    const depth = args.depth ?? xConfig.depth
    const selectedModel = xConfig.model
    const requestBody: ResponsesRequest = {
      model: selectedModel,
      input,
      tools,
      store: true,
    }
    if (supportsReasoningEffort(selectedModel)) {
      requestBody.reasoning = { effort: reasoningEffortForDepth(depth) }
    }
    if (args.previousResponseId) {
      requestBody.previous_response_id = args.previousResponseId
    }

    try {
      let response = await callResponsesApi(apiKey, requestBody, context.abort, keep)

      if (!response.ok) {
        const errorText = await keptText(response, keep, RAW_LABEL)
        if (shouldRetryWithoutStorage(response.status, errorText)) {
          const retryBody: ResponsesRequest = {
            ...requestBody,
            store: false,
            previous_response_id: undefined,
          }
          response = await callResponsesApi(apiKey, retryBody, context.abort, keep)
          if (response.ok) {
            requestBody.store = false
            requestBody.previous_response_id = undefined
          } else {
            const retryErrorText = await keptText(response, keep, RAW_LABEL)
            return fail(`${parseError(response.status, retryErrorText)} (status ${response.status})`)
          }
        } else if (shouldRetryWithoutReasoning(response.status, errorText, requestBody.reasoning != null)) {
          const retryBody: ResponsesRequest = { ...requestBody, reasoning: undefined }
          response = await callResponsesApi(apiKey, retryBody, context.abort, keep)
          if (response.ok) {
            requestBody.reasoning = undefined
          } else {
            const retryErrorText = await keptText(response, keep, RAW_LABEL)
            return fail(`${parseError(response.status, retryErrorText)} (status ${response.status})`)
          }
        } else {
          return fail(`${parseError(response.status, errorText)} (status ${response.status})`)
        }
      }

      const data = (await keptJson(response, keep, RAW_LABEL)) as ResponsesResponse
      if (data.error) return fail(data.error.message)

      const { text, sources } = extractContent(data)
      if (!text) return fail("No response content from xAI API")

      // Build result
      const passLabel = args.passLabel?.trim() || "pass-1"
      let result = `${passLabel}\n${text}`

      // Search parameters summary
      const handleList = args.handles?.length ? args.handles.map((h: string) => h.replace(/^@/, "")).join(", ") : "none"
      const excludeList = args.excludeHandles?.length ? args.excludeHandles.map((h: string) => h.replace(/^@/, "")).join(", ") : "none"
      const activeTools = tools.map((t) => t.type).join(", ")

      result += "\n\n---\n**Search Parameters:**\n"
      result += `- Query: ${args.query}\n`
      result += `- Model: ${selectedModel}\n`
      result += `- Depth: ${depth}${requestBody.reasoning ? ` (requested effort: ${requestBody.reasoning.effort})` : " (effort not sent; provider default applies)"}\n`
      result += "- X Search billing: from 2026-09-21 12:00 PM Pacific, $5 per 1,000 fetched posts and $10 per 1,000 fetched profiles replace $5 per 1,000 tool calls. Parent and quoted posts count; model-token charges are separate. See https://docs.x.ai/developers/tools/x-search.\n"
      result += `- Tools: ${activeTools}\n`
      result += `- Store: ${requestBody.store === false ? "false" : "true"}\n`
      result += `- Handles: ${handleList}\n`
      result += `- Excluded Handles: ${excludeList}\n`
      result += `- Date Range: ${args.fromDate ?? "not set"} to ${args.toDate ?? "not set"}\n`
      if (args.previousResponseId) {
        result += `- Chained from: ${args.previousResponseId}\n`
      }

      if (sources.length > 0) {
        result += "\n---\n**Sources:**\n"
        sources.forEach((source, index) => {
          const title = source.title ? ` - ${source.title}` : ""
          result += `- [${index + 1}] ${source.url}${title}\n`
        })
      }

      result += "\n---\n"
      result += `**response_id:** ${data.id}\n`
      const usdTotal = passUsd()
      if (data.usage) {
        const costStr = usdTotal != null
          ? ` | $${usdTotal.toFixed(4)}${attempts > 1 ? ` over ${attempts} attempts` : ""}`
          : ""
        const reasoningTokens = getReasoningTokens(data.usage)
        const reasoningStr = reasoningTokens != null
          ? ` | Reasoning: ${reasoningTokens.toLocaleString()}`
          : ""
        result += `*Tokens: ${data.usage.total_tokens.toLocaleString()}${reasoningStr}${costStr}*`
        if (data.usage.num_sources_used != null || data.usage.num_server_side_tools_used != null) {
          const sourceStr = data.usage.num_sources_used != null
            ? `Sources used: ${data.usage.num_sources_used.toLocaleString()}`
            : ""
          const toolStr = data.usage.num_server_side_tools_used != null
            ? `Server-side tools: ${data.usage.num_server_side_tools_used.toLocaleString()}`
            : ""
          result += `\n*${[sourceStr, toolStr].filter(Boolean).join(" | ")}*`
        }
      }
      if (usdTotal == null) {
        result += "\n*Provider cost unavailable; do not estimate it from the number of cited posts or tool calls.*"
      }
      const serverSideToolUsage = getServerSideToolUsage(data)
      if (serverSideToolUsage && Object.keys(serverSideToolUsage).length > 0) {
        result += "\n\n**Server-side tool usage:**\n"
        for (const [tool, count] of Object.entries(serverSideToolUsage)) {
          result += `- ${tool}: ${count}\n`
        }
      }

      return result
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Unknown error")
    }
  },
} satisfies ToolSpec, "USD", reportedUsd)
