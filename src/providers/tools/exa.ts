/**
 * Exa search, content extraction, similarity, and deep research tools.
 *
 * Exa is the retrieval layer of the Dig search group: it finds documents,
 * extracts page content, and (opt-in) runs a grounded deep-reasoning search.
 * Perplexity remains the synthesis layer for question answering.
 *
 * Requires: EXA_API_KEY env var (https://dashboard.exa.ai)
 *
 * API reference: https://exa.ai/docs/reference/search (OpenAPI 2.0.0, read 2026-09-15)
 * Pricing (2026-03-03 update): /search $7/1k requests including text + highlights for
 * the first 10 results, +$1/1k results above 10, AI summaries +$1/1k pages;
 * deep-lite and deep $12/1k, deep-reasoning $15/1k; /contents $1/1k pages per content type.
 *
 * Exports four tools:
 *   exa_search     — /search with the current search modes (instant … deep-reasoning)
 *   exa_contents   — /contents with per-URL fetch status reporting
 *   exa_similar    — /findSimilar (deprecated upstream, still served)
 *   exa_research   — /search type "deep-reasoning" with a synthesized, field-grounded answer
 *
 * The retired /research endpoint (HTTP 410 RESEARCH_RETIRED since 2026-04-01) and its
 * exa-research-* model tiers are gone; the deprecated `livecrawl` freshness knob is replaced
 * by `maxAgeHours`; deprecated `highlights.numSentences` is replaced by `maxCharacters`.
 */
import { requestJson } from "../http.js"
import { metered } from "../outcome.js"
import type { KeepRaw, ToolContext, ToolSpec } from "../types.js"

const EXA_BASE = "https://api.exa.ai"
const MISSING_KEY = "ERROR: EXA_API_KEY env var not set. Get a key at https://dashboard.exa.ai"

/** Research-preview flag for Dynamic Highlights; sent only when the caller opts in. */
const DYNAMIC_HIGHLIGHTS_BETA = "dynamic-highlights-2026-08-28"

/** Public numResults ceiling on /search and /findSimilar. */
const MAX_RESULTS = 100
/** /contents `urls` maxItems. */
const MAX_CONTENT_URLS = 100
/** text.maxCharacters and highlights.maxCharacters ceiling. */
const MAX_CHARACTERS = 10_000
/** contents.maxAgeHours range: -1 = cache only, 0 = always fetch fresh, N = fetch if older than N hours. */
const MIN_MAX_AGE_HOURS = -1
const MAX_MAX_AGE_HOURS = 720
/** additionalQueries maxItems on deep search types. */
const MAX_ADDITIONAL_QUERIES = 10

const DEFAULT_RESULTS = 10
const SEARCH_TEXT_CHARACTERS = 3_000
const SIMILAR_TEXT_CHARACTERS = 2_000
const CONTENTS_TEXT_CHARACTERS = 5_000
const TEXT_PREVIEW_CHARACTERS = 500

const SEARCH_TIMEOUT_MS = 60_000
/**
 * deep-reasoning is documented at 12–40s; this is a provider-latency envelope with headroom
 * for queueing, not a "slow call" cutoff. The research call is never retried (see exaPost).
 */
const RESEARCH_TIMEOUT_MS = 180_000

/**
 * Exa documents 429 and 503 as "the request was not processed; retry with backoff".
 * Other statuses are not retried. requestJson also retries transport errors (including its
 * own timeout) up to `retries`, so the paid deep-reasoning call sets retries to 0: it must
 * never be issued twice.
 */
const EXA_RETRY_STATUSES = [429, 503] as const
const RESEARCH_RETRIES = 0

const SEARCH_TYPES = ["instant", "fast", "auto", "deep-lite", "deep", "deep-reasoning"] as const
type SearchType = (typeof SEARCH_TYPES)[number]
const RESEARCH_TYPE: SearchType = "deep-reasoning"

const CATEGORY_HELP =
  "Known categories: 'company', 'publication' (scholarly; replaced 'research paper'), 'news', " +
  "'personal site', 'financial report', 'people' (replaced 'linkedin profile'). Other strings are " +
  "accepted as hints. 'pdf', 'github', and 'tweet' are deprecated upstream. 'company' and 'people' " +
  "reject startPublishedDate, endPublishedDate, and excludeDomains (HTTP 400)."

