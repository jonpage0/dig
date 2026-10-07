import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import { executeSource } from "../outcome.js";
import type { SourceToolResult, ToolContext } from "../types.js";
import { instagram, linkedin, telegram, tiktok } from "./scrapecreators.js";

type FetchCall = { url: URL };
type Envelope = { status: number; body: unknown };

function isEnvelope(value: unknown): value is Envelope {
	return typeof value === "object" && value !== null && "status" in value && "body" in value && typeof (value as Envelope).status === "number";
}

const context: ToolContext = {
	sessionID: "scrapecreators-test",
	directory: "/tmp",
	worktree: "/tmp",
	abort: new AbortController().signal,
	keep: () => {},
};

function text(result: SourceToolResult): string {
	return typeof result === "string" ? result : result.text;
}

function details(result: SourceToolResult): Record<string, unknown> {
	return typeof result === "string" ? {} : (result.details ?? {});
}

type Route = unknown | ((url: URL) => unknown);

/** Route values (or what a route function returns) are the JSON body for a 200, or `{ status, body }` for another status. */
function installFetchMock(routes: Record<string, Route>) {
	const calls: FetchCall[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = input instanceof URL ? input : new URL(String(input));
		const call = { url };
		calls.push(call);
		const route = routes[url.pathname];
		if (route === undefined) return new Response(JSON.stringify({ success: false, error: "no route" }), { status: 404 });
		const resolved = typeof route === "function" ? (route as (url: URL) => unknown)(url) : route;
		const { status, body } = isEnvelope(resolved) ? resolved : { status: 200, body: resolved };
		return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

// Shapes follow the official ScrapeCreators docs examples read 2026-09-15.
const reelFixture = {
	id: "3723045213787686915",
	shortcode: "DOq6eV6iIgD",
	url: "https://www.instagram.com/reel/DOq6eV6iIgD/",
	caption: "Dogs are family #rescuedog",
	video_duration: 75.7,
	owner: { username: "fetchmycamera_", is_verified: true, follower_count: 188406 },
	taken_at: "2025-09-16T16:56:45.000Z",
	like_count: 3487,
	comment_count: 90,
	comments: [{ text: "Lovely pics", owner: { username: "anakaren" } }],
};

const tiktokFixture = (id: string, playCount?: number) => ({
	aweme_info: {
		aweme_id: id,
		desc: `video ${id} #tag`,
		create_time: 1757980800,
		share_url: `https://www.tiktok.com/@creator/video/${id}?lang=en`,
		author: { unique_id: "creator" },
		statistics: { ...(playCount === undefined ? {} : { play_count: playCount }), digg_count: 10, comment_count: 2, share_count: 1 },
		text_extra: [{ hashtag_name: "tag" }],
		video: { duration: 28459 },
	},
});

describe("scrapecreators tools", () => {
	const originalKey = process.env.SCRAPECREATORS_API_KEY;
	let restore: (() => void) | undefined;

	beforeEach(() => {
		process.env.SCRAPECREATORS_API_KEY = "sc-test-key";
	});

	afterEach(() => {
		restore?.();
		restore = undefined;
		if (originalKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
		else process.env.SCRAPECREATORS_API_KEY = originalKey;
	});

	test("instagram reels reports absent views as unavailable and never zero", async () => {
		const mock = installFetchMock({
			"/v2/instagram/reels/search": { success: true, credits_charged: 1, reels: [reelFixture] },
		});
		restore = mock.restore;

		const result = await instagram.execute({ query: "dogs", transcripts: false, date_posted: "last-week", page: 2 }, context);
		const output = text(result);

		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0].url.searchParams.get("date_posted")).toBe("last-week");
		expect(mock.calls[0].url.searchParams.get("page")).toBe("2");
		expect(output).toContain("Views: unavailable | Likes: 3.5K | Comments: 90");
		expect(output).not.toContain("Views: 0");
		expect(output).toContain("set enrich_views=true");
		expect(output).toContain("Next page: pass page=3");
		expect(details(result)).toMatchObject({ mode: "reels", shown: 1, credits: { charged: 1, unreported: 0 } });
	});

	test("instagram reels looks up play counts only when enrich_views is set and forwards cache_max_age", async () => {
		const mock = installFetchMock({
			"/v2/instagram/reels/search": { success: true, credits_charged: 1, reels: [reelFixture] },
			"/v1/instagram/post": {
				success: true,
				credits_charged: 0,
				cached: true,
				cached_at: "2026-09-14T10:00:00.000Z",
				data: { xdt_shortcode_media: { video_play_count: 4651, video_view_count: 1639 } },
			},
		});
		restore = mock.restore;

		const result = await instagram.execute({ query: "dogs", transcripts: false, enrich_views: true, cache_max_age: "7d" }, context);
		const output = text(result);
		const lookup = mock.calls.find((call) => call.url.pathname === "/v1/instagram/post");

		expect(lookup?.url.searchParams.get("url")).toBe(reelFixture.url);
		expect(lookup?.url.searchParams.get("include_play_count")).toBe("true");
		expect(lookup?.url.searchParams.get("cache_max_age")).toBe("7d");
		expect(output).toContain("Views: 4.7K (post lookup)");
		expect(output).toContain("View lookups: 1 with play counts of 1 requested");
		expect(details(result)).toMatchObject({ credits: { charged: 1, unreported: 0 }, views: { requested: 1, fetched: 1, failed: 0 } });
	});

	test("a 200 without the documented array is reported as unreadable, not as no results, and unreported credits stay unknown", async () => {
		const mock = installFetchMock({
			"/v2/instagram/reels/search": { success: true },
			"/v1/tiktok/search/keyword": { success: true, search_item_list: [tiktokFixture("1", 5)] },
		});
		restore = mock.restore;

		expect(await instagram.execute({ query: "dogs" }, context)).toBe("ERROR: ScrapeCreators Instagram Reels search returned an unexpected payload: `reels` is missing");
		const tiktokResult = await tiktok.execute({ query: "x", transcripts: false }, context);
		expect(text(tiktokResult)).toContain("Credits charged: 0 reported, plus 1 request that did not report a charge (total unknown)");
		expect(details(tiktokResult)).toMatchObject({ credits: { charged: 0, unreported: 1 } });
	});

	test("cancellation during transcript enrichment stops the loop and is reported as cancelled, not as provider failures", async () => {
		const controller = new AbortController();
		const mock = installFetchMock({
			"/v1/tiktok/search/keyword": { success: true, credits_charged: 1, search_item_list: [tiktokFixture("1", 5), tiktokFixture("2", 6), tiktokFixture("3", 7)] },
			"/v1/tiktok/video/transcript": () => {
				controller.abort();
				return { success: true, credits_charged: 1, transcript: "WEBVTT\n\nhello" };
			},
		});
		restore = mock.restore;

		const result = await tiktok.execute({ query: "x", transcript_limit: 3 }, { ...context, abort: controller.signal });
		expect(text(result)).toMatch(/^ERROR: Cancelled: /);
		expect(mock.calls.filter((call) => call.url.pathname === "/v1/tiktok/video/transcript").length).toBeLessThanOrEqual(1);
	});

	test("instagram rejects out-of-range pages and mode-specific arguments before any request", async () => {
		const mock = installFetchMock({});
		restore = mock.restore;

		expect(await instagram.execute({ query: "dogs", page: 12 }, context)).toContain("page must be an integer from 1 to 11");
		expect(await instagram.execute({ query: "dogs", mode: "native", date_posted: "last-week" }, context)).toBe("ERROR: date_posted applies to mode='reels' only.");
		expect(await instagram.execute({ query: "dogs", mode: "popular", enrich_views: true }, context)).toContain("popular posts already include play_count");
		expect(mock.calls).toHaveLength(0);
	});

	test("instagram native and popular modes use their own endpoints and pagination", async () => {
		const mock = installFetchMock({
			"/v1/instagram/search": {
				success: true,
				credits_charged: 1,
				// Live root shape observed 2026-09-15 (the docs example nests these under `data`).
				query: "nike",
				users: [{ position: 0, id: "13460080", username: "nike", full_name: "Nike", is_verified: true }],
				hashtags: [{ position: 2, name: "nikewomen", media_count: 2033463, search_result_subtitle: null }],
				places: [{ position: 49, id: "715603272", name: "Nike", title: "Nike", subtitle: "" }],
				keywords: [],
				rank_token: "a6e9cded",
			},
			"/v1/instagram/search/popular": {
				success: true,
				credits_charged: 1,
				query: "basketball",
				title: "Basketball",
				total_media_count: 8800000,
				description: { plain_text: "James Naismith invented basketball.", source_uris: ["https://en.wikipedia.org/wiki/Outline_of_basketball"] },
				suggested_terms: ["the tallest basketball player"],
				posts: [{ id: "POLARIS_1", shortcode: "DYGkBO3NfMA", url: "https://www.instagram.com/reel/DYGkBO3NfMA/", type: "reel", caption: "#hooper", play_count: 11993988, owner: { username: "lukaceo" } }],
				cursor: "opaque-cursor",
				has_more: true,
			},
		});
		restore = mock.restore;

		const native = await instagram.execute({ query: "nike", mode: "native" }, context);
		expect(text(native)).toContain("@nike — Nike (verified)");
		expect(text(native)).toContain("#nikewomen — 2.0M posts");
		expect(text(native)).toContain("Returned: 1 users | 1 hashtags | 1 places | 0 keywords");
		expect(text(native)).toContain("not posts");

		const popular = await instagram.execute({ query: "basketball", mode: "popular", transcripts: false }, context);
		expect(text(popular)).toContain("Plays: 12.0M");
		expect(text(popular)).toContain('Next page: pass cursor="opaque-cursor"');
		expect(details(popular)).toMatchObject({ mode: "popular", cursor: "opaque-cursor", has_more: true });
		expect(mock.calls.map((call) => call.url.pathname)).toEqual(["/v1/instagram/search", "/v1/instagram/search/popular"]);
	});

	test("tiktok forwards provider filters, keeps provider order, dedupes, and leaves missing views unreported", async () => {
		const mock = installFetchMock({
			"/v1/tiktok/search/keyword": { success: true, credits_charged: 1, cursor: 12, search_item_list: [tiktokFixture("1", 50), tiktokFixture("2"), tiktokFixture("1", 50)] },
			"/v1/tiktok/video/transcript": { success: true, credits_charged: 1, transcript: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello there\n" },
		});
		restore = mock.restore;

		const result = await executeSource(
			tiktok,
			{ query: "ai tools", date_posted: "this-month", sort_by: "date-posted", region: "us", cursor: 10, transcript_limit: 1, transcript_language: "en" },
			context,
		);
		const output = text(result);
		const search = mock.calls[0].url.searchParams;

		expect(search.get("date_posted")).toBe("this-month");
		expect(search.get("sort_by")).toBe("date-posted");
		expect(search.get("region")).toBe("US");
		expect(search.get("cursor")).toBe("10");
		expect(output).toContain("1 duplicate dropped");
		expect(output).toContain("Next page: pass cursor=12");
		expect(output.indexOf("video 1")).toBeLessThan(output.indexOf("video 2"));
		expect(output).toContain("Views: n/a | Likes: 10");
		expect(output).toContain("Duration: 28.5s");
		expect(output).toContain("Totals over videos reporting metrics: 50 views (1/2)");
		expect(output).toContain("Transcript: hello there");
		const transcript = mock.calls.find((call) => call.url.pathname === "/v1/tiktok/video/transcript");
		expect(transcript?.url.searchParams.get("language")).toBe("en");
		expect(transcript?.url.searchParams.get("use_ai_as_fallback")).toBeNull();
		expect(details(result)).toMatchObject({ credits: { charged: 2, unreported: 0 }, cursor: 12, duplicates_dropped: 1 });
		expect(details(result).cost).toEqual([{ amount: 2, unit: "credits" }]);
		expect(details(result).knownCost).toBeUndefined();
	});

	test("tiktok reports a page of unreadable entries as unreadable, counts partial unreadable entries, and never prints a missing like total as 0", async () => {
		const mock = installFetchMock({
			"/v1/tiktok/search/keyword": (url: URL) =>
				url.searchParams.get("query") === "drift"
					? { success: true, credits_charged: 1, search_item_list: [{ unexpected: "schema-drift" }] }
					: { success: true, credits_charged: 1, search_item_list: [{ aweme_info: { aweme_id: "1", statistics: { play_count: 99 } } }, { unexpected: "schema-drift" }] },
		});
		restore = mock.restore;

		expect(text(await tiktok.execute({ query: "drift", transcripts: false }, context))).toBe(
			"ERROR: ScrapeCreators TikTok search returned an unexpected payload: none of the 1 search_item_list entry carried a readable video record (missing aweme_id)",
		);

		const mixed = await tiktok.execute({ query: "mixed", transcripts: false }, context);
		const output = text(mixed);
		expect(output).toContain("Totals over videos reporting metrics: 99 views (1/1) | no likes reported");
		expect(output).not.toContain("0 likes");
		expect(output).toContain("Unreadable entries: 1 returned entry lacked a readable video record and was skipped.");
		expect(details(mixed)).toMatchObject({ returned: 1, unreadable: 1 });
	});

	test("a failed enrichment request without a charge leaves the credit total unknown and keeps the reported subtotal", async () => {
		const mock = installFetchMock({
			"/v1/tiktok/search/keyword": { success: true, credits_charged: 1, search_item_list: [tiktokFixture("1", 5)] },
			"/v1/tiktok/video/transcript": { success: false, error: "Upstream failed" },
		});
		restore = mock.restore;

		const result = await executeSource(tiktok, { query: "x", transcript_limit: 1 }, context);
		expect(text(result)).toContain("Credits charged: 1 reported, plus 1 request that did not report a charge (total unknown)");
		expect(text(result)).toContain("Transcripts: 0 fetched of 1 requested; 1 failed");
		expect(details(result)).toMatchObject({ credits: { charged: 1, unreported: 1 }, transcripts: { requested: 1, fetched: 0, failed: 1 } });
		expect(details(result).cost).toBeNull();
		expect(details(result).knownCost).toEqual([{ amount: 1, unit: "credits" }]);
	});

	test("cancellation after a charged search keeps the reported credits as a subtotal", async () => {
		const controller = new AbortController();
		const mock = installFetchMock({
			"/v1/tiktok/search/keyword": { success: true, credits_charged: 1, search_item_list: [tiktokFixture("1", 5)] },
			"/v1/tiktok/video/transcript": () => {
				controller.abort();
				throw new DOMException("The operation was aborted.", "AbortError");
			},
		});
		restore = mock.restore;

		const result = await executeSource(tiktok, { query: "x", transcript_limit: 1 }, { ...context, abort: controller.signal });
		expect(result.status).toBe("cancelled");
		expect(details(result).cost).toBeNull();
		expect(details(result).knownCost).toEqual([{ amount: 1, unit: "credits" }]);
	});

	test("instagram transcript responses distinguish a missing transcripts field from the documented no-speech null", async () => {
		const second = { ...reelFixture, id: "2", shortcode: "second", url: "https://www.instagram.com/reel/second/" };
		const mock = installFetchMock({
			"/v2/instagram/reels/search": { success: true, credits_charged: 1, reels: [reelFixture, second] },
			"/v2/instagram/media/transcript": (url: URL) =>
				url.searchParams.get("url") === reelFixture.url ? { success: true, credits_charged: 1 } : { success: true, credits_charged: 1, transcripts: null },
		});
		restore = mock.restore;

		const result = await instagram.execute({ query: "dogs", transcript_limit: 2 }, context);
		const output = text(result);
		expect(output).toContain("Transcript: transcript failed: ScrapeCreators Instagram transcript returned an unexpected payload: `transcripts` is missing");
		expect(output).toContain("Transcript: provider reported no speech (transcripts: null)");
		expect(output).not.toContain("over 2 minutes");
		expect(output).toContain("Transcripts: 0 fetched of 2 requested; 1 failed");
		expect(details(result)).toMatchObject({ transcripts: { requested: 2, fetched: 0, failed: 1 }, credits: { charged: 3, unreported: 0 } });
	});

	test("linkedin search sends query, date_posted, and cursor to the posts search endpoint", async () => {
		const mock = installFetchMock({
			"/v1/linkedin/search/posts": {
				success: true,
				credits_charged: 1,
				posts: [{ url: "https://www.linkedin.com/posts/example", datePublished: "2025-07-25T19:56:02.566Z", description: "AI agents guide", author: { name: "Aakash Gupta", url: "https://www.linkedin.com/in/aagupta", followers: 313422 }, likeCount: 217, commentCount: 25, comments: [] }],
				cursor: "3",
			},
		});
		restore = mock.restore;

		const result = await linkedin.execute({ kind: "search", query: "ai agents", date_posted: "last-week", cursor: "2" }, context);
		const params = mock.calls[0].url.searchParams;

		expect(params.get("query")).toBe("ai agents");
		expect(params.get("date_posted")).toBe("last-week");
		expect(params.get("cursor")).toBe("2");
		expect(text(result)).toContain("Aakash Gupta (313.4K followers)");
		expect(text(result)).toContain('Next page: pass cursor="3"');
		expect(details(result)).toMatchObject({ kind: "search", cursor: "3", posts: 1 });
	});

	test("linkedin url kinds still require a linkedin.com url and reject search-only arguments", async () => {
		const mock = installFetchMock({});
		restore = mock.restore;

		expect(await linkedin.execute({ kind: "profile" }, context)).toBe("ERROR: url is required for kind='profile'.");
		expect(await linkedin.execute({ kind: "profile", url: "https://example.com/in/x" }, context)).toBe("ERROR: url must be a linkedin.com URL.");
		expect(await linkedin.execute({ kind: "post", url: "https://www.linkedin.com/posts/x", cursor: "2" }, context)).toContain("apply to kind='search' only");
		expect(await linkedin.execute({ kind: "search", query: "x", cursor: "12" }, context)).toContain("rejects cursor 12");
		expect(mock.calls).toHaveLength(0);
	});

	test("telegram routes channel, posts, and post lookups, orders posts newest-first, and reports cache hits", async () => {
		const channel = { handle: "durov", name: "Pavel Durov", url: "https://t.me/durov", is_verified: true, subscriber_count: 11100000, subscriber_count_text: "11.1M", member_count: null, photo_count: 14 };
		const post = { id: "543", channel_handle: "durov", url: "https://t.me/durov/543", author_name: "Pavel Durov", text: "Telegram has applied for the .gram domain zone.", published_at: "2026-08-18T17:37:31+00:00", view_count: 1210000, reactions: [{ emoji: "⭐", count: 16300 }], reaction_count: 89300, forwarded_from: null, media: [], link_preview: null };
		const older = { ...post, id: "540", url: "https://t.me/durov/540", text: "Older post.", published_at: "2026-08-10T10:00:00+00:00" };
		const undated = { ...post, id: "541", url: "https://t.me/durov/541", text: "Undated post.", published_at: null };
		const mock = installFetchMock({
			"/v1/telegram/channel": { success: true, credits_charged: 1, ...channel },
			"/v1/telegram/channel/posts": { success: true, credits_charged: 0, cached: true, cached_at: "2026-09-15T01:00:00+00:00", channel, posts: [undated, older, post], cursor: "523", has_more: true },
			"/v1/telegram/post": { success: true, credits_charged: 1, ...post },
		});
		restore = mock.restore;

		const channelResult = await telegram.execute({ kind: "channel", handle: "https://t.me/s/durov", cache_max_age: "3d" }, context);
		expect(mock.calls[0].url.searchParams.get("handle")).toBe("durov");
		expect(mock.calls[0].url.searchParams.get("cache_max_age")).toBe("3d");
		expect(text(channelResult)).toContain("Channel: Pavel Durov (@durov) — verified");
		expect(text(channelResult)).toContain("11.1M subscribers");

		const postsResult = await telegram.execute({ kind: "posts", handle: "@durov", cursor: "600", limit: 2 }, context);
		expect(mock.calls[1].url.searchParams.get("cursor")).toBe("600");
		expect(text(postsResult)).toContain("Served from ScrapeCreators cache (scraped 2026-09-15T01:00:00+00:00); credits charged: 0");
		expect(text(postsResult)).toContain("Views: 1.2M | Reactions: 89.3K (⭐ 16.3K)");
		expect(text(postsResult)).toContain('Older posts: pass cursor="523"');
		expect(text(postsResult)).toContain("1 post without a parseable date listed last, unranked");
		expect(text(postsResult).indexOf("https://t.me/durov/543")).toBeLessThan(text(postsResult).indexOf("https://t.me/durov/540"));
		expect(text(postsResult)).not.toContain("Undated post.");
		expect(details(postsResult)).toMatchObject({ kind: "posts", cursor: "523", cached: true, shown: 2, undated: 1, post_ids: ["543", "540"] });

		const postResult = await telegram.execute({ kind: "post", url: "t.me/durov/543" }, context);
		expect(mock.calls[2].url.searchParams.get("url")).toBe("https://t.me/durov/543");
		expect(text(postResult)).toContain("Telegram post: https://t.me/durov/543");
	});

	test("telegram refuses private, invite-only, and numeric targets without a request", async () => {
		const mock = installFetchMock({});
		restore = mock.restore;

		expect(await telegram.execute({ kind: "channel", handle: "https://t.me/+AbCdEf" }, context)).toContain("private or invite-only");
		expect(await telegram.execute({ kind: "posts", handle: "https://t.me/joinchat/AbCdEf" }, context)).toContain("private or invite-only");
		expect(await telegram.execute({ kind: "channel", handle: "123456" }, context)).toContain("numeric Telegram ids are not supported");
		expect(await telegram.execute({ kind: "post", url: "https://t.me/durov" }, context)).toContain("https://t.me/<handle>/<post id>");
		expect(mock.calls).toHaveLength(0);
	});

	test("provider failures and missing credentials surface as explicit errors", async () => {
		const mock = installFetchMock({
			"/v1/tiktok/search/keyword": { status: 402, body: { success: false, error: "Insufficient credits" } },
		});
		restore = mock.restore;

		expect(await tiktok.execute({ query: "x" }, context)).toBe("ERROR: ScrapeCreators TikTok search returned HTTP 402: Insufficient credits");

		mock.restore();
		restore = undefined;
		delete process.env.SCRAPECREATORS_API_KEY;
		expect(await telegram.execute({ kind: "channel", handle: "durov" }, context)).toBe("ERROR: SCRAPECREATORS_API_KEY not set. Get a key at https://scrapecreators.com");
	});
});
