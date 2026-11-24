import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext, type AnyActionDefinition } from "../../core/plugin.ts";
import chinaSocialSource, { chinaSocialSearchAction, chinaSocialSource as namedChinaSocialSource } from "./index.ts";

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
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const FIXTURES: Record<string, unknown> = {
  "/api/v1/xiaohongshu/app_v2/search_notes": {
    code: 200,
    request_id: "req-xhs",
    data: {
      data: {
        search_id: "sid-1",
        search_session_id: "sess-1",
        items: [{ note: { note_id: "671f0a0001", display_title: "XHS Note", desc: "Details", user: { nickname: "Alice" } } }],
      },
    },
  },
  "/api/v1/bilibili/web/fetch_general_search": {
    code: 200,
    data: { result: [{ bvid: "BV1TEST", title: "Bili Video", author: "Bob", play: 1200, like: 88, video_review: 12 }] },
  },
  "/api/v1/douyin/search/fetch_video_search_v2": {
    code: 200,
    data: {
      business_config: { next_page: { cursor: 20, search_id: "dy-1" }, backtrace: "bt-1", has_more: true },
      data: [{ aweme_info: { aweme_id: "7450000000000000001", desc: "Douyin Video", author: { nickname: "Carol" } } }],
    },
  },
  "/api/v1/weibo/web_v2/fetch_advanced_search": {
    code: 200,
    data: { data: { cards: [{ mblog: { idstr: "5190000001", text_raw: "Weibo Post", user: { screen_name: "Dan" }, attitudes_count: 10 } }] } },
  },
  "/api/v1/zhihu/web/fetch_article_search_v3": {
    code: 200,
    data: [{ type: "search_result", object: { type: "answer", id: "123", question: { id: "987", title: "Zhihu Q" }, author: { name: "Eve" } } }],
  },
  "/api/v1/kuaishou/app/search_comprehensive": {
    code: 200,
    data: { recoPcursor: "ks-next", mixFeeds: [{ feed: { share_info: "photoId=ks-1", caption: "Kuaishou Vid", user_name: "Frank" } }] },
  },
  "/api/v1/wechat_search/v2/fetch_search": {
    code: 200,
    data: { continue_flag: 1, cursor: "wx-next", items: [{ id: "wx-1", title: "WeChat Article", url: "https://mp.weixin.qq.com/s/wx-1" }] },
  },
};

describe("china-social source plugin", () => {
  const savedTikHub = process.env.TIKHUB_API_KEY;
  const savedJustOne = process.env.JUSTONE_API_KEY;

  beforeEach(() => {
    process.env.TIKHUB_API_KEY = "test-tikhub-secret";
    process.env.JUSTONE_API_KEY = "test-justone-secret";
  });

  afterEach(() => {
    if (savedTikHub === undefined) delete process.env.TIKHUB_API_KEY;
    else process.env.TIKHUB_API_KEY = savedTikHub;
    if (savedJustOne === undefined) delete process.env.JUSTONE_API_KEY;
    else process.env.JUSTONE_API_KEY = savedJustOne;
  });

  test("exports chinaSocialSource as named and default with expected metadata", () => {
    assert.equal(chinaSocialSource, namedChinaSocialSource);
    assert.equal(chinaSocialSource.id, "china-social");
    assert.equal(chinaSocialSource.group, "social");
    assert.deepEqual(
      chinaSocialSource.actions.map((a) => a.name),
      ["china_social_search"],
    );
  });

  test("searches all 7 TikHub platforms cleanly and records unknown cost", async () => {
    const env = makeTestEnv((req) => {
      const body = FIXTURES[req.url.pathname];
      return body ? jsonResponse(body) : jsonResponse({ code: 404 }, 404);
    });

    const res = await env.run(chinaSocialSearchAction, {
      query: "AI",
      platforms: ["xiaohongshu", "bilibili", "douyin", "weibo", "zhihu", "kuaishou", "wechat"],
    });
    assert.equal(res.status, "success");
    assert.equal(res.details?.cost, null);
    assert.equal(env.requests.length, 7);
    assert.match(res.text, /XHS Note/);
    assert.match(res.text, /Bili Video/);
    assert.match(res.text, /Douyin Video/);
    assert.match(res.text, /Weibo Post/);
    assert.match(res.text, /Zhihu Q/);
    assert.match(res.text, /Kuaishou Vid/);
    assert.match(res.text, /WeChat Article/);
  });

  test("returns partial status when one platform fails and another succeeds", async () => {
    const env = makeTestEnv((req) => {
      if (req.url.pathname === "/api/v1/bilibili/web/fetch_general_search") {
        return jsonResponse(FIXTURES[req.url.pathname]);
      }
      return jsonResponse({ code: 500, message: "Upstream error" }, 500);
    });
    const res = await env.run(chinaSocialSearchAction, { query: "AI", platforms: ["bilibili", "douyin"] });
    assert.equal(res.status, "partial");
    assert.match(res.text, /## Warnings/);
    assert.match(res.text, /Bili Video/);
  });

  test("Just One API explicit fallback requires date boundaries and redacts token on transport error", async () => {
    const env = makeTestEnv(() =>
      jsonResponse({
        code: 0,
        requestId: "jo-1",
        data: JSON.stringify({
          nextCursor: "jo-next",
          items: [{ id: "1234567890123456789", title: "JustOne Hit", url: "https://example.com/1" }],
        }),
      }),
    );

    const missingDates = await env.run(chinaSocialSearchAction, {
      query: "coffee",
      platforms: ["weibo"],
      provider: "justone",
    });
    assert.equal(missingDates.status, "failed");
    assert.equal(env.requests.length, 0);

    const ok = await env.run(chinaSocialSearchAction, {
      query: "coffee",
      platforms: ["weibo"],
      provider: "justone",
      justone_start: "2026-10-01 00:00:00",
      justone_end: "2026-10-10 00:00:00",
    });
    assert.equal(ok.status, "success");
    assert.match(ok.text, /JustOne Hit/);
    assert.match(ok.text, /ID: 1234567890123456789/);

    const envErr = makeTestEnv(() => ({ error: "connection reset with test-justone-secret" }));
    const errRes = await envErr.run(chinaSocialSearchAction, {
      query: "coffee",
      platforms: ["weibo"],
      provider: "justone",
      justone_start: "2026-10-01 00:00:00",
      justone_end: "2026-10-10 00:00:00",
    });
    assert.equal(errRes.status, "failed");
    assert.ok(!errRes.text.includes("test-justone-secret"));
    assert.match(errRes.text, /token-bearing diagnostics withheld/);
  });

  test("refuses invalid cursor/page combinations before any paid request", async () => {
    const env = makeTestEnv(() => jsonResponse({ code: 200, data: {} }));
    for (const bad of [
      { query: "x", platforms: ["xiaohongshu", "bilibili"], cursor: "abc" },
      { query: "x", platforms: ["douyin"], page: 2 },
      { query: "x", platforms: ["xiaohongshu"], page: 2 },
      { query: "x", platforms: ["bilibili"], weibo_search_type: "hot" },
    ]) {
      assert.equal((await env.run(chinaSocialSearchAction, bad)).status, "failed", JSON.stringify(bad));
    }
    assert.equal(env.requests.length, 0);
  });
});