const MAX_AGE_HELP =
  "Content freshness for extracted page content (not a publication-date filter): " +
  "omit to use cached content with a live fetch fallback, 0 to always fetch fresh, " +
  "-1 for cache only, N (1-720) to refetch pages whose cached copy is older than N hours."

const HIGHLIGHT_CHARACTERS_HELP =
  "Per-page character budget for highlights (1-10000). Omit for Exa's default budget. " +
  "Not compatible with dynamicHighlights."

const DYNAMIC_HIGHLIGHTS_HELP =
  "Opt in to Exa Dynamic Highlights (research preview): one shared excerpt budget across the whole " +
  "result set instead of a per-page budget, sent with the required Exa-Beta header. " +
  "Use when several pages feed one context window; omit for a predictable per-page excerpt."

// ---------------------------------------------------------------------------
// Response types (validated from the 2.0.0 OpenAPI schemas before rendering)
// ---------------------------------------------------------------------------

interface ExaResult {
  title?: string
  url: string
  id?: string
  publishedDate?: string
  author?: string
  text?: string
  highlights?: string[]
  summary?: string
}

interface ExaCitation {
  url: string
  title: string
}

interface ExaGrounding {
  field: string
  citations: ExaCitation[]
  confidence: "low" | "medium" | "high"
}

interface ExaSynthesisOutput {
  content: string | Record<string, unknown>
  grounding: ExaGrounding[]
}

interface ExaContentStatus {
  id: string
  status: "success" | "error"
  source?: "cached" | "crawled"
  error?: { tag?: string; httpStatusCode?: number }
}

interface ExaResponse {
  requestId?: string
  results: ExaResult[]
  costDollars?: number
  searchTime?: number
  /** Present only when outputSchema was sent. */
  output?: ExaSynthesisOutput
  /** /contents only. */
  statuses: ExaContentStatus[]
}

// ---------------------------------------------------------------------------
// Response validation — a 2xx envelope is data only when it has the documented shape
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined
}

class ExaShapeError extends Error {
  constructor(path: ExaPath, detail: string) {
    super(`Exa ${path} returned an unexpected payload: ${detail}`)
  }
}

function parseResult(path: ExaPath, value: unknown, index: number): ExaResult {
  const record = asRecord(value)
  const url = optionalString(record?.url)
  if (!record || !url) throw new ExaShapeError(path, `results[${index}] has no url`)
  const highlights = record.highlights === undefined ? undefined : stringList(record.highlights)
  if (record.highlights !== undefined && !highlights) throw new ExaShapeError(path, `results[${index}].highlights is not a string array`)
  return {
    url,
    title: optionalString(record.title),
    id: optionalString(record.id),
    publishedDate: optionalString(record.publishedDate),
    author: optionalString(record.author),
    text: optionalString(record.text),
    highlights,
    summary: optionalString(record.summary),
  }
}

function parseCitation(path: ExaPath, value: unknown, where: string): ExaCitation {
  const record = asRecord(value)
  const url = optionalString(record?.url)
  if (!record || !url) throw new ExaShapeError(path, `${where} citation has no url`)
  return { url, title: optionalString(record.title) ?? "" }
}

function parseGrounding(path: ExaPath, value: unknown, index: number): ExaGrounding {
  const record = asRecord(value)
  const field = optionalString(record?.field)
  const confidence = optionalString(record?.confidence)
  if (!record || !field || !Array.isArray(record.citations)) {
    throw new ExaShapeError(path, `output.grounding[${index}] lacks field or citations`)
  }
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
    throw new ExaShapeError(path, `output.grounding[${index}].confidence is not low|medium|high`)
  }
  return {
    field,
    confidence,
    citations: record.citations.map((c) => parseCitation(path, c, `output.grounding[${index}]`)),
  }
}

