import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext, type AnyActionDefinition } from "../../core/plugin.ts";
import polymarketSource, {
  polymarketAction,
  polymarketHistoryAction,
  polymarketResolutionAction,
} from "./index.ts";

const pmMarket = (overrides: Record<string, unknown> = {}) => ({
  id: "m",
  question: "Will X happen?",
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.4","0.6"]',
  active: true,
  closed: false,
  ...overrides,
});

function makeLayer(handler: (url: URL) => Response | Error | Promise<Response | Error>) {
  const base = HttpClient.make((req) =>
    Effect.tryPromise({
      try: async () => {
        const res = await handler(new URL(req.url));
        if (res instanceof Error) throw res;
        return HttpClientResponse.fromWeb(req, res);
      },
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request: req,
            description: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
        }),
    }),
  );
  return Layer.mergeAll(
    Layer.succeed(FreeHttp, makeFreeClient(base, { resolveDns: false, retries: 0 })),
    Layer.succeed(PaidHttp, makePaidClient(base, { resolveDns: false })),
  );
}

function run<A extends AnyActionDefinition>(
  action: A,
  args: unknown,
  handler: (url: URL) => Response | Error | Promise<Response | Error>,
) {
  const ctx: ActionContext = {
    digId: "pm-test",
    project: "/tmp",
    signal: new AbortController().signal,
    progress: () => {},
    keep: () => {},
  };
  return Effect.runPromise(
    executeAction(action, args as never, ctx).pipe(Effect.provide(makeLayer(handler))),
  );
}

