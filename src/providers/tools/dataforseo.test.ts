import { afterEach, beforeEach, test } from "node:test";
import { expect } from "expect";
import { executeSource } from "../outcome.js";
import { knownSecrets } from "../secrets.js";
import type { ToolContext } from "../types.js";
import { docs_index, docs_read, request } from "./dataforseo.js";

const originalFetch = globalThis.fetch;
const saved = { DATAFORSEO_USERNAME: process.env.DATAFORSEO_USERNAME, DATAFORSEO_PASSWORD: process.env.DATAFORSEO_PASSWORD };
const LOGIN = "analyst@example.com";
const PASSWORD = "dfs-test-password-9f2c";

beforeEach(() => {
	process.env.DATAFORSEO_USERNAME = LOGIN;
	process.env.DATAFORSEO_PASSWORD = PASSWORD;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

const context: ToolContext = {
	sessionID: "dataforseo-test",
	directory: "/tmp",
	worktree: "/tmp",
	abort: new AbortController().signal,
	keep: () => {},
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
function installFetch(respond: (call: Call) => Response): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		const call = { url: String(input), method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) }, body: init?.body ? JSON.parse(String(init.body)) : undefined };
		calls.push(call);
		return respond(call);
	}, { preconnect: originalFetch.preconnect });
	return calls;
}

const envelope = (tasks: object[], cost: number) => ({
	version: "0.1.20261001", status_code: 20000, status_message: "Ok.", time: "1.2 sec.", cost,
	tasks_count: tasks.length, tasks_error: tasks.filter((task: any) => task.status_code !== 20000).length, tasks,
});

test("a live request sends the task array with Basic auth once and records the USD cost DataForSEO reported", async () => {
	const calls = installFetch(() => Response.json(envelope([
		{ id: "t-1", status_code: 20000, status_message: "Ok.", cost: 0.002, result_count: 1, data: { keyword: "espresso" }, result: [{ keyword: "espresso", items: [{ rank_group: 1, domain: "example.com", description: null, links: [] }] }] },
		{ id: "t-2", status_code: 40501, status_message: "Invalid Field: 'location_code'.", cost: 0, result_count: 0, result: null },
	], 0.002)));
	const tasks = [{ keyword: "espresso", location_code: 2840, language_code: "en" }, { keyword: "espresso", location_code: -1 }];
	const result = await executeSource(request, { path: "/v3/serp/google/organic/live/advanced", tasks }, context);

	expect(calls).toHaveLength(1);
	expect(calls[0]).toMatchObject({ url: "https://api.dataforseo.com/v3/serp/google/organic/live/advanced", method: "POST", body: tasks });
	expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64")}`);
	expect(result.status).toBe("partial");
	expect(result.details?.cost).toEqual([{ amount: 0.002, unit: "USD" }]);
	expect(result.text).toContain("Task t-2: 40501 Invalid Field: 'location_code'.");
	expect(result.text).toContain('"domain":"example.com"');
	// Null and empty fields are trimmed from the model's view, as DataForSEO's .ai responses would.
	expect(result.text).not.toMatch(/"description"|"links"/);
	expect(JSON.stringify(result)).not.toContain(PASSWORD);
});

test("a response without a reported cost is unknown, is not retried, and fails", async () => {
	const calls = installFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
	const result = await executeSource(request, { path: "serp/google/organic/live/advanced", tasks: [{ keyword: "espresso" }] }, context);
	expect(calls).toHaveLength(1);
	expect(result.status).toBe("failed");
	expect(result.details?.cost).toBeNull();
	expect(result.details?.knownCost).toBeUndefined();
});

test("trimmed .ai paths, path escapes and missing credentials are refused before any request", async () => {
	const calls = installFetch(() => Response.json(envelope([], 0)));
	for (const path of ["serp/google/organic/live/advanced.ai", "serp/../appendix/user_data"]) {
		const refused = await executeSource(request, { path, tasks: [{ keyword: "x" }] }, context);
		expect(refused.status).toBe("failed");
	}
	delete process.env.DATAFORSEO_PASSWORD;
	const missing = await executeSource(request, { path: "serp/google/organic/live/advanced", tasks: [{ keyword: "x" }] }, context);
	expect(missing.status).toBe("failed");
	expect(missing.text).toContain("DATAFORSEO_PASSWORD");
	expect(calls).toHaveLength(0);
});

test("sandbox requests go to the sandbox host and are labelled as dummy data", async () => {
	const calls = installFetch(() => Response.json(envelope([{ id: "s-1", status_code: 20000, status_message: "Ok.", cost: 0, result_count: 1, result: [{ items_count: 1 }] }], 0)));
	const result = await executeSource(request, { path: "serp/google/organic/live/advanced", tasks: [{ keyword: "x" }], sandbox: true }, context);
	expect(calls[0].url).toBe("https://sandbox.dataforseo.com/v3/serp/google/organic/live/advanced");
	expect(result.text).toContain("sandbox: free dummy data, not evidence");
	expect(result.details?.cost).toEqual([]);
});

