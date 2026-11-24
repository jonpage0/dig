import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import {
  decodeActionArgs,
  executeAction,
  schemaToMcpJson,
  type ActionContext,
  type ToolProgress,
} from "../../core/plugin.ts";
import deepwikiSource, {
  deepwikiAskQuestionAction,
  deepwikiReadContentsAction,
  deepwikiReadStructureAction,
} from "./index.ts";

interface CapturedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
}

function decodeBody(req: HttpClientRequest.HttpClientRequest): Record<string, unknown> {
  if (req.body._tag === "Uint8Array") {
    const text = new TextDecoder().decode(req.body.body);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }
  return {};
}

function makeMockLayer(handler: (call: CapturedCall) => Response) {
  const calls: CapturedCall[] = [];
  const base = HttpClient.make((req) =>
    Effect.sync(() => {
      const call: CapturedCall = {
        url: req.url,
        method: req.method,
        headers: { ...req.headers },
        body: decodeBody(req),
      };
      calls.push(call);
      return HttpClientResponse.fromWeb(req, handler(call));
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(PaidHttp, makePaidClient(base, { resolveDns: false })),
    Layer.succeed(FreeHttp, makeFreeClient(base, { resolveDns: false, retries: 0 })),
  );
  return { calls, layer };
}

function makeCtx() {
  const kept: Array<{ readonly label: string; readonly status: number | string; readonly body: unknown }> = [];
  const progress: ToolProgress[] = [];
  const ctx: ActionContext = {
    digId: "dig-deepwiki-test",
    project: "/tmp/deepwiki-test",
    signal: new AbortController().signal,
    keep(label, status, body) {
      kept.push({ label, status, body });
    },
    progress(update) {
      progress.push(update);
    },
  };
  return { ctx, kept, progress };
}

describe("deepwiki source plugin (Effect 4.1.5)", () => {
  const savedExaKey = process.env.EXA_API_KEY;

  afterEach(() => {
    if (savedExaKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = savedExaKey;
  });

  it("exports plugin metadata, marks deepwiki_ask_question slow, and validates schemas", () => {
    assert.equal(deepwikiSource.id, "deepwiki");
    assert.equal(deepwikiSource.group, "code");
    assert.deepEqual(
      deepwikiSource.actions.map((a) => a.name),
      ["deepwiki_read_wiki_structure", "deepwiki_read_wiki_contents", "deepwiki_ask_question"],
    );
    assert.equal(deepwikiAskQuestionAction.slow, true);
    assert.equal(deepwikiReadStructureAction.slow, undefined);

    for (const action of deepwikiSource.actions) {
      assert.equal(schemaToMcpJson(action.schema, { compact: true }).type, "object");
    }
    assert.equal(
      decodeActionArgs(deepwikiAskQuestionAction, { repoName: "owner/repo", question: "How?" }).ok,
      true,
    );
    assert.equal(decodeActionArgs(deepwikiAskQuestionAction, { repoName: "owner/repo" }).ok, false);
  });

  it("deepwiki_ask_question parses SSE streams, emits live ctx.progress updates, and uses free billing", async () => {
    const stream = [
      ": ping - 2026-09-27 19:29:26",
      "",
      "event: message",
      'data: {"method":"notifications/message","params":{"level":"info","data":{"msg":"Processing query (14s elapsed)"}},"jsonrpc":"2.0"}',
      "",
      "event: message",
      'data: {"jsonrpc":"2.0","id":"ask_question-1","result":{"content":[{"type":"text","text":"It produces an HTMLBundle."}]}}',
      "",
    ].join("\r\n");

    const { calls, layer } = makeMockLayer(
      () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    );
    const { ctx, progress } = makeCtx();

    const out = await Effect.runPromise(
      executeAction(
        deepwikiAskQuestionAction,
        { repoName: "oven-sh/bun", question: "How do HTML imports work?" },
        ctx,
      ).pipe(Effect.provide(layer)),
    );

    assert.equal(out.status, "success");
    assert.deepEqual(out.details?.cost, []);
    assert.match(out.text, /HTMLBundle/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://mcp.deepwiki.com/mcp");
    assert.equal(calls[0]!.body.method, "tools/call");
    assert.ok(progress.length >= 3, "expected initial, notification, and completion progress updates");
    assert.match(progress[0]!.message, /Asking DeepWiki/);
    assert.match(progress[1]!.message, /Processing query \(14s elapsed\)/);
    assert.equal(progress[progress.length - 1]!.progress, 2);
  });

  it("deepwiki_read_wiki_contents cuts wikis over 200,000 chars at a heading boundary while keeping the full wiki in raw capture", async () => {
    const page = (n: number) => `# Page: Part ${n}\n\n${"Body text of this page. ".repeat(400)}\n\n`;
    const wiki = Array.from({ length: 40 }, (_, n) => page(n + 1)).join("");
    const { layer } = makeMockLayer(() =>
      Response.json({ jsonrpc: "2.0", result: { content: [{ type: "text", text: wiki }] } }),
    );
    const { ctx, kept } = makeCtx();

    const out = await Effect.runPromise(
      executeAction(deepwikiReadContentsAction, { repoName: "fixture/repo" }, ctx).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(out.status, "partial");
    const [notice, ...rest] = out.text.split("\n\n");
    const shown = rest.join("\n\n");
    assert.ok(shown.length <= 200_000);
    assert.equal(wiki.startsWith(shown), true);
    assert.equal(wiki.slice(shown.length).startsWith("# Page: "), true);
    assert.match(notice!, /Showing the first/);
    const retained = kept[0]!.body as { readonly result: { readonly content: readonly { readonly text: string }[] } };
    assert.equal(retained.result.content[0]!.text, wiki);
  });

  it("deepwiki upstream isError stays failed and error excerpts redact echoed secrets before slicing", async () => {
    const isErrMock = makeMockLayer(() =>
      Response.json({
        jsonrpc: "2.0",
        result: { isError: true, content: [{ type: "text", text: "Repository unavailable" }] },
      }),
    );
    const errRes = await Effect.runPromise(
      executeAction(deepwikiReadStructureAction, { repoName: "fixture/repo" }, makeCtx().ctx).pipe(
        Effect.provide(isErrMock.layer),
      ),
    );
    assert.equal(errRes.status, "failed");
    assert.match(errRes.text, /Repository unavailable/);

    process.env.EXA_API_KEY = `PRIVATE/percent+KEY space-unique-${"7G9w".repeat(20)}`; // gitleaks:allow
    const encoded = encodeURIComponent(process.env.EXA_API_KEY).replace(/%[0-9A-F]{2}/g, (e) =>
      e.toLowerCase(),
    );
    const leakMock = makeMockLayer(() => new Response(`${"X".repeat(260)}${encoded}`, { status: 502 }));
    const leakRes = await Effect.runPromise(
      executeAction(deepwikiReadContentsAction, { repoName: "fixture/repo" }, makeCtx().ctx).pipe(
        Effect.provide(leakMock.layer),
      ),
    );
    assert.equal(leakRes.status, "failed");
    assert.match(leakRes.text, /DeepWiki HTTP 502/);
    assert.equal(leakRes.text.includes("PRIVATE%2f"), false);
  });
});
