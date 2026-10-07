import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { expect } from "expect";
import { executeSource } from "../outcome.js";
import type { SourceToolResult, ToolContext } from "../types.js";
import { openalex_search, semantic_scholar_search, semantic_scholar_recommendations } from "./papers.js";

const text = (result: SourceToolResult) => (typeof result === "string" ? result : result.text);

const context: ToolContext = { sessionID: "papers-test", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, keep: () => {} };
const keys = ["OPENALEX_API_KEY", "PAPER_SEARCH_MCP_OPENALEX_API_KEY", "SEMANTIC_SCHOLAR_API_KEY", "PAPER_SEARCH_MCP_SEMANTIC_SCHOLAR_API_KEY"];
const saved = new Map(keys.map(key => [key, process.env[key]]));
type FetchMock = ReturnType<typeof mock.method<typeof globalThis, "fetch">>;
let fetchMock: FetchMock;

function mockFetch(implementation: typeof fetch) {
	fetchMock.mock.mockImplementation(implementation);
}

beforeEach(() => {
	for (const key of keys) delete process.env[key];
	// Every test installs its own response; an unexpected request fails instead of reaching a provider.
	fetchMock = mock.method(globalThis, "fetch", async () => {
		throw new Error("unmocked fetch");
	});
});
afterEach(() => {
	fetchMock.mock.restore();
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("papers provider outcomes", () => {
	test("reports the actual keyless OpenAlex budget and the charge it reports even when the completed search is empty", async () => {
		const response = new Response(JSON.stringify({ results: [], meta: { cost_usd: 0.001 } }), {
			headers: { "x-ratelimit-limit": "1000", "x-ratelimit-remaining": "0", "x-ratelimit-credits-used": "10", "x-ratelimit-reset": "60" },
		});
		mockFetch(async () => response);
		const result = await executeSource(openalex_search, { query: "absent" }, context);
		expect(result.details?.cost).toEqual([{ amount: 0.001, unit: "USD" }]);
		expect(result.text).toContain("No OpenAlex works found");
		expect(result.text).toContain("remaining credits: 0");
		expect(result.text).toContain("request USD: 0.001");
		expect(result.text).toContain("keyless");
	});

	test("an OpenAlex response without valid billing stays unknown, including invalid billing on an error", async () => {
		for (const [body, status] of [
			[{ results: [{ id: "https://openalex.org/W1", display_name: "Reported work" }] }, 200],
			[{ results: [], meta: { cost_usd: -1 } }, 200],
			[{ error: "provider unavailable", meta: {} }, 200],
			[{ error: "quota", meta: { cost_usd: -1 } }, 429],
		] as const) {
			mockFetch(async () => new Response(JSON.stringify(body), { status }));
			const result = await executeSource(openalex_search, { query: "test" }, context);
			expect(result.details?.cost).toBeNull();
			expect(result.details?.knownCost).toBeUndefined();
		}
	});

	test("authenticates with the configured alias without disclosing a key in error output or URLs", async () => {
		process.env.PAPER_SEARCH_MCP_OPENALEX_API_KEY = "fixture-secret";
		mockFetch(async (input, init) => {
			expect(String(input)).not.toContain("fixture-secret");
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-secret");
			return new Response('{"error":"fixture-secret rejected"}', { status: 429 });
		});
		const result = await executeSource(openalex_search, { query: "example" }, context);
		// OpenAlex documents every 4xx/5xx response as costing nothing.
		expect(result.details?.cost).toEqual([]);
		expect(result.text).toContain("HTTP 429");
		expect(result.text).toContain("not reported");
		expect(result.text).not.toContain("fixture-secret");
	});

	test("does not convert HTTP-200 error payloads into empty literature evidence", async () => {
		mockFetch(async () => new Response('{"error":"provider unavailable"}'));
		expect(text(await openalex_search.execute({ query: "test" }, context))).toMatch(/^ERROR:/);
		expect(text(await semantic_scholar_search.execute({ query: "test" }, context))).toMatch(/^ERROR:/);
		expect(text(await semantic_scholar_recommendations.execute({ positivePaperIds: ["seed"] }, context))).toMatch(/^ERROR:/);
	});

	test("a malformed abstract index leaves the work without an abstract instead of sizing an array from it", async () => {
		const work = (id: string, index: unknown) => ({ id: `https://openalex.org/${id}`, display_name: `Work ${id}`, abstract_inverted_index: index });
		mockFetch(async () => new Response(JSON.stringify({
			results: [work("W1", { Huge: [100000000] }), work("W2", { Fraction: [1.5] }), work("W3", { Readable: [0], abstract: [1] })],
			meta: { cost_usd: 0 },
		})));
		const result = await executeSource(openalex_search, { query: "test" }, context);
		expect(result.status).toBe("success");
		expect(result.text).toContain("Work W1");
		expect(result.text).toContain("Work W2");
		expect(result.text).not.toMatch(/Huge|Fraction/);
		expect(result.text).toContain("Readable abstract");
	});

	test("distinguishes anonymous throttling from configured-key throttling and honors blank aliases", async () => {
		mockFetch(async () => new Response("", { status: 429, headers: { "retry-after": "12" } }));
		const anonymous = text(await semantic_scholar_search.execute({ query: "test" }, context));
		expect(anonymous).toContain("shared anonymous pool");
		expect(anonymous).toContain("Retry-After: 12");
		process.env.SEMANTIC_SCHOLAR_API_KEY = "bare-key";
		process.env.PAPER_SEARCH_MCP_SEMANTIC_SCHOLAR_API_KEY = " ";
		mockFetch(async (_input, init) => {
			expect(new Headers(init?.headers).get("x-api-key")).toBe("bare-key");
			return new Response("", { status: 429 });
		});
		expect(text(await semantic_scholar_search.execute({ query: "test" }, context))).toContain("API key configured");
	});

	test("propagates cancellation instead of reporting a provider outage", async () => {
		const controller = new AbortController();
		controller.abort();
		mockFetch(async (_input, init) => {
			init?.signal?.throwIfAborted();
			throw new Error("expected an aborted request");
		});
		await expect(openalex_search.execute({ query: "test" }, { ...context, abort: controller.signal })).rejects.toThrow();
	});
});
