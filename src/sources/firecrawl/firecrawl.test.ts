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
} from "../../core/plugin.ts";
import firecrawlSource, {
  firecrawlMapAction,
  firecrawlScrapeAction,
  reportedFirecrawlCredits,
  validatePublicHttpUrl,
} from "./index.ts";

interface CapturedCall {
  readonly url: string;
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

function decodeBody(req: HttpClientRequest.HttpClientRequest): Record<string, unknown> {
  if (req.body._tag === "Uint8Array") {
    const text = new TextDecoder().decode(req.body.body);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }
  return {};
}

function makeMockLayer(handler: (call: CapturedCall) => MockReply) {
  const calls: CapturedCall[] = [];
  const base = HttpClient.make((req) =>
    Effect.suspend(() => {
      const call: CapturedCall = {
        url: req.url,
        method: req.method,
        headers: { ...req.headers },
        body: decodeBody(req),
      };
      calls.push(call);
      const reply = handler(call);
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

function makeCtx() {
  const kept: Array<{ readonly label: string; readonly status: number | string; readonly body: unknown }> = [];
  const ctx: ActionContext = {
    digId: "dig-firecrawl-test",
    project: "/tmp/firecrawl-test",
    signal: new AbortController().signal,
    keep(label, status, body) {
      kept.push({ label, status, body });
    },
    progress() {},
  };
  return { ctx, kept };
}

describe("firecrawl source plugin (Effect 4.1.5)", () => {
  const savedKey = process.env.FIRECRAWL_API_KEY;

  beforeEach(() => {
    process.env.FIRECRAWL_API_KEY = "fc-test-key";
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = savedKey;
  });

  it("exports plugin metadata and validates schemas and bounds", () => {
    assert.equal(firecrawlSource.id, "firecrawl");
    assert.equal(firecrawlSource.group, "web");
    assert.equal(firecrawlSource.logo, undefined);
    assert.deepEqual(
      firecrawlSource.actions.map((a) => a.name),
      ["firecrawl_scrape", "firecrawl_map"],
    );

    for (const action of firecrawlSource.actions) {
      assert.equal(schemaToMcpJson(action.schema, { compact: true }).type, "object");
    }

    assert.equal(
      decodeActionArgs(firecrawlScrapeAction, {
        url: "https://example.com",
        formats: ["markdown", "links"],
        onlyMainContent: false,
        maxAge: 0,
        waitFor: 10_000,
      }).ok,
      true,
    );
    assert.equal(
      decodeActionArgs(firecrawlScrapeAction, { url: "https://example.com", waitFor: 10_001 }).ok,
      false,
    );
    assert.equal(
      decodeActionArgs(firecrawlScrapeAction, { url: "https://example.com", formats: ["screenshot"] }).ok,
      false,
    );
    assert.equal(
      decodeActionArgs(firecrawlMapAction, {
        url: "https://example.com",
        search: "api",
        limit: 200,
        sitemap: "only",
      }).ok,
      true,
    );
    assert.equal(
      decodeActionArgs(firecrawlMapAction, { url: "https://example.com", limit: 201 }).ok,
      false,
    );
  });

  it("scrape posts to /v2/scrape with Bearer auth and meters top-level creditsUsed", async () => {
    const { calls, layer } = makeMockLayer(() => ({
      payload: {
        success: true,
        creditsUsed: 1,
        data: {
          markdown: "# Hello Firecrawl\n\nClean content from JS page.",
          metadata: {
            title: "Hello Firecrawl",
            description: "Sample page",
            sourceURL: "https://example.com/docs",
            url: "https://example.com/docs/intro",
            statusCode: 200,
            cacheState: "miss",
          },
        },
      },
    }));
    const { ctx, kept } = makeCtx();

    const out = await Effect.runPromise(
      executeAction(
        firecrawlScrapeAction,
        { url: "https://example.com/docs", onlyMainContent: true, maxAge: 0, waitFor: 1500 },
        ctx,
      ).pipe(Effect.provide(layer)),
    );

    assert.equal(out.status, "success", out.text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.firecrawl.dev/v2/scrape");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.authorization, "Bearer fc-test-key");
    assert.deepEqual(calls[0]!.body, {
      url: "https://example.com/docs",
      formats: ["markdown"],
      onlyMainContent: true,
      maxAge: 0,
      waitFor: 1500,
      timeout: 60_000,
    });
    assert.deepEqual(out.details?.cost, [{ amount: 1, unit: "Firecrawl credits" }]);
    assert.match(out.text, /# Hello Firecrawl/);
    assert.match(out.text, /1 Firecrawl credit/);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.label, "/v2/scrape");
  });

  it("scrape meters nested data.metadata.creditsUsed and keeps omitted credits as unknown (never 0)", async () => {
    const nested = makeMockLayer(() => ({
      payload: {
        success: true,
        data: {
          markdown: "Nested credit page",
          metadata: { title: "Nested", creditsUsed: 2, statusCode: 200 },
        },
      },
    }));
    const nestedOut = await Effect.runPromise(
      executeAction(firecrawlScrapeAction, { url: "https://example.com/nested" }, makeCtx().ctx).pipe(
        Effect.provide(nested.layer),
      ),
    );
    assert.equal(nestedOut.status, "success");
    assert.deepEqual(nestedOut.details?.cost, [{ amount: 2, unit: "Firecrawl credits" }]);

    const omitted = makeMockLayer(() => ({
      payload: {
        success: true,
        data: { markdown: "No credits field", metadata: { title: "Omitted", statusCode: 200 } },
      },
    }));
    const omittedOut = await Effect.runPromise(
      executeAction(firecrawlScrapeAction, { url: "https://example.com/omitted" }, makeCtx().ctx).pipe(
        Effect.provide(omitted.layer),
      ),
    );
    assert.equal(omittedOut.status, "success");
    assert.equal(omittedOut.details?.cost, null);
    assert.match(omittedOut.text, /credits not reported \(cost unknown\)/);
  });

  it("scrape supports html and links formats and truncates cleanly at maxCharacters", async () => {
    const { layer } = makeMockLayer(() => ({
      payload: {
        success: true,
        creditsUsed: 1,
        data: {
          markdown: "A".repeat(800),
          links: ["https://example.com/a", "https://example.com/b"],
          metadata: { title: "Big Page", statusCode: 200 },
        },
      },
    }));

    const out = await Effect.runPromise(
      executeAction(
        firecrawlScrapeAction,
        { url: "https://example.com/big", formats: ["markdown", "links"], maxCharacters: 500 },
        makeCtx().ctx,
      ).pipe(Effect.provide(layer)),
    );
    assert.equal(out.status, "success");
    assert.equal(out.details?.truncated, true);
    assert.match(out.text, /Truncated at 500 characters/);
  });

  it("refuses private, loopback, link-local, metadata, and non-http(s) URLs before any paid request", async () => {
    const { calls, layer } = makeMockLayer(() => {
      throw new Error("should not fetch");
    });

    const blocked = [
      "http://localhost/admin",
      "http://foo.localhost/secret",
      "http://127.0.0.1:47811/health",
      "http://10.0.0.1/internal",
      "http://172.16.0.5/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://[fc00::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
      "http://[::127.0.0.1]/",
      "http://[::ffff:0:127.0.0.1]/",
      "http://[64:ff9b::169.254.169.254]/",
      "http://[2002:a9fe:a9fe::]/",
      "http://[2001:db8::1]/",
      "http://198.51.100.1/",
      "http://203.0.113.1/",
      "http://localhost../",
      "http://metadata.goog/",
      "http://printer.home.arpa/",
      "http://printer.local/",
      "http://metadata.google.internal/",
      "http://intranet/dashboard",
      "file:///etc/passwd",
      "ftp://example.com/file",
      "https://user:pass@example.com/",
      "example.com/no-scheme",
    ];

    for (const url of blocked) {
      const check = validatePublicHttpUrl(url);
      assert.ok("error" in check, `expected ${url} to be refused`);
      const out = await Effect.runPromise(
        executeAction(firecrawlScrapeAction, { url }, makeCtx().ctx).pipe(Effect.provide(layer)),
      );
      assert.equal(out.status, "failed", url);
    }
    assert.equal(calls.length, 0);
  });

  it("never retries paid calls on 429 or transport error and redacts API key from errors", async () => {
    const errMock = makeMockLayer(() => ({
      status: 429,
      payload: { success: false, error: "Rate limited for key fc-test-key" },
    }));

    const rateLimited = await Effect.runPromise(
      executeAction(firecrawlScrapeAction, { url: "https://example.com/rl" }, makeCtx().ctx).pipe(
        Effect.provide(errMock.layer),
      ),
    );
    assert.equal(rateLimited.status, "failed");
    assert.equal(errMock.calls.length, 1);
    assert.equal(rateLimited.details?.cost, null);
    assert.equal(rateLimited.text.includes("fc-test-key"), false);
    assert.match(rateLimited.text, /\[redacted\]/);

    const netMock = makeMockLayer(() => ({
      transportError: "socket hang up with fc-test-key",
    }));
    const dropped = await Effect.runPromise(
      executeAction(firecrawlMapAction, { url: "https://example.com" }, makeCtx().ctx).pipe(
        Effect.provide(netMock.layer),
      ),
    );
    assert.equal(dropped.status, "failed");
    assert.equal(netMock.calls.length, 1);
    assert.equal(dropped.details?.cost, null);
    assert.match(dropped.text, /cost is unknown/);
    assert.equal(dropped.text.includes("fc-test-key"), false);
  });

  it("map posts to /v2/map, renders object and string links, and returns empty when links is empty", async () => {
    const populated = makeMockLayer(() => ({
      payload: {
        success: true,
        creditsUsed: 1,
        links: [
          { url: "https://example.com/pricing", title: "Pricing", description: "Plan tiers and credits." },
          "https://example.com/docs",
        ],
      },
    }));

    const out = await Effect.runPromise(
      executeAction(
        firecrawlMapAction,
        { url: "https://example.com", search: "pricing", limit: 25, sitemap: "include" },
        makeCtx().ctx,
      ).pipe(Effect.provide(populated.layer)),
    );
    assert.equal(out.status, "success", out.text);
    assert.equal(populated.calls[0]!.url, "https://api.firecrawl.dev/v2/map");
    assert.deepEqual(populated.calls[0]!.body, {
      url: "https://example.com/",
      search: "pricing",
      limit: 25,
      sitemap: "include",
      timeout: 60_000,
    });
    assert.deepEqual(out.details?.cost, [{ amount: 1, unit: "Firecrawl credits" }]);
    assert.match(out.text, /1\. https:\/\/example\.com\/pricing — Pricing/);
    assert.match(out.text, /2\. https:\/\/example\.com\/docs/);

    const empty = makeMockLayer(() => ({ payload: { success: true, links: [] } }));
    const emptyOut = await Effect.runPromise(
      executeAction(firecrawlMapAction, { url: "https://example.com", search: "none" }, makeCtx().ctx).pipe(
        Effect.provide(empty.layer),
      ),
    );
    assert.equal(emptyOut.status, "empty");
    assert.equal(emptyOut.details?.cost, null);
    assert.equal(reportedFirecrawlCredits({ success: true }), null);
  });
});
