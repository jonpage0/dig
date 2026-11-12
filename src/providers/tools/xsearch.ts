/**
 * X.com Search Tool via xAI Agent Tools API
 *
 * Self-contained xsearch tool for the dig plugin.
 * Uses the xAI Responses API with x_search agent tool for real-time X.com data.
 * Model and depth come from the [x] table in Dig's native config.toml; reasoning
 * effort is sent when the model supports it, and dropped if the API rejects it.
 * The answer is streamed, so a long pass is not cut off waiting for response headers.
 * A stream cut before its final event is not sent again. xAI stores a finished response
 * for 30 days, so Dig looks for it by its id, in the same call or a later one; a pass
 * whose connection dropped while it ran is not stored, so only a finished one is found.
 * Supports handle filtering, date ranges, image/video understanding,
 * and multi-turn chaining via previous_response_id.
 */
import { hostOf, hostWords } from "../../ui/host.mjs"
import { Lexer, type Token, type Tokens } from "marked"
import type { KeepRaw, ToolSpec } from "../types.js"
import { loadConfig } from "../runtime-config.js"
import { abortableDelay, keptJson, keptText } from "../http.js"
import { knownSecrets, redactProviderText } from "../secrets.js"
import { failed, metered, outcome } from "../outcome.js"

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
  stream?: boolean
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
  status?: string
  incomplete_details?: { reason?: string }
  output: Array<MessageOutput | { type: string; [key: string]: unknown }>
  citations?: string[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    reasoning_tokens?: number
    output_tokens_details?: {
      reasoning_tokens?: number
    }
    total_tokens?: number
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

/** What reading a stored response by its id found. */
type Stored =
  | { state: "finished"; body: Record<string, unknown> }
  | { state: "running" }
  | { state: "missing" }
  | { state: "error"; status: number | string }

// -- Helpers --

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function dateRange(fromDate?: string, toDate?: string): string {
  return [
    fromDate ? `from ${fromDate} 00:00 UTC (inclusive)` : "start not set",
    toDate ? `before ${toDate} 00:00 UTC (exclusive)` : "end not set",
  ].join("; ")
}

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
3. Report findings, citing each post inline where you use it with its full link (https://x.com/<handle>/status/<id>). Never cite a post by number, such as [3] or [post:12]: numbers do not reach the reader as links.
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
    message += `\n\nDate constraints: ${dateRange(options.fromDate, options.toDate)}.`
  }

  return message
}

