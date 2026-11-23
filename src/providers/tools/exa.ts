/**
 * Exa search, content extraction, similarity, and deep research tools.
 *
 * Exa is the retrieval layer of the Dig search group: it finds documents,
 * extracts page content, and (opt-in) runs a grounded deep search.
 * Perplexity remains the synthesis layer for question answering.
 *
 * Requires: EXA_API_KEY env var (https://dashboard.exa.ai)
 * Optional: EXA_BASE_URL env var (default https://api.exa.ai; https://api.eu.exa.ai for EU keys)
 *
 * API reference: https://exa.ai/docs/reference/search (Exa 3.0 / OpenAPI 2.0.0)
 * Pricing: /search lite $4/1k, auto $7/1k (includes text + highlights for the first
 * 10 results; +$1/1k results above 10; AI summaries +$1/1k pages); deep-lite and deep
 * $12/1k, legacy deep-reasoning $15/1k; /contents $1/1k pages per content type
 * (text, highlights, summary). Legacy search modes: fast, instant, deep-reasoning.
 *
 * Exports four tools:
 *   exa_search     — /search with Exa 3.0 modes (auto, lite, deep-lite, deep) and legacy modes (fast, instant, deep-reasoning)
 *   exa_contents   — /contents with per-URL fetch status reporting and optional highlights
 *   exa_similar    — /findSimilar (deprecated upstream, still served)
 *   exa_research   — /search deep mode (default "deep", optional "deep-lite" or legacy "deep-reasoning") with a synthesized, field-grounded answer
 *
 * The retired /research endpoint (HTTP 410 RESEARCH_RETIRED since 2026-04-01) and its
 * exa-research-* model tiers are gone; the deprecated `livecrawl` freshness knob is replaced
 * by `maxAgeHours`; deprecated `highlights.numSentences` is replaced by `maxCharacters`.
 */
import { requestJson } from "../http.js"
import { metered, setOutsideChat } from "../outcome.js"
import { knownSecrets, redactText } from "../secrets.js"
import type { KeepRaw, ToolContext, ToolSpec } from "../types.js"

const DEFAULT_EXA_BASE = "https://api.exa.ai"
const MISSING_KEY = `ERROR: EXA_API_KEY is not set in Dig's keys.env. Get a key at https://dashboard.exa.ai. ${setOutsideChat()}`

/** Documented Exa-Beta header value for Dynamic Highlights; sent only when the caller opts in. */
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
 * deep is documented at ~4–15s and legacy deep-reasoning at 12–40s; this is a provider-latency
 * envelope with headroom for queueing, not a "slow call" cutoff. The research call is never retried (see exaPost).
 */
const RESEARCH_TIMEOUT_MS = 180_000

/**
 * Exa documents 429 and 503 as "the request was not processed; retry with backoff".
 * Other statuses are not retried, and requestJson never repeats a request that got no
 * response (including its own timeout). The paid exa_research call, and exa_search in any
 * deep mode, also sets retries to 0: it must never be issued twice.
 */
const EXA_RETRY_STATUSES = [429, 503] as const
const RESEARCH_RETRIES = 0

const SEARCH_TYPES = ["instant", "fast", "lite", "auto", "deep-lite", "deep", "deep-reasoning"] as const
type SearchType = (typeof SEARCH_TYPES)[number]
const RESEARCH_MODES = ["deep", "deep-lite", "deep-reasoning"] as const
type ResearchMode = (typeof RESEARCH_MODES)[number]
const RESEARCH_TYPE: ResearchMode = "deep"

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
  entities?: Record<string, unknown>[]
  image?: string
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
    image: optionalString(record.image),
    entities: Array.isArray(record.entities) ? record.entities.filter((entry): entry is Record<string, unknown> => asRecord(entry) !== null) : undefined,
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

const ALLOWED_EXA_HOSTS = new Set(["api.exa.ai", "api.eu.exa.ai"])

/** Read per request so an EXA_BASE_URL reloaded from keys.env after startup applies. */
function exaBaseUrl(): string | Invalid {
  const raw = process.env.EXA_BASE_URL?.trim()
  if (!raw) return DEFAULT_EXA_BASE
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { error: "ERROR: EXA_BASE_URL must be https://api.exa.ai or https://api.eu.exa.ai." }
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, "")
  if (
    parsed.protocol !== "https:" ||
    !ALLOWED_EXA_HOSTS.has(parsed.hostname.toLowerCase()) ||
    parsed.port ||
    cleanPath !== "" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return { error: "ERROR: EXA_BASE_URL must be https://api.exa.ai or https://api.eu.exa.ai (plain https:// origin with no port, path, credentials, query, or fragment)." }
  }
  return `https://${parsed.hostname.toLowerCase()}`
}