function parseOutput(path: ExaPath, value: unknown): ExaSynthesisOutput | undefined {
  if (value === undefined) return undefined
  const record = asRecord(value)
  const content = typeof record?.content === "string" ? record.content : asRecord(record?.content)
  if (!record || content === null || !Array.isArray(record.grounding)) {
    throw new ExaShapeError(path, "output lacks content or grounding")
  }
  return {
    content,
    grounding: record.grounding.map((g, index) => parseGrounding(path, g, index)),
  }
}

function parseStatus(path: ExaPath, value: unknown, index: number): ExaContentStatus {
  const record = asRecord(value)
  const id = optionalString(record?.id)
  const status = optionalString(record?.status)
  if (!record || !id || (status !== "success" && status !== "error")) {
    throw new ExaShapeError(path, `statuses[${index}] lacks id or a success|error status`)
  }
  const source = optionalString(record.source)
  const error = asRecord(record.error)
  return {
    id,
    status,
    source: source === "cached" || source === "crawled" ? source : undefined,
    error: error ? { tag: optionalString(error.tag), httpStatusCode: optionalNumber(error.httpStatusCode) } : undefined,
  }
}

/** Exa's own charge on one response body (`costDollars.total`, USD); undefined when the body reports none. */
function reportedDollars(body: unknown): number | undefined {
  return optionalNumber(asRecord(asRecord(body)?.costDollars)?.total)
}

function parseResponse(path: ExaPath, payload: Record<string, unknown>): ExaResponse {
  if (!Array.isArray(payload.results)) throw new ExaShapeError(path, "no results array")
  if (path === "/contents" && !Array.isArray(payload.statuses)) throw new ExaShapeError(path, "no statuses array")
  const statuses = Array.isArray(payload.statuses) ? payload.statuses : []
  return {
    requestId: optionalString(payload.requestId),
    results: payload.results.map((r, index) => parseResult(path, r, index)),
    costDollars: reportedDollars(payload),
    searchTime: optionalNumber(payload.searchTime),
    output: parseOutput(path, payload.output),
    statuses: statuses.map((s, index) => parseStatus(path, s, index)),
  }
}

/** Every Exa endpoint bills in USD; each captured response contributes its own `costDollars.total`. */
const exaMetered = (spec: ToolSpec): ToolSpec => metered(spec, "USD", (body) => reportedDollars(body) ?? null)

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

function apiKey(): string | null {
  return process.env.EXA_API_KEY?.trim() || null
}

/** Provider text is untrusted; never let the credential reach a rendered error. */
function redactKey(message: string, key: string): string {
  return message.split(key).join("[EXA_API_KEY redacted]")
}

type ExaPath = "/search" | "/contents" | "/findSimilar"

async function exaPost(
  path: ExaPath,
  body: Record<string, unknown>,
  options: { key: string; signal: AbortSignal; keep: KeepRaw; timeoutMs: number; retries?: number; beta?: string },
): Promise<ExaResponse> {
  const headers: Record<string, string> = {
    "x-api-key": options.key,
    "Content-Type": "application/json",
    Accept: "application/json",
  }
  if (options.beta) headers["Exa-Beta"] = options.beta

  const response = await requestJson({
    url: `${EXA_BASE}${path}`,
    method: "POST",
    headers,
    body,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    retryStatuses: EXA_RETRY_STATUSES,
    provider: "Exa",
    keep: options.keep,
    label: path,
  })

  const payload = asRecord(response.payload)
  const envelopeError = optionalString(payload?.error)
  // Exa's error envelope is { requestId, error, tag }. A 2xx carrying `error` is still a failure.
  if (response.status < 200 || response.status >= 300 || envelopeError !== undefined) {
    const message = envelopeError ?? `HTTP ${response.status}`
    const tag = optionalString(payload?.tag)
    const requestId = optionalString(payload?.requestId) ?? response.requestId
    throw new Error(
      `Exa ${path} returned HTTP ${response.status}${tag ? ` (${tag})` : ""}: ${message}${requestId ? ` [request ${requestId}]` : ""}`,
    )
  }
  if (!payload) throw new ExaShapeError(path, "non-object JSON body")
  return parseResponse(path, payload)
}

function failure(operation: string, error: unknown, signal: AbortSignal, key: string): string {
  if (signal.aborted) return `ERROR: Exa ${operation} canceled before completion; not a provider failure.`
  const message = error instanceof Error ? error.message : "Unknown error"
  return `ERROR: Exa ${operation} failed: ${redactKey(message, key)}`
}