function parseError(status: number, errorText: string): string {
  try {
    const errorJson = JSON.parse(errorText)
    // xAI's error is either an object with a message or, in a flat body, the message itself.
    const message = typeof errorJson.error === "string" ? errorJson.error : errorJson.error?.message
    if (typeof message === "string" && message) return message
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

/** Markdown tokens whose text is not prose: links and images (whose label may itself be `[1]`), code, escapes, HTML and reference definitions. */
const NOT_PROSE = new Set(["link", "image", "code", "codespan", "escape", "html", "def"])

/** The prose of a Markdown write-up, one string per text token, so a match never spans two tokens. */
function proseOf(tokens: Token[], out: string[] = []): string[] {
  for (const token of tokens) {
    if (NOT_PROSE.has(token.type)) continue
    const inner = "tokens" in token ? token.tokens : undefined
    if (token.type === "text" && !inner) out.push(token.raw)
    if (inner) proseOf(inner, out)
    if (token.type === "list") for (const item of (token as Tokens.List).items) proseOf(item.tokens, out)
    if (token.type === "table") {
      const table = token as Tokens.Table
      for (const cell of [...table.header, ...table.rows.flat()]) proseOf(cell.tokens, out)
    }
  }
  return out
}

/**
 * Grok sometimes cites posts by number (`[post:50]`, `[120]`) with no link in its text; in the runs observed, its
 * annotations then listed posts without positions and the numbers did not index that list (the post described at
 * `[post:50]` was entry 27 of it). Returns the bracketed numbers in the write-up's prose: `[post:N]`, or one to three
 * digits (so a year is not one), alone or in a list or range such as `[1, 2]` or `[1–3]`. Markdown decides what is
 * prose, so a number that is a link's label (`[1](url)`, Grok's `[[1]](url)`), a resolved reference (`[1]` with a
 * `[1]: url` definition) or code is not counted.
 */
function numberedCitations(text: string): string[] {
  const number = String.raw`(?:post:\s*\d{1,4}|\d{1,3})`
  const marker = new RegExp(String.raw`\[${number}(?:\s*[,–-]\s*${number})*\]`, "gi")
  return proseOf(Lexer.lex(text)).flatMap((prose) => prose.match(marker) ?? [])
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
    const message = error instanceof Error ? error.message : String(error)
    keep(RAW_LABEL, "error", message)
    // Node's fetch keeps why it failed (a headers timeout, a reset connection) in `cause`.
    const cause = error instanceof Error ? (error.cause as { code?: unknown; message?: unknown } | undefined) : undefined
    const why = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : null
    throw new Error(`${message}${why ? ` (${why})` : ""}. xAI may have received the request, so the pass may still have run and been charged; its cost is unknown.`, { cause: error })
  }
}

/** Events that end a Responses stream; each carries the finished `response`. */
const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed"])

/**
 * The answer of a `POST /responses` sent with `stream: true`, read by OpenAI's Responses event protocol, which xAI
 * follows: records separated by a blank line, of `event:` and `data:` lines, ended by a terminal event whose `response`
 * is the object an unstreamed call returns as its body. Only that object is kept for the raw file, so a retained
 * original has the same shape either way; the deltas are read past. A stream that reports an error, breaks or ends
 * without a terminal event is never sent again. When it broke or ended and its response id had arrived, `recover`
 * (when given) reads the stored response by that id; a finished one is the answer, kept as the call's original with
 * the charge it reports, and `recovered` is true. Otherwise what arrived (the error event, else the last `response`
 * snapshot) is kept as interrupted, so the charge is unknown, and this throws. A JSON body (a server that ignored
 * `stream`) is read as before.
 */
async function answerBody(response: Response, keep: KeepRaw, recover?: (id: string) => Promise<Stored>): Promise<{ body: unknown; recovered?: true }> {
  if (!response.body || !/^text\/event-stream\b/i.test(response.headers.get("content-type") ?? "")) return { body: await keptJson(response, keep, RAW_LABEL) }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  const secrets = knownSecrets()
  let buffer = ""
  let event = ""
  let data: string[] = []
  let seen: unknown = ""
  let answer: object | undefined
  let error: { message?: unknown } | undefined
  const dispatch = () => {
    const text = data.join("\n")
    const named = event
    event = ""
    data = []
    if (!text || text === "[DONE]") return
    // Each record is redacted by what it means before anything reads it, as keptJson does for a whole body.
    const record = redactProviderText(text, secrets)
    if (!record.json || !record.value || typeof record.value !== "object") return
    const value = record.value as { type?: unknown; response?: unknown; message?: unknown }
    const type = typeof value.type === "string" ? value.type : named
    const snapshot = value.response && typeof value.response === "object" ? value.response : undefined
    if (snapshot) seen = snapshot
    if (snapshot && TERMINAL_EVENTS.has(type)) answer = snapshot
    else if (type === "error") seen = error = value
  }
  const line = (text: string) => {
    if (!text) return dispatch()
    if (text.startsWith(":")) return
    const colon = text.indexOf(":")
    const field = colon < 0 ? text : text.slice(0, colon)
    const value = colon < 0 ? "" : text.slice(colon + 1).replace(/^ /, "")
    if (field === "event") event = value
    else if (field === "data") data.push(value)
  }
  const cut = (why: string, cause?: unknown, found?: Stored): never => {
    keep(RAW_LABEL, response.status, seen, undefined, true)
    const id = responseId(seen)
    const later = !found || !id ? "" : found.state === "running"
      ? ` Its response id is ${id}, and xAI still shows the pass running. To read the answer once it finishes, without paying for a new pass, call xsearch with recoverResponseId set to that id.`
      : ` Its response id is ${id}; xAI held no finished response under it when Dig looked${found.state === "error" ? ` (the last read failed: ${found.status})` : ""}. To look again without paying for a new pass, call xsearch with recoverResponseId set to that id.`
    throw new Error(`${why}. xAI accepted the request, so the pass may still have run and been charged; its cost is unknown.${later}`, cause === undefined ? undefined : { cause })
  }
  /** A cut stream's finished response read back by its id, or the cut itself. A recovery that cannot run changes nothing. */
  const recovered = async (why: string, cause?: unknown): Promise<{ body: unknown; recovered: true }> => {
    const id = responseId(seen)
    let found: Stored | undefined
    if (recover && id) try { found = await recover(id) } catch { found = undefined }
    if (found?.state !== "finished") return cut(why, cause, found)
    keep(RAW_LABEL, 200, found.body)
    return { body: found.body, recovered: true }
  }
  try {
    while (!answer && !error) {
      const { done, value } = await reader.read()
      if (done) {
        if (buffer) line(buffer)
        dispatch()
        break
      }
      buffer += value
      // A lone `\r` at the end may be the first half of a `\r\n` split across chunks: wait for the next one.
      for (let match; !answer && !error && (match = /\r\n|\n|\r/.exec(buffer)) && !(match[0] === "\r" && match.index === buffer.length - 1);) {
        line(buffer.slice(0, match.index))
        buffer = buffer.slice(match.index + match[0].length)
      }
    }
  } catch (failure) {
    const cause = failure instanceof Error ? (failure.cause as { code?: unknown } | undefined)?.code : undefined
    const why = [failure instanceof Error ? failure.message : String(failure), typeof cause === "string" ? cause : ""].filter(Boolean).join(": ")
    return recovered(`xAI's stream broke before its final event${why ? ` (${why})` : ""}`, failure)
  }
  reader.cancel().catch(() => {})
  if (error) cut(`xAI's stream reported an error: ${typeof error.message === "string" && error.message ? error.message : "no message"}`)
  if (!answer) return recovered("xAI's stream ended before its final event")
  keep(RAW_LABEL, response.status, answer)
  return { body: answer }
}

const responseId = (value: unknown): string | undefined => value && typeof value === "object" && "id" in value && typeof value.id === "string" && value.id ? value.id : undefined

/** Statuses of a stored response that will not change. */
const FINISHED = new Set(["completed", "incomplete", "failed", "cancelled"])
/**
 * Waits before each read of a stored response after a cut stream. Two looks, ten seconds in all: xAI does not keep a
 * pass whose connection dropped while it ran (a pass cut one second in was still not stored minutes later, 2026-11-11,
 * and its `background` mode is unsupported), so these find only a pass that had finished when the connection dropped.
 * Tests shorten them.
 */
export const RECOVERY = { waitsMs: [2_000, 8_000] }

/**
 * Reads a stored response by its id (`GET /responses/{id}`: nothing is searched and nothing is charged), once after
 * each wait, until xAI shows it finished. A 404 means none is stored under the id, which is also what an unfinished
 * pass can look like, so the reads go on; a refused key stops them. Returns the last thing found.
 */
async function storedResponse(apiKey: string, id: string, signal: AbortSignal, waitsMs: readonly number[]): Promise<Stored> {
  let found: Stored = { state: "missing" }
  for (const wait of waitsMs) {
    await abortableDelay(wait, signal)
    let response: Response
    try {
      response = await fetch(`${API_BASE}/responses/${encodeURIComponent(id)}`, { headers: { "Authorization": `Bearer ${apiKey}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
    } catch (error) {
      signal.throwIfAborted()
      found = { state: "error", status: error instanceof Error ? error.message : String(error) }
      continue
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      found = response.status === 404 ? { state: "missing" } : { state: "error", status: response.status }
      if (response.status === 401 || response.status === 403) return found
      continue
    }
    const record = redactProviderText(await response.text(), knownSecrets())
    const body = record.json && record.value && typeof record.value === "object" ? record.value as Record<string, unknown> : undefined
    if (body && FINISHED.has(String(body.status))) return { state: "finished", body }
    found = body ? { state: "running" } : { state: "error", status: "unreadable response" }
  }
  return found
}

function incompleteNote(data: ResponsesResponse): string {
  const reason = typeof data.incomplete_details?.reason === "string" ? ` (${data.incomplete_details.reason})` : ""
  return `\n\n**Incomplete response:** xAI marked this response incomplete${reason}. The readable text is retained, but it is not a complete research result.`
}

function citationNote(text: string): string {
  const numbered = numberedCitations(text)
  if (!numbered.length) return ""
  const markers = numbered.length === 1 ? "1 bracketed marker that looks like a citation by number" : `${numbered.length} bracketed markers that look like citations by number`
  return `\n\n**Citations by number:** this write-up has ${markers} (such as ${numbered[0]}) but no link for them. Dig does not resolve which post each means, and the Sources list below is numbered by Dig, not by Grok, so do not read a number as that Sources entry. Find the post a claim rests on through X's search (\`x_search_posts\`) before relying on it.`
}

function sourceList(sources: ReturnType<typeof extractContent>["sources"]): string {
  if (!sources.length) return ""
  return `\n---\n**Sources:**\n${sources.map((source, index) => `- [${index + 1}] ${source.url}${source.title ? ` - ${source.title}` : ""}\n`).join("")}`
}

const isIncomplete = (data: ResponsesResponse) => data.status === "incomplete" || data.output.some(item => item.type === "message" && item.status === "incomplete")

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
    "understanding, and multi-turn chaining via previousResponseId. Date bounds are " +
    "inclusive fromDate and exclusive toDate at 00:00 UTC. Each handle filter accepts at most 20 handles. " +
    "A pass is never sent twice: when its stream is cut, Dig looks for the finished answer under its response id (xAI keeps a finished pass, not one whose connection dropped while it ran), " +
    "and recoverResponseId reads a stored pass later, free, without running a search.",
  async execute(args, context) {
    const xConfig = loadConfig().x

    // A retried pass is charged for every attempt. The receipt's cost comes
    // from the billing reader; this tally only lets the text state a total
    // when every attempt reported one.
    let attempts = 0
    let ticks = 0
    let unreported = 0
    const keep: KeepRaw = (label, status, body, headers, interrupted) => {
      attempts += 1
      const charged = interrupted ? null : reportedTicks(body)
      if (charged === null) unreported += 1
      else ticks += charged
      if (interrupted) context.keep(label, status, body, headers, true)
      else context.keep(label, status, body)
    }
    const passUsd = () => (attempts && !unreported ? ticks / USD_TICKS_PER_DOLLAR : null)
    const fail = (message: string) => failed(`ERROR: ${message}`)

    const apiKey = process.env.XAI_API_KEY
    if (!apiKey) {
      return failed(hostOf(process.env.DIG_HOST) === "codex" ? "ERROR: XAI_API_KEY is not set in Dig's keys.env. The user adds it outside the chat (Dig Settings → Edit keys.env), or copies one Codex's environment already has (Dig Settings → X → Use existing key)." : `ERROR: XAI_API_KEY is not set in Dig's keys.env. The user adds it outside the chat by editing keys.env directly (${hostWords(process.env.DIG_HOST).skill("setup")} gives the exact line), or copies one ${hostWords(process.env.DIG_HOST).app}'s environment already has into keys.env by hand.`)
    }

    if (args.recoverResponseId) {
      const id = String(args.recoverResponseId).trim()
      let found: Stored
      try {
        found = await storedResponse(apiKey, id, context.abort, [0])
      } catch (error) {
        return fail(error instanceof Error ? error.message : "Unknown error")
      }
      if (found.state === "running") return outcome("empty", `xAI still shows the pass with response id ${id} running. Nothing was searched or charged by this read; call again with the same recoverResponseId once it has had time to finish.`)
      if (found.state === "missing") return outcome("empty", `xAI holds no response under id ${id}. It stores a pass for 30 days, and only a pass sent with storage on; a pass whose connection dropped before xAI began it is not stored. Nothing was searched or charged by this read.`)
      if (found.state === "error") return fail(`xAI could not be read for response id ${id} (${found.status}). Nothing was searched or charged by this read.`)
      context.keep(RAW_LABEL, 200, found.body)
      const data = found.body as unknown as ResponsesResponse
      if (data.error) return fail(`xAI reports the pass with response id ${id} failed: ${data.error.message}`)
      if (!Array.isArray(data.output)) return fail(`xAI's stored response under id ${id} has no readable output`)
      const { text, sources } = extractContent(data)
      const incomplete = isIncomplete(data)
      if (!text) return fail(`xAI's stored response under id ${id} is ${data.status ?? "finished"} with no readable content`)
      const charged = reportedUsd(data)
      let result = `${args.passLabel?.trim() || "pass-1"}\n${text}${incomplete ? incompleteNote(data) : ""}${citationNote(text)}`
      result += `\n\n---\n**Recovered pass:** this is the stored answer of an earlier pass, read from xAI by its response id. No search was run by this call, and the query, dates, handles and depth are those of that pass, not of this call's other arguments.\n`
      result += charged === null
        ? "- Billing: this read is free. xAI's stored response reports no charge for the pass; do not estimate one.\n"
        : `- Billing: this read is free. xAI reports the pass itself cost $${charged.toFixed(4)}; that charge belongs to the call that sent it, whose receipt records its cost as unknown.\n`
      result += sourceList(sources)
      result += `\n---\n**response_id:** ${data.id}\n`
      if (data.usage) result += `*Tokens: ${data.usage.total_tokens?.toLocaleString() ?? "not reported"}*`
      return outcome(incomplete ? "partial" : "success", result)
    }

    if (args.handles?.length && args.excludeHandles?.length) {
      return failed("ERROR: Cannot use both 'handles' and 'excludeHandles' - choose one")
    }
    if (args.handles?.length > 20 || args.excludeHandles?.length > 20) {
      return failed("ERROR: Each handle filter accepts at most 20 handles. Split a larger scope into explicit searches; no handles were silently omitted.")
    }
    for (const name of ["fromDate", "toDate"]) {
      if (args[name] !== undefined && !validDate(args[name])) {
        return failed(`ERROR: ${name} must be a valid YYYY-MM-DD date. Date-time values are not applied by X Search.`)
      }
    }
    if (args.fromDate && args.toDate && args.fromDate >= args.toDate) {
      return failed("ERROR: toDate must be after fromDate. toDate is exclusive at 00:00 UTC; to search one day, use the following date.")
    }

    // Build tools array
    const xSearchTool: XSearchToolConfig = { type: "x_search" }
    if (args.handles?.length) {
      xSearchTool.allowed_x_handles = args.handles.map((h: string) => h.replace(/^@/, ""))
    }
    if (args.excludeHandles?.length) {
      xSearchTool.excluded_x_handles = args.excludeHandles.map((h: string) => h.replace(/^@/, ""))
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
      queryWithContext = `${args.query} (Date range: ${dateRange(args.fromDate, args.toDate)})`
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
      stream: true,
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
          if (requestBody.previous_response_id) {
            return fail(`${parseError(response.status, errorText)} (status ${response.status}). The chained request was not retried without its previous response context. To continue, start an explicit new pass with the full question and relevant prior evidence.`)
          }
          const retryBody: ResponsesRequest = {
            ...requestBody,
            store: false,
          }
          response = await callResponsesApi(apiKey, retryBody, context.abort, keep)
          if (response.ok) {
            requestBody.store = false
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

      // A response sent without storage cannot be read back, so its cut stream is not looked for.
      const answered = await answerBody(response, keep, requestBody.store === false ? undefined : (id) => storedResponse(apiKey, id, context.abort, RECOVERY.waitsMs))
      const data = answered.body as ResponsesResponse
      if (data.error) return fail(data.error.message)
      if (!Array.isArray(data.output)) return fail("No response content from xAI API")

      const { text, sources } = extractContent(data)
      const incomplete = isIncomplete(data)
      if (!text) return fail(incomplete ? "xAI returned an incomplete response with no readable content" : "No response content from xAI API")

      // Build result
      const passLabel = args.passLabel?.trim() || "pass-1"
      let result = `${passLabel}\n${text}`
      if (incomplete) result += incompleteNote(data)
      result += citationNote(text)
      if (answered.recovered) result += "\n\n**Recovered:** xAI's stream was cut before its final event. The pass was not sent again: Dig read the finished answer back from xAI by its response id."

      // Search parameters summary
      const handleList = args.handles?.length ? args.handles.map((h: string) => h.replace(/^@/, "")).join(", ") : "none"
      const excludeList = args.excludeHandles?.length ? args.excludeHandles.map((h: string) => h.replace(/^@/, "")).join(", ") : "none"
      const activeTools = tools.map((t) => t.type).join(", ")

      result += "\n\n---\n**Search Parameters:**\n"
      result += `- Query: ${args.query}\n`
      result += `- Model: ${selectedModel}\n`
      result += `- Depth: ${depth}${requestBody.reasoning ? ` (requested effort: ${requestBody.reasoning.effort})` : " (effort not sent; provider default applies)"}\n`
      result += "- Billing: every pass is paid, and a deeper pass costs more; the receipt records the charge xAI reported.\n"
      result += `- Tools: ${activeTools}\n`
      result += `- Store: ${requestBody.store === false ? "false" : "true"}\n`
      result += `- Handles: ${handleList}\n`
      result += `- Excluded Handles: ${excludeList}\n`
      result += `- Date Range: ${dateRange(args.fromDate, args.toDate)}\n`
      if (requestBody.previous_response_id) {
        result += `- Chained from: ${requestBody.previous_response_id}\n`
      }

      result += sourceList(sources)

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
        result += `*Tokens: ${data.usage.total_tokens?.toLocaleString() ?? "not reported"}${reasoningStr}${costStr}*`
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

      return outcome(incomplete ? "partial" : "success", result)
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Unknown error")
    }
  },
} satisfies ToolSpec, "USD", reportedUsd)
// Reading a stored response back by its id runs nothing and is not charged.
search.billing = { ...(search.billing as Exclude<ToolSpec["billing"], "free" | undefined>), noCharge: (args) => typeof args?.recoverResponseId === "string" && args.recoverResponseId.trim().length > 0 }
