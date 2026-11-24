import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext, type AnyActionDefinition } from "../../core/plugin.ts";
import blueskyDefault, {
  atUriToWebUrl,
  blueskyProfileAction,
  blueskySearchAction,
  blueskySource,
  blueskyThreadAction,
  parsePostTarget,
} from "./index.ts";

function makeLayers(handler: (url: URL, method: string) => Response) {
  const calls: string[] = [];
  const base = HttpClient.make((req) =>
    Effect.sync(() => {
      calls.push(req.url);
      const url = new URL(req.url);
      return HttpClientResponse.fromWeb(req, handler(url, req.method));
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(FreeHttp, makeFreeClient(base, { resolveDns: false, retries: 0 })),
    Layer.succeed(PaidHttp, makePaidClient(base, { resolveDns: false })),
  );
  return { calls, layer };
}

function makeCtx(signal?: AbortSignal): { ctx: ActionContext; kept: Array<{ label: string; status: number | string; body: unknown }> } {
  const kept: Array<{ label: string; status: number | string; body: unknown }> = [];
  const ctx: ActionContext = {
    digId: "test-dig",
    project: "/tmp",
    keep: (label, status, body) => kept.push({ label, status, body }),
    progress: () => {},
    signal: signal ?? new AbortController().signal,
  };
  return { ctx, kept };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("bluesky SourcePlugin", () => {
  it("exports metadata, default export, and 3 free actions", () => {
    assert.equal(blueskySource, blueskyDefault);
    assert.equal(blueskySource.id, "bluesky");
    assert.equal(blueskySource.group, "social");
    assert.deepEqual(
      blueskySource.actions.map((a: AnyActionDefinition) => a.name),
      ["bluesky_search", "bluesky_thread", "bluesky_profile"],
    );
    assert.ok(blueskySource.actions.every((a: AnyActionDefinition) => a.billing === "free"));
  });

  it("parses at:// URIs and bsky.app post URLs cleanly", () => {
    assert.equal(
      atUriToWebUrl("at://did:plc:abc123/app.bsky.feed.post/3kxyz", "alice.bsky.social"),
      "https://bsky.app/profile/alice.bsky.social/post/3kxyz",
    );
    assert.deepEqual(
      parsePostTarget("https://bsky.app/profile/alice.bsky.social/post/3kxyz"),
      { actor: "alice.bsky.social", rkey: "3kxyz", isDid: false },
    );
    assert.deepEqual(
      parsePostTarget("at://did:plc:abc123/app.bsky.feed.post/3kxyz"),
      { actor: "did:plc:abc123", rkey: "3kxyz", isDid: true },
    );
    assert.ok("error" in parsePostTarget("https://example.com/profile/a/post/1"));
  });

  it("bluesky_search formats posts, embeds, pagination cursor, and records free cost []", async () => {
    const { calls, layer } = makeLayers((url) => {
      assert.equal(url.pathname, "/xrpc/app.bsky.feed.searchPosts");
      assert.equal(url.searchParams.get("q"), "effect typescript");
      assert.equal(url.searchParams.get("sort"), "top");
      assert.equal(url.searchParams.get("author"), "alice.bsky.social");
      return jsonResponse({
        hitsTotal: 42,
        cursor: "cur-2",
        posts: [
          {
            uri: "at://did:plc:111/app.bsky.feed.post/3abc",
            author: { handle: "alice.bsky.social", displayName: "Alice" },
            record: { text: "Effect 4 is fast.", createdAt: "2026-11-20T12:00:00Z" },
            likeCount: 14,
            repostCount: 3,
            replyCount: 2,
            quoteCount: 1,
            embed: {
              external: { uri: "https://effect.website", title: "Effect Docs", description: "TypeScript effect system" },
            },
          },
        ],
      });
    });

    const decoded = decodeActionArgs(blueskySearchAction, {
      q: "effect typescript",
      sort: "top",
      author: "@alice.bsky.social",
      limit: 10,
    });
    assert.equal(decoded.ok, true);
    if (!decoded.ok) return;

    const { ctx, kept } = makeCtx();
    const res = await Effect.runPromise(
      executeAction(blueskySearchAction, decoded.args, ctx).pipe(Effect.provide(layer)),
    );
    assert.equal(calls.length, 1);
    assert.equal(kept.length, 1);
    assert.equal(res.status, "success");
    assert.deepEqual(res.details?.cost, []);
    assert.match(res.text, /Alice \(@alice\.bsky\.social\)/);
    assert.match(res.text, /Effect 4 is fast\./);
    assert.match(res.text, /Link: Effect Docs <https:\/\/effect\.website>/);
    assert.match(res.text, /More posts: pass cursor "cur-2"/);
  });

  it("bluesky_search handles empty results and HTTP errors cleanly", async () => {
    const emptyMock = makeLayers(() => jsonResponse({ posts: [] }));
    const { ctx } = makeCtx();
    const empty = await Effect.runPromise(
      executeAction(blueskySearchAction, { q: "no-hits-here" }, ctx).pipe(Effect.provide(emptyMock.layer)),
    );
    assert.equal(empty.status, "empty");
    assert.deepEqual(empty.details?.cost, []);

    const errMock = makeLayers(() => jsonResponse({ error: "RateLimitExceeded", message: "slow down" }, 429));
    const failedRes = await Effect.runPromise(
      executeAction(blueskySearchAction, { q: "burst" }, ctx).pipe(Effect.provide(errMock.layer)),
    );
    assert.equal(failedRes.status, "failed");
    assert.match(failedRes.text, /HTTP 429: RateLimitExceeded: slow down/);
    assert.deepEqual(failedRes.details?.cost, []);
  });

  it("bluesky_thread resolves handle URLs to DID and renders ancestors and nested replies", async () => {
    const { calls, layer } = makeLayers((url) => {
      if (url.pathname.endsWith("/com.atproto.identity.resolveHandle")) {
        assert.equal(url.searchParams.get("handle"), "alice.bsky.social");
        return jsonResponse({ did: "did:plc:alice1" });
      }
      assert.equal(url.pathname, "/xrpc/app.bsky.feed.getPostThread");
      assert.equal(url.searchParams.get("uri"), "at://did:plc:alice1/app.bsky.feed.post/post2");
      return jsonResponse({
        thread: {
          parent: {
            post: {
              uri: "at://did:plc:alice1/app.bsky.feed.post/post1",
              author: { handle: "alice.bsky.social" },
              record: { text: "Parent post", createdAt: "2026-11-20T10:00:00Z" },
            },
          },
          post: {
            uri: "at://did:plc:alice1/app.bsky.feed.post/post2",
            author: { handle: "alice.bsky.social" },
            record: { text: "Focal post", createdAt: "2026-11-20T10:05:00Z" },
          },
          replies: [
            {
              post: {
                uri: "at://did:plc:bob2/app.bsky.feed.post/post3",
                author: { handle: "bob.bsky.social" },
                record: { text: "Reply text", createdAt: "2026-11-20T10:10:00Z" },
              },
              replies: [],
            },
          ],
        },
      });
    });

    const { ctx } = makeCtx();
    const res = await Effect.runPromise(
      executeAction(
        blueskyThreadAction,
        { post: "https://bsky.app/profile/alice.bsky.social/post/post2" },
        ctx,
      ).pipe(Effect.provide(layer)),
    );
    assert.equal(calls.length, 2);
    assert.equal(res.status, "success");
    assert.match(res.text, /### Parent context[\s\S]*Parent post[\s\S]*### Focal post[\s\S]*Focal post[\s\S]*### Replies \(1\)[\s\S]*Reply text/);
  });

  it("bluesky_profile renders profile + author feed and degrades gracefully to partial if feed fails", async () => {
    const partialMock = makeLayers((url) => {
      if (url.pathname.endsWith("/app.bsky.actor.getProfile")) {
        return jsonResponse({
          did: "did:plc:bsky",
          handle: "bsky.app",
          displayName: "Bluesky",
          description: "Official account",
          followersCount: 1000,
          followsCount: 10,
          postsCount: 50,
          createdAt: "2023-04-01T00:00:00Z",
        });
      }
      return jsonResponse({ error: "InternalError", message: "feed down" }, 500);
    });

    const { ctx } = makeCtx();
    const res = await Effect.runPromise(
      executeAction(blueskyProfileAction, { actor: "@bsky.app" }, ctx).pipe(Effect.provide(partialMock.layer)),
    );
    assert.equal(res.status, "partial");
    assert.match(res.text, /# Bluesky \(@bsky\.app\)/);
    assert.match(res.text, /Recent posts unavailable: Bluesky app\.bsky\.feed\.getAuthorFeed returned HTTP 500/);
    assert.deepEqual(res.details?.cost, []);
  });
});
