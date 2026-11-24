import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Effect, Layer, Result, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext, type AnyActionDefinition } from "../../core/plugin.ts";
import secSource, {
  clearSecTickerCache,
  parseCik,
  secCompanyAction,
  secFactsAction,
  secSearchAction,
} from "./index.ts";

const TICKERS_FIXTURE = {
  "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  "1": { cik_str: 1067983, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY INC" },
};

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
};

const COMPANYFACTS_FIXTURE = {
  cik: 320193,
  entityName: "Apple Inc.",
  facts: {
    "us-gaap": {
      Revenues: {
        label: "Revenues",
        units: {
          USD: [
            {
              start: "2023-10-01",
              end: "2024-09-28",
              val: 391035000000,
              accn: "0000320193-24-000123",
              fy: 2024,
              fp: "FY",
              form: "10-K",
              filed: "2024-11-01",
            },
            {
              start: "2023-10-01",
              end: "2024-09-28",
              val: 391036000000,
              accn: "0000320193-25-000079",
              fy: 2025,
              fp: "FY",
              form: "10-K",
              filed: "2025-11-01",
            },
            {
              start: "2024-09-29",
              end: "2025-09-27",
              val: 416161000000,
              accn: "0000320193-25-000079",
              fy: 2025,
              fp: "FY",
              form: "10-K",
              filed: "2025-11-01",
            },
            {
              start: "2025-03-30",
              end: "2025-06-28",
              val: 94036000000,
              accn: "0000320193-25-000050",
              fy: 2025,
              fp: "Q3",
              form: "10-Q",
              filed: "2025-08-01",
            },
          ],
        },
      },
      Assets: {
        label: "Assets",
        units: {
          USD: [
            {
              end: "2025-09-27",
              val: 359241000000,
              accn: "0000320193-25-000079",
              fy: 2025,
              fp: "FY",
              form: "10-K",
              filed: "2025-11-01",
            },
          ],
        },
      },
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        label: "Revenue from Contract with Customer",
        units: {
          USD: [
            {
              start: "2024-09-29",
              end: "2025-09-27",
              val: 416161000000,
              accn: "0000320193-25-000079",
              fy: 2025,
              fp: "FY",
              form: "10-K",
              filed: "2025-11-01",
            },
          ],
        },
      },
    },
    dei: {
      EntityCommonStockSharesOutstanding: {
        label: "Entity Common Stock, Shares Outstanding",
        units: {
          shares: [
            {
              end: "2025-10-17",
              val: 14840390000,
              accn: "0000320193-25-000079",
              fy: 2025,
              fp: "FY",
              form: "10-K",
              filed: "2025-11-01",
            },
          ],
        },
      },
    },
  },
};

function makeLayer(handler: (url: URL, headers: Record<string, string>) => Response) {
  const base = HttpClient.make((req) =>
    Effect.sync(() => HttpClientResponse.fromWeb(req, handler(new URL(req.url), { ...req.headers }))),
  );
  return Layer.mergeAll(
    Layer.succeed(FreeHttp, makeFreeClient(base, { resolveDns: false, retries: 0 })),
    Layer.succeed(PaidHttp, makePaidClient(base, { resolveDns: false })),
  );
}