// ---------------------------------------------------------------------------
// Argument normalization (runtime checks; the registration schema is advisory)
// ---------------------------------------------------------------------------

type Invalid = { error: string }

function invalid(value: unknown): value is Invalid {
  return typeof value === "object" && value !== null && "error" in value
}

function requireText(value: unknown, name: string): string | Invalid {
  const text = typeof value === "string" ? value.trim() : ""
  return text ? text : { error: `ERROR: ${name} is required.` }
}

function optionalText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : ""
  return text || undefined
}

function optionalStringArray(value: unknown, name: string): string[] | undefined | Invalid {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return { error: `ERROR: ${name} must be an array of strings.` }
  }
  return value as string[]
}

/** Clamp to [1, MAX_RESULTS]; returns a note when the caller asked for more than Exa serves. */
function resultCount(value: unknown): { numResults: number; note?: string } {
  if (typeof value !== "number" || !Number.isFinite(value)) return { numResults: DEFAULT_RESULTS }
  const requested = Math.trunc(value)
  if (requested > MAX_RESULTS) {
    return {
      numResults: MAX_RESULTS,
      note: `numResults ${requested} exceeds Exa's public limit; capped at ${MAX_RESULTS}.`,
    }
  }
  return { numResults: Math.max(1, requested) }
}

function maxAgeHours(value: unknown): number | undefined | Invalid {
  if (value === undefined || value === null) return undefined
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_MAX_AGE_HOURS ||
    value > MAX_MAX_AGE_HOURS
  ) {
    return { error: `ERROR: maxAgeHours must be an integer from ${MIN_MAX_AGE_HOURS} to ${MAX_MAX_AGE_HOURS}.` }
  }
  return value
}

function characterBudget(value: unknown, name: string): number | undefined | Invalid {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_CHARACTERS) {
    return { error: `ERROR: ${name} must be an integer from 1 to ${MAX_CHARACTERS}.` }
  }
  return value
}

interface HighlightArgs {
  query?: string
  highlightMaxCharacters?: number
  dynamicHighlights?: boolean
}

interface HighlightPlan {
  highlights: true | Record<string, unknown>
  beta?: string
}

/**
 * Current highlights contract: `true` for Exa's default budget, or an object with
 * `query`, `maxCharacters`, or `dynamic`. `dynamic` requires the beta header and
 * excludes `maxCharacters`.
 */
