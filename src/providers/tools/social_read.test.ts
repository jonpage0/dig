import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createSchemas } from "../schemas.js";
import { MODULES } from "../modules.js";
import { executeSource } from "../outcome.js";
import { providerTools } from "../index.js";
import { tiktok_read, instagram_read } from "./social_read.js";
import type { RetainedResponse, ToolContext, ToolSpec } from "../types.js";

const tik = "https://www.tiktok.com/@fixture/video/1234567890123456789";
const ig = "https://www.instagram.com/p/Fixture_123/";
const savedKey = process.env.SCRAPECREATORS_API_KEY;
const originalFetch = globalThis.fetch;
let calls: { url: URL; init: RequestInit }[];
let responses: RetainedResponse[];
let context: ToolContext;
function mock(body: unknown, status = 200) {
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}
async function run(spec: ToolSpec, args: any) { return executeSource(spec, args, context); }
const post = { success: true, credits_charged: 1, credits_remaining: 999999, aweme_detail: { aweme_id: "1234567890123456789", desc: "Caption", statistics: { play_count: null } } };

describe("direct social reads", () => {
  beforeEach(() => {
    process.env.SCRAPECREATORS_API_KEY = "social-read-test-key";
    calls = []; responses = [];
    context = { sessionID: "social-read-tests", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, keep: (label, status, body) => responses.push({ label, status, body }) };
  });
  afterEach(() => { globalThis.fetch = originalFetch; if (savedKey === undefined) delete process.env.SCRAPECREATORS_API_KEY; else process.env.SCRAPECREATORS_API_KEY = savedKey; });

  test("the two tools belong only to existing sources and reject unknown schema fields", () => {
    assert.equal(providerTools.tiktok_read, tiktok_read);
    assert.equal(providerTools.instagram_read, instagram_read);
    assert(MODULES.find(m => m.id === "tiktok")!.tools.includes("tiktok_read"));
    assert(MODULES.find(m => m.id === "instagram")!.tools.includes("instagram_read"));
    const schemas = createSchemas(Type);
    assert(Value.Check(schemas.tiktok_read, { kind: "post", url: tik }));
    assert(!Value.Check(schemas.tiktok_read, { kind: "post", url: tik, allow_long_transcription: true }));
    assert(!Value.Check(schemas.instagram_read, { kind: "transcript", url: ig, aiFallback: true }));
  });

  test("exact TikTok photo reads keep media and null metrics, record cost and disable downloads", async () => {
    mock({ ...post, aweme_detail: { ...post.aweme_detail, image_post_info: { images: [{ display_image: { url_list: ["https://images.example/photo.jpg"] } }] } } });
    const result = await run(tiktok_read, { kind: "post", url: tik.replace("/video/", "/photo/"), region: "us", cacheMaxAge: "1d" });
    assert.equal(result.status, "success");
    assert.deepEqual(result.details?.cost, [{ amount: 1, unit: "credits" }]);
    assert.match(result.text, /image_post_info/);
    assert.match(result.text, /"play_count": null/);
    assert.doesNotMatch(result.text, /credits_remaining|999999/);
    assert.equal(calls[0].url.pathname, "/v2/tiktok/video");
    assert.equal(calls[0].url.searchParams.get("download_media"), "false");
    assert.equal(calls[0].url.searchParams.get("get_transcript"), "false");
    assert.equal(calls[0].url.searchParams.get("region"), "US");
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(responses.length, 1);
  });

  test("all read operations choose their documented route and continuation parameter", async () => {
    const cases: [ToolSpec, any, string, unknown, string?][] = [
      [tiktok_read, { kind: "profile", handle: "@fixture" }, "/v1/tiktok/profile", { user: { id: "1" }, stats: { followerCount: null } }],
      [tiktok_read, { kind: "posts", handle: "fixture", cursor: 1748286476000, sort: "popular", includePinned: true }, "/v3/tiktok/profile/videos", { aweme_list: [{ aweme_id: "1" }], max_cursor: 1748286476001 }, "max_cursor"],
      [tiktok_read, { kind: "replies", url: tik, commentId: "10", cursor: 6 }, "/v1/tiktok/video/comment/replies", { comments: [{ cid: "11", text: "Reply" }], has_more: false }, "cursor"],
      [instagram_read, { kind: "profile", handle: "fixture" }, "/v1/instagram/profile", { data: { user: { id: "1" } } }],
      [instagram_read, { kind: "post", url: ig, includePlayCount: false }, "/v1/instagram/post", { data: { xdt_shortcode_media: { id: "1", shortcode: "Fixture_123", edge_sidecar_to_children: { edges: [{ node: { display_url: "https://image.example/a" } }] } } } }],
      [instagram_read, { kind: "posts", handle: "fixture", cursor: "opaque-feed" }, "/v2/instagram/user/posts", { items: [{ pk: "1", code: "Abc" }], next_max_id: "next", more_available: true }, "next_max_id"],
      [instagram_read, { kind: "reels", handle: "fixture", cursor: "opaque-reels" }, "/v1/instagram/user/reels", { items: [{ media: { id: "1", code: "Abc" } }], max_id: "next" }, "max_id"],
      [instagram_read, { kind: "replies", url: ig, commentId: "10", cursor: "opaque-replies" }, "/v1/instagram/post/comment/replies", { comments: [{ id: "11", text: "Reply" }], has_more: false }, "cursor"],
    ];
    for (const [tool, args, path, body, cursor] of cases) {
      calls = []; mock({ success: true, credits_charged: 1, ...(body as object) });
      const result = await run(tool, args);
      assert.notEqual(result.status, "failed", `${path}: ${result.text}`);
      assert.equal(calls.length, 1); assert.equal(calls[0].url.pathname, path);
      if (cursor) assert.equal(calls[0].url.searchParams.get(cursor), String(args.cursor));
      if (args.commentId) assert.equal(calls[0].url.searchParams.get("comment_id"), args.commentId);
    }
  });

  test("empty, unreadable, duplicate and paginated feeds keep distinct outcomes", async () => {
    mock({ success: true, credits_charged: 1, items: [], more_available: false });
    assert.equal((await run(instagram_read, { kind: "posts", handle: "fixture" })).status, "empty");
    mock({ success: true, credits_charged: 1 });
    assert.equal((await run(instagram_read, { kind: "posts", handle: "fixture" })).status, "failed");
    mock({ success: true, items: [{ no_id: true }] });
    assert.equal((await run(instagram_read, { kind: "posts", handle: "fixture" })).status, "failed");
    mock({ success: true, items: [{ id: "1" }, { no_id: true }, { id: "1" }], more_available: true, next_max_id: "next" });
    const mixed = await run(instagram_read, { kind: "posts", handle: "fixture" });
    assert.equal(mixed.status, "partial"); assert.match(mixed.text, /1 duplicate/); assert.match(mixed.text, /1 unrecognized/);
    mock({ success: true, items: [{ id: "1" }], cursor: "old", has_more: false });
    assert.equal((await run(instagram_read, { kind: "replies", url: ig, commentId: "1" })).status, "failed", "reply contract requires comments, not items");
    mock({ success: true, comments: [{ id: "1" }], cursor: "old", has_more: false });
    assert.equal((await run(instagram_read, { kind: "replies", url: ig, commentId: "1" })).status, "success", "explicit last-page flag overrides an unused cursor");
  });

  test("standalone transcripts retain timestamps and never opt in to long paid transcription", async () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nCaption words";
    mock({ success: true, credits_charged: 1, transcript: vtt, id: "1234567890123456789" });
    const result = await run(tiktok_read, { kind: "transcript", url: tik, language: "EN", aiFallback: true });
    assert.equal(result.status, "success"); assert.match(result.text, /00:00:01/);
    assert.deepEqual(result.details?.cost, [{ amount: 1, unit: "credits" }]);
    assert.equal(calls[0].url.searchParams.get("allow_long_transcription"), "false");
    assert.equal(calls[0].url.searchParams.get("use_ai_as_fallback"), "true");
    assert.equal(calls[0].url.searchParams.get("language"), "en");
    mock({ success: true, credits_charged: 0, transcript: null });
    const empty = await run(tiktok_read, { kind: "transcript", url: tik });
    assert.equal(empty.status, "empty"); assert.deepEqual(empty.details?.cost, []);
    mock({ success: true, transcript: [{ text: "not the documented shape" }] });
    assert.equal((await run(tiktok_read, { kind: "transcript", url: tik })).status, "failed");
    mock({ success: true, credits_charged: 1, transcripts: [{ id: "first", text: "Speech" }, null, { id: "silent", text: null }] });
    const carousel = await run(instagram_read, { kind: "transcript", url: ig });
    assert.equal(carousel.status, "partial"); assert.match(carousel.text, /"id": "first"/);
    assert.equal(calls.at(-1)!.url.searchParams.get("allow_long_transcription"), "false");
    mock({ success: true, transcripts: [{ id: "1" }] });
    assert.equal((await run(instagram_read, { kind: "transcript", url: ig })).status, "failed");
  });

  test("confirmed restricted profiles are partial public lookups, never generic authorization success", async () => {
    for (const status of [200, 403, 404]) {
      mock({ success: true, credits_charged: 0, message: "Profile is age restricted", age_restricted: true }, status);
      const result = await run(instagram_read, { kind: "profile", handle: "fixture" });
      assert.equal(result.status, "partial"); assert.match(result.text, /resource state/);
    }
    mock({ success: true, credits_charged: 1, data: { user: { id: "1", is_private: true } } });
    assert.equal((await run(instagram_read, { kind: "profile", handle: "fixture" })).status, "partial");
    mock({ success: false, message: "Profile is private" }, 403);
    assert.equal((await run(instagram_read, { kind: "profile", handle: "fixture" })).status, "failed");
    mock({ success: true, message: "Invalid API key" }, 403);
    assert.equal((await run(instagram_read, { kind: "profile", handle: "fixture" })).status, "failed");
    mock({ success: true, message: "Profile is private", credits_charged: 0 }, 404);
    assert.equal((await run(instagram_read, { kind: "posts", handle: "fixture" })).status, "partial");
  });

  test("invalid targets and incompatible arguments fail before any paid request", async () => {
    mock(post);
    for (const args of [
      { kind: "post", url: "http://www.tiktok.com/@fixture/video/1" },
      { kind: "post", url: "https://www.tiktok.com.evil.example/@fixture/video/1" },
      { kind: "post", url: "https://user:password@www.tiktok.com/@fixture/video/1" },
      { kind: "post", url: tik, aiFallback: true },
      { kind: "profile", handle: "https://www.tiktok.com/@fixture" },
      { kind: "posts", handle: "fixture", cacheMaxAge: "1d" },
      { kind: "replies", url: tik, commentId: "1", cursor: "6" },
      { kind: "transcript", url: tik, allow_long_transcription: true },
    ]) assert.equal((await run(tiktok_read, args)).status, "failed");
    assert.equal((await run(instagram_read, { kind: "replies", url: ig, commentId: "1", cursor: 1 })).status, "failed");
    assert.equal((await run(instagram_read, { kind: "post", url: "https://www.instagram.com/fixture/" })).status, "failed");
    assert.equal(calls.length, 0);
  });

  test("wrong post identity, missing key, redirect and rate-limit responses never cause retries", async () => {
    mock({ ...post, aweme_detail: { aweme_id: "wrong" } });
    assert.equal((await run(tiktok_read, { kind: "post", url: tik })).status, "failed");
    delete process.env.SCRAPECREATORS_API_KEY;
    calls = []; assert.equal((await run(tiktok_read, { kind: "post", url: tik })).status, "failed"); assert.equal(calls.length, 0);
    process.env.SCRAPECREATORS_API_KEY = "social-read-test-key";
    for (const status of [302, 429]) {
      calls = []; mock({ success: false, message: "Unavailable", credits_charged: 0 }, status);
      assert.equal((await run(tiktok_read, { kind: "post", url: tik })).status, "failed"); assert.equal(calls.length, 1); assert.equal(calls[0].init.redirect, "manual");
    }
  });

  test("unknown prices stay unknown and complete raw responses survive output bounds", async () => {
    mock({ success: true, aweme_detail: { ...post.aweme_detail, desc: "x".repeat(70000) } });
    const result = await run(tiktok_read, { kind: "post", url: tik });
    assert.equal(result.status, "partial"); assert.equal(result.details?.cost, null); assert.equal(result.details?.truncated, true);
    assert.match(result.text, /Output shortened/); assert.equal((responses[0].body as any).aweme_detail.desc.length, 70000);
  });

  test("configuration noise cannot crowd the caption out of a direct post read", async () => {
    mock({ ...post, aweme_detail: { a_provider_configuration: "noise".repeat(20000), ...post.aweme_detail } });
    const result = await run(tiktok_read, { kind: "post", url: tik });
    assert.equal(result.status, "success"); assert(result.text.length < 3000);
    assert.match(result.text, /Caption/); assert.doesNotMatch(result.text, /a_provider_configuration/);
    assert.equal((responses[0].body as any).aweme_detail.a_provider_configuration.length, 100000);
  });

  test("provider echoes are redacted and cancellation retains the returned charge", async () => {
    mock({ ...post, aweme_detail: { ...post.aweme_detail, desc: "social-read-test-key" } });
    const redacted = await run(tiktok_read, { kind: "post", url: tik });
    assert(!JSON.stringify([redacted, responses]).includes("social-read-test-key"));
    const controller = new AbortController(); context.abort = controller.signal;
    context.keep = (label, status, body) => { responses.push({ label, status, body }); controller.abort(); };
    mock(post); const stopped = await run(tiktok_read, { kind: "post", url: tik });
    assert.equal(stopped.status, "cancelled"); assert.equal(stopped.details?.cost, null); assert.deepEqual(stopped.details?.knownCost, [{ amount: 1, unit: "credits" }]);
  });
});
