import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import {
  decodeActionArgs,
  executeAction,
  schemaToMcpJson,
  type ActionContext,
} from "../../core/plugin.ts";
import hackernewsSource, {
  hackernewsReadAction,
  hackernewsSearchAction,
  hnText,
} from "./index.ts";

interface MockHandler {
  (url: string): Response | { readonly transportError: string };
}

function makeMockLayer(handler: MockHandler) {
  const seen: string[] = [];
  const base = HttpClient.make((req) =>
    Effect.suspend(() => {
      seen.push(req.url);
      const reply = handler(req.url);
      if (reply instanceof Response) {
        return Effect.succeed(HttpClientResponse.fromWeb(req, reply));
      }
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request: req,
            description: reply.transportError,
          }),
        }),
      );
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(PaidHttp, makePaidClient(base, { resolveDns: false })),
    Layer.succeed(FreeHttp, makeFreeClient(base, { resolveDns: false, retries: 0 })),
  );
  return { seen, layer };
}

function makeCtx(signal?: AbortSignal): ActionContext {
  return {
    digId: "dig-hn-test",
    project: "/tmp/hn-test",
    signal: signal ?? new AbortController().signal,
    keep() {},
    progress() {},
  };
}

const comment = (id: number, children: readonly unknown[] = []) => ({
  id,
  author: "author",
  text: `<p>Text ${id}</p>`,
  children,
});

