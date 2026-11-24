import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext, type AnyActionDefinition } from "../../core/plugin.ts";
import tiktokAdsSource, {
  tiktokAdLibraryAction,
  tiktokAdsDetailAction,
  tiktokAdsSearchAction,
  tiktokAdsSource as namedTikTokAdsSource,
  tiktokAdsTopAction,
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

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const tikhubWrap = (data: unknown) => jsonResponse({ code: 200, data: { code: 0, msg: "OK", data } });

describe("tiktok-ads source plugin", () => {
  const savedTikHub = process.env.TIKHUB_API_KEY;
  const savedSc = process.env.SCRAPECREATORS_API_KEY;

  beforeEach(() => {
    process.env.TIKHUB_API_KEY = "tikhub-ads-test-key";
    process.env.SCRAPECREATORS_API_KEY = "sc-ads-test-key";
  });

  afterEach(() => {
    if (savedTikHub === undefined) delete process.env.TIKHUB_API_KEY;
    else process.env.TIKHUB_API_KEY = savedTikHub;
    if (savedSc === undefined) delete process.env.SCRAPECREATORS_API_KEY;
    else process.env.SCRAPECREATORS_API_KEY = savedSc;
  });

  test("exports tiktokAdsSource as named and default with 4 actions", () => {
    assert.equal(tiktokAdsSource, namedTikTokAdsSource);
    assert.equal(tiktokAdsSource.id, "tiktok-ads");
    assert.equal(tiktokAdsSource.group, "markets");
    assert.deepEqual(
      tiktokAdsSource.actions.map((a) => a.name),
      ["tiktok_ads_search", "tiktok_ads_top", "tiktok_ads_detail", "tiktok_ad_library"],
    );
  });

  test("tiktok_ads_search resolves industry names, rejects unknown names, and records unknown cost", async () => {
    const env = makeTestEnv(() =>
      tikhubWrap({
        materials: [
          {
            id: "ad-1",
            ad_title: "Summer Flights",
            brand_name: "FlyFast",
            industry_key: "label_17000000000",
            objective_key: "campaign_objective_traffic",
            ctr: 0.042,
            like: 1500,
            cost: 2,
          },
        ],
        pagination: { total_count: 1, has_more: false },
      }),
    );

    const res = await env.run(tiktokAdsSearchAction, {
      keyword: "flights",
      industry: "Travel, Live Events",
      period: 30,
      objective: "traffic",
      performance: "top_20",
    });
    assert.equal(res.status, "success");
    assert.equal(res.details?.cost, null);
    assert.equal((env.requests[0].body as Record<string, unknown>).industry, "17000000000,23110000000");
    assert.match(res.text, /Summer Flights/);
    assert.match(res.text, /Industry: Travel/);

    const bad = await env.run(tiktokAdsSearchAction, { industry: "Nonexistent Industry" });
    assert.equal(bad.status, "failed");
    assert.equal(env.requests.length, 1);
  });

  test("tiktok_ads_top rejects multiple industries and formats spotlight results", async () => {
    const env = makeTestEnv(() =>
      tikhubWrap({
        materials: [{ id: "sp-1", brand_name: "GlowCo", ctr: 0.05, like: 800, highlight: "Strong hook" }],
        pagination: { total: 1, has_more: false },
      }),
    );
    const bad = await env.run(tiktokAdsTopAction, { industry: "Travel, Pets" });
    assert.equal(bad.status, "failed");
    assert.equal(env.requests.length, 0);

    const ok = await env.run(tiktokAdsTopAction, { industry: "Travel" });
    assert.equal(ok.status, "success");
    assert.match(ok.text, /Why it works \(TikTok\): Strong hook/);
  });

  test("tiktok_ads_detail fetches analytics and promotes sub-industry to top-level for similar ads", async () => {
    const env = makeTestEnv((req) => {
      if (req.url.pathname.endsWith("/get_ads_detail")) {
        return tikhubWrap({
          id: "ad-99",
          ad_title: "Hotel Promo",
          industry_key: "label_17103000000",
          country_code: ["US"],
          ctr: 0.06,
          like: 500,
        });
      }
      if (req.url.pathname.endsWith("/get_ad_percentile")) return tikhubWrap({ ctr_percentile: 0.85 });
      if (req.url.pathname.endsWith("/get_ad_keyframe_analysis")) {
        return tikhubWrap({
          duration: 15,
          analysis: [
            { second: 0, value: 1.0 },
            { second: 3, value: 0.6 },
          ],
          highlight: [2],
        });
      }
      if (req.url.pathname.endsWith("/get_recommended_ads")) {
        return tikhubWrap({ materials: [{ id: "sim-1", ad_title: "Similar Hotel", ctr: 0.04, like: 200 }] });
      }
      return jsonResponse({}, 404);
    });

    const res = await env.run(tiktokAdsDetailAction, { ad_id: "ad-99", analytics: true, similar: true });
    assert.equal(res.status, "success");
    assert.equal(res.details?.cost, null);
    const recReq = env.requests.find((r) => r.url.pathname.endsWith("/get_recommended_ads"));
    assert.equal((recReq?.body as Record<string, unknown>).industry, "17000000000");
    assert.match(res.text, /CTR percentile within industry \(180d\): 85%/);
    assert.match(res.text, /Similar Hotel/);
  });

  test("tiktok_ad_library calls ScrapeCreators, meters credits, and enforces advertiser_name with adv_biz_ids", async () => {
    const env = makeTestEnv(() =>
      jsonResponse({
        success: true,
        credits_charged: 1,
        total: 2,
        has_more: true,
        cursor: "lib-2",
        advertiser_matches: [{ name: "Acme", ids: "biz-123" }],
        ads: [
          {
            id: "111",
            name: "Acme",
            adv_biz_ids: "biz-123",
            first_shown_date: 1759276800000,
            last_shown_date: 1760000000000,
            estimated_audience: "10K-100K",
            videos: [{ cover_img: "https://cdn.example/c.jpg" }],
          },
        ],
      }),
    );

    const bad = await env.run(tiktokAdLibraryAction, { adv_biz_ids: "biz-123" });
    assert.equal(bad.status, "failed");
    assert.equal(env.requests.length, 0);

    const ok = await env.run(tiktokAdLibraryAction, { advertiser_name: "Acme", adv_biz_ids: "biz-123" });
    assert.equal(ok.status, "success");
    assert.deepEqual(ok.details?.cost, [{ amount: 1, unit: "credits" }]);
    assert.match(ok.text, /Requested exact advertiser business IDs: biz-123/);
    assert.match(ok.text, /pass cursor="lib-2"/);
  });
});
