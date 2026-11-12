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
import { RECOVERY, search } from "./xsearch.js";

const originalFetch = globalThis.fetch;
const saved = { XAI_API_KEY: process.env.XAI_API_KEY, DIG_STATE_DIR: process.env.DIG_STATE_DIR };
const recoveryWaits = RECOVERY.waitsMs;
let root: string;

beforeEach(() => {
	// Default [x] settings come from an isolated, empty native state directory.
	root = mkdtempSync(join(tmpdir(), "dig-xsearch-test-"));
	process.env.DIG_STATE_DIR = root;
	process.env.XAI_API_KEY = "xai-test-key";
	// A cut stream is looked for twice, without waiting.
	RECOVERY.waitsMs = [0, 0];
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	RECOVERY.waitsMs = recoveryWaits;
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

test("an empty query is rejected by the schema", () => {
	expect(Value.Check(createSchemas(Type).xsearch, { query: "" })).toBe(false);
	expect(Value.Check(createSchemas(Type).xsearch, { query: "x" })).toBe(true);
});

test("failures are explicit failed outcomes, and an error body's message is read whether it is a string or an object", async () => {
	const refused = await search.execute({ query: "q", handles: ["a"], excludeHandles: ["b"] }, context);
	expect(refused).toEqual({ status: "failed", text: "ERROR: Cannot use both 'handles' and 'excludeHandles' - choose one" });
	for (const body of [{ code: "invalid-argument", error: "The query is malformed" }, { error: { message: "The query is malformed" } }]) {
		globalThis.fetch = (async () => Response.json(body, { status: 400 })) as typeof fetch;
		const result = await executeSource(search, { query: "malformed" }, context);
		expect(result.status).toBe("failed");
		expect(result.text).toBe("ERROR: The query is malformed (status 400)");
	}
});

test("a paid response without total_tokens keeps its finding", async () => {
	globalThis.fetch = (async () => Response.json(complete({ usage: { cost_in_usd_ticks: 50000000 } }))) as typeof fetch;
	const result = await executeSource(search, { query: "no token count" }, context);
	expect(result.status).toBe("success");
	expect(result.text).toContain("A readable finding.");
	expect(result.details?.cost).toEqual([{ amount: 0.005, unit: "USD" }]);
});

test("a transport failure names its cause and says the pass may still have been charged", async () => {
	globalThis.fetch = (async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }) }); }) as typeof fetch;
	const result = await executeSource(search, { query: "a long pass" }, context);
	expect(result.status).toBe("failed");
	expect(result.text).toMatch(/^ERROR: fetch failed \(UND_ERR_HEADERS_TIMEOUT\)\. /);
	expect(result.text).toContain("may still have run and been charged");
	expect(result.details?.cost).toBeNull();
});

/** A streamed answer: the given chunks as an event stream. */
const streamed = (chunks: string[]) => new Response(new ReadableStream({
	start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); },
}), { headers: { "content-type": "text/event-stream" } });
const record = (type: string, data: Record<string, unknown>, eol = "\n") => `event: ${type}${eol}data: ${JSON.stringify({ type, ...data })}${eol}${eol}`;
const deltas = record("response.created", { response: { id: "r-new", status: "in_progress", output: [] } }) + record("response.output_text.delta", { delta: "A readable " }) + record("response.output_text.delta", { delta: "finding." });
/** A stream that breaks after its first events have been read. */
const broken = () => {
	let sent = false;
	return new Response(new ReadableStream({
		pull(controller) { if (sent) return controller.error(new TypeError("terminated")); sent = true; controller.enqueue(new TextEncoder().encode(deltas)); },
	}), { headers: { "content-type": "text/event-stream" } });
};
/** xAI's answer to a read by an id it holds nothing under. */
const notStored = () => new Response(JSON.stringify({ code: "not-found", error: "Response with id=r-new not found" }), { status: 404 });