describe("polymarketSource", () => {
  it("exports expected plugin metadata and validates search schema", () => {
    assert.equal(polymarketSource.id, "polymarket");
    assert.equal(polymarketSource.group, "markets");
    assert.equal(polymarketSource.logo, "polymarket");
    assert.deepEqual(
      polymarketSource.actions.map((a) => a.name),
      ["polymarket", "polymarket_history", "polymarket_resolution"],
    );
    assert.equal(decodeActionArgs(polymarketAction, { query: "x", limit: 2, page: 1 }).ok, true);
    for (const bad of [{ limit: -1 }, { limit: 0 }, { page: 1.5 }, { page: 0 }]) {
      assert.equal(decodeActionArgs(polymarketAction, { query: "x", ...bad }).ok, false);
    }
  });

  it("handles empty active markets, counts shown/matching/hasMore, prints n/a for missing prices/volume, and names movement", async () => {
    const empty = await run(polymarketAction, { query: "x" }, () =>
      Response.json({
        events: [{ id: "e1", title: "X event", slug: "x", markets: [pmMarket({ closed: true })] }],
        pagination: { hasMore: false },
      }),
    );
    assert.equal(empty.status, "empty");
    assert.deepEqual(empty.details?.cost, []);

    const paged = await run(polymarketAction, { query: "x", limit: 2 }, () =>
      Response.json({
        events: Array.from({ length: 12 }, (_, i) => ({
          id: `e${i}`,
          title: `X event ${i}`,
          slug: `x${i}`,
          markets: [pmMarket()],
        })),
        pagination: { hasMore: true },
      }),
    );
    assert.equal(paged.status, "success", paged.text);
    assert.match(paged.text, /2 of 12 matching open events shown; provider reports more: yes/);

    const missing = await run(polymarketAction, { query: "x" }, () =>
      Response.json({
        events: [
          {
            id: "e1",
            title: "X event",
            slug: "x",
            markets: [pmMarket({ outcomePrices: undefined, oneWeekPriceChange: -0.05 })],
          },
        ],
      }),
    );
    assert.match(missing.text, /Volume: n\/a/);
    assert.match(missing.text, /Yes: n\/a \/ No: n\/a/);
    assert.doesNotMatch(missing.text, /\$0 total|0\.0%/);
    assert.match(missing.text, /Movement of "Will X happen\?": ↓ 5\.0 percentage points over the rolling 7 days/);
  });

  it("prints condition/token IDs, labels grouped events by groupItemTitle, and handles partial expansion failures concurrently", async () => {
    const mk = (id: string, question: string, tokens: string, groupItemTitle?: string, yes = "0.4") => ({
      id,
      conditionId: `0x${id.repeat(64)}`,
      clobTokenIds: tokens,
      question,
      ...(groupItemTitle ? { groupItemTitle } : {}),
      outcomes: '["Yes","No"]',
      outcomePrices: JSON.stringify([yes, String(1 - Number(yes))]),
      active: true,
      closed: false,
    });

    const single = mk("a", "Will it rain in Austin?", '["111","222"]');
    const field = [
      mk("b", "Will there be no change in Fed rates?", '["333","444"]', "No change", "0.855"),
      mk("c", "Will the Fed decrease rates by 25 bps?", '["555","666"]', "25 bps decrease", "0.145"),
    ];
    const idsOut = await run(polymarketAction, { query: "rain" }, () =>
      Response.json({
        events: [
          { id: "e1", title: "Will it rain in Austin?", slug: "rain", markets: [single] },
          { id: "e2", title: "Fed decision?", slug: "fed", markets: field },
        ],
      }),
    );
    assert.equal(idsOut.status, "success");
    assert.ok(idsOut.text.includes(`Condition ID: ${single.conditionId}`));
    assert.ok(idsOut.text.includes(`Outcome token IDs (outcome order): ${single.clobTokenIds}`));
    assert.ok(idsOut.text.includes("No change: 85.5%"));
    assert.ok(idsOut.text.includes("25 bps decrease: 14.5%"));

    let inFlight = 0;
    let maxInFlight = 0;
    const partial = await run(polymarketAction, { query: "bitcoin price" }, async (url) => {
      const q = url.searchParams.get("q");
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      if (q === "bitcoin price") {
        return Response.json({
          events: [{ id: "e1", title: "bitcoin price", slug: "b", markets: [pmMarket()] }],
        });
      }
      if (q === "bitcoin") return new Error("socket hang up");
      return new Response("busy", { status: 503 });
    });
    assert.equal(partial.status, "partial", partial.text);
    assert.match(partial.text, /\*\*bitcoin price\*\*/);
    assert.match(partial.text, /"bitcoin"/);
    assert.match(partial.text, /"price" \(HTTP 503\)/);
    assert.equal(maxInFlight, 3);
  });

  it("polymarket_history validates windows/pagination and keeps cursor on line 1 even when truncated", async () => {
    let calls = 0;
    const paged = await run(polymarketHistoryAction, { token_id: "123", interval: "1w" }, (url) => {
      calls++;
      assert.equal(url.searchParams.get("token_id"), "123");
      return Response.json({
        data: [{ price: 0.4, timestamp: 1780000000, resolution_seconds: 300 }],
        pagination: { has_more: true, next_cursor: "next" },
      });
    });
    assert.equal(paged.status, "success");
    assert.deepEqual(paged.details?.cost, []);
    assert.match(paged.text, /^Pagination: has_more: true; next_cursor: next\n/);

    const mixed = await run(polymarketHistoryAction, { token_id: "123", interval: "1w", start: 1 }, () => {
      calls++;
      return Response.json({});
    });
    assert.equal(mixed.status, "failed");
    assert.equal(calls, 1);

    const missingCursor = await run(polymarketHistoryAction, { token_id: "123", interval: "1w" }, () =>
      Response.json({ data: [], pagination: { has_more: true } }),
    );
    assert.equal(missingCursor.status, "failed");

    const rows = Array.from({ length: 1000 }, (_, i) => ({
      timestamp: 1780000000 + i * 300,
      price: 0.5123,
      resolution_seconds: 300,
    }));
    const large = await run(polymarketHistoryAction, { token_id: "123", interval: "1w", limit: 1000 }, () =>
      Response.json({ data: rows, pagination: { has_more: true, next_cursor: "CURSOR_TOKEN_ABC" } }),
    );
    assert.equal(large.status, "partial");
    assert.match(large.text.split("\n")[0], /has_more: true; next_cursor: CURSOR_TOKEN_ABC/);
    assert.equal(large.details?.has_more, true);
    assert.equal(large.details?.next_cursor, "CURSOR_TOKEN_ABC");
  });

  it("polymarket_resolution validates selectors, trims comma-separated IDs, and reports estimate caveat", async () => {
    const out = await run(polymarketResolutionAction, { event_id: "123" }, () =>
      Response.json({ data: [{ status: "proposed", expected_settlement_time: "2026-10-20T12:00:00Z" }] }),
    );
    assert.equal(out.status, "success");
    assert.deepEqual(out.details?.cost, []);
    assert.match(out.text, /estimates, not deadlines/);

    const bad = await run(polymarketResolutionAction, { event_id: "123", question_id: "bad" }, () =>
      Response.json({ data: [] }),
    );
    assert.equal(bad.status, "failed");

    let sent = "";
    const a = `0x${"a".repeat(64)}`;
    const b = `0x${"b".repeat(64)}`;
    const trimmed = await run(polymarketResolutionAction, { condition: `${a}, ${b}` }, (url) => {
      sent = url.searchParams.get("condition") ?? "";
      return Response.json({ data: [{ status: "resolved" }] });
    });
    assert.equal(trimmed.status, "success");
    assert.equal(sent, `${a},${b}`);
  });
});
