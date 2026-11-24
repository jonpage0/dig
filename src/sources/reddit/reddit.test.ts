import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext } from "../../core/plugin.ts";
import redditDefault, { redditAction, redditSource } from "./index.ts";

const TEST_KEY = "sc-test-reddit-key-5678";

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("reddit SourcePlugin", () => {
  const prevKey = process.env.SCRAPECREATORS_API_KEY;
  beforeEach(() => {
    process.env.SCRAPECREATORS_API_KEY = TEST_KEY;
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
    else process.env.SCRAPECREATORS_API_KEY = prevKey;
  });

  it("exports metadata, default export, and reddit action", () => {
    assert.equal(redditSource, redditDefault);
    assert.equal(redditSource.id, "reddit");
    assert.equal(redditSource.group, "social");
    assert.deepEqual(redditSource.actions.map((a) => a.name), ["reddit"]);
  });

  it("searches all of Reddit, filters NSFW, enriches top comments, and sums ScrapeCreators credits", async () => {
    const { calls, layer } = makeLayers((url) => {
      if (url.pathname === "/v1/reddit/search") {
        assert.equal(url.searchParams.get("query"), "local llm");
        assert.equal(url.searchParams.get("sort"), "comment_count");
        return json({
          success: true,
          credits_charged: 1,
          after: "t3_next",
          posts: [
            {
              id: "t3_abc",
              title: "Running local models on Mac",
              subreddit: "LocalLLaMA",
              author: "dev1",
              score: 250,
              num_comments: 40,
              created_utc: 1760000000,
              permalink: "/r/LocalLLaMA/comments/abc/running_local/",
              over_18: false,
            },
            {
              id: "t3_nsfw",
              title: "NSFW post",
              subreddit: "LocalLLaMA",
              over_18: true,
            },
          ],
        });
      }
      if (url.pathname === "/v1/reddit/post/comments") {
        return json({
          success: true,
          credits_charged: 1,
          comments: [
            { author: "AutoModerator", body: "Welcome to the sub!", score: 1 },
            { author: "user2", body: "Memory bandwidth matters most.", score: 85 },
          ],
          more: { has_more: true, cursor: "cm-next" },
        });
      }
      return json({ success: false, error: "not found" }, 404);
    });

    const decoded = decodeActionArgs(redditAction, {
      query: "local llm",
      sort: "comments",
      commentThreads: 1,
    });
    assert.equal(decoded.ok, true);
    if (!decoded.ok) return;

    const res = await Effect.runPromise(
      executeAction(redditAction, decoded.args, makeCtx()).pipe(Effect.provide(layer)),
    );
    assert.equal(calls.length, 2);
    assert.equal(res.status, "success");
    assert.deepEqual(res.details?.cost, [{ amount: 2, unit: "credits" }]);
    assert.match(res.text, /1 NSFW excluded/);
    assert.match(res.text, /Memory bandwidth matters most\./);
    assert.ok(!res.text.includes("Welcome to the sub!"));
    assert.match(res.text, /after="t3_next"/);
  });

  it("supports direct postUrl comments mode and refuses mixed search args", async () => {
    const { calls, layer } = makeLayers((url) => {
      assert.equal(url.pathname, "/v1/reddit/post/comments");
      assert.equal(url.searchParams.get("cursor"), "c1");
      return json({
        success: true,
        credits_charged: 1,
        comments: [
          {
            id: "t1_1",
            author: "commenter",
            body: "Detailed breakdown of benchmarks.",
            score: 12,
            replies: { items: [], more: { has_more: true, cursor: "rep-1" } },
          },
        ],
        more: { has_more: false },
      });
    });

    const res = await Effect.runPromise(
      executeAction(
        redditAction,
        { postUrl: "https://www.reddit.com/r/LocalLLaMA/comments/abc/test/", cursor: "c1" },
        makeCtx(),
      ).pipe(Effect.provide(layer)),
    );
    assert.equal(calls.length, 1);
    assert.equal(res.status, "success");
    assert.deepEqual(res.details?.cost, [{ amount: 1, unit: "credits" }]);
    assert.match(res.text, /Replies cursor: "rep-1"/);

    const bad = await Effect.runPromise(
      executeAction(
        redditAction,
        { postUrl: "https://www.reddit.com/r/LocalLLaMA/comments/abc/test/", query: "oops" },
        makeCtx(),
      ).pipe(Effect.provide(layer)),
    );
    assert.equal(bad.status, "failed");
    assert.equal(calls.length, 1);
  });

  it("never retries PaidHttp transport failures and records unknown cost", async () => {
    const { calls, layer } = makeLayers(() => new Error("socket hang up"));
    const res = await Effect.runPromise(
      executeAction(redditAction, { query: "retry check", includeComments: false }, makeCtx()).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(calls.length, 1, "PaidHttp must never retry on transport error");
    assert.equal(res.status, "failed");
    assert.equal(res.details?.cost, null);
    assert.match(res.text, /its cost is unknown/);
  });
});
