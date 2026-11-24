import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext, type AnyActionDefinition } from "../../core/plugin.ts";
import commerceSource, {
  commerceDiscoverAction,
  commerceHistoryAction,
  commerceProductAction,
  commerceReviewsAction,
  commerceSearchAction,
  commerceSource as namedCommerceSource,
} from "./index.ts";

interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly body: unknown;
}

function makeTestEnv(handler: (req: RecordedRequest) => Response | { readonly error: string }) {
  const requests: RecordedRequest[] = [];
  const base = HttpClient.make((req) =>
    Effect.gen(function* () {
      let body: unknown = undefined;
      if (req.body._tag === "Uint8Array") {
        try {
          body = JSON.parse(new TextDecoder().decode(req.body.body));
        } catch {
          body = undefined;
        }
      }
      const rec: RecordedRequest = { url: new URL(req.url), method: req.method, body };
      requests.push(rec);
      const res = handler(rec);
      if ("error" in res) {
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request: req, description: res.error }),
          }),
        );
      }
      return HttpClientResponse.fromWeb(req, res);
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(PaidHttp, makePaidClient(base, { resolveDns: false })),
    Layer.succeed(FreeHttp, makeFreeClient(base, { resolveDns: false, retries: 0 })),
  );
  const ctx: ActionContext = {
    digId: "dig-test",
    project: "/tmp",
    signal: new AbortController().signal,
    progress: () => {},
    keep: () => {},
  };
  return {
    requests,
    run: <A extends AnyActionDefinition>(action: A, rawArgs: unknown) => {
      const decoded = decodeActionArgs(action, rawArgs);
      if (!decoded.ok) {
        return Promise.resolve({ status: "failed" as const, text: decoded.error, details: { cost: null } });
      }
      return Effect.runPromise(executeAction(action, decoded.args, ctx).pipe(Effect.provide(layer)));
    },
  };
}

