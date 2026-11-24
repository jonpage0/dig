import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp, type RetainedResponse } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext, type AnyActionDefinition } from "../../core/plugin.ts";
import tiktokSource, {
  scrapecreatorsTiktokAction,
  tiktokCommentsAction,
  tiktokReadAction,
  tiktokSource as namedTikTokSource,
  tiktokTopAction,
} from "./index.ts";

interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string>;
}

type MockHandler = (req: RecordedRequest) => Response | { readonly error: string };

const TIK = "https://www.tiktok.com/@fixture/video/1234567890123456789";

function makeTestEnv(handler: MockHandler, signal?: AbortSignal, onKeep?: (resp: RetainedResponse) => void) {
  const requests: RecordedRequest[] = [];
  const retained: RetainedResponse[] = [];
  const base = HttpClient.make((req) =>
    Effect.gen(function* () {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v);
      const rec: RecordedRequest = { url, method: req.method, headers };
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
    signal: signal ?? new AbortController().signal,
    progress: () => {},
    keep: (label, status, body, headers) => {
      const entry: RetainedResponse = { label, status, body, ...(headers ? { headers } : {}) };
      retained.push(entry);
      onKeep?.(entry);
    },
  };
  return {
    requests,
    retained,
    run: <A extends AnyActionDefinition>(action: A, rawArgs: unknown) => {
      const decoded = decodeActionArgs(action, rawArgs);
      if (!decoded.ok) {
        return Promise.resolve({ status: "failed" as const, text: decoded.error, details: { cost: null } });
      }
      return Effect.runPromise(executeAction(action, decoded.args, ctx).pipe(Effect.provide(layer)));
    },
    runDirect: <A extends AnyActionDefinition>(action: A, args: unknown) =>
      Effect.runPromise(executeAction(action, args as never, ctx).pipe(Effect.provide(layer))),
  };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const tiktokFixture = (id: string, playCount?: number) => ({
  aweme_info: {
    aweme_id: id,
    desc: `video ${id} #tag`,
    create_time: 1757980800,
    share_url: `https://www.tiktok.com/@creator/video/${id}?lang=en`,
    author: { unique_id: "creator" },
    statistics: {
      ...(playCount === undefined ? {} : { play_count: playCount }),
      digg_count: 10,
      comment_count: 2,
      share_count: 1,
    },
    text_extra: [{ hashtag_name: "tag" }],
    video: { duration: 28459 },
  },
});

const postBody = {
  success: true,
  credits_charged: 1,
  credits_remaining: 999999,
  aweme_detail: {
    aweme_id: "1234567890123456789",
    desc: "Caption",
    statistics: { play_count: null },
  },
};

describe("tiktok source plugin", () => {
  const savedKey = process.env.SCRAPECREATORS_API_KEY;

  beforeEach(() => {
    process.env.SCRAPECREATORS_API_KEY = "tiktok-test-secret-key";
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
    else process.env.SCRAPECREATORS_API_KEY = savedKey;
  });

  test("exports tiktokSource as named and default with expected metadata and 4 actions", () => {
    assert.equal(tiktokSource, namedTikTokSource);
    assert.equal(tiktokSource.id, "tiktok");
    assert.equal(tiktokSource.group, "social");
    assert.deepEqual(
      tiktokSource.actions.map((a) => a.name),
      ["scrapecreators_tiktok", "tiktok_top", "tiktok_comments", "tiktok_read"],
    );
  });

  test("scrapecreators_tiktok searches, deduplicates, cleans VTT transcripts, and reports metered credits", async () => {
    const env = makeTestEnv((req) => {
      if (req.url.pathname === "/v1/tiktok/search/keyword") {
        return jsonResponse({
          success: true,
          credits_charged: 1,
          cursor: 20,
          has_more: true,
          search_item_list: [tiktokFixture("1", 5000), tiktokFixture("1", 5000), tiktokFixture("2")],
        });
      }
      if (req.url.pathname === "/v1/tiktok/video/transcript") {
        return jsonResponse({
          success: true,
          credits_charged: 1,
          transcript: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello <b>TikTok</b> world",
        });
      }
      return jsonResponse({ success: false }, 404);
    });

    const result = await env.run(scrapecreatorsTiktokAction, {
      query: "coffee",
      date_posted: "this-week",
      sort_by: "most-liked",
      region: "us",
      transcript_limit: 1,
    });
    assert.equal(result.status, "success");
    assert.equal(env.requests.length, 2);
    assert.equal(env.requests[0].url.searchParams.get("region"), "US");
    assert.equal(env.requests[0].url.searchParams.get("sort_by"), "most-liked");
    assert.match(result.text, /1 duplicate dropped/);
    assert.match(result.text, /Views: n\/a \| Likes: 10/);
    assert.match(result.text, /Transcript: Hello TikTok world/);
    assert.deepEqual(result.details?.cost, [{ amount: 2, unit: "credits" }]);
  });

  test("scrapecreators_tiktok records unknown total with knownCost subtotal when transcript omits credits", async () => {
    const env = makeTestEnv((req) => {
      if (req.url.pathname === "/v1/tiktok/search/keyword") {
        return jsonResponse({ success: true, credits_charged: 1, search_item_list: [tiktokFixture("1", 5)] });
      }
      return jsonResponse({ success: false, error: "Upstream unavailable" }, 502);
    });

    const result = await env.run(scrapecreatorsTiktokAction, { query: "x", transcript_limit: 1 });
    assert.equal(result.status, "partial");
    assert.match(result.text, /Credits charged: 1 reported, plus 1 request that did not report a charge/);
    assert.equal(result.details?.cost, null);
    assert.deepEqual(result.details?.knownCost, [{ amount: 1, unit: "credits" }]);
  });

  test("tiktok_top uppercases region, deduplicates, and rejects invalid region before any request", async () => {
    const env = makeTestEnv(() => jsonResponse({ success: true, credits_charged: 1, items: [{ id: "1" }, { id: "1" }] }));
    const ok = await env.run(tiktokTopAction, { query: "robot", region: "us" });
    assert.equal(ok.status, "success");
    assert.equal(env.requests[0].url.searchParams.get("region"), "US");
    assert.deepEqual(ok.details?.cost, [{ amount: 1, unit: "credits" }]);

    const bad = await env.run(tiktokTopAction, { query: "robot", region: "usa" });
    assert.equal(bad.status, "failed");
    assert.equal(env.requests.length, 1);
  });

  test("tiktok_comments honours explicit last-page flags and reports continuation when present", async () => {
    for (const end of [{ has_more: 0 }, { has_more: false }, { end_of_pagination: true }]) {
      const env = makeTestEnv(() =>
        jsonResponse({ success: true, credits_charged: 1, comments: [{ cid: "1", text: "Hi" }], cursor: 40, ...end }),
      );
      const res = await env.run(tiktokCommentsAction, { url: TIK });
      assert.equal(res.status, "success");
      assert.doesNotMatch(res.text, /More data may exist/);
    }
    const envMore = makeTestEnv(() =>
      jsonResponse({ success: true, credits_charged: 1, comments: [{ cid: "1", text: "Hi" }], cursor: 40 }),
    );
    const more = await envMore.run(tiktokCommentsAction, { url: TIK });
    assert.equal(more.status, "success");
    assert.match(more.text, /More data may exist; use the returned continuation/);
  });

  test("tiktok_read photo post disables downloads, preserves null metrics, and strips credits_remaining", async () => {
    const env = makeTestEnv(() =>
      jsonResponse({
        ...postBody,
        aweme_detail: {
          ...postBody.aweme_detail,
          image_post_info: { images: [{ display_image: { url_list: ["https://images.example/photo.jpg"] } }] },
        },
      }),
    );
    const result = await env.run(tiktokReadAction, {
      kind: "post",
      url: TIK.replace("/video/", "/photo/"),
      region: "us",
      cacheMaxAge: "1d",
    });
    assert.equal(result.status, "success");
    assert.deepEqual(result.details?.cost, [{ amount: 1, unit: "credits" }]);
    assert.match(result.text, /image_post_info/);
    assert.match(result.text, /"play_count": null/);
    assert.doesNotMatch(result.text, /credits_remaining|999999/);
    assert.equal(env.requests[0].url.pathname, "/v2/tiktok/video");
    assert.equal(env.requests[0].url.searchParams.get("download_media"), "false");
    assert.equal(env.requests[0].url.searchParams.get("get_transcript"), "false");
    assert.equal(env.requests[0].url.searchParams.get("region"), "US");
  });

  test("tiktok_read standalone transcript keeps VTT timestamps and disables long transcription", async () => {
    const env = makeTestEnv(() =>
      jsonResponse({
        success: true,
        credits_charged: 1,
        transcript: "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nCaption words",
        id: "1234567890123456789",
      }),
    );
    const result = await env.run(tiktokReadAction, {
      kind: "transcript",
      url: TIK,
      language: "EN",
      aiFallback: true,
    });
    assert.equal(result.status, "success");
    assert.match(result.text, /00:00:01/);
    assert.equal(env.requests[0].url.searchParams.get("allow_long_transcription"), "false");
    assert.equal(env.requests[0].url.searchParams.get("use_ai_as_fallback"), "true");
    assert.equal(env.requests[0].url.searchParams.get("language"), "en");
  });

  test("tiktok_read validates arguments before any paid request and never retries transport errors", async () => {
    const env = makeTestEnv(() => ({ error: "timeout" }));
    for (const bad of [
      { kind: "post", url: "http://www.tiktok.com/@fixture/video/1" },
      { kind: "post", url: "https://www.tiktok.com.evil.example/@fixture/video/1" },
      { kind: "post", url: TIK, aiFallback: true },
      { kind: "profile", handle: "https://www.tiktok.com/@fixture" },
      { kind: "posts", handle: "fixture", cacheMaxAge: "1d" },
      { kind: "replies", url: TIK, commentId: "1", cursor: "6" },
    ]) {
      const r = await env.runDirect(tiktokReadAction, bad);
      assert.equal(r.status, "failed");
    }
    assert.equal(env.requests.length, 0);

    const failedNet = await env.run(tiktokReadAction, { kind: "post", url: TIK });
    assert.equal(failedNet.status, "failed");
    assert.equal(env.requests.length, 1);
    assert.match(failedNet.text, /no complete response arrived; its cost is unknown/);
    assert.equal(failedNet.details?.cost, null);
    assert.deepEqual(
      env.retained.map((r) => r.status),
      ["error"],
    );
  });

  test("tiktok_read redacts echoed API key and preserves subtotal on abort", async () => {
    const env1 = makeTestEnv(() =>
      jsonResponse({
        ...postBody,
        aweme_detail: { ...postBody.aweme_detail, desc: "leak tiktok-test-secret-key here" },
      }),
    );
    const res1 = await env1.run(tiktokReadAction, { kind: "post", url: TIK });
    assert.equal(res1.status, "success");
    assert.ok(!JSON.stringify([res1, env1.retained]).includes("tiktok-test-secret-key"));

    const controller = new AbortController();
    const env2 = makeTestEnv(
      () => jsonResponse(postBody),
      controller.signal,
      () => controller.abort(),
    );
    const stopped = await env2.run(tiktokReadAction, { kind: "post", url: TIK });
    assert.equal(stopped.status, "cancelled");
    assert.equal(stopped.details?.cost, null);
    assert.deepEqual(stopped.details?.knownCost, [{ amount: 1, unit: "credits" }]);
  });
});
