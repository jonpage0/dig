import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext } from "../../core/plugin.ts";
import threadsDefault, { threadsAction, threadsSource } from "./index.ts";

const TEST_KEY = "sc-test-threads-key-1234";

function makeLayers(handler: (url: URL, headers: Record<string, string>) => Response) {
  const calls: URL[] = [];
  const base = HttpClient.make((req) =>
    Effect.sync(() => {
      const url = new URL(req.url);
      calls.push(url);
      return HttpClientResponse.fromWeb(req, handler(url, req.headers as Record<string, string>));
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

describe("threads SourcePlugin", () => {
  const prevKey = process.env.SCRAPECREATORS_API_KEY;
  beforeEach(() => {
    process.env.SCRAPECREATORS_API_KEY = TEST_KEY;
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
    else process.env.SCRAPECREATORS_API_KEY = prevKey;
  });

  it("exports metadata, default export, and threads action with ScrapeCreators billing", () => {
    assert.equal(threadsSource, threadsDefault);
    assert.equal(threadsSource.id, "threads");
    assert.equal(threadsSource.group, "social");
    assert.deepEqual(threadsSource.actions.map((a) => a.name), ["threads"]);
    assert.ok(threadsAction.billing && threadsAction.billing !== "free");
  });

  it("reads a single Threads post and records ScrapeCreators credits", async () => {
    const { calls, layer } = makeLayers((url) => {
      assert.equal(url.pathname, "/v1/threads/post");
      assert.equal(url.searchParams.get("url"), "https://www.threads.net/@zuck/post/C123");
      assert.equal(url.searchParams.get("cache_max_age"), "7d");
      return new Response(
        JSON.stringify({
          success: true,
          credits_charged: 1,
          credits_remaining: 99,
          post: { id: "post_1", caption: { text: "Hello Threads" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const decoded = decodeActionArgs(threadsAction, {
      kind: "post",
      url: "https://www.threads.net/@zuck/post/C123",
      cacheMaxAge: "7d",
    });
    assert.equal(decoded.ok, true);
    if (!decoded.ok) return;

    const res = await Effect.runPromise(
      executeAction(threadsAction, decoded.args, makeCtx()).pipe(Effect.provide(layer)),
    );
    assert.equal(calls.length, 1);
    assert.equal(res.status, "success");
    assert.deepEqual(res.details?.cost, [{ amount: 1, unit: "credits" }]);
    assert.match(res.text, /Threads post/);
    assert.ok(!res.text.includes("credits_remaining"));
  });

  it("reads account posts, deduplicates by id, and rejects invalid arguments before HTTP", async () => {
    const { calls, layer } = makeLayers((url) => {
      assert.equal(url.pathname, "/v1/threads/user/posts");
      assert.equal(url.searchParams.get("handle"), "zuck");
      return new Response(
        JSON.stringify({
          success: true,
          credits_charged: 1,
          posts: [
            { id: "1", text: "first" },
            { id: "1", text: "dup" },
            { id: "2", text: "second" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const res = await Effect.runPromise(
      executeAction(threadsAction, { kind: "posts", handle: "@zuck" }, makeCtx()).pipe(Effect.provide(layer)),
    );
    assert.equal(calls.length, 1);
    assert.equal(res.status, "success");
    assert.deepEqual(res.details?.cost, [{ amount: 1, unit: "credits" }]);
    assert.match(res.text, /This endpoint provides no documented pagination/);

    const badHost = await Effect.runPromise(
      executeAction(threadsAction, { kind: "post", url: "https://example.com/@zuck/post/1" }, makeCtx()).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(badHost.status, "failed");
    assert.equal(calls.length, 1, "Invalid URL must be refused before any paid request");

    const badMix = await Effect.runPromise(
      executeAction(threadsAction, { kind: "posts", handle: "zuck", url: "https://threads.net/@zuck/post/1" }, makeCtx()).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(badMix.status, "failed");
    assert.equal(calls.length, 1);
  });
});