const jsonResponse = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("commerce source plugin", () => {
  const savedScrapeDo = process.env.SCRAPE_DO_API_KEY;
  const savedNexscope = process.env.NEXSCOPE_API_KEY;

  beforeEach(() => {
    process.env.SCRAPE_DO_API_KEY = "scrapedo-test-token-1234";
    process.env.NEXSCOPE_API_KEY = "nexscope-test-token-5678";
  });

  afterEach(() => {
    if (savedScrapeDo === undefined) delete process.env.SCRAPE_DO_API_KEY;
    else process.env.SCRAPE_DO_API_KEY = savedScrapeDo;
    if (savedNexscope === undefined) delete process.env.NEXSCOPE_API_KEY;
    else process.env.NEXSCOPE_API_KEY = savedNexscope;
  });

  test("exports commerceSource as named and default with all 5 actions", () => {
    assert.equal(commerceSource, namedCommerceSource);
    assert.equal(commerceSource.id, "commerce");
    assert.equal(commerceSource.group, "markets");
    assert.deepEqual(
      commerceSource.actions.map((a) => a.name),
      ["commerce_search", "commerce_product", "commerce_history", "commerce_reviews", "commerce_discover"],
    );
  });

  test("commerce_search meters scrape.do-request-cost header and formats results", async () => {
    const env = makeTestEnv(() =>
      jsonResponse(
        {
          status: "success",
          totalResults: "1-16 of over 1,000 results",
          products: [
            {
              position: 1,
              title: "Stainless Kettle",
              asin: "B0ABCDEF12",
              price: { amount: 39.99, currencyCode: "USD" },
              rating: 4.7,
              reviewCount: "(1.2K)",
              isPrime: true,
              isSponsored: false,
            },
          ],
          filters: [{ name: "Brand", options: [{ label: "Fellow", rh: "p_89:Fellow" }] }],
        },
        200,
        { "scrape.do-request-cost": "5" },
      ),
    );

    const res = await env.run(commerceSearchAction, { query: "kettle", low_price: 20, high_price: 60 });
    assert.equal(res.status, "success");
    assert.deepEqual(res.details?.cost, [{ amount: 5, unit: "Scrape.do credits" }]);
    assert.equal(env.requests[0].url.searchParams.get("geocode"), "us");
    assert.equal(env.requests[0].url.searchParams.get("zipcode"), "10001");
    assert.match(res.text, /Stainless Kettle/);
    assert.match(res.text, /Fellow \(rh=p_89:Fellow\)/);
    assert.ok(!res.text.includes("scrapedo-test-token-1234"));
  });

  test("commerce_product sums Scrape.do PDP + offer-listing header costs and marks partial when offers fail", async () => {
    const envOk = makeTestEnv((req) => {
      if (req.url.pathname.endsWith("/pdp")) {
        return jsonResponse(
          { status: "success", asin: "B0ABCDEF12", name: "Stainless Kettle", price: 39.99, currency: "USD", rating: 4.7, total_ratings: 1200 },
          200,
          { "scrape.do-request-cost": "5" },
        );
      }
      return jsonResponse(
        {
          status: "success",
          offers: [{ merchantName: "Amazon.com", isBuyBoxWinner: true, listingPrice: { amount: 39.99, currencyCode: "USD" }, isPrime: true }],
        },
        200,
        { "scrape.do-request-cost": "3" },
      );
    });

    const ok = await envOk.run(commerceProductAction, { asin: "b0abcdef12" });
    assert.equal(ok.status, "success");
    assert.deepEqual(ok.details?.cost, [{ amount: 8, unit: "Scrape.do credits" }]);
    assert.match(ok.text, /## Buy Box \/ Seller Context/);
    assert.match(ok.text, /Seller: Amazon\.com/);

    const envPartial = makeTestEnv((req) => {
      if (req.url.pathname.endsWith("/pdp")) {
        return jsonResponse(
          { status: "success", asin: "B0ABCDEF12", name: "Stainless Kettle", price: 39.99, currency: "USD" },
          200,
          { "scrape.do-request-cost": "5" },
        );
      }
      return jsonResponse({ message: "upstream 500" }, 500);
    });
    const part = await envPartial.run(commerceProductAction, { asin: "B0ABCDEF12" });
    assert.equal(part.status, "partial");
    assert.equal(part.details?.cost, null);
    assert.deepEqual(part.details?.knownCost, [{ amount: 5, unit: "Scrape.do credits" }]);
  });

  test("commerce_history and commerce_reviews call Nexscope with unknown cost and carry-in/sampling behavior", async () => {
    const envHist = makeTestEnv(() =>
      jsonResponse({
        code: 0,
        data: {
          costToken: 4,
          price: [
            { time: "2020-01-01", value: 49.99 },
            { time: new Date().toISOString().slice(0, 10), value: 39.99 },
          ],
          buyboxPrice: [{ time: new Date().toISOString().slice(0, 10), value: 39.99 }],
        },
      }),
    );
    const hist = await envHist.run(commerceHistoryAction, { asin: "B0ABCDEF12", days: 30, series: ["market_price", "buy_box"] });
    assert.equal(hist.status, "success");
    assert.equal(hist.details?.cost, null);
    assert.match(hist.text, /carry-in/);
    assert.match(hist.text, /\$39\.99/);

    const envRev = makeTestEnv(() =>
      jsonResponse({
        code: 0,
        data: {
          total: 2,
          costToken: 2,
          columns: [
            {
              reviewId: "R1",
              rating: 5,
              title: "Heats fast",
              text: "Boils water in 2 minutes.",
              userName: "Pat",
              verified: true,
              productTitle: "Stainless Kettle",
            },
          ],
        },
      }),
    );
    const rev = await envRev.run(commerceReviewsAction, { asin: "B0ABCDEF12", stars: [5], per_star_limit: 5 });
    assert.equal(rev.status, "success");
    assert.equal(rev.details?.cost, null);
    assert.match(rev.text, /Heats fast/);
    assert.equal((envRev.requests[0].body as Record<string, unknown>).star1Num, 0);
    assert.equal((envRev.requests[0].body as Record<string, unknown>).star5Num, 5);
  });

  test("commerce_discover enforces kind-specific args and meters Scrape.do credits", async () => {
    const env = makeTestEnv(() =>
      jsonResponse(
        {
          status: "success",
          pagination: { current_page: 1, has_next: false },
          products: [
            {
              title: "Deal Kettle",
              asin: "B0DEAL0001",
              price: { amount: 25, currencyCode: "USD" },
              price_before_deal: { amount: 50, currencyCode: "USD" },
            },
          ],
        },
        200,
        { "scrape.do-request-cost": "4" },
      ),
    );

    const bad = await env.run(commerceDiscoverAction, { kind: "seller", seller: "A123", low_price: 10 });
    assert.equal(bad.status, "failed");
    assert.equal(env.requests.length, 0);

    const ok = await env.run(commerceDiscoverAction, { kind: "deals", low_price: 10, high_price: 60 });
    assert.equal(ok.status, "success");
    assert.deepEqual(ok.details?.cost, [{ amount: 4, unit: "Scrape.do credits" }]);
    assert.match(ok.text, /50\.0%/);
  });
});
