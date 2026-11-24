import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext } from "../../core/plugin.ts";
import { xWebSearchAction } from "./web-search.ts";

const KEY = "sc-test-key-x-web-9999";

function makeLayers(handler: (url: URL) => Response | Error) {
  const calls: URL[] = [];
  const base = HttpClient.make((req) =>
    Effect.gen(function* () {
      const url = new URL(req.url);
      calls.push(url);
      const out = handler(url);
      if (out instanceof Error) {
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request: req, description: out.message }),
          }),
        );
      }
      return HttpClientResponse.fromWeb(req, out);
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(PaidHttp, makePaidClient(base, { resolveDns: false })),
    Layer.succeed(FreeHttp, makeFreeClient(base, { resolveDns: false, retries: 0 })),
  );
  return { calls, layer };
}

function makeCtx(): ActionContext {
  return {
    digId: "test-dig",
    project: "/tmp",
    keep: () => {},
    progress: () => {},
    signal: new AbortController().signal,
  };
}

const liveTweet = {
  __typename: "Tweet",
  rest_id: "2022496971895025679",
  url: "https://x.com/advaithj1/status/2022496971895025679",
  views: { count: "24665" },
  core: {
    user_results: {
      result: {
        is_blue_verified: true,
        core: { screen_name: "advaithj1", name: "advaith" },
        legacy: { followers_count: 18500 },
      },
    },
  },
  legacy: {
    id_str: "2022496971895025679",
    created_at: "Sat Feb 14 02:23:48 +0000 2026",
    full_text: "Check https://t.co/abc",
    favorite_count: 617,
    retweet_count: 42,
    reply_count: 15,
    quote_count: 8,
    bookmark_count: 91,
    entities: { urls: [{ url: "https://t.co/abc", expanded_url: "https://discord.com/developers/docs" }] },
    extended_entities: {
      media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/shot1.png", ext_alt_text: "Modal shot" }],
    },
  },
};

describe("x_web_search action", () => {
  const prevKey = process.env.SCRAPECREATORS_API_KEY;
  beforeEach(() => {
    process.env.SCRAPECREATORS_API_KEY = KEY;
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
    else process.env.SCRAPECREATORS_API_KEY = prevKey;
  });

  it("formats hydrated posts, expands t.co links, prints Media: lines, and records ScrapeCreators credits", async () => {
    const { calls, layer } = makeLayers((url) => {
      assert.equal(url.pathname, "/v1/twitter/search/posts");
      assert.equal(url.searchParams.get("query"), "Discord Components V2");
      return new Response(
        JSON.stringify({
          success: true,
          credits_charged: 1,
          posts: [liveTweet, liveTweet],
          cursor: "2",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const decoded = decodeActionArgs(xWebSearchAction, { query: "Discord Components V2" });
    assert.equal(decoded.ok, true);
    if (!decoded.ok) return;

    const res = await Effect.runPromise(
      executeAction(xWebSearchAction, decoded.args, makeCtx()).pipe(Effect.provide(layer)),
    );
    assert.equal(calls.length, 1);
    assert.equal(res.status, "success");
    assert.deepEqual(res.details?.cost, [{ amount: 1, unit: "credits" }]);
    assert.match(res.text, /1 post \(1 duplicate dropped\)/);
    assert.match(res.text, /Check https:\/\/discord\.com\/developers\/docs/);
    assert.match(res.text, /Media: photo https:\/\/pbs\.twimg\.com\/media\/shot1\.png \(alt text: Modal shot\)/);
    assert.match(res.text, /Next page: pass cursor="2"/);
  });

  it("redacts leaked keys on errors and never retries PaidHttp transport failures", async () => {
    const errMock = makeLayers(
      () =>
        new Response(JSON.stringify({ success: false, error: `No credits for ${KEY}` }), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
    );
    const errRes = await Effect.runPromise(
      executeAction(xWebSearchAction, { query: "test" }, makeCtx()).pipe(Effect.provide(errMock.layer)),
    );
    assert.equal(errRes.status, "failed");
    assert.equal(errRes.details?.cost, null);
    assert.ok(!errRes.text.includes(KEY));
    assert.match(errRes.text, /\[redacted\]/);

    const netMock = makeLayers(() => new Error("connection reset"));
    const netRes = await Effect.runPromise(
      executeAction(xWebSearchAction, { query: "test" }, makeCtx()).pipe(Effect.provide(netMock.layer)),
    );
    assert.equal(netMock.calls.length, 1);
    assert.equal(netRes.status, "failed");
    assert.equal(netRes.details?.cost, null);
    assert.match(netRes.text, /its cost is unknown/);
  });
});
