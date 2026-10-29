import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "expect";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { executeSource } from "../outcome.js";
import { createSchemas } from "../schemas.js";
import type { ToolContext } from "../types.js";
import { search } from "./xsearch.js";

const originalFetch = globalThis.fetch;
const saved = { XAI_API_KEY: process.env.XAI_API_KEY, DIG_STATE_DIR: process.env.DIG_STATE_DIR };
let root: string;

beforeEach(() => {
	// Default [x] settings come from an isolated, empty native state directory.
	root = mkdtempSync(join(tmpdir(), "dig-xsearch-test-"));
	process.env.DIG_STATE_DIR = root;
	process.env.XAI_API_KEY = "xai-test-key";
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

const context: ToolContext = {
	sessionID: "xsearch-test",
	directory: "/tmp",
	worktree: "/tmp",
	abort: new AbortController().signal,
	keep: () => {},
};

const complete = (overrides: Record<string, unknown> = {}) => ({
	id: "r-new",
	status: "completed",
	output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: "A readable finding." }] }],
	usage: { total_tokens: 12, cost_in_usd_ticks: 50000000 },
	...overrides,
});

test("a charged chained storage-limit failure is retained without a context-losing retry", async () => {
	const bodies: any[] = [];
	const retained: unknown[][] = [];
	const failure = { error: { message: "Response is too large to store" }, usage: { total_tokens: 12, cost_in_usd_ticks: 123400000 } };
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		return bodies.length === 1 ? Response.json(failure, { status: 400 }) : Response.json(complete());
	}) as typeof fetch;
	const result = await executeSource(search, { query: "Now compare the opposing view.", previousResponseId: "r-prior" }, {
		...context, keep: (...args) => { retained.push(args); },
	});
	expect(bodies).toHaveLength(1);
	expect(bodies[0].previous_response_id).toBe("r-prior");
	expect(result.status).toBe("failed");
	expect(result.text).toContain("chained request was not retried without its previous response context");
	expect(result.text).not.toContain("Chained from:");
	expect(result.details?.cost).toEqual([{ amount: 0.01234, unit: "USD" }]);
	expect(retained).toEqual([["x_search", 400, failure]]);
});

test("an unchained storage-limit retry keeps its full standalone input and all reported charges", async () => {
	const bodies: any[] = [];
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		return bodies.length === 1
			? Response.json({ error: { message: "Response is too large to store" }, usage: { total_tokens: 12, cost_in_usd_ticks: 123400000 } }, { status: 400 })
			: Response.json(complete());
	}) as typeof fetch;
	const result = await executeSource(search, { query: "A complete standalone question." }, context);
	expect(bodies).toHaveLength(2);
	expect(bodies[0].input.map((value: any) => value.role)).toEqual(["system", "user"]);
	expect(bodies[1].input).toEqual(bodies[0].input);
	expect(bodies[1].store).toBe(false);
	expect(result.status).toBe("success");
	expect(result.details?.cost).toEqual([{ amount: 0.01734, unit: "USD" }]);
	expect(result.text).toContain("- Store: false");
});

test("a reasoning-parameter retry preserves a chained request's prior response", async () => {
	const bodies: any[] = [];
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		return bodies.length === 1
			? Response.json({ error: { message: "reasoning effort is not supported" }, usage: { total_tokens: 0, cost_in_usd_ticks: 0 } }, { status: 400 })
			: Response.json(complete());
	}) as typeof fetch;
	const result = await executeSource(search, { query: "A follow-up question.", previousResponseId: "r-prior" }, context);
	expect(bodies.map(value => value.previous_response_id)).toEqual(["r-prior", "r-prior"]);
	expect(bodies[1].input).toEqual(bodies[0].input);
	expect(bodies[1].reasoning).toBeUndefined();
	expect(result.status).toBe("success");
	expect(result.text).toContain("- Chained from: r-prior");
});

test("incomplete response or message status preserves readable evidence as partial with reported usage", async () => {
	for (const variant of [
		{ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
		{ output: [{ type: "message", status: "incomplete", content: [{ type: "output_text", text: "A partial finding." }] }] },
	]) {
		let calls = 0;
		globalThis.fetch = (async () => { calls += 1; return Response.json(complete(variant)); }) as typeof fetch;
		const result = await executeSource(search, { query: "A bounded question." }, context);
		expect(calls).toBe(1);
		expect(result.status).toBe("partial");
		expect(result.text).toContain("finding.");
		expect(result.text).toContain("**Incomplete response:**");
		expect(result.details?.cost).toEqual([{ amount: 0.005, unit: "USD" }]);
	}
});

test("an incomplete response without readable text fails while retaining its reported cost", async () => {
	globalThis.fetch = (async () => Response.json(complete({ status: "incomplete", output: [] }))) as typeof fetch;
	const result = await executeSource(search, { query: "No readable result." }, context);
	expect(result.status).toBe("failed");
	expect(result.text).toContain("incomplete response with no readable content");
	expect(result.details?.cost).toEqual([{ amount: 0.005, unit: "USD" }]);
});

test("oversized handle scopes are rejected by the schema and runtime before a request", async () => {
	const schema = createSchemas(Type).xsearch;
	let calls = 0;
	globalThis.fetch = (async () => { calls += 1; return Response.json(complete()); }) as typeof fetch;
	for (const field of ["handles", "excludeHandles"]) {
		const args = { query: "A scoped question.", [field]: Array.from({ length: 21 }, (_, index) => `person${index}`) };
		expect(Value.Check(schema, args)).toBe(false);
		const result = await executeSource(search, args, context);
		expect(result.status).toBe("failed");
		expect(result.text).toContain("at most 20 handles");
	}
	expect(calls).toBe(0);
});

test("all twenty allowed or excluded handles are forwarded and reported", async () => {
	const bodies: any[] = [];
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body))); return Response.json(complete());
	}) as typeof fetch;
	const handles = Array.from({ length: 20 }, (_, index) => `@person${index}`);
	for (const [field, providerField] of [["handles", "allowed_x_handles"], ["excludeHandles", "excluded_x_handles"]]) {
		const args = { query: "A scoped question.", [field]: handles };
		expect(Value.Check(createSchemas(Type).xsearch, args)).toBe(true);
		const result = await executeSource(search, args, context);
		expect(result.status).toBe("success");
		expect(bodies.at(-1).tools[0][providerField]).toEqual(handles.map(value => value.slice(1)));
		expect(result.text).toContain("person19");
	}
});

