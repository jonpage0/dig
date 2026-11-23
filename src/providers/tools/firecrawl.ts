/**
 * Firecrawl web scraping and site mapping tools (v2 REST API).
 *
 * Requires: FIRECRAWL_API_KEY in Dig's keys.env (https://www.firecrawl.dev/app/api-keys)
 *
 * API reference: https://docs.firecrawl.dev/api-reference/endpoint/scrape and /map
 *   - POST https://api.firecrawl.dev/v2/scrape — single public URL to clean Markdown
 *   - POST https://api.firecrawl.dev/v2/map    — discover URLs on a site with optional relevance filter
 *
 * Bounded surface: single-page scrape and URL discovery only (no unbounded multi-page crawl).
 * Paid calls never retry (`retries: 0`, `retryTransport: false`) and meter credits honestly:
 * recorded from `creditsUsed` (or `data.metadata.creditsUsed`) when reported, else unknown (`null`), never 0.
 */
import { USER_AGENT } from "../../version.mjs"
import { requestJson } from "../http.js"
import { failed, metered, outcome, setOutsideChat } from "../outcome.js"
import { knownSecrets, redactText } from "../secrets.js"
import type { KeepRaw, ToolContext, ToolSpec } from "../types.js"

const FIRECRAWL_BASE = "https://api.firecrawl.dev"
const FIRECRAWL_COST_UNIT = "Firecrawl credits"
const MISSING_KEY = `ERROR: FIRECRAWL_API_KEY is not set in Dig's keys.env. Get a key at https://www.firecrawl.dev/app/api-keys. ${setOutsideChat()}`
const UNANSWERED_COST =
  "Firecrawl may have received and charged this request, but no complete response arrived; its cost is unknown."

const CLIENT_TIMEOUT_MS = 70_000
const PROVIDER_TIMEOUT_MS = 60_000
const MAX_WAIT_FOR_MS = 10_000
const DEFAULT_MAX_CHARACTERS = 40_000
const MIN_MAX_CHARACTERS = 500
const MAX_MAX_CHARACTERS = 100_000
const DEFAULT_MAP_LIMIT = 50
const MAX_MAP_LIMIT = 200

const SCRAPE_FORMATS = ["markdown", "html", "links"] as const
type ScrapeFormat = (typeof SCRAPE_FORMATS)[number]

const SITEMAP_MODES = ["include", "skip", "only"] as const
type SitemapMode = (typeof SITEMAP_MODES)[number]

// ---------------------------------------------------------------------------
// Helpers & validation
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

/** Firecrawl credits reported on a response body (`creditsUsed` or `data.metadata.creditsUsed`); null when omitted. */
export function reportedFirecrawlCredits(body: unknown): number | null {
  const record = asRecord(body)
  if (!record) return null
  const top = optionalNumber(record.creditsUsed)
  if (top !== undefined && top >= 0) return top
  const meta = asRecord(asRecord(record.data)?.metadata)
  const nested = optionalNumber(meta?.creditsUsed)
  if (nested !== undefined && nested >= 0) return nested
  return null
}

const firecrawlMetered = (spec: ToolSpec): ToolSpec =>
  metered(spec, FIRECRAWL_COST_UNIT, (body) => reportedFirecrawlCredits(body))

function apiKey(): string | null {
  return process.env.FIRECRAWL_API_KEY?.trim() || null
}

/** True when the four IPv4 octets fall in a private, loopback, link-local, CGNAT, multicast, or reserved range. */
function isBlockedIpv4(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT RFC 6598
  if (a === 169 && b === 254) return true // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // RFC 1918
  if (a === 192 && b === 168) return true // RFC 1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2 (RFC 5737)
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3 (RFC 5737)
  if (a >= 224) return true // multicast, reserved, broadcast
  return false
}

