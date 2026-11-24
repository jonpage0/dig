import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext, type AnyActionDefinition } from "../../core/plugin.ts";
import facebookAdsSource, { facebookAdLibraryAction, facebookAdsSource as namedFacebookAdsSource } from "./index.ts";

interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
}

function makeTestEnv(handler: (req: RecordedRequest) => Response | { readonly error: string }) {
  const requests: RecordedRequest[] = [];
  const base = HttpClient.make((req) =>
    Effect.gen(function* () {
      const rec = { url: new URL(req.url), method: req.method };
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

describe("facebook-ads source plugin", () => {
  const savedKey = process.env.SCRAPECREATORS_API_KEY;

  beforeEach(() => {
    process.env.SCRAPECREATORS_API_KEY = "fb-ads-test-key";
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
    else process.env.SCRAPECREATORS_API_KEY = savedKey;
  });

  test("exports facebookAdsSource as named and default with expected metadata", () => {
    assert.equal(facebookAdsSource, namedFacebookAdsSource);
    assert.equal(facebookAdsSource.id, "facebook-ads");
    assert.equal(facebookAdsSource.group, "markets");
    assert.deepEqual(
      facebookAdsSource.actions.map((a) => a.name),
      ["facebook_ad_library"],
    );
  });

  test("search uses GET for first page and POST for cursor continuation, and meters credits", async () => {
    const env = makeTestEnv(() =>
      jsonResponse({
        success: true,
        credits_charged: 1,
        searchResultsCount: 25,
        cursor: "cur-2",
        searchResults: [
          {
            ad_archive_id: "702369045530963",
            page_name: "Acme Gear",
            page_id: "101",
            is_active: true,
            start_date: 1759276800,
            publisher_platform: ["FACEBOOK", "INSTAGRAM"],
            snapshot: {
              body: { text: "Shop summer gear" },
              title: "Summer Sale",
              cta_text: "Shop Now",
            },
          },
        ],
      }),
    );

    const p1 = await env.run(facebookAdLibraryAction, { kind: "search", query: "gear", country: "us" });
    assert.equal(p1.status, "success");
    assert.equal(env.requests[0].method, "GET");
    assert.equal(env.requests[0].url.searchParams.get("country"), "US");
    assert.match(p1.text, /Acme Gear — ad 702369045530963 — active/);
    assert.deepEqual(p1.details?.cost, [{ amount: 1, unit: "credits" }]);

    const p2 = await env.run(facebookAdLibraryAction, { kind: "search", query: "gear", cursor: "cur-2" });
    assert.equal(p2.status, "success");
    assert.equal(env.requests[1].method, "POST");
    assert.match(p2.text, /cursor sent by POST/);
  });

  test("ad detail formats regulated transparency data and transcript handles empty free response", async () => {
    const env = makeTestEnv((req) => {
      if (req.url.pathname.endsWith("/ad")) {
        return jsonResponse({
          success: true,
          credits_charged: 1,
          adArchiveID: "702369045530963",
          pageName: "Civic Voice",
          pageID: "55",
          isActive: true,
          snapshot: { body: "Line 1<br />Line 2" },
          aaa_info: { targets_eu: true, eu_total_reach: 12000, payer_beneficiary_data: [{ payer: "Org A", beneficiary: "Org A" }] },
        });
      }
      return jsonResponse({
        success: true,
        credits_charged: 0,
        data: { ad_id: "702369045530963", transcript: null, transcript_available: false },
      });
    });

    const ad = await env.run(facebookAdLibraryAction, { kind: "ad", ad_id: "702369045530963" });
    assert.equal(ad.status, "success");
    assert.match(ad.text, /EU total reach: 12000/);
    assert.match(ad.text, /payer Org A, beneficiary Org A/);

    const tr = await env.run(facebookAdLibraryAction, { kind: "transcript", ad_id: "702369045530963" });
    assert.equal(tr.status, "empty");
    assert.deepEqual(tr.details?.cost, []);
  });

  test("rejects misplaced arguments and bad dates/ids before any request", async () => {
    const env = makeTestEnv(() => jsonResponse({ success: true }));
    for (const bad of [
      { kind: "companies", query: "acme", country: "US" },
      { kind: "company", page_id: "not-numeric" },
      { kind: "ad", ad_id: "1", url: "https://www.facebook.com/ads/library?id=1" },
      { kind: "search", query: "x", start_date: "2026-02-30" },
    ]) {
      assert.equal((await env.run(facebookAdLibraryAction, bad)).status, "failed", JSON.stringify(bad));
    }
    assert.equal(env.requests.length, 0);
  });
});
