import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { executeSource } from "../outcome.js";
import { createSchemas } from "../schemas.js";
import type { SourceToolResult, ToolContext } from "../types.js";
import { web_search } from "./x_web_search.js";

type FetchCall = { url: URL; headers: Record<string, string> };
type Reply = { status: number; body: unknown };
type Route = unknown | ((call: FetchCall) => unknown);

const KEY = "sc-test-key-x-web";
const PATH = "/v1/twitter/search/posts";

const context: ToolContext = {
	sessionID: "x-web-search-test",
	directory: "/tmp",
	worktree: "/tmp",
	abort: new AbortController().signal,
	keep: () => {},
};

const text = (result: SourceToolResult): string => (typeof result === "string" ? result : result.text);
const details = (result: SourceToolResult): Record<string, unknown> => (typeof result === "string" ? {} : (result.details ?? {}));
const isReply = (value: unknown): value is Reply => typeof value === "object" && value !== null && "status" in value && "body" in value;

function installFetchMock(routes: Record<string, Route>) {
	const calls: FetchCall[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof URL ? input : new URL(String(input));
		const call = { url, headers: { ...(init?.headers as Record<string, string>) } };
		calls.push(call);
		const route = routes[url.pathname];
		if (route === undefined) return new Response(JSON.stringify({ success: false, error: "no route" }), { status: 404 });
		const resolved = typeof route === "function" ? (route as (call: FetchCall) => unknown)(call) : route;
		const reply = isReply(resolved) ? resolved : { status: 200, body: resolved };
		return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

// Mirrors live ScrapeCreators /v1/twitter/search/posts response observed 2026-11-22 (GraphQL tweet objects).
const liveTweet = {
	__typename: "Tweet",
	rest_id: "2022496971895025679",
	url: "https://x.com/advaithj1/status/2022496971895025679",
	views: { count: "24665", state: "EnabledWithCount" },
	core: {
		user_results: {
			result: {
				is_blue_verified: true,
				core: { screen_name: "advaithj1", name: "advaith" },
				legacy: { followers_count: 18500 },
			},
		},
	},
	legacy: {
		id_str: "2022496971895025679",
		created_at: "Sat Feb 14 02:23:48 +0000 2026",
		full_text: "I've added more components to bot modals on Discord! Check https://t.co/abc",
		favorite_count: 617,
		retweet_count: 42,
		reply_count: 15,
		quote_count: 8,
		bookmark_count: 91,
		entities: { urls: [{ url: "https://t.co/abc", expanded_url: "https://discord.com/developers/docs" }] },
		extended_entities: {
			media: [
				{ type: "photo", media_url_https: "https://pbs.twimg.com/media/shot1.png", ext_alt_text: "Discord modal screenshot" },
			],
		},
	},
};

const longVideoQuotedTweet = {
	__typename: "TweetWithVisibilityResults",
	tweet: {
		rest_id: "2022500000000000001",
		url: "https://x.com/builder/status/2022500000000000001",
		views: { count: "9100" },
		core: {
			user_results: {
				result: {
					legacy: { screen_name: "builder", name: "Bot Builder", followers_count: 3200, verified: false },
				},
			},
		},
		note_tweet: {
			note_tweet_results: {
				result: {
					text: "Long-form breakdown of Components V2 containers with link https://t.co/longlink",
					entity_set: { urls: [{ url: "https://t.co/longlink", expanded_url: "https://example.com/guide" }] },
				},
			},
		},
		legacy: {
			created_at: "Sun Feb 15 10:00:00 +0000 2026",
			full_text: "Truncated preview...",
			favorite_count: 120,
			retweet_count: 0,
			reply_count: 0,
			quote_count: 0,
			bookmark_count: 33,
			extended_entities: {
				media: [
					{
						type: "video",
						media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/1/img/thumb.jpg",
						video_info: {
							duration_millis: 14500,
							variants: [
								{ content_type: "application/x-mpegURL", url: "https://video.twimg.com/a.m3u8" },
								{ content_type: "video/mp4", bitrate: 256000, url: "https://video.twimg.com/low.mp4" },
								{ content_type: "video/mp4", bitrate: 2176000, url: "https://video.twimg.com/high.mp4" },
							],
						},
					},
				],
			},
		},
		quoted_status_result: {
			result: {
				rest_id: "1914792045694333208",
				core: { user_results: { result: { core: { screen_name: "discord", name: "Discord" } } } },
				legacy: { full_text: "Components V2 is live.", favorite_count: 5000 },
			},
		},
	},
};

const page = (posts: unknown[], cursor: string | null = "2") => ({
	success: true,
	credits_remaining: 24449,
	credits_charged: 1,
	query: "Discord Components V2",
	posts,
	cursor,
});

describe("x_web_search", () => {
	const originalKey = process.env.SCRAPECREATORS_API_KEY;
	let restore: (() => void) | undefined;
	beforeEach(() => { process.env.SCRAPECREATORS_API_KEY = KEY; });
	afterEach(() => {
		restore?.();
		restore = undefined;
		if (originalKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
		else process.env.SCRAPECREATORS_API_KEY = originalKey;
	});

	test("searches ScrapeCreators, formats hydrated posts with links, media, note_tweet and quotes, and records credits", async () => {
		const mock = installFetchMock({ [PATH]: page([liveTweet, longVideoQuotedTweet], "2") });
		restore = mock.restore;
		const result = await executeSource(web_search, { query: "Discord Components V2", cursor: "1" }, context);
		const out = text(result);

		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]!.headers["x-api-key"]).toBe(KEY);
		expect(Object.fromEntries(mock.calls[0]!.url.searchParams)).toEqual({ query: "Discord Components V2", cursor: "1" });
		expect(result.status).toBe("success");
		expect(out).toContain('X web search via ScrapeCreators for "Discord Components V2" (cursor=1): 2 posts.');
		expect(out).toContain("Credits charged: 1");
		expect(out).toContain("@advaithj1 (advaith, 18,500 followers, verified) · 2026-02-14 02:23 UTC · 15 replies · 42 reposts · 8 quotes · 617 likes · 91 bookmarks · 24,665 views · https://x.com/advaithj1/status/2022496971895025679");
		expect(out).toContain("Check https://discord.com/developers/docs");
		expect(out).toContain("Media: photo https://pbs.twimg.com/media/shot1.png (alt text: Discord modal screenshot)");
		expect(out).toContain("Long-form breakdown of Components V2 containers with link https://example.com/guide");
		expect(out).toContain("Media: video https://video.twimg.com/high.mp4 (14.5 s; preview https://pbs.twimg.com/ext_tw_video_thumb/1/img/thumb.jpg)");
		expect(out).toContain("Quoting @discord: https://x.com/discord/status/1914792045694333208");
		expect(out).toContain("> Components V2 is live.");
		expect(out).toMatch(/Next page: pass cursor="2" with the same query \(ScrapeCreators supports pages 1-11\)\.$/);
		expect(details(result)).toMatchObject({
			provider: "scrapecreators",
			via: "ScrapeCreators",
			returned: 2,
			duplicates_dropped: 0,
			unreadable: 0,
			cursor: "2",
			post_ids: ["2022496971895025679", "2022500000000000001"],
			credits_charged: 1,
			truncated: false,
		});
		expect(details(result).cost).toEqual([{ amount: 1, unit: "credits" }]);
	});

	test("deduplicates repeated ids, handles null cursor, empty results, partial unreadable entries and malformed payloads", async () => {
		let body: unknown = page([liveTweet, liveTweet], null);
		const mock = installFetchMock({ [PATH]: () => body });
		restore = mock.restore;

		const dedup = await executeSource(web_search, { query: "Discord" }, context);
		expect(dedup.status).toBe("success");
		expect(text(dedup)).toContain("1 post (1 duplicate dropped).");
		expect(text(dedup)).toMatch(/Next page: no cursor returned; the provider gave no further page\.$/);
		expect(details(dedup).cursor).toBeNull();

		body = page([], null);
		const empty = await executeSource(web_search, { query: "nothing here" }, context);
		expect(empty.status).toBe("empty");
		expect(text(empty)).toContain("ScrapeCreators returned no indexed X posts");
		expect(details(empty).cost).toEqual([{ amount: 1, unit: "credits" }]);

		body = page([liveTweet, { bogus: true }], "3");
		const mixed = await executeSource(web_search, { query: "mixed" }, context);
		expect(mixed.status).toBe("partial");
		expect(text(mixed)).toContain("Unreadable entries: 1 returned entry lacked a readable X post record");

		body = page([{ bogus: true }], null);
		const allBad = await executeSource(web_search, { query: "allbad" }, context);
		expect(allBad.status).toBe("failed");
		expect(text(allBad)).toContain("unexpected payload: none of the 1 entry carried a readable X post record");

		body = { success: true, credits_charged: 1 };
		const missing = await executeSource(web_search, { query: "missing" }, context);
		expect(missing.status).toBe("failed");
		expect(text(missing)).toContain("`posts` is missing");
	});

	test("redacts echoed credentials on HTTP errors, leaves transport failures with unknown cost, and validates inputs before any request", async () => {
		const mock = installFetchMock({ [PATH]: { status: 402, body: { success: false, error: `No credits for ${KEY}` } } });
		restore = mock.restore;

		const err = await executeSource(web_search, { query: "test" }, context);
		expect(err.status).toBe("failed");
		expect(text(err)).toBe("ERROR: ScrapeCreators X web search returned HTTP 402: No credits for [redacted]");
		expect(details(err).cost).toBeNull();
		expect(mock.calls).toHaveLength(1);

		restore();
		const netMock = installFetchMock({ [PATH]: () => { throw new TypeError("fetch failed"); } });
		restore = netMock.restore;
		const netErr = await executeSource(web_search, { query: "test" }, context);
		expect(netMock.calls).toHaveLength(1);
		expect(netErr.status).toBe("failed");
		expect(text(netErr)).toContain("its cost is unknown");
		expect(details(netErr).cost).toBeNull();

		restore();
		const idle = installFetchMock({});
		restore = idle.restore;
		expect(await web_search.execute({ query: "   " }, context)).toBe("ERROR: query is required.");
		expect(await web_search.execute({ query: "ok", cursor: "  " }, context)).toBe("ERROR: cursor must be a non-empty string returned by a previous response.");
		delete process.env.SCRAPECREATORS_API_KEY;
		expect(await web_search.execute({ query: "ok" }, context)).toContain("SCRAPECREATORS_API_KEY is not set in Dig's keys.env");
		expect(idle.calls).toHaveLength(0);

		const schema = createSchemas(Type).x_web_search;
		expect(Value.Check(schema, { query: "hello" })).toBe(true);
		expect(Value.Check(schema, { query: "hello", cursor: "2" })).toBe(true);
		expect(Value.Check(schema, { query: "" })).toBe(false);
		expect(Value.Check(schema, { query: "hello", cursor: "" })).toBe(false);
	});

	test("truncates output past 60,000 characters as partial while preserving the next-page line", async () => {
		const big = {
			...liveTweet,
			rest_id: "2022500000000000009",
			legacy: { ...liveTweet.legacy, full_text: "word ".repeat(15_000) },
		};
		const mock = installFetchMock({ [PATH]: page([big, { ...big, rest_id: "2022500000000000010" }], "4") });
		restore = mock.restore;
		const result = await executeSource(web_search, { query: "huge" }, context);
		expect(result.status).toBe("partial");
		expect(text(result)).toContain("[Truncated at 60000 of ");
		expect(text(result)).toMatch(/Next page: pass cursor="4" with the same query \(ScrapeCreators supports pages 1-11\)\.$/);
		expect(details(result).truncated).toBe(true);
	});
});
