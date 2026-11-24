import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import {
  decodeActionArgs,
  executeAction,
  schemaToMcpJson,
  type ActionContext,
  type ActionDefinition,
  type ToolProgress,
} from "../../core/plugin.ts";
import exaSource, {
  exaContentsAction,
  exaResearchAction,
  exaSearchAction,
  exaSimilarAction,
} from "./index.ts";

interface CapturedCall {
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
}

interface MockReply {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly payload?: unknown;
  readonly transportError?: string;
}

type RouteHandler = MockReply | ((call: CapturedCall) => MockReply);

function decodeBody(req: HttpClientRequest.HttpClientRequest): Record<string, unknown> {
  if (req.body._tag === "Uint8Array") {
    const text = new TextDecoder().decode(req.body.body);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }
  return {};
}

function makeMockLayer(routes: Record<string, RouteHandler>) {
  const calls: CapturedCall[] = [];
  const base = HttpClient.make((req) =>
    Effect.suspend(() => {
      const url = new URL(req.url);
      const call: CapturedCall = {
        url,
        method: req.method,
        headers: { ...req.headers },
        body: decodeBody(req),
      };
      calls.push(call);
      const route = routes[url.pathname];
      if (!route) {
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("not found", { status: 404 })));
      }
      const reply = typeof route === "function" ? route(call) : route;
      if (reply.transportError !== undefined) {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request: req,
              description: reply.transportError,
            }),
          }),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          req,
          new Response(JSON.stringify(reply.payload ?? {}), {
            status: reply.status ?? 200,
            headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
          }),
        ),
      );
    }),
  );

  const layer = Layer.mergeAll(
    Layer.succeed(PaidHttp, makePaidClient(base, { resolveDns: false })),
    Layer.succeed(FreeHttp, makeFreeClient(base, { resolveDns: false, retries: 0 })),
  );
  return { calls, layer };
}

function makeCtx(options?: { readonly signal?: AbortSignal }) {
  const kept: Array<{ readonly label: string; readonly status: number | string; readonly body: unknown }> = [];
  const progress: ToolProgress[] = [];
  const ctx: ActionContext = {
    digId: "dig-exa-test",
    project: "/tmp/exa-test",
    signal: options?.signal ?? new AbortController().signal,
    keep(label, status, body) {
      kept.push({ label, status, body });
    },
    progress(update) {
      progress.push(update);
    },
  };
  return { ctx, kept, progress };
}

const page = {
  title: "Exa Deep Search",
  url: "https://exa.ai/docs/search/deep-search",
  id: "https://exa.ai/docs/search/deep-search",
  publishedDate: "2026-03-04T00:00:00.000Z",
  highlights: ["Deep Search is the research mode of the Search API."],
};

