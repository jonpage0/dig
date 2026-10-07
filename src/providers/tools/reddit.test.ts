import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import type { SourceToolResult, ToolContext } from "../types.js";
import reddit from "./reddit.js";

type FetchCall = { url: URL };
type Envelope = { status: number; body: unknown };

function isEnvelope(value: unknown): value is Envelope {
	return typeof value === "object" && value !== null && "status" in value && "body" in value && typeof (value as Envelope).status === "number";
}

const context: ToolContext = {
	sessionID: "reddit-test",
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
		calls.push({ url });
		const route = routes[url.pathname];
		if (route === undefined) return new Response(JSON.stringify({ success: false, error: "no route" }), { status: 404 });
		const resolved = typeof route === "function" ? (route as (url: URL) => unknown)(url) : route;
		const { status, body } = isEnvelope(resolved) ? resolved : { status: 200, body: resolved };
		return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

// Shapes follow the official ScrapeCreators Reddit docs examples read 2026-09-15.
const globalPost = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	name: `t3_${id}`,
	title: `Thread ${id}`,
	selftext: "Don't try putting scraping tools in Lambda.",
	subreddit: "webscraping",
	author: "Sea_Cardiologist_212",
	score: 361,
	ups: 361,
	upvote_ratio: 0.99,
	num_comments: 102,
	created_utc: 1726851591,
	permalink: `/r/webscraping/comments/${id}/thread/`,
	url: `https://www.reddit.com/r/webscraping/comments/${id}/thread/`,
	over_18: false,
	stickied: false,
	link_flair_text: null,
	...extra,
});

const commentsFixture = {
	success: true,
	credits_charged: 1,
	post: globalPost("1flgwup"),
	comments: [
		{ author: "AutoModerator", body: "Reminder about the rules", score: 1, stickied: true, distinguished: "moderator" },
		{
			id: "ed1czme",
			author: "sweatybeard",
			body: "But when I finally do, it'll be the years biggest one",
			score: 12211,
			ups: 12211,
			created_at_iso: "2019-01-01T21:35:24.000Z",
			permalink: "/r/webscraping/comments/1flgwup/thread/ed1czme/",
			replies: { items: [{ author: "jofwu", body: "Somewhere out there.", score: 2415 }], more: { has_more: true, cursor: "reply_cursor_1" } },
		},
		{ author: "jofwu", body: "Somewhere out there, somebody has made the biggest one of the year.", score: 2415 },
	],
	more: { has_more: true, cursor: "opaque_cursor" },
};

