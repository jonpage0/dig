import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import { executeSource } from "../outcome.js";
import type { SourceToolResult, ToolContext } from "../types.js";
import { reddit } from "./tikhub_reddit.js";

type FetchCall = { url: URL };

const context: ToolContext = {
	sessionID: "tikhub-reddit-test",
	directory: "/tmp",
	worktree: "/tmp",
	abort: new AbortController().signal,
	keep: () => {},
};

function text(result: SourceToolResult): string {
	return typeof result === "string" ? result : result.text;
}

/** TikHub's documented `ResponseModel` (saved OpenAPI, 2026-10-20): the request is echoed under `params`, results sit under `data`. */
function envelope(url: URL, data: unknown) {
	return {
		code: 200,
		request_id: "req-1",
		message: "Request successful. This request will incur a charge.",
		message_zh: "请求成功，本次请求将被计费。",
		support: "Discord: https://discord.gg/aMEAS8Xsvz",
		time: "2026-11-10 10:00:00",
		time_stamp: 1794326400,
		time_zone: "America/Los_Angeles",
		docs: `https://api.tikhub.io/#/Reddit-APP-API${url.pathname}`,
		cache_message: "This response is cached and accessible via the URL below for 24 hours at no extra cost.",
		cache_message_zh: "此响应已缓存。",
		cache_url: "https://cache.tikhub.io/api/v1/cache/req-1",
		router: url.pathname,
		params: Object.fromEntries(url.searchParams),
		data,
	};
}