test("the request asks for a stream, and the terminal event's response is read and kept as the call's original", async () => {
	const bodies: any[] = [];
	const retained: unknown[][] = [];
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		return streamed([deltas, record("response.completed", { response: complete() }), "data: [DONE]\n\n"]);
	}) as typeof fetch;
	const result = await executeSource(search, { query: "streamed" }, { ...context, keep: (...args) => { retained.push(args); } });
	expect(bodies).toHaveLength(1);
	expect(bodies[0].stream).toBe(true);
	expect(result.status).toBe("success");
	expect(result.text).toContain("A readable finding.");
	expect(result.text).toContain("**response_id:** r-new");
	expect(result.details?.cost).toEqual([{ amount: 0.005, unit: "USD" }]);
	expect(retained).toEqual([["x_search", 200, complete()]]);
});

test("a stream read across chunk boundaries, with CRLF line ends, comments and a [DONE] line, gives the same answer", async () => {
	const text = ": keep-alive\r\n\r\n" + record("response.output_text.delta", { delta: "A readable finding." }, "\r\n") + record("response.completed", { response: complete() }, "\r\n") + "data: [DONE]\r\n\r\n";
	for (const size of [1, 2, 7, 64]) {
		const chunks = Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size));
		globalThis.fetch = (async () => streamed(chunks)) as typeof fetch;
		const result = await executeSource(search, { query: "split" }, context);
		expect(result.status).toBe("success");
		expect(result.text).toContain("A readable finding.");
		expect(result.details?.cost).toEqual([{ amount: 0.005, unit: "USD" }]);
	}
});

test("a stream that ends with response.incomplete keeps its readable text as partial", async () => {
	globalThis.fetch = (async () => streamed([deltas, record("response.incomplete", { response: complete({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }) })])) as typeof fetch;
	const result = await executeSource(search, { query: "incomplete" }, context);
	expect(result.status).toBe("partial");
	expect(result.text).toContain("**Incomplete response:** xAI marked this response incomplete (max_output_tokens)");
	expect(result.details?.cost).toEqual([{ amount: 0.005, unit: "USD" }]);
});

test("a stream that ends with response.failed fails with the response's error", async () => {
	globalThis.fetch = (async () => streamed([deltas, record("response.failed", { response: complete({ status: "failed", output: [], error: { code: "server_error", message: "The search failed" } }) })])) as typeof fetch;
	const result = await executeSource(search, { query: "failed" }, context);
	expect(result.status).toBe("failed");
	expect(result.text).toBe("ERROR: The search failed");
	expect(result.details?.cost).toEqual([{ amount: 0.005, unit: "USD" }]);
});

test("an error event, or a stream cut before its terminal event, fails once with an unknown cost and keeps what arrived as interrupted", async () => {
	const error = { type: "error", code: "server_error", message: "The model stopped" };
	for (const [chunks, said, kept] of [
		[[deltas, `event: error\ndata: ${JSON.stringify(error)}\n\n`], "xAI's stream reported an error: The model stopped", error],
		[[deltas], "xAI's stream ended before its final event", { id: "r-new", status: "in_progress", output: [] }],
		[[deltas.slice(0, 40)], "xAI's stream ended before its final event", ""],
	] as const) {
		let calls = 0;
		let reads = 0;
		const retained: unknown[][] = [];
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			if (init?.method !== "POST") { reads += 1; return notStored(); }
			calls += 1; return streamed([...chunks]);
		}) as typeof fetch;
		const result = await executeSource(search, { query: "cut" }, context);
		expect(calls).toBe(1);
		// Only a stream that broke or ended after its response id arrived is looked for; a reported error is final.
		expect(reads).toBe(said.includes("ended") && kept !== "" ? 2 : 0);
		expect(result.status).toBe("failed");
		expect(result.text).toContain(said);
		expect(result.text).toContain("the pass may still have run and been charged; its cost is unknown");
		expect(result.text.includes("recoverResponseId set to that id")).toBe(reads > 0);
		expect(result.details?.cost).toBeNull();
		expect(result.details?.knownCost).toBeUndefined();
		await search.execute({ query: "cut" }, { ...context, keep: (...args) => { retained.push(args); } });
		expect(retained).toEqual([["x_search", 200, kept, undefined, true]]);
	}
});

