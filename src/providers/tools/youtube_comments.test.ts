// The fixtures are ScrapeCreators' documented response examples for GET /v1/youtube/video/comments (read 2026-11-10),
// trimmed; they have not been checked against a live response.
import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import { executeSource } from "../outcome.js";
import type { SourceToolResult, ToolContext } from "../types.js";
import { comments } from "./youtube_comments.js";

type FetchCall = { url: URL; headers: Record<string, string> };
type Reply = { status: number; body: unknown };
type Route = unknown | ((call: FetchCall) => unknown);

const KEY = "sc-test-key-0231";
const PATH = "/v1/youtube/video/comments";

const context: ToolContext = {
	sessionID: "youtube-comments-test",
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

const CONTENT = "I love how in the middle he said \"I've been able to work with 2 great coaches... Pete and Coach Tomlin\"... Side shade to Coach Sean Payton, love it :)";
const documented = {
	id: "UgwVfRopfS2F-WB3aF14AaABAg",
	content: CONTENT,
	publishedTimeText: "9 days ago",
	publishedTime: "2025-01-23T23:14:02.948Z",
	replyLevel: 0,
	author: { name: "@SimonT80", channelId: "UC8JC3uSUmmXTCTKl-bgr1DA", isVerified: false, isCreator: false, channelUrl: "https://youtube.com/@SimonT80" },
	engagement: { likes: 110, replies: 5 },
	repliesContinuationToken: "Eg0SC2RRdzR3OVdnWGNRGAYy1AEK...",
};
const byOwner = { ...documented, id: "Ugx-owner", content: "Thanks for watching.\nMore next week.", author: { ...documented.author, name: "@Channel", isCreator: true, isVerified: true }, engagement: { likes: 1, replies: 0 } };
const page = (items: unknown[], next?: string) => ({ success: true, credits_remaining: 1000000, credits_charged: 1, comments: items, ...(next ? { continuationToken: next } : {}) });

describe("youtube_comments", () => {
	const originalKey = process.env.SCRAPECREATORS_API_KEY;
	let restore: (() => void) | undefined;
	beforeEach(() => { process.env.SCRAPECREATORS_API_KEY = KEY; });
	afterEach(() => {
		restore?.();
		restore = undefined;
		if (originalKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
		else process.env.SCRAPECREATORS_API_KEY = originalKey;
	});

	test("sends the video, order and cursor as documented, and shows the whole page with each comment in full", async () => {
		const mock = installFetchMock({ [PATH]: page([documented, byOwner], "Eg0SCzVFV2F4bVd....") });
		restore = mock.restore;
		const result = await executeSource(comments, { url: "https://youtube.com/shorts/dQw4w9WgXcQ", order: "top", cursor: "4qmFsgKr" }, context);
		const out = text(result);
		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]!.headers["x-api-key"]).toBe(KEY);
		expect(Object.fromEntries(mock.calls[0]!.url.searchParams)).toEqual({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", order: "top", continuationToken: "4qmFsgKr" });
		expect(result.status).toBe("success");
		expect(out).toContain("YouTube comments: https://www.youtube.com/watch?v=dQw4w9WgXcQ");
		expect(out).toContain("Order: top | continuation page");
		expect(out).toContain("Credits charged: 1");
		expect(out).toContain("Comments returned: 2");
		expect(out).toContain('1. @SimonT80 — 2025-01-23 (about; YouTube shows "9 days ago") — 110 likes — 5 replies');
		expect(out).toContain(`   ${CONTENT}`);
		expect(out).toContain("2. @Channel — 2025-01-23 (about; YouTube shows \"9 days ago\") — 1 like — 0 replies — written by the channel owner — verified author");
		expect(out).toContain("   Thanks for watching.\n   More next week.");
		expect(out).toContain("top comments are the most liked");
		expect(out).toMatch(/Next page: pass cursor="Eg0SCzVFV2F4bVd\.\.\.\." with the same url and order\.$/);
		expect(details(result)).toMatchObject({ video_id: "dQw4w9WgXcQ", order: "top", returned: 2, shown: 2, cursor: "Eg0SCzVFV2F4bVd....", comment_ids: [documented.id, byOwner.id], truncated: false });
		expect(details(result).cost).toEqual([{ amount: 1, unit: "credits" }]);
	});

	test("limit narrows what is shown, never what is requested, and says the cursor continues after every returned comment", async () => {
		const mock = installFetchMock({ [PATH]: page([documented, byOwner], "next-token") });
		restore = mock.restore;
		const result = await executeSource(comments, { url: "dQw4w9WgXcQ", limit: 1 }, context);
		const out = text(result);
		expect(Object.fromEntries(mock.calls[0]!.url.searchParams)).toEqual({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
		expect(out).toContain("Order: provider default (no order sent; ScrapeCreators documents top and newest) | first page");
		expect(out).toContain("Comments returned: 2 | 1 shown of 2 returned (limit=1)");
		expect(out).not.toContain("@Channel");
		expect(out).toContain('Next page: pass cursor="next-token" with the same url and order (it continues after all 2 returned comments, including the 1 not shown).');
		expect(result.status).toBe("success");
	});

	test("no comments is empty; the last page says there is no further page; an unreadable payload is an error", async () => {
		let body: unknown = page([]);
		const mock = installFetchMock({ [PATH]: () => body });
		restore = mock.restore;
		const empty = await executeSource(comments, { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, context);
		expect(empty.status).toBe("empty");
		expect(empty.text).toContain("YouTube returned no comments for this video and order.");
		expect(details(empty).cost).toEqual([{ amount: 1, unit: "credits" }]);

		body = page([documented]);
		const last = await executeSource(comments, { url: "dQw4w9WgXcQ" }, context);
		expect(last.status).toBe("success");
		expect(last.text).toMatch(/Next page: no continuation returned; the provider gave no further page\.$/);

		body = page([documented, { id: "x" }]);
		const mixed = await executeSource(comments, { url: "dQw4w9WgXcQ" }, context);
		expect(mixed.status).toBe("partial");
		expect(mixed.text).toContain("Unreadable entries: 1 returned entry carried no comment text and was skipped");

		body = { success: true, credits_charged: 1 };
		expect(await comments.execute({ url: "dQw4w9WgXcQ" }, context)).toBe("ERROR: ScrapeCreators YouTube comments returned an unexpected payload: `comments` is missing");
	});

	test("a provider error status fails with the provider's message and the key redacted", async () => {
		const mock = installFetchMock({ [PATH]: { status: 402, body: { success: false, error: `Insufficient credits for ${KEY}` } } });
		restore = mock.restore;
		const result = await executeSource(comments, { url: "dQw4w9WgXcQ" }, context);
		expect(result.status).toBe("failed");
		expect(result.text).toBe("ERROR: ScrapeCreators YouTube comments returned HTTP 402: Insufficient credits for [redacted]");
		expect(details(result).cost).toBeNull();
		expect(mock.calls).toHaveLength(1);
	});

	test("a request that got no response is sent once, says its cost is unknown once, and the receipt leaves it unknown", async () => {
		const mock = installFetchMock({ [PATH]: () => { throw new TypeError("fetch failed"); } });
		restore = mock.restore;
		const result = await executeSource(comments, { url: "dQw4w9WgXcQ" }, context);
		expect(mock.calls).toHaveLength(1);
		expect(result.status).toBe("failed");
		expect(result.text.match(/its cost is unknown/g)).toHaveLength(1);
		expect(details(result).cost).toBeNull();
	});

	test("arguments are checked and a missing key fails before any request", async () => {
		const mock = installFetchMock({});
		restore = mock.restore;
		expect(await comments.execute({ url: "https://vimeo.com/1" }, context)).toBe("ERROR: url must be a YouTube URL or video ID");
		expect(await comments.execute({ url: "short" }, context)).toBe("ERROR: url must be a valid YouTube video ID or URL");
		expect(await comments.execute({ url: "dQw4w9WgXcQ", order: "oldest" }, context)).toBe("ERROR: order must be one of top, newest");
		expect(await comments.execute({ url: "dQw4w9WgXcQ", limit: 0 }, context)).toBe("ERROR: limit must be a positive whole number.");
		delete process.env.SCRAPECREATORS_API_KEY;
		expect(await comments.execute({ url: "dQw4w9WgXcQ" }, context)).toBe("ERROR: SCRAPECREATORS_API_KEY not set. Get a key at https://scrapecreators.com");
		expect(mock.calls).toHaveLength(0);
	});

	test("output past the limit is cut with a pointer to the retained original, and the next-page line is kept", async () => {
		const huge = { ...documented, content: "word ".repeat(15_000) };
		const mock = installFetchMock({ [PATH]: page([huge, { ...huge, id: "2" }], "after") });
		restore = mock.restore;
		const result = await comments.execute({ url: "dQw4w9WgXcQ" }, context);
		const out = text(result);
		expect(out).toContain("[Truncated at 60000 of ");
		expect(out).toMatch(/Next page: pass cursor="after" with the same url and order\.$/);
		expect(typeof result === "string" ? undefined : result.status).toBe("partial");
	});
});
