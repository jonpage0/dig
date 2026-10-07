import { afterEach, beforeEach, describe, test } from "node:test"
import { expect } from "expect"
import { executeSource } from "../outcome.js"
import type { SourceToolResult, ToolContext } from "../types.js"
import { ask, reason, research, search } from "./perplexity.js"

const context: ToolContext = {
  sessionID: "perplexity-test", directory: "/tmp", worktree: "/tmp",
  abort: new AbortController().signal,
  keep: () => {},
}
const messages = [{ role: "user", content: "What changed?" }]
const sourceUrl = "https://example.com/article?version=2&lang=en#details"
const source = {
  id: 7, source: "web", title: "Primary record", url: sourceUrl,
  snippet: "The documented change.", date: "2026-09-01", last_updated: "2026-09-14",
}
function agentFixture(status = "completed") {
  return {
    id: "response-test", status, model: "provider/model",
    output: [
      { type: "search_results", results: [source] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "The change is documented[web:7]." }] },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cost: { currency: "USD", input_cost: 0.001, output_cost: 0.002, total_cost: 0.0082 } },
  }
}
/** Direct tool calls return text or an outcome; executeSource adds the call's finalized cost. */
const text = (result: SourceToolResult) => (typeof result === "string" ? result : result.text)

function installFetch(payload: unknown, status = 200) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  // Bun's fetch also carries the preconnect method; the fixture only replaces HTTP calls.
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify(payload), { status })
  }, { preconnect: globalThis.fetch.preconnect })
  return calls
}

