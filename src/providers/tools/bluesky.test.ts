import { afterEach, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { Type } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { executeSource } from "../outcome.js"
import { createSchemas } from "../schemas.js"
import type { ToolContext } from "../types.js"
import { atUriToWebUrl, parsePostTarget, profile, search, thread } from "./bluesky.js"

const kept: { label: string; status: number | string; body: unknown }[] = []
const ctx: ToolContext = {
  sessionID: "bluesky-test",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  keep(label, status, body) {
    kept.push({ label, status, body })
  },
}

const SAMPLE_POST = {
  uri: "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l5abc123",
  cid: "bafyreitest",
  author: {
    did: "did:plc:z72i7hdynmk6r22z27h6tvur",
    handle: "bsky.app",
    displayName: "Bluesky",
  },
  record: {
    $type: "app.bsky.feed.post",
    text: "Public ATProto search is live.",
    createdAt: "2026-10-01T15:00:00.000Z",
  },
  embed: {
    $type: "app.bsky.embed.external#view",
    external: {
      uri: "https://docs.bsky.app",
      title: "ATProto Docs",
      description: "Developer documentation for Bluesky.",
    },
  },
  likeCount: 120,
  repostCount: 34,
  replyCount: 12,
  quoteCount: 5,
}

describe("bluesky tools", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    kept.length = 0
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("bluesky_search queries public.api.bsky.app and formats metrics, embeds, AT URI and clickable URL", async () => {
    const seen: URL[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new URL(String(input)))
      assert.match(new Headers(init?.headers).get("user-agent") ?? "", /^dig\//)
      return Response.json({
        posts: [SAMPLE_POST],
        hitsTotal: 42,
        cursor: "25",
      })
    }) as typeof fetch

    const out = await executeSource(
      search,
      { q: "atproto", sort: "top", author: "@bsky.app", lang: "en", limit: 10 },
      ctx,
    )

    assert.equal(out.status, "success", out.text)
    assert.deepEqual(out.details?.cost, [], "Bluesky public API is free")
    assert.equal(seen.length, 1)
    assert.equal(seen[0].origin + seen[0].pathname, "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts")
    assert.equal(seen[0].searchParams.get("q"), "atproto")
    assert.equal(seen[0].searchParams.get("sort"), "top")
    assert.equal(seen[0].searchParams.get("author"), "bsky.app")
    assert.equal(seen[0].searchParams.get("lang"), "en")
    assert.equal(seen[0].searchParams.get("limit"), "10")
    assert.match(out.text, /Bluesky \(@bsky\.app\)/)
    assert.match(out.text, /Public ATProto search is live\./)
    assert.match(out.text, /Link: ATProto Docs <https:\/\/docs\.bsky\.app>/)
    assert.match(out.text, /120 likes \| 34 reposts \| 12 replies \| 5 quotes/)
    assert.match(out.text, /URL: https:\/\/bsky\.app\/profile\/bsky\.app\/post\/3l5abc123/)
    assert.match(out.text, /AT URI: at:\/\/did:plc:z72i7hdynmk6r22z27h6tvur\/app\.bsky\.feed\.post\/3l5abc123/)
    assert.match(out.text, /cursor "25"/)
    assert.equal(out.details?.cursor, "25")
  })

  test("bluesky_thread resolves handle URLs via resolveHandle and renders ancestors, focal post, and replies", async () => {
    const calls: URL[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      calls.push(url)
      if (url.pathname.endsWith("/com.atproto.identity.resolveHandle")) {
        assert.equal(url.searchParams.get("handle"), "bsky.app")
        return Response.json({ did: "did:plc:z72i7hdynmk6r22z27h6tvur" })
      }
      if (url.pathname.endsWith("/app.bsky.feed.getPostThread")) {
        assert.equal(url.searchParams.get("uri"), "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l5abc123")
        assert.equal(url.searchParams.get("depth"), "4")
        assert.equal(url.searchParams.get("parentHeight"), "2")
        return Response.json({
          thread: {
            $type: "app.bsky.feed.defs#threadViewPost",
            parent: {
              $type: "app.bsky.feed.defs#threadViewPost",
              post: {
                uri: "at://did:plc:parent/app.bsky.feed.post/root1",
                author: { did: "did:plc:parent", handle: "alice.bsky.social" },
                record: { text: "Question about ATProto", createdAt: "2026-10-01T14:55:00.000Z" },
                likeCount: 7,
              },
            },
            post: SAMPLE_POST,
            replies: [
              {
                $type: "app.bsky.feed.defs#threadViewPost",
                post: {
                  uri: "at://did:plc:reply/app.bsky.feed.post/rep1",
                  author: { did: "did:plc:reply", handle: "bob.bsky.social" },
                  record: { text: "Great news!", createdAt: "2026-10-01T15:05:00.000Z" },
                  embed: { $type: "app.bsky.embed.images#view", images: [{ alt: "Architecture diagram" }] },
                  likeCount: 3,
                },
                replies: [],
              },
              { $type: "app.bsky.feed.defs#blockedPost", uri: "at://did:plc:x/app.bsky.feed.post/blk1" },
            ],
          },
        })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const out = await executeSource(
      thread,
      { post: "https://bsky.app/profile/bsky.app/post/3l5abc123", depth: 4, parentHeight: 2 },
      ctx,
    )

    assert.equal(out.status, "success", out.text)
    assert.equal(calls.length, 2)
    assert.match(out.text, /### Parent context/)
    assert.match(out.text, /\[Parent\] \*\*@alice\.bsky\.social\*\*/)
    assert.match(out.text, /\[Focal post\] \*\*Bluesky \(@bsky\.app\)\*\*/)
    assert.match(out.text, /@bob\.bsky\.social/)
    assert.match(out.text, /Images: 1 \(alt: #1: "Architecture diagram"\)/)
    assert.match(out.text, /\[Reply blocked\]/)
  })

  test("bluesky_thread skips resolveHandle for direct DID AT URIs and handles notFoundPost", async () => {
    const calls: URL[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(new URL(String(input)))
      return Response.json({ thread: { $type: "app.bsky.feed.defs#notFoundPost", uri: "at://did:plc:abc/app.bsky.feed.post/missing" } })
    }) as typeof fetch

    const out = await executeSource(
      thread,
      { post: "at://did:plc:abc/app.bsky.feed.post/missing" },
      ctx,
    )
    assert.equal(out.status, "empty")
    assert.equal(calls.length, 1, "DID URI must not call resolveHandle")
    assert.match(out.text, /not found/)
  })

  test("bluesky_profile fetches profile and recent posts, and degrades to partial if feed fails", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith("/app.bsky.actor.getProfile")) {
        return Response.json({
          did: "did:plc:z72i7hdynmk6r22z27h6tvur",
          handle: "bsky.app",
          displayName: "Bluesky",
          description: "Official Bluesky account",
          followersCount: 25000000,
          followsCount: 10,
          postsCount: 500,
          createdAt: "2023-04-12T00:00:00.000Z",
        })
      }
      if (url.pathname.endsWith("/app.bsky.feed.getAuthorFeed")) {
        assert.equal(url.searchParams.get("filter"), "posts_no_replies")
        return Response.json({
          feed: [
            {
              post: SAMPLE_POST,
              reason: { $type: "app.bsky.feed.defs#reasonRepost", by: { handle: "bsky.app" } },
            },
          ],
          cursor: "next-cursor",
        })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const out = await executeSource(
      profile,
      { actor: "@bsky.app", includePosts: true, limit: 10, filter: "posts_no_replies" },
      ctx,
    )
    assert.equal(out.status, "success", out.text)
    assert.match(out.text, /# Bluesky \(@bsky\.app\)/)
    assert.match(out.text, /Followers: 25,000,000/)
    assert.match(out.text, /\[Repost by @bsky\.app\]/)
    assert.match(out.text, /cursor "next-cursor"/)

    // Feed failure -> partial with profile preserved
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith("/app.bsky.actor.getProfile")) {
        return Response.json({ did: "did:plc:abc", handle: "alice.bsky.social" })
      }
      return new Response(JSON.stringify({ error: "UpstreamError", message: "Feed temporarily unavailable" }), { status: 503 })
    }) as typeof fetch

    const partial = await executeSource(profile, { actor: "alice.bsky.social" }, ctx)
    assert.equal(partial.status, "partial", partial.text)
    assert.match(partial.text, /@alice\.bsky\.social/)
    assert.match(partial.text, /Recent posts unavailable/)
  })

  test("helpers and schemas validate inputs and bounds", () => {
    assert.equal(
      atUriToWebUrl("at://did:plc:abc/app.bsky.feed.post/xyz", "alice.bsky.social"),
      "https://bsky.app/profile/alice.bsky.social/post/xyz",
    )
    assert.deepEqual(parsePostTarget("https://bsky.app/profile/did:plc:abc/post/xyz"), {
      actor: "did:plc:abc",
      rkey: "xyz",
      isDid: true,
    })
    assert.ok("error" in parsePostTarget("https://example.com/not-bsky"))

    const schemas = createSchemas(Type)
    assert.ok(Value.Check(schemas.bluesky_search, { q: "news", sort: "top", limit: 50 }))
    assert.ok(!Value.Check(schemas.bluesky_search, { q: "news", limit: 51 }))
    assert.ok(Value.Check(schemas.bluesky_thread, { post: "https://bsky.app/profile/bsky.app/post/abc", depth: 20, parentHeight: 20 }))
    assert.ok(!Value.Check(schemas.bluesky_thread, { post: "https://bsky.app/profile/bsky.app/post/abc", depth: 21 }))
    assert.ok(Value.Check(schemas.bluesky_profile, { actor: "bsky.app", includePosts: false, filter: "posts_with_media", limit: 50 }))
    assert.ok(!Value.Check(schemas.bluesky_profile, { actor: "bsky.app", filter: "invalid_filter" }))
  })

  test("formats recordWithMedia quoted embeds and registers bluesky under social as keyless", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        posts: [
          {
            uri: "at://did:plc:u1/app.bsky.feed.post/p99",
            author: { did: "did:plc:u1", handle: "dev.bsky.social" },
            record: { text: "Check this quote", createdAt: "2026-10-02T10:00:00.000Z" },
            embed: {
              $type: "app.bsky.embed.recordWithMedia#view",
              media: { $type: "app.bsky.embed.images#view", images: [{ alt: "Benchmark chart" }] },
              record: {
                record: {
                  $type: "app.bsky.embed.record#viewRecord",
                  uri: "at://did:plc:u2/app.bsky.feed.post/q1",
                  author: { did: "did:plc:u2", handle: "orig.bsky.social" },
                  value: { text: "Original claim here." },
                },
              },
            },
          },
        ],
      })) as typeof fetch

    const out = await executeSource(search, { q: "quote" }, ctx)
    assert.equal(out.status, "success", out.text)
    assert.match(out.text, /Images: 1 \(alt: #1: "Benchmark chart"\)/)
    assert.match(out.text, /\[Quote @orig\.bsky\.social \(https:\/\/bsky\.app\/profile\/orig\.bsky\.social\/post\/q1\): Original claim here\.\]/)

    const { MODULES, SOURCE_GROUPS } = await import("../modules.js")
    const mod = MODULES.find((m) => m.id === "bluesky")
    assert.ok(mod)
    assert.deepEqual(mod.tools, ["bluesky_search", "bluesky_thread", "bluesky_profile"])
    assert.equal("keys" in mod, false)
    assert.equal("logo" in mod, false)
    assert.ok((SOURCE_GROUPS.find((g) => g.id === "social")?.sources as readonly string[]).includes("bluesky"))
  })
})