test("date-time strings, invalid dates and empty or reversed ranges are rejected before retrieval", async () => {
	let calls = 0;
	globalThis.fetch = (async () => { calls += 1; return Response.json(complete()); }) as typeof fetch;
	const invalid = [
		{ fromDate: "2026-10-28T00:00:00Z" }, { toDate: "2026-02-30" }, { fromDate: "" },
		{ fromDate: "2026-10-28", toDate: "2026-10-28" }, { fromDate: "2026-10-29", toDate: "2026-10-28" },
	];
	for (const dates of invalid) {
		const result = await executeSource(search, { query: "Date-constrained research.", ...dates }, context);
		expect(result.status).toBe("failed");
	}
	expect(calls).toBe(0);
	expect(Value.Check(createSchemas(Type).xsearch, { query: "Date-constrained research.", fromDate: "2026-10-28T00:00:00Z" })).toBe(false);
});

test("single-day UTC boundaries remain explicit in the request and returned scope", async () => {
	let body: any;
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return Response.json(complete()); }) as typeof fetch;
	const result = await executeSource(search, { query: "One day.", fromDate: "2026-10-28", toDate: "2026-10-29" }, context);
	expect(result.status).toBe("success");
	expect(body.tools[0].from_date).toBe("2026-10-28");
	expect(body.tools[0].to_date).toBe("2026-10-29");
	for (const input of body.input) {
		expect(input.content).toContain("from 2026-10-28 00:00 UTC (inclusive)");
		expect(input.content).toContain("before 2026-10-29 00:00 UTC (exclusive)");
	}
	expect(result.text).toContain("- Date Range: from 2026-10-28 00:00 UTC (inclusive); before 2026-10-29 00:00 UTC (exclusive)");
});

test("a transport failure after a charged storage-limit response leaves the total unknown and keeps the reported USD subtotal", async () => {
	let calls = 0;
	globalThis.fetch = (async () => {
		if (++calls === 1) {
			return Response.json(
				{ error: { message: "Response is too large to store" }, usage: { total_tokens: 12, cost_in_usd_ticks: 123400000 } },
				{ status: 400 },
			);
		}
		throw new TypeError("fetch failed");
	}) as typeof fetch;

	const result = await executeSource(search, { query: "storage limit" }, context);
	expect(calls).toBe(2);
	expect(result.status).toBe("failed");
	expect(result.details?.cost).toBeNull();
	expect(result.details?.knownCost).toEqual([{ amount: 0.01234, unit: "USD" }]);
});

test("the default model receives the requested depth as reasoning effort", async () => {
	const bodies: Array<{ model: string; reasoning?: { effort: string } }> = [];
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		return Response.json({ error: { message: "stop after the request" } });
	}) as typeof fetch;
	await executeSource(search, { query: "depth" }, context);
	await executeSource(search, { query: "depth", depth: "max" }, context);
	expect(bodies.map((body) => [body.model, body.reasoning?.effort])).toEqual([["grok-4.7", "medium"], ["grok-4.7", "high"]]);
});

test("a write-up that cites posts by number is flagged; links, references, code and years are not", async () => {
	const reply = (text: string) => (async () => Response.json({ id: "r", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { total_tokens: 1, cost_in_usd_ticks: 1 } })) as typeof fetch;
	globalThis.fetch = reply("According to [post:50]: the skills work. Oren posts the result [120] and [118], as do [3, 5].");
	const numbered = await executeSource(search, { query: "numbered" }, context);
	expect(numbered.status).toBe("success");
	expect(numbered.text).toContain("this write-up has 4 bracketed markers that look like citations by number (such as [post:50]) but no link for them");
	globalThis.fetch = reply(
		"Alex shows the skills [1](https://x.com/The_Alex/status/1). Ethan edits raw footage [[3]](https://x.com/Ethan_Ng_13/status/3 \"post\"). " +
			"Oren posts the result [2] and [4][oren]; the fix is `items[0]`, shipped in [2026].\n\n[2]: https://x.com/orenmeetsworld/status/2\n[oren]: https://x.com/orenmeetsworld/status/4",
	);
	const linked = await executeSource(search, { query: "linked" }, context);
	expect(linked.text).not.toContain("Citations by number");
});
