import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext } from "../../core/plugin.ts";
import telegramDefault, { telegramAction, telegramSource } from "./index.ts";

const TEST_KEY = "sc-test-telegram-key-2222";

function makeLayers(handler: (url: URL) => Response) {
  const calls: URL[] = [];
  const base = HttpClient.make((req) =>
    Effect.sync(() => {
      const url = new URL(req.url);
      calls.push(url);
      return HttpClientResponse.fromWeb(req, handler(url));
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

describe("telegram SourcePlugin", () => {
  const prevKey = process.env.SCRAPECREATORS_API_KEY;
  beforeEach(() => {
    process.env.SCRAPECREATORS_API_KEY = TEST_KEY;
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
    else process.env.SCRAPECREATORS_API_KEY = prevKey;
  });

  it("exports metadata, default export, and scrapecreators_telegram action", () => {
    assert.equal(telegramSource, telegramDefault);
    assert.equal(telegramSource.id, "telegram");
    assert.equal(telegramSource.group, "social");
    assert.deepEqual(telegramSource.actions.map((a) => a.name), ["scrapecreators_telegram"]);
  });

  it("reads channel posts newest-first, preserves cursor, and records credits", async () => {
    const { calls, layer } = makeLayers((url) => {
      assert.equal(url.pathname, "/v1/telegram/channel/posts");
      assert.equal(url.searchParams.get("handle"), "durov");
      return json({
        success: true,
        credits_charged: 1,
        cursor: "500",
        has_more: true,
        posts: [
          { id: "501", text: "Earlier update", published_at: "2026-11-18T10:00:00Z", view_count: 1000 },
          { id: "502", text: "Newer post", published_at: "2026-11-20T10:00:00Z", view_count: 2500 },
        ],
      });
    });

    const decoded = decodeActionArgs(telegramAction, {
      kind: "posts",
      handle: "https://t.me/s/durov",
      limit: 1,
    });
    assert.equal(decoded.ok, true);
    if (!decoded.ok) return;

    const res = await Effect.runPromise(
      executeAction(telegramAction, decoded.args, makeCtx()).pipe(Effect.provide(layer)),
    );
    assert.equal(calls.length, 1);
    assert.equal(res.status, "success");
    assert.deepEqual(res.details?.cost, [{ amount: 1, unit: "credits" }]);
    assert.match(res.text, /1\. Newer post/);
    assert.ok(!res.text.includes("Earlier update"));
    assert.match(res.text, /pass cursor="500".*including the 1 not shown/);
  });

  it("reads channel details & single post, and refuses private invite links before HTTP", async () => {
    const { calls, layer } = makeLayers((url) => {
      if (url.pathname === "/v1/telegram/channel") {
        return json({
          success: true,
          credits_charged: 0,
          cached: true,
          name: "Durov's Channel",
          handle: "durov",
          is_verified: true,
          subscriber_count: 5000000,
        });
      }
      if (url.pathname === "/v1/telegram/post") {
        return json({
          success: true,
          credits_charged: 1,
          id: "543",
          channel_handle: "durov",
          text: "Public update",
          published_at: "2026-11-21T00:00:00Z",
          view_count: 12000,
        });
      }
      return json({ success: false }, 404);
    });

    const ch = await Effect.runPromise(
      executeAction(telegramAction, { kind: "channel", handle: "@durov", cache_max_age: "7d" }, makeCtx()).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(ch.status, "success");
    assert.deepEqual(ch.details?.cost, []);
    assert.match(ch.text, /Served from ScrapeCreators cache/);

    const post = await Effect.runPromise(
      executeAction(telegramAction, { kind: "post", url: "https://t.me/s/durov/543" }, makeCtx()).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(post.status, "success");
    assert.deepEqual(post.details?.cost, [{ amount: 1, unit: "credits" }]);

    const invite = await Effect.runPromise(
      executeAction(telegramAction, { kind: "channel", handle: "https://t.me/+AbCdEf" }, makeCtx()).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(invite.status, "failed");
    assert.match(invite.text, /private or invite-only/);
    assert.equal(calls.length, 2, "Private invite link must not send HTTP");
  });
});
