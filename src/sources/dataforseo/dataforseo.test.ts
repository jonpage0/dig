import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import {
  decodeActionArgs,
  executeAction,
  type ActionContext,
  type AnyActionDefinition,
  type ToolProgress,
} from "../../core/plugin.ts";
import { knownSecrets } from "../../core/secrets.ts";
import dataforseoSource, {
  dataforseoDocsIndexAction,
  dataforseoDocsReadAction,
  dataforseoDocsSectionsAction,
  dataforseoRequestAction,
  dataforseoSource as namedDataforseoSource,
} from "./index.ts";

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

const LOGIN = "analyst@example.com";
const PASSWORD = "dfs-test-password-9f2c";

function makeTestEnv(
  handler: (req: RecordedRequest) => Response | { readonly error: string },
  options?: { readonly maxRedirects?: number },
) {
  const requests: RecordedRequest[] = [];
  const progressEvents: ToolProgress[] = [];
  const base = HttpClient.make((req) =>
    Effect.gen(function* () {
      let body: unknown = undefined;
      if (req.body._tag === "Uint8Array") {
        try {
          body = JSON.parse(new TextDecoder().decode(req.body.body));
        } catch {
          body = undefined;
        }
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v);
      const rec: RecordedRequest = { url: req.url, method: req.method, headers, body };
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
    Layer.succeed(
      FreeHttp,
      makeFreeClient(base, { resolveDns: false, retries: 0, maxRedirects: options?.maxRedirects ?? 0 }),
    ),
  );
  const ctx: ActionContext = {
    digId: "dig-test",
    project: "/tmp",
    signal: new AbortController().signal,
    progress: (update) => progressEvents.push(update),
    keep: () => {},
  };
  return {
    requests,
    progressEvents,
    run: <A extends AnyActionDefinition>(action: A, rawArgs: unknown) => {
      const decoded = decodeActionArgs(action, rawArgs);
      if (!decoded.ok) {
        return Promise.resolve({ status: "failed" as const, text: decoded.error, details: { cost: null } });
      }
      return Effect.runPromise(executeAction(action, decoded.args, ctx).pipe(Effect.provide(layer)));
    },
  };
}

const envelope = (tasks: readonly Record<string, unknown>[], cost: number) => ({
  version: "0.1.20261101",
  status_code: 20000,
  status_message: "Ok.",
  time: "1.2 sec.",
  cost,
  tasks_count: tasks.length,
  tasks_error: tasks.filter((t) => t.status_code !== 20000).length,
  tasks,
});

const INDEX = [
  "Docs DataForSEO V3",
  "",
  "- [Authentication](https://docs.dataforseo.com/v3/auth.md) — Use your API login and password.",
  "## SERP API",
  "### Google",
  "#### Organic",
  "##### Live",
  "- [Live Google Organic SERP Advanced](https://docs.dataforseo.com/v3/serp/google/organic/live/advanced.md) — ![checked](https://docs.dataforseo.com/v3/icon.svg) Real-time [top results](https://example.com) for a keyword.",
  "## DataForSEO Labs API",
  "- [Keyword Ideas](https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live.md) — Keyword ideas for seed keywords.",
].join("\n");

describe("dataforseo source plugin", () => {
  const savedUser = process.env.DATAFORSEO_USERNAME;
  const savedPass = process.env.DATAFORSEO_PASSWORD;

  beforeEach(() => {
    process.env.DATAFORSEO_USERNAME = LOGIN;
    process.env.DATAFORSEO_PASSWORD = PASSWORD;
  });

  afterEach(() => {
    if (savedUser === undefined) delete process.env.DATAFORSEO_USERNAME;
    else process.env.DATAFORSEO_USERNAME = savedUser;
    if (savedPass === undefined) delete process.env.DATAFORSEO_PASSWORD;
    else process.env.DATAFORSEO_PASSWORD = savedPass;
  });

  test("exports dataforseoSource with 4 actions and slow:true on dataforseo_request", () => {
    assert.equal(dataforseoSource, namedDataforseoSource);
    assert.equal(dataforseoSource.id, "dataforseo");
    assert.equal(dataforseoSource.group, "markets");
    assert.deepEqual(dataforseoSource.skills, ["dataforseo", "dataforseo-ai-visibility"]);
    assert.equal(dataforseoRequestAction.slow, true);
    assert.deepEqual(
      dataforseoSource.actions.map((a) => a.name),
      ["dataforseo_docs_sections", "dataforseo_docs_index", "dataforseo_docs_read", "dataforseo_request"],
    );
  });

  test("live request sends Basic auth once, emits live ctx.progress updates, compacts nulls, and meters USD cost", async () => {
    const env = makeTestEnv(() =>
      Response.json(
        envelope(
          [
            {
              id: "t-1",
              status_code: 20000,
              status_message: "Ok.",
              cost: 0.002,
              result_count: 1,
              data: { keyword: "espresso" },
              result: [{ keyword: "espresso", items: [{ rank_group: 1, domain: "example.com", description: null, links: [] }] }],
            },
            {
              id: "t-2",
              status_code: 40501,
              status_message: "Invalid Field: 'location_code'.",
              cost: 0,
              result_count: 0,
              result: null,
            },
          ],
          0.002,
        ),
      ),
    );
    const tasks = [
      { keyword: "espresso", location_code: 2840, language_code: "en", resolve_goto_urls: true },
      { keyword: "espresso", location_code: -1 },
    ];
    const result = await env.run(dataforseoRequestAction, {
      path: "/v3/serp/google/organic/live/advanced",
      tasks,
    });
    assert.equal(env.requests.length, 1);
    assert.equal(env.requests[0].url, "https://api.dataforseo.com/v3/serp/google/organic/live/advanced");
    assert.equal(env.requests[0].headers.authorization, `Basic ${Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64")}`);
    assert.equal(result.status, "partial");
    assert.deepEqual(result.details?.cost, [{ amount: 0.002, unit: "USD" }]);
    assert.match(result.text, /"domain":"example\.com"/);
    assert.doesNotMatch(result.text, /"description"|"links"/);
    assert.ok(!JSON.stringify(result).includes(PASSWORD));
    assert.equal(env.progressEvents.length, 3);
    assert.equal(env.progressEvents[0].progress, 1);
    assert.equal(env.progressEvents[2].progress, 3);
  });

  test("sandbox call goes to sandbox host and records zero/free cost even when envelope reports cost or transport fails", async () => {
    const envOk = makeTestEnv(() =>
      Response.json(
        envelope([{ id: "s-1", status_code: 20000, status_message: "Ok.", cost: 0.0101, result_count: 1, result: [{ ok: true }] }], 0.0101),
      ),
    );
    const ok = await envOk.run(dataforseoRequestAction, {
      path: "serp/google/organic/live/advanced",
      tasks: [{ keyword: "x" }],
      sandbox: true,
    });
    assert.equal(ok.status, "success");
    assert.equal(envOk.requests[0].url, "https://sandbox.dataforseo.com/v3/serp/google/organic/live/advanced");
    assert.deepEqual(ok.details?.cost, []);

    const envFail = makeTestEnv(() => ({ error: "network down" }));
    const fail = await envFail.run(dataforseoRequestAction, {
      path: "serp/google/organic/live/advanced",
      tasks: [{ keyword: "x" }],
      sandbox: true,
    });
    assert.equal(fail.status, "failed");
    assert.deepEqual(fail.details?.cost, []);
    assert.doesNotMatch(fail.text, /charged/);
  });

  test("live transport failure or non-JSON 502 records unknown cost (null) and never retries", async () => {
    const envErr = makeTestEnv(() => ({ error: "fetch failed" }));
    const r1 = await envErr.run(dataforseoRequestAction, {
      path: "serp/google/organic/live/advanced",
      tasks: [{ keyword: "x" }],
    });
    assert.equal(envErr.requests.length, 1);
    assert.equal(r1.status, "failed");
    assert.equal(r1.details?.cost, null);
    assert.match(r1.text, /no complete response arrived; its cost is unknown/);

    const env502 = makeTestEnv(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    const r2 = await env502.run(dataforseoRequestAction, {
      path: "serp/google/organic/live/advanced",
      tasks: [{ keyword: "x" }],
    });
    assert.equal(env502.requests.length, 1);
    assert.equal(r2.status, "failed");
    assert.equal(r2.details?.cost, null);
  });

  test("documented task codes (40102 empty, 40106 partial, 40602 queued) and redirect/path guards work", async () => {
    const runTask = async (task: Record<string, unknown>) => {
      const env = makeTestEnv(() => Response.json(envelope([{ id: "t", cost: 0.004, result_count: 0, ...task }], 0.004)));
      return env.run(dataforseoRequestAction, { path: "serp/google/organic/live/advanced", tasks: [{ keyword: "x" }] });
    };
    assert.equal((await runTask({ status_code: 40102, status_message: "No Search Results.", result: null })).status, "empty");
    const partial = await runTask({ status_code: 40106, status_message: "Partial", result: [{ items: [1] }] });
    assert.equal(partial.status, "partial");
    assert.deepEqual(partial.details?.cost, [{ amount: 0.004, unit: "USD" }]);
    const queued = await runTask({ status_code: 40602, status_message: "Task In Queue.", result: null });
    assert.equal(queued.status, "success");
    assert.match(queued.text, /task_get/);

    const envGuard = makeTestEnv(() => new Response(null, { status: 307, headers: { location: "https://evil.example/v3" } }));
    for (const badPath of [
      "serp/google/organic/live/advanced.ai",
      "serp/../appendix/user_data",
      "https://sandbox.dataforseo.com/v3/serp/google/organic/live/advanced",
      "serp/google/locations?country=us",
    ]) {
      assert.equal(
        (await envGuard.run(dataforseoRequestAction, { path: badPath, tasks: [{ keyword: "x" }] })).status,
        "failed",
        badPath,
      );
    }
    assert.equal(envGuard.requests.length, 0);

    const redir = await envGuard.run(dataforseoRequestAction, {
      path: "serp/google/organic/live/advanced",
      tasks: [{ keyword: "x" }],
    });
    assert.equal(redir.status, "failed");
    assert.match(redir.text, /does not follow redirects/);
    assert.equal(redir.details?.cost, null);
  });

  test("docs tools use FreeHttp with free billing, filter sections/index, page markdown, and guard redirects", async () => {
    const env = makeTestEnv((req) =>
      req.url.endsWith("llms.txt")
        ? new Response(INDEX)
        : req.url.endsWith("live/advanced.md")
          ? new Response("# Live Google Organic SERP Advanced\nPOST https://api.dataforseo.com/v3/serp/google/organic/live/advanced")
          : new Response("Not found", { status: 404 }),
    );
    const sections = await env.run(dataforseoDocsSectionsAction, {});
    assert.equal(sections.status, "success");
    assert.match(sections.text, /SERP API \(1 pages\)/);
    assert.deepEqual(sections.details?.cost, []);

    const index = await env.run(dataforseoDocsIndexAction, { section: "serp", query: "organic live" });
    assert.equal(index.status, "success");
    assert.match(index.text, /serp\/google\/organic\/live\/advanced/);
    assert.doesNotMatch(index.text, /Keyword Ideas/);

    const page = await env.run(dataforseoDocsReadAction, {
      path: "https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/",
      limit: 10,
    });
    assert.equal(page.status, "success");
    assert.match(page.text, /characters 0–10 of/);
    assert.deepEqual(page.details?.cost, []);

    const envCrossHost = makeTestEnv(() => new Response(null, { status: 301, headers: { location: "https://elsewhere.example/auth.md" } }));
    const blocked = await envCrossHost.run(dataforseoDocsReadAction, { path: "auth" });
    assert.equal(blocked.status, "failed");
    assert.match(blocked.text, /redirected to another host/);

    assert.ok(knownSecrets().includes(PASSWORD));
    assert.ok(!knownSecrets().includes(LOGIN));
  });
});
