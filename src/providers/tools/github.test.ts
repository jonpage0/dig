import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import type { SourceToolResult, ToolContext } from "../types.js";
import { inspect, read, search } from "./github.js";

type FetchCall = { url: URL; init: RequestInit | undefined; headers: Headers; body: unknown };
type Route = unknown | ((call: FetchCall) => unknown | Response);

const TOKEN = "gh_test_token_never_shown";
const DAY = 86_400_000;
const RESET_EPOCH = "1789300000";
const RESET_ISO = "2026-09-13T11:46:40.000Z";

const context: ToolContext = {
	sessionID: "github-test",
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

function json(payload: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
	return new Response(JSON.stringify(payload), {
		status: init.status ?? 200,
		headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
	});
}

function rateLimited(resource: string): Response {
	return json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-resource": resource, "x-ratelimit-reset": RESET_EPOCH } });
}

function installFetchMock(routes: Record<string, Route>) {
	const calls: FetchCall[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof URL ? input : new URL(String(input));
		const call: FetchCall = { url, init, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
		calls.push(call);
		const route = routes[url.pathname];
		if (route === undefined) return json({ message: "Not Found" }, { status: 404 });
		const payload = typeof route === "function" ? (route as (call: FetchCall) => unknown)(call) : route;
		// A prebuilt Response is cloned so a retried route can be served twice.
		return payload instanceof Response ? payload.clone() : json(payload);
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

const publicRepo = {
	full_name: "acme/widget",
	html_url: "https://github.com/acme/widget",
	description: "A widget framework",
	homepage: "https://widget.example",
	language: "TypeScript",
	license: { spdx_id: "MIT", name: "MIT License" },
	topics: ["widgets", "framework"],
	stargazers_count: 1234,
	forks_count: 56,
	subscribers_count: 40,
	open_issues_count: 7,
	created_at: "2024-01-10T00:00:00Z",
	pushed_at: "2026-09-14T20:06:34Z",
	default_branch: "main",
	private: false,
	visibility: "public",
	archived: false,
	fork: false,
	owner: { login: "acme", type: "Organization" },
};

// One clock reading for every fixture date so expectations rebuilt later in a
// test compare equal to the strings the routes served.
const NOW = Date.now();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const weekSeconds = (daysAgo: number) => Math.floor((NOW - daysAgo * DAY) / 1000);
const isoDate = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

function commit(sha: string, login: string | null, committedDaysAgo: number, parents = 1) {
	return {
		sha,
		commit: {
			author: { name: "Someone", date: iso(committedDaysAgo + 40) },
			committer: { name: "GitHub", date: iso(committedDaysAgo) },
			message: `Change ${sha}\n\nbody`,
		},
		author: login ? { login, type: login.endsWith("[bot]") ? "Bot" : "User" } : null,
		parents: Array.from({ length: parents }, (_, index) => ({ sha: `p${index}` })),
	};
}

function starWeek(daysAgo: number, total: number) {
	return { week: weekSeconds(daysAgo), total, days: [total, 0, 0, 0, 0, 0, 0] };
}

function actor(login: string, bot = false) {
	return { __typename: bot ? "Bot" : "User", login };
}

const graphql = {
	data: {
		rateLimit: { cost: 1, remaining: 4999, resetAt: hoursAgo(0) },
		repository: {
			isPrivate: false,
			mergedPullRequests: {
				totalCount: 120,
				nodes: [
					{
						number: 41, title: "Add retries", url: "https://github.com/acme/widget/pull/41", createdAt: hoursAgo(50), mergedAt: hoursAgo(2),
						authorAssociation: "CONTRIBUTOR", author: actor("outsider"), mergedBy: actor("maintainer"),
						reviews: { totalCount: 2, nodes: [
							{ state: "COMMENTED", submittedAt: hoursAgo(20), url: "https://github.com/acme/widget/pull/41#r1", bodyText: "self note", author: actor("outsider") },
							{ state: "APPROVED", submittedAt: hoursAgo(3), url: "https://github.com/acme/widget/pull/41#r2", bodyText: "LGTM, thanks for adding the backoff test.", author: actor("maintainer") },
						] },
					},
					{
						number: 42, title: "Bump deps", url: "https://github.com/acme/widget/pull/42", createdAt: hoursAgo(10), mergedAt: hoursAgo(1),
						authorAssociation: "CONTRIBUTOR", author: actor("dependabot", true), mergedBy: actor("maintainer"),
						reviews: { totalCount: 1, nodes: [{ state: "APPROVED", submittedAt: hoursAgo(5), url: "https://github.com/acme/widget/pull/42#r1", bodyText: "", author: actor("copilot-pull-request-reviewer", true) }] },
					},
				],
			},
			openIssues: {
				totalCount: 5,
				nodes: [{
					number: 7, title: "Crash on start", url: "https://github.com/acme/widget/issues/7", createdAt: hoursAgo(30), authorAssociation: "NONE", author: actor("reporter"),
					comments: { totalCount: 2, nodes: [
						{ createdAt: hoursAgo(29), authorAssociation: "NONE", url: "c1", bodyText: "same here", author: actor("reporter") },
						{ createdAt: hoursAgo(25), authorAssociation: "MEMBER", url: "https://github.com/acme/widget/issues/7#c2", bodyText: "Reproduced on 2.0.0; fix in #43.", author: actor("maintainer") },
					] },
				}],
			},
			closedIssues: {
				totalCount: 300,
				nodes: [{
					number: 3, title: "Old bug", url: null, createdAt: hoursAgo(500), closedAt: hoursAgo(400), authorAssociation: "NONE", author: null,
					comments: { totalCount: 9, nodes: [{ createdAt: hoursAgo(499), authorAssociation: "NONE", url: null, bodyText: "closing as stale", author: actor("stale", true) }] },
				}],
			},
		},
	},
};

function repoRoutes(overrides: Record<string, Route> = {}): Record<string, Route> {
	return {
		"/repos/acme/widget": publicRepo,
		// current partial week (3 stars), two complete window weeks (10, 20), two complete prior weeks (30, 99)
		"/repos/acme/widget/stargazers/history": [starWeek(2, 3), starWeek(9, 10), starWeek(16, 20), starWeek(23, 30), starWeek(30, 99)],
		"/repos/acme/widget/commits": (call: FetchCall) => {
			const page = call.url.searchParams.get("page");
			expect(call.url.searchParams.get("sha")).toBe("main");
			expect(call.url.searchParams.get("since")).toBeTruthy();
			const payload = page === "1" ? [commit("aaa1111111", "alice", 1), commit("bbb2222222", "dependabot[bot]", 2, 2)] : [commit(`ccc${page}`, null, 3)];
			return json(payload, { headers: { link: `<https://api.github.com/repos/acme/widget/commits?page=${Number(page) + 1}>; rel="next"` } });
		},
		"/repos/acme/widget/releases": [
			{ tag_name: "v2.0.0", published_at: hoursAgo(24), prerelease: false, draft: false, html_url: "https://github.com/acme/widget/releases/tag/v2.0.0" },
			{ tag_name: "v1.9.0", published_at: iso(100), prerelease: false, draft: false, html_url: null },
			{ tag_name: "v2.1.0-draft", published_at: null, prerelease: true, draft: true, html_url: null },
		],
		"/repos/acme/widget/contributors": json(
			[{ login: "alice", type: "User", contributions: 900 }, { login: "dependabot[bot]", type: "Bot", contributions: 120 }],
			{ headers: { link: '<https://api.github.com/repos/acme/widget/contributors?page=2>; rel="next"' } },
		),
		"/graphql": graphql,
		...overrides,
	};
}

describe("github tools", () => {
	const env = { gh: process.env.GH_TOKEN, github: process.env.GITHUB_TOKEN };
	let restore: (() => void) | undefined;

	beforeEach(() => {
		process.env.GH_TOKEN = TOKEN;
		delete process.env.GITHUB_TOKEN;
	});

	afterEach(() => {
		restore?.();
		restore = undefined;
		if (env.gh === undefined) delete process.env.GH_TOKEN;
		else process.env.GH_TOKEN = env.gh;
		if (env.github === undefined) delete process.env.GITHUB_TOKEN;
		else process.env.GITHUB_TOKEN = env.github;
	});

	describe("github_search", () => {
		test("always appends is:public, forwards sort and paging, withholds items not marked public, and preserves total/incomplete/continuation", async () => {
			const mock = installFetchMock({
				"/search/repositories": json(
					{ total_count: 2500, incomplete_results: true, items: [
						{ ...publicRepo },
						{ ...publicRepo, full_name: "acme/other", archived: true, license: null },
						{ ...publicRepo, full_name: "acme/leaked", private: true, visibility: "private" },
						{ ...publicRepo, full_name: "acme/unmarked", visibility: undefined },
					] },
					{ headers: { "x-ratelimit-remaining": "29", "x-ratelimit-resource": "search", "x-ratelimit-reset": RESET_EPOCH } },
				),
			});
			restore = mock.restore;

			const result = await search.execute({ query: 'widget "is:public" language:TypeScript', sort: "stars", order: "asc", page: 3, perPage: 50 }, context);

			expect(mock.calls).toHaveLength(1);
			const [call] = mock.calls;
			expect(call!.url.searchParams.get("q")).toBe('widget "is:public" language:TypeScript is:public');
			expect(call!.url.searchParams.get("sort")).toBe("stars");
			expect(call!.url.searchParams.get("order")).toBe("asc");
			expect(call!.url.searchParams.get("per_page")).toBe("50");
			expect(call!.url.searchParams.get("page")).toBe("3");
			expect(call!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
			expect(call!.init?.signal).toBeInstanceOf(AbortSignal);

			const out = text(result);
			expect(out).not.toContain(TOKEN);
			expect(out).toContain("authenticated via GH_TOKEN");
			expect(out).toContain("Total matches reported by GitHub: 2,500 | incomplete_results: true");
			expect(out).toContain("Showing results 101–104 of 1,000 retrievable (GitHub caps retrieval at 1,000 of 2,500). More pages available (next page 4).");
			expect(out).toContain("Withheld 2 returned item(s) not explicitly marked public");
			expect(out).not.toContain("acme/leaked");
			expect(out).not.toContain("acme/unmarked");
			expect(out).toContain("acme/other [ARCHIVED]");
			expect(out).toContain("License: none detected");
			expect(details(result)).toMatchObject({ total: 2500, retrievable: 1000, incomplete_results: true, hasMore: true, shown: 2, withheld: 2, repos: ["acme/widget", "acme/other"] });
		});

		test("refuses negated or non-public scope and pages past GitHub's cap before spending a request", async () => {
			const mock = installFetchMock({});
			restore = mock.restore;
			for (const query of ["widget is:private", "widget is:internal", "widget -is:public", "widget NOT is:public", "widget visibility:private"]) {
				expect((text(await search.execute({ query }, context))).startsWith("ERROR: github_search reads public repositories only")).toBe(true);
			}
			expect(text(await search.execute({ query: "widget", perPage: 100, page: 11 }, context))).toBe("ERROR: GitHub search exposes at most 1,000 results per query; with perPage 100 the last page is 10");
			expect(mock.calls).toHaveLength(0);
		});

		test("reports a search rate limit with its reset time instead of an empty result", async () => {
			const mock = installFetchMock({ "/search/repositories": rateLimited("search") });
			restore = mock.restore;
			expect(text(await search.execute({ query: "widget" }, context))).toBe(`ERROR: GitHub search rate limit reached while fetching repository search; remaining 0 (resets ${RESET_ISO})`);
		});

		test("surfaces GitHub validation messages with any token text redacted", async () => {
			const mock = installFetchMock({
				"/search/repositories": json({ message: `Bad credentials for ${TOKEN}`, errors: [{ message: "echoed ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 back" }] }, { status: 422 }),
			});
			restore = mock.restore;
			const out = text(await search.execute({ query: "x" }, context));
			expect(out).toBe("ERROR: GitHub returned HTTP 422 for repository search: Bad credentials for [redacted]; echoed [redacted] back");
		});

		test("reports an HTTP 200 without the search envelope as unavailable instead of zero matches", async () => {
			const mock = installFetchMock({ "/search/repositories": { message: "unexpected search envelope" } });
			restore = mock.restore;
			const malformed = await search.execute({ query: "widget" }, context);
			expect(text(malformed)).toBe("ERROR: GitHub search returned HTTP 200 without a search result envelope (numeric total_count, boolean incomplete_results, items array); no match count is available");
			expect(text(malformed)).not.toContain("No public repositories matched");

			restore();
			restore = installFetchMock({ "/search/repositories": { total_count: 0, incomplete_results: false, items: [] } }).restore;
			const empty = await search.execute({ query: "widget" }, context);
			expect(text(empty)).toContain("Total matches reported by GitHub: 0 | incomplete_results: false");
			expect(text(empty)).toContain("No public repositories matched");
			expect(details(empty)).toMatchObject({ total: 0, shown: 0 });
		});
	});

	describe("github_inspect", () => {
		test("assembles every evidence section with complete-week windows, caps, quoted reviews and bot labels", async () => {
			const mock = installFetchMock(repoRoutes());
			restore = mock.restore;

			const result = await inspect.execute({ repo: "https://github.com/acme/widget.git", days: 14, samples: 2 }, context);
			const out = text(result);
			expect(out).not.toContain(TOKEN);
			expect(out).toContain("GitHub inspect: acme/widget — window");
			expect(out).toContain("Status: complete — all sections returned");
			expect(out).toContain("Stars: 1,234 | Forks: 56 | Watchers: 40 | Open issues+PRs: 7");

			expect(out).toContain(`Current week (started ${isoDate(weekSeconds(2))}, about 3 of 7 days elapsed): 3 stars so far — partial, excluded from the windows below`);
			expect(out).toContain(`Window (2 of 2 complete weeks, ${isoDate(weekSeconds(16))} → ${isoDate(weekSeconds(9) + 6 * 86_400)}): 30 stars created`);
			expect(out).toContain(`Prior window (2 complete weeks, ${isoDate(weekSeconds(30))} → ${isoDate(weekSeconds(23) + 6 * 86_400)}): 129 stars created — same unit`);
			expect(out).toContain(`${isoDate(weekSeconds(2))}: 3* | ${isoDate(weekSeconds(9))}: 10 | ${isoDate(weekSeconds(16))}: 20`);

			expect(out).toContain("commits whose committer date falls in the last 14 days");
			expect(out).toContain("Commits: 4+ (listing capped; more exist in the window) | merge commits: 1 | authors with GitHub accounts: 1 human, 1 bot | commits without a linked account: 2");
			expect(out).toContain(`Latest: aaa1111111 on ${iso(1).slice(0, 10)} by alice`);
			expect(out).toContain("Bot authors: dependabot[bot]");
			expect(out).toContain("Published in the last 14 days: 1 of 2 total");
			expect(out).toContain("Listed: 2+ (more pages exist) | bots among listed: 1");

			expect(out).toContain("Merged PRs (2 most recently updated of 120 merged): 1 by contributors outside owner/member/collaborator, 1 by bots, 1 reviewed by another human (1 human-approved), 1 reviewed only by bots");
			expect(out).toContain("#41 Add retries — outsider (CONTRIBUTOR), merged");
			expect(out).toContain("https://github.com/acme/widget/pull/41; human reviews by maintainer (approved)");
			expect(out).toContain('APPROVED by maintainer on');
			expect(out).toContain('"LGTM, thanks for adding the backoff test." https://github.com/acme/widget/pull/41#r2');
			expect(out).toContain("#42 Bump deps — dependabot [bot]");
			expect(out).toContain("bot reviews by copilot-pull-request-reviewer (bot approval)");
			expect(out).toContain("APPROVED by copilot-pull-request-reviewer [bot]");
			expect(out).toContain("(no review text)");
			expect(out).toContain("Open issues (1 newest of 5 open): 1 with a maintainer reply in the sampled comments, median 5h");
			expect(out).toContain("first MEMBER reply by maintainer after 5h");
			expect(out).toContain('reply: "Reproduced on 2.0.0; fix in #43." https://github.com/acme/widget/issues/7#c2');
			expect(out).toContain("#3 Old bug — (deleted account) (NONE)");
			expect(out).toContain("no owner/member/collaborator reply among the first 1 of 9 comment(s)");
			expect(out).toContain("not net growth");

			expect(mock.calls.filter((call) => call.url.pathname === "/repos/acme/widget/commits")).toHaveLength(3);
			const gql = mock.calls.find((call) => call.url.pathname === "/graphql");
			expect(gql?.init?.method).toBe("POST");
			expect((gql?.body as { variables: Record<string, unknown> }).variables).toMatchObject({ owner: "acme", name: "widget", samples: 2 });
			expect((gql?.body as { query: string }).query).toContain("bodyText");

			expect(details(result)).toMatchObject({
				repo: "acme/widget",
				partial: false,
				window: { days: 14 },
				stars: { weeksPerWindow: 2, current: { total: 3, daysElapsed: 3 }, window: { weeks: 2, total: 30 }, prior: { weeks: 2, total: 129 }, historyExhausted: true },
				commits: { count: 4, capped: true, mergeCommits: 1, latest: { sha: "aaa1111111", date: iso(1) } },
				contributors: { listed: 2, moreExist: true, bots: 1 },
			});
			expect(JSON.stringify(details(result))).not.toContain(TOKEN);
		});

		test("selects the latest publication within the retrieved page instead of an old rolling tag", async () => {
			const mock = installFetchMock(repoRoutes({
				"/repos/acme/widget/releases": [
					{ tag_name: "nightly", published_at: iso(400), prerelease: true, draft: false },
					{ tag_name: "v2.1.0", published_at: iso(2), prerelease: false, draft: false },
					{ tag_name: "v2.0.0", published_at: iso(30), prerelease: false, draft: false },
				],
			}));
			restore = mock.restore;
			const result = await inspect.execute({ repo: "acme/widget", days: 90 }, context);
			expect(details(result)).toMatchObject({
				releases: { listed: 3, inWindow: 2, latest: { tag: "v2.1.0", publishedAt: iso(2), prerelease: false } },
			});
		});

		test("refuses a private repository the token can see, and malformed metadata, after one call each", async () => {
			const mock = installFetchMock({
				"/repos/acme/secret": { ...publicRepo, full_name: "acme/secret", private: true, visibility: "private" },
				"/repos/acme/unmarked": { ...publicRepo, full_name: "acme/unmarked", visibility: undefined },
				"/repos/acme/empty": {},
			});
			restore = mock.restore;
			expect(text(await inspect.execute({ repo: "acme/secret" }, context))).toBe("ERROR: GitHub repository acme/secret is not public; github tools read public repositories only");
			expect(text(await inspect.execute({ repo: "acme/unmarked" }, context))).toBe("ERROR: GitHub repository acme/unmarked is not public; github tools read public repositories only");
			expect(text(await inspect.execute({ repo: "acme/empty" }, context))).toBe("ERROR: GitHub repository metadata is malformed (missing full_name, html_url, or default_branch)");
			expect(mock.calls).toHaveLength(3);
		});

		test("keeps pages fetched before a rate limit and labels the truncated sections, GraphQL failure, and status as partial", async () => {
			const mock = installFetchMock(repoRoutes({
				"/repos/acme/widget/stargazers/history": (call: FetchCall) =>
					call.url.searchParams.get("page") === "1"
						? Array.from({ length: 30 }, (_, index) => starWeek(2 + index * 7, index === 0 ? 1 : 10))
						: rateLimited("core"),
				"/repos/acme/widget/commits": (call: FetchCall) =>
					call.url.searchParams.get("page") === "1"
						? json([commit("aaa1111111", "alice", 1), commit("bbb2222222", "bob", 2)], { headers: { link: '<https://api.github.com/repos/acme/widget/commits?page=2>; rel="next"' } })
						: rateLimited("core"),
				"/graphql": json({ message: "Bad Gateway" }, { status: 502 }),
			}));
			restore = mock.restore;

			const result = await inspect.execute({ repo: "acme/widget", days: 365 }, context);
			const out = text(result);
			expect((out).startsWith("ERROR:")).toBe(false);
			expect(out).toContain("Status: partial — 3 section(s) unavailable or truncated");
			expect(out).toContain(`PARTIAL: star history truncated after page 1: GitHub core rate limit reached while fetching star history page 2; remaining 0 (resets ${RESET_ISO})`);
			expect(out).toContain("Window (29 of 53 complete weeks,");
			expect(out).toContain("): 290 stars created — short window (later pages unavailable)");
			expect(out).toContain("Prior window: not comparable — both runs must hold 53 complete weeks (later pages unavailable)");
			expect(out).toContain(`PARTIAL: commit listing truncated after page 1 (2 commits kept): GitHub core rate limit reached while fetching commits on main, page 2; remaining 0 (resets ${RESET_ISO})`);
			expect(out).toContain("Commits: 2 | merge commits: 0");
			expect(out).toContain("unavailable: GitHub returned HTTP 502 for GraphQL evidence: Bad Gateway");
			expect(details(result)).toMatchObject({ partial: true, stars: { window: { weeks: 29, total: 290 }, prior: null }, commits: { count: 2 }, collaboration: null });
			expect((details(result).failures as string[])).toHaveLength(3);
			expect(mock.calls.filter((call) => call.url.pathname === "/graphql")).toHaveLength(2);
		});

		test("withholds GraphQL evidence on partial errors or malformed connections instead of showing empty samples", async () => {
			const withErrors = { errors: [{ message: "Something went wrong while executing your query." }], data: { repository: { ...graphql.data.repository, openIssues: null } } };
			const mock = installFetchMock(repoRoutes({ "/graphql": withErrors }));
			restore = mock.restore;
			const out = text(await inspect.execute({ repo: "acme/widget", days: 14 }, context));
			expect(out).toContain("Status: partial — 1 section(s)");
			expect(out).toContain("unavailable: GitHub GraphQL reported 1 error(s): Something went wrong while executing your query.");
			expect(out).not.toContain("Open issues (0");

			restore();
			restore = installFetchMock(repoRoutes({ "/graphql": { data: { repository: { ...graphql.data.repository, openIssues: null, closedIssues: { totalCount: "3" } } } } })).restore;
			const malformed = text(await inspect.execute({ repo: "acme/widget", days: 14 }, context));
			expect(malformed).toContain("unavailable: GitHub GraphQL returned malformed connection(s): openIssues, closedIssues; evidence withheld");
		});

		test("withholds star history when a bucket lacks a numeric total instead of counting it as zero", async () => {
			const mock = installFetchMock(repoRoutes({ "/repos/acme/widget/stargazers/history": [starWeek(2, 3), { week: weekSeconds(9), days: [1, 1, 1, 1, 1, 1, 1] }] }));
			restore = mock.restore;
			const result = await inspect.execute({ repo: "acme/widget", days: 14 }, context);
			expect(text(result)).toContain("unavailable: GitHub star history returned a malformed bucket (missing numeric week or total); section withheld");
			expect(details(result)).toMatchObject({ partial: true, stars: null });
		});

		test("keeps a contributor's missing commit count unknown instead of reporting zero", async () => {
			const mock = installFetchMock(repoRoutes({ "/repos/acme/widget/contributors": [{ login: "alice", type: "User", contributions: null }, { login: "bob", type: "User", contributions: 12 }] }));
			restore = mock.restore;
			const result = await inspect.execute({ repo: "acme/widget", days: 14 }, context);
			expect(text(result)).toContain("Top by commit count: alice (n/a), bob (12)");
			expect(details(result)).toMatchObject({ contributors: { top: [{ login: "alice", contributions: null }, { login: "bob", contributions: 12 }] } });
		});

		test("labels a PR whose reviews exceed the fetched sample instead of calling it bot-only reviewed", async () => {
			const botReview = (index: number) => ({ state: "COMMENTED", submittedAt: hoursAgo(20), url: `https://github.com/acme/widget/pull/50#r${index}`, bodyText: `automation ${index}`, author: actor("linter[bot]", true) });
			const humanApproval = { state: "APPROVED", submittedAt: hoursAgo(2), url: "https://github.com/acme/widget/pull/50#r-human", bodyText: "Verified the edge case.", author: actor("maintainer") };
			const pull = {
				number: 50, title: "Real fix", url: "https://github.com/acme/widget/pull/50", createdAt: hoursAgo(40), mergedAt: hoursAgo(1),
				authorAssociation: "CONTRIBUTOR", author: actor("outsider"), mergedBy: actor("maintainer"),
			};
			const mock = installFetchMock(repoRoutes({
				"/graphql": (call: FetchCall) => {
					// Honour the requested nested page size: ten bot comments come first, the human approval is eleventh.
					const requested = (call.body as { variables: { reviews: number } }).variables.reviews;
					const all = [...Array.from({ length: 10 }, (_, index) => botReview(index)), humanApproval];
					return { data: { rateLimit: { cost: 1 }, repository: { isPrivate: false, mergedPullRequests: { totalCount: 1, nodes: [{ ...pull, reviews: { totalCount: all.length, nodes: all.slice(0, requested) } }] }, openIssues: { totalCount: 0, nodes: [] }, closedIssues: { totalCount: 0, nodes: [] } } } };
				},
			}));
			restore = mock.restore;

			const result = await inspect.execute({ repo: "acme/widget", days: 14, samples: 1 }, context);
			const out = text(result);
			expect(out).toContain("Merged PRs (1 most recently updated of 1 merged): 1 by contributors outside owner/member/collaborator, 0 by bots, 0 reviewed by another human (0 human-approved), 0 reviewed only by bots, 1 with no human review among the first 10 of their reviews (later reviews not fetched, so not classified)");
			expect(out).toContain("bot reviews by linter[bot]; only the first 10 of 11 reviews were fetched — later reviews are unexamined");
			expect(out).toContain("Reviews are examined up to the first 10 per PR");
			expect(out).not.toContain("1 reviewed only by bots");
			const [sample] = (details(result).collaboration as { pulls: Record<string, unknown>[] }).pulls;
			expect(sample).toMatchObject({ number: 50, reviewCount: 11, reviewsSampled: 10, reviewsCapped: true, humanReviewers: [], botReviewers: ["linter[bot]"], approvedByHuman: false });
		});

		test("rejects malformed repository identifiers before any request", async () => {
			const mock = installFetchMock({});
			restore = mock.restore;
			expect((text(await inspect.execute({ repo: "acme/widget/../other" }, context))).startsWith("ERROR: repo must be owner/repo")).toBe(true);
			expect((text(await inspect.execute({ repo: "acme/wid get" }, context))).startsWith("ERROR: repo name")).toBe(true);
			expect(mock.calls).toHaveLength(0);
		});
	});

	describe("github_read", () => {
		const commitSha = "0123456789abcdef0123456789abcdef01234567";
		function readRoutes(content: Record<string, unknown>): Record<string, Route> {
			return {
				"/repos/acme/widget": publicRepo,
				"/repos/acme/widget/commits/v2.0.0": { sha: commitSha, commit: { committer: { date: "2026-09-05T00:30:56Z" } }, html_url: "x" },
				"/repos/acme/widget/commits/main": { sha: commitSha, commit: { committer: { date: "2026-09-05T00:30:56Z" } }, html_url: "x" },
				"/repos/acme/widget/contents/src/index.ts": (call: FetchCall) => {
					expect(call.url.searchParams.get("ref")).toBe(commitSha);
					expect(call.headers.get("accept")).toBe("application/vnd.github.object+json");
					return content;
				},
				"/repos/acme/widget/contents/": { type: "dir", entries: [{ type: "file", name: "README.md", path: "README.md", size: 120, sha: "f1" }, { type: "dir", name: "src", path: "src", size: 0, sha: "d1" }, { type: "symlink", name: "link", path: "link", size: 3, sha: "s1" }] },
			};
		}

		test("returns an exact line range with provenance and continuation", async () => {
			const body = Buffer.from("line one\nline two\nline three\nline four\nline five\n").toString("base64");
			const mock = installFetchMock(readRoutes({ type: "file", encoding: "base64", size: 49, sha: "blob123", content: body }));
			restore = mock.restore;

			const result = await read.execute({ repo: "acme/widget", path: "/src/index.ts", ref: "v2.0.0", startLine: 2, maxLines: 2 }, context);
			const out = text(result);
			expect(out).toContain(`GitHub file: src/index.ts — acme/widget @ v2.0.0 → commit ${commitSha} (2026-09-05)`);
			expect(out).toContain("Blob: blob123 | Size: 49 bytes | Lines: 5 | Showing 2–3 | Continue with startLine: 4");
			expect(out).toContain("untrusted repository data");
			expect(out.endsWith("line two\nline three")).toBe(true);
			expect(out).not.toContain("line four");
			expect(details(result)).toMatchObject({ ref: "v2.0.0", commit: commitSha, total_lines: 5, start_line: 2, end_line: 3, has_more: true, next_start_line: 4 });
		});

		test("lists a directory at the default branch when no ref is given", async () => {
			const mock = installFetchMock(readRoutes({}));
			restore = mock.restore;
			const out = text(await read.execute({ repo: "acme/widget" }, context));
			expect(mock.calls.map((call) => call.url.pathname)).toEqual(["/repos/acme/widget", "/repos/acme/widget/commits/main", "/repos/acme/widget/contents/"]);
			expect(out).toContain("GitHub directory: (root) — acme/widget @ main → commit");
			expect(out).toContain("Entries: 3");
			expect(out.indexOf("dir   src")).toBeLessThan(out.indexOf("file  README.md  (120 bytes)"));
			expect(out).toContain("symlink  link");
		});

		test("declines binary content and files GitHub only serves raw", async () => {
			const mock = installFetchMock(readRoutes({ type: "file", encoding: "base64", size: 4, sha: "bin1", content: Buffer.from([0x89, 0x50, 0x00, 0x47]).toString("base64") }));
			restore = mock.restore;
			const out = text(await read.execute({ repo: "acme/widget", path: "src/index.ts" }, context));
			expect(out).toContain("GitHub binary file: src/index.ts (4 bytes, blob bin1)");
			expect(out).toContain("Binary content is not displayed.");

			restore();
			restore = installFetchMock(readRoutes({ type: "file", encoding: "none", size: 5_000_000, sha: "big1", content: "" })).restore;
			expect((text(await read.execute({ repo: "acme/widget", path: "src/index.ts" }, context))).startsWith("ERROR: src/index.ts is 5,000,000 bytes; github_read returns files up to 1,000,000 bytes")).toBe(true);
		});

		test("rejects path traversal, injected query strings and bad refs before any request", async () => {
			const mock = installFetchMock({});
			restore = mock.restore;
			expect((text(await read.execute({ repo: "acme/widget", path: "../../etc/passwd" }, context))).startsWith('ERROR: path "../../etc/passwd" contains an empty or dot segment')).toBe(true);
			expect(text(await read.execute({ repo: "acme/widget", path: "src?ref=main" }, context))).toBe("ERROR: path may not contain control characters, backslashes, ? or #");
			for (const ref of ["main?x=1", "main#frag", "main%2F..%2Fx", "main/../../secret", "a//b", "release/", "v1.", "x/.hidden", "x.lock/y", "a@{1}", "@", "-x", "a b"]) {
				expect((text(await read.execute({ repo: "acme/widget", path: "src", ref }, context))).startsWith(`ERROR: ref "${ref}" is not a valid`)).toBe(true);
			}
			expect(mock.calls).toHaveLength(0);
		});

		test("accepts package-style release tags and underscored branches as refs and URL-encodes them", async () => {
			const mock = installFetchMock({
				...readRoutes({ type: "file", encoding: "base64", size: 3, sha: "blob1", content: Buffer.from("ok\n").toString("base64") }),
				"/repos/acme/widget/commits/effect%404.0.0-rc.115": { sha: commitSha },
				"/repos/acme/widget/commits/release_2024%2Bbuild.7": { sha: commitSha },
				"/repos/acme/widget/commits/%40effect%2Fplatform%400.1.0": { sha: commitSha },
				"/repos/acme/widget/commits/_maintenance": { sha: commitSha },
			});
			restore = mock.restore;
			for (const ref of ["effect@4.0.0-rc.115", "release_2024+build.7", "@effect/platform@0.1.0", "_maintenance"]) {
				const result = await read.execute({ repo: "acme/widget", path: "src/index.ts", ref }, context);
				expect(text(result)).toContain(`GitHub file: src/index.ts — acme/widget @ ${ref} → commit ${commitSha}`);
				expect(details(result)).toMatchObject({ ref, commit: commitSha });
			}
			expect(mock.calls.filter((call) => call.url.pathname.startsWith("/repos/acme/widget/commits/")).map((call) => call.url.pathname)).toEqual([
				"/repos/acme/widget/commits/effect%404.0.0-rc.115",
				"/repos/acme/widget/commits/release_2024%2Bbuild.7",
				"/repos/acme/widget/commits/%40effect%2Fplatform%400.1.0",
				"/repos/acme/widget/commits/_maintenance",
			]);
		});

		test("refuses private repositories and unknown refs", async () => {
			const mock = installFetchMock({
				"/repos/acme/secret": { ...publicRepo, full_name: "acme/secret", private: true },
				"/repos/acme/widget": publicRepo,
				"/repos/acme/widget/commits/nope": json({ message: "No commit found for SHA: nope" }, { status: 422 }),
			});
			restore = mock.restore;
			expect(text(await read.execute({ repo: "acme/secret", path: "README.md" }, context))).toBe("ERROR: GitHub repository acme/secret is not public; github tools read public repositories only");
			expect(text(await read.execute({ repo: "acme/widget", path: "README.md", ref: "nope" }, context))).toBe('ERROR: ref "nope" was not found in acme/widget');
			expect(mock.calls.map((call) => call.url.pathname)).toEqual(["/repos/acme/secret", "/repos/acme/widget", "/repos/acme/widget/commits/nope"]);
		});
	});
});
