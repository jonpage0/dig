import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import { executeSource } from "../outcome.js";
import type { SourceToolResult, ToolContext } from "../types.js";
import { contents, research, search, similar } from "./exa.js";

type FetchCall = { url: URL; headers: Headers; body: Record<string, unknown> };
type Reply = { status?: number; headers?: Record<string, string>; payload: unknown };
type Route = Reply | ((call: FetchCall) => Reply);

const context: ToolContext = {
	sessionID: "exa-test",
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

function installFetchMock(routes: Record<string, Route>) {
	const calls: FetchCall[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof URL ? input : new URL(String(input));
		const call = { url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : {} };
		calls.push(call);
		const route = routes[url.pathname];
		if (route === undefined) return new Response("not found", { status: 404 });
		const { status = 200, headers = {}, payload } = typeof route === "function" ? route(call) : route;
		return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", ...headers } });
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

const page = {
	title: "Exa Deep Search",
	url: "https://exa.ai/docs/search/deep-search",
	id: "https://exa.ai/docs/search/deep-search",
	publishedDate: "2026-03-04T00:00:00.000Z",
	highlights: ["Deep Search is the research mode of the Search API."],
};

describe("exa tools", () => {
	const savedKey = process.env.EXA_API_KEY;
	let restore: (() => void) | undefined;

	beforeEach(() => {
		process.env.EXA_API_KEY = "exa-test-key";
	});

	afterEach(() => {
		restore?.();
		restore = undefined;
		if (savedKey === undefined) delete process.env.EXA_API_KEY;
		else process.env.EXA_API_KEY = savedKey;
	});

	test("research posts one deep-reasoning /search with a text outputSchema and renders grounding", async () => {
		const mock = installFetchMock({
			"/search": {
				payload: {
					requestId: "req-1",
					results: [page],
					costDollars: { total: 0.015 },
					searchTime: 18400,
					output: {
						content: "Deep Search runs iterative retrieval before synthesis.",
						grounding: [{ field: "content", citations: [{ title: page.title, url: page.url }], confidence: "high" }],
					},
				},
			},
		});
		restore = mock.restore;

		const result = await research.execute(
			{ query: "How does Exa Deep Search work?", systemPrompt: "Prefer official docs.", additionalQueries: ["exa deep-reasoning mode"] },
			context,
		);

		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]!.body).toEqual({
			query: "How does Exa Deep Search work?",
			type: "deep-reasoning",
			numResults: 10,
			outputSchema: { type: "text" },
			contents: { highlights: { query: "How does Exa Deep Search work?" } },
			systemPrompt: "Prefer official docs.",
			additionalQueries: ["exa deep-reasoning mode"],
		});
		expect(mock.calls[0]!.headers.get("x-api-key")).toBe("exa-test-key");
		expect(mock.calls[0]!.headers.get("exa-beta")).toBeNull();
		const out = text(result);
		expect(out).toContain("Deep Search runs iterative retrieval before synthesis.");
		expect(out).toContain("- `content` — confidence high: Exa Deep Search <https://exa.ai/docs/search/deep-search>");
		expect(out).toContain("### Selected sources (1)");
		expect(out).toContain("> Deep Search is the research mode of the Search API.");
		expect(details(result)).toMatchObject({ provider: "exa", requestId: "req-1", synthesized: true, grounding: 1, citations: [page.url] });
	});

	test("research says plainly when Exa returns pages without a synthesis", async () => {
		const mock = installFetchMock({ "/search": { payload: { requestId: "req-2", results: [page] } } });
		restore = mock.restore;
		const result = await research.execute({ query: "x" }, context);
		const out = text(result);
		expect((out).startsWith("ERROR:")).toBe(false);
		expect(out).toContain("Exa returned no synthesized output for this request");
		expect(details(result)).toMatchObject({ synthesized: false, grounding: 0 });
	});

	test("search sends the beta header only when dynamic highlights are selected", async () => {
		const mock = installFetchMock({ "/search": { payload: { requestId: "r", results: [page] } } });
		restore = mock.restore;

		await search.execute({ query: "solar costs", type: "fast", maxAgeHours: 24 }, context);
		await search.execute({ query: "solar costs", dynamicHighlights: true }, context);

		expect(mock.calls[0]!.headers.get("exa-beta")).toBeNull();
		expect(mock.calls[0]!.body).toEqual({
			query: "solar costs",
			numResults: 10,
			type: "fast",
			contents: { text: { maxCharacters: 3000 }, highlights: { query: "solar costs" }, maxAgeHours: 24 },
		});
		expect(mock.calls[1]!.headers.get("exa-beta")).toBe("dynamic-highlights-2026-08-28");
		expect(mock.calls[1]!.body.contents).toEqual({ text: { maxCharacters: 3000 }, highlights: { query: "solar costs", dynamic: true } });
	});

	test("search rejects incompatible highlight options and unknown modes before spending", async () => {
		const mock = installFetchMock({});
		restore = mock.restore;
		expect((text(await search.execute({ query: "q", dynamicHighlights: true, highlightMaxCharacters: 500 }, context))).startsWith("ERROR: highlightMaxCharacters cannot be combined with dynamicHighlights")).toBe(true);
		expect(text(await search.execute({ query: "q", type: "neural" }, context))).toBe(
			"ERROR: type must be one of instant, fast, auto, deep-lite, deep, deep-reasoning.",
		);
		expect(text(await search.execute({ query: "q", maxAgeHours: 1000 }, context))).toBe("ERROR: maxAgeHours must be an integer from -1 to 720.");
		expect(mock.calls).toHaveLength(0);
	});

	test("search surfaces the Exa error envelope with its tag and request id", async () => {
		const mock = installFetchMock({
			"/search": { status: 400, payload: { requestId: "bad-1", error: "excludeDomains is not supported for category people", tag: "INVALID_REQUEST" } },
		});
		restore = mock.restore;
		expect(text(await search.execute({ query: "q", category: "people", excludeDomains: ["x.com"] }, context))).toBe(
			"ERROR: Exa search failed: Exa /search returned HTTP 400 (INVALID_REQUEST): excludeDomains is not supported for category people [request bad-1]",
		);
	});

	test("a 2xx envelope without a results array or carrying an error is a provider failure, not empty evidence", async () => {
		const mock = installFetchMock({
			"/search": (call) => (call.body.query === "empty" ? { payload: {} } : { payload: { requestId: "x", error: "upstream degraded", tag: "INTERNAL_ERROR" } }),
		});
		restore = mock.restore;
		expect(text(await search.execute({ query: "empty" }, context))).toBe(
			"ERROR: Exa search failed: Exa /search returned an unexpected payload: no results array",
		);
		expect(text(await search.execute({ query: "degraded" }, context))).toBe(
			"ERROR: Exa search failed: Exa /search returned HTTP 200 (INTERNAL_ERROR): upstream degraded [request x]",
		);
	});

	test("provider error text never carries the API key", async () => {
		const mock = installFetchMock({ "/search": { status: 401, payload: { requestId: "k", error: "invalid key exa-test-key", tag: "INVALID_API_KEY" } } });
		restore = mock.restore;
		const out = text(await search.execute({ query: "q" }, context));
		expect(out).not.toContain("exa-test-key");
		expect(out).toContain("[EXA_API_KEY redacted]");
	});

	test("contents reports per-URL failures and URLs Exa never accounted for", async () => {
		const mock = installFetchMock({
			"/contents": {
				payload: {
					requestId: "c-1",
					results: [{ ...page, text: "Full page text." }],
					statuses: [
						{ id: page.url, status: "success", source: "cached" },
						{ id: "https://example.com/missing", status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } },
					],
					costDollars: { total: 0.002 },
				},
			},
		});
		restore = mock.restore;

		const result = await contents.execute(
			{ urls: [page.url, "https://example.com/missing", "https://example.com/silent"], query: "deep search", summary: true },
			context,
		);

		expect(mock.calls[0]!.body).toEqual({
			urls: [page.url, "https://example.com/missing", "https://example.com/silent"],
			text: { maxCharacters: 5000 },
			highlights: { query: "deep search" },
			summary: { query: "deep search" },
		});
		const out = text(result);
		expect(out).toContain("Content extracted for 1 of 3 requested URLs");
		expect(out).toContain("- https://example.com/missing — CRAWL_NOT_FOUND (HTTP 404)");
		expect(out).toContain("Not returned and no status reported by Exa:\n- https://example.com/silent");
		expect(out).toContain("**Page text (15 characters returned against a 5000-character request; completeness not established):**");
		expect(out).toContain("Full page text.");
		expect(details(result)).toMatchObject({ requested: 3, failed: ["https://example.com/missing"], unaccounted: ["https://example.com/silent"] });
	});

	test("contents per-URL failure diagnostics never carry the API key", async () => {
		const mock = installFetchMock({
			"/contents": {
				payload: {
					requestId: "c-2",
					results: [],
					statuses: [{ id: "https://example.invalid/?k=exa-test-key", status: "error", error: { tag: "exa-test-key", httpStatusCode: 401 } }],
				},
			},
		});
		restore = mock.restore;

		const result = await contents.execute({ urls: ["https://example.invalid/"] }, context);

		const out = text(result);
		expect(out).not.toContain("exa-test-key");
		expect(out).toContain("- https://example.invalid/?k=[EXA_API_KEY redacted] — [EXA_API_KEY redacted] (HTTP 401)");
		expect(JSON.stringify(details(result))).not.toContain("exa-test-key");
		expect(details(result)).toMatchObject({ failed: ["https://example.invalid/?k=[EXA_API_KEY redacted]"] });
	});

	test("similar uses excludeSourceDomain and caps numResults at the public limit with a note", async () => {
		const mock = installFetchMock({ "/findSimilar": { payload: { requestId: "s-1", results: [page] } } });
		restore = mock.restore;
		const out = text(await similar.execute({ url: page.url, numResults: 250, excludeSourceDomain: true, contents: false }, context));
		expect(mock.calls[0]!.body).toEqual({ url: page.url, numResults: 100, excludeSourceDomain: true });
		expect(out).toContain("Note: numResults 250 exceeds Exa's public limit; capped at 100.");
	});

	test("a canceled call is reported as a cancellation, not a provider failure", async () => {
		const controller = new AbortController();
		controller.abort();
		const mock = installFetchMock({});
		restore = mock.restore;
		const out = text(await search.execute({ query: "q" }, { ...context, abort: controller.signal }));
		expect(out).toBe("ERROR: Exa search canceled before completion; not a provider failure.");
		expect(mock.calls).toHaveLength(0);
	});

	test("the call's cost is Exa's reported costDollars.total; an unpriced error envelope stays unknown", async () => {
		const mock = installFetchMock({
			"/search": (call) =>
				call.body.query === "rejected"
					? { status: 400, payload: { requestId: "bad", error: "invalid request", tag: "INVALID_REQUEST" } }
					: { payload: { requestId: "paid", results: [page], costDollars: { total: 0.015 } } },
		});
		restore = mock.restore;

		const paid = await executeSource(search, { query: "priced" }, context);
		expect(paid.status).toBe("success");
		expect(paid.details).toMatchObject({ cost: [{ amount: 0.015, unit: "USD" }] });
		expect(paid.details?.knownCost).toBeUndefined();

		const rejected = await executeSource(search, { query: "rejected" }, context);
		expect(rejected.status).toBe("failed");
		expect(rejected.details?.cost).toBeNull();
		expect(rejected.details?.knownCost).toBeUndefined();
	});

	test("a retried attempt without costDollars leaves the total unknown and keeps the reported subtotal", async () => {
		let attempts = 0;
		const mock = installFetchMock({
			"/search": () =>
				++attempts === 1
					? { status: 503, headers: { "retry-after": "0" }, payload: { requestId: "busy", error: "Service unavailable", tag: "SERVICE_UNAVAILABLE" } }
					: { payload: { requestId: "retried", results: [page], costDollars: { total: 0.007 } } },
		});
		restore = mock.restore;

		const result = await executeSource(search, { query: "solar costs" }, context);
		expect(mock.calls).toHaveLength(2);
		expect(result.status).toBe("success");
		expect(result.details?.cost).toBeNull();
		expect(result.details?.knownCost).toEqual([{ amount: 0.007, unit: "USD" }]);
	});
});