test("documented task codes keep their meaning: 40102 is empty, 40106 is partial, 40602 is not ready yet", async () => {
	const run = async (task: object) => {
		installFetch(() => Response.json(envelope([{ id: "t", cost: 0.004, result_count: 0, ...task }], 0.004)));
		return executeSource(request, { path: "serp/google/organic/live/advanced", tasks: [{ keyword: "x" }] }, context);
	};
	expect((await run({ status_code: 40102, status_message: "No Search Results.", result: null })).status).toBe("empty");
	const partial = await run({ status_code: 40106, status_message: "Task completed with partial results.", result: [{ items: [{ rank_group: 1 }] }] });
	expect(partial.status).toBe("partial");
	expect(partial.details?.cost).toEqual([{ amount: 0.004, unit: "USD" }]);
	const queued = await run({ status_code: 40602, status_message: "Task In Queue.", result: null });
	expect(queued.status).toBe("success");
	expect(queued.text).toContain("task_get");
});

test("a redirect is reported instead of followed, leaving the cost unknown; the docs reader refuses a redirect off the docs host", async () => {
	const calls = installFetch(() => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/v3/serp" } }));
	const api = await executeSource(request, { path: "serp/google/organic/live/advanced", tasks: [{ keyword: "x" }] }, context);
	expect(calls).toHaveLength(1);
	expect(api.status).toBe("failed");
	expect(api.text).toContain("does not follow redirects");
	expect(api.details?.cost).toBeNull();

	const docsCalls = installFetch(() => new Response(null, { status: 301, headers: { location: "https://elsewhere.example/auth.md" } }));
	const docs = await executeSource(docs_read, { path: "auth" }, context);
	expect(docsCalls.map((call) => new URL(call.url).host)).toEqual(["docs.dataforseo.com"]);
	expect(docs.status).toBe("failed");
});

test("a password echoed in a response is redacted before the output is serialized and truncated", async () => {
	// A quote makes JSON escaping change the password's text, which exact-match redaction after serialization would miss.
	process.env.DATAFORSEO_PASSWORD = 'dfs"quoted-pass-77';
	installFetch(() => Response.json(envelope([{
		id: "t-echo", status_code: 20000, status_message: "Ok.", cost: 0.001, result_count: 1,
		result: [{ echoed: process.env.DATAFORSEO_PASSWORD, filler: "x".repeat(60_000) }],
	}], 0.001)));
	const result = await executeSource(request, { path: "serp/google/organic/live/advanced", tasks: [{ keyword: "x" }] }, context);
	expect(result.text).toContain("[Truncated at 60000");
	expect(result.text).toContain('"echoed":"[redacted]"');
	expect(result.text).not.toContain("quoted-pass");
});

const INDEX = [
	"Docs DataForSEO V3",
	"",
	"- [Authentication](https://docs.dataforseo.com/v3/auth.md) — Use your API login and password.",
	"## SERP API",
	"### Google",
	"#### Organic",
	"##### Live",
	"- [Live Google Organic SERP Advanced](https://docs.dataforseo.com/v3/serp/google/organic/live/advanced.md) — ![checked](https://docs.dataforseo.com/v3/icon.svg) Real-time [top results](https://example.com) for a keyword.",
	"## DataForSEO Labs API",
	"- [Keyword Ideas](https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live.md) — Keyword ideas for seed keywords.",
].join("\n");

test("the docs index filters by section and words and returns readable paths; the docs reader pages a page and fails on a missing one", async () => {
	installFetch((call) => call.url.endsWith("llms.txt")
		? new Response(INDEX)
		: call.url.endsWith("live/advanced.md")
			? new Response("# Live Google Organic SERP Advanced\nPOST https://api.dataforseo.com/v3/serp/google/organic/live/advanced")
			: new Response("Not found", { status: 404 }));
	const index = await executeSource(docs_index, { section: "serp", query: "organic live" }, context);
	expect(index.status).toBe("success");
	expect(index.text).toContain("- Live Google Organic SERP Advanced — serp/google/organic/live/advanced — SERP API › Google › Organic › Live — Real-time top results for a keyword.");
	expect(index.text).not.toContain("Keyword Ideas");
	expect(index.details?.cost).toEqual([]);

	const page = await executeSource(docs_read, { path: "https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/", limit: 10 }, context);
	expect(page.text).toContain("characters 0–10 of");
	expect(page.text).toContain("continue at offset 10");
	const missing = await executeSource(docs_read, { path: "serp/google/organic/live/nonexistent" }, context);
	expect(missing.status).toBe("failed");
});

test("the DataForSEO password is a known secret for redaction; the API login is not", () => {
	expect(knownSecrets()).toContain(PASSWORD);
	expect(knownSecrets()).not.toContain(LOGIN);
});
