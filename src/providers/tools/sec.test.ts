import { afterEach, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { Type } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { executeSource } from "../outcome.js"
import { createSchemas } from "../schemas.js"
import type { ToolContext } from "../types.js"
import { clearSecTickerCache, company, facts, parseCik, search } from "./sec.js"

const kept: { label: string; status: number | string; body: unknown }[] = []
const ctx: ToolContext = {
  sessionID: "sec-test",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  keep(label, status, body) {
    kept.push({ label, status, body })
  },
}

const TICKERS_FIXTURE = {
  "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  "1": { cik_str: 1067983, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY INC" },
}

const SUBMISSIONS_FIXTURE = {
  cik: "0000320193",
  entityType: "operating",
  sic: "3571",
  sicDescription: "ELECTRONIC COMPUTERS",
  name: "Apple Inc.",
  tickers: ["AAPL"],
  exchanges: ["Nasdaq"],
  fiscalYearEnd: "0927",
  stateOfIncorporation: "CA",
  filings: {
    recent: {
      accessionNumber: ["0000320193-25-000079", "0000320193-25-000050", "0000320193-25-000010"],
      filingDate: ["2025-11-01", "2025-08-01", "2025-05-02"],
      reportDate: ["2025-09-27", "2025-06-28", "2025-03-29"],
      form: ["10-K", "10-Q", "8-K"],
      primaryDocument: ["aapl-20250927.htm", "aapl-20250628.htm", "aapl-8k.htm"],
      primaryDocDescription: ["10-K", "10-Q", "Current report"],
      items: [[], [], ["2.02", "9.01"]],
    },
    files: [{ name: "CIK0000320193-submissions-001.json" }],
  },
}

const COMPANYFACTS_FIXTURE = {
  cik: 320193,
  entityName: "Apple Inc.",
  facts: {
    "us-gaap": {
      Revenues: {
        label: "Revenues",
        units: {
          USD: [
            { start: "2023-10-01", end: "2024-09-28", val: 391035000000, accn: "0000320193-24-000123", fy: 2024, fp: "FY", form: "10-K", filed: "2024-11-01" },
            { start: "2023-10-01", end: "2024-09-28", val: 391036000000, accn: "0000320193-25-000079", fy: 2025, fp: "FY", form: "10-K", filed: "2025-11-01" },
            { start: "2024-09-29", end: "2025-09-27", val: 416161000000, accn: "0000320193-25-000079", fy: 2025, fp: "FY", form: "10-K", filed: "2025-11-01" },
            { start: "2025-03-30", end: "2025-06-28", val: 94036000000, accn: "0000320193-25-000050", fy: 2025, fp: "Q3", form: "10-Q", filed: "2025-08-01" },
          ],
        },
      },
      Assets: {
        label: "Assets",
        units: {
          USD: [
            { end: "2025-09-27", val: 359241000000, accn: "0000320193-25-000079", fy: 2025, fp: "FY", form: "10-K", filed: "2025-11-01" },
          ],
        },
      },
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        label: "Revenue from Contract with Customer",
        units: {
          USD: [
            { start: "2024-09-29", end: "2025-09-27", val: 416161000000, accn: "0000320193-25-000079", fy: 2025, fp: "FY", form: "10-K", filed: "2025-11-01" },
          ],
        },
      },
    },
    dei: {
      EntityCommonStockSharesOutstanding: {
        label: "Entity Common Stock, Shares Outstanding",
        units: { shares: [{ end: "2025-10-17", val: 14840390000, accn: "0000320193-25-000079", fy: 2025, fp: "FY", form: "10-K", filed: "2025-11-01" }] },
      },
    },
  },
}