describe("exa source plugin (Effect 4.1.5)", () => {
  const savedKey = process.env.EXA_API_KEY;
  const savedBaseUrl = process.env.EXA_BASE_URL;

  beforeEach(() => {
    process.env.EXA_API_KEY = "exa-test-key";
    delete process.env.EXA_BASE_URL;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = savedKey;
    if (savedBaseUrl === undefined) delete process.env.EXA_BASE_URL;
    else process.env.EXA_BASE_URL = savedBaseUrl;
  });

  it("exports plugin metadata, slow flag on exa_research, and valid compact JSON schemas", () => {
    assert.equal(exaSource.id, "exa");
    assert.equal(exaSource.group, "web");
    assert.equal(exaSource.logo, "exa");
    assert.deepEqual(
      exaSource.actions.map((a) => a.name),
      ["exa_search", "exa_contents", "exa_similar", "exa_research"],
    );
    assert.equal(exaResearchAction.slow, true);
    assert.equal(exaSearchAction.slow, undefined);

    for (const action of exaSource.actions) {
      const compact = schemaToMcpJson(action.schema, { compact: true });
      assert.equal(compact.type, "object");
    }
    const okSearch = decodeActionArgs(exaSearchAction, {
      query: "effect v4",
      highlightVerbosity: "medium",
    });
    assert.equal(okSearch.ok, true);
    const okResearch = decodeActionArgs(exaResearchAction, {
      query: "mcp apps",
      mode: "auto",
      highlightVerbosity: "low",
    });
    assert.equal(okResearch.ok, true);
  });

  it("exa_research defaults to deep + Dynamic Highlights medium verbosity, sends Exa-Beta, and emits ctx.progress", async () => {
    const { calls, layer } = makeMockLayer({
      "/search": {
        payload: {
          requestId: "req-1",
          results: [page],
          costDollars: { total: 0.012 },
          searchTime: 8400,
          output: {
            content: "Deep Search runs iterative retrieval before synthesis.",
            grounding: [
              {
                field: "content",
                citations: [{ title: page.title, url: page.url }],
                confidence: "high",
              },
            ],
          },
        },
      },
    });
    const { ctx, progress } = makeCtx();

    const result = await Effect.runPromise(
      executeAction(
        exaResearchAction,
        {
          query: "How does Exa Deep Search work?",
          systemPrompt: "Prefer official docs.",
          additionalQueries: ["exa deep mode"],
        },
        ctx,
      ).pipe(Effect.provide(layer)),
    );

    assert.equal(result.status, "success");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url.origin, "https://api.exa.ai");
    assert.deepEqual(calls[0]!.body, {
      query: "How does Exa Deep Search work?",
      type: "deep",
      numResults: 10,
      outputSchema: { type: "text" },
      contents: { highlights: { dynamic: true, verbosity: "medium" } },
      systemPrompt: "Prefer official docs.",
      additionalQueries: ["exa deep mode"],
    });
    assert.equal(calls[0]!.headers["x-api-key"], "exa-test-key");
    assert.equal(calls[0]!.headers["exa-beta"], "dynamic-highlights-2026-08-28");
    assert.match(result.text, /## Exa Deep Research \(deep\)/);
    assert.match(result.text, /Deep Search runs iterative retrieval before synthesis\./);
    assert.match(
      result.text,
      /- `content` — confidence high: Exa Deep Search <https:\/\/exa\.ai\/docs\/search\/deep-search>/,
    );
    assert.deepEqual(result.details?.cost, [{ amount: 0.012, unit: "USD" }]);
    assert.equal(result.details?.dynamicHighlights, true);
    assert.equal(result.details?.highlightVerbosity, "medium");
    assert.equal(progress.length, 3);
    assert.equal(progress[0]!.progress, 0);
    assert.equal(progress[1]!.progress, 1);
    assert.equal(progress[2]!.progress, 2);
  });

  it("exa_research supports auto ($0.007), deep-lite, deep-reasoning, verbosity overrides, and dynamicHighlights: false", async () => {
    const { calls, layer } = makeMockLayer({
      "/search": (call) => ({
        payload: {
          requestId: `req-${String(call.body.type)}`,
          results: [page],
          costDollars: { total: call.body.type === "auto" ? 0.007 : 0.012 },
          output: { content: "Quick synthesis.", grounding: [] },
        },
      }),
    });

    const autoOut = await Effect.runPromise(
      executeAction(
        exaResearchAction,
        { query: "quick check", mode: "auto", highlightVerbosity: "low" },
        makeCtx().ctx,
      ).pipe(Effect.provide(layer)),
    );
    assert.equal(autoOut.status, "success");
    assert.equal(calls[0]!.body.type, "auto");
    assert.deepEqual(calls[0]!.body.contents, { highlights: { dynamic: true, verbosity: "low" } });
    assert.equal(calls[0]!.headers["exa-beta"], "dynamic-highlights-2026-08-28");
    assert.deepEqual(autoOut.details?.cost, [{ amount: 0.007, unit: "USD" }]);
    assert.match(autoOut.text, /## Exa Deep Research \(auto\)/);
    assert.match(autoOut.text, /treat the synthesis as unsupported/);

    const staticOut = await Effect.runPromise(
      executeAction(
        exaResearchAction,
        { query: "static", mode: "deep-lite", dynamicHighlights: false, highlightMaxCharacters: 2000 },
        makeCtx().ctx,
      ).pipe(Effect.provide(layer)),
    );
    assert.equal(staticOut.status, "success");
    assert.equal(calls[1]!.headers["exa-beta"], undefined);
    assert.deepEqual(calls[1]!.body.contents, { highlights: { query: "static", maxCharacters: 2000 } });
    assert.equal(staticOut.details?.dynamicHighlights, false);

    // Incompatible combos rejected before spending
    const badCombo = await Effect.runPromise(
      executeAction(
        exaResearchAction,
        { query: "bad", highlightMaxCharacters: 500 },
        makeCtx().ctx,
      ).pipe(Effect.provide(layer)),
    );
    assert.equal(badCombo.status, "failed");
    assert.match(badCombo.text, /highlightMaxCharacters cannot be combined with dynamicHighlights/);
    assert.equal(calls.length, 2);
  });

  it("exa_search wires highlightVerbosity with Exa-Beta and omits text, while preserving standard mode", async () => {
    const { calls, layer } = makeMockLayer({
      "/search": { payload: { requestId: "r", results: [page], costDollars: { total: 0.007 } } },
    });

    await Effect.runPromise(
      executeAction(exaSearchAction, { query: "solar costs", type: "fast", maxAgeHours: 24 }, makeCtx().ctx).pipe(
        Effect.provide(layer),
      ),
    );
    const verboseRes = await Effect.runPromise(
      executeAction(
        exaSearchAction,
        { query: "solar costs", highlightVerbosity: "low", summary: true, snapshotAsOf: "2026-09-01" },
        makeCtx().ctx,
      ).pipe(Effect.provide(layer)),
    );

    assert.equal(calls[0]!.headers["exa-beta"], undefined);
    assert.deepEqual(calls[0]!.body, {
      query: "solar costs",
      numResults: 10,
      type: "fast",
      contents: { text: { maxCharacters: 3000 }, highlights: { query: "solar costs" }, maxAgeHours: 24 },
    });

    assert.equal(calls[1]!.headers["exa-beta"], "dynamic-highlights-2026-08-28");
    assert.deepEqual(calls[1]!.body.contents, {
      highlights: { query: "solar costs", dynamic: true, verbosity: "low" },
      summary: { query: "solar costs" },
      snapshotAsOf: "2026-09-01",
    });
    assert.equal("text" in (calls[1]!.body.contents as Record<string, unknown>), false);
    assert.equal(verboseRes.details?.dynamicHighlights, true);
    assert.equal(verboseRes.details?.highlightVerbosity, "low");
  });

  it("exa_contents reports per-URL failures, unaccounted URLs, and redacts leaked API keys", async () => {
    const { layer } = makeMockLayer({
      "/contents": {
        payload: {
          requestId: "c-1",
          results: [{ ...page, text: "Full page text." }],
          statuses: [
            { id: page.url, status: "success", source: "cached" },
            {
              id: "https://example.com/missing?k=exa-test-key",
              status: "error",
              error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 },
            },
          ],
          costDollars: { total: 0.002 },
        },
      },
    });

    const out = await Effect.runPromise(
      executeAction(
        exaContentsAction,
        {
          urls: [page.url, "https://example.com/missing?k=exa-test-key", "https://example.com/silent"],
          query: "deep search",
          summary: true,
        },
        makeCtx().ctx,
      ).pipe(Effect.provide(layer)),
    );

    assert.equal(out.status, "partial");
    assert.equal(out.text.includes("exa-test-key"), false);
    assert.match(out.text, /Content extracted for 1 of 3 requested URLs/);
    assert.match(out.text, /\[redacted\] — CRAWL_NOT_FOUND \(HTTP 404\)/);
    assert.match(out.text, /Not returned and no status reported by Exa:\n- https:\/\/example\.com\/silent/);
    assert.deepEqual(out.details?.cost, [{ amount: 0.002, unit: "USD" }]);
  });

  it("EXA_BASE_URL allows only api.exa.ai and api.eu.exa.ai, trimming trailing slashes and rejecting others before spending", async () => {
    const { calls, layer } = makeMockLayer({
      "/search": { payload: { requestId: "eu-s", results: [page], costDollars: { total: 0.007 } } },
      "/contents": {
        payload: {
          requestId: "eu-c",
          results: [page],
          statuses: [{ id: page.url, status: "success" }],
          costDollars: { total: 0.001 },
        },
      },
      "/findSimilar": { payload: { requestId: "eu-f", results: [page], costDollars: { total: 0.007 } } },
    });

    process.env.EXA_BASE_URL = "https://api.eu.exa.ai///";
    await Effect.runPromise(executeAction(exaSearchAction, { query: "eu" }, makeCtx().ctx).pipe(Effect.provide(layer)));
    await Effect.runPromise(
      executeAction(exaContentsAction, { urls: [page.url] }, makeCtx().ctx).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      executeAction(exaSimilarAction, { url: page.url }, makeCtx().ctx).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      executeAction(exaResearchAction, { query: "eu" }, makeCtx().ctx).pipe(Effect.provide(layer)),
    );
    assert.deepEqual(
      calls.map((c) => c.url.href),
      [
        "https://api.eu.exa.ai/search",
        "https://api.eu.exa.ai/contents",
        "https://api.eu.exa.ai/findSimilar",
        "https://api.eu.exa.ai/search",
      ],
    );

    for (const bad of [
      "http://api.eu.exa.ai",
      "https://evil.example",
      "https://api.eu.exa.ai:8443",
      "https://api.eu.exa.ai/v1",
      "not-a-url",
      "https://user:pass@api.eu.exa.ai",
    ]) {
      process.env.EXA_BASE_URL = bad;
      const res = await Effect.runPromise(
        executeAction(exaSearchAction, { query: "q" }, makeCtx().ctx).pipe(Effect.provide(layer)),
      );
      assert.equal(res.status, "failed");
      assert.match(res.text, /^ERROR: EXA_BASE_URL must be/);
    }
    assert.equal(calls.length, 4);
  });

  it("PaidHttp never retries any Exa action on transport error and marks unanswered cost as unknown", async () => {
    const { calls, layer } = makeMockLayer({
      "/search": { transportError: "socket hang up" },
      "/contents": { transportError: "socket hang up" },
      "/findSimilar": { transportError: "socket hang up" },
    });

    const runs: ReadonlyArray<readonly [ActionDefinition, Record<string, unknown>]> = [
      [exaSearchAction, { query: "x" }],
      [exaContentsAction, { urls: [page.url] }],
      [exaSimilarAction, { url: page.url }],
      [exaResearchAction, { query: "x" }],
    ];

    for (const [action, args] of runs) {
      const before = calls.length;
      const result = await Effect.runPromise(
        executeAction(action, args, makeCtx().ctx).pipe(Effect.provide(layer)),
      );
      assert.equal(calls.length - before, 1, `${action.name} must never retry paid requests`);
      assert.equal(result.status, "failed");
      assert.equal(result.details?.cost, null);
      assert.match(result.text, /cost is unknown/);
    }
  });

  it("handles cancellation without spending and validates incompatible lite/snapshot/userLocation args", async () => {
    const { calls, layer } = makeMockLayer({});
    const controller = new AbortController();
    controller.abort();
    const cancelled = await Effect.runPromise(
      executeAction(exaSearchAction, { query: "q" }, makeCtx({ signal: controller.signal }).ctx).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(cancelled.status, "cancelled");

    const badLite = await Effect.runPromise(
      executeAction(exaSearchAction, { query: "q", type: "lite", maxAgeHours: 0 }, makeCtx().ctx).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(badLite.status, "failed");
    assert.equal(calls.length, 0);
  });
});
