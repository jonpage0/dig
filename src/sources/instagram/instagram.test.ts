import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp, type RetainedResponse } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext, type AnyActionDefinition } from "../../core/plugin.ts";
import instagramSource, {
  instagramCommentsAction,
  instagramReadAction,
  instagramSource as namedInstagramSource,
  scrapecreatorsInstagramAction,
} from "./index.ts";

interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
}

type MockHandler = (req: RecordedRequest) => Response | { readonly error: string };

const IG = "https://www.instagram.com/p/Fixture_123/";

function makeTestEnv(handler: MockHandler) {
  const requests: RecordedRequest[] = [];
  const retained: RetainedResponse[] = [];
  const base = HttpClient.make((req) =>
    Effect.gen(function* () {
      const rec: RecordedRequest = { url: new URL(req.url), method: req.method };
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
    keep: (label, status, body, headers) => retained.push({ label, status, body, ...(headers ? { headers } : {}) }),
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

const reelFixture = {
  id: "3723045213787686915",
  shortcode: "DOq6eV6iIgD",
  url: "https://www.instagram.com/reel/DOq6eV6iIgD/",
  caption: "Dogs are family #rescuedog",
  video_duration: 75.7,
  owner: { username: "fetchmycamera_", is_verified: true, follower_count: 188406 },
  taken_at: "2025-09-16T16:56:45.000Z",
  like_count: 3487,
  comment_count: 90,
  comments: [{ text: "Lovely pics", owner: { username: "anakaren" } }],
};

describe("instagram source plugin", () => {
  const savedKey = process.env.SCRAPECREATORS_API_KEY;

  beforeEach(() => {
    process.env.SCRAPECREATORS_API_KEY = "ig-test-secret-key";
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
    else process.env.SCRAPECREATORS_API_KEY = savedKey;
  });

  test("exports instagramSource as named and default with expected metadata and 3 actions", () => {
    assert.equal(instagramSource, namedInstagramSource);
    assert.equal(instagramSource.id, "instagram");
    assert.equal(instagramSource.group, "social");
    assert.deepEqual(
      instagramSource.actions.map((a) => a.name),
      ["scrapecreators_instagram", "instagram_comments", "instagram_read"],
    );
  });

  test("scrapecreators_instagram reels reports absent views as unavailable and enriches only when enrich_views=true", async () => {
    const env = makeTestEnv((req) => {
      if (req.url.pathname === "/v2/instagram/reels/search") {
        return jsonResponse({ success: true, credits_charged: 1, reels: [reelFixture] });
      }
      if (req.url.pathname === "/v1/instagram/post") {
        return jsonResponse({
          success: true,
          credits_charged: 0,
          cached: true,
          cached_at: "2026-10-01",
          data: { xdt_shortcode_media: { video_play_count: 12500 } },
        });
      }
      return jsonResponse({ success: false }, 404);
    });

    const basic = await env.run(scrapecreatorsInstagramAction, {
      query: "dogs",
      transcripts: false,
      date_posted: "last-week",
      page: 2,
    });
    assert.equal(basic.status, "success");
    assert.match(basic.text, /Views: unavailable \| Likes: 3\.5K \| Comments: 90/);
    assert.doesNotMatch(basic.text, /Views: 0/);
    assert.deepEqual(basic.details?.cost, [{ amount: 1, unit: "credits" }]);

    const enriched = await env.run(scrapecreatorsInstagramAction, {
      query: "dogs",
      transcripts: false,
      enrich_views: true,
      cache_max_age: "7d",
    });
    assert.equal(enriched.status, "success");
    assert.match(enriched.text, /Views: 12\.5K \(post lookup\)/);
    assert.equal(env.requests.at(-1)?.url.searchParams.get("cache_max_age"), "7d");
  });

  test("scrapecreators_instagram native and popular modes work and distinguish missing transcripts from null", async () => {
    const envNative = makeTestEnv(() =>
      jsonResponse({
        success: true,
        credits_charged: 1,
        users: [{ username: "nasa", full_name: "NASA", is_verified: true }],
        hashtags: [{ name: "space", media_count: 12000 }],
        places: [],
        keywords: ["space exploration"],
      }),
    );
    const native = await envNative.run(scrapecreatorsInstagramAction, { query: "nasa", mode: "native" });
    assert.equal(native.status, "success");
    assert.match(native.text, /@nasa — NASA \(verified\)/);
    assert.match(native.text, /#space — 12\.0K posts/);

    const second = { ...reelFixture, id: "2", shortcode: "second", url: "https://www.instagram.com/reel/second/" };
    const envPop = makeTestEnv((req) => {
      if (req.url.pathname === "/v1/instagram/search/popular") {
        return jsonResponse({
          success: true,
          credits_charged: 1,
          posts: [{ ...reelFixture, type: "reel" }, { ...second, type: "reel" }],
          cursor: "next-pop",
        });
      }
      if (req.url.searchParams.get("url") === reelFixture.url) {
        return jsonResponse({ success: true, credits_charged: 1 });
      }
      return jsonResponse({ success: true, credits_charged: 1, transcripts: null });
    });
    const pop = await envPop.run(scrapecreatorsInstagramAction, {
      query: "dogs",
      mode: "popular",
      transcript_limit: 2,
    });
    assert.equal(pop.status, "partial");
    assert.match(pop.text, /Transcript: provider reported no speech \(transcripts: null\)/);
    assert.match(pop.text, /Transcripts: 0 fetched of 2 requested \(reels\/videos only\); 1 failed/);
    assert.deepEqual(pop.details?.cost, [{ amount: 3, unit: "credits" }]);
  });

  test("instagram_comments refuses invalid URLs before any paid request and accepts post/reel URLs", async () => {
    const env = makeTestEnv(() => jsonResponse({ success: true, credits_charged: 1, comments: [{ id: "1", text: "Hi" }] }));
    for (const url of [
      "https://www.instagram.com/reels/Fixture_123/",
      "https://www.instagram.com/fixture/reel/Fixture_123/",
      "https://www.instagram.com/fixture/",
    ]) {
      assert.equal((await env.run(instagramCommentsAction, { url })).status, "failed", url);
      assert.equal((await env.run(instagramReadAction, { kind: "replies", url, commentId: "1" })).status, "failed", url);
    }
    assert.equal(env.requests.length, 0);
    assert.equal((await env.run(instagramCommentsAction, { url: IG })).status, "success");
    assert.equal(
      (await env.run(instagramCommentsAction, { url: "https://www.instagram.com/reel/Fixture_123/" })).status,
      "success",
    );
  });

  test("instagram_read P0 fix: confirmed restricted profiles on HTTP 200/403/404 return partial, generic 403/404/401 still fail", async () => {
    // Oct 2026 uncharged HTTP 403/404 restriction responses with success:false
    for (const kind of ["profile", "posts"] as const) {
      const envAge = makeTestEnv(() =>
        jsonResponse(
          {
            success: false,
            error: "forbidden",
            errorStatus: 403,
            age_restricted: true,
            credits_charged: 0,
            message: "Profile is age restricted",
          },
          403,
        ),
      );
      const age = await envAge.run(instagramReadAction, { kind, handle: "fixture" });
      assert.equal(age.status, "partial");
      assert.match(age.text, /Provider-reported resource state: Profile is age restricted/);
      assert.deepEqual(age.details?.cost, []);

      for (const message of ["Profile is restricted", "Profile is unavailable on Instagram"]) {
        const env404 = makeTestEnv(() =>
          jsonResponse({ success: false, error: "not_found", errorStatus: 404, credits_charged: 0, message }, 404),
        );
        const restricted = await env404.run(instagramReadAction, { kind, handle: "fixture" });
        assert.equal(restricted.status, "partial");
        assert.match(restricted.text, new RegExp(`Provider-reported resource state: ${message}`));
        assert.deepEqual(restricted.details?.cost, []);
      }
    }

    // Age-restricted 403 with age_restricted:true
    const envAgeFlag = makeTestEnv(() =>
      jsonResponse({ success: false, age_restricted: true, credits_charged: 0, message: "Profile is age restricted" }, 403),
    );
    assert.equal((await envAgeFlag.run(instagramReadAction, { kind: "profile", handle: "fixture" })).status, "partial");

    // Confirmed 200/403/404 with success:true
    for (const status of [200, 403, 404]) {
      const envOk = makeTestEnv(() =>
        jsonResponse({ success: true, credits_charged: 0, message: "Profile is age restricted", age_restricted: true }, status),
      );
      assert.equal((await envOk.run(instagramReadAction, { kind: "profile", handle: "fixture" })).status, "partial");
    }

    // Private profile returned with user record -> partial
    const envPriv = makeTestEnv(() =>
      jsonResponse({ success: true, credits_charged: 1, data: { user: { id: "1", is_private: true } } }),
    );
    assert.equal((await envPriv.run(instagramReadAction, { kind: "profile", handle: "fixture" })).status, "partial");

    // Generic 403/404/401 failures MUST still fail
    const failures: Array<[Record<string, unknown>, number]> = [
      [{ success: false, error: "forbidden", errorStatus: 403, message: "Invalid API key" }, 403],
      [{ success: false, message: "Profile is age restricted" }, 403],
      [{ success: false, message: "Profile is private" }, 403],
      [{ success: true, message: "Invalid API key" }, 403],
      [{ success: false, error: "not_found", errorStatus: 404, message: "Endpoint not found" }, 404],
      [{ success: false, error: "not_found", errorStatus: 404, message: "Not found" }, 404],
      [{ success: false, message: "Profile is restricted" }, 404],
      [{ success: false, error: "forbidden", errorStatus: 401, age_restricted: true, message: "Profile is age restricted" }, 401],
    ];
    for (const [body, status] of failures) {
      const envFail = makeTestEnv(() => jsonResponse(body, status));
      assert.equal(
        (await envFail.run(instagramReadAction, { kind: "profile", handle: "fixture" })).status,
        "failed",
        JSON.stringify({ status, body }),
      );
    }
  });

  test("instagram_read handles posts, reels, carousels, and partial carousel transcripts cleanly", async () => {
    const envFeed = makeTestEnv(() =>
      jsonResponse({ success: true, credits_charged: 1, items: [{ id: "1" }, { no_id: true }, { id: "1" }], more_available: true, next_max_id: "next" }),
    );
    const mixed = await envFeed.run(instagramReadAction, { kind: "posts", handle: "fixture" });
    assert.equal(mixed.status, "partial");
    assert.match(mixed.text, /1 duplicate/);
    assert.match(mixed.text, /1 unrecognized/);

    const envTranscript = makeTestEnv(() =>
      jsonResponse({
        success: true,
        credits_charged: 1,
        transcripts: [{ id: "first", text: "Speech" }, null, { id: "silent", text: null }],
      }),
    );
    const carousel = await envTranscript.run(instagramReadAction, { kind: "transcript", url: IG });
    assert.equal(carousel.status, "partial");
    assert.match(carousel.text, /"id": "first"/);
    assert.equal(envTranscript.requests[0].url.searchParams.get("allow_long_transcription"), "false");
  });
});