describe("secSource", () => {
  const savedUA = process.env.SEC_USER_AGENT;
  const kept: Array<{ label: string; status: number | string; body: unknown }> = [];

  const makeCtx = (): ActionContext => ({
    digId: "sec-test",
    project: "/tmp",
    signal: new AbortController().signal,
    progress: () => {},
    keep: (label, status, body) => kept.push({ label, status, body }),
  });

  const run = <A extends AnyActionDefinition>(
    action: A,
    args: unknown,
    handler: (url: URL, headers: Record<string, string>) => Response,
  ) =>
    Effect.runPromise(
      executeAction(action, args as never, makeCtx()).pipe(Effect.provide(makeLayer(handler))),
    );

  beforeEach(() => {
    kept.length = 0;
    clearSecTickerCache();
    delete process.env.SEC_USER_AGENT;
  });

  afterEach(() => {
    clearSecTickerCache();
    if (savedUA === undefined) delete process.env.SEC_USER_AGENT;
    else process.env.SEC_USER_AGENT = savedUA;
  });

  it("sec_search queries efts.sec.gov with descriptive User-Agent and builds direct Archive URLs", async () => {
    const requests: Array<{ url: URL; ua: string | undefined }> = [];
    process.env.SEC_USER_AGENT = "MyOrg ResearchBot/1.0 (ops@example.com)";
    const out = await run(
      secSearchAction,
      {
        q: '"supply chain"',
        forms: ["10-k", "10-q"],
        entity: "320193",
        startDate: "2025-01-01",
        endDate: "2025-12-31",
        limit: 5,
      },
      (url, headers) => {
        requests.push({ url, ua: headers["user-agent"] });
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
        });
      },
    );

    assert.equal(out.status, "success", out.text);
    assert.deepEqual(out.details?.cost, []);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].ua, "MyOrg ResearchBot/1.0 (ops@example.com)");
    assert.equal(requests[0].url.origin + requests[0].url.pathname, "https://efts.sec.gov/LATEST/search-index");
    assert.equal(requests[0].url.searchParams.get("forms"), "10-K,10-Q");
    assert.equal(requests[0].url.searchParams.get("ciks"), "0000320193");
    assert.equal(requests[0].url.searchParams.get("dateRange"), "custom");
    assert.equal(requests[0].url.searchParams.get("startdt"), "2025-01-01");
    assert.equal(requests[0].url.searchParams.get("enddt"), "2025-12-31");
    assert.match(out.text, /https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/320193\/000032019325000079\/aapl-20250927\.htm/);
    assert.equal(out.text.includes("ops@example.com"), false, "never echo SEC_USER_AGENT in output");
  });

  it("sec_company resolves ticker once (cached in memory) and filters recent filings", async () => {
    const urls: string[] = [];
    const handler = (url: URL, headers: Record<string, string>) => {
      urls.push(url.href);
      assert.match(headers["user-agent"] ?? "", /^DigResearch\//);
      if (url.pathname.endsWith("company_tickers.json")) return Response.json(TICKERS_FIXTURE);
      if (url.pathname.endsWith("CIK0000320193.json")) return Response.json(SUBMISSIONS_FIXTURE);
      return new Response("not found", { status: 404 });
    };

    const first = await run(secCompanyAction, { entity: "aapl", forms: ["10-K", "10-Q"], limit: 10 }, handler);
    assert.equal(first.status, "success", first.text);
    assert.deepEqual(first.details?.cost, []);
    assert.equal(urls.length, 2);
    assert.match(first.text, /# Apple Inc\. \(CIK 0000320193\)/);
    assert.match(first.text, /1\. \*\*10-K\*\* · Filed 2025-11-01/);
    assert.doesNotMatch(first.text, /\*\*8-K\*\*/);

    const second = await run(secCompanyAction, { entity: "AAPL", forms: ["8-K"] }, handler);
    assert.equal(second.status, "success", second.text);
    assert.equal(urls.length, 3, "second ticker call must reuse in-memory ticker cache");
    assert.match(second.text, /\*\*8-K\*\*/);
    assert.match(second.text, /Items: 2\.02, 9\.01/);
  });

  it("sec_facts lists concepts when omitted and deduplicates comparative restatements when queried", async () => {
    const urls: string[] = [];
    const handler = (url: URL) => {
      urls.push(url.href);
      if (url.pathname.endsWith("companyfacts/CIK0000320193.json")) return Response.json(COMPANYFACTS_FIXTURE);
      return new Response("not found", { status: 404 });
    };

    const discover = await run(secFactsAction, { entity: "320193" }, handler);
    assert.equal(discover.status, "success", discover.text);
    assert.equal(urls.length, 1);
    assert.match(discover.text, /Available taxonomies: us-gaap, dei/);
    assert.match(discover.text, /\*\*Revenues\*\*/);

    const query = await run(
      secFactsAction,
      { entity: "CIK0000320193", concepts: ["revenues", "Contract"], forms: ["10-K"], limit: 4 },
      handler,
    );
    assert.equal(query.status, "success", query.text);
    assert.match(query.text, /\$416,161,000,000/);
    assert.match(query.text, /\$391,036,000,000/);
    assert.doesNotMatch(query.text, /\$391,035,000,000/, "comparative repeat should be deduplicated to latest filed");
    assert.doesNotMatch(query.text, /94,036,000,000/, "10-Q filtered out");
    assert.match(query.text, /Similar concepts: RevenueFromContractWithCustomerExcludingAssessedTax/);
  });

  it("validates dates, CIK parsing, unknown ticker, Effect schemas, and keyless plugin metadata", async () => {
    assert.deepEqual(parseCik("320193"), { cik10: "0000320193", cikNum: "320193" });
    assert.deepEqual(parseCik("CIK0000320193"), { cik10: "0000320193", cikNum: "320193" });
    assert.equal(parseCik("AAPL"), null);
    assert.equal(parseCik("0000000000"), null);

    const noop = () => Response.json(TICKERS_FIXTURE);
    assert.equal((await run(secSearchAction, { q: "test", startDate: "2025-02-30" }, noop)).status, "failed");
    assert.equal(
      (await run(secSearchAction, { q: "test", startDate: "2025-06-01", endDate: "2025-01-01" }, noop)).status,
      "failed",
    );

    const unknown = await run(secCompanyAction, { entity: "ZZZZZZ" }, noop);
    assert.equal(unknown.status, "failed");
    assert.match(unknown.text, /not found/);

    assert.equal(decodeActionArgs(secSearchAction, { q: "litigation", limit: 25 }).ok, true);
    assert.equal(decodeActionArgs(secSearchAction, { q: "litigation", limit: 26 }).ok, false);
    assert.equal(decodeActionArgs(secCompanyAction, { entity: "AAPL", limit: 50 }).ok, true);
    assert.equal(decodeActionArgs(secCompanyAction, { entity: "AAPL", limit: 51 }).ok, false);
    assert.equal(decodeActionArgs(secFactsAction, { entity: "AAPL", concepts: ["Revenues"], limit: 25 }).ok, true);
    assert.equal(decodeActionArgs(secFactsAction, { entity: "AAPL", limit: 26 }).ok, false);

    const seen: URL[] = [];
    const empty = await run(secSearchAction, { q: "quantum widget", entity: "Acme Corp" }, (url) => {
      seen.push(url);
      return Response.json({ hits: { total: { value: 0, relation: "eq" }, hits: [] } });
    });
    assert.equal(empty.status, "empty");
    assert.equal(seen[0].searchParams.get("entityName"), "Acme Corp");
    assert.equal(seen[0].searchParams.get("ciks"), null);

    assert.equal(secSource.id, "sec");
    assert.equal(secSource.group, "markets");
    assert.equal(secSource.keys, undefined, "SEC must stay keyless so readiness is ready");
    assert.equal(secSource.logo, undefined);
    assert.ok(secSource.envSettings?.some((s) => s.name === "SEC_USER_AGENT"));
    assert.ok(Result.isSuccess(Schema.decodeUnknownResult(secSearchAction.schema)({ q: "test" })));
  });
});