test("a stream that breaks while being read is not sent again and its cost is unknown", async () => {
	let calls = 0;
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		if (init?.method !== "POST") return notStored();
		calls += 1;
		return broken();
	}) as typeof fetch;
	const result = await executeSource(search, { query: "reset" }, context);
	expect(calls).toBe(1);
	expect(result.status).toBe("failed");
	expect(result.text).toContain("xAI's stream broke before its final event (terminated)");
	expect(result.text).toContain("may still have run and been charged");
	expect(result.text).toContain("Its response id is r-new; xAI held no finished response under it when Dig looked.");
	expect(result.details?.cost).toBeNull();
});

test("a cut stream's finished answer is read back from xAI by its response id, once, with its reported cost, and the pass is not sent again", async () => {
	for (const cut of [() => streamed([deltas]), broken]) {
		const requests: Array<{ method: string; url: string; auth: string | null }> = [];
		const retained: unknown[][] = [];
		// The first read finds the pass still running; the second finds it finished.
		const reads = [new Response(JSON.stringify(complete({ status: "in_progress", output: [], usage: undefined }))), new Response(JSON.stringify(complete()))];
		globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
			requests.push({ method: init?.method ?? "GET", url: String(url), auth: new Headers(init?.headers).get("authorization") });
			return init?.method === "POST" ? cut() : reads.shift()!;
		}) as typeof fetch;
		const result = await executeSource(search, { query: "recovered" }, { ...context, keep: (...args) => { retained.push(args); } });
		expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual(["POST https://api.x.ai/v1/responses", "GET https://api.x.ai/v1/responses/r-new", "GET https://api.x.ai/v1/responses/r-new"]);
		expect(requests.every(({ auth }) => auth === "Bearer xai-test-key")).toBe(true);
		expect(result.status).toBe("success");
		expect(result.text).toContain("A readable finding.");
		expect(result.text).toContain("**Recovered:** xAI's stream was cut before its final event. The pass was not sent again");
		expect(result.text).toContain("$0.0050");
		// The finished response is the call's one original, so the receipt holds the charge xAI reported for the pass.
		expect(result.details?.cost).toEqual([{ amount: 0.005, unit: "USD" }]);
		expect(retained).toEqual([["x_search", 200, complete()]]);
	}
});

test("a cut stream whose pass xAI still shows running fails with its id and how to read it later", async () => {
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => init?.method === "POST" ? streamed([deltas]) : new Response(JSON.stringify({ id: "r-new", status: "in_progress", output: [] }))) as typeof fetch;
	const result = await executeSource(search, { query: "slow" }, context);
	expect(result.status).toBe("failed");
	expect(result.text).toContain("Its response id is r-new, and xAI still shows the pass running. To read the answer once it finishes, without paying for a new pass, call xsearch with recoverResponseId set to that id.");
	expect(result.details?.cost).toBeNull();
});

test("a refused key stops the reads, and a pass sent without storage is not looked for", async () => {
	let reads = 0;
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		if (init?.method === "POST") return streamed([deltas]);
		reads += 1;
		return new Response(JSON.stringify({ code: "unauthorized", error: "Invalid key" }), { status: 401 });
	}) as typeof fetch;
	const refused = await executeSource(search, { query: "refused" }, context);
	expect(reads).toBe(1);
	expect(refused.text).toContain("xAI held no finished response under it when Dig looked (the last read failed: 401)");

	reads = 0;
	let posts = 0;
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		if (init?.method !== "POST") { reads += 1; return notStored(); }
		posts += 1;
		return posts === 1 ? new Response(JSON.stringify({ error: "Response is too large to store", usage: { cost_in_usd_ticks: 10000000 } }), { status: 400 }) : streamed([deltas]);
	}) as typeof fetch;
	const unstored = await executeSource(search, { query: "unstored" }, context);
	expect(posts).toBe(2);
	expect(reads).toBe(0);
	expect(unstored.status).toBe("failed");
	expect(unstored.text).not.toContain("recoverResponseId");
});

