import { afterEach, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { Type } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { executeSource } from "../outcome.js"
import { createSchemas } from "../schemas.js"
import type { ToolContext } from "../types.js"
import { map, reportedFirecrawlCredits, scrape, validatePublicHttpUrl } from "./firecrawl.js"

type FetchCall = { url: string; method: string; headers: Headers; body: Record<string, unknown> }
type Reply = { status?: number; headers?: Record<string, string>; payload?: unknown; raw?: string; throwError?: Error }

const kept: { label: string; status: number | string; body: unknown }[] = []
const ctx: ToolContext = {
  sessionID: "firecrawl-test",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  keep(label, status, body) {
    kept.push({ label, status, body })
  },
}

function mockFetch(handler: (call: FetchCall) => Reply) {
  const calls: FetchCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    }
    calls.push(call)
    const reply = handler(call)
    if (reply.throwError) throw reply.throwError
    const body = reply.raw !== undefined ? reply.raw : JSON.stringify(reply.payload ?? {})
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json", ...(reply.headers ?? {}) },
    })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

describe("firecrawl tools", () => {
  const savedKey = process.env.FIRECRAWL_API_KEY
  let restore: (() => void) | undefined

  beforeEach(() => {
    kept.length = 0
    process.env.FIRECRAWL_API_KEY = "fc-test-key"
  })

  afterEach(() => {
    restore?.()
    restore = undefined
    if (savedKey === undefined) delete process.env.FIRECRAWL_API_KEY
    else process.env.FIRECRAWL_API_KEY = savedKey
  })

  test("scrape posts to /v2/scrape with Bearer auth and meters top-level creditsUsed", async () => {
    const mock = mockFetch(() => ({
      payload: {
        success: true,
        creditsUsed: 1,
        data: {
          markdown: "# Hello Firecrawl\n\nClean content from JS page.",
          metadata: {
            title: "Hello Firecrawl",
            description: "Sample page",
            sourceURL: "https://example.com/docs",
            url: "https://example.com/docs/intro",
            statusCode: 200,
            cacheState: "miss",
          },
        },
      },
    }))
    restore = mock.restore

    const out = await executeSource(
      scrape,
      { url: "https://example.com/docs", onlyMainContent: true, maxAge: 0, waitFor: 1500 },
      ctx,
    )

    assert.equal(out.status, "success", out.text)
    assert.equal(mock.calls.length, 1)
    assert.equal(mock.calls[0].url, "https://api.firecrawl.dev/v2/scrape")
    assert.equal(mock.calls[0].method, "POST")
    assert.equal(mock.calls[0].headers.get("authorization"), "Bearer fc-test-key")
    assert.deepEqual(mock.calls[0].body, {
      url: "https://example.com/docs",
      formats: ["markdown"],
      onlyMainContent: true,
      maxAge: 0,
      waitFor: 1500,
      timeout: 60000,
    })
    assert.deepEqual(out.details?.cost, [{ amount: 1, unit: "Firecrawl credits" }])
    assert.match(out.text, /# Hello Firecrawl/)
    assert.match(out.text, /Clean content from JS page\./)
    assert.match(out.text, /1 Firecrawl credit/)
    assert.equal(kept.length, 1)
    assert.equal(kept[0].label, "/v2/scrape")
  })

  test("scrape meters nested data.metadata.creditsUsed and marks omitted credits as unknown (never 0)", async () => {
    const nestedMock = mockFetch(() => ({
      payload: {
        success: true,
        data: {
          markdown: "Nested credit page",
          metadata: { title: "Nested", creditsUsed: 2, statusCode: 200 },
        },
      },
    }))
    restore = nestedMock.restore

    const nestedOut = await executeSource(scrape, { url: "https://example.com/nested" }, ctx)
    assert.equal(nestedOut.status, "success")
    assert.deepEqual(nestedOut.details?.cost, [{ amount: 2, unit: "Firecrawl credits" }])
    nestedMock.restore()

    const omittedMock = mockFetch(() => ({
      payload: {
        success: true,
        data: { markdown: "No credits field", metadata: { title: "Omitted", statusCode: 200 } },
      },
    }))
    restore = omittedMock.restore

    const omittedOut = await executeSource(scrape, { url: "https://example.com/omitted" }, ctx)
    assert.equal(omittedOut.status, "success")
    assert.equal(omittedOut.details?.cost, null, "omitted credits must be unknown, never 0")
    assert.match(omittedOut.text, /credits not reported \(cost unknown\)/)
  })

  test("scrape supports html and links formats and truncates cleanly at maxCharacters", async () => {
    const mock = mockFetch(() => ({
      payload: {
        success: true,
        creditsUsed: 1,
        data: {
          markdown: "A".repeat(800),
          links: ["https://example.com/a", "https://example.com/b"],
          metadata: { title: "Big Page", statusCode: 200 },
        },
      },
    }))
    restore = mock.restore

    const out = await executeSource(
      scrape,
      { url: "https://example.com/big", formats: ["markdown", "links"], maxCharacters: 500 },
      ctx,
    )
    assert.equal(out.status, "success")
    assert.equal(out.details?.truncated, true)
    assert.match(out.text, /Truncated at 500 characters/)
  })

  test("scrape refuses private, loopback, link-local, metadata, and non-http(s) URLs before any request", async () => {
    const mock = mockFetch(() => {
      throw new Error("should not fetch")
    })
    restore = mock.restore

    const blocked = [
      "http://localhost/admin",
      "http://foo.localhost/secret",
      "http://127.0.0.1:47811/health",
      "http://10.0.0.1/internal",
      "http://172.16.0.5/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://[fc00::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
      "http://[::127.0.0.1]/",
      "http://[::169.254.169.254]/",
      "http://[::ffff:0:127.0.0.1]/",
      "http://[64:ff9b::169.254.169.254]/",
      "http://[2002:a9fe:a9fe::]/",
      "http://[2001:db8::1]/",
      "http://198.51.100.1/",
      "http://203.0.113.1/",
      "http://localhost../",
      "http://metadata.goog/",
      "http://printer.home.arpa/",
      "http://printer.local/",
      "http://metadata.google.internal/",
      "http://intranet/dashboard",
      "file:///etc/passwd",
      "ftp://example.com/file",
      "https://user:pass@example.com/",
      "example.com/no-scheme",
    ]
    for (const url of blocked) {
      const check = validatePublicHttpUrl(url)
      assert.ok("error" in check, `expected ${url} to be refused`)
      const out = await executeSource(scrape, { url }, ctx)
      assert.equal(out.status, "failed", url)
    }
    assert.equal(mock.calls.length, 0)
  })

  test("scrape rejects waitFor > 10000 and missing API key before sending any request", async () => {
    const mock = mockFetch(() => {
      throw new Error("should not fetch")
    })
    restore = mock.restore

    const tooLong = await executeSource(scrape, { url: "https://example.com", waitFor: 15000 }, ctx)
    assert.equal(tooLong.status, "failed")
    assert.match(tooLong.text, /waitFor/)

    delete process.env.FIRECRAWL_API_KEY
    const noKey = await executeSource(scrape, { url: "https://example.com" }, ctx)
    assert.equal(noKey.status, "failed")
    assert.match(noKey.text, /FIRECRAWL_API_KEY/)
    assert.equal(mock.calls.length, 0)
  })

  test("never retries paid calls on 429/500 or transport error and redacts API key from errors", async () => {
    const errMock = mockFetch(() => ({
      status: 429,
      payload: { success: false, error: "Rate limited for key fc-test-key" },
    }))
    restore = errMock.restore

    const rateLimited = await executeSource(scrape, { url: "https://example.com/rl" }, ctx)
    assert.equal(rateLimited.status, "failed")
    assert.equal(errMock.calls.length, 1, "must never retry a paid Firecrawl call on 429")
    assert.equal(rateLimited.details?.cost, null)
    assert.equal(rateLimited.text.includes("fc-test-key"), false, "API key must be redacted")
    assert.match(rateLimited.text, /\[redacted\]/)
    errMock.restore()

    const netMock = mockFetch(() => ({
      throwError: new Error("socket hang up with fc-test-key"),
    }))
    restore = netMock.restore

    const dropped = await executeSource(map, { url: "https://example.com" }, ctx)
    assert.equal(dropped.status, "failed")
    assert.equal(netMock.calls.length, 1, "must never retry on transport error")
    assert.equal(dropped.details?.cost, null)
    assert.match(dropped.text, /cost is unknown/)
    assert.equal(dropped.text.includes("fc-test-key"), false)
  })

  test("map posts to /v2/map and renders both object and string link entries", async () => {
    const mock = mockFetch(() => ({
      payload: {
        success: true,
        creditsUsed: 1,
        links: [
          { url: "https://example.com/pricing", title: "Pricing", description: "Plan tiers and credits." },
          "https://example.com/docs",
        ],
      },
    }))
    restore = mock.restore

    const out = await executeSource(
      map,
      { url: "https://example.com", search: "pricing", limit: 25, sitemap: "include" },
      ctx,
    )
    assert.equal(out.status, "success", out.text)
    assert.equal(mock.calls.length, 1)
    assert.equal(mock.calls[0].url, "https://api.firecrawl.dev/v2/map")
    assert.deepEqual(mock.calls[0].body, {
      url: "https://example.com/",
      search: "pricing",
      limit: 25,
      sitemap: "include",
      timeout: 60000,
    })
    assert.deepEqual(out.details?.cost, [{ amount: 1, unit: "Firecrawl credits" }])
    assert.match(out.text, /1\. https:\/\/example\.com\/pricing — Pricing/)
    assert.match(out.text, /2\. https:\/\/example\.com\/docs/)
  })

  test("map returns empty when links is empty and validates schemas and bounds", async () => {
    const mock = mockFetch(() => ({
      payload: { success: true, links: [] },
    }))
    restore = mock.restore

    const out = await executeSource(map, { url: "https://example.com", search: "nonexistent" }, ctx)
    assert.equal(out.status, "empty")
    assert.equal(out.details?.cost, null)
    assert.equal(reportedFirecrawlCredits({ success: true }), null)

    const schemas = createSchemas(Type)
    assert.ok(Value.Check(schemas.firecrawl_scrape, { url: "https://example.com", formats: ["markdown", "links"], onlyMainContent: false, maxAge: 0, waitFor: 10000 }))
    assert.ok(!Value.Check(schemas.firecrawl_scrape, { url: "https://example.com", waitFor: 10001 }))
    assert.ok(!Value.Check(schemas.firecrawl_scrape, { url: "https://example.com", formats: ["screenshot"] }))
    assert.ok(Value.Check(schemas.firecrawl_map, { url: "https://example.com", search: "api", limit: 200, sitemap: "only" }))
    assert.ok(!Value.Check(schemas.firecrawl_map, { url: "https://example.com", limit: 201 }))
  })

  test("catalog registers firecrawl under web with FIRECRAWL_API_KEY account and no brand logo", async () => {
    const { ACCOUNTS, MODULES, SOURCE_GROUPS } = await import("../modules.js")
    const mod = MODULES.find((m) => m.id === "firecrawl")
    assert.ok(mod)
    assert.deepEqual(mod.tools, ["firecrawl_scrape", "firecrawl_map"])
    assert.deepEqual(mod.keys, ["FIRECRAWL_API_KEY"])
    assert.equal("logo" in mod, false)
    assert.ok((SOURCE_GROUPS.find((g) => g.id === "web")?.sources as readonly string[]).includes("firecrawl"))
    assert.ok(ACCOUNTS.some((a) => a.id === "firecrawl" && (a.keys as readonly unknown[]).includes("FIRECRAWL_API_KEY")))
  })
})