describe("reddit tool (ScrapeCreators provider)", () => {
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

	test("all-Reddit post search maps sort/timeframe/cursor to the documented parameters and enriches comments", async () => {
		const mock = installFetchMock({
			"/v1/reddit/search": { success: true, credits_charged: 1, posts: [globalPost("1flgwup"), globalPost("2abcdef", { over_18: true })], after: "t3_1ihh437" },
			"/v1/reddit/post/comments": commentsFixture,
		});
		restore = mock.restore;

		const result = await reddit.execute({ query: "web scraping", sort: "comments", timeframe: "month", cursor: "t3_prev", commentThreads: 1 }, context);
		const output = text(result);
		const search = mock.calls[0].url;

		expect(search.pathname).toBe("/v1/reddit/search");
		expect(search.searchParams.get("filter")).toBe("posts");
		expect(search.searchParams.get("sort")).toBe("comment_count");
		expect(search.searchParams.get("timeframe")).toBe("month");
		expect(search.searchParams.get("after")).toBe("t3_prev");
		expect(mock.calls[1].url.pathname).toBe("/v1/reddit/post/comments");
		expect(mock.calls[1].url.searchParams.get("url")).toBe("https://www.reddit.com/r/webscraping/comments/1flgwup/thread/");
		expect(output).toContain("1 threads shown of 1 returned (1 NSFW excluded; pass allowNsfw=true to include)");
		expect(output).toContain('Next page: pass cursor with after="t3_1ihh437"');
		expect(output).toContain("Score: 361 | Comments: 102 | Author: u/Sea_Cardiologist_212 | Date: 2024-09-20");
		expect(output).toContain("u/sweatybeard (12211 pts)");
		expect(output).not.toContain("💬");
		expect(output).not.toContain("u/AutoModerator");
		expect(output).toContain('cursor="opaque_cursor"');
		expect(details(result)).toMatchObject({ provider: "scrapecreators", shown: 1, nsfw_excluded: 1, credits: { charged: 2, unreported: 0 }, comments: { requested: 1, fetched: 1, failed: 0 } });
	});

	test("post-comments mode forwards the cursor and surfaces top-level and reply continuation tokens", async () => {
		const mock = installFetchMock({ "/v1/reddit/post/comments": commentsFixture });
		restore = mock.restore;

		const result = await reddit.execute({ postUrl: "https://www.reddit.com/r/webscraping/comments/1flgwup/thread/", cursor: "prev_cursor", limit: 5 }, context);
		const output = text(result);

		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0].url.pathname).toBe("/v1/reddit/post/comments");
		expect(mock.calls[0].url.searchParams.get("cursor")).toBe("prev_cursor");
		expect(output).toContain("Post: **1flgwup** r/webscraping — Thread 1flgwup");
		expect(output).toContain('More top-level comments: pass postUrl with cursor="opaque_cursor"');
		expect(output).toContain("1. u/sweatybeard (12211 pts)");
		expect(output).toContain("↳ u/jofwu (2415 pts): Somewhere out there.");
		expect(output).toContain('Replies cursor: "reply_cursor_1"');
		expect(output).not.toContain("u/AutoModerator");
		expect(details(result)).toMatchObject({ mode: "post_comments", shown: 2, cursor: "opaque_cursor", reply_cursors: [{ id: "ed1czme", cursor: "reply_cursor_1" }] });

		expect(await reddit.execute({ postUrl: "https://www.reddit.com/r/x/comments/1/", query: "x" }, context)).toContain("applies to search mode");
		expect(await reddit.execute({ postUrl: "https://example.com/post" }, context)).toContain("reddit.com");
	});

	test("a 200 without the documented array is an unreadable payload, not an empty result", async () => {
		const mock = installFetchMock({ "/v1/reddit/search": { success: true, credits_charged: 1 } });
		restore = mock.restore;
		const result = await reddit.execute({ query: "x", includeComments: false }, context);
		expect(text(result)).toBe("ERROR: Reddit search failed: ScrapeCreators Reddit search returned an unexpected payload: `posts` is missing");
	});

	test("a comment page whose entries carry no readable body is reported as unreadable, not as moderation", async () => {
		const mock = installFetchMock({
			"/v1/reddit/post/comments": { success: true, credits_charged: 1, comments: [{ id: "c", unexpected: "body schema changed" }] },
		});
		restore = mock.restore;

		const result = await reddit.execute({ postUrl: "https://www.reddit.com/r/test/comments/abc/title/" }, context);
		const output = text(result);
		expect(output).toContain("Comments: 0 shown of 0 quotable top-level comments (1 returned on this page; stickied/moderator/AutoModerator excluded; 1 without a readable body skipped)");
		expect(output).toContain("None of the 1 returned comment carried a readable body; this page is unreadable, not moderated or empty.");
		expect(output).not.toContain("Every returned comment was stickied");
		expect(details(result)).toMatchObject({ returned: 1, unreadable: 1, quotable: 0, shown: 0 });
	});

	test("a pre-cancelled signal is reported as cancellation before any request", async () => {
		const mock = installFetchMock({ "/v1/reddit/search": { success: true, credits_charged: 1, posts: [] } });
		restore = mock.restore;
		const controller = new AbortController();
		controller.abort();
		const result = await reddit.execute({ query: "x" }, { ...context, abort: controller.signal });
		expect(text(result)).toMatch(/^ERROR: Cancelled: /);
		expect(mock.calls).toHaveLength(0);
	});

	test("subreddit-scoped search hits each subreddit, keeps partial failures visible, and reads compact post shapes", async () => {
		const mock = installFetchMock({
			"/v1/reddit/subreddit/search": (url: URL) =>
				url.searchParams.get("subreddit") === "broken"
					? { success: false, error: "subreddit not found" }
					: {
					success: true,
					credits_charged: 1,
					posts: [{ id: "t3_8gmjrb", title: "Is doing 50-100 pushups a day doing anything?", url: "https://www.reddit.com/r/Fitness/comments/8gmjrb/pushups/", permalink: "/r/Fitness/comments/8gmjrb/pushups/", nsfw: false, subreddit: { name: "Fitness" }, votes: 1414, num_comments: 582, created_at_iso: "2018-05-03T01:09:17.620Z" }],
					comments: [],
					media: [],
					cursor: "eyJjYW5k",
				},
		});
		restore = mock.restore;

		const result = await reddit.execute({ query: "push ups", subreddits: ["r/Fitness", "broken"], sort: "hot", timeframe: "hour", includeComments: false }, context);
		const output = text(result);
		const calls = mock.calls.map((call) => call.url);

		expect(calls.map((url) => url.pathname)).toEqual(["/v1/reddit/subreddit/search", "/v1/reddit/subreddit/search"]);
		expect(calls[0].searchParams.get("subreddit")).toBe("Fitness");
		expect(calls[0].searchParams.get("sort")).toBe("hot");
		expect(calls[0].searchParams.get("timeframe")).toBe("hour");
		expect(output).toContain("**8gmjrb** r/Fitness — Is doing 50-100 pushups a day doing anything?");
		expect(output).toContain("Score: 1.4K | Comments: 582 | Author: not returned | Date: 2018-05-03");
		expect(output).toContain("Partial: ScrapeCreators Reddit r/broken search: subreddit not found");
		expect(output).toContain('r/Fitness: cursor="eyJjYW5k"');
		expect(output).toContain("Comments: not requested");
		expect(output).toContain("Credits charged: 1 reported, plus 1 request that did not report a charge (total unknown)");
		expect(details(result)).toMatchObject({ shown: 1, credits: { charged: 1, unreported: 1 }, errors: ["ScrapeCreators Reddit r/broken search: subreddit not found"] });
	});

	test("comment search uses the comments filter and formats comment hits", async () => {
		const mock = installFetchMock({
			"/v1/reddit/subreddit/search": {
				success: true,
				credits_charged: 1,
				posts: [],
				comments: [{ id: "t1_nxf7p27", author: "Philser23", body: "My girlfriend decided to start going to the gym.", votes: 123, url: "https://www.reddit.com/r/Fitness/comments/1q2p898/gym_story_saturday/nxf7p27/", created_at_iso: "2026-01-03T11:26:02.434Z", post: { title: "Gym Story Saturday", url: "https://www.reddit.com/r/Fitness/comments/1q2p898/gym_story_saturday/" }, subreddit: { name: "Fitness" } }],
				media: [],
			},
		});
		restore = mock.restore;

		const result = await reddit.execute({ query: "gym", filter: "comments", subreddits: ["Fitness"], sort: "top" }, context);
		const output = text(result);

		expect(mock.calls).toHaveLength(1);
		expect(output).toContain("Reddit comment search via ScrapeCreators");
		expect(output).toContain("u/Philser23 in r/Fitness — My girlfriend decided to start going to the gym.");
		expect(output).toContain("Score: 123 | Date: 2026-01-03 | Thread: Gym Story Saturday");
		expect(details(result)).toMatchObject({ filter: "comments", shown: 1 });
	});

	test("rejects unsupported filter combinations before any request", async () => {
		const mock = installFetchMock({});
		restore = mock.restore;

		expect(await reddit.execute({ query: "x", sort: "hot" }, context)).toContain("only available inside subreddits");
		expect(await reddit.execute({ query: "x", timeframe: "hour" }, context)).toContain("only available inside subreddits");
		expect(await reddit.execute({ query: "x", filter: "comments", sort: "comments" }, context)).toContain("comment searches accept sort relevance, top, or new");
		expect(await reddit.execute({ query: "x", subreddits: ["a", "b"], cursor: "c" }, context)).toContain("exactly one subreddit");
		expect(mock.calls).toHaveLength(0);
	});

	test("provider errors and a missing credential are reported, never silently empty", async () => {
		const mock = installFetchMock({ "/v1/reddit/search": { status: 401, body: { success: false, error: "Invalid API key" } } });
		restore = mock.restore;
		expect(await reddit.execute({ query: "x" }, context)).toBe("ERROR: Reddit search failed: ScrapeCreators Reddit search returned HTTP 401: Invalid API key");

		mock.restore();
		restore = undefined;
		delete process.env.SCRAPECREATORS_API_KEY;
		expect(await reddit.execute({ query: "x" }, context)).toBe("ERROR: Reddit lookup failed: SCRAPECREATORS_API_KEY not set. Get a key at https://scrapecreators.com");
	});
});