/** Routes map an endpoint path to its `data`; anything unrouted answers an empty `need_format=true` listing. */
function installFetchMock(routes: Record<string, unknown | ((url: URL) => unknown)> = {}) {
	const calls: FetchCall[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = input instanceof URL ? input : new URL(String(input));
		calls.push({ url });
		const route = routes[url.pathname];
		const data = route === undefined ? { children: [], pageInfo: { hasNextPage: false } } : typeof route === "function" ? (route as (url: URL) => unknown)(url) : route;
		return new Response(JSON.stringify(envelope(url, data)), { status: 200, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

describe("tikhub_reddit tool", () => {
	const originalKey = process.env.TIKHUB_API_KEY;
	let restore: (() => void) | undefined;

	beforeEach(() => {
		process.env.TIKHUB_API_KEY = "tikhub-test-key";
	});

	afterEach(() => {
		restore?.();
		restore = undefined;
		if (originalKey === undefined) delete process.env.TIKHUB_API_KEY;
		else process.env.TIKHUB_API_KEY = originalKey;
	});

	test("an unsupported sort for the operation is rejected before any request", async () => {
		const mock = installFetchMock();
		restore = mock.restore;

		for (const [args, expected] of [
			[{ operation: "discovery_bundle", query: "q", sort: "BEST" }, "Unsupported sort BEST"],
			[{ operation: "query_scout", query: "q", sort: "RISING" }, "Unsupported sort RISING"],
			[{ operation: "subreddit_context", subredditName: "pics", sort: "RELEVANCE" }, "Unsupported sort RELEVANCE"],
			[{ operation: "author_context", username: "someone", sort: "BEST" }, "Unsupported sort BEST"],
		] as const) {
			expect(text(await reddit.execute(args, context))).toContain(expected);
		}
		expect(mock.calls).toHaveLength(0);
	});

	test("subreddit_channels feed discovery requires a subreddit instead of falling back to the provider default", async () => {
		const mock = installFetchMock();
		restore = mock.restore;

		expect(text(await reddit.execute({ operation: "feed_discovery", feed: "subreddit_channels" }, context))).toBe(
			"ERROR: TikHub Reddit failed: subredditName is required for subreddit channel feed discovery",
		);
		expect(mock.calls).toHaveLength(0);

		await reddit.execute({ operation: "feed_discovery", feed: "subreddit_channels", subredditName: "r/pics" }, context);
		expect(mock.calls[0].url.searchParams.get("subreddit_name")).toBe("pics");
	});

	test("a post id without its t3_ prefix is sent with it", async () => {
		const mock = installFetchMock();
		restore = mock.restore;

		await reddit.execute({ operation: "deep_thread", postId: "1flgwup", includeReplies: false }, context);
		await reddit.execute({ operation: "thread_intelligence", postIds: ["t3_abc123", "def456"], includeReplies: false }, context);

		expect(mock.calls.map((call) => call.url.searchParams.get("post_id"))).toEqual(["t3_1flgwup", "t3_1flgwup", "t3_abc123", "t3_abc123", "t3_def456", "t3_def456"]);
	});

	test("the response envelope's echoed request and boilerplate are not read as evidence", async () => {
		const mock = installFetchMock();
		restore = mock.restore;

		const output = text(await reddit.execute({ operation: "query_scout", query: "standing desk" }, context));

		expect(mock.calls).toHaveLength(3);
		expect(output).not.toContain("## Query Suggestions");
		expect(output).toContain("Useful records: 0 extracted (3 thin successful calls)");
		expect(output).toContain("## Raw Response Samples");
		expect(output).toContain('"children": []');
		expect(output).not.toContain("cache_message");
	});

	test("records under the envelope's data are still extracted, and an empty-string count is not read as zero", async () => {
		const mock = installFetchMock({
			"/api/v1/reddit/app/fetch_dynamic_search": {
				children: [{ id: "t3_abc", title: "Standing desk after a year", subreddit: "r/desks", score: "", ups: 57, num_comments: 12 }],
				pageInfo: { hasNextPage: true, endCursor: "next-page" },
			},
		});
		restore = mock.restore;

		const output = text(await reddit.execute({ operation: "query_scout", query: "standing desk" }, context));

		expect(output).toContain("1. **Standing desk after a year** — r/desks | 57 pts | 12 comments");
		expect(output).toContain("- Post IDs: `t3_abc`");
		expect(output).toContain('Listing pagination for dynamic search (/api/v1/reddit/app/fetch_dynamic_search): ["next-page"]');
	});

	test("a default discovery bundle sends no parameter it then reports as unsupported", async () => {
		const mock = installFetchMock();
		restore = mock.restore;

		const output = text(await reddit.execute({ operation: "discovery_bundle", query: "standing desk" }, context));
		const searches = mock.calls.filter((call) => call.url.pathname === "/api/v1/reddit/app/fetch_dynamic_search").map((call) => call.url.searchParams);

		expect(searches.map((params) => params.get("search_type"))).toEqual(["post", "community", "comment"]);
		expect(searches[0].get("sort")).toBe("RELEVANCE");
		expect(searches[0].get("time_range")).toBe("month");
		expect(searches[1].has("sort")).toBe(false);
		expect(searches[1].has("time_range")).toBe(false);
		expect(searches[2].get("sort")).toBe("RELEVANCE");
		expect(searches[2].has("time_range")).toBe(false);
		expect(output).not.toContain("Unsupported");
		expect(output).toContain("Display cap: 10 per evidence section, 10 for Comment Highlights (never more than 12)");
	});

	test("a query_scout comment search feeds Comment Highlights", async () => {
		const mock = installFetchMock({
			"/api/v1/reddit/app/fetch_dynamic_search": {
				children: [{ id: "t1_c1", body: "I switched to a standing desk and my back pain went away.", author: "deskfan", score: 31 }],
			},
		});
		restore = mock.restore;

		const output = text(await reddit.execute({ operation: "query_scout", query: "standing desk", searchType: "comment" }, context));

		expect(output).toContain("| dynamic comment search | `/api/v1/reddit/app/fetch_dynamic_search` | ok |");
		expect(output).toContain('## Comment Highlights\n1. ID: t1_c1 | u/deskfan | 31 pts — "I switched to a standing desk and my back pain went away."');
	});
	test("a request that got no response is sent once, says its cost is unknown, and records no cost", async () => {
		const sent: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			sent.push(new URL(String(input)).pathname);
			throw new TypeError("fetch failed");
		}) as typeof fetch;
		restore = () => { globalThis.fetch = originalFetch; };
		const result = await executeSource(reddit, { operation: "deep_thread", postId: "t3_abc" }, context);
		expect(sent).toEqual(["/api/v1/reddit/app/fetch_post_details", "/api/v1/reddit/app/fetch_post_comments"]);
		expect(result.status).toBe("failed");
		expect(result.text).toContain("fetch failed. TikHub may have received and charged this request, but no complete response arrived; its cost is unknown.");
		expect(result.details?.cost).toBeNull();
	});

	test("another listing page is success, not partial", async () => {
		const mock = installFetchMock({ "/api/v1/reddit/app/fetch_dynamic_search": { children: [], pageInfo: { hasNextPage: true, endCursor: "next-page-cursor" } } });
		restore = mock.restore;
		const paged = await executeSource(reddit, { operation: "query_scout", query: "espresso" }, context);
		expect(paged.status).toBe("success");
		expect(paged.text).toContain("next-page-cursor");
	});
});
