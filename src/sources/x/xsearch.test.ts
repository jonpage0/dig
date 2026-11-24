import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { X_DEFAULTS } from "../../core/config.ts";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { executeAction, type ActionContext, type ToolProgress } from "../../core/plugin.ts";
import { loadXDefaults, RECOVERY, xsearchAction } from "./xsearch.ts";

const XAI_KEY = "xai-test-key-12345678"; // gitleaks:allow

function sseResponse(events: ReadonlyArray<{ event?: string; data: unknown }>, status = 200): Response {
  const payload = events
    .map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`)
    .join("");
  return new Response(payload, {
    status,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function makeLayers(handler: (url: URL, method: string, body: unknown) => Response) {
  const calls: Array<{ url: URL; method: string; body: unknown }> = [];
  const base = HttpClient.make((req) =>
    Effect.sync(() => {
      const url = new URL(req.url);
      let parsedBody: unknown;
      if (req.body._tag === "Uint8Array") {
        parsedBody = JSON.parse(new TextDecoder().decode(req.body.body));
      }
      calls.push({ url, method: req.method, body: parsedBody });
      return HttpClientResponse.fromWeb(req, handler(url, req.method, parsedBody));
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(PaidHttp, makePaidClient(base, { resolveDns: false })),
    Layer.succeed(FreeHttp, makeFreeClient(base, { resolveDns: false, retries: 0 })),
  );
  return { calls, layer };
}

function makeCtx(): { ctx: ActionContext; progress: ToolProgress[]; kept: Array<{ label: string; status: number | string; body: unknown }> } {
  const progress: ToolProgress[] = [];
  const kept: Array<{ label: string; status: number | string; body: unknown }> = [];
  const ctx: ActionContext = {
    digId: "test-dig",
    project: "/tmp",
    keep: (label, status, body) => kept.push({ label, status, body }),
    progress: (u) => progress.push(u),
    signal: new AbortController().signal,
  };
  return { ctx, progress, kept };
}

describe("xsearch action", () => {
  const prevKey = process.env.XAI_API_KEY;
  const prevStateDir = process.env.DIG_STATE_DIR;
  const prevWaits = RECOVERY.waitsMs;

  beforeEach(() => {
    process.env.XAI_API_KEY = XAI_KEY;
    RECOVERY.waitsMs = [1, 1];
  });

  afterEach(() => {
    RECOVERY.waitsMs = prevWaits;
    if (prevKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = prevKey;
    if (prevStateDir === undefined) delete process.env.DIG_STATE_DIR;
    else process.env.DIG_STATE_DIR = prevStateDir;
  });

  it("loads [x] defaults from DIG_STATE_DIR/config.toml and falls back to X_DEFAULTS when absent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "dig-xsearch-cfg-"));
    try {
      process.env.DIG_STATE_DIR = tmp;
      assert.deepEqual(loadXDefaults(), { ...X_DEFAULTS });

      await writeFile(
        join(tmp, "config.toml"),
        '[x]\nmodel = "grok-4.8"\ndepth = "max"\nweb_search = true\ncode_execution = true\n',
        "utf8",
      );
      assert.deepEqual(loadXDefaults(), {
        model: "grok-4.8",
        depth: "max",
        web_search: true,
        code_execution: true,
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("streams SSE search rounds, emits live ctx.progress updates, and records reported USD cost", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "dig-xsearch-run-"));
    try {
      process.env.DIG_STATE_DIR = tmp;
      const completedBody = {
        id: "resp_123",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Found key post at https://x.com/alice/status/12345.",
                annotations: [{ type: "url_citation", url: "https://x.com/alice/status/12345", title: "Alice", start_index: 0, end_index: 10 }],
              },
            ],
          },
        ],
        usage: {
          total_tokens: 1500,
          cost_in_usd_ticks: 250_000_000, // $0.025
        },
      };

      const { calls, layer } = makeLayers((url, method, body) => {
        assert.equal(method, "POST");
        assert.equal(url.pathname, "/v1/responses");
        const reqBody = body as { model: string; reasoning?: { effort: string }; stream: boolean };
        assert.equal(reqBody.model, X_DEFAULTS.model);
        assert.equal(reqBody.stream, true);
        assert.equal(reqBody.reasoning?.effort, "low");
        return sseResponse([
          {
            event: "response.output_item.done",
            data: {
              type: "response.output_item.done",
              item: {
                type: "custom_tool_call",
                call_id: "call_1",
                name: "x_semantic_search",
                input: JSON.stringify({ query: "effect 4 migration" }),
              },
            },
          },
          {
            event: "response.completed",
            data: { type: "response.completed", response: completedBody },
          },
        ]);
      });

      const { ctx, progress } = makeCtx();
      const res = await Effect.runPromise(
        executeAction(xsearchAction, { query: "effect 4 migration", mode: "semantic" }, ctx).pipe(
          Effect.provide(layer),
        ),
      );
      assert.equal(calls.length, 1);
      assert.equal(res.status, "success");
      assert.deepEqual(res.details?.cost, [{ amount: 0.025, unit: "USD" }]);
      assert.equal(progress.length, 1);
      assert.match(progress[0]!.message, /Search round 1 \(x_semantic_search\): "effect 4 migration"/);
      assert.match(res.text, /\*\*response_id:\*\* resp_123/);
      assert.match(res.text, /\$0\.0250/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("recovers a cut SSE stream via read-only GET /v1/responses/:id without re-POSTing and emits polling progress", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "dig-xsearch-cut-"));
    try {
      process.env.DIG_STATE_DIR = tmp;
      let getCount = 0;
      const finishedBody = {
        id: "resp_cut_1",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "Recovered answer from xAI." }],
          },
        ],
        usage: { total_tokens: 800, cost_in_usd_ticks: 100_000_000 },
      };

      const { calls, layer } = makeLayers((url, method) => {
        if (method === "POST") {
          // Stream ends without response.completed after sending response.created
          return sseResponse([
            { event: "response.created", data: { type: "response.created", response: { id: "resp_cut_1", status: "in_progress" } } },
          ]);
        }
        assert.equal(method, "GET");
        assert.equal(url.pathname, "/v1/responses/resp_cut_1");
        getCount += 1;
        return new Response(JSON.stringify(getCount === 1 ? { id: "resp_cut_1", status: "in_progress" } : finishedBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const { ctx, progress } = makeCtx();
      const res = await Effect.runPromise(
        executeAction(xsearchAction, { query: "cut stream test" }, ctx).pipe(Effect.provide(layer)),
      );
      assert.equal(calls.filter((c) => c.method === "POST").length, 1, "Must NEVER re-POST on stream cut");
      assert.equal(calls.filter((c) => c.method === "GET").length, 2);
      assert.equal(res.status, "success");
      assert.match(res.text, /Recovered answer from xAI\./);
      assert.match(res.text, /\*\*Recovered:\*\*/);
      assert.deepEqual(res.details?.cost, [{ amount: 0.01, unit: "USD" }]);
      assert.ok(progress.some((p) => /polling stored xAI response resp_cut_1/.test(p.message)));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("supports durable read-only reconcile() and free recoverResponseId without ever POSTing", async () => {
    const storedBody = {
      id: "resp_stored_9",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_9",
          role: "assistant",
          content: [{ type: "output_text", text: "Stored answer body." }],
        },
      ],
      usage: { total_tokens: 400, cost_in_usd_ticks: 50_000_000 },
    };

    const { calls, layer } = makeLayers((url, method) => {
      assert.equal(method, "GET", "reconcile and recoverResponseId must ONLY send GET");
      if (url.pathname === "/v1/responses/resp_stored_9") {
        return new Response(JSON.stringify(storedBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: "resp_running", status: "in_progress" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // 1. reconcile finished response
    const { ctx } = makeCtx();
    assert.ok(xsearchAction.reconcile);
    const reconciled = await Effect.runPromise(
      xsearchAction.reconcile("resp_stored_9", { query: "original" }, ctx).pipe(Effect.provide(layer)),
    );
    assert.ok(reconciled);
    assert.equal(reconciled.status, "success");
    assert.deepEqual(reconciled.details?.cost, [{ amount: 0.005, unit: "USD" }]);
    assert.match(reconciled.text, /Stored answer body\./);

    // 2. reconcile still-running response -> null
    const pending = await Effect.runPromise(
      xsearchAction.reconcile("resp_running", { query: "original" }, ctx).pipe(Effect.provide(layer)),
    );
    assert.equal(pending, null);

    // 3. recoverResponseId is free (cost: [])
    const recovered = await Effect.runPromise(
      executeAction(xsearchAction, { query: "original", recoverResponseId: "resp_stored_9" }, ctx).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(recovered.status, "success");
    assert.deepEqual(recovered.details?.cost, []);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  });
});
