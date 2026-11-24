import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext } from "../../core/plugin.ts";
import tikhubRedditDefault, { tikhubRedditAction, tikhubRedditSource } from "./index.ts";

const TEST_KEY = "tikhub-test-secret-key-9999";

function makeLayers(handler: (url: URL, auth: string | undefined) => Response | Error) {
  const calls: URL[] = [];
  const base = HttpClient.make((req) =>
    Effect.gen(function* () {
      const url = new URL(req.url);
      calls.push(url);
      const out = handler(url, req.headers["authorization"]);
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

describe("tikhub-reddit SourcePlugin", () => {
  const prevKey = process.env.TIKHUB_API_KEY;
  beforeEach(() => {
    process.env.TIKHUB_API_KEY = TEST_KEY;
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.TIKHUB_API_KEY;
    else process.env.TIKHUB_API_KEY = prevKey;
  });

  it("exports metadata, default export, and tikhub_reddit action with unknown billing", () => {
    assert.equal(tikhubRedditSource, tikhubRedditDefault);
    assert.equal(tikhubRedditSource.id, "tikhub-reddit");
    assert.equal(tikhubRedditSource.group, "social");
    assert.deepEqual(tikhubRedditSource.actions.map((a) => a.name), ["tikhub_reddit"]);
    assert.equal(tikhubRedditAction.billing, undefined);
  });

  it("runs query_scout over PaidHttp and records unknown cost (null)", async () => {
    const { calls, layer } = makeLayers((url, auth) => {
      assert.equal(auth, `Bearer ${TEST_KEY}`);
      if (url.pathname.endsWith("/fetch_search_typeahead")) {
        return json({ code: 200, data: { suggestions: [{ query: "effect ts", type: "search" }] } });
      }
      if (url.pathname.endsWith("/fetch_dynamic_search")) {
        return json({
          code: 200,
          data: {
            posts: [
              {
                id: "t3_xyz",
                title: "Effect 4 review",
                subreddit: "typescript",
                author: "dev",
                score: 100,
                num_comments: 20,
                permalink: "/r/typescript/comments/xyz/effect_4/",
              },
            ],
          },
        });
      }
      return json({ code: 200, data: { trending: [{ term: "typescript", kind: "trend" }] } });
    });

    const decoded = decodeActionArgs(tikhubRedditAction, {
      operation: "query_scout",
      query: "effect ts",
      sort: "top",
    });
    assert.equal(decoded.ok, true);
    if (!decoded.ok) return;

    const res = await Effect.runPromise(
      executeAction(tikhubRedditAction, decoded.args, makeCtx()).pipe(Effect.provide(layer)),
    );
    assert.equal(calls.length, 3);
    assert.equal(res.status, "success");
    assert.equal(res.details?.cost, null);
    assert.match(res.text, /# TikHub Reddit query_scout/);
    assert.match(res.text, /Effect 4 review/);
    assert.match(res.text, /`t3_xyz`/);
  });

  it("validates unsupported sort and author_context pagination before any HTTP call", async () => {
    const { calls, layer } = makeLayers(() => json({ code: 200, data: {} }));

    const badSort = await Effect.runPromise(
      executeAction(
        tikhubRedditAction,
        { operation: "query_scout", query: "test", sort: "INVALID_SORT" },
        makeCtx(),
      ).pipe(Effect.provide(layer)),
    );
    assert.equal(badSort.status, "failed");
    assert.equal(calls.length, 0);

    const badAuthor = await Effect.runPromise(
      executeAction(
        tikhubRedditAction,
        { operation: "author_context", username: "dev", after: "cur1" },
        makeCtx(),
      ).pipe(Effect.provide(layer)),
    );
    assert.equal(badAuthor.status, "failed");
    assert.match(badAuthor.text, /afterTarget=user_posts or user_comments/);
    assert.equal(calls.length, 0);
  });

  it("marks partial failure cleanly and never retries PaidHttp transport errors", async () => {
    let idx = 0;
    const { calls, layer } = makeLayers(() => {
      idx += 1;
      if (idx === 1) {
        return json({
          code: 200,
          data: { id: "t3_1", title: "Post 1", subreddit: "test", score: 10 },
        });
      }
      return new Error("connection reset");
    });

    const res = await Effect.runPromise(
      executeAction(
        tikhubRedditAction,
        { operation: "deep_thread", postId: "t3_1", includeReplies: false },
        makeCtx(),
      ).pipe(Effect.provide(layer)),
    );
    assert.equal(calls.length, 2, "Must execute each endpoint once with zero retries");
    assert.equal(res.status, "partial");
    assert.equal(res.details?.cost, null);
    assert.match(res.text, /Calls: 1\/2 succeeded/);
    assert.match(res.text, /its cost is unknown/);
  });
});
