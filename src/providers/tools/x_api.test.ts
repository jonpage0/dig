import { afterEach, beforeEach, describe, test } from "node:test";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { expect } from "expect";
import { executeSource } from "../outcome.js";
import type { ToolContext } from "../types.js";
import { bookmarks, community, count_posts, explore, likes, news, post, search_posts, users } from "./x_api.js";
import { percent, signatureBase, USER_KEY_NAMES } from "./x_oauth.js";

const TOKEN = "AAAAAAAAAAAAAAAAAAAAAx-test-bearer%3Dtoken";
const TIKHUB_KEY = "tikhub-test-key-for-x";
const POST_ID = "2107184236008718446";
const OTHER_ID = "2107182485377626379";
const AUTHOR_ID = "44196397";

const originalFetch = globalThis.fetch;
const saved: Record<string, string | undefined> = Object.fromEntries(["X_BEARER_TOKEN", "TIKHUB_API_KEY", "TIKHUB_BASE_URL", ...USER_KEY_NAMES].map((name) => [name, process.env[name]]));

type Call = { url: URL; headers: Record<string, string>; redirect: RequestRedirect | undefined; at: number };
type Reply = Response | (() => never);
let calls: Call[] = [];
let kept: Array<{ label: string; status: number | string; body: unknown }> = [];

/** Every request goes to `respond`; an unexpected one fails the test instead of reaching a provider. */
function installFetch(respond: (url: URL) => Reply) {
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		calls.push({ url, headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect, at: Date.now() });
		const reply = respond(url);
		return typeof reply === "function" ? reply() : reply;
	}, { preconnect: originalFetch.preconnect });
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });
const xCalls = () => calls.filter((call) => call.url.host === "api.x.com");
const tikhubCalls = () => calls.filter((call) => call.url.host === "api.tikhub.io");

const context = (): ToolContext => ({
	sessionID: "x-api-test",
	directory: "/tmp",
	worktree: "/tmp",
	abort: new AbortController().signal,
	keep: (label, status, body) => kept.push({ label, status, body }),
});