type ExaPath = "/search" | "/contents" | "/findSimilar"

async function exaPost(
  path: ExaPath,
  body: Record<string, unknown>,
  options: { baseUrl: string; key: string; signal: AbortSignal; keep: KeepRaw; timeoutMs: number; retries?: number; beta?: string },
): Promise<ExaResponse> {
  const headers: Record<string, string> = {
    "x-api-key": options.key,
    "Content-Type": "application/json",
    Accept: "application/json",
  }
  if (options.beta) headers["Exa-Beta"] = options.beta

  const response = await requestJson({
    url: `${options.baseUrl}${path}`,
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    retryStatuses: EXA_RETRY_STATUSES,
    provider: "Exa",
    keep: options.keep,
    label: path,
  }).catch((error: unknown) => {
    if (options.signal.aborted) throw error
    throw new ExaUnansweredError(error instanceof Error ? error.message : "Unknown error")
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

/** No complete response arrived (a transport failure, or a body cut off): Exa may still have received and charged the request. */
class ExaUnansweredError extends Error {}
const UNANSWERED_COST = "Exa may have received and charged this request, but no complete response arrived; its cost is unknown."

/** Provider bodies arrive redacted (requestJson); a transport error's message does not, so it is redacted here. */
function failure(operation: string, error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return `ERROR: Exa ${operation} canceled before completion; not a provider failure.`
  const message = error instanceof Error ? error.message : "Unknown error"
  return `ERROR: Exa ${operation} failed: ${redactText(message, knownSecrets())}${error instanceof ExaUnansweredError ? `. ${UNANSWERED_COST}` : ""}`
}

// ---------------------------------------------------------------------------
// Argument normalization (runtime checks behind the registration schema, which the server enforces)
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

function userLocation(value: unknown): string | undefined | Invalid {
  if (value === undefined || value === null) return undefined
  const code = typeof value === "string" ? value.trim() : ""
  if (!/^[A-Za-z]{2}$/.test(code)) {
    return { error: "ERROR: userLocation must be a 2-letter ISO-3166-1 alpha-2 country code (e.g. US)." }
  }
  return code.toUpperCase()
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
  if (r.entities?.length) lines.push(`${indent}Structured entities: ${JSON.stringify(r.entities)}`)
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
  snapshotAsOf?: string
  summary?: boolean
  maxAgeHours?: number
}

interface ContentsPlan {
  contents?: Record<string, unknown>
  beta?: string
}

function contentsPlan(args: ContentsArgs, textCharacters: number, summaryQuery?: string): ContentsPlan | Invalid {
  if (args.snapshotAsOf !== undefined && args.contents === false) return { error: "ERROR: snapshotAsOf requires contents." }
  if (args.contents === false) return {}
  const highlights = highlightPlan(args)
  if (invalid(highlights)) return highlights
  const age = maxAgeHours(args.maxAgeHours)
  if (invalid(age)) return age

  const contents: Record<string, unknown> = {
    ...(args.dynamicHighlights === true ? {} : { text: { maxCharacters: textCharacters } }),
    highlights: highlights.highlights,
  }
  if (args.summary === true) contents.summary = summaryQuery ? { query: summaryQuery } : {}
  if (age !== undefined) contents.maxAgeHours = age
  const snapshot = snapshotTime(args.snapshotAsOf)
  if (invalid(snapshot)) return snapshot
  if (snapshot !== undefined) {
    if (args.maxAgeHours !== undefined) return { error: "ERROR: snapshotAsOf cannot be combined with maxAgeHours." }
    contents.snapshotAsOf = snapshot
  }
  return { contents, ...(highlights.beta ? { beta: highlights.beta } : {}) }
}

function snapshotTime(value: unknown): string | undefined | Invalid {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) || !Number.isFinite(Date.parse(value))) return { error: "ERROR: snapshotAsOf must be an ISO date or date-time with timezone." }
  const [year, month, day] = value.slice(0, 10).split("-").map(Number)
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== value.slice(0, 10)) return { error: "ERROR: snapshotAsOf must name a valid calendar date." }
  if (Date.parse(value) > Date.now()) return { error: "ERROR: snapshotAsOf must not be in the future." }
  return value
}

// ---------------------------------------------------------------------------
// exa_search — /search with the current search modes
// ---------------------------------------------------------------------------