function highlightPlan(args: HighlightArgs): HighlightPlan | Invalid {
  const dynamic = args.dynamicHighlights === true
  const maxCharacters = characterBudget(args.highlightMaxCharacters, "highlightMaxCharacters")
  if (invalid(maxCharacters)) return maxCharacters
  if (dynamic && maxCharacters !== undefined) {
    return { error: "ERROR: highlightMaxCharacters cannot be combined with dynamicHighlights (Exa allocates one shared budget)." }
  }
  const query = optionalText(args.query)

  const options: Record<string, unknown> = {}
  if (query) options.query = query
  if (dynamic) options.dynamic = true
  if (maxCharacters !== undefined) options.maxCharacters = maxCharacters

  return {
    highlights: Object.keys(options).length > 0 ? options : true,
    ...(dynamic ? { beta: DYNAMIC_HIGHLIGHTS_BETA } : {}),
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function costLine(response: ExaResponse): string {
  const parts: string[] = []
  if (response.costDollars !== undefined) parts.push(`cost $${response.costDollars.toFixed(4)}`)
  if (typeof response.searchTime === "number") parts.push(`search ${Math.round(response.searchTime)} ms`)
  if (response.requestId) parts.push(`request ${response.requestId}`)
  return parts.join("; ")
}

function resultDetails(response: ExaResponse, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    provider: "exa",
    requestId: response.requestId,
    costDollars: response.costDollars,
    results: response.results.length,
    ...extra,
  }
}

function formatResult(r: ExaResult, lines: string[]): void {
  const indent = "  "
  lines.push(`**${r.title || "(no title)"}**`)
  lines.push(
    `${indent}URL: ${r.url}` +
      (r.publishedDate ? ` | Published: ${r.publishedDate.split("T")[0]}` : "") +
      (r.author ? ` | Author: ${r.author}` : ""),
  )
  if (r.summary) lines.push(`${indent}Summary: ${r.summary}`)
  if (r.highlights && r.highlights.length > 0) {
    lines.push(`${indent}Highlights:`)
    for (const h of r.highlights) lines.push(`${indent}  > ${h}`)
  }
  if (r.text) {
    const preview = r.text.slice(0, TEXT_PREVIEW_CHARACTERS).replace(/\n+/g, " ")
    lines.push(`${indent}Text preview (first ${Math.min(r.text.length, TEXT_PREVIEW_CHARACTERS)} of ${r.text.length} returned characters): ${preview}${r.text.length > TEXT_PREVIEW_CHARACTERS ? "..." : ""}`)
  }
  lines.push("")
}

function formatResults(header: string, notes: string[], response: ExaResponse): string {
  const lines: string[] = [header]
  const cost = costLine(response)
  if (cost) lines.push(`(${cost})`)
  for (const note of notes) lines.push(`Note: ${note}`)
  lines.push("")
  for (const r of response.results) formatResult(r, lines)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Shared search/findSimilar contents block
// ---------------------------------------------------------------------------

interface ContentsArgs extends HighlightArgs {
  contents?: boolean
  summary?: boolean
  maxAgeHours?: number
}

interface ContentsPlan {
  contents?: Record<string, unknown>
  beta?: string
}

function contentsPlan(args: ContentsArgs, textCharacters: number, summaryQuery?: string): ContentsPlan | Invalid {
  if (args.contents === false) return {}
  const highlights = highlightPlan(args)
  if (invalid(highlights)) return highlights
  const age = maxAgeHours(args.maxAgeHours)
  if (invalid(age)) return age

  const contents: Record<string, unknown> = {
    text: { maxCharacters: textCharacters },
    highlights: highlights.highlights,
  }
  if (args.summary === true) contents.summary = summaryQuery ? { query: summaryQuery } : {}
  if (age !== undefined) contents.maxAgeHours = age
  return { contents, ...(highlights.beta ? { beta: highlights.beta } : {}) }
}

// ---------------------------------------------------------------------------
// exa_search — /search with the current search modes
// ---------------------------------------------------------------------------

export const search = exaMetered({
  description:
    "Search the web with Exa and get ranked documents with page text and query-relevant highlights. " +
    "Search modes: 'auto' (default), 'fast', 'instant' for latency, and the Deep modes 'deep-lite', 'deep', " +
    "'deep-reasoning' ($12–15/1k) for iterative research over the selected pages. " +
    "Filters: domains/paths (wildcards like '*.substack.com'), publication dates, category. " +
    "Complementary to Perplexity: Exa returns raw documents for your analysis; use exa_research " +
    "when a synthesized, source-grounded answer is explicitly requested.",
  async execute(args, ctx: ToolContext) {
    const key = apiKey()
    if (!key) return MISSING_KEY

    const query = requireText(args.query, "query")
    if (invalid(query)) return query.error

    const type: SearchType = args.type ?? "auto"
    if (!SEARCH_TYPES.includes(type)) {
      return `ERROR: type must be one of ${SEARCH_TYPES.join(", ")}.`
    }

    const includeDomains = optionalStringArray(args.includeDomains, "includeDomains")
    if (invalid(includeDomains)) return includeDomains.error
    const excludeDomains = optionalStringArray(args.excludeDomains, "excludeDomains")
    if (invalid(excludeDomains)) return excludeDomains.error

    const { numResults, note } = resultCount(args.numResults)
    const plan = contentsPlan({ ...args, query }, SEARCH_TEXT_CHARACTERS, query)
    if (invalid(plan)) return plan.error

    const body: Record<string, unknown> = { query, numResults, type }
    if (args.category) body.category = args.category
    if (includeDomains) body.includeDomains = includeDomains
    if (excludeDomains) body.excludeDomains = excludeDomains
    if (args.startPublishedDate) body.startPublishedDate = args.startPublishedDate
    if (args.endPublishedDate) body.endPublishedDate = args.endPublishedDate
    if (plan.contents) body.contents = plan.contents

    let response: ExaResponse
    try {
      response = await exaPost("/search", body, { key, signal: ctx.abort, keep: ctx.keep, timeoutMs: SEARCH_TIMEOUT_MS, beta: plan.beta })
    } catch (error) {
      return failure("search", error, ctx.abort, key)
    }

    const notes = note ? [note] : []
    const results = response.results
    if (results.length === 0) {
      return {
        status: "empty",
        text: [`No Exa results found for "${query}" (type: ${type}).`, ...notes.map((n) => `Note: ${n}`)].join("\n"),
        details: resultDetails(response, { type }),
      }
    }

    return {
      text: formatResults(`Exa search "${query}" (type: ${type}; ${results.length} results)`, notes, response),
      details: resultDetails(response, { type, dynamicHighlights: plan.beta !== undefined }),
    }
  },
} satisfies ToolSpec)

// ---------------------------------------------------------------------------
// exa_contents — /contents with per-URL fetch status
// ---------------------------------------------------------------------------

export const contents = exaMetered({
  description:
    "Extract clean markdown text and query-relevant highlights from specific URLs via Exa's cache " +
    "with live-fetch fallback. Reports per-URL fetch status so a failed page is never silently dropped. " +
    "Bills $1/1k pages per content type (text, highlights, and optional summary each count).",
  async execute(args, ctx: ToolContext) {
    const key = apiKey()
    if (!key) return MISSING_KEY

    const urls = optionalStringArray(args.urls, "urls")
    if (invalid(urls)) return urls.error
    if (!urls || urls.length === 0) return "ERROR: urls must be a non-empty array of URLs."

    const notes: string[] = []
    const requested = urls.slice(0, MAX_CONTENT_URLS)
    if (urls.length > MAX_CONTENT_URLS) {
      notes.push(`${urls.length - MAX_CONTENT_URLS} URLs beyond Exa's ${MAX_CONTENT_URLS}-URL limit were not requested.`)
    }

    const textCharacters = characterBudget(args.maxCharacters, "maxCharacters")
    if (invalid(textCharacters)) return textCharacters.error
    const highlights = highlightPlan(args)
    if (invalid(highlights)) return highlights.error
    const age = maxAgeHours(args.maxAgeHours)
    if (invalid(age)) return age.error

    const focus = optionalText(args.query)
    const body: Record<string, unknown> = {
      urls: requested,
      text: { maxCharacters: textCharacters ?? CONTENTS_TEXT_CHARACTERS },
      highlights: highlights.highlights,
    }
    if (args.summary === true) body.summary = focus ? { query: focus } : {}
    if (age !== undefined) body.maxAgeHours = age

    let response: ExaResponse
    try {
      response = await exaPost("/contents", body, { key, signal: ctx.abort, keep: ctx.keep, timeoutMs: SEARCH_TIMEOUT_MS, beta: highlights.beta })
    } catch (error) {
      return failure("contents extraction", error, ctx.abort, key)
    }

    const results = response.results
    const statuses = response.statuses
    const failures = statuses.filter((s) => s.status === "error")
    const returned = new Set(results.map((r) => r.id ?? r.url))
    const reported = new Set(statuses.map((s) => s.id))
    const unaccounted = requested.filter((u) => !returned.has(u) && !reported.has(u))
    const sources = { cached: 0, crawled: 0 }
    for (const s of statuses) if (s.status === "success" && s.source) sources[s.source] += 1

    const lines: string[] = []
    lines.push(`Content extracted for ${results.length} of ${requested.length} requested URLs`)
    const cost = costLine(response)
    if (cost) lines.push(`(${cost})`)
    if (sources.cached || sources.crawled) lines.push(`Sources: ${sources.cached} cached, ${sources.crawled} freshly crawled`)
    for (const note of notes) lines.push(`Note: ${note}`)
    if (failures.length > 0) {
      lines.push("Fetch failures (per-URL status from Exa):")
      for (const f of failures) {
        const tag = f.error?.tag ?? "ERROR"
        const http = typeof f.error?.httpStatusCode === "number" ? ` (HTTP ${f.error.httpStatusCode})` : ""
        // Per-URL id and tag are provider text, like the top-level error envelope.
        lines.push(redactKey(`- ${f.id} — ${tag}${http}`, key))
      }
    }
    if (unaccounted.length > 0) {
      lines.push("Not returned and no status reported by Exa:")
      for (const u of unaccounted) lines.push(`- ${u}`)
    }
    lines.push("")

    for (const r of results) {
      lines.push(`## ${r.title || r.url}`)
      lines.push(`URL: ${r.url}`)
      if (r.publishedDate) lines.push(`Published: ${r.publishedDate.split("T")[0]}`)
      if (r.author) lines.push(`Author: ${r.author}`)
      lines.push("")
      if (r.summary) {
        lines.push(`**Summary:** ${r.summary}`)
        lines.push("")
      }
      if (r.highlights && r.highlights.length > 0) {
        lines.push("**Key passages:**")
        for (const h of r.highlights) lines.push(`> ${h}`)
        lines.push("")
      }
      if (r.text) {
        lines.push(
          `**Page text (${r.text.length} characters returned against a ${textCharacters ?? CONTENTS_TEXT_CHARACTERS}-character request; ` +
            "completeness not established):**",
        )
        lines.push(r.text)
        lines.push("")
      }
      lines.push("---")
      lines.push("")
    }

    return {
      text: lines.join("\n"),
      details: resultDetails(response, {
        requested: requested.length,
        failed: failures.map((f) => redactKey(f.id, key)),
        unaccounted,
        dynamicHighlights: highlights.beta !== undefined,
      }),
    }
  },
} satisfies ToolSpec)

// ---------------------------------------------------------------------------
// exa_similar — /findSimilar (deprecated upstream, still served with a Deprecation header)
// ---------------------------------------------------------------------------

export const similar = exaMetered({
  description:
    "Find web pages semantically similar to a reference URL ('more papers like this one', " +
    "'competitors to this company'). Exa marks /findSimilar deprecated in favor of /search with a " +
    "query describing the source; it is still served. Supports domain, date, and category filters.",
  async execute(args, ctx: ToolContext) {
    const key = apiKey()
    if (!key) return MISSING_KEY

    const url = requireText(args.url, "url")
    if (invalid(url)) return url.error

    const includeDomains = optionalStringArray(args.includeDomains, "includeDomains")
    if (invalid(includeDomains)) return includeDomains.error
    const excludeDomains = optionalStringArray(args.excludeDomains, "excludeDomains")
    if (invalid(excludeDomains)) return excludeDomains.error

    const { numResults, note } = resultCount(args.numResults)
    const plan = contentsPlan(args, SIMILAR_TEXT_CHARACTERS)
    if (invalid(plan)) return plan.error

    const body: Record<string, unknown> = { url, numResults }
    if (args.excludeSourceDomain === true) body.excludeSourceDomain = true
    if (includeDomains) body.includeDomains = includeDomains
    if (excludeDomains) body.excludeDomains = excludeDomains
    if (args.startPublishedDate) body.startPublishedDate = args.startPublishedDate
    if (args.endPublishedDate) body.endPublishedDate = args.endPublishedDate
    if (args.category) body.category = args.category
    if (plan.contents) body.contents = plan.contents

    let response: ExaResponse
    try {
      response = await exaPost("/findSimilar", body, { key, signal: ctx.abort, keep: ctx.keep, timeoutMs: SEARCH_TIMEOUT_MS, beta: plan.beta })
    } catch (error) {
      return failure("findSimilar", error, ctx.abort, key)
    }

    const notes = note ? [note] : []
    const results = response.results
    if (results.length === 0) {
      return {
        status: "empty",
        text: [`No similar pages found for "${url}".`, ...notes.map((n) => `Note: ${n}`)].join("\n"),
        details: resultDetails(response, {}),
      }
    }

    return {
      text: formatResults(`Pages similar to ${url} (${results.length} results)`, notes, response),
      details: resultDetails(response, { dynamicHighlights: plan.beta !== undefined }),
    }
  },
} satisfies ToolSpec)

// ---------------------------------------------------------------------------
// exa_research — /search type "deep-reasoning" with grounded synthesis
// ---------------------------------------------------------------------------

function formatSynthesis(content: ExaSynthesisOutput["content"]): string[] {
  if (typeof content === "string") return [content]
  return ["```json", JSON.stringify(content, null, 2), "```"]
}

export const research = exaMetered({
  description:
    "Opt-in deep research: one Exa /search call with type 'deep-reasoning' ($15/1k requests, 12–40s). " +
    "Exa plans multiple searches, inspects and refines the evidence, then returns a synthesized text answer " +
    "with field-level grounding (citations + Exa-reported confidence) and the selected source pages with " +
    "highlights. Call only when the user or parent explicitly asks for Exa deep research.",
  async execute(args, ctx: ToolContext) {
    const key = apiKey()
    if (!key) return MISSING_KEY

    const query = requireText(args.query, "query")
    if (invalid(query)) return query.error

    const additionalQueries = optionalStringArray(args.additionalQueries, "additionalQueries")
    if (invalid(additionalQueries)) return additionalQueries.error
    if (additionalQueries && additionalQueries.length > MAX_ADDITIONAL_QUERIES) {
      return `ERROR: additionalQueries accepts at most ${MAX_ADDITIONAL_QUERIES} entries.`
    }

    const { numResults, note } = resultCount(args.numResults)
    const systemPrompt = optionalText(args.systemPrompt)

    const body: Record<string, unknown> = {
      query,
      type: RESEARCH_TYPE,
      numResults,
      // outputSchema triggers synthesis; without it /search returns pages only.
      outputSchema: { type: "text" },
      contents: { highlights: { query } },
    }
    if (systemPrompt) body.systemPrompt = systemPrompt
    if (additionalQueries && additionalQueries.length > 0) body.additionalQueries = additionalQueries

    let response: ExaResponse
    try {
      response = await exaPost("/search", body, {
        key,
        signal: ctx.abort,
        keep: ctx.keep,
        timeoutMs: RESEARCH_TIMEOUT_MS,
        retries: RESEARCH_RETRIES,
      })
    } catch (error) {
      return failure("deep research", error, ctx.abort, key)
    }

    const results = response.results
    const output = response.output
    const lines: string[] = []
    lines.push(`## Exa Deep Research (${RESEARCH_TYPE})`)
    const cost = costLine(response)
    if (cost) lines.push(`(${cost})`)
    if (note) lines.push(`Note: ${note}`)
    lines.push("")

    if (output) {
      lines.push(...formatSynthesis(output.content))
      lines.push("")
      lines.push("### Grounding (Exa field-level citations; confidence is Exa-reported)")
      if (output.grounding.length === 0) {
        lines.push("Exa returned no grounding entries for this output; treat the synthesis as unsupported.")
      }
      for (const g of output.grounding) {
        const cites = g.citations.map((c) => `${c.title || "(no title)"} <${c.url}>`).join("; ")
        lines.push(`- \`${g.field}\` — confidence ${g.confidence}: ${cites || "no citations"}`)
      }
    } else {
      lines.push("Exa returned no synthesized output for this request; the selected pages below are the only evidence.")
    }
    lines.push("")

    lines.push(`### Selected sources (${results.length})`)
    lines.push("")
    if (results.length === 0) lines.push("Exa selected no source pages.")
    results.forEach((r, index) => {
      lines.push(`${index + 1}. **${r.title || "(no title)"}**`)
      lines.push(
        `   URL: ${r.url}` +
          (r.publishedDate ? ` | Published: ${r.publishedDate.split("T")[0]}` : "") +
          (r.author ? ` | Author: ${r.author}` : ""),
      )
      for (const h of r.highlights ?? []) lines.push(`   > ${h}`)
      lines.push("")
    })

    return {
      text: lines.join("\n"),
      details: resultDetails(response, {
        type: RESEARCH_TYPE,
        synthesized: output !== undefined,
        grounding: output?.grounding.length ?? 0,
        citations: [...new Set((output?.grounding ?? []).flatMap((g) => g.citations.map((c) => c.url)))],
      }),
    }
  },
} satisfies ToolSpec)