describe("hackernews source plugin (Effect 4.1.5)", () => {
  it("exports plugin metadata and validates schemas and bounds", () => {
    assert.equal(hackernewsSource.id, "hackernews");
    assert.equal(hackernewsSource.group, "code");
    assert.equal(hackernewsSource.logo, "ycombinator");
    assert.deepEqual(
      hackernewsSource.actions.map((a) => a.name),
      ["hackernews", "hackernews_read"],
    );
    for (const action of hackernewsSource.actions) {
      assert.equal(schemaToMcpJson(action.schema, { compact: true }).type, "object");
    }

    assert.equal(decodeActionArgs(hackernewsSearchAction, { query: "x", limit: 50, days: 1 }).ok, true);
    for (const bad of [{ limit: 0 }, { limit: 2.5 }, { limit: 51 }, { days: -3 }, { days: 0 }]) {
      assert.equal(
        decodeActionArgs(hackernewsSearchAction, { query: "x", ...bad }).ok,
        false,
        JSON.stringify(bad),
      );
    }
    assert.equal(decodeActionArgs(hackernewsReadAction, { item: "1", offset: 0, limit: 500 }).ok, true);
    assert.equal(decodeActionArgs(hackernewsReadAction, { item: "1", limit: 501 }).ok, false);
  });

  it("hackernews_read retains parent IDs, supports pagination, and decodes entities once", async () => {
    const { seen, layer } = makeMockLayer((url) => {
      assert.equal(url, "https://hn.algolia.com/api/v1/items/1");
      return Response.json({
        id: 1,
        title: "Story",
        children: [comment(2, [comment(3)]), comment(4)],
      });
    });

    const first = await Effect.runPromise(
      executeAction(
        hackernewsReadAction,
        { item: "https://news.ycombinator.com/item?id=1", limit: 1 },
        makeCtx(),
      ).pipe(Effect.provide(layer)),
    );
    assert.equal(first.status, "success");
    assert.deepEqual(first.details?.cost, []);
    assert.match(first.text, /2 \(reply to 1\)/);
    assert.match(first.text, /offset=1/);

    const rest = await Effect.runPromise(
      executeAction(hackernewsReadAction, { item: "1", offset: 1, limit: 2 }, makeCtx()).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(rest.status, "success");
    assert.match(rest.text, /3 \(reply to 2\)/);
    assert.match(rest.text, /4 \(reply to 1\)/);
    assert.equal(seen.length, 2);

    assert.equal(
      hnText(
        'First sentence.<p>Second sentence. See <a href="https:&#x2F;&#x2F;example.com&#x2F;a&#x2F;long.html" rel="nofollow">https:&#x2F;&#x2F;example.com&#x2F;a&#x2F;lo...</a> and &amp;lt;b&amp;gt;',
      ),
      "First sentence.\nSecond sentence. See https://example.com/a/long.html and &lt;b&gt;",
    );
  });

  it("hackernews_read refuses invalid hosts/IDs and marks malformed descendants partial", async () => {
    const emptyMock = makeMockLayer(() => {
      throw new Error("must not fetch");
    });
    for (const item of ["https://example.com/item?id=1", "0", "1e5", "9007199254740993"]) {
      const out = await Effect.runPromise(
        executeAction(hackernewsReadAction, { item }, makeCtx()).pipe(Effect.provide(emptyMock.layer)),
      );
      assert.equal(out.status, "failed", item);
    }

    const wrongIdMock = makeMockLayer(() => Response.json({ id: 2, children: [] }));
    const wrongOut = await Effect.runPromise(
      executeAction(hackernewsReadAction, { item: "1" }, makeCtx()).pipe(Effect.provide(wrongIdMock.layer)),
    );
    assert.equal(wrongOut.status, "failed");

    const malformedMock = makeMockLayer(() => Response.json({ id: 1, children: [{ id: "bad" }] }));
    const malformedOut = await Effect.runPromise(
      executeAction(hackernewsReadAction, { item: "1" }, makeCtx()).pipe(Effect.provide(malformedMock.layer)),
    );
    assert.equal(malformedOut.status, "partial");
  });

  it("hackernews search reports failed comment-tree fetches as partial, applies points>2 on stories only, and omits points filter on all", async () => {
    const long = "word ".repeat(80);
    const story = (id: string, story_text: string) => ({
      objectID: id,
      title: `T${id}`,
      author: "a",
      points: 9,
      num_comments: 9,
      created_at: "2026-11-01T00:00:00Z",
      created_at_i: 1,
      story_text,
      _tags: ["story"],
    });

    const storyMock = makeMockLayer((url) => {
      if (url.includes("/search")) {
        return Response.json({ hits: [story("1", "Short.<p>Two &amp;amp; three"), story("2", long)], nbHits: 2 });
      }
      if (url.endsWith("/items/1")) return { transportError: "socket hang up" };
      return Response.json({
        id: 2,
        children: [
          { id: 3, author: "b", text: `<p>${"x".repeat(260)}</p>`, children: [] },
          { id: 4, author: "c", text: "<i>Fine</i> &amp; short", children: [] },
        ],
      });
    });

    const out = await Effect.runPromise(
      executeAction(hackernewsSearchAction, { query: "sqlite" }, makeCtx()).pipe(
        Effect.provide(storyMock.layer),
      ),
    );
    assert.equal(out.status, "partial", out.text);
    assert.deepEqual(out.details?.cost, []);
    assert.match(out.text, /1 of 2 comment-tree fetches failed/);
    assert.match(out.text, /more than 2 points/);
    assert.match(storyMock.seen[0]!, /points>2|points%3E2/);
    assert.match(out.text, /Text: Short\. Two &amp; three\n/);
    assert.match(out.text, /c \(0 replies\): Fine & short/);
    assert.match(out.text, /b \(0 replies\): x{250}\.\.\./);

    const allMock = makeMockLayer(() =>
      Response.json({
        hits: [
          {
            objectID: "9",
            author: "a",
            points: null,
            comment_text: "A comment.",
            story_title: "S",
            created_at: "2026-11-01T00:00:00Z",
            created_at_i: 1,
            _tags: ["comment"],
          },
        ],
        nbHits: 1,
      }),
    );
    const allOut = await Effect.runPromise(
      executeAction(hackernewsSearchAction, { query: "sqlite", type: "all" }, makeCtx()).pipe(
        Effect.provide(allMock.layer),
      ),
    );
    assert.equal(allOut.status, "success", allOut.text);
    assert.doesNotMatch(allMock.seen[0]!, /points/);
    assert.match(allOut.text, /No points filter: comments carry no points/);
  });
});
