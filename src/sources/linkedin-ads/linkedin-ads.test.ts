import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext, type AnyActionDefinition } from "../../core/plugin.ts";
import linkedinAdsSource, { linkedinAdLibraryAction, linkedinAdsSource as namedLinkedinAdsSource } from "./index.ts";

interface RecordedRequest {
  readonly url: URL;
}

function makeTestEnv(handler: (req: RecordedRequest) => Response | { readonly error: string }) {
  const requests: RecordedRequest[] = [];
  const base = HttpClient.make((req) =>
    Effect.gen(function* () {
      const rec = { url: new URL(req.url) };
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

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describe("linkedin-ads source plugin", () => {
  const savedKey = process.env.SCRAPECREATORS_API_KEY;

  beforeEach(() => {
    process.env.SCRAPECREATORS_API_KEY = "li-ads-test-key";
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
    else process.env.SCRAPECREATORS_API_KEY = savedKey;
  });

  test("exports linkedinAdsSource as named and default with expected metadata", () => {
    assert.equal(linkedinAdsSource, namedLinkedinAdsSource);
    assert.equal(linkedinAdsSource.id, "linkedin-ads");
    assert.equal(linkedinAdsSource.group, "markets");
    assert.deepEqual(
      linkedinAdsSource.actions.map((a) => a.name),
      ["linkedin_ad_library"],
    );
  });

  test("search sends validated filters, formats ads, respects limit and paginationToken, and meters credits", async () => {
    const start = daysAgo(30);
    const end = daysAgo(2);
    const env = makeTestEnv(() =>
      jsonResponse({
        success: true,
        credits_charged: 1,
        totalAds: 120,
        isLastPage: false,
        paginationToken: "tok-2",
        ads: [
          {
            id: "666281156",
            advertiser: "Acme Corp",
            adType: "SINGLE_IMAGE_AD",
            headline: "Scale faster",
            description: "Build reliable workflows",
            startDate: start,
            endDate: end,
          },
          {
            id: "666281157",
            advertiser: "Acme Corp",
            adType: "VIDEO_AD",
            description: "Second ad",
          },
        ],
      }),
    );

    const res = await env.run(linkedinAdLibraryAction, {
      action: "search",
      company_name: "Acme Corp",
      countries: "us, ca",
      start_date: start,
      end_date: end,
      limit: 1,
    });
    assert.equal(res.status, "success");
    assert.equal(env.requests.length, 1);
    assert.equal(env.requests[0].url.pathname, "/v1/linkedin/ads/search");
    assert.equal(env.requests[0].url.searchParams.get("countries"), "US,CA");
    assert.match(res.text, /1 shown of 2 returned/);
    assert.match(res.text, /pass cursor="tok-2"/);
    assert.deepEqual(res.details?.cost, [{ amount: 1, unit: "credits" }]);
  });

  test("detail validates url/ad_id, detects mismatched id, and displays payer, targeting, and media", async () => {
    const env = makeTestEnv(() =>
      jsonResponse({
        success: true,
        credits_charged: 1,
        id: "666281156",
        advertiser: "Acme Corp",
        paidForBy: "Acme Holdings LLC",
        totalImpressions: "10K-50K",
        targeting: { Location: "United States" },
        image: "https://media.licdn.com/ad-image.jpg",
      }),
    );

    const res = await env.run(linkedinAdLibraryAction, { action: "detail", ad_id: "666281156" });
    assert.equal(res.status, "success");
    assert.equal(env.requests[0].url.searchParams.get("url"), "https://www.linkedin.com/ad-library/detail/666281156");
    assert.match(res.text, /Paid for by: Acme Holdings LLC/);
    assert.match(res.text, /Total impressions \(LinkedIn's range\): 10K-50K/);
    assert.match(res.text, /Image: https:\/\/media\.licdn\.com\/ad-image\.jpg/);

    const badMismatch = await env.run(linkedinAdLibraryAction, { action: "detail", ad_id: "999999" });
    assert.equal(badMismatch.status, "failed");
    assert.match(badMismatch.text, /instead of requested ad 999999/);
  });

  test("rejects misplaced arguments, half date ranges, and invalid URLs before any request", async () => {
    const env = makeTestEnv(() => jsonResponse({ success: true, ads: [] }));
    for (const bad of [
      { action: "search" },
      { action: "search", company_name: "Acme", ad_id: "1" },
      { action: "search", company_name: "Acme", start_date: daysAgo(10) },
      { action: "search", company_name: "Acme", countries: "USA" },
      { action: "detail", url: "https://evil.example/ad-library/detail/1" },
      { action: "detail", ad_id: "1", url: "https://www.linkedin.com/ad-library/detail/1" },
    ]) {
      assert.equal((await env.run(linkedinAdLibraryAction, bad)).status, "failed", JSON.stringify(bad));
    }
    assert.equal(env.requests.length, 0);
  });
});