describe("sec edgar tools", () => {
  const originalFetch = globalThis.fetch
  const savedUA = process.env.SEC_USER_AGENT

  beforeEach(() => {
    kept.length = 0
    clearSecTickerCache()
    delete process.env.SEC_USER_AGENT
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearSecTickerCache()
    if (savedUA === undefined) delete process.env.SEC_USER_AGENT
    else process.env.SEC_USER_AGENT = savedUA
  })

  test("sec_search queries efts.sec.gov with descriptive User-Agent and builds direct Archive URLs", async () => {
    const requests: { url: URL; ua: string | null }[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: new URL(String(input)), ua: new Headers(init?.headers).get("user-agent") })
      return Response.json({
        hits: {
          total: { value: 42, relation: "eq" },
          hits: [
            {
              _id: "0000320193-25-000079:aapl-20250927.htm",
              _source: {
                adsh: "0000320193-25-000079",
                ciks: ["0000320193"],
                display_names: ["Apple Inc. (AAPL) (CIK 0000320193)"],
                form: "10-K",
                file_date: "2025-11-01",
                period_ending: "2025-09-27",
                file_description: "Form 10-K",
              },
            },
          ],
        },
      })
    }) as typeof fetch

    process.env.SEC_USER_AGENT = "MyOrg ResearchBot/1.0 (ops@example.com)"
    const out = await executeSource(
      search,
      { q: '"supply chain"', forms: ["10-k", "10-q"], entity: "320193", startDate: "2025-01-01", endDate: "2025-12-31", limit: 5 },
      ctx,
    )

    assert.equal(out.status, "success", out.text)
    assert.deepEqual(out.details?.cost, [], "SEC EDGAR is free")
    assert.equal(requests.length, 1)
    assert.equal(requests[0].ua, "MyOrg ResearchBot/1.0 (ops@example.com)")
    assert.equal(requests[0].url.origin + requests[0].url.pathname, "https://efts.sec.gov/LATEST/search-index")
    assert.equal(requests[0].url.searchParams.get("forms"), "10-K,10-Q")
    assert.equal(requests[0].url.searchParams.get("ciks"), "0000320193")
    assert.equal(requests[0].url.searchParams.get("dateRange"), "custom")
    assert.equal(requests[0].url.searchParams.get("startdt"), "2025-01-01")
    assert.equal(requests[0].url.searchParams.get("enddt"), "2025-12-31")
    assert.match(out.text, /https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/320193\/000032019325000079\/aapl-20250927\.htm/)
    assert.match(out.text, /0000320193-25-000079/)
    assert.equal(out.text.includes("ops@example.com"), false, "never echo SEC_USER_AGENT in output")
  })

  test("sec_company resolves ticker once (cached in memory) and filters recent filings", async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      urls.push(url)
      assert.match(new Headers(init?.headers).get("user-agent") ?? "", /^DigResearch\/1\.0 \(/)
      if (url.endsWith("company_tickers.json")) return Response.json(TICKERS_FIXTURE)
      if (url.endsWith("CIK0000320193.json")) return Response.json(SUBMISSIONS_FIXTURE)
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const first = await executeSource(company, { entity: "aapl", forms: ["10-K", "10-Q"], limit: 10 }, ctx)
    assert.equal(first.status, "success", first.text)
    assert.deepEqual(first.details?.cost, [])
    assert.equal(urls.length, 2, "first ticker lookup fetches company_tickers.json + submissions")
    assert.match(first.text, /# Apple Inc\. \(CIK 0000320193\)/)
    assert.match(first.text, /1\. \*\*10-K\*\* · Filed 2025-11-01/)
    assert.match(first.text, /2\. \*\*10-Q\*\* · Filed 2025-08-01/)
    assert.doesNotMatch(first.text, /\*\*8-K\*\*/)
    assert.match(first.text, /https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/320193\/000032019325000079\/aapl-20250927\.htm/)

    // Second call with ticker uses cached map (1 request only)
    const second = await executeSource(company, { entity: "AAPL", forms: ["8-K"] }, ctx)
    assert.equal(second.status, "success", second.text)
    assert.equal(urls.length, 3, "second ticker call must reuse in-memory ticker cache")
    assert.match(second.text, /\*\*8-K\*\*/)
    assert.match(second.text, /Items: 2\.02, 9\.01/)
  })

  test("sec_facts lists available concepts when omitted and deduplicates comparative restatements when queried", async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.endsWith("companyfacts/CIK0000320193.json")) return Response.json(COMPANYFACTS_FIXTURE)
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    // Direct CIK skips company_tickers.json
    const discover = await executeSource(facts, { entity: "320193" }, ctx)
    assert.equal(discover.status, "success", discover.text)
    assert.equal(urls.length, 1)
    assert.match(discover.text, /Available taxonomies: us-gaap, dei/)
    assert.match(discover.text, /\*\*Revenues\*\*/)
    assert.match(discover.text, /\*\*Assets\*\*/)

    // Specific concepts + form filter + missing-concept suggestion
    const query = await executeSource(
      facts,
      { entity: "CIK0000320193", concepts: ["revenues", "Contract"], forms: ["10-K"], limit: 4 },
      ctx,
    )
    assert.equal(query.status, "success", query.text)
    // Latest restated filing for FY2024 (391,036,000,000 filed 2025-11-01) replaces earlier 391,035,000,000
    assert.match(query.text, /\$416,161,000,000/)
    assert.match(query.text, /\$391,036,000,000/)
    assert.doesNotMatch(query.text, /\$391,035,000,000/, "comparative repeat should be deduplicated to latest filed")
    assert.doesNotMatch(query.text, /94,036,000,000/, "10-Q filtered out")
    assert.match(query.text, /Similar concepts: RevenueFromContractWithCustomerExcludingAssessedTax/)
  })

  test("validates dates, CIK parsing, unknown ticker, and TypeBox schemas", async () => {
    assert.deepEqual(parseCik("320193"), { cik10: "0000320193", cikNum: "320193" })
    assert.deepEqual(parseCik("CIK0000320193"), { cik10: "0000320193", cikNum: "320193" })
    assert.equal(parseCik("AAPL"), null)
    assert.equal(parseCik("0000000000"), null)

    const badDate = await executeSource(search, { q: "test", startDate: "2025-02-30" }, ctx)
    assert.equal(badDate.status, "failed")
    const inverted = await executeSource(search, { q: "test", startDate: "2025-06-01", endDate: "2025-01-01" }, ctx)
    assert.equal(inverted.status, "failed")

    globalThis.fetch = (async () => Response.json(TICKERS_FIXTURE)) as typeof fetch
    const unknown = await executeSource(company, { entity: "ZZZZZZ" }, ctx)
    assert.equal(unknown.status, "failed")
    assert.match(unknown.text, /not found/)

    const schemas = createSchemas(Type)
    assert.ok(Value.Check(schemas.sec_search, { q: "litigation", forms: ["10-K"], startDate: "2025-01-01", limit: 25 }))
    assert.ok(!Value.Check(schemas.sec_search, { q: "litigation", limit: 26 }))
    assert.ok(Value.Check(schemas.sec_company, { entity: "AAPL", forms: ["10-K"], limit: 50 }))
    assert.ok(!Value.Check(schemas.sec_company, { entity: "AAPL", limit: 51 }))
    assert.ok(Value.Check(schemas.sec_facts, { entity: "AAPL", concepts: ["Revenues"], taxonomy: "us-gaap", limit: 25 }))
    assert.ok(!Value.Check(schemas.sec_facts, { entity: "AAPL", limit: 26 }))
  })

  test("sec_search sends entityName for non-CIK entity, handles empty results, and catalog keeps sec keyless-ready", async () => {
    const seen: URL[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(new URL(String(input)))
      return Response.json({ hits: { total: { value: 0, relation: "eq" }, hits: [] } })
    }) as typeof fetch

    const empty = await executeSource(search, { q: "quantum widget", entity: "Acme Corp" }, ctx)
    assert.equal(empty.status, "empty")
    assert.equal(seen[0].searchParams.get("entityName"), "Acme Corp")
    assert.equal(seen[0].searchParams.get("ciks"), null)

    const { MODULES, SOURCE_GROUPS } = await import("../modules.js")
    const mod = MODULES.find((m) => m.id === "sec")
    assert.ok(mod)
    assert.deepEqual(mod.tools, ["sec_search", "sec_company", "sec_facts"])
    assert.equal("keys" in mod, false, "SEC must stay keyless so readiness is ready")
    assert.equal("logo" in mod, false)
    assert.ok(mod.envSettings?.some((s) => s.name === "SEC_USER_AGENT"))
    assert.ok((SOURCE_GROUPS.find((g) => g.id === "markets")?.sources as readonly string[]).includes("sec"))
  })
})