/** Parse an IPv6 literal (with optional trailing dotted-quad IPv4) into 8 16-bit hextets. */
function parseIpv6Hextets(raw: string): number[] | null {
  const ip = raw.toLowerCase().split("%")[0]
  if (!ip) return null
  const halves = ip.split("::")
  if (halves.length > 2) return null

  const parsePart = (part: string): number[] | null => {
    if (!part) return []
    const tokens = part.split(":")
    const out: number[] = []
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]
      if (tok.includes(".")) {
        if (i !== tokens.length - 1) return null
        const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tok)
        if (!m) return null
        const octets = m.slice(1).map(Number)
        if (octets.some((n) => n > 255)) return null
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null
        out.push(parseInt(tok, 16))
      }
    }
    return out
  }

  const left = parsePart(halves[0])
  if (!left) return null
  if (halves.length === 1) return left.length === 8 ? left : null
  const right = parsePart(halves[1])
  if (!right) return null
  const missing = 8 - (left.length + right.length)
  if (missing < 1) return null
  return [...left, ...new Array<number>(missing).fill(0), ...right]
}

/** Allow only public global unicast IPv6 (2000::/3), excluding documentation, Teredo, and 6to4 transition prefixes. */
function isBlockedIpv6(host: string): boolean {
  const h = parseIpv6Hextets(host)
  if (!h) return true
  if ((h[0] & 0xe000) !== 0x2000) return true // outside 2000::/3 (blocks ::, ::1, ::/8, ::ffff:0:0/96, 64:ff9b::/96, 100::/64, fc00::/7, fe80::/10, ff00::/8, etc.)
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true // 2001:db8::/32 documentation
  if (h[0] === 0x2001 && h[1] === 0x0000) return true // 2001::/32 Teredo
  if (h[0] === 0x2002) return true // 2002::/16 6to4 (can embed private IPv4)
  return false
}

/**
 * Validate a public http(s) URL before sending any paid request to Firecrawl.
 * Refuses non-http(s) schemes, embedded credentials, single-label hosts, localhost/internal domains,
 * and private, loopback, link-local, CGNAT, or reserved IPv4/IPv6 addresses.
 */
export function validatePublicHttpUrl(value: unknown): URL | { error: string } {
  const raw = typeof value === "string" ? value.trim() : ""
  if (!raw) return { error: "url is required." }
  if (!/^https?:\/\//i.test(raw)) {
    return { error: "url must begin with http:// or https://." }
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { error: "url is not a valid http(s) URL." }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "url must use http:// or https://." }
  }
  if (url.username || url.password) {
    return { error: "url must not contain embedded credentials." }
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/, "")
  if (!host) return { error: "url must include a hostname." }

  // Bracketed IPv6 literal (Node's URL keeps brackets around hostname for IPv6)
  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1)
    if (isBlockedIpv6(inner)) {
      return { error: `Refused private, loopback, or link-local target "${host}".` }
    }
    return url
  }

  // IPv4 literal (WHATWG URL normalizes decimal/octal/hex IPv4 into dotted-quad)
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number)
    if (octets.some((n) => n > 255)) return { error: `Invalid IPv4 address "${host}".` }
    if (isBlockedIpv4(octets[0], octets[1], octets[2])) {
      return { error: `Refused private, loopback, or link-local target "${host}".` }
    }
    return url
  }

  // Reject empty DNS labels (e.g. "a..b") and local / internal / metadata domain names and single-label hosts
  const labels = host.split(".")
  if (
    labels.length < 2 ||
    labels.some((l) => l.length === 0) ||
    host === "localhost" ||
    host === "metadata.goog" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".localdomain") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa") ||
    host.endsWith(".metadata.goog")
  ) {
    return { error: `Refused private, loopback, or local target "${host}".` }
  }

  return url
}

// ---------------------------------------------------------------------------
// Request plumbing (zero retries on paid calls)
// ---------------------------------------------------------------------------

class FirecrawlUnansweredError extends Error {}

async function firecrawlPost(
  path: "/v2/scrape" | "/v2/map",
  body: Record<string, unknown>,
  options: { key: string; signal: AbortSignal; keep: KeepRaw },
): Promise<Record<string, unknown>> {
  const response = await requestJson({
    url: `${FIRECRAWL_BASE}${path}`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body,
    redirect: "error",
    signal: options.signal,
    timeoutMs: CLIENT_TIMEOUT_MS,
    retries: 0,
    provider: "Firecrawl",
    keep: options.keep,
    label: path,
  }).catch((error: unknown) => {
    if (options.signal.aborted) throw error
    throw new FirecrawlUnansweredError(error instanceof Error ? error.message : "Unknown error")
  })

  const payload = asRecord(response.payload)
  const envelopeError = optionalString(payload?.error)
  if (response.status < 200 || response.status >= 300 || payload?.success === false || envelopeError !== undefined) {
    const detail = envelopeError ?? (typeof response.payload === "string" && response.payload.trim() ? response.payload.trim().slice(0, 240) : `HTTP ${response.status}`)
    const reqId = response.requestId ? ` [request ${response.requestId}]` : ""
    throw new Error(`Firecrawl ${path} returned HTTP ${response.status}: ${detail}${reqId}`)
  }
  if (!payload) throw new Error(`Firecrawl ${path} returned an unexpected non-object JSON body`)
  return payload
}

