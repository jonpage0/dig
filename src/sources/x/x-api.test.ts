import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext, type AnyActionDefinition } from "../../core/plugin.ts";
import xDefault, {
  ACCOUNT_READS,
  ARCHIVE_PACING,
  clearSignedInAccountCache,
  POST_READS,
  postId,
  resetArchivePacing,
  X_API_DOCS_URL,
  xBookmarksAction,
  xCommunityAction,
  xCountPostsAction,
  xExploreAction,
  xFollowsAction,
  xImagesAction,
  xLikesAction,
  xNewsAction,
  xPostAction,
  xReads,
  xsearchAction,
  xSearchPostsAction,
  xSource,
  xUsersAction,
} from "./index.ts";

const BEARER = "x-test-bearer-token-1234";
const TIKHUB = "tikhub-test-token-5678";

function makeLayers(handler: (url: URL, headers: Record<string, string>) => Response | Error) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const base = HttpClient.make((req) =>
    Effect.gen(function* () {
      const url = new URL(req.url);
      const headers = req.headers as Record<string, string>;
      calls.push({ url, headers });
      const res = handler(url, headers);
      if (res instanceof Error) {
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request: req, description: res.message }),
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

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

describe("x SourcePlugin & X API actions", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "X_BEARER_TOKEN",
    "X_CONSUMER_KEY",
    "X_CONSUMER_SECRET",
    "X_ACCESS_TOKEN",
    "X_ACCESS_TOKEN_SECRET",
    "TIKHUB_API_KEY",
  ];
  const prevInterval = ARCHIVE_PACING.intervalMs;

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.X_BEARER_TOKEN = BEARER;
    delete process.env.X_CONSUMER_KEY;
    delete process.env.X_CONSUMER_SECRET;
    delete process.env.X_ACCESS_TOKEN;
    delete process.env.X_ACCESS_TOKEN_SECRET;
    delete process.env.TIKHUB_API_KEY;
    clearSignedInAccountCache();
    ARCHIVE_PACING.intervalMs = 0;
    resetArchivePacing();
  });

  afterEach(() => {
    ARCHIVE_PACING.intervalMs = prevInterval;
    clearSignedInAccountCache();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("exports xSource with all 13 actions, clean X API docs billing link, slow xsearch, and returnsImages x_images", () => {
    assert.equal(xSource, xDefault);
    assert.equal(xSource.id, "x");
    assert.equal(xSource.group, "social");
    assert.deepEqual(
      xSource.actions.map((a: AnyActionDefinition) => a.name),
      [
        "xsearch",
        "x_post",
        "x_search_posts",
        "x_web_search",
        "x_count_posts",
        "x_users",
        "x_follows",
        "x_news",
        "x_explore",
        "x_bookmarks",
        "x_likes",
        "x_community",
        "x_images",
      ],
    );
    assert.equal(xsearchAction.slow, true);
    assert.equal(xImagesAction.returnsImages, true);
    assert.ok(xSource.billing.includes(X_API_DOCS_URL));
    assert.ok(xSource.billing.includes('x_explore with kind="list"'));
    assert.equal(postId("https://x.com/alice/status/1900000000000000001"), "1900000000000000001");
    assert.equal(postId("https://example.com/alice/status/123"), null);
  });

  it("x_explore counts xReads honestly when kind='list' and keeps trends/spaces/communities as unknown cost", async () => {
    const { layer } = makeLayers((url) => {
      if (url.pathname === "/2/lists/12345/tweets") {
        return json({
          data: [
            { id: "1001", author_id: "u1", text: "List post one", created_at: "2026-11-20T12:00:00Z" },
            { id: "1002", author_id: "u2", text: "List post two", created_at: "2026-11-20T13:00:00Z" },
          ],
          includes: {
            users: [
              { id: "u1", username: "alice", name: "Alice" },
              { id: "u2", username: "bob", name: "Bob" },
            ],
            posts: [{ id: "1000", author_id: "u1", text: "Quoted post" }],
          },
        });
      }
      if (url.pathname === "/2/trends/by/woeid/1") {
        return json({ data: [{ trend_name: "#EffectTS", tweet_count: 1500 }] });
      }
      return json({ data: [] });
    });

    const listRes = await Effect.runPromise(
      executeAction(xExploreAction, { kind: "list", list: "https://x.com/i/lists/12345", limit: 10 }, makeCtx()).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(listRes.status, "success");
    assert.deepEqual(listRes.details?.cost, [
      { amount: 3, unit: POST_READS },
      { amount: 2, unit: ACCOUNT_READS },
    ]);
    assert.match(listRes.text, /X List 12345/);
    assert.match(listRes.text, /List post one/);

    const trendsRes = await Effect.runPromise(
      executeAction(xExploreAction, { kind: "trends", woeid: 1 }, makeCtx()).pipe(Effect.provide(layer)),
    );
    assert.equal(trendsRes.status, "success");
    assert.equal(trendsRes.details?.cost, null, "Trends must keep unknown cost");
    assert.match(trendsRes.text, /#EffectTS/);
  });

  it("x_post reads posts with xReads counting, falls back to TikHub on single-post failure, and respects X refusal veto", async () => {
    const { layer } = makeLayers((url) => {
      assert.equal(url.pathname, "/2/tweets");
      return json({
        data: [
          {
            id: "1900000000000000001",
            author_id: "u1",
            text: "Exact X post text",
            created_at: "2026-11-20T12:00:00Z",
            public_metrics: { like_count: 50, repost_count: 10, reply_count: 3, quote_count: 1 },
          },
        ],
        includes: {
          users: [{ id: "u1", username: "builder", name: "Builder", verified: true, verified_type: "blue" }],
        },
      });
    });

    const res = await Effect.runPromise(
      executeAction(xPostAction, { posts: ["https://x.com/builder/status/1900000000000000001"] }, makeCtx()).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(res.status, "success");
    assert.deepEqual(res.details?.cost, [
      { amount: 1, unit: POST_READS },
      { amount: 1, unit: ACCOUNT_READS },
    ]);
    assert.match(res.text, /Exact X post text/);

    // Single-post TikHub fallback when X_BEARER_TOKEN is unset -> unknown cost
    delete process.env.X_BEARER_TOKEN;
    process.env.TIKHUB_API_KEY = TIKHUB;
    const tikhubMock = makeLayers((url) => {
      assert.equal(url.pathname, "/api/v1/twitter/web/fetch_tweet_detail");
      return json({
        code: 200,
        data: {
          id: "1900000000000000001",
          text: "Fallback post text",
          author: { screen_name: "builder", name: "Builder" },
          likes: 50,
        },
      });
    });
    const fallbackRes = await Effect.runPromise(
      executeAction(xPostAction, { posts: ["1900000000000000001"] }, makeCtx()).pipe(
        Effect.provide(tikhubMock.layer),
      ),
    );
    assert.equal(fallbackRes.status, "success");
    assert.equal(fallbackRes.details?.cost, null, "TikHub fallback must record unknown cost");
    assert.match(fallbackRes.text, /via TikHub/);
    assert.match(fallbackRes.text, /Fallback post text/);

    // Protected/not-found resource problem vetoes TikHub fallback
    process.env.X_BEARER_TOKEN = BEARER;
    const vetoMock = makeLayers((url) => {
      assert.equal(url.pathname, "/2/tweets");
      return json(
        {
          errors: [
            {
              type: "https://api.x.com/2/problems/not-authorized-for-resource",
              resource_type: "tweet",
              resource_id: "1900000000000000002",
              title: "Authorization Error",
              detail: "Protected account",
            },
          ],
        },
        403,
      );
    });
    const vetoRes = await Effect.runPromise(
      executeAction(xPostAction, { posts: ["1900000000000000002"] }, makeCtx()).pipe(
        Effect.provide(vetoMock.layer),
      ),
    );
    assert.equal(vetoRes.status, "empty");
    assert.equal(vetoMock.calls.length, 1, "Must NOT call TikHub when X explicitly names resource protected");
  });

  it("x_search_posts and x_count_posts handle paging, archive validation, and billing", async () => {
    const { calls, layer } = makeLayers((url) => {
      if (url.pathname === "/2/tweets/search/all") {
        return json({
          data: [{ id: "10", author_id: "u1", text: "Archive match" }],
          includes: { users: [{ id: "u1", username: "archiver" }] },
        });
      }
      if (url.pathname === "/2/tweets/counts/recent") {
        return json({
          data: [{ start: "2026-11-20T00:00:00Z", end: "2026-11-21T00:00:00Z", post_count: 15 }],
          meta: { total_post_count: 15 },
        });
      }
      return json({ data: [] });
    });

    const searchRes = await Effect.runPromise(
      executeAction(xSearchPostsAction, { query: "effect", archive: true, limit: 10 }, makeCtx()).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(searchRes.status, "success");
    assert.deepEqual(searchRes.details?.cost, [
      { amount: 1, unit: POST_READS },
      { amount: 1, unit: ACCOUNT_READS },
    ]);

    const badCount = await Effect.runPromise(
      executeAction(xCountPostsAction, { query: "effect", archive: true }, makeCtx()).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(badCount.status, "failed");
    assert.match(badCount.text, /needs start_time/);
    assert.equal(calls.length, 1);

    const countRes = await Effect.runPromise(
      executeAction(xCountPostsAction, { query: "effect" }, makeCtx()).pipe(Effect.provide(layer)),
    );
    assert.equal(countRes.status, "success");
    assert.equal(countRes.details?.cost, null);
    assert.match(countRes.text, /15 posts in 1 bucket/);
  });

  it("x_users, x_follows, x_news, x_bookmarks, x_likes, and x_community execute cleanly", async () => {
    process.env.X_CONSUMER_KEY = "ck-12345678";
    process.env.X_CONSUMER_SECRET = "cs-12345678";
    process.env.X_ACCESS_TOKEN = "at-12345678";
    process.env.X_ACCESS_TOKEN_SECRET = "as-12345678";
    process.env.TIKHUB_API_KEY = TIKHUB;

    const { layer } = makeLayers((url, headers) => {
      if (url.pathname === "/2/users/by") {
        return json({
          data: [{ id: "u1", username: "alice", name: "Alice", public_metrics: { followers_count: 500, following_count: 10 } }],
        });
      }
      if (url.pathname === "/2/users/u1/following") {
        return json({
          data: [{ id: "u2", username: "bob", name: "Bob" }],
          meta: { next_token: "nxt-1" },
        });
      }
      if (url.pathname === "/2/users/me") {
        assert.match(headers["authorization"] ?? "", /^OAuth /);
        return json({ data: { id: "me-1", username: "selfuser" } });
      }
      if (url.pathname === "/2/users/me-1/bookmarks") {
        assert.match(headers["authorization"] ?? "", /^OAuth /);
        return json({
          data: [
            { id: "p1", author_id: "u1", text: "AI agents in TypeScript" },
            { id: "p2", author_id: "u1", text: "Brainstorming lunch" },
          ],
          includes: { users: [{ id: "u1", username: "alice" }] },
        });
      }
      if (url.pathname === "/2/users/me-1/liked_tweets") {
        return json({
          data: [{ id: "p3", author_id: "u1", text: "Liked post about Effect" }],
          includes: { users: [{ id: "u1", username: "alice" }] },
        });
      }
      if (url.pathname === "/2/news/search") {
        return json({ data: [{ id: "999", name: "Breaking Tech Story", summary: "Details here" }] });
      }
      if (url.pathname === "/2/communities/777") {
        return json({ data: { id: "777", name: "TypeScript Devs", member_count: 1200 } });
      }
      if (url.pathname === "/api/v1/twitter/web/fetch_community_timeline") {
        return json({
          code: 200,
          data: {
            timeline: [{ id: "555", text: "Community post", author: { screen_name: "alice" }, created_at: "Fri Nov 20 12:00:00 +0000 2026" }],
          },
        });
      }
      return json({ data: [] });
    });

    const usersRes = await Effect.runPromise(
      executeAction(xUsersAction, { handles: ["@alice"] }, makeCtx()).pipe(Effect.provide(layer)),
    );
    assert.equal(usersRes.status, "success");
    assert.deepEqual(usersRes.details?.cost, [{ amount: 1, unit: ACCOUNT_READS }]);

    const followsRes = await Effect.runPromise(
      executeAction(xFollowsAction, { handle: "alice", direction: "following", limit: 10 }, makeCtx()).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(followsRes.status, "success");
    assert.deepEqual(followsRes.details?.cost, [{ amount: 2, unit: ACCOUNT_READS }]);
    assert.match(followsRes.text, /cursor "nxt-1"/);

    const bookmarksRes = await Effect.runPromise(
      executeAction(xBookmarksAction, { limit: 10, match: "ai" }, makeCtx()).pipe(Effect.provide(layer)),
    );
    assert.equal(bookmarksRes.status, "success");
    assert.match(bookmarksRes.text, /2 posts read, 1 post matching "ai"/);
    assert.match(bookmarksRes.text, /AI agents in TypeScript/);
    assert.ok(!bookmarksRes.text.includes("Brainstorming lunch"));
    // /2/users/me (1 account) + bookmarks (2 posts + 1 user) = 2 posts, 2 accounts
    assert.deepEqual(bookmarksRes.details?.cost, [
      { amount: 2, unit: ACCOUNT_READS },
      { amount: 2, unit: POST_READS },
    ]);

    const likesRes = await Effect.runPromise(
      executeAction(xLikesAction, { limit: 10 }, makeCtx()).pipe(Effect.provide(layer)),
    );
    assert.equal(likesRes.status, "success");
    assert.deepEqual(likesRes.details?.cost, [
      { amount: 1, unit: POST_READS },
      { amount: 1, unit: ACCOUNT_READS },
    ]);

    const newsRes = await Effect.runPromise(
      executeAction(xNewsAction, { query: "tech" }, makeCtx()).pipe(Effect.provide(layer)),
    );
    assert.equal(newsRes.status, "success");
    assert.equal(newsRes.details?.cost, null);

    const commDecoded = decodeActionArgs(xCommunityAction, { community: "https://x.com/i/communities/777", posts: 5 });
    assert.equal(commDecoded.ok, true);
    if (!commDecoded.ok) return;
    const commRes = await Effect.runPromise(
      executeAction(xCommunityAction, commDecoded.args, makeCtx()).pipe(Effect.provide(layer)),
    );
    assert.equal(commRes.status, "success");
    assert.equal(commRes.details?.cost, null);
    assert.match(commRes.text, /TypeScript Devs/);
    assert.match(commRes.text, /Community post/);
  });

  it("xReads returns null for TikHub labels and transport errors, and counts posts+users accurately", () => {
    assert.equal(xReads({ label: "fetch_tweet_detail via TikHub", status: 200, body: { data: { id: "1", text: "hi" } } }), null);
    assert.equal(xReads({ label: "post lookup", status: "error", body: "timeout" }), null);
    assert.deepEqual(
      xReads({
        label: "List 1 posts",
        status: 200,
        body: {
          data: [{ id: "1", text: "hello" }],
          includes: { users: [{ id: "u1", username: "a" }], tweets: [{ id: "2", text: "quoted" }] },
        },
      }),
      { posts: 2, accounts: 1 },
    );
  });

  it("never retries PaidHttp transport failures on X API calls", async () => {
    const { calls, layer } = makeLayers(() => new Error("network unreachable"));
    const res = await Effect.runPromise(
      executeAction(xSearchPostsAction, { query: "test" }, makeCtx()).pipe(Effect.provide(layer)),
    );
    assert.equal(calls.length, 1);
    assert.equal(res.status, "failed");
    assert.equal(res.details?.cost, null);
  });
});
