import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext, type AnyActionDefinition } from "../../core/plugin.ts";
import googleAdsSource, { googleAdLibraryAction, googleAdsSource as namedGoogleAdsSource } from "./index.ts";

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

const AD_URL =
  "https://adstransparency.google.com/advertiser/AR07541154843046445057/creative/CR17778900238552006657";

describe("google-ads source plugin", () => {
  const savedKey = process.env.SCRAPECREATORS_API_KEY;

  beforeEach(() => {
    process.env.SCRAPECREATORS_API_KEY = "google-ads-test-key";
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
    else process.env.SCRAPECREATORS_API_KEY = savedKey;
  });

  test("exports googleAdsSource as named and default with expected metadata", () => {
    assert.equal(googleAdsSource, namedGoogleAdsSource);
    assert.equal(googleAdsSource.id, "google-ads");
    assert.equal(googleAdsSource.group, "markets");
    assert.deepEqual(
      googleAdsSource.actions.map((a) => a.name),
      ["google_ad_library"],
    );
  });

  test("advertisers search formats advertisers, websites, and meters credits", async () => {
    const env = makeTestEnv(() =>
      jsonResponse({
        success: true,
        credits_charged: 1,
        advertisers: [
          { name: "Lululemon", advertiser_id: "AR07541154843046445057", region: "US", number_of_ads_estimate: 500 },
        ],
        websites: [{ domain: "lululemon.com" }],
      }),
    );
    const res = await env.run(googleAdLibraryAction, { action: "advertisers", query: "lululemon", country: "us" });
    assert.equal(res.status, "success");
    assert.equal(env.requests[0].url.searchParams.get("region"), "US");
    assert.match(res.text, /AR07541154843046445057/);
    assert.match(res.text, /lululemon\.com/);
    assert.deepEqual(res.details?.cost, [{ amount: 1, unit: "credits" }]);
  });

  test("ads lists creatives, preserves cursor and limit note, and detail validates creative identity", async () => {
    const envAds = makeTestEnv(() =>
      jsonResponse({
        success: true,
        credits_charged: 1,
        cursor: "next-g",
        number_of_ads_estimate: 42,
        ads: [
          {
            advertiserId: "AR07541154843046445057",
            creativeId: "CR17778900238552006657",
            advertiserName: "Lululemon",
            format: "image",
            firstShown: "2026-09-01",
            lastShown: "2026-10-01",
          },
          {
            advertiserId: "AR07541154843046445057",
            creativeId: "CR222",
            advertiserName: "Lululemon",
            format: "text",
          },
        ],
      }),
    );
    const adsRes = await envAds.run(googleAdLibraryAction, {
      action: "ads",
      domain: "LULULEMON.COM",
      format: "image",
      limit: 1,
    });
    assert.equal(adsRes.status, "success");
    assert.equal(envAds.requests[0].url.searchParams.get("domain"), "lululemon.com");
    assert.match(adsRes.text, /1 shown of 2 returned/);
    assert.match(adsRes.text, /pass cursor="next-g"/);

    const envDetail = makeTestEnv(() =>
      jsonResponse({
        success: true,
        credits_charged: 1,
        advertiserId: "AR07541154843046445057",
        creativeId: "CR17778900238552006657",
        format: "text",
        firstShown: null,
        lastShown: "2026-10-01",
        overallImpressions: { min: 1000, max: 2000 },
        spend: { currency: "USD", lower: 100, upper: 500 },
        variations: [{ headline: "Run light", destinationUrl: "https://shop.lululemon.com" }],
      }),
    );
    const det = await envDetail.run(googleAdLibraryAction, { action: "detail", url: AD_URL });
    assert.equal(det.status, "success");
    assert.match(det.text, /Impressions \(Google's range\): 1\.0K–2\.0K/);
    assert.match(det.text, /Spend \(Google's range\): 100–500 USD/);
    assert.match(det.text, /Headline: Run light/);
  });

  test("rejects invalid arguments before sending any request", async () => {
    const env = makeTestEnv(() => jsonResponse({ success: true, ads: [] }));
    for (const bad of [
      { action: "advertisers", query: "x", domain: "x.com" },
      { action: "ads", domain: "https://lululemon.com" },
      { action: "ads", advertiser_id: "BAD123" },
      { action: "ads", domain: "lululemon.com", start_date: "2026-02-30" },
      { action: "detail", url: "https://evil.example/advertiser/AR1/creative/CR1" },
    ]) {
      assert.equal((await env.run(googleAdLibraryAction, bad)).status, "failed", JSON.stringify(bad));
    }
    assert.equal(env.requests.length, 0);
  });
});