function failure(operation: string, error: unknown, signal: AbortSignal): ReturnType<typeof failed> {
  if (signal.aborted) return failed(`Firecrawl ${operation} canceled before completion; not a provider failure.`)
  const message = error instanceof Error ? error.message : "Unknown error"
  return failed(
    `Firecrawl ${operation} failed: ${redactText(message, knownSecrets())}${error instanceof FirecrawlUnansweredError ? `. ${UNANSWERED_COST}` : ""}`,
  )
}

function formatCreditsNote(credits: number | null): string {
  if (credits === null) return "credits not reported (cost unknown)"
  return `${credits} Firecrawl ${credits === 1 ? "credit" : "credits"}`
}

// ---------------------------------------------------------------------------
// firecrawl_scrape — POST /v2/scrape
// ---------------------------------------------------------------------------

export const scrape = firecrawlMetered({
  description:
    "Scrape a single public web page into clean Markdown (and optional HTML or page links) via Firecrawl v2. " +
    "Handles JavaScript-rendered pages, strips navigation chrome by default, and supports bounded render waits (up to 10s). " +
    "Single URL only; never retries paid requests. Bills Firecrawl credits per request.",
  async execute(args, ctx: ToolContext) {
    const key = apiKey()
    if (!key) return failed(MISSING_KEY)

    const target = validatePublicHttpUrl(args.url)
    if ("error" in target) return failed(target.error)

    let formats: ScrapeFormat[] = ["markdown"]
    if (args.formats !== undefined) {
      if (!Array.isArray(args.formats) || args.formats.length === 0) {
        return failed("formats must be a non-empty array of 'markdown', 'html', or 'links'.")
      }
      const unique: ScrapeFormat[] = []
      for (const item of args.formats) {
        if (typeof item !== "string" || !(SCRAPE_FORMATS as readonly string[]).includes(item)) {
          return failed(`formats entries must be one of: ${SCRAPE_FORMATS.join(", ")}.`)
        }
        if (!unique.includes(item as ScrapeFormat)) unique.push(item as ScrapeFormat)
      }
      formats = unique
    }

    const onlyMainContent = args.onlyMainContent === undefined ? true : Boolean(args.onlyMainContent)

    let maxAge: number | undefined
    if (args.maxAge !== undefined) {
      if (typeof args.maxAge !== "number" || !Number.isInteger(args.maxAge) || args.maxAge < 0) {
        return failed("maxAge must be a non-negative integer (milliseconds).")
      }
      maxAge = args.maxAge
    }

    let waitFor: number | undefined
    if (args.waitFor !== undefined) {
      if (typeof args.waitFor !== "number" || !Number.isInteger(args.waitFor) || args.waitFor < 0 || args.waitFor > MAX_WAIT_FOR_MS) {
        return failed(`waitFor must be an integer between 0 and ${MAX_WAIT_FOR_MS} milliseconds.`)
      }
      waitFor = args.waitFor
    }

    let maxCharacters = DEFAULT_MAX_CHARACTERS
    if (args.maxCharacters !== undefined) {
      if (
        typeof args.maxCharacters !== "number" ||
        !Number.isInteger(args.maxCharacters) ||
        args.maxCharacters < MIN_MAX_CHARACTERS ||
        args.maxCharacters > MAX_MAX_CHARACTERS
      ) {
        return failed(`maxCharacters must be an integer between ${MIN_MAX_CHARACTERS} and ${MAX_MAX_CHARACTERS}.`)
      }
      maxCharacters = args.maxCharacters
    }

    const body: Record<string, unknown> = {
      url: target.href,
      formats,
      onlyMainContent,
      timeout: PROVIDER_TIMEOUT_MS,
    }
    if (maxAge !== undefined) body.maxAge = maxAge
    if (waitFor !== undefined) body.waitFor = waitFor

    let payload: Record<string, unknown>
    try {
      payload = await firecrawlPost("/v2/scrape", body, { key, signal: ctx.abort, keep: ctx.keep })
    } catch (error) {
      return failure("scrape", error, ctx.abort)
    }

    const data = asRecord(payload.data)
    if (!data) return failed("Firecrawl /v2/scrape returned an unexpected payload: missing data object.")

    const metadata = asRecord(data.metadata)
    const creditsUsed = reportedFirecrawlCredits(payload)
    const title = optionalString(metadata?.title)?.trim()
    const description = optionalString(metadata?.description)?.trim()
    const sourceURL = optionalString(metadata?.sourceURL) ?? target.href
    const resolvedUrl = optionalString(metadata?.url) ?? sourceURL
    const statusCode = optionalNumber(metadata?.statusCode)
    const cacheState = optionalString(metadata?.cacheState)
    const pageError = optionalString(metadata?.error)?.trim()

    const markdown = optionalString(data.markdown)?.trim() ?? ""
    const html = optionalString(data.html)?.trim() ?? ""
    const links = Array.isArray(data.links)
      ? data.links.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : []

    const details: Record<string, unknown> = {
      provider: "firecrawl",
      url: sourceURL,
      ...(resolvedUrl !== sourceURL ? { resolvedUrl } : {}),
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(cacheState ? { cacheState } : {}),
      creditsUsed,
      formats,
    }

    const hasRequestedContent =
      (formats.includes("markdown") && Boolean(markdown)) ||
      (formats.includes("html") && Boolean(html)) ||
      (formats.includes("links") && links.length > 0)

    if (!hasRequestedContent) {
      if (pageError) {
        return failed(`Firecrawl scrape returned no content for ${target.href}: ${redactText(pageError, knownSecrets())}`)
      }
      return outcome(
        "empty",
        `Firecrawl scraped ${target.href} (${formatCreditsNote(creditsUsed)}${statusCode !== undefined ? `; target HTTP ${statusCode}` : ""}) but returned no readable content.`,
        details,
      )
    }

    const header: string[] = [`# ${title || resolvedUrl}`]
    const metaParts: string[] = [`URL: ${resolvedUrl}`]
    if (resolvedUrl !== sourceURL) metaParts.push(`Requested: ${sourceURL}`)
    if (statusCode !== undefined) metaParts.push(`Target HTTP: ${statusCode}`)
    if (cacheState) metaParts.push(`Cache: ${cacheState}`)
    metaParts.push(`Usage: ${formatCreditsNote(creditsUsed)}`)
    header.push(metaParts.join(" | "))
    if (description) header.push(`Description: ${description}`)
    if (pageError) header.push(`Warning from target page: ${redactText(pageError, knownSecrets())}`)
    header.push("")

    const sections: string[] = []
    let truncated = false
    let remaining = maxCharacters

    const pushBudgeted = (heading: string | null, content: string): void => {
      if (!content) return
      if (remaining <= 0) {
        truncated = true
        return
      }
      const slice = content.length > remaining ? content.slice(0, remaining) : content
      if (content.length > remaining) truncated = true
      remaining -= slice.length
      if (heading) sections.push(heading, "")
      sections.push(slice)
      if (content.length > slice.length) {
        sections.push(`\n[Truncated at ${maxCharacters} characters; full response is in the retained original when keep_raw is enabled.]`)
      }
      sections.push("")
    }

    if (formats.includes("markdown") && markdown) {
      pushBudgeted(formats.length > 1 ? "## Markdown" : null, markdown)
    }
    if (formats.includes("html") && html) {
      pushBudgeted("## HTML", html)
    }
    if (formats.includes("links") && links.length > 0) {
      const shown = links.slice(0, MAX_MAP_LIMIT)
      const listText = shown.map((link) => `- ${link}`).join("\n") +
        (links.length > shown.length ? `\n(${links.length - shown.length} more links in retained original)` : "")
      pushBudgeted(`## Links (${links.length})`, listText)
    }

    const totalCharacters = markdown.length + html.length
    return outcome("success", `${header.join("\n")}\n${sections.join("\n").trim()}`, {
      ...details,
      totalCharacters,
      truncated,
      ...(links.length > 0 ? { linksCount: links.length } : {}),
    })
  },
} satisfies ToolSpec)