test("recoverResponseId reads a stored pass without sending a search, records no charge and states what the pass cost", async () => {
	const requests: string[] = [];
	const retained: unknown[][] = [];
	const stored = complete({ id: "r-old", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: "An earlier finding [3].", annotations: [{ type: "url_citation", url: "https://x.com/a/status/1", start_index: 0, end_index: 1 }] }] }] });
	globalThis.fetch = (async (url: unknown, init?: RequestInit) => { requests.push(`${init?.method ?? "GET"} ${String(url)}`); return new Response(JSON.stringify(stored)); }) as typeof fetch;
	const result = await executeSource(search, { query: "the original question", recoverResponseId: " r-old ", handles: ["ignored"] }, { ...context, keep: (...args) => { retained.push(args); } });
	expect(requests).toEqual(["GET https://api.x.ai/v1/responses/r-old"]);
	expect(result.status).toBe("success");
	expect(result.text).toContain("An earlier finding [3].");
	expect(result.text).toContain("**Citations by number:**");
	expect(result.text).toContain("**Recovered pass:** this is the stored answer of an earlier pass");
	expect(result.text).toContain("this read is free. xAI reports the pass itself cost $0.0050; that charge belongs to the call that sent it");
	expect(result.text).toContain("- [1] https://x.com/a/status/1");
	expect(result.text).toContain("**response_id:** r-old");
	expect(result.details?.cost).toEqual([]);
	expect(retained).toEqual([["x_search", 200, stored]]);
});

test("recoverResponseId says so when the pass is still running, is not stored, failed or cannot be read; none is charged", async () => {
	for (const [answer, status, said] of [
		[() => new Response(JSON.stringify({ id: "r-old", status: "in_progress", output: [] })), "empty", "xAI still shows the pass with response id r-old running"],
		[() => notStored(), "empty", "xAI holds no response under id r-old"],
		[() => new Response(JSON.stringify(complete({ id: "r-old", status: "failed", output: [], error: { message: "The search failed" } }))), "failed", "xAI reports the pass with response id r-old failed: The search failed"],
		[() => new Response("upstream", { status: 503 }), "failed", "xAI could not be read for response id r-old (503)"],
		[() => new Response(JSON.stringify(complete({ id: "r-old", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }))), "partial", "**Incomplete response:** xAI marked this response incomplete (max_output_tokens)"],
	] as const) {
		let calls = 0;
		globalThis.fetch = (async () => { calls += 1; return answer(); }) as typeof fetch;
		const result = await executeSource(search, { query: "again", recoverResponseId: "r-old" }, context);
		expect(calls).toBe(1);
		expect(result.status).toBe(status);
		expect(result.text).toContain(said);
		expect(result.details?.cost).toEqual([]);
	}
	expect(Value.Check(createSchemas(Type).xsearch, { query: "again", recoverResponseId: "" })).toBe(false);
});

test("a terminal response without a reported charge leaves the cost unknown, never zero", async () => {
	globalThis.fetch = (async () => streamed([record("response.completed", { response: complete({ usage: { total_tokens: 12 } }) })])) as typeof fetch;
	const result = await executeSource(search, { query: "no charge reported" }, context);
	expect(result.status).toBe("success");
	expect(result.text).toContain("Provider cost unavailable");
	expect(result.details?.cost).toBeNull();
});

test("JSON 400s before a stream still trigger each retry, and the retried request streams", async () => {
	for (const message of ["Response is too large to store", "reasoning effort is not supported"]) {
		const bodies: any[] = [];
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return bodies.length === 1
				? Response.json({ error: { message }, usage: { total_tokens: 0, cost_in_usd_ticks: 0 } }, { status: 400 })
				: streamed([record("response.completed", { response: complete() })]);
		}) as typeof fetch;
		const result = await executeSource(search, { query: "retry" }, context);
		expect(bodies).toHaveLength(2);
		expect(bodies.map(body => body.stream)).toEqual([true, true]);
		expect(message.startsWith("Response") ? bodies[1].store : bodies[1].reasoning).toBe(message.startsWith("Response") ? false : undefined);
		expect(result.status).toBe("success");
		expect(result.text).toContain("A readable finding.");
	}
});

test("a JSON 200 from a server that ignored the stream is read as before", async () => {
	globalThis.fetch = (async () => Response.json(complete())) as typeof fetch;
	const result = await executeSource(search, { query: "plain JSON" }, context);
	expect(result.status).toBe("success");
	expect(result.text).toContain("A readable finding.");
	expect(result.details?.cost).toEqual([{ amount: 0.005, unit: "USD" }]);
});