describe("Perplexity Agent and Search contracts", () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.PERPLEXITY_API_KEY
  const originalTimeout = process.env.PERPLEXITY_TIMEOUT_MS
  beforeEach(() => { process.env.PERPLEXITY_API_KEY = "perplexity-test-secret" })
  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.PERPLEXITY_API_KEY
    else process.env.PERPLEXITY_API_KEY = originalKey
    if (originalTimeout === undefined) delete process.env.PERPLEXITY_TIMEOUT_MS
    else process.env.PERPLEXITY_TIMEOUT_MS = originalTimeout
  })

  test("uses each Agent preset and resolves noncontiguous provider citation IDs without renumbering", async () => {
    const calls = installFetch(agentFixture())
    for (const tool of [ask, reason, research]) {
      const output = await executeSource(tool, { messages, search_domain_filter: ["example.com"], search_recency_filter: "week" }, context)
      expect(output.details?.cost).toEqual([{ amount: 0.0082, unit: "USD" }])
      const result = output.text
      expect(result).toContain("documented[web:7]")
      expect(result).toContain("[web:7] (numeric marker [7]) Primary record")
      expect(result).toContain(sourceUrl)
      expect(result).toContain("Published: 2026-09-01")
      expect(result).toContain("Last updated: 2026-09-14")
      expect(result).not.toContain("[web:1]")
    }
    expect(calls.map((call) => call.body.preset)).toEqual(["low", "medium", "high"])
    expect(calls.every((call) => call.url.endsWith("/v1/agent"))).toBe(true)
    expect(calls[0].body.input).toEqual([{ type: "message", ...messages[0] }])
    expect(calls[0].body.tools).toEqual([{ type: "web_search", filters: { search_domain_filter: ["example.com"], search_recency_filter: "week" } }])
  })

  test("retains multiple answer parts, URL annotations and unresolved citation gaps", async () => {
    installFetch({ status: "completed", output: [{ type: "message", content: [
      { type: "output_text", text: "First part[99].", annotations: [{ type: "url_citation", url: sourceUrl, title: "Annotation" }] },
      { type: "output_text", text: "Second part." },
    ] }] })
    const result = text(await ask.execute({ messages }, context))
    expect(result).toContain("First part[99].\n\nSecond part.")
    expect(result).toContain(`URL citation: Annotation\nURL: ${sourceUrl}`)
    expect(result).toContain("no returned source ID resolves [99]")
    expect(result).not.toContain("[web:99]")
  })

  test("keeps incomplete, failed, empty and malformed responses distinct", async () => {
    installFetch(agentFixture("incomplete"))
    const partial = text(await research.execute({ messages }, context))
    expect(partial.startsWith("ERROR:")).toBe(true)
    expect(partial).toContain("partial evidence")
    expect(partial).toContain(sourceUrl)
    installFetch({ status: "failed", error: { message: "Quota exceeded" }, output: [] })
    expect(text(await ask.execute({ messages }, context))).toContain("status: failed — Quota exceeded")
    installFetch({ status: "completed", output: [] })
    expect(text(await ask.execute({ messages }, context))).toContain("no answer text")
    installFetch({ unexpected: [] })
    expect(text(await search.execute({ query: "term" }, context)).startsWith("ERROR:")).toBe(true)
    installFetch({ results: [] })
    const empty = await search.execute({ query: "term" }, context)
    expect(typeof empty === "string" ? undefined : empty.status).toBe("empty")
    expect(text(empty)).toContain("No search results")
  })

  test("a failed Agent result keeps the charge its response reported, and an unpriced response stays unknown", async () => {
    installFetch(agentFixture("incomplete"))
    const partial = await executeSource(research, { messages }, context)
    expect(partial.status).toBe("failed")
    expect(partial.details?.cost).toEqual([{ amount: 0.0082, unit: "USD" }])

    installFetch({ status: "completed", output: [] })
    const unpriced = await executeSource(ask, { messages }, context)
    expect(unpriced.status).toBe("failed")
    expect(unpriced.details?.cost).toBeNull()
    expect(unpriced.details?.knownCost).toBeUndefined()
  })

  test("returns combined multi-query results with full metadata using current Search filters", async () => {
    const calls = installFetch({ results: [source] })
    const filters = {
      search_domain_filter: ["example.com"], search_language_filter: ["en", "fr"], country: "US",
      search_recency_filter: "month", search_after_date_filter: "09/01/2026",
      search_before_date_filter: "09/15/2026", last_updated_after_filter: "09/10/2026",
      last_updated_before_filter: "09/16/2026",
    }
    const result = await search.execute({ query: ["first angle", "second angle"], ...filters, max_tokens_per_page: 4096 }, context)
    expect(calls[0].url).toBe("https://api.perplexity.ai/search")
    expect(calls[0].body).toEqual({ query: ["first angle", "second angle"], search_type: "web", max_results: 10, ...filters, max_tokens_per_page: 4096 })
    expect(result).toContain(sourceUrl)
    expect(result).toContain("Snippet: The documented change.")
    expect(result).toContain("Last updated: 2026-09-14")
  })

  test("rejects retired arguments and conflicting or invalid search constraints before requesting", async () => {
    const calls = installFetch({ results: [] })
    expect(text(await reason.execute({ messages, strip_thinking: true }, context)).startsWith("ERROR:")).toBe(true)
    const invalidSearches = [
      { query: ["1", "2", "3", "4", "5", "6"] },
      { query: "term", search_context_size: "high", max_tokens: 1000 },
      { query: "term", search_domain_filter: ["example.com", "-other.com"] },
      { query: "term", search_after_date_filter: "02/30/2026" },
      { query: "term", max_results: 21 },
    ]
    for (const args of invalidSearches) expect(text(await search.execute(args, context)).startsWith("ERROR:")).toBe(true)
    expect(calls).toHaveLength(0)
    await search.execute({ query: "term", search_type: "people", max_results: 50 }, context)
    expect(calls).toHaveLength(1)
  })

  test("reports caller cancellation during body consumption instead of timeout or missing evidence", async () => {
    const controller = new AbortController()
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"status":'))
        init?.signal?.addEventListener("abort", () => stream.error(new DOMException("Interrupted", "AbortError")), { once: true })
        queueMicrotask(() => controller.abort())
      },
    })), { preconnect: originalFetch.preconnect })
    const result = text(await ask.execute({ messages }, { ...context, abort: controller.signal }))
    expect(result).toContain("cancelled by caller")
    expect(result).not.toContain("timed out")
    expect(result).not.toContain("No search results")
  })

  test("keeps the timeout active through body consumption", async () => {
    process.env.PERPLEXITY_TIMEOUT_MS = "5"
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
      start(stream) {
        init?.signal?.addEventListener("abort", () => stream.error(new DOMException("Interrupted", "AbortError")), { once: true })
      },
    })), { preconnect: originalFetch.preconnect })
    expect(text(await research.execute({ messages }, context))).toContain("timed out after 5ms")
  })

  test("redacts credential echoes from provider errors", async () => {
    installFetch({ error: { message: "Invalid perplexity-test-secret" } }, 401)
    const result = text(await ask.execute({ messages }, context))
    expect(result).toContain("HTTP 401")
    expect(result).toContain("[REDACTED]")
    expect(result).not.toContain("perplexity-test-secret")
  })
})