export const search = exaMetered({
  description:
    "Search the web with Exa and get ranked documents with page text and query-relevant highlights. " +
    "Search modes: 'auto' (default, $7/1k), 'lite' ($4/1k low-cost cached retrieval), legacy 'fast'/'instant', and Deep modes 'deep-lite'/'deep' ($12/1k) " +
    "or legacy 'deep-reasoning' ($15/1k) for iterative research over selected pages. " +
    "Filters: domains/paths (wildcards like '*.substack.com'), publication dates, category, userLocation (ISO country code). " +
    "With dynamicHighlights: true, page text is omitted for token savings. Use exa_research when a synthesized, source-grounded answer is explicitly requested.",
  async execute(args, ctx: ToolContext) {
    const key = apiKey()
    if (!key) return MISSING_KEY
    const baseUrl = exaBaseUrl()
    if (invalid(baseUrl)) return baseUrl.error
    const query = requireText(args.query, "query")
    if (invalid(query)) return query.error

    const type: SearchType = args.type ?? "auto"
    if (!SEARCH_TYPES.includes(type)) {
      return `ERROR: type must be one of ${SEARCH_TYPES.join(", ")}.`
    }

    if (type === "lite" && (args.maxAgeHours !== undefined || args.summary !== undefined)) return "ERROR: lite is cache-only and does not accept maxAgeHours or summary; use auto."
    if (args.snapshotAsOf !== undefined && (args.category !== undefined || type === "deep" || type === "deep-reasoning")) return "ERROR: Snapshot does not support category, deep or deep-reasoning."
    const location = userLocation(args.userLocation)
    if (invalid(location)) return location.error
    const includeDomains = optionalStringArray(args.includeDomains, "includeDomains")
    if (invalid(includeDomains)) return includeDomains.error
    const excludeDomains = optionalStringArray(args.excludeDomains, "excludeDomains")
    if (invalid(excludeDomains)) return excludeDomains.error

    const { numResults, note } = resultCount(args.numResults)
    const plan = contentsPlan({ ...args, query }, SEARCH_TEXT_CHARACTERS, query)
    if (invalid(plan)) return plan.error

    const body: Record<string, unknown> = { query, numResults, type }
    if (args.category) body.category = args.category
    if (location) body.userLocation = location
    if (includeDomains) body.includeDomains = includeDomains
    if (excludeDomains) body.excludeDomains = excludeDomains
    if (args.startPublishedDate) body.startPublishedDate = args.startPublishedDate
    if (args.endPublishedDate) body.endPublishedDate = args.endPublishedDate
    if (plan.contents) body.contents = plan.contents

    let response: ExaResponse
    try {
      response = await exaPost("/search", body, { baseUrl, key, signal: ctx.abort, keep: ctx.keep, timeoutMs: SEARCH_TIMEOUT_MS, beta: plan.beta, ...(type.startsWith("deep") ? { retries: RESEARCH_RETRIES } : {}) })
    } catch (error) {
      return failure("search", error, ctx.abort)
    }

    const notes = note ? [note] : []
    if (args.snapshotAsOf) notes.push(`Snapshot cutoff ${args.snapshotAsOf}: stored content only; current retrieval signals still rank candidate URLs. Availability depends on the Exa plan and stored coverage.`)
    if (type === "lite") notes.push("Lite uses cached page content only; missing cached pages may be omitted.")
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
    "Extract clean markdown text and optional highlights from specific URLs via Exa's cache " +
    "with live-fetch fallback. Reports per-URL fetch status so a failed page is never silently dropped. " +
    "Bills $1/1k pages per content type (text, highlights, summary); set highlights: false for text-only at half cost.",
  async execute(args, ctx: ToolContext) {
    const key = apiKey()
    if (!key) return MISSING_KEY
    const baseUrl = exaBaseUrl()
    if (invalid(baseUrl)) return baseUrl.error
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
    if (args.highlights !== undefined && typeof args.highlights !== "boolean") {
      return "ERROR: highlights must be a boolean."
    }
    const wantHighlights = args.highlights !== false
    if (!wantHighlights && (args.dynamicHighlights === true || (args.highlightMaxCharacters !== undefined && args.highlightMaxCharacters !== null))) {
      return "ERROR: highlights: false cannot be combined with dynamicHighlights or highlightMaxCharacters."
    }
    const highlights = wantHighlights ? highlightPlan(args) : undefined
    if (invalid(highlights)) return highlights.error
    const age = maxAgeHours(args.maxAgeHours)
    if (invalid(age)) return age.error

    const snapshot = snapshotTime(args.snapshotAsOf)
    if (invalid(snapshot)) return snapshot.error
    if (snapshot !== undefined && args.maxAgeHours !== undefined) return "ERROR: snapshotAsOf cannot be combined with maxAgeHours."
    if (snapshot !== undefined) notes.push(`Snapshot cutoff ${snapshot}: newest stored content at or before this date; coverage and plan limits apply.`)
    const focus = optionalText(args.query)
    const body: Record<string, unknown> = {
      urls: requested,
      text: { maxCharacters: textCharacters ?? CONTENTS_TEXT_CHARACTERS },
    }
    if (highlights) body.highlights = highlights.highlights
    if (args.summary === true) body.summary = focus ? { query: focus } : {}
    if (age !== undefined) body.maxAgeHours = age
    if (snapshot !== undefined) body.snapshotAsOf = snapshot

    let response: ExaResponse
    try {
      response = await exaPost("/contents", body, { baseUrl, key, signal: ctx.abort, keep: ctx.keep, timeoutMs: SEARCH_TIMEOUT_MS, beta: highlights?.beta })
    } catch (error) {
      return failure("contents extraction", error, ctx.abort)
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
        lines.push(redactText(`- ${f.id} — ${tag}${http}`, knownSecrets()))
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
      if (r.entities?.length) lines.push(`Structured entities: ${JSON.stringify(r.entities)}`, "")
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
      status: results.length === 0 ? "empty" : failures.length || unaccounted.length ? "partial" : "success",
      text: lines.join("\n"),
      details: resultDetails(response, {
        requested: requested.length,
        failed: failures.map((f) => redactText(f.id, knownSecrets())),
        unaccounted,
        dynamicHighlights: highlights?.beta !== undefined,
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
    const baseUrl = exaBaseUrl()
    if (invalid(baseUrl)) return baseUrl.error

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
      response = await exaPost("/findSimilar", body, { baseUrl, key, signal: ctx.abort, keep: ctx.keep, timeoutMs: SEARCH_TIMEOUT_MS, beta: plan.beta })
    } catch (error) {
      return failure("findSimilar", error, ctx.abort)
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
// exa_research — /search deep mode (default "deep") with grounded synthesis
// ---------------------------------------------------------------------------

function formatSynthesis(content: ExaSynthesisOutput["content"]): string[] {
  if (typeof content === "string") return [content]
  return ["```json", JSON.stringify(content, null, 2), "```"]
}

export const research = exaMetered({
  description:
    "Opt-in deep research: one Exa /search call (default 'deep' $12/1k, 4–15s; optional 'deep-lite' or legacy 'deep-reasoning'). " +
    "Exa plans multiple searches, inspects and refines the evidence, then returns a synthesized text answer " +
    "with field-level grounding (citations + Exa-reported confidence) and the selected source pages with " +
    "highlights. Call only when the user or parent explicitly asks for Exa deep research.",
  async execute(args, ctx: ToolContext) {
    const key = apiKey()
    if (!key) return MISSING_KEY
    const baseUrl = exaBaseUrl()
    if (invalid(baseUrl)) return baseUrl.error

    const query = requireText(args.query, "query")
    if (invalid(query)) return query.error

    const rawMode = args.mode ?? RESEARCH_TYPE
    if (typeof rawMode !== "string" || !(RESEARCH_MODES as readonly string[]).includes(rawMode)) {
      return `ERROR: mode must be one of ${RESEARCH_MODES.join(", ")}.`
    }
    const mode = rawMode as ResearchMode

    const additionalQueries = optionalStringArray(args.additionalQueries, "additionalQueries")
    if (invalid(additionalQueries)) return additionalQueries.error
    if (additionalQueries && additionalQueries.length > MAX_ADDITIONAL_QUERIES) {
      return `ERROR: additionalQueries accepts at most ${MAX_ADDITIONAL_QUERIES} entries.`
    }

    const { numResults, note } = resultCount(args.numResults)
    const systemPrompt = optionalText(args.systemPrompt)

    const body: Record<string, unknown> = {
      query,
      type: mode,
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
        baseUrl,
        key,
        signal: ctx.abort,
        keep: ctx.keep,
        timeoutMs: RESEARCH_TIMEOUT_MS,
        retries: RESEARCH_RETRIES,
      })
    } catch (error) {
      return failure("deep research", error, ctx.abort)
    }

    const results = response.results
    const output = response.output
    const lines: string[] = []
    lines.push(`## Exa Deep Research (${mode})`)
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
      ...(!output && results.length === 0 ? { status: "empty" as const } : {}),
      text: lines.join("\n"),
      details: resultDetails(response, {
        type: mode,
        synthesized: output !== undefined,
        grounding: output?.grounding.length ?? 0,
        citations: [...new Set((output?.grounding ?? []).flatMap((g) => g.citations.map((c) => c.url)))],
      }),
    }
  },
} satisfies ToolSpec)