// ---------------------------------------------------------------------------
// firecrawl_map — POST /v2/map
// ---------------------------------------------------------------------------

interface MapEntry {
  url: string
  title?: string
  description?: string
}

function parseMapLink(entry: unknown): MapEntry | null {
  if (typeof entry === "string" && entry.trim()) return { url: entry.trim() }
  const record = asRecord(entry)
  const url = optionalString(record?.url)?.trim()
  if (!url) return null
  return {
    url,
    title: optionalString(record?.title)?.trim() || undefined,
    description: optionalString(record?.description)?.trim() || undefined,
  }
}

export const map = firecrawlMetered({
  description:
    "Discover URLs on a public website via Firecrawl v2 /v2/map with optional relevance search filtering. " +
    "Returns up to 200 discovered URLs (default 50) without scraping page bodies, so you can pick specific pages for firecrawl_scrape. " +
    "Never retries paid requests. Bills Firecrawl credits per request.",
  async execute(args, ctx: ToolContext) {
    const key = apiKey()
    if (!key) return failed(MISSING_KEY)

    const target = validatePublicHttpUrl(args.url)
    if ("error" in target) return failed(target.error)

    const search = typeof args.search === "string" ? args.search.trim() : ""

    let limit = DEFAULT_MAP_LIMIT
    if (args.limit !== undefined) {
      if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_MAP_LIMIT) {
        return failed(`limit must be an integer between 1 and ${MAX_MAP_LIMIT}.`)
      }
      limit = args.limit
    }

    let sitemap: SitemapMode | undefined
    if (args.sitemap !== undefined) {
      if (typeof args.sitemap !== "string" || !(SITEMAP_MODES as readonly string[]).includes(args.sitemap)) {
        return failed(`sitemap must be one of: ${SITEMAP_MODES.join(", ")}.`)
      }
      sitemap = args.sitemap as SitemapMode
    }

    const body: Record<string, unknown> = {
      url: target.href,
      limit,
      timeout: PROVIDER_TIMEOUT_MS,
    }
    if (search) body.search = search
    if (args.includeSubdomains !== undefined) body.includeSubdomains = Boolean(args.includeSubdomains)
    if (sitemap) body.sitemap = sitemap

    let payload: Record<string, unknown>
    try {
      payload = await firecrawlPost("/v2/map", body, { key, signal: ctx.abort, keep: ctx.keep })
    } catch (error) {
      return failure("map", error, ctx.abort)
    }

    if (!Array.isArray(payload.links)) {
      return failed("Firecrawl /v2/map returned an unexpected payload: missing links array.")
    }

    const creditsUsed = reportedFirecrawlCredits(payload)
    const parsed = payload.links.map(parseMapLink).filter((item): item is MapEntry => item !== null)
    const shown = parsed.slice(0, limit)

    const details: Record<string, unknown> = {
      provider: "firecrawl",
      url: target.href,
      ...(search ? { search } : {}),
      count: shown.length,
      totalReturned: parsed.length,
      creditsUsed,
    }

    if (shown.length === 0) {
      return outcome(
        "empty",
        `Firecrawl map found no URLs for ${target.href}${search ? ` matching "${search}"` : ""} (${formatCreditsNote(creditsUsed)}).`,
        details,
      )
    }

    const lines: string[] = [
      `Firecrawl map for ${target.href}${search ? ` (filter: "${search}")` : ""}: ${shown.length} URL${shown.length === 1 ? "" : "s"} (${formatCreditsNote(creditsUsed)})`,
      "",
    ]
    for (let i = 0; i < shown.length; i++) {
      const item = shown[i]
      const suffix = item.title ? ` — ${item.title}` : ""
      lines.push(`${i + 1}. ${item.url}${suffix}`)
      if (item.description) {
        const desc = item.description.replace(/\s+/g, " ")
        lines.push(`   ${desc.length > 200 ? `${desc.slice(0, 200)}...` : desc}`)
      }
    }
    if (parsed.length > shown.length) {
      lines.push("", `Showing first ${shown.length} of ${parsed.length} returned URLs (capped at limit ${limit}).`)
    }

    return outcome("success", lines.join("\n"), details)
  },
} satisfies ToolSpec)