beforeEach(() => {
	calls = [];
	kept = [];
	process.env.X_BEARER_TOKEN = TOKEN;
	process.env.TIKHUB_API_KEY = TIKHUB_KEY;
	delete process.env.TIKHUB_BASE_URL;
	for (const name of USER_KEY_NAMES) delete process.env[name];
	installFetch((url) => {
		throw new Error(`unexpected request to ${url}`);
	});
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

// Shapes follow X's API reference (OpenAPI 2.170): `note_post`, `referenced_posts`, `repost_count`, `includes.posts`.
const author = { id: AUTHOR_ID, username: "jack", name: "jack", verified: true, verified_type: "blue", public_metrics: { followers_count: 6_500_000, following_count: 4_000, post_count: 29_000, listed_count: 30_000 } };
const quotedAuthor = { id: "783214", username: "X", name: "X", verified: true, verified_type: "business" };
const longText = `${"A long post that runs past 280 characters. ".repeat(8)}The end.`;
const apiPost = {
	id: POST_ID,
	text: `${longText.slice(0, 270)}… https://t.co/short`,
	note_post: { text: longText, entities: { urls: [{ url: "https://t.co/link", expanded_url: "https://example.com/article", title: "An article" }] } },
	author_id: AUTHOR_ID,
	created_at: "2026-10-05T19:00:46.000Z",
	conversation_id: POST_ID,
	lang: "en",
	edit_history_post_ids: ["2107184000000000000", POST_ID],
	public_metrics: { reply_count: 25, repost_count: 1, quote_count: 4, like_count: 57, bookmark_count: 22, impression_count: 6397 },
	referenced_posts: [{ type: "quoted", id: OTHER_ID }],
	attachments: { media_keys: ["3_1"], poll_ids: ["poll-1"] },
	context_annotations: [{ domain: { id: "47", name: "Brand" }, entity: { id: "10045225402", name: "Twitter" } }],
};
const includes = {
	users: [author, quotedAuthor],
	posts: [
		{ id: OTHER_ID, text: "The quoted post.", author_id: "783214", created_at: "2026-10-05T18:53:48.000Z", public_metrics: { reply_count: 0, repost_count: 2, quote_count: 1, like_count: 333, bookmark_count: 0, impression_count: 9000 } },
		{ id: "2107184000000000000", text: "The first version, before an edit.", author_id: AUTHOR_ID },
	],
	media: [{ media_key: "3_1", type: "photo", url: "https://pbs.twimg.com/media/photo.jpg", alt_text: "A photo" }],
	polls: [{ id: "poll-1", voting_status: "closed", options: [{ position: 1, label: "Yes", votes: 795 }, { position: 2, label: "No", votes: 156 }] }],
};
const notFound = (id: string) => ({ resource_id: id, resource_type: "tweet", title: "Not Found Error", detail: `Could not find tweet with id: [${id}].`, type: "https://api.x.com/2/problems/resource-not-found" });
const tikhubDetail = { code: 200, message: "Request successful.", data: { id: POST_ID, created_at: "Mon Oct 05 19:00:46 +0000 2026", text: "TikHub's copy of the post.", likes: 57, retweets: 1, replies: 25, views: "6397", author: { screen_name: "jack", name: "jack", sub_count: 6_500_000, blue_verified: true } } };

describe("x_post", () => {
	test("looks posts up with the Bearer Token and the full public field set, and returns each post's full text and context", async () => {
		installFetch(() => json({ data: [apiPost], includes }));
		const result = await executeSource(post, { posts: [`https://x.com/jack/status/${POST_ID}?s=20`] }, context());

		expect(xCalls()).toHaveLength(1);
		const [lookup] = xCalls();
		expect(`${lookup.url.origin}${lookup.url.pathname}`).toBe("https://api.x.com/2/tweets");
		expect(lookup.url.searchParams.get("ids")).toBe(POST_ID);
		expect(lookup.url.searchParams.get("post.fields")?.split(",")).toEqual(expect.arrayContaining(["note_post", "article", "public_metrics", "context_annotations", "entities", "conversation_id"]));
		expect(lookup.url.searchParams.get("post.fields")).not.toMatch(/non_public_metrics|organic_metrics|promoted_metrics/);
		expect(lookup.url.searchParams.get("expansions")?.split(",")).toEqual(expect.arrayContaining(["author_id", "referenced_posts", "attachments.media_keys", "attachments.poll_ids", "edit_history_post_ids"]));
		expect(lookup.headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(Object.keys(lookup.headers).sort()).toEqual(["accept", "authorization"]);
		expect(lookup.redirect).toBe("manual");

		expect(result.status).toBe("success");
		expect(result.text).toContain("X post by @jack (jack, 6,500,000 followers, verified blue)");
		expect(result.text).toContain(`https://x.com/jack/status/${POST_ID}`);
		expect(result.text).toContain("2026-10-05 19:00 UTC · language en · 25 replies · 1 repost · 4 quotes · 57 likes · 22 bookmarks · 6,397 impressions");
		expect(result.text).toContain(longText);
		expect(result.text).toContain("Media: photo https://pbs.twimg.com/media/photo.jpg (alt text: A photo)");
		expect(result.text).toContain('Poll (closed): 1. Yes — 795 votes; 2. No — 156 votes');
		expect(result.text).toContain("Link: https://example.com/article — An article");
		expect(result.text).toContain("Context annotations: Brand: Twitter");
		expect(result.text).toContain(`Edit history: 2 versions (2107184000000000000, ${POST_ID})`);
		expect(result.text).toContain("> The first version, before an edit.");
		expect(result.text).toContain("Quoting @X (X, verified business) · 2026-10-05 18:53 UTC");
		expect(result.text).toContain("> The quoted post.");
		expect(result.details?.cost).toBeNull();
		expect(result.details?.knownCost).toBeUndefined();
		expect(kept.map((response) => response.label)).toEqual(["post lookup"]);
	});

	test("posts X reports missing make the call partial, naming each; all missing is empty and never falls back to TikHub", async () => {
		installFetch(() => json({ data: [apiPost], includes, errors: [notFound(OTHER_ID)] }));
		const partial = await executeSource(post, { posts: [POST_ID, `twitter.com/x/status/${OTHER_ID}`] }, context());
		expect(partial.status).toBe("partial");
		expect(partial.text).toContain(`X API: 1 post of 2 requested.\nNot returned: ${OTHER_ID} — Not Found Error: Could not find tweet with id: [${OTHER_ID}].`);
		expect(xCalls()[0].url.searchParams.get("ids")).toBe(`${POST_ID},${OTHER_ID}`);

		calls = [];
		installFetch(() => json({ errors: [notFound(POST_ID)] }));
		const empty = await executeSource(post, { posts: [POST_ID] }, context());
		expect(empty.status).toBe("empty");
		expect(empty.text).toContain(`Not returned: ${POST_ID} — Not Found Error`);
		expect(tikhubCalls()).toHaveLength(0);
		expect(empty.details?.cost).toBeNull();
	});

	test("an X failure while reading several posts fails with X's error and does not fall back", async () => {
		installFetch(() => json({ title: "Service Unavailable", detail: "Try again later." }, 503));
		const result = await executeSource(post, { posts: [POST_ID, OTHER_ID] }, context());
		expect(result.status).toBe("failed");
		expect(result.text.split("\n", 1)[0]).toBe("ERROR: X API post lookup failed with HTTP 503: Service Unavailable: Try again later.");
		expect(tikhubCalls()).toHaveLength(0);
		expect(xCalls()).toHaveLength(1);
	});

	test("one post falls back to TikHub when the token is missing, labelled via TikHub with an unknown cost", async () => {
		delete process.env.X_BEARER_TOKEN;
		installFetch((url) => (url.host === "api.tikhub.io" ? json(tikhubDetail) : json({}, 500)));
		const result = await executeSource(post, { posts: [POST_ID] }, context());
		expect(xCalls()).toHaveLength(0);
		expect(tikhubCalls()).toHaveLength(1);
		const [detail] = tikhubCalls();
		expect(detail.url.pathname).toBe("/api/v1/twitter/web/fetch_tweet_detail");
		expect(detail.url.searchParams.get("tweet_id")).toBe(POST_ID);
		expect(detail.headers.authorization).toBe(`Bearer ${TIKHUB_KEY}`);
		expect(result.status).toBe("success");
		expect(result.text.split("\n", 1)[0]).toBe(`X post ${POST_ID} via TikHub: the X API could not serve it (X_BEARER_TOKEN is not set in Dig's keys.env).`);
		expect(result.text).toContain("X post by @jack (jack, 6,500,000 followers, verified)");
		expect(result.text).toContain("TikHub's copy of the post.");
		expect(kept.map((response) => response.label)).toEqual(["fetch_tweet_detail via TikHub"]);
		expect(result.details).toMatchObject({ provider: "tikhub", via: "TikHub", cost: null });

		const several = await executeSource(post, { posts: [POST_ID, OTHER_ID] }, context());
		expect(several.status).toBe("failed");
		expect(several.text).toContain("X_BEARER_TOKEN is not set");
		expect(tikhubCalls()).toHaveLength(1);
	});

	test("one post falls back to TikHub on X authentication, credit, rate-limit, server and network failures, saying what needs the X API", async () => {
		const failures: Array<[string, () => Response]> = [
			["HTTP 401", () => json({ title: "Unauthorized", detail: "Unauthorized" }, 401)],
			["HTTP 403", () => json({ title: "Client Forbidden", detail: "This app is not enrolled for this endpoint.", type: "https://api.x.com/2/problems/client-forbidden", reason: "client-not-enrolled" }, 403)],
			["HTTP 402", () => json({ title: "Payment Required", detail: "Your enrolled account does not have any credits" }, 402)],
			["HTTP 429", () => json({ title: "Too Many Requests" }, 429, { "x-rate-limit-reset": "1791349200" })],
			["HTTP 500", () => json({ title: "Internal Server Error" }, 500)],
			["could not be reached", () => {
				throw new TypeError("fetch failed");
			}],
		];
		for (const [said, reply] of failures) {
			calls = [];
			kept = [];
			installFetch((url) => (url.host === "api.tikhub.io" ? json(tikhubDetail) : reply()));
			const result = await executeSource(post, { posts: [POST_ID], replies: 5 }, context());
			expect(xCalls()).toHaveLength(1);
			expect(tikhubCalls()).toHaveLength(1);
			expect(result.status).toBe("partial");
			expect(result.text.split("\n", 1)[0]).toContain(`X post ${POST_ID} via TikHub: the X API could not serve it (`);
			expect(result.text.split("\n", 1)[0]).toContain(said);
			expect(result.text).toContain("The thread, replies, quote posts and reposters need the X API; TikHub read only the post.");
			expect(result.details?.cost).toBeNull();
			expect(kept.map((response) => response.label)).toEqual(["post lookup", "fetch_tweet_detail via TikHub"]);
		}
	});

	test("a missing TikHub key or a TikHub failure fails with both reasons", async () => {
		delete process.env.TIKHUB_API_KEY;
		installFetch(() => json({ title: "Unauthorized" }, 401));
		const noKey = await executeSource(post, { posts: [POST_ID] }, context());
		expect(noKey.status).toBe("failed");
		expect(noKey.text).toMatch(/^ERROR: X post \d+ could not be read: X API refused post lookup with X_BEARER_TOKEN \(HTTP 401\): Unauthorized\. The TikHub fallback needs TIKHUB_API_KEY/);

		process.env.TIKHUB_API_KEY = TIKHUB_KEY;
		installFetch((url) => (url.host === "api.tikhub.io" ? json({ detail: { code: 400, message: "Request failed. Please retry." } }, 400) : json({ title: "Unauthorized" }, 401)));
		const both = await executeSource(post, { posts: [POST_ID] }, context());
		expect(both.status).toBe("failed");
		expect(both.text).toContain("or TikHub (TikHub fetch_tweet_detail returned HTTP 400: Request failed. Please retry)");
	});

	test("thread and replies read the conversation through search, the author's posts oldest first and others newest first", async () => {
		const reply = (id: string, authorId: string, text: string) => ({ id, text, author_id: authorId, conversation_id: POST_ID, created_at: "2026-10-05T19:30:00.000Z", public_metrics: { reply_count: 0, repost_count: 0, quote_count: 0, like_count: 2, bookmark_count: 0, impression_count: 40 } });
		const recentPost = { ...apiPost, id: POST_ID, conversation_id: POST_ID, created_at: new Date().toISOString() };
		// A conversation started now, so recent search covers it.
		const now = BigInt(Date.now() - 1288834974657) << 22n;
		const rootId = String(now);
		installFetch((url) => {
			if (url.pathname === "/2/tweets") return json({ data: [{ ...recentPost, id: rootId, conversation_id: rootId }], includes });
			const query = url.searchParams.get("query") ?? "";
			if (query === `conversation_id:${rootId} from:jack`) return json({ data: [reply(`${now + 2n}`, AUTHOR_ID, "Second of the thread"), reply(`${now + 1n}`, AUTHOR_ID, "First of the thread")], includes: { users: [author] } });
			if (query === `conversation_id:${rootId} -from:jack`) return json({ data: [reply(`${now + 5n}`, "9", "A reply")], includes: { users: [{ id: "9", username: "someone", name: "Some One" }] } });
			return json({}, 404);
		});
		const result = await executeSource(post, { posts: [rootId], thread: true, replies: 3 }, context());
		const searches = xCalls().filter((call) => call.url.pathname.startsWith("/2/tweets/search/"));
		expect(searches.map((call) => call.url.pathname)).toEqual(["/2/tweets/search/recent", "/2/tweets/search/recent"]);
		expect(searches.map((call) => call.url.searchParams.get("max_results"))).toEqual(["100", "10"]);
		expect(result.status).toBe("success");
		expect(result.text.indexOf("First of the thread")).toBeLessThan(result.text.indexOf("Second of the thread"));
		expect(result.text).toContain("Replies: 1 post from conversation");
		expect(result.text).toContain("- @someone (Some One) · 2026-10-05 19:30 UTC · 2 likes · 40 impressions");
	});
});

describe("x_search_posts", () => {
	const page = (start: number, size: number) => Array.from({ length: size }, (_, i) => ({ id: String(1_000_000 + start + i), text: `post ${start + i}`, author_id: AUTHOR_ID }));

	test("pages with next_token up to limit, each page retained, and says X has more", async () => {
		installFetch((url) => {
			const token = url.searchParams.get("next_token");
			return json({ data: page(token === "p2" ? 10 : token === "p3" ? 20 : 0, 10), includes: { users: [author] }, meta: { result_count: 10, next_token: token === "p3" ? "p4" : token === "p2" ? "p3" : "p2" } });
		});
		const result = await executeSource(search_posts, { query: "from:jack -is:retweet", limit: 25 }, context());
		expect(xCalls().map((call) => call.url.pathname)).toEqual(Array(3).fill("/2/tweets/search/recent"));
		expect(xCalls().map((call) => [call.url.searchParams.get("max_results"), call.url.searchParams.get("next_token")])).toEqual([["25", null], ["15", "p2"], ["10", "p3"]]);
		expect(xCalls()[0].url.searchParams.get("query")).toBe("from:jack -is:retweet");
		expect(xCalls()[0].url.searchParams.get("sort_order")).toBe("recency");
		expect(kept.map((response) => response.label)).toEqual(["recent search", "recent search, page 2", "recent search, page 3"]);
		expect(result.status).toBe("success");
		expect(result.text).toContain("25 posts over 3 pages; X has more beyond limit 25.");
		expect(result.text).toContain("post 24");
		expect(result.text).not.toContain("post 25");
		expect(result.details?.cost).toBeNull();
	});

	test("a later page that fails keeps the earlier posts as partial; no matches is empty", async () => {
		installFetch((url) => (url.searchParams.get("next_token") ? json({ title: "Internal Server Error" }, 500) : json({ data: page(0, 10), meta: { next_token: "p2" } })));
		const partial = await executeSource(search_posts, { query: "dig", limit: 50 }, context());
		expect(partial.status).toBe("partial");
		expect(partial.text).toContain("10 posts over 2 pages");
		expect(partial.text).toContain("Page 2 failed or reported a problem, so later matches may be missing: X API recent search, page 2 failed with HTTP 500: Internal Server Error");

		installFetch(() => json({ meta: { result_count: 0 } }));
		const empty = await executeSource(search_posts, { query: "nothing matches" }, context());
		expect(empty.status).toBe("empty");
	});

	test("a rate limit reports X's reset time and is not retried", async () => {
		installFetch(() => json({ title: "Too Many Requests", detail: "Too Many Requests" }, 429, { "x-rate-limit-reset": "1791349200" }));
		const result = await executeSource(search_posts, { query: "dig" }, context());
		expect(xCalls()).toHaveLength(1);
		expect(result.status).toBe("failed");
		expect(result.text.split("\n", 1)[0]).toBe("ERROR: X API rate limit reached (HTTP 429) for recent search: Too Many Requests. The limit resets at 2026-10-07T05:00:00.000Z (x-rate-limit-reset). Dig does not wait or retry.");
	});

	test("full-archive pages go to search/all at most one a second", async () => {
		installFetch((url) => json({ data: page(url.searchParams.get("next_token") ? 10 : 0, 10), meta: url.searchParams.get("next_token") ? {} : { next_token: "p2" } }));
		const result = await executeSource(search_posts, { query: "dig", archive: true, limit: 20 }, context());
		expect(xCalls().map((call) => call.url.pathname)).toEqual(["/2/tweets/search/all", "/2/tweets/search/all"]);
		expect(xCalls()[1].at - xCalls()[0].at).toBeGreaterThanOrEqual(1000);
		expect(result.status).toBe("success");
	});

	test("the Bearer Token is required, and a token echoed by X is redacted from the result", async () => {
		delete process.env.X_BEARER_TOKEN;
		const missing = await executeSource(search_posts, { query: "dig" }, context());
		expect(missing.status).toBe("failed");
		expect(missing.text).toContain("X_BEARER_TOKEN is not set in Dig's keys.env");
		expect(calls).toHaveLength(0);

		process.env.X_BEARER_TOKEN = TOKEN;
		installFetch(() => json({ data: [{ id: "1", text: `echo ${TOKEN}`, author_id: AUTHOR_ID }] }));
		const echoed = await executeSource(search_posts, { query: "dig" }, context());
		expect(echoed.text).toContain("echo [redacted]");
		expect(JSON.stringify(echoed)).not.toContain(TOKEN);
	});
});

test("x_count_posts returns each bucket and X's total, per day by default", async () => {
	installFetch(() => json({ data: [{ start: "2026-10-01T00:00:00.000Z", end: "2026-10-02T00:00:00.000Z", post_count: 120 }, { start: "2026-10-02T00:00:00.000Z", end: "2026-10-03T00:00:00.000Z", post_count: 30 }], meta: { total_post_count: 150 } }));
	const result = await executeSource(count_posts, { query: "dig lang:en" }, context());
	expect(xCalls()[0].url.pathname).toBe("/2/tweets/counts/recent");
	expect(xCalls()[0].url.searchParams.get("granularity")).toBe("day");
	expect(result.status).toBe("success");
	expect(result.text).toContain('X post counts for "dig lang:en" (last 7 days, per day): 150 posts in 2 buckets.');
	expect(result.text).toContain("2026-10-01: 120\n2026-10-02: 30");
	expect(result.details).toMatchObject({ total: 150, cost: null });
});

test("x_users looks handles up, names the ones X reports missing, and reads each account's recent posts", async () => {
	installFetch((url) => {
		if (url.pathname === "/2/users/by") return json({ data: [{ ...author, description: "Bio text", location: "Earth", created_at: "2006-03-21T20:50:14.000Z", pinned_post_id: POST_ID }], errors: [{ value: "ghost_account", parameter: "usernames", resource_type: "user", title: "Not Found Error", detail: "Could not find user with usernames: [ghost_account]." }] });
		if (url.pathname === `/2/users/${AUTHOR_ID}/tweets`) return json({ data: [{ id: "77", text: "A recent post", author_id: AUTHOR_ID }], includes: { users: [author] } });
		return json({}, 404);
	});
	const result = await executeSource(users, { handles: ["@jack", "ghost_account"], posts: 3 }, context());
	expect(xCalls()[0].url.searchParams.get("usernames")).toBe("jack,ghost_account");
	expect(xCalls()[0].url.searchParams.get("user.fields")?.split(",")).toEqual(expect.arrayContaining(["description", "location", "public_metrics", "verified", "created_at"]));
	expect(xCalls()[1].url.searchParams.get("max_results")).toBe("5");
	expect(result.status).toBe("partial");
	expect(result.text).toContain("Not returned: @ghost_account — Not Found Error: Could not find user with usernames: [ghost_account].");
	expect(result.text).toContain("@jack — jack (verified blue)");
	expect(result.text).toContain("Bio: Bio text");
	expect(result.text).toContain("Location: Earth · Joined 2006-03-21");
	expect(result.text).toContain("6,500,000 followers · 4,000 following · 29,000 posts · 30,000 lists");
	expect(result.text).toContain("A recent post");
	expect(result.details?.cost).toBeNull();
});

test("x_news and x_explore refuse arguments that do not fit before any request, and explore reads trends by WOEID", async () => {
	expect((await executeSource(news, { query: "AI", id: "1989418137272422538" }, context())).text).toBe("ERROR: Pass either query or id, not both.");
	expect((await executeSource(explore, { kind: "trends", query: "AI" }, context())).text).toBe('ERROR: kind "trends" takes woeid, limit; query belongs to another kind.');
	expect((await executeSource(explore, { kind: "communities", state: "live", query: "AI" }, context())).text).toBe('ERROR: kind "communities" takes query, limit; state belongs to another kind.');
	expect(calls).toHaveLength(0);

	installFetch(() => json({ data: [{ trend_name: "#Dig", tweet_count: 12_345 }, { trend_name: "Spaces" }] }));
	const trends = await executeSource(explore, { kind: "trends" }, context());
	expect(xCalls()[0].url.pathname).toBe("/2/trends/by/woeid/1");
	expect(xCalls()[0].url.searchParams.get("max_trends")).toBe("20");
	expect(trends.text).toBe("X trends worldwide (WOEID 1): 2 trends.\n\n1. #Dig — 12,345 posts\n2. Spaces");
	expect(trends.details?.cost).toBeNull();
});

test("x_news reads a story's summary, contexts and clustered posts", async () => {
	installFetch(() => json({ data: { id: "1989418137272422538", name: "Nebius stock plunges", summary: "Shares fell.", hook: "A hook.", category: "News", contexts: { entities: { organizations: ["Nebius Group N.V."], people: [] }, topics: ["Stocks"], finance: { tickers: ["NBIS"] } }, cluster_posts_results: [{ post_id: "1989409257394245835" }] } }));
	const result = await executeSource(news, { id: "1989418137272422538" }, context());
	expect(xCalls()[0].url.pathname).toBe("/2/news/1989418137272422538");
	expect(result.status).toBe("success");
	expect(result.text).toContain("X News story: Nebius stock plunges");
	expect(result.text).toContain("Context entities.organizations: Nebius Group N.V.");
	expect(result.text).toContain("Context finance.tickers: NBIS");
	expect(result.text).toContain("- https://x.com/i/status/1989409257394245835");
});

// Cold-review regressions (0.2.25).
const internalError = { type: "https://api.x.com/2/problems/internal-error", title: "Internal Server Error", detail: "An internal error has occurred.", status: 500 };
const internalNote = "reported Internal Server Error: An internal error has occurred.";

describe("problems X reports inside a 2xx response", () => {
	test("a search whose first page carries only a problem fails instead of reporting no matches", async () => {
		installFetch(() => json({ errors: [internalError] }));
		const result = await executeSource(search_posts, { query: "dig" }, context());
		expect(result.status).toBe("failed");
		expect(result.text.split("\n", 1)[0]).toBe(`ERROR: X API recent search ${internalNote}, and returned no data`);
	});

	test("a later search page carrying a problem keeps the earlier posts as partial and is never taken for the last page", async () => {
		installFetch((url) => (url.searchParams.get("next_token") ? json({ errors: [internalError] }) : json({ data: [{ id: "1", text: "first page", author_id: AUTHOR_ID }], meta: { next_token: "p2" } })));
		const result = await executeSource(search_posts, { query: "dig", limit: 50 }, context());
		expect(result.status).toBe("partial");
		expect(result.text).toContain(`Page 2 failed or reported a problem, so later matches may be missing: X API recent search, page 2 ${internalNote}, and returned no data`);
		expect(result.details).toMatchObject({ more: true });
	});

	test("counts carrying only a problem fail, and buckets beside a problem are partial", async () => {
		installFetch(() => json({ errors: [internalError] }));
		const failedCount = await executeSource(count_posts, { query: "dig" }, context());
		expect(failedCount.status).toBe("failed");
		expect(failedCount.text.split("\n", 1)[0]).toBe(`ERROR: X API post counts ${internalNote}, and returned no data`);

		installFetch(() => json({ data: [{ start: "2026-10-01T00:00:00.000Z", end: "2026-10-02T00:00:00.000Z", post_count: 120 }], errors: [internalError], meta: { total_post_count: 120 } }));
		const partialCount = await executeSource(count_posts, { query: "dig" }, context());
		expect(partialCount.status).toBe("partial");
		expect(partialCount.text).toContain(`X API post counts ${internalNote}`);
	});

	test("a requested quote read carrying only a problem is a failed read naming it, not zero quote posts", async () => {
		installFetch((url) => (url.pathname.endsWith("/quote_tweets") ? json({ errors: [internalError] }) : json({ data: [apiPost], includes })));
		const result = await executeSource(post, { posts: [POST_ID], quotes: 5 }, context());
		expect(result.status).toBe("partial");
		expect(result.text).toContain(`Not read: X API quote posts of ${POST_ID} ${internalNote}, and returned no data`);
	});

	test("data beside a problem is kept and the call is partial, while a missing referenced post is not a problem with the request", async () => {
		installFetch(() => json({ data: [{ id: "1zqKVXPQhvZJB", title: "AI talk", state: "live" }], errors: [internalError] }));
		const spaces = await executeSource(explore, { kind: "spaces", query: "ai" }, context());
		expect(spaces.status).toBe("partial");
		expect(spaces.text).toContain(`Partial: X API Spaces search ${internalNote}`);
		expect(spaces.text).toContain("- AI talk · live");

		installFetch(() => json({ data: [{ id: "1", text: "quotes a deleted post", author_id: AUTHOR_ID }], errors: [{ ...notFound("999"), parameter: "referenced_posts.id" }] }));
		const search = await executeSource(search_posts, { query: "dig" }, context());
		expect(search.status).toBe("success");
	});
});

test("an HTTP 403 saying the requested post is protected is reported, never read through TikHub", async () => {
	installFetch((url) => (url.host === "api.tikhub.io" ? json(tikhubDetail) : json({ type: "https://api.x.com/2/problems/not-authorized-for-resource", title: "Authorization Error", detail: "Sorry, you are not authorized to see this protected post.", resource_type: "tweet", resource_id: POST_ID }, 403)));
	const result = await executeSource(post, { posts: [POST_ID] }, context());
	expect(tikhubCalls()).toHaveLength(0);
	expect(result.status).toBe("empty");
	expect(result.text).toBe(`X API: 0 posts of 1 requested.\nNot returned: ${POST_ID} — Authorization Error: Sorry, you are not authorized to see this protected post.`);
	expect(result.details?.cost).toBeNull();
});

describe("full-archive time window and pacing", () => {
	const OLD_ROOT = "1212092628029698048"; // 2019-12-31T19:26:16.771Z
	const PRE_SNOWFLAKE = "20"; // 2006, before snowflake ids
	const archiveSearches = () => xCalls().filter((call) => call.url.pathname === "/2/tweets/search/all");

	test("an old conversation's thread and replies are searched from its root post, and a pre-snowflake one from the archive's start", async () => {
		installFetch((url) => (url.pathname === "/2/tweets" ? json({ data: [{ ...apiPost, id: url.searchParams.get("ids"), conversation_id: url.searchParams.get("ids") }], includes }) : json({ meta: { result_count: 0 } })));
		await executeSource(post, { posts: [OLD_ROOT], thread: true, replies: 10 }, context());
		expect(archiveSearches().map((call) => call.url.searchParams.get("start_time"))).toEqual(["2019-12-31T19:26:16Z", "2019-12-31T19:26:16Z"]);

		calls = [];
		const pre = await executeSource(post, { posts: [PRE_SNOWFLAKE], thread: true }, context());
		expect(archiveSearches().map((call) => call.url.searchParams.get("start_time"))).toEqual(["2006-03-21T00:00:00Z"]);
		expect(pre.text).toContain("full-archive search from 2006-03-21T00:00:00Z");
	});

	test("archive searches and counts without a start time reach back to 2006; a given start time and recent search are left as asked", async () => {
		installFetch(() => json({ meta: { result_count: 0 } }));
		await executeSource(search_posts, { query: "dig", archive: true }, context());
		await executeSource(search_posts, { query: "dig", archive: true, start_time: "2020-01-01T00:00:00Z" }, context());
		await executeSource(search_posts, { query: "dig" }, context());
		await executeSource(count_posts, { query: "dig", archive: true }, context());
		expect(xCalls().map((call) => [call.url.pathname, call.url.searchParams.get("start_time")])).toEqual([
			["/2/tweets/search/all", "2006-03-21T00:00:00Z"],
			["/2/tweets/search/all", "2020-01-01T00:00:00Z"],
			["/2/tweets/search/recent", null],
			["/2/tweets/counts/all", "2006-03-21T00:00:00Z"],
		]);
	});

	test("consecutive calls share one full-archive pacing gate", async () => {
		installFetch(() => json({ meta: { result_count: 0 } }));
		await executeSource(search_posts, { query: "first", archive: true }, context());
		await executeSource(search_posts, { query: "second", archive: true }, context());
		const [first, second] = archiveSearches();
		expect(second.at - first.at).toBeGreaterThanOrEqual(1000);
	});
});

describe("where a reading stopped", () => {
	test("a thread the page safety limit stops says how many posts it read, names the limit and makes the call partial", async () => {
		const now = BigInt(Date.now() - 1288834974657) << 22n;
		const rootId = String(now);
		installFetch((url) => (url.pathname === "/2/tweets"
			? json({ data: [{ ...apiPost, id: rootId, conversation_id: rootId }], includes })
			: json({ data: [{ id: String(now + 1n), text: "more of the thread", author_id: AUTHOR_ID }], includes: { users: [author] }, meta: { next_token: "more" } })));
		const result = await executeSource(post, { posts: [rootId], thread: true }, context());
		expect(xCalls().filter((call) => call.url.pathname === "/2/tweets/search/recent")).toHaveLength(50);
		expect(result.status).toBe("partial");
		expect(result.text).toContain("Thread: 1 post by @jack");
		expect(result.text).toContain(`Coverage incomplete: X has more of this thread than the 1 post read here; read on with x_search_posts with query "conversation_id:${rootId} from:jack", end_time `);
		expect(result.text).toContain(`Not read: the rest of the thread of ${rootId}: the search stopped at its 50-page safety limit after 1 post`);
		expect(result.text).not.toContain("100 posts read here");
	});

	test("following a thread's printed continuation reads posts the thread read did not", async () => {
		// 150 posts by the author, two to a second, oldest first; the first is the conversation's root.
		const base = Date.now() - 60 * 60 * 1000;
		const convo = Array.from({ length: 150 }, (_, i) => {
			const ms = base + i * 500;
			return { id: String((BigInt(ms - 1288834974657) << 22n) + BigInt(i)), text: `thread post ${i}`, author_id: AUTHOR_ID, created_at: new Date(ms).toISOString() };
		});
		const rootId = convo[0].id;
		installFetch((url) => {
			if (url.pathname === "/2/tweets") return json({ data: [{ ...apiPost, ...convo[0], conversation_id: rootId }], includes });
			// Search as X runs it: end_time exclusive, start_time inclusive, newest first, paged.
			const end = url.searchParams.get("end_time");
			const start = url.searchParams.get("start_time");
			const matches = convo.filter((item) => (!end || Date.parse(item.created_at) < Date.parse(end)) && (!start || Date.parse(item.created_at) >= Date.parse(start))).reverse();
			const offset = Number(url.searchParams.get("next_token") ?? 0);
			const size = Number(url.searchParams.get("max_results"));
			return json({ data: matches.slice(offset, offset + size), includes: { users: [author] }, meta: offset + size < matches.length ? { next_token: String(offset + size) } : {} });
		});
		const first = await executeSource(post, { posts: [rootId], thread: true }, context());
		const said = first.text.match(/(?:read on|read the rest) with x_search_posts with (.+?)(?:; it may repeat|\.$)/m)?.[1] ?? "";
		const args: Record<string, unknown> = { query: said.match(/query "([^"]+)"/)?.[1] };
		for (const [, name, value] of said.matchAll(/(archive|start_time|end_time|limit) (\S+?)(?=,| and |$)/g)) args[name] = name === "limit" ? Number(value) : name === "archive" ? value === "true" : value;
		const next = await executeSource(search_posts, args, context());
		const unread = convo.filter((item) => !first.text.includes(`/status/${item.id}`) && next.text.includes(`/status/${item.id}`));
		expect(unread.length).toBeGreaterThan(0);
		expect(first.text).toContain("it may repeat posts from");
	});

	test("the page safety limit is told apart from reaching the requested limit", async () => {
		let n = 0;
		installFetch(() => json({ data: [{ id: String(5_000_000 + ++n), text: `sparse ${n}`, author_id: AUTHOR_ID }], meta: { next_token: `p${n}` } }));
		const result = await executeSource(search_posts, { query: "sparse", limit: 500 }, context());
		expect(xCalls()).toHaveLength(50);
		expect(result.status).toBe("partial");
		expect(result.text).toContain("Stopped at the 50-page safety limit with 50 of the 500 posts asked for; X has more.");
		expect(result.text).not.toContain("X has more beyond limit");
	});
});

describe("TikHub fallback reads", () => {
	test("a TikHub redirect is reported as a failed fallback, with no request to its target", async () => {
		delete process.env.X_BEARER_TOKEN;
		const paths: string[] = [];
		const fixture = createServer((request, response) => {
			paths.push(request.url ?? "");
			if (request.url?.startsWith("/api/v1/twitter/web/fetch_tweet_detail")) response.writeHead(302, { location: "/redirected" }).end();
			else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(tikhubDetail));
		});
		await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
		process.env.TIKHUB_BASE_URL = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
		globalThis.fetch = originalFetch;
		try {
			const result = await executeSource(post, { posts: [POST_ID] }, context());
			expect(paths).toEqual([`/api/v1/twitter/web/fetch_tweet_detail?tweet_id=${POST_ID}`]);
			expect(result.status).toBe("failed");
			expect(result.text).toContain("TikHub fetch_tweet_detail answered HTTP 302 with a redirect to /redirected; Dig does not follow redirects");
			expect(kept.map((response) => [response.label, response.status])).toEqual([["fetch_tweet_detail via TikHub", 302]]);
		} finally {
			await new Promise((resolve) => fixture.close(resolve));
		}
	});

	test("only TikHub's own copy of the requested post, with text or media, counts as reading it", async () => {
		delete process.env.X_BEARER_TOKEN;
		for (const data of [{}, { ...tikhubDetail.data, id: OTHER_ID }, { ...tikhubDetail.data, text: "" }]) {
			installFetch(() => json({ code: 200, data }));
			const result = await executeSource(post, { posts: [POST_ID] }, context());
			expect(result.status).toBe("failed");
			expect(result.text).toContain("TikHub fetch_tweet_detail did not return that post with its text or media");
		}
	});
});

// Cold-review round 2: resource problems are classified, not dropped.
const protectedPost = (resourceId?: string) => ({ type: "https://api.x.com/2/problems/not-authorized-for-resource", title: "Authorization Error", detail: "Sorry, you are not authorized to see this protected post.", resource_type: "tweet", ...(resourceId ? { resource_id: resourceId } : {}) });
const protectedNote = "Authorization Error: Sorry, you are not authorized to see this protected post.";
const clientForbidden = { type: "https://api.x.com/2/problems/client-forbidden", title: "Client Forbidden", detail: "This app is not enrolled for this endpoint.", reason: "client-not-enrolled" };
const suspendedAuthor = { type: "https://api.x.com/2/problems/resource-unavailable", title: "Forbidden", detail: `User has been suspended: [${AUTHOR_ID}].`, resource_type: "user", resource_id: AUTHOR_ID };

describe("a post X names missing, protected or suspended is never read through TikHub", () => {
	const lookup = (respond: () => Response) => installFetch((url) => (url.host === "api.tikhub.io" ? json(tikhubDetail) : respond()));

	test("a protected-post answer beside an internal error in a 200 is that post's answer", async () => {
		lookup(() => json({ errors: [protectedPost(POST_ID), internalError] }));
		const result = await executeSource(post, { posts: [POST_ID] }, context());
		expect(tikhubCalls()).toHaveLength(0);
		expect(result.status).toBe("empty");
		expect(result.text).toBe(`X API: 0 posts of 1 requested.\nNot returned: ${POST_ID} — ${protectedNote}\nX also reported: Internal Server Error: An internal error has occurred.`);
	});

	test("a 403 naming the protected post beside client-forbidden is that post's answer", async () => {
		lookup(() => json({ errors: [protectedPost(POST_ID), clientForbidden] }, 403));
		const result = await executeSource(post, { posts: [POST_ID] }, context());
		expect(tikhubCalls()).toHaveLength(0);
		expect(result.status).toBe("empty");
		expect(result.text).toBe(`X API: 0 posts of 1 requested.\nNot returned: ${POST_ID} — ${protectedNote}\nX also reported: Client Forbidden: This app is not enrolled for this endpoint.`);
	});

	const refusedUnnamed = async (problem: Record<string, unknown>, said: string) => {
		lookup(() => json(problem, 403));
		const result = await executeSource(post, { posts: [POST_ID] }, context());
		expect(tikhubCalls()).toHaveLength(0);
		expect(result.status).toBe("failed");
		expect(result.text).toBe(`ERROR: X API refused post lookup with X_BEARER_TOKEN (HTTP 403): ${said}\nX refused or withheld the post (${said}), so it was not read elsewhere.\nNot returned: ${POST_ID} — X returned neither it nor an error naming it`);
	};

	test("a 403 protected-post problem without a resource id fails and is not read elsewhere", async () => {
		await refusedUnnamed(protectedPost(), protectedNote);
	});

	test("a 403 naming the post's suspended author fails and is not read elsewhere", async () => {
		await refusedUnnamed(suspendedAuthor, `Forbidden: User has been suspended: [${AUTHOR_ID}].`);
	});

	test("two posts with only one named fail instead of reading as empty", async () => {
		lookup(() => json(protectedPost(POST_ID), 403));
		const result = await executeSource(post, { posts: [POST_ID, OTHER_ID] }, context());
		expect(tikhubCalls()).toHaveLength(0);
		expect(result.status).toBe("failed");
		expect(result.text).toContain(`Not returned: ${POST_ID} — ${protectedNote}\nNot returned: ${OTHER_ID} — X returned neither it nor an error naming it`);
	});

	test("an untyped problem saying 500 is an operational failure even when it names the post", async () => {
		lookup(() => json({ errors: [{ resource_type: "tweet", resource_id: POST_ID, status: 500, title: "Internal Server Error", detail: "An internal error has occurred." }] }));
		const result = await executeSource(post, { posts: [POST_ID] }, context());
		expect(result.status).toBe("success");
		expect(tikhubCalls()).toHaveLength(1);
		expect(result.text.split("\n", 1)[0]).toBe(`X post ${POST_ID} via TikHub: the X API could not serve it (X API post lookup ${internalNote}, and returned no data).`);
	});
});

test("a quote read or search page X refuses with no data is a failed read, never zero results", async () => {
	installFetch((url) => (url.pathname.endsWith("/quote_tweets") ? json({ errors: [protectedPost(POST_ID)] }) : json({ data: [apiPost], includes })));
	const quotes = await executeSource(post, { posts: [POST_ID], quotes: 5 }, context());
	expect(quotes.status).toBe("partial");
	expect(quotes.text).toContain(`Not read: X API quote posts of ${POST_ID} reported ${protectedNote}, and returned no data`);

	installFetch(() => json({ errors: [protectedPost("123")] }));
	const search = await executeSource(search_posts, { query: "conversation_id:123" }, context());
	expect(search.status).toBe("failed");
	expect(search.text.split("\n", 1)[0]).toBe(`ERROR: X API recent search reported ${protectedNote}, and returned no data`);
});

test("x_users takes a 404 naming the requested handle as that account's answer", async () => {
	installFetch(() => json({ errors: [{ type: "https://api.x.com/2/problems/resource-not-found", title: "Not Found Error", detail: "Could not find user with username: [ghost_account].", resource_type: "user", parameter: "username", value: "ghost_account" }] }, 404));
	const result = await executeSource(users, { handles: ["ghost_account"] }, context());
	expect(result.status).toBe("empty");
	expect(result.text).toBe("X API: 0 accounts of 1 requested.\nNot returned: @ghost_account — Not Found Error: Could not find user with username: [ghost_account].");
});

// Shapes X sent live on 2026-10-06 to an app-only token: reposts typed `reposted`, account lookups refusing three
// user fields, and a pinned post X could not find beside the account.
describe("live X API shapes", () => {
	const ORIGINAL_ID = "2107518458703605844";
	const developers = { id: "2244994945", username: "XDevelopers", name: "Developers", verified: true, verified_type: "business" };
	const originalText = `${"The X API serves posts, accounts, search and counts on pay-per-use credits. ".repeat(4)}Read the docs.`;
	const original = { id: ORIGINAL_ID, text: `${originalText.slice(0, 270)}…`, note_post: { text: originalText }, author_id: developers.id, created_at: "2026-10-06T18:00:00.000Z" };
	const repost = { id: "2107600000000000000", text: `RT @XDevelopers: ${originalText.slice(0, 120)}…`, author_id: AUTHOR_ID, created_at: "2026-10-06T20:00:00.000Z", referenced_posts: [{ id: ORIGINAL_ID, type: "reposted" }] };

	test("a repost X sends as `reposted` reads as a repost with the original's full text, in a list and on its own", async () => {
		installFetch(() => json({ data: [repost], includes: { users: [author, developers], posts: [original] } }));
		const listed = await executeSource(search_posts, { query: "from:jack" }, context());
		expect(listed.text).toContain(`  Reposting @XDevelopers: https://x.com/XDevelopers/status/${ORIGINAL_ID}\n  > ${originalText}`);
		expect(listed.text).not.toContain("Replying to");
		const read = await executeSource(post, { posts: [repost.id] }, context());
		expect(read.text).toContain(`Reposting @XDevelopers (Developers, verified business) · 2026-10-06 18:00 UTC\nhttps://x.com/XDevelopers/status/${ORIGINAL_ID}\n> ${originalText}`);
		expect(read.text).not.toContain("Replying to");
	});

	test("account and post reads no longer ask for the user fields X refuses an app-only token", async () => {
		installFetch((url) => json(url.pathname === "/2/users/by" ? { data: [developers] } : { data: [apiPost], includes }));
		const accounts = await executeSource(users, { handles: ["XDevelopers"] }, context());
		await executeSource(post, { posts: [POST_ID] }, context());
		for (const call of xCalls()) {
			const fields = call.url.searchParams.get("user.fields")?.split(",") ?? [];
			for (const refused of ["parody", "subscriber_count", "verified_followers_count"]) expect(fields).not.toContain(refused);
		}
		expect(accounts.status).toBe("success");
	});

	test("a pinned post X cannot find beside the account is an expansion problem, and the lookup stays success", async () => {
		const pinned = "1990000000000000000";
		installFetch(() => json({ data: [{ ...developers, pinned_post_id: pinned }], errors: [{ type: "https://api.x.com/2/problems/resource-not-found", title: "Not Found Error", detail: `Could not find post with pinned_post_id: [${pinned}].`, resource_type: "post", resource_id: pinned, value: pinned, parameter: "pinned_post_id", section: "includes" }] }));
		const result = await executeSource(users, { handles: ["XDevelopers"] }, context());
		expect(result.status).toBe("success");
		expect(result.text).toContain(`Pinned post: https://x.com/XDevelopers/status/${pinned}`);
	});
});

// 0.2.26: X as you. Fixtures are synthetic, shaped like X's and TikHub's live responses of 2026-10-06 (bookmarks and
// likes in X's tweet spelling, folders as id and name, a folder's posts as ids only, TikHub's community envelopes).
let signIns = 0;
/** Sets the four sign-in keys, with an access token of its own so the signed-in account is looked up afresh. */
function signIn() {
	signIns += 1;
	const keys = { X_CONSUMER_KEY: "consumer-key-fixture", X_CONSUMER_SECRET: "consumer-secret fixture&more", X_ACCESS_TOKEN: `1500-access-token-fixture-${signIns}`, X_ACCESS_TOKEN_SECRET: "access-token-secret-fixture" };
	Object.assign(process.env, keys);
	return keys;
}
/** Whether a request carries a valid OAuth 1.0a signature, by these keys, over the URL it was actually sent to. */
function signedBy(call: Call, keys: ReturnType<typeof signIn>): boolean {
	const header = call.headers.authorization ?? "";
	if (!header.startsWith("OAuth ")) return false;
	const { oauth_signature: signature, ...oauth } = Object.fromEntries([...header.slice(6).matchAll(/(\w+)="([^"]*)"/g)].map(([, name, value]) => [name, decodeURIComponent(value)]));
	const expected = createHmac("sha1", `${percent(keys.X_CONSUMER_SECRET)}&${percent(keys.X_ACCESS_TOKEN_SECRET)}`).update(signatureBase("GET", call.url, oauth)).digest("base64");
	return signature === expected && oauth.oauth_consumer_key === keys.X_CONSUMER_KEY && oauth.oauth_token === keys.X_ACCESS_TOKEN;
}
const ME = { id: "1500000000000000001", username: "dig_tester", name: "Dig Tester" };
const maker = { id: "1600000000000000001", username: "maker_one", name: "Maker One", verified_type: "none" };
const other = { id: "1600000000000000002", username: "another_person", name: "Another Person", verified_type: "none" };
const tweet = (id: string, text: string, by = maker, extra: Record<string, unknown> = {}) => ({ id, text, author_id: by.id, created_at: "2026-10-01T12:00:00.000Z", edit_history_tweet_ids: [id], public_metrics: { retweet_count: 3, reply_count: 1, like_count: 20, quote_count: 0, bookmark_count: 5, impression_count: 900 }, ...extra });
const path = (call: Call) => call.url.pathname;

describe("X sign-in", () => {
	test("people search is signed as the user with a valid OAuth 1.0a signature over the URL sent, and carries no Bearer Token", async () => {
		const keys = signIn();
		installFetch(() => json({ data: [{ ...maker, description: "Makes shovels" }] }));
		const result = await executeSource(users, { query: "maker one" }, context());
		const [search] = xCalls();
		expect(path(search)).toBe("/2/users/search");
		expect(search.url.search).toContain("query=maker%20one");
		expect(search.url.search).not.toContain("+");
		expect(signedBy(search, keys)).toBe(true);
		expect(search.headers.authorization).not.toContain(TOKEN);
		expect(result.status).toBe("success");
		expect(result.text).toContain("@maker_one — Maker One");
		expect(result.details?.cost).toBeNull();
	});

	test("a read that needs sign-in fails before any request, naming the sign-in keys that are missing", async () => {
		const people = await executeSource(users, { query: "maker one" }, context());
		expect(people.status).toBe("failed");
		expect(people.text).toMatch(/^ERROR: People search needs X sign-in, and X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET are not set in Dig's keys\.env\./);
		process.env.X_CONSUMER_KEY = "consumer-key-fixture";
		process.env.X_CONSUMER_SECRET = "consumer-secret-fixture";
		const saved = await executeSource(bookmarks, {}, context());
		expect(saved.text).toMatch(/^ERROR: Reading bookmarks needs X sign-in, and X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET are not set/);
		const liked = await executeSource(likes, {}, context());
		expect(liked.text).toMatch(/^ERROR: Reading liked posts needs X sign-in, and X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET are not set/);
		expect(calls).toHaveLength(0);
	});

	test("bookmarks page as the signed-in account, which X names once per access token", async () => {
		const keys = signIn();
		installFetch((url) => {
			if (url.pathname === "/2/users/me") return json({ data: ME });
			const next = url.searchParams.get("pagination_token");
			return json(next ? { data: [tweet("1610000000000000003", "Third bookmark")], includes: { users: [maker] }, meta: { result_count: 1 } } : { data: [tweet("1610000000000000001", "First bookmark"), tweet("1610000000000000002", "Second bookmark")], includes: { users: [maker] }, meta: { result_count: 2, next_token: "pg2" } });
		});
		const result = await executeSource(bookmarks, { limit: 10 }, context());
		expect(xCalls().map(path)).toEqual(["/2/users/me", `/2/users/${ME.id}/bookmarks`, `/2/users/${ME.id}/bookmarks`]);
		expect(xCalls().every((call) => signedBy(call, keys))).toBe(true);
		expect(xCalls().slice(1).map((call) => [call.url.searchParams.get("max_results"), call.url.searchParams.get("pagination_token")])).toEqual([["10", null], ["8", "pg2"]]);
		expect(kept.map((response) => response.label)).toEqual(["signed-in account", "bookmarks", "bookmarks, page 2"]);
		expect(result.status).toBe("success");
		expect(result.text.split("\n", 1)[0]).toBe("X bookmarks of @dig_tester: 3 posts read.");
		expect(result.text.indexOf("First bookmark")).toBeLessThan(result.text.indexOf("Third bookmark"));
		expect(result.details?.cost).toBeNull();

		calls = [];
		const again = await executeSource(bookmarks, { limit: 1 }, context());
		expect(xCalls().map(path)).toEqual([`/2/users/${ME.id}/bookmarks`]);
		expect(again.text.split("\n", 1)[0]).toBe("X bookmarks of @dig_tester: 1 post read; X has more.");
	});

	test("match keeps posts with every word in their text, author, links or the post they quote, and says how many matched", async () => {
		signIn();
		const quoted = tweet("1620000000000000009", "A shovel and a spade", other);
		installFetch((url) => (url.pathname === "/2/users/me"
			? json({ data: ME })
			: json({
				data: [
					tweet("1620000000000000001", "Notes on digging"),
					tweet("1620000000000000002", "Worth a read https://t.co/abc", maker, { entities: { urls: [{ url: "https://t.co/abc", expanded_url: "https://example.com/shovel-guide", display_url: "example.com/shovel-guide" }] } }),
					tweet("1620000000000000003", "Look at this", other, { referenced_tweets: [{ type: "quoted", id: quoted.id }] }),
					tweet("1620000000000000004", "Nothing to see", other, { note_tweet: { text: "Nothing to see, at length, about Shovels" } }),
					tweet("1620000000000000005", "Unrelated", other),
				],
				includes: { users: [maker, other], tweets: [quoted] },
			})));
		const shovel = await executeSource(bookmarks, { match: "shovel" }, context());
		expect(shovel.status).toBe("success");
		expect(shovel.text.split("\n", 1)[0]).toBe('X bookmarks of @dig_tester: 5 posts read, 3 posts matching "shovel".');
		expect(["1620000000000000002", "1620000000000000003", "1620000000000000004"].every((id) => shovel.text.includes(`/status/${id}`))).toBe(true);
		expect(shovel.text).not.toContain("/status/1620000000000000005");

		const byMaker = await executeSource(bookmarks, { match: "DIGGING maker_one" }, context());
		expect(byMaker.text.split("\n", 1)[0]).toBe('X bookmarks of @dig_tester: 5 posts read, 1 post matching "digging maker_one".');

		const none = await executeSource(likes, { match: "spoon" }, context());
		expect(none.status).toBe("empty");
		expect(none.text).toContain('None of the 5 posts read match "spoon".');
	});

	test("each match word must start a word, in text and links alike: ai finds AI, AI's and #AI but not brainstorm or said", async () => {
		signIn();
		const link = (url: string) => ({ entities: { urls: [{ url: "https://t.co/x", expanded_url: url, display_url: url }] } });
		installFetch((url) => (url.pathname === "/2/users/me"
			? json({ data: ME })
			: json({
				data: [
					tweet("1625000000000000001", "Time to brainstorm"),
					tweet("1625000000000000002", "AI's next step"),
					tweet("1625000000000000003", "Everywhere: #AI"),
					tweet("1625000000000000004", "She said so"),
					tweet("1625000000000000005", "A guide https://t.co/x", maker, link("https://example.com/ai-guide")),
					tweet("1625000000000000006", "Another https://t.co/x", maker, link("https://example.com/said-it")),
					tweet("1625000000000000007", "Agents at work"),
				],
				includes: { users: [maker] },
			})));
		const ai = await executeSource(likes, { match: "ai" }, context());
		expect(ai.text.split("\n", 1)[0]).toBe('X posts liked by @dig_tester: 7 posts read, 3 posts matching "ai".');
		for (const id of ["1625000000000000002", "1625000000000000003", "1625000000000000005"]) expect(ai.text).toContain(`/status/${id}`);
		for (const id of ["1625000000000000001", "1625000000000000004", "1625000000000000006", "1625000000000000007"]) expect(ai.text).not.toContain(`/status/${id}`);
		const agent = await executeSource(likes, { match: "agent" }, context());
		expect(agent.text.split("\n", 1)[0]).toBe('X posts liked by @dig_tester: 7 posts read, 1 post matching "agent".');
		expect(agent.text).toContain("/status/1625000000000000007");
	});

	test("a bookmark folder is found by name or id, its listed posts read through the post lookup in the folder's order", async () => {
		const keys = signIn();
		const folders = { data: [{ id: "1700000000000000001", name: "Reading List" }, { id: "1700000000000000002", name: "Tools" }] };
		installFetch((url) => {
			if (url.pathname === "/2/users/me") return json({ data: ME });
			if (url.pathname.endsWith("/bookmarks/folders")) return json(folders);
			if (url.pathname.endsWith("/bookmarks/folders/1700000000000000002")) return json({ data: [{ id: "1630000000000000002" }, { id: "1630000000000000001" }] });
			if (url.pathname === "/2/tweets") return json({ data: [tweet("1630000000000000001", "Older tool"), tweet("1630000000000000002", "Newer tool")], includes: { users: [maker] } });
			return json({}, 404);
		});
		const byName = await executeSource(bookmarks, { folder: "tools" }, context());
		expect(xCalls().map(path)).toEqual(["/2/users/me", `/2/users/${ME.id}/bookmarks/folders`, `/2/users/${ME.id}/bookmarks/folders/1700000000000000002`, "/2/tweets"]);
		expect(xCalls().slice(0, 3).every((call) => signedBy(call, keys))).toBe(true);
		const lookup = xCalls()[3];
		expect(lookup.headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(lookup.url.searchParams.get("ids")).toBe("1630000000000000002,1630000000000000001");
		expect(byName.status).toBe("success");
		expect(byName.text.split("\n", 1)[0]).toBe('X bookmarks of @dig_tester, folder "Tools": 2 posts read.');
		expect(byName.text.indexOf("Newer tool")).toBeLessThan(byName.text.indexOf("Older tool"));

		const byId = await executeSource(bookmarks, { folder: "1700000000000000002" }, context());
		expect(byId.text.split("\n", 1)[0]).toBe('X bookmarks of @dig_tester, folder "Tools": 2 posts read.');

		calls = [];
		const unknown = await executeSource(bookmarks, { folder: "Recipes" }, context());
		expect(unknown.status).toBe("failed");
		expect(unknown.text).toBe('ERROR: @dig_tester has no bookmark folder named or numbered "Recipes". X lists 2 folders: "Reading List", "Tools".');
		expect(xCalls().map(path)).toEqual([`/2/users/${ME.id}/bookmarks/folders`]);

		calls = [];
		delete process.env.X_BEARER_TOKEN;
		const noToken = await executeSource(bookmarks, { folder: "Tools" }, context());
		expect(noToken.text).toMatch(/^ERROR: A bookmark folder lists post ids only, and Dig reads its posts through the post lookup, which needs X_BEARER_TOKEN\./);
		expect(calls).toHaveLength(0);
	});

	test("a folder page of X's 100-id maximum with no next token says the folder may hold more, unless limit was reached; a full folder list says so too", async () => {
		signIn();
		const ids = Array.from({ length: 100 }, (_, i) => String(1650000000000000000n + BigInt(i)));
		const folders = (count: number) => ({ data: Array.from({ length: count }, (_, i) => ({ id: String(1700000000000001000n + BigInt(i)), name: i === 0 ? "Tools" : `Folder ${i}` })) });
		let listed = folders(2);
		installFetch((url) => {
			if (url.pathname === "/2/users/me") return json({ data: ME });
			if (url.pathname.endsWith("/bookmarks/folders")) return json(listed);
			if (url.pathname.includes("/bookmarks/folders/")) return json({ data: ids.map((id) => ({ id })) });
			return json({ data: (url.searchParams.get("ids") ?? "").split(",").map((id) => tweet(id, `Saved ${id}`)), includes: { users: [maker] } });
		});
		const note = "X's folder endpoint returned 100 post ids, its maximum per request, and no way to read further; the folder may hold more.";
		const short = await executeSource(bookmarks, { folder: "Tools", limit: 800 }, context());
		expect(short.status).toBe("partial");
		expect(short.text).toContain(note);
		expect(short.text.split("\n", 1)[0]).toBe('X bookmarks of @dig_tester, folder "Tools": 100 posts read.');
		const reached = await executeSource(bookmarks, { folder: "Tools", limit: 100 }, context());
		expect(reached.status).toBe("success");
		expect(reached.text).not.toContain(note);

		listed = folders(100);
		const unknown = await executeSource(bookmarks, { folder: "Recipes" }, context());
		expect(unknown.status).toBe("failed");
		expect(unknown.text).toMatch(/^ERROR: Dig could not tell whether @dig_tester has a bookmark folder named or numbered "Recipes": the folder list was incomplete \(X's folder list returned 100 folders, its maximum per request, and no way to read further\)\. X listed 100 folders: /);
		expect(unknown.text).not.toContain("has no bookmark folder");
	});

	test("a folder's post lookup follows the lookup rules: posts beside ones X names missing are partial, and every post answered missing is empty", async () => {
		signIn();
		const FIRST = "1800000000000000001";
		const SECOND = "1800000000000000002";
		let lookup: () => Response = () => json({});
		installFetch((url) => {
			if (url.pathname === "/2/users/me") return json({ data: ME });
			if (url.pathname.endsWith("/bookmarks/folders")) return json({ data: [{ id: "1700000000000000009", name: "Reading" }] });
			if (url.pathname.includes("/bookmarks/folders/")) return json({ data: [{ id: FIRST }, { id: SECOND }] });
			return lookup();
		});
		lookup = () => json({ data: [tweet(FIRST, "synthetic post")], includes: { users: [maker] }, errors: [notFound(SECOND)] });
		const some = await executeSource(bookmarks, { folder: "Reading" }, context());
		expect(some.status).toBe("partial");
		expect(some.text).toContain(`X bookmarks of @dig_tester, folder "Reading": 1 post read.\nNot returned: ${SECOND} — Not Found Error: Could not find tweet with id: [${SECOND}].`);

		lookup = () => json({ errors: [notFound(FIRST), notFound(SECOND)] }, 404);
		const none = await executeSource(bookmarks, { folder: "Reading" }, context());
		expect(none.status).toBe("empty");
		expect(none.text).toContain(`Not returned: ${FIRST} — Not Found Error`);
		expect(none.text).toContain(`Not returned: ${SECOND} — Not Found Error`);

		lookup = () => json({ title: "Service Unavailable", detail: "Try again later." }, 503);
		const down = await executeSource(bookmarks, { folder: "Reading" }, context());
		expect(down.status).toBe("failed");
		expect(down.text.split("\n", 1)[0]).toBe("ERROR: X API post lookup failed with HTTP 503: Service Unavailable: Try again later.");
	});

	test("a problem beside the folder list makes a found folder's read partial, and stops a missing folder being called absent", async () => {
		signIn();
		const problem = { type: "https://api.x.com/2/problems/internal-error", title: "Internal Server Error", detail: "An internal error has occurred.", status: 500 };
		installFetch((url) => {
			if (url.pathname === "/2/users/me") return json({ data: ME });
			if (url.pathname.endsWith("/bookmarks/folders")) return json({ data: [{ id: "1700000000000000009", name: "Reading" }], errors: [problem] });
			if (url.pathname.includes("/bookmarks/folders/")) return json({ data: [{ id: "1800000000000000001" }] });
			return json({ data: [tweet("1800000000000000001", "synthetic post")], includes: { users: [maker] } });
		});
		const found = await executeSource(bookmarks, { folder: "Reading" }, context());
		expect(found.status).toBe("partial");
		expect(found.text).toContain("The folder list reported a problem, though it listed this folder: X API bookmark folders reported Internal Server Error: An internal error has occurred.");
		expect(found.text).toContain("synthetic post");

		const absent = await executeSource(bookmarks, { folder: "Recipes" }, context());
		expect(absent.status).toBe("failed");
		expect(absent.text).toBe('ERROR: Dig could not tell whether @dig_tester has a bookmark folder named or numbered "Recipes": the folder list was incomplete (X API bookmark folders reported Internal Server Error: An internal error has occurred.). X listed 1 folder: "Reading".');
	});

	test("likes page the signed-in account's liked posts, asking X for at least the five it allows", async () => {
		const keys = signIn();
		installFetch((url) => (url.pathname === "/2/users/me"
			? json({ data: ME })
			: json({ data: Array.from({ length: 5 }, (_, i) => tweet(`164000000000000000${i}`, `Liked ${i}`)), includes: { users: [maker] }, meta: { result_count: 5, next_token: "more" } })));
		const result = await executeSource(likes, { limit: 3 }, context());
		const [, liked] = xCalls();
		expect(path(liked)).toBe(`/2/users/${ME.id}/liked_tweets`);
		expect(liked.url.searchParams.get("max_results")).toBe("5");
		expect(signedBy(liked, keys)).toBe(true);
		expect(result.text.split("\n", 1)[0]).toBe("X posts liked by @dig_tester: 3 posts read; X has more.");
		expect(result.text).not.toContain("Liked 3");
	});
});

describe("X Communities", () => {
	const COMMUNITY = "1800000000000000001";
	const tikhubPostFixture = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ tweet_id: id, bookmarks: null, created_at: "Mon Oct 05 19:00:46 +0000 2026", favorites: 9, text, lang: "en", source: null, views: "120", screen_name: "maker_one", quotes: 0, replies: 1, retweets: 2, media: [], author: { rest_id: maker.id, name: "Maker One", screen_name: "maker_one", avatar: null, blue_verified: true }, ...extra });
	const envelope = (data: unknown, params: Record<string, string>) => json({ code: 200, message: "Request successful. This request will incur a charge.", params, data });

	test("Communities search runs signed in when sign-in is set, each with its link", async () => {
		const keys = signIn();
		installFetch(() => json({ data: [{ id: COMMUNITY, name: "Shovel Makers", member_count: 1200, access: "Public", join_policy: "Open" }], meta: { next_token: "more" } }));
		const result = await executeSource(explore, { kind: "communities", query: "shovels" }, context());
		const [search] = xCalls();
		expect(path(search)).toBe("/2/communities/search");
		expect(signedBy(search, keys)).toBe(true);
		expect(tikhubCalls()).toHaveLength(0);
		expect(result.status).toBe("success");
		expect(result.text).toContain(`- Shovel Makers · Public · Open · 1,200 members\n  https://x.com/i/communities/${COMMUNITY}`);
	});

	test("without sign-in, Communities search is read through TikHub, paged, labelled via TikHub and needing no Bearer Token", async () => {
		delete process.env.X_BEARER_TOKEN;
		installFetch((url) => (url.searchParams.get("cursor")
			? envelope({ communities: [{ community_id: "1800000000000000003", member_count: 40, name: "Spade Club", primary_topic: null, is_nsfw: false }], next_cursor: "" }, { keyword: "shovels" })
			: envelope({ communities: [{ community_id: COMMUNITY, member_count: 1200, name: "Shovel Makers", primary_topic: null, is_nsfw: false }, { community_id: "1800000000000000002", member_count: 75, name: "Garden Tools", primary_topic: null, is_nsfw: true }], next_cursor: "cursor-2" }, { keyword: "shovels" })));
		const result = await executeSource(explore, { kind: "communities", query: "shovels" }, context());
		expect(xCalls()).toHaveLength(0);
		expect(tikhubCalls().map((call) => [call.url.pathname, call.url.searchParams.get("keyword"), call.url.searchParams.get("cursor")])).toEqual([
			["/api/v1/twitter/web/fetch_search_communities", "shovels", null],
			["/api/v1/twitter/web/fetch_search_communities", "shovels", "cursor-2"],
		]);
		expect(kept.map((response) => response.label)).toEqual(["fetch_search_communities via TikHub", "fetch_search_communities via TikHub, page 2"]);
		expect(result.status).toBe("success");
		expect(result.text.split("\n", 1)[0]).toBe('X Communities search for "shovels" via TikHub: 3 Communities.');
		expect(result.text).toContain("- Garden Tools · 75 members · marked NSFW\n  https://x.com/i/communities/1800000000000000002");
		expect(result.details).toMatchObject({ via: "TikHub", cost: null });
	});

	test("Communities search with neither sign-in nor TikHub fails before any request, naming both", async () => {
		delete process.env.TIKHUB_API_KEY;
		const result = await executeSource(explore, { kind: "communities", query: "shovels" }, context());
		expect(result.status).toBe("failed");
		expect(result.text).toContain("X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET are not set");
		expect(result.text).toContain("TIKHUB_API_KEY");
		expect(calls).toHaveLength(0);
	});

	test("x_community with posts 0 reads only X's details, by link", async () => {
		installFetch(() => json({ data: { id: COMMUNITY, name: "Shovel Makers", description: "People who make shovels", member_count: 1200, access: "Public", join_policy: "Open", created_at: "2024-05-01T10:00:00.000Z" } }));
		const result = await executeSource(community, { community: `https://x.com/i/communities/${COMMUNITY}`, posts: 0 }, context());
		expect(xCalls().map((call) => [path(call), call.headers.authorization])).toEqual([[`/2/communities/${COMMUNITY}`, `Bearer ${TOKEN}`]]);
		expect(xCalls()[0].url.searchParams.get("community.fields")?.split(",")).toEqual(expect.arrayContaining(["member_count", "description", "join_policy"]));
		expect(tikhubCalls()).toHaveLength(0);
		expect(result.status).toBe("success");
		expect(result.text).toBe(`X Community ${COMMUNITY} "Shovel Makers" (https://x.com/i/communities/${COMMUNITY}): details from the X API.\n\nPublic · join policy Open · 1,200 members · created 2024-05-01\nDescription: People who make shovels`);
	});

	test("x_community reads its posts through TikHub, paged until it has enough, each with its exact text, author, time, counts and link", async () => {
		installFetch((url) => {
			if (url.host === "api.x.com") return json({ data: { id: COMMUNITY, name: "Shovel Makers", member_count: 1200 } });
			const cursor = url.searchParams.get("cursor");
			return cursor === "t-2"
				? envelope({ timeline: [tikhubPostFixture("1810000000000000003", "Third post"), tikhubPostFixture("1810000000000000004", "Fourth post")], cursor: "t-3" }, { community_id: COMMUNITY, ranking: "Recency" })
				: envelope({ timeline: [tikhubPostFixture("1810000000000000001", "First post\nwith a second line", { media: { photo: [{ id: "1", media_url_https: "https://pbs.twimg.com/media/fixture.jpg" }] } }), tikhubPostFixture("1810000000000000002", "Second post", { quoted: { ...tikhubPostFixture("1810000000000000009", "The quoted post"), author: { rest_id: other.id, name: "Another Person", screen_name: "another_person", avatar: null, blue_verified: false } } })], cursor: "t-2" }, { community_id: COMMUNITY, ranking: "Recency" });
		});
		const result = await executeSource(community, { community: COMMUNITY, posts: 3 }, context());
		expect(tikhubCalls().map((call) => [call.url.pathname, call.url.searchParams.get("community_id"), call.url.searchParams.get("ranking"), call.url.searchParams.get("cursor")])).toEqual([
			["/api/v1/twitter/web/fetch_community_timeline", COMMUNITY, "Recency", null],
			["/api/v1/twitter/web/fetch_community_timeline", COMMUNITY, "Recency", "t-2"],
		]);
		expect(kept.map((response) => response.label)).toEqual([`Community ${COMMUNITY}`, "fetch_community_timeline via TikHub", "fetch_community_timeline via TikHub, page 2"]);
		expect(result.status).toBe("success");
		expect(result.text.split("\n", 1)[0]).toBe(`X Community ${COMMUNITY} "Shovel Makers" (https://x.com/i/communities/${COMMUNITY}): details from the X API, 3 posts via TikHub.`);
		expect(result.text).toContain("Posts via TikHub: 3 posts read through TikHub's Recency ranking, shown newest first; TikHub has more. TikHub's ranking is not strictly by time, so a newer post may sit on a later page.\nList lines leave out counts of zero.\n");
		expect(result.text).toContain("- @maker_one (Maker One, verified) · 2026-10-05 19:00 UTC · 1 reply · 2 reposts · 9 likes · 120 views · https://x.com/maker_one/status/1810000000000000001\n  First post\n  with a second line\n  Media: photo https://pbs.twimg.com/media/fixture.jpg");
		expect(result.text).not.toContain("0 quotes");
		expect(result.text).toContain("  Quoting @another_person: https://x.com/another_person/status/1810000000000000009\n  > The quoted post");
		expect(result.text).not.toContain("Fourth post");
		expect(result.details).toMatchObject({ via: "TikHub", posts: 3, cost: null });

		calls = [];
		await executeSource(community, { community: COMMUNITY, posts: 1, sort: "relevant" }, context());
		expect(tikhubCalls()[0].url.searchParams.get("ranking")).toBe("Relevance");
	});

	test("TikHub's 30-page safety limit is named and makes the call partial, for a Community's posts and for Communities search", async () => {
		let n = 0;
		installFetch((url) => {
			if (url.host === "api.x.com") return json({ data: { id: COMMUNITY, name: "Shovel Makers", member_count: 1200 } });
			n += 1;
			if (url.pathname.endsWith("/fetch_search_communities")) return envelope({ communities: [{ community_id: String(1830000000000000000n + BigInt(n)), member_count: 5, name: `Community ${n}` }], next_cursor: `s-${n}` }, { keyword: "shovels" });
			return envelope({ timeline: Array.from({ length: 10 }, (_, i) => tikhubPostFixture(String(1840000000000000000n + BigInt(n * 100 + i)), `Post ${n}-${i}`)), cursor: `t-${n}` }, { community_id: COMMUNITY, ranking: "Recency" });
		});
		const posts = await executeSource(community, { community: COMMUNITY, posts: 500 }, context());
		expect(tikhubCalls()).toHaveLength(30);
		expect(posts.status).toBe("partial");
		expect(posts.text).toContain("Not read: the rest of the Community's posts: TikHub paging stopped at its 30-page safety limit after 300 posts of the 500 asked for");
		expect(posts.details).toMatchObject({ posts: 300 });

		calls = [];
		n = 0;
		for (const name of USER_KEY_NAMES) delete process.env[name];
		const search = await executeSource(explore, { kind: "communities", query: "shovels", limit: 100 }, context());
		expect(tikhubCalls()).toHaveLength(30);
		expect(search.status).toBe("partial");
		expect(search.text).toContain("Stopped at the 30-page safety limit with 30 Communities of the 100 asked for; TikHub has more.");

		calls = [];
		n = 0;
		const reached = await executeSource(community, { community: COMMUNITY, posts: 20 }, context());
		expect(reached.status).toBe("success");
		expect(reached.text).not.toContain("safety limit");
	});

	test("TikHub's Recency ranking, which is not time order, is shown newest first by each post's own time; Relevance keeps TikHub's order", async () => {
		// The order of a live Recency page: Oct 05 11:02, Oct 06 22:52, Oct 06 16:01, Oct 07 00:15.
		const page = [["1820000000000000001", "Mon Oct 05 11:02:00 +0000 2026"], ["1820000000000000002", "Tue Oct 06 22:52:00 +0000 2026"], ["1820000000000000003", "Tue Oct 06 16:01:00 +0000 2026"], ["1820000000000000004", "Wed Oct 07 00:15:00 +0000 2026"]];
		installFetch((url) => (url.host === "api.x.com"
			? json({ data: { id: COMMUNITY, name: "Shovel Makers", member_count: 1200 } })
			: envelope({ timeline: page.map(([id, at]) => tikhubPostFixture(id, `Post ${id.slice(-1)}`, { created_at: at })) }, { community_id: COMMUNITY, ranking: String(url.searchParams.get("ranking")) })));
		const at = (text: string, order: string[]) => order.map((n) => `${text}\n`.indexOf(`  Post ${n}\n`));
		const sorted = (positions: number[]) => positions.every((position) => position > 0) && positions.every((position, i) => i === 0 || position > positions[i - 1]);
		const recent = await executeSource(community, { community: COMMUNITY, posts: 4 }, context());
		expect(sorted(at(recent.text, ["4", "2", "3", "1"]))).toBe(true);
		expect(recent.text).toContain("4 posts read through TikHub's Recency ranking, shown newest first. TikHub's ranking is not strictly by time, so a newer post may sit on a later page.");
		const relevant = await executeSource(community, { community: COMMUNITY, posts: 4, sort: "relevant" }, context());
		expect(sorted(at(relevant.text, ["1", "2", "3", "4"]))).toBe(true);
		expect(relevant.text).toContain("Posts via TikHub: 4 posts read in TikHub's Relevance ranking, in its order.");
		expect(relevant.text).not.toContain("newest first");
	});

	test("x_community without TIKHUB_API_KEY returns X's details and says the posts need it", async () => {
		delete process.env.TIKHUB_API_KEY;
		installFetch(() => json({ data: { id: COMMUNITY, name: "Shovel Makers", member_count: 1200 } }));
		const result = await executeSource(community, { community: COMMUNITY }, context());
		expect(tikhubCalls()).toHaveLength(0);
		expect(result.status).toBe("partial");
		expect(result.text).toContain("details from the X API, 0 posts via TikHub.");
		expect(result.text).toContain("Not read: the Community's posts: Dig reads them through TikHub, which needs TIKHUB_API_KEY, and it is not set in Dig's keys.env");
		expect(result.text).toContain("1,200 members");
	});

	test("x_community without X_BEARER_TOKEN reads its details through TikHub, whose join status is not shown", async () => {
		delete process.env.X_BEARER_TOKEN;
		installFetch(() => envelope({ id: COMMUNITY, created_at: 1714557600000, name: "Shovel Makers", description: "People who make shovels", is_nsfw: false, primary_topic: null, member_count: 1200, rules: [{ name: "Be kind", description: "No insults" }], status: "failed", last_cursor: "" }, { community_id: COMMUNITY }));
		const result = await executeSource(community, { community: COMMUNITY, posts: 0 }, context());
		expect(xCalls()).toHaveLength(0);
		expect(tikhubCalls().map((call) => call.url.pathname)).toEqual(["/api/v1/twitter/web/fetch_community_info"]);
		expect(result.status).toBe("success");
		expect(result.text).toBe(`X Community ${COMMUNITY} "Shovel Makers" (https://x.com/i/communities/${COMMUNITY}): details via TikHub.\n\n1,200 members · created 2024-05-01\nDescription: People who make shovels\nRules:\n1. Be kind: No insults`);
	});

	test("x_community refuses a link that is not a Community, and needs X_BEARER_TOKEN or TIKHUB_API_KEY, before any request", async () => {
		expect((await executeSource(community, { community: "https://x.com/jack/status/20" }, context())).text).toBe("ERROR: community must be an X Community id or link such as https://x.com/i/communities/<id>.");
		delete process.env.X_BEARER_TOKEN;
		delete process.env.TIKHUB_API_KEY;
		const neither = await executeSource(community, { community: COMMUNITY }, context());
		expect(neither.text).toMatch(/^ERROR: x_community reads a Community's details with X_BEARER_TOKEN or through TikHub, and its posts through TikHub; neither X_BEARER_TOKEN nor TIKHUB_API_KEY is set/);
		expect(calls).toHaveLength(0);
	});

	test("a post in a Community shows the Community's link, in full and in lists", async () => {
		installFetch((url) => json(url.pathname === "/2/tweets" ? { data: [{ ...apiPost, community_id: COMMUNITY }], includes } : { data: [{ id: "1", text: "In a community", author_id: AUTHOR_ID, community_id: COMMUNITY }], includes: { users: [author] } }));
		const full = await executeSource(post, { posts: [POST_ID] }, context());
		expect(full.text).toContain(`Community: https://x.com/i/communities/${COMMUNITY}`);
		const listed = await executeSource(search_posts, { query: "community" }, context());
		expect(listed.text).toContain(`  In a community\n  Community: https://x.com/i/communities/${COMMUNITY}`);
	});
});
